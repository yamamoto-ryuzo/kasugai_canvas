// geotiff: / cog: / tiff: 行のラスタ読み込み・描画補助（Cesium フロント専用）
// geotiff.js を CDN から遅延ロードし、GeoTIFF/COG をブラウザ内でデコードする。
// 2つの描画経路を持つ:
//   - mode=tiles : カスタム ImageryProvider。EPSG:4326 / EPSG:3857 の軸平行
//                  ラスタを Cesium のタイル分割へ割り当て、ズームレベルに応じて
//                  COG のオーバービュー + Range Request で部分読みする（LOD 対応）
//   - mode=overlay : 単一画像キャンバスを矩形/ポリゴン entity として地表クランプ
//                  （image: 行と同じ経路。地形・3D Tiles へのドレープ、
//                  任意座標系・回転画像に対応）
// mode=auto（既定）は EPSG:4326/3857 かつ軸平行なら tiles、それ以外は overlay。

import { loadScriptOnce } from "../shared/lazy-lib.js";

export const GEOTIFF_LINE_TYPES = new Set(["geotiff", "cog", "tiff"]);
export function isGeoTiffType(type) {
  return GEOTIFF_LINE_TYPES.has(String(type || "").toLowerCase());
}

// ---- geotiff.js / proj4 の遅延ロード -------------------------------------

const GEOTIFF_ESM = "https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm";
const PROJ4_URL = "https://cdn.jsdelivr.net/npm/proj4@2.15.0/dist/proj4-src.js";

let _geoTiffLibPromise = null;
function loadGeoTiffLib() {
  if (!_geoTiffLibPromise) {
    _geoTiffLibPromise = import(/* webpackIgnore: true */ GEOTIFF_ESM)
      .then(mod => (mod.default && mod.default.fromUrl ? mod.default : mod))
      .catch(err => { _geoTiffLibPromise = null; throw err; });
  }
  return _geoTiffLibPromise;
}

let _proj4Promise = null;
const _epsgDefLoaded = new Set();
function loadProj4() {
  if (!_proj4Promise) {
    _proj4Promise = loadScriptOnce(PROJ4_URL)
      .then(() => window.proj4 || null)
      .catch(err => { _proj4Promise = null; throw err; });
  }
  return _proj4Promise;
}

// EPSG コード → (x, y) => [lon, lat] 変換関数。
// 4326 は null（恒等）、3857 は数式、それ以外は proj4 + epsg.io の定義を使う
async function lonLatTransform(epsg) {
  if (epsg === 4326) return null;
  if (epsg === 3857) {
    const R = 6378137;
    return (x, y) => [
      x / R * 180 / Math.PI,
      (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * 180 / Math.PI,
    ];
  }
  const proj4 = await loadProj4();
  if (!proj4) throw new Error("proj4 の読み込みに失敗しました");
  if (!_epsgDefLoaded.has(epsg)) {
    const res = await fetch(`https://epsg.io/${epsg}.proj4`);
    if (!res.ok) throw new Error(`EPSG:${epsg} の座標系定義を取得できませんでした (epsg.io)`);
    proj4.defs(`EPSG:${epsg}`, await res.text());
    _epsgDefLoaded.add(epsg);
  }
  return (x, y) => proj4(`EPSG:${epsg}`, "EPSG:4326", [x, y]);
}

// ---- メタデータ解釈 -------------------------------------------------------

// GeoKey から座標系を取り出す。{ modelType, code }（code は EPSG 番号 or null）
function geoTiffCrs(image) {
  const k = image.geoKeys || {};
  const modelType = k.GTModelTypeGeoKey;
  let code = null;
  if (modelType === 1) code = k.ProjectedCSTypeGeoKey;
  else if (modelType === 2) code = k.GeographicTypeGeoKey;
  else code = k.ProjectedCSTypeGeoKey || k.GeographicTypeGeoKey;
  code = Number(code);
  return { modelType, code: Number.isFinite(code) && code !== 32767 ? code : null };
}

// 回転・シアーのない軸平行画像か（タイル経路は軸平行のみ対応）
function isAxisAligned(image) {
  const mt = image.fileDirectory?.ModelTransformation;
  if (mt && mt.length >= 16) {
    return mt[1] === 0 && mt[4] === 0;
  }
  return true;
}

// 出力画素サイズ（ネイティブ単位/px）に最も近い IFD（オーバービュー）を選ぶ。
// images は {image, resX} を解像度の細かい順に持つ。target より細かいものを優先し、
// 1.5 倍までの粗さは許容して読み込み量を抑える
function pickOverviewImage(images, targetResX) {
  let best = images[0];
  for (const info of images) {
    if (info.resX <= targetResX * 1.5) best = info;
    else break;
  }
  return best;
}

// ---- ラスタ → キャンバス ---------------------------------------------------

function rasterCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

// nodata 値を透明にする。マスク用に第1バンドを最近傍で別途読み、一致画素の
// アルファを 0 にする（readRGB はカラー変換で元値を失うため値比較は生バンドで行う）
async function applyNodataMask(image, rgba, width, height, window, nodata) {
  if (nodata == null || !Number.isFinite(nodata)) return;
  const mask = await image.readRasters({
    window, samples: [0], width, height, resampleMethod: "nearest",
  });
  const band = mask[0];
  for (let i = 0; i < band.length; i++) {
    if (band[i] === nodata) rgba[i * 4 + 3] = 0;
  }
}

// typed array → 0-255 正規化（uint8 はそのまま out へ複写）。戻り値は out
function normalizeBand(arr, out) {
  const uint8 = arr instanceof Uint8Array || arr instanceof Uint8ClampedArray;
  if (uint8) { out.set(arr); return out; }
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (!(range > 0)) {
    out.fill(Math.max(0, Math.min(255, min === Infinity ? 0 : min)));
    return out;
  }
  const scale = 255 / range;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = Number.isFinite(v) ? (v - min) * scale : 0;
  }
  return out;
}

// 画像（または窓）を読み込んで RGBA キャンバスへ描く。
// options: { window, outW, outH, bands:[1始まり], nodata, resample, signal }
export async function readGeoTiffToCanvas(image, { window = null, outW, outH, bands = null, nodata = null, resample = "bilinear", signal } = {}) {
  const fd = image.fileDirectory || {};
  // fileDirectory の数値タグは TypedArray で来るため Array.isArray は使わない
  const bits = fd.BitsPerSample?.length != null ? Array.from(fd.BitsPerSample) : [fd.BitsPerSample || 8];
  const formats = fd.SampleFormat?.length != null ? Array.from(fd.SampleFormat) : [];
  const allUint8 = bits.every(b => b === 8) && formats.every(f => f === undefined || f === 1);
  const photo = fd.PhotometricInterpretation;

  if (!bands?.length && allUint8 && photo != null) {
    // 視覚データ経路: readRGB が photometric 変換（パレット・CMYK・YCbCr 等）を吸収する
    let data;
    try {
      data = await image.readRGB({ window, width: outW, height: outH, resampleMethod: resample, enableAlpha: true, signal });
    } catch (err) {
      data = null;
    }
    if (data) {
      const w = data.width, h = data.height;
      const ch = data.length / (w * h);
      const px = new Uint8ClampedArray(w * h * 4);
      if (ch >= 4) {
        for (let i = 0, j = 0; i < w * h; i++, j += ch) {
          px[i * 4] = data[j]; px[i * 4 + 1] = data[j + 1]; px[i * 4 + 2] = data[j + 2];
          px[i * 4 + 3] = ch >= 4 ? data[j + 3] : 255;
        }
      } else {
        for (let i = 0, j = 0; i < w * h; i++, j += ch) {
          px[i * 4] = data[j]; px[i * 4 + 1] = data[j + 1] || data[j]; px[i * 4 + 2] = data[j + 2] || data[j];
          px[i * 4 + 3] = 255;
        }
      }
      await applyNodataMask(image, px, w, h, window, nodata);
      const canvas = rasterCanvas(w, h);
      canvas.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
      return canvas;
    }
    // readRGB 非対応の photometric なら解析経路へ落ちる
  }

  // 解析経路: 指定バンド（または先頭バンド群）を読み min-max 正規化する。
  // 単バンドはグレースケール、3バンド以上は先頭3バンドを RGB 割当
  const count = image.getSamplesPerPixel();
  const sel = bands?.length
    ? bands.map(b => Math.min(Math.max(Math.trunc(b), 1), count) - 1)
    : (count >= 3 ? [0, 1, 2] : [0]);
  const read = await image.readRasters({ window, samples: sel.slice(0, 4), width: outW, height: outH, resampleMethod: resample, signal });
  const w = read.width, h = read.height;
  const px = new Uint8ClampedArray(w * h * 4);
  const tmp = new Uint8ClampedArray(w * h);
  const norm = read.map(arr => normalizeBand(arr, tmp.slice()));
  const src0 = read[0];
  for (let i = 0; i < w * h; i++) {
    if (sel.length >= 3) {
      px[i * 4] = norm[0][i]; px[i * 4 + 1] = norm[1][i]; px[i * 4 + 2] = norm[2][i];
    } else {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = norm[0][i];
    }
    px[i * 4 + 3] = (nodata != null && Number.isFinite(nodata) && src0[i] === nodata) ? 0 : 255;
  }
  const canvas = rasterCanvas(w, h);
  canvas.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
  return canvas;
}

// ---- アイテム解決 ---------------------------------------------------------

// geotiff: 系アイテムの TIFF ヘッダを開き item._gt に実行時情報を保持する。
// fetchUrl はプロキシ適用済みの取得 URL（app.js 側で proxyFetchUrl を通す）
export async function resolveGeoTiffItem(item, fetchUrl) {
  if (item._gt) return item._gt;
  const GeoTIFF = await loadGeoTiffLib();
  const tiff = await GeoTIFF.fromUrl(fetchUrl);
  const count = await tiff.getImageCount();
  const base = await tiff.getImage(0);
  // 全 IFD（オーバービュー）のメタデータを先に集める。COG のサブ IFD は
  // 自身の ModelPixelScale を持つが、持たない場合も基準画像からの比で
  // 解像度を推定できるよう getResolution(base) を使う
  const images = [];
  for (let i = 0; i < count; i++) {
    const image = await tiff.getImage(i);
    let resX = Infinity, resY = Infinity;
    try {
      const res = image.getResolution(base);
      resX = Math.abs(res[0]) || Infinity;
      resY = Math.abs(res[1]) || Infinity;
    } catch (e) { /* affine 情報無し */ }
    images.push({ index: i, image, w: image.getWidth(), h: image.getHeight(), resX, resY });
  }
  images.sort((a, b) => a.resX - b.resX);
  const crs = geoTiffCrs(base);
  let bboxNative = null;
  try { bboxNative = base.getBoundingBox(); } catch (e) { /* ジオリファレンス無し */ }
  const nodata = base.getGDALNoData ? base.getGDALNoData() : null;

  // mode 判定: auto はタイル可能（4326/3857・軸平行・georef あり）なら tiles
  const georeferenced = !!bboxNative || !!(item.imageBbox || item.imageCorners);
  const tileable = !!(crs.code === 4326 || crs.code === 3857) && isAxisAligned(base) && !!bboxNative;
  let mode;
  if (item.gtMode === "tiles") {
    if (!tileable) throw new Error("geotiff: mode=tiles は EPSG:4326 / EPSG:3857 の軸平行ラスタのみ対応です（mode=overlay を指定してください）");
    mode = "tiles";
  } else if (item.gtMode === "overlay") {
    mode = "overlay";
  } else {
    mode = tileable ? "tiles" : "overlay";
  }
  if (!georeferenced) {
    throw new Error("geotiff: ジオリファレンス情報がありません（bbox= または corners= で配置範囲を指定してください）");
  }
  item._gt = { tiff, images, base, crs, bboxNative, nodata, mode };
  return item._gt;
}

// ---- オーバーレイ（entity ドレープ）経路 -----------------------------------

// ネイティブ bbox の4隅（左上・右上・右下・左下）を lon/lat へ変換する
async function bboxToLonLatQuad(gt, item) {
  if (item.imageCorners?.length >= 3 || item.imageBbox) {
    // 明示指定は image: 行と同じく既に lon/lat
    return { corners: item.imageCorners, bbox: item.imageBbox };
  }
  const [minX, minY, maxX, maxY] = gt.bboxNative;
  // EPSG コードを持たないジオリファレンスは、値域が緯度経度として妥当な
  // 範囲のときのみ EPSG:4326 とみなす（投影座標の巨大値を誤配置しない）
  let code = gt.crs.code;
  if (!code) {
    const plausible = Math.abs(minX) <= 360 && Math.abs(maxX) <= 360 && Math.abs(minY) <= 90 && Math.abs(maxY) <= 90;
    if (!plausible) throw new Error("geotiff: 座標系を特定できません（GeoKey 無し・ユーザー定義 CRS）");
    code = 4326;
  }
  const transform = await lonLatTransform(code);
  const pts = [[minX, maxY], [maxX, maxY], [maxX, minY], [minX, minY]]
    .map(([x, y]) => (transform ? transform(x, y) : [x, y]));
  // 軸平行（4326/3857 由来）なら矩形に潰す
  const w = Math.min(...pts.map(p => p[0])), e = Math.max(...pts.map(p => p[0]));
  const s = Math.min(...pts.map(p => p[1])), n = Math.max(...pts.map(p => p[1]));
  const axisAligned = Math.abs(pts[0][0] - pts[3][0]) < 1e-9 && Math.abs(pts[1][0] - pts[2][0]) < 1e-9
    && Math.abs(pts[0][1] - pts[1][1]) < 1e-9 && Math.abs(pts[2][1] - pts[3][1]) < 1e-9;
  return axisAligned ? { bbox: [w, s, e, n] } : { corners: pts };
}

// geotiff 行 → 地表クランプ画像の CustomDataSource（image: 行と同じ構成）。
// 戻り値は { ds, canvas }（focus 用に ds をそのまま layerRuntimeTargets へ登録する）
export async function buildGeoTiffOverlayDataSource(Cesium, item, fetchUrl) {
  const gt = await resolveGeoTiffItem(item, fetchUrl);
  const { bbox, corners } = await bboxToLonLatQuad(gt, item);
  const base = gt.base;
  const maxSize = item.maxSize || 2048;
  // 出力サイズはベース画像を maxSize へ縮めたもの。オーバービューがあれば
  // 出力画素サイズに近い IFD から読む（COG では Range Request 量が減る）
  let targetRes = Infinity;
  try { targetRes = Math.abs(base.getResolution()[0]) * (base.getWidth() / Math.min(base.getWidth(), maxSize)); } catch (e) { /* affine 無し */ }
  const ovr = Number.isFinite(targetRes) ? pickOverviewImage(gt.images, targetRes) : (gt.images.find(i => i.index === 0) || gt.images[0]);
  const scale = Math.min(1, maxSize / ovr.w, maxSize / ovr.h);
  const outW = Math.max(1, Math.round(ovr.w * scale));
  const outH = Math.max(1, Math.round(ovr.h * scale));
  const canvas = await readGeoTiffToCanvas(ovr.image, {
    outW, outH, bands: item.bands, nodata: gt.nodata, resample: item.resample || "bilinear",
  });
  const material = new Cesium.ImageMaterialProperty({
    image: canvas,
    transparent: true,
    color: Cesium.Color.WHITE.withAlpha(item.opacity ?? 1),
  });
  const ds = new Cesium.CustomDataSource(item.title);
  if (corners && corners.length >= 3) {
    ds.entities.add({
      polygon: {
        hierarchy: corners.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
        material,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
  } else if (bbox) {
    ds.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(...bbox),
        material,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
  } else {
    throw new Error("geotiff: 配置範囲を特定できませんでした");
  }
  return ds;
}

// ---- タイル（ImageryProvider）経路 -----------------------------------------

// EPSG:4326 / EPSG:3857 の GeoTIFF/COG を Cesium のグローバルタイル分割へ載せる
// カスタム ImageryProvider。タイル要求ごとに COG の対応範囲を Range Request で
// 読むため、大容量ラスタでもズームレベルに応じた量しか転送しない
export function createGeoTiffImageryProvider(Cesium, item, gt) {
  const epsg = gt.crs.code;
  const base = gt.base;
  const origin = base.getOrigin();
  const res = base.getResolution(); // [resX, resY(通常負), resZ]
  const W = base.getWidth(), H = base.getHeight();
  const isGeo = epsg === 4326;

  const tilingScheme = isGeo
    ? new Cesium.GeographicTilingScheme()
    : new Cesium.WebMercatorTilingScheme();
  // rectangle は常に緯度経度（ラジアン）。3857 ソースは bbox を逆投影する
  const [minX, minY, maxX, maxY] = gt.bboxNative;
  const toLonLat = (x, y) => isGeo ? [x, y] : [
    x / 6378137 * 180 / Math.PI,
    (Math.atan(Math.exp(y / 6378137)) * 2 - Math.PI / 2) * 180 / Math.PI,
  ];
  const [w0, s0] = toLonLat(minX, minY);
  const [e0, n0] = toLonLat(maxX, maxY);
  const rectangle = Cesium.Rectangle.fromDegrees(
    Math.min(w0, e0), Math.min(s0, n0), Math.max(w0, e0), Math.max(s0, n0));

  // タイル上限レベル: レベル0タイルの解像度がネイティブ解像度を下回るまで
  const nX0 = tilingScheme.getNumberOfXTilesAtLevel(0);
  const level0TileRes = isGeo
    ? 360 / (nX0 * 256)                    // 地理院度/px
    : 40075016.68557849 / (nX0 * 256);     // m/px
  const resNative = Math.abs(res[0]);
  const maximumLevel = resNative > 0
    ? Math.max(0, Math.min(30, Math.ceil(Math.log2(level0TileRes / resNative))))
    : 0;

  const R = 6378137;
  const mercY = latRad => R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));

  const provider = {
    ready: Promise.resolve(true),
    readyPromise: Promise.resolve(true),
    errorEvent: new Cesium.Event(),
    tilingScheme,
    rectangle,
    tileWidth: 256,
    tileHeight: 256,
    minimumLevel: 0,
    maximumLevel,
    credit: item.attribution ? new Cesium.Credit(item.attribution) : undefined,
    hasAlphaChannel: true,
    getTileCredits() { return undefined; },
    pickFeatures() { return undefined; },
    async requestImage(x, y, level) {
      // タイルの緯度経度範囲 → ソースのネイティブ座標範囲 [w,s,e,n]
      const rect = tilingScheme.tileXYToRectangle(x, y, level);
      let nw, ns, ne, nn;
      if (isGeo) {
        nw = Cesium.Math.toDegrees(rect.west); ns = Cesium.Math.toDegrees(rect.south);
        ne = Cesium.Math.toDegrees(rect.east); nn = Cesium.Math.toDegrees(rect.north);
      } else {
        nw = rect.west * R; ne = rect.east * R;
        ns = mercY(rect.south); nn = mercY(rect.north);
      }
      // ベース画像の画素窓（y は北→南方向に増える前提の一般式）
      const px0 = (nw - origin[0]) / res[0];
      const px1 = (ne - origin[0]) / res[0];
      const py0 = (nn - origin[1]) / res[1];
      const py1 = (ns - origin[1]) / res[1];
      const wx0 = Math.min(px0, px1), wx1 = Math.max(px0, px1);
      const wy0 = Math.min(py0, py1), wy1 = Math.max(py0, py1);
      const cx0 = Math.max(0, Math.floor(wx0)), cy0 = Math.max(0, Math.floor(wy0));
      const cx1 = Math.min(W, Math.ceil(wx1)), cy1 = Math.min(H, Math.ceil(wy1));
      const canvas = rasterCanvas(256, 256);
      const ctx = canvas.getContext("2d");
      if (cx1 <= cx0 || cy1 <= cy0) return canvas; // 範囲外タイル（通常は要求されない）
      // オーバービュー選択: タイル1px が覆うネイティブ幅を基準に近い IFD を選ぶ
      const targetRes = Math.abs(ne - nw) / 256;
      const ovr = pickOverviewImage(gt.images, targetRes);
      const f = ovr.w / W;
      const oWin = [
        Math.max(0, Math.floor(cx0 * f)), Math.max(0, Math.floor(cy0 * f)),
        Math.min(ovr.w, Math.ceil(cx1 * f)), Math.min(ovr.h, Math.ceil(cy1 * f)),
      ];
      // クリップで縮んだ分だけ出力を小さくし、タイル内の正しい位置へ貼る
      const outW = Math.max(1, Math.round(256 * (cx1 - cx0) / (wx1 - wx0)));
      const outH = Math.max(1, Math.round(256 * (cy1 - cy0) / (wy1 - wy0)));
      try {
        const tile = await readGeoTiffToCanvas(ovr.image, {
          window: oWin, outW, outH,
          bands: item.bands, nodata: gt.nodata, resample: item.resample || "bilinear",
        });
        const dx = Math.round(256 * (cx0 - wx0) / (wx1 - wx0));
        const dy = Math.round(256 * (cy0 - wy0) / (wy1 - wy0));
        ctx.drawImage(tile, dx, dy);
      } catch (err) {
        // タイル単位の失敗は透明タイルで継続（ログのみ）
        console.warn("geotiff tile read failed:", err);
      }
      return canvas;
    },
  };
  return provider;
}
