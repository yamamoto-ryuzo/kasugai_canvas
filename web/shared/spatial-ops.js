// 空間演算（GeoJSON 述語・範囲生成・バッファ）— 全エンジン共通の純粋計算部
// 静的配信のみで完結。重いバッファ（ライン/ポリゴン）は turf.js を
// 利用時だけ jsdelivr から遅延ロードするため常時コストはゼロ。
import { computeGroupStats } from "./attr-stats.js";

const TURF_URL = "https://cdn.jsdelivr.net/npm/@turf/turf@7.4.0/+esm";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
export const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;

// ---- 測地線（WGS84 Vincenty 逆問題。非収束時は球面にフォールバック） ----
export function geodesicInverse(a, b) {
  const f1 = a.lat * RAD, f2 = b.lat * RAD;
  const L = (b.lng - a.lng) * RAD;
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(f1));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(f2));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lam = L;
  for (let i = 0; i < 100; i++) {
    const sinL = Math.sin(lam), cosL = Math.cos(lam);
    const sinSig = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSig === 0) return { dist: 0, az1: 0, az2: 0 };
    const cosSig = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    const sig = Math.atan2(sinSig, cosSig);
    const sinA = cosU1 * cosU2 * sinL / sinSig;
    const cos2A = 1 - sinA * sinA;
    const cos2Sm = cos2A !== 0 ? cosSig - 2 * sinU1 * sinU2 / cos2A : 0;
    const C = WGS84_F / 16 * cos2A * (4 + WGS84_F * (4 - 3 * cos2A));
    const prev = lam;
    lam = L + (1 - C) * WGS84_F * sinA * (sig + C * sinSig * (cos2Sm + C * cosSig * (-1 + 2 * cos2Sm ** 2)));
    if (Math.abs(lam - prev) < 1e-12) {
      const u2 = cos2A * (WGS84_A ** 2 - (WGS84_A * (1 - WGS84_F)) ** 2) / (WGS84_A * (1 - WGS84_F)) ** 2;
      const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
      const B = u2 / 1024 * (256 + cos2A * (-128 + u2 * (74 - 47 * u2)));
      const dSig = B * sinSig * (cos2Sm + B / 4 * (cosSig * (-1 + 2 * cos2Sm ** 2)
        - B / 6 * cos2Sm * (-3 + 4 * cos2Sm ** 2) * (-3 + 4 * cos2Sm ** 2)));
      const az1 = Math.atan2(cosU2 * Math.sin(lam), cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lam));
      const az2 = Math.atan2(cosU1 * Math.sin(lam), -sinU1 * cosU2 + cosU1 * sinU2 * Math.cos(lam));
      return { dist: WGS84_A * (1 - WGS84_F) * A * (sig - dSig), az1: az1 * DEG, az2: az2 * DEG };
    }
  }
  // 非収束（ほぼ対蹠点）: 球面ハバーシンにフォールバック
  const dLat = f2 - f1, dLng = L;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dLng / 2) ** 2;
  const dist = 2 * WGS84_A * Math.asin(Math.min(1, Math.sqrt(s)));
  const az = (x, y) => Math.atan2(
    Math.sin((y.lng - x.lng) * RAD) * Math.cos(y.lat * RAD),
    Math.cos(x.lat * RAD) * Math.sin(y.lat * RAD) - Math.sin(x.lat * RAD) * Math.cos(y.lat * RAD) * Math.cos((y.lng - x.lng) * RAD)) * DEG;
  return { dist, az1: az(a, b), az2: az(a, b) };
}
export const segDistance = (a, b) => geodesicInverse(a, b).dist;

// 球面多角形面積（Chamberlain–Duquette。実務サイズなら十分な精度）
export function polygonArea(pts) {
  if (pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += (q.lng - p.lng) * RAD * (2 + Math.sin(p.lat * RAD) + Math.sin(q.lat * RAD));
  }
  return Math.abs(s * WGS84_A * WGS84_A / 2);
}

// 2点間の球面補間（fraction 0..1）
export function slerp(a, b, f) {
  const toVec = p => [Math.cos(p.lat * RAD) * Math.cos(p.lng * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lng * RAD), Math.sin(p.lat * RAD)];
  const A = toVec(a), B = toVec(b);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const th = Math.acos(dot);
  if (th < 1e-9) return { lat: a.lat, lng: a.lng };
  const sA = Math.sin((1 - f) * th) / Math.sin(th), sB = Math.sin(f * th) / Math.sin(th);
  const v = [sA * A[0] + sB * B[0], sA * A[1] + sB * B[1], sA * A[2] + sB * B[2]];
  return { lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) * DEG, lng: Math.atan2(v[1], v[0]) * DEG };
}

// 地点 + 方位角 + 距離 → 目的地点（球面 direct 問題）
export function destinationPoint(p, bearingDeg, distM) {
  const d = distM / WGS84_A, th = bearingDeg * RAD;
  const f1 = p.lat * RAD, l1 = p.lng * RAD;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return { lng: ((l2 * DEG + 540) % 360) - 180, lat: f2 * DEG };
}

// ---------- 範囲ジオメトリの生成 ----------
// 測地線円バッファ（点のバッファは turf を待たずこちらで生成）
export function circlePolygon(center, radiusMeters, steps = 64) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const p = destinationPoint(center, (360 / steps) * i, radiusMeters);
    ring.push([p.lng, p.lat]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

export function rectPolygon(west, south, east, north) {
  const mid = (west + east) / 2, midLat = (south + north) / 2;
  return {
    type: "Polygon",
    coordinates: [[
      [west, south], [mid, south], [east, south], [east, midLat],
      [east, north], [mid, north], [west, north], [west, midLat], [west, south],
    ]],
  };
}

// ---------- 包含・交差判定（緯度経度平面での近似。実務サイズでは十分） ----------
export function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 外環に含まれ全ての内環（穴）の外にあるか
export function pointInPolygonCoords(lng, lat, coords) {
  if (!coords?.length || !pointInRing(lng, lat, coords[0])) return false;
  for (let i = 1; i < coords.length; i++) if (pointInRing(lng, lat, coords[i])) return false;
  return true;
}

export function pointInPolygonGeom(lng, lat, geom) {
  if (geom?.type === "Polygon") return pointInPolygonCoords(lng, lat, geom.coordinates);
  if (geom?.type === "MultiPolygon") return geom.coordinates.some(c => pointInPolygonCoords(lng, lat, c));
  return false;
}

// 線分交差（端点接触も交差とみなす）
function segsIntersect(a, b, c, d) {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function ringsOf(geom) {
  if (geom?.type === "Polygon") return geom.coordinates;
  if (geom?.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
}

// LineString 座標列がポリゴンと交差するか（頂点包含 or 辺との交差）
function lineCrossesPolygon(line, polyGeom) {
  const rings = ringsOf(polyGeom);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    // 端点がポリゴン内なら交差（穴の中だけは除外）
    if (pointInPolygonGeom(a[0], a[1], polyGeom) || pointInPolygonGeom(b[0], b[1], polyGeom)) return true;
    for (const ring of rings) {
      for (let j = 1; j < ring.length; j++) {
        if (segsIntersect(a, b, ring[j - 1], ring[j])) return true;
      }
    }
  }
  // 退化ライン（1点）も包含で扱う
  if (line.length === 1) return pointInPolygonGeom(line[0][0], line[0][1], polyGeom);
  return false;
}

// Polygon/MultiPolygon 同士の交差: 辺交差 or 相互の頂点包含（完全包含も拾う）
function polygonIntersectsPolygon(aGeom, bGeom) {
  for (const ring of ringsOf(aGeom)) {
    if (lineCrossesPolygon(ring, bGeom)) return true;
  }
  // b が a を完全に含む場合は b 側頂点が a 内にあるか、b が a を完全に含む場合は
  // a の代表点が b 内にあるかで拾う（上の lineCrossesPolygon は a の辺だけ見る）
  const bFirst = ringsOf(bGeom)[0]?.[0];
  if (bFirst && pointInPolygonGeom(bFirst[0], bFirst[1], aGeom)) return true;
  return false;
}

// geom とポリゴン領域の交差判定（地物選択用）
export function geomIntersectsPolygon(geom, polyGeom) {
  if (!geom || !polyGeom) return false;
  switch (geom.type) {
    case "Point":
      return pointInPolygonGeom(geom.coordinates[0], geom.coordinates[1], polyGeom);
    case "MultiPoint":
      return geom.coordinates.some(c => pointInPolygonGeom(c[0], c[1], polyGeom));
    case "LineString":
      return lineCrossesPolygon(geom.coordinates, polyGeom);
    case "MultiLineString":
      return geom.coordinates.some(l => lineCrossesPolygon(l, polyGeom));
    case "Polygon":
    case "MultiPolygon":
      return polygonIntersectsPolygon(geom, polyGeom);
    case "GeometryCollection":
      return (geom.geometries || []).some(g => geomIntersectsPolygon(g, polyGeom));
    default:
      return false;
  }
}

export function selectFeatures(fc, regionGeom) {
  return (fc?.features || []).filter(f => geomIntersectsPolygon(f?.geometry, regionGeom));
}

// ---------- 範囲指定の正規化（AI ツール/外部 API からの入力を Polygon 系へ） ----------
// 受け付ける形: GeoJSON geometry(Polygon|MultiPolygon) / Feature / FeatureCollection(先頭面)
//   { bbox:[w,s,e,n] } / { center:[lng,lat]|{lng,lat}, radiusMeters:r } / [[lng,lat],...](環)
export function normalizeRegion(input) {
  if (!input) return null;
  if (Array.isArray(input) && input.length === 4 && input.every(Number.isFinite)) {
    return rectPolygon(input[0], input[1], input[2], input[3]);
  }
  if (Array.isArray(input) && input.length >= 3 && Array.isArray(input[0])) {
    const ring = input.map(c => [Number(c[0]), Number(c[1])]).filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    if (ring.length >= 3) return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
    return null;
  }
  if (typeof input === "string") {
    try { return normalizeRegion(JSON.parse(input)); } catch (e) { return null; }
  }
  if (input.bbox && Array.isArray(input.bbox) && input.bbox.length === 4) return normalizeRegion(input.bbox);
  const center = input.center && (Array.isArray(input.center)
    ? { lng: Number(input.center[0]), lat: Number(input.center[1]) }
    : { lng: Number(input.center.lng ?? input.center.longitude), lat: Number(input.center.lat ?? input.center.latitude) });
  if (center && Number.isFinite(center.lng) && Number.isFinite(center.lat) && Number.isFinite(Number(input.radiusMeters ?? input.radius))) {
    return circlePolygon(center, Number(input.radiusMeters ?? input.radius));
  }
  if (input.type === "Feature") return normalizeRegion(input.geometry);
  if (input.type === "FeatureCollection") {
    const f = (input.features || []).find(x => /Polygon/.test(x?.geometry?.type || ""));
    return f ? f.geometry : null;
  }
  if (input.type === "Polygon" || input.type === "MultiPolygon") return input;
  if (input.type === "Point") return circlePolygon({ lng: input.coordinates[0], lat: input.coordinates[1] }, Number(input.radiusMeters ?? input.radius ?? 0) || 0);
  return null;
}

// ---------- ポリゴン内集計（#30） ----------
// regionGeom 内の地物を対象に、groupField(任意)で GROUP BY 集計。
// groupField 未指定なら全体件数 + valueField の統計のみ。
export function aggregateWithin(fc, regionGeom, { groupField = null, valueField = null } = {}) {
  const inside = selectFeatures(fc, regionGeom);
  if (!groupField) {
    const one = { key: null, count: inside.length, sum: null, min: null, max: null, avg: null, numeric: 0 };
    if (valueField) {
      const g = computeGroupStats(inside.map(f => ({ ...f, properties: { __g: "", __v: f?.properties?.[valueField] } })), "__g", "__v")[0];
      if (g) Object.assign(one, { sum: g.sum, min: g.min, max: g.max, avg: g.avg, numeric: g.numeric });
    }
    return { features: inside, rows: [one] };
  }
  return { features: inside, rows: computeGroupStats(inside, groupField, valueField) };
}

// ---------- バッファ（#34） ----------
// Point/MultiPoint は測地線円を直接生成（turf 不要）。
// Line/Polygon は turf.js を遅延ロードして生成する。
let turfPromise = null;
let _turfMod = null;
// 解決済み turf を同期取得(evalGeomExpr 等の同期経路から使う)。
// 未ロード時は null — 呼び出し側は ensureTurf() で先行読込する
export function turfSync() { return _turfMod; }
export function ensureTurf() {
  turfPromise ||= import(TURF_URL).then(m => (_turfMod = (m.default && m.default.buffer ? m.default : m)));
  return turfPromise;
}

export async function bufferGeometry(geom, radiusMeters) {
  const r = Number(radiusMeters);
  if (!geom || !Number.isFinite(r) || r === 0) return null;
  if (geom.type === "Point") {
    return r > 0 ? circlePolygon({ lng: geom.coordinates[0], lat: geom.coordinates[1] }, r) : null;
  }
  if (geom.type === "MultiPoint") {
    return r > 0 ? {
      type: "MultiPolygon",
      coordinates: geom.coordinates.map(c => circlePolygon({ lng: c[0], lat: c[1] }, r).coordinates),
    } : null;
  }
  const turf = await ensureTurf();
  const out = turf.buffer({ type: "Feature", properties: {}, geometry: geom }, r / 1000, { units: "kilometers" });
  return out?.geometry || null;
}

// ジオメトリの bbox [w,s,e,n]
export function geomBbox(geom) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = c => {
    if (typeof c?.[0] === "number") {
      if (c[0] < box[0]) box[0] = c[0];
      if (c[1] < box[1]) box[1] = c[1];
      if (c[0] > box[2]) box[2] = c[0];
      if (c[1] > box[3]) box[3] = c[1];
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geom?.coordinates);
  return box[0] === Infinity ? null : box;
}

// ジオメトリの代表点（ズーム・ラベル用）
export function geomCentroid(geom) {
  const box = geomBbox(geom);
  return box ? { lng: (box[0] + box[2]) / 2, lat: (box[1] + box[3]) / 2 } : null;
}
