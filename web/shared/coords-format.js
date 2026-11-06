// ---- 座標表示形式（度 / 度分秒 / UTM / 平面直角座標系）全エンジン共通 ----
// カーソル座標・地点座標ポップアップで共用する。表示形式は #coords-format の値
import { t } from "./i18n.js";
import { localCoordsString } from "./coords-local.js";

// i18n 辞書未初期化時はフォールバック文字列を返す
function _tr(key, fallback) {
  const s = t(key);
  return s === key ? fallback : s;
}

export function dmsString(deg, posMark, negMark) {
  const mark = deg < 0 ? negMark : posMark;
  const v = Math.abs(deg);
  const d = Math.floor(v);
  const mFloat = (v - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(1)}"${mark}`;
}

// 楕円体定数
const ELL_GRS80 = { a: 6378137, invF: 298.257222101 };   // 世界測地系 (JGD/UTM)
const ELL_BESSEL = { a: 6377397.155, invF: 299.1528128 }; // 日本測地系(旧)

// 横メルカトル(Gauss-Krüger 系)正規化変換。UTM(縮尺0.9996)・平面直角座標系(0.9999)で共用。
// 返り値 x=北方向(m)・y=東方向(m)（いずれも原点基準・縮尺補正込み）
export function gaussKruger(latDeg, lonDeg, lat0Deg, lon0Deg, k0, ell = ELL_GRS80) {
  const a = ell.a;
  const f = 1 / ell.invF;
  const n = f / (2 - f);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = k0 * a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
    13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
    61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
    49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
    34729 * n5 / 80640 - 3418889 * n6 / 1995840,
    212378941 * n6 / 319467840,
  ];
  const rad = d => d * Math.PI / 180;
  const nSqrt2 = 2 * Math.sqrt(n) / (1 + n);
  const confLat = phi => Math.atan2(
    Math.sinh(Math.atanh(Math.sin(phi)) - nSqrt2 * Math.atanh(nSqrt2 * Math.sin(phi))), 1);
  const phi = rad(latDeg);
  const lam = rad(lonDeg - lon0Deg);
  const lamCos = Math.cos(lam);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - nSqrt2 * Math.atanh(nSqrt2 * Math.sin(phi)));
  const xi = Math.atan2(t, lamCos);
  const eta = Math.asinh(Math.sin(lam) / Math.sqrt(t * t + lamCos * lamCos));
  const xi0 = confLat(rad(lat0Deg));
  let x = A * (xi - xi0);
  let y = A * eta;
  for (let j = 1; j <= 6; j++) {
    x += A * alpha[j - 1] * (Math.sin(2 * j * xi) * Math.cosh(2 * j * eta) - Math.sin(2 * j * xi0));
    y += A * alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { x, y };
}

export function utmString(latDeg, lonDeg) {
  const zone = Math.min(60, Math.max(1, Math.floor((lonDeg + 180) / 6) + 1));
  const { x, y } = gaussKruger(latDeg, lonDeg, 0, zone * 6 - 183, 0.9996);
  const northing = latDeg < 0 ? x + 10000000 : x;
  return `${zone}${latDeg < 0 ? "S" : "N"} E${(y + 500000).toFixed(1)} N${northing.toFixed(1)}`;
}

// 平面直角座標系(JGD2011) 系番号1-19の原点(緯度,経度 度)
const JPX_ZONES = [
  [33, 129.5], [33, 131], [36, 132.166666666667], [33, 133.5], [36, 134.333333333333],
  [36, 136], [36, 137.166666666667], [36, 138.5], [36, 139.833333333333], [40, 140.833333333333],
  [44, 140.25], [44, 142.25], [44, 144.25], [26, 142], [26, 127.5],
  [26, 124], [26, 131], [20, 136], [26, 154],
];
const JPX_ZONE_NAMES = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX"];

// 系番号(0-18) → 系の原点・名称
export function jpxZoneOrigin(zoneIndex) {
  const i = Math.max(0, Math.min(JPX_ZONES.length - 1, zoneIndex | 0));
  const [lat0, lon0] = JPX_ZONES[i];
  return { index: i, name: JPX_ZONE_NAMES[i], lat0, lon0 };
}

// 最も近い原点の平面直角座標系を返す（日本域外では単なる最近傍になる点に注意）
export function jpxZoneAt(latDeg, lonDeg) {
  let zone = 0;
  let best = Infinity;
  const cosLat = Math.cos(latDeg * Math.PI / 180);
  JPX_ZONES.forEach(([la, lo], i) => {
    const d = (latDeg - la) ** 2 + ((lonDeg - lo) * cosLat) ** 2;
    if (d < best) { best = d; zone = i; }
  });
  const [lat0, lon0] = JPX_ZONES[zone];
  return { index: zone, name: JPX_ZONE_NAMES[zone], lat0, lon0 };
}

export function jpxString(latDeg, lonDeg, ell = ELL_GRS80) {
  const zone = jpxZoneAt(latDeg, lonDeg);
  const { x, y } = gaussKruger(latDeg, lonDeg, zone.lat0, zone.lon0, 0.9999, ell);
  return `${zone.name}系 X=${x.toFixed(3)} Y=${y.toFixed(3)}`;
}

// ---- 測地系変換（国土地理院 TKY2JGD.par / PatchJGD パラメータ由来）----
// tools/convert_coords_datum.py が生成する coords-datum-<name>.bin を lazy fetch する。
// .par 形式: メッシュ節点(30"緯度 x 45"経度グリッド)に dB/dL[秒] を持ち、
// 変換は「変換元座標系の位置でセルを特定 → 4節点をバイリニア補間 → 補正量を加算」。
// 逆変換は固定点反復（公式TKY2JGDの2段階反復と同等以上の精度）。
const _datumGrids = {}; // name -> grid | "loading" | "error"
const _datumFetches = {};

function _parseDatumBin(buf) {
  const v = new DataView(buf);
  if (buf.byteLength < 12 || v.getUint32(0) !== 0x4B434450 /* "KCDP" */) throw new Error("bad datum bin");
  const n = v.getUint32(8, true);
  const codes = new Uint32Array(buf, 12, n);
  const db = new Float32Array(buf, 12 + 4 * n, n);
  const dl = new Float32Array(buf, 12 + 8 * n, n);
  return { codes, db, dl };
}

export function loadDatumGrid(name) {
  if (_datumGrids[name] === "error") return null;
  if (_datumGrids[name] && _datumGrids[name] !== "loading") return _datumGrids[name];
  if (!_datumFetches[name]) {
    _datumGrids[name] = "loading";
    _datumFetches[name] = fetch(new URL(`./coords-datum-${name}.bin`, import.meta.url))
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.arrayBuffer(); })
      .then(buf => { _datumGrids[name] = _parseDatumBin(buf); })
      .catch(() => { _datumGrids[name] = "error"; });
  }
  return null;
}

// lat/lon からセルの南西節点のメッシュコードとセル内位置(0..1)を計算（公式LatLon2MeshCode相当）
function _meshCell(lat, lon) {
  let lat1 = Math.floor(lat * 1.5);
  let lon1 = Math.floor(lon) - 100;
  let lat2 = Math.floor(8 * (1.5 * lat - lat1));
  let lon2 = Math.floor(8 * (lon - lon1 - 100));
  let lat3 = Math.floor(10 * (12 * lat - 8 * lat1 - lat2) + 1e-11);
  let lon3 = Math.floor(10 * (8 * (lon - lon1 - 100) - lon2) + 1e-11);
  if (lat3 === 10) { lat3 = 0; if (++lat2 === 8) { lat2 = 0; lat1++; } }
  if (lon3 === 10) { lon3 = 0; if (++lon2 === 8) { lon2 = 0; lon1++; } }
  return {
    lat1, lon1, lat2, lon2, lat3, lon3,
    modLat: 120 * lat - 80 * lat1 - 10 * lat2 - lat3,
    modLon: 80 * (lon - lon1 - 100) - 10 * lon2 - lon3,
  };
}

function _meshCode(c) {
  return (c.lat1 * 100 + c.lon1) * 10000 + (c.lat2 * 10 + c.lon2) * 100 + c.lat3 * 10 + c.lon3;
}

// 隣接節点コード（東/北方向に1グリッド進める。桁上がり処理つき）
function _meshNeighbor(c, dLat, dLon) {
  const n = { lat1: c.lat1, lon1: c.lon1, lat2: c.lat2, lon2: c.lon2, lat3: c.lat3, lon3: c.lon3 };
  for (const [d, k3, k2, k1, b3, b2] of [[dLat, "lat3", "lat2", "lat1", 9, 7], [dLon, "lon3", "lon2", "lon1", 9, 7]]) {
    if (!d) continue;
    if (++n[k3] > b3) { n[k3] = 0; if (++n[k2] > b2) { n[k2] = 0; n[k1]++; } }
  }
  return _meshCode(n);
}

function _gridFind(g, code) {
  const c = g.codes;
  let lo = 0, hi = c.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (c[m] === code) return m;
    if (c[m] < code) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

// 順変換補正量 {dB,dL}[度] を返す。セル節点が1つでも欠ければ null（圏外）
export function gridCorr(g, lat, lon) {
  if (lat < 20 || lat > 46 || lon < 120 || lon > 154) return null;
  const c = _meshCell(lat, lon);
  const i00 = _gridFind(g, _meshCode(c));
  const i10 = _gridFind(g, _meshNeighbor(c, 0, 1));
  const i01 = _gridFind(g, _meshNeighbor(c, 1, 0));
  const i11 = _gridFind(g, _meshNeighbor(c, 1, 1));
  if (i00 < 0 || i10 < 0 || i01 < 0 || i11 < 0) return null;
  const x = c.modLon, y = c.modLat;
  const bl = (a, i0, i1, i2, i3) =>
    a[i0] + (a[i1] - a[i0]) * x + (a[i2] - a[i0]) * y + (a[i3] - a[i1] - a[i2] + a[i0]) * x * y;
  return { dB: bl(g.db, i00, i10, i01, i11) / 3600, dL: bl(g.dl, i00, i10, i01, i11) / 3600 };
}

// 逆変換: 変換先座標(例:JGD)から変換元座標(例:日本測地系)を固定点反復で求める
export function gridInverse(g, lat, lon) {
  let b = lat, l = lon;
  for (let i = 0; i < 3; i++) {
    const c = gridCorr(g, b, l);
    if (!c) return null;
    b = lat - c.dB; l = lon - c.dL;
  }
  return { lat: b, lon: l };
}

// #coords-datum の値に応じて入力緯度経度(WGS84≒JGD系)を選択測地系の緯度経度に変換
// 返り値: {lat, lon, ell, tag} / 圏外 null / 読込中 "loading"
function _toDatum(latDeg, lonDeg, datum) {
  if (datum === "tokyo" || datum === "jgd2000") {
    const name = datum === "tokyo" ? "tky" : "jgd2000";
    const g = _datumGrids[name];
    if (g === "error") return "fetcherror";
    if (!g || g === "loading") { loadDatumGrid(name); return "loading"; }
    const inv = gridInverse(g, latDeg, lonDeg);
    if (datum === "tokyo") {
      if (!inv) return null;
      return { lat: inv.lat, lon: inv.lon, ell: ELL_BESSEL, tag: _tr("display.datumTokyo", "日本測地系") + " " };
    }
    // PatchJGD対象外は測地成果2000と2011が同値のため変換せずそのまま使う
    return { lat: inv?.lat ?? latDeg, lon: inv?.lon ?? lonDeg, ell: ELL_GRS80, tag: "JGD2000 " };
  }
  return { lat: latDeg, lon: lonDeg, ell: ELL_GRS80, tag: "" }; // jgd2024/jgd2011
}

// 緯度経度を #coords-format（deg/dms/utm/jpx）と #coords-datum の設定で文字列化
export function formatLatLng(latDeg, lonDeg) {
  const format = document.querySelector("#coords-format")?.value || "deg";
  const datum = document.querySelector("#coords-datum")?.value || "jgd2024";
  // ローカル座標は対応点定義側が平面直角(JGD)基準で保持するため、
  // 測地系変換を通さず WGS84≒JGD の生座標から直接計算する
  if (format === "local") {
    return `${localCoordsString(latDeg, lonDeg)} ${_tr("coords.refValue", "（参考値）")}`;
  }
  const conv = _toDatum(latDeg, lonDeg, datum);
  if (conv === "loading") return _tr("coords.datumLoading", "測地系データ読込中…");
  if (conv === "fetcherror") return _tr("coords.datumFetchError", "測地系データなし");
  if (conv === null) return _tr("coords.outOfRange", "範囲外");
  const { lat, lon, ell, tag } = conv;
  // WGS84ネイティブ（既定測地系での緯度経度表示）以外は参考値である旨を明示する
  const ref = format === "utm" || format === "jpx" || datum !== "jgd2024"
    ? ` ${_tr("coords.refValue", "（参考値）")}` : "";
  switch (format) {
    case "dms": return `${tag}${dmsString(lat, "N", "S")} ${dmsString(lon, "E", "W")}${ref}`;
    case "utm": return `${tag}UTM ${utmString(lat, lon)}${ref}`;
    case "jpx": return `${tag}${jpxString(lat, lon, ell)}${ref}`;
    default: return `${tag}${lat.toFixed(5)}, ${lon.toFixed(5)}${ref}`;
  }
}

// ---- 検索窓の座標直入力パーサ ----
// "35.6,139.7" / "139.7,35.6" / "N35°36'50" E139°43'0"" / "35度36分 139度43分" 等を
// {lat,lng} に正規化する。座標と解釈できなければ null
export function parseCoordinateQuery(text) {
  const s = String(text || "").trim()
    .replace(/[，、]/g, ",")
    .replace(/北緯/g, "N").replace(/南緯/g, "S").replace(/東経/g, "E").replace(/西経/g, "W")
    .replace(/度/g, "°").replace(/分/g, "'").replace(/秒/g, '"')
    .replace(/[′’`]/g, "'").replace(/[″”]/g, '"');
  if (!s || !/\d/.test(s)) return null;
  const orderLatLng = (va, vb) => {
    const aIsLon = va.hemi === "E" || va.hemi === "W" || (Math.abs(va.v) > 90 && Math.abs(vb.v) <= 90);
    const bIsLat = vb.hemi === "N" || vb.hemi === "S";
    const lat = (aIsLon && !bIsLat) || bIsLat ? vb.v : va.v;
    const lng = (aIsLon && !bIsLat) || bIsLat ? va.v : vb.v;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  };
  const parseComponent = str => {
    const m = String(str).trim().match(/^([NSEW])?\s*([+-]?\d+(?:\.\d+)?)(?:\s*°\s*(\d+(?:\.\d+)?))?(?:\s*'\s*(\d+(?:\.\d+)?))?(?:\s*")?\s*([NSEW])?$/i);
    if (!m) return null;
    let v = Math.abs(parseFloat(m[2])) + (Number(m[3]) || 0) / 60 + (Number(m[4]) || 0) / 3600;
    const hemi = (m[1] || m[5] || "").toUpperCase();
    if (hemi === "S" || hemi === "W" || m[2].startsWith("-")) v = -v;
    return { v, hemi };
  };
  // コンマ区切りを最優先で試し、駄目なら空白区切りの全分割点を試す
  const candidates = s.includes(",")
    ? s.split(",").map(p => p.trim()).filter(Boolean)
    : s.split(/\s+/).filter(Boolean);
  for (let i = 1; i < candidates.length; i++) {
    const a = parseComponent(candidates.slice(0, i).join(" "));
    const b = parseComponent(candidates.slice(i).join(" "));
    if (a && b) {
      const result = orderLatLng(a, b);
      if (result) return result;
    }
  }
  return null;
}
