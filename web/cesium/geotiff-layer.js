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

// ---- ラスタレンダラ（疑似カラー・ヒルシェード・ストレッチ） ---------------
// QGIS のラスタレンダラ（単バンド疑似カラー/パレット・ヒルシェード・
// コントラストストレッチ）を Canvas 側で再現するための .kasc オプション系。
// geotiff: 行の colormap= / hillshade= / min= / max= / stretch= / nodata= を
// app.js が item に解釈し、resolveGeoTiffItem が gt.render へ束ねる。
// 描画自体は readGeoTiffToCanvas の解析経路で行い、タイル/オーバーレイ両経路に効く。

// 組込みカラーランプ。stop は [位置0-1, r, g, b]（256 エントリ LUT へ展開する）
const COLOR_RAMPS = {
  viridis: [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]],
  magma: [[0, 0, 0, 4], [0.25, 81, 18, 124], [0.5, 182, 54, 121], [0.75, 251, 136, 97], [1, 252, 253, 191]],
  inferno: [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]],
  plasma: [[0, 13, 8, 135], [0.25, 126, 3, 168], [0.5, 204, 71, 120], [0.75, 248, 149, 64], [1, 240, 249, 33]],
  cividis: [[0, 0, 32, 76], [0.25, 59, 77, 107], [0.5, 120, 124, 126], [0.75, 188, 175, 111], [1, 255, 233, 70]],
  turbo: [[0, 48, 18, 59], [0.25, 50, 136, 229], [0.5, 26, 200, 167], [0.75, 249, 164, 39], [1, 122, 4, 3]],
  terrain: [[0, 51, 102, 204], [0.15, 42, 153, 84], [0.4, 190, 200, 120], [0.65, 150, 105, 74], [0.85, 160, 160, 160], [1, 255, 255, 255]],
  spectral: [[0, 158, 1, 66], [0.25, 213, 62, 79], [0.5, 255, 255, 191], [0.75, 102, 194, 165], [1, 94, 79, 162]],
  rdbu: [[0, 103, 0, 31], [0.5, 247, 247, 247], [1, 5, 48, 97]],
  gray: [[0, 0, 0, 0], [1, 255, 255, 255]],
};
COLOR_RAMPS.grays = COLOR_RAMPS.gray;
COLOR_RAMPS.greys = COLOR_RAMPS.gray;

function hexToRgbStop(s) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(String(s || "").trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) : 255] : null;
}

// colormap= 指定を 256 エントリの RGBA LUT（Uint8ClampedArray(256*4)）へ展開。
// 形式: 組込み名（viridis 等）/ "#hex,#hex,..." の等間隔 stop /
// "値:#hex,値:#hex" の位置指定（値は stretch 範囲へ正規化されるため
// resolveGeoTiffItem 側で range を渡す）。失敗時は null
export function compileColorRamp(spec, { min = 0, max = 1, invert = false } = {}) {
  const raw = String(spec || "").trim();
  if (!raw) return null;
  let stops = null;
  const named = COLOR_RAMPS[raw.toLowerCase()];
  if (named) {
    stops = named.map(([p, r, g, b]) => [p, r, g, b, 255]);
  } else {
    // "pos:#hex" または "#hex" のカンマ区切り
    stops = [];
    const entries = raw.split(",").map(s => s.trim()).filter(Boolean);
    entries.forEach((entry, idx) => {
      const colon = entry.indexOf(":");
      let pos = null, col = entry;
      if (colon > 0 && !entry.startsWith("#")) {
        pos = Number(entry.slice(0, colon));
        col = entry.slice(colon + 1);
      }
      const rgba = hexToRgbStop(col);
      if (!rgba) return;
      if (pos == null || !Number.isFinite(pos)) pos = entries.length > 1 ? idx / (entries.length - 1) : 0;
      else if (Math.abs(pos) > 1) pos = (pos - min) / ((max - min) || 1); // 値域→0-1
      stops.push([Math.max(0, Math.min(1, pos)), rgba[0], rgba[1], rgba[2], rgba[3]]);
    });
    if (!stops.length) return null;
    stops.sort((a, b) => a[0] - b[0]);
  }
  const lut = new Uint8ClampedArray(256 * 4);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    let t = i / 255;
    if (invert) t = 1 - t;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const a = stops[j], b = stops[Math.min(j + 1, stops.length - 1)];
    const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = a[1 + c] + (b[1 + c] - a[1 + c]) * f;
  }
  return lut;
}

// Hillshade 係数（Horn の方法）。vals は標高値の typed array（w*h）、
// csx/csy は m/px、az/el は度、z は誇張係数。戻り値 Float32Array(w*h) ∈[0,1]
function hillshadeFactors(vals, w, h, csx, csy, azDeg, elDeg, z, nodata) {
  const az = (360 - azDeg + 90) * Math.PI / 180; // 方位→数値角
  const zen = (90 - elDeg) * Math.PI / 180;
  const out = new Float32Array(w * h);
  const ok = i => Number.isFinite(vals[i]) && (nodata == null || vals[i] !== nodata);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ok(i)) { out[i] = 0; continue; }
      const xl = x > 0 ? i - 1 : i, xr = x < w - 1 ? i + 1 : i;
      const yu = y > 0 ? i - w : i, yd = y < h - 1 ? i + w : i;
      const vl = ok(xl) ? vals[xl] : vals[i], vr = ok(xr) ? vals[xr] : vals[i];
      const vu = ok(yu) ? vals[yu] : vals[i], vd = ok(yd) ? vals[yd] : vals[i];
      const dzdx = (vr - vl) * z / (2 * csx);
      const dzdy = (vd - vu) * z / (2 * csy);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdx, -dzdy);
      const hs = Math.cos(zen) * Math.cos(slope)
        + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
      out[i] = Math.max(0, Math.min(1, hs));
    }
  }
  return out;
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
// options: { window, outW, outH, bands:[1始まり], nodata, resample, signal,
//   render:{ lut, min, max, stats:{min,max}, nodata, hillshade:{az,el,z}, cellsize:[x,y] } }
// render 指定時は単バンド解析経路へ強制し、ストレッチ→疑似カラー→陰影の順で着色する
export async function readGeoTiffToCanvas(image, { window = null, outW, outH, bands = null, nodata = null, resample = "bilinear", signal, render = null } = {}) {
  const fd = image.fileDirectory || {};
  // fileDirectory の数値タグは TypedArray で来るため Array.isArray は使わない
  const bits = fd.BitsPerSample?.length != null ? Array.from(fd.BitsPerSample) : [fd.BitsPerSample || 8];
  const formats = fd.SampleFormat?.length != null ? Array.from(fd.SampleFormat) : [];
  const allUint8 = bits.every(b => b === 8) && formats.every(f => f === undefined || f === 1);
  const photo = fd.PhotometricInterpretation;
  const effNodata = render?.nodata ?? nodata;

  if (!render && !bands?.length && allUint8 && photo != null) {
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
      await applyNodataMask(image, px, w, h, window, effNodata);
      const canvas = rasterCanvas(w, h);
      canvas.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
      return canvas;
    }
    // readRGB 非対応の photometric なら解析経路へ落ちる
  }

  // 解析経路: 指定バンド（または先頭バンド群）を読み min-max 正規化する。
  // 単バンドはグレースケール、3バンド以上は先頭3バンドを RGB 割当
  const count = image.getSamplesPerPixel();
  const sel = render
    ? [Math.min(Math.max(Math.trunc(render.band || 1), 1), count) - 1]
    : (bands?.length
      ? bands.map(b => Math.min(Math.max(Math.trunc(b), 1), count) - 1)
      : (count >= 3 ? [0, 1, 2] : [0]));
  const read = await image.readRasters({ window, samples: sel.slice(0, 4), width: outW, height: outH, resampleMethod: resample, signal });
  const w = read.width, h = read.height;
  const px = new Uint8ClampedArray(w * h * 4);

  if (render) {
    // レンダラ経路: 値域ストレッチ → 疑似カラー(LUT) → 陰影
    const src = read[0];
    let lo = render.min, hi = render.max;
    if ((lo == null || hi == null) && render.stats) {
      if (lo == null) lo = render.stats.min;
      if (hi == null) hi = render.stats.max;
    }
    if (lo == null || hi == null) {
      // 統計が取れない場合は窓内 min-max へフォールバック
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (!Number.isFinite(v) || (effNodata != null && v === effNodata)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (lo == null) lo = mn;
      if (hi == null) hi = mx;
    }
    const span = hi - lo;
    const lut = render.lut;
    const shade = render.hillshade
      ? hillshadeFactors(src, w, h,
          render.cellsize?.[0] || 1, render.cellsize?.[1] || 1,
          render.hillshade.az ?? 315, render.hillshade.el ?? 45,
          render.hillshade.z ?? 1, effNodata)
      : null;
    for (let i = 0; i < w * h; i++) {
      const v = src[i];
      const isNodata = !Number.isFinite(v) || (effNodata != null && Number.isFinite(effNodata) && v === effNodata);
      if (isNodata) { px[i * 4 + 3] = 0; continue; }
      const t = span > 0 ? Math.max(0, Math.min(255, Math.round((v - lo) * 255 / span))) : 0;
      let r, g, b;
      if (lut) {
        r = lut[t * 4]; g = lut[t * 4 + 1]; b = lut[t * 4 + 2];
      } else {
        r = g = b = shade ? 255 : t; // 陰影のみの場合は白下地を乗算
      }
      if (shade) { const s = shade[i]; r *= s; g *= s; b *= s; }
      px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b;
      px[i * 4 + 3] = lut ? lut[t * 4 + 3] : 255;
    }
  } else {
    const tmp = new Uint8ClampedArray(w * h);
    const norm = read.map(arr => normalizeBand(arr, tmp.slice()));
    const src0 = read[0];
    for (let i = 0; i < w * h; i++) {
      if (sel.length >= 3) {
        px[i * 4] = norm[0][i]; px[i * 4 + 1] = norm[1][i]; px[i * 4 + 2] = norm[2][i];
      } else {
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = norm[0][i];
      }
      px[i * 4 + 3] = (effNodata != null && Number.isFinite(effNodata) && src0[i] === effNodata) ? 0 : 255;
    }
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
  item._gt.render = await buildRenderOpts(item, item._gt);
  return item._gt;
}

// レンダラオプション（colormap=/hillshade=/min=/max=/stretch=/nodata=）を
// 実行時設定へ束ねる。値域が未指定で必要な場合は最も粗い IFD から統計を推定し
// タイル間で見え方がブレないようにする（範囲がタイルごとの窓内 min-max だと
// タイル境界で色が不連続になる）
async function buildRenderOpts(item, gt) {
  const wants = item.colormap || item.hillshade || item.stretch
    || item.gtMin != null || item.gtMax != null || item.nodata != null;
  if (!wants) return null;
  const band = item.bands?.[0] || 1;
  let stats = null;
  if (item.stretch === "minmax" || item.gtMin == null || item.gtMax == null
      || item.colormap || item.hillshade) {
    try {
      // 最も粗いオーバービュー（images は解像度昇順ソート済み）から推定
      const coarse = gt.images[gt.images.length - 1].image;
      const sw = Math.min(coarse.getWidth(), 512), sh = Math.min(coarse.getHeight(), 512);
      const bidx = Math.min(Math.max(band - 1, 0), coarse.getSamplesPerPixel() - 1);
      const r = await coarse.readRasters({ samples: [bidx], width: sw, height: sh, resampleMethod: "nearest" });
      let mn = Infinity, mx = -Infinity;
      const arr = r[0], nd = item.nodata ?? gt.nodata;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (!Number.isFinite(v) || (nd != null && v === nd)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (Number.isFinite(mn)) stats = { min: mn, max: mx };
    } catch (e) { /* 統計推定失敗時は窓内 min-max フォールバック */ }
  }
  return {
    band,
    lut: item.colormap ? compileColorRamp(item.colormap, {
      min: item.gtMin ?? stats?.min ?? 0, max: item.gtMax ?? stats?.max ?? 1,
      invert: item.colormapInvert }) : null,
    min: item.gtMin ?? null,
    max: item.gtMax ?? null,
    stats,
    nodata: item.nodata ?? gt.nodata,
    hillshade: item.hillshade || null,
  };
}

// 陰影計算に使う画素サイズ [x,y] をメートル/px で返す。
// 度単位(4326/不明の地理座標)は中心緯度でメートルへ換算（標高の m との整合用）
function cellsizeMeters(image, gt) {
  let res = null;
  try { res = image.getResolution(gt.base); } catch (e) { /* affine 無し */ }
  if (!res) { try { res = gt.base.getResolution(); } catch (e) { res = null; } }
  if (!res) return [1, 1];
  let csx = Math.abs(res[0]) || 1, csy = Math.abs(res[1]) || 1;
  const code = gt.crs.code;
  const geographic = code === 4326
    || (!code && gt.bboxNative && Math.abs(gt.bboxNative[0]) <= 360 && Math.abs(gt.bboxNative[1]) <= 90);
  if (geographic && gt.bboxNative) {
    const latC = (gt.bboxNative[1] + gt.bboxNative[3]) / 2;
    csx *= 111320 * Math.cos(latC * Math.PI / 180);
    csy *= 110540;
  }
  return [csx, csy];
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
  const render = gt.render ? { ...gt.render, cellsize: cellsizeMeters(ovr.image, gt) } : null;
  const canvas = await readGeoTiffToCanvas(ovr.image, {
    outW, outH, bands: item.bands, nodata: gt.nodata, resample: item.resample || "bilinear",
    render,
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
        const render = gt.render ? { ...gt.render, cellsize: cellsizeMeters(ovr.image, gt) } : null;
        const tile = await readGeoTiffToCanvas(ovr.image, {
          window: oWin, outW, outH,
          bands: item.bands, nodata: gt.nodata, resample: item.resample || "bilinear",
          render,
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
