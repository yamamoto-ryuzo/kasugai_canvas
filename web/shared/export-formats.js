// レイヤーエクスポート用シリアライザ（ブラウザ完結・外部依存なし）
// - GeoJSON → CSV/TSV（QGIS の CSV エクスポート GEOMETRY=AS_WKT 互換: 先頭列 "WKT"）
// - GeoJSON → KML（属性は ExtendedData）
// - GeoJSON → FlatGeobuf（実行時のみ flatgeobuf ESM を動的 import。vector-load.js と同URLのため
//   読み込み済みなら追加取得は発生しない）
// - GeoJSON → Shapefile（.shp/.shx/.dbf/.prj/.cpg を非圧縮 ZIP に同梱。
//   ジオメトリ種別ごとにファイル分割、Z 座標を含む場合は Z 形状として出力）

const FGB_URL = "https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/geojson.js/+esm";
const te = new TextEncoder();
const td = new TextDecoder();

// ---------- WKT ----------
const isNumArr = c => Array.isArray(c) && typeof c[0] === "number";

function coordsHaveZ(coords) {
  if (!Array.isArray(coords)) return false;
  if (isNumArr(coords)) return coords.length >= 3;
  return coords.some(coordsHaveZ);
}

function geomHasZ(g) {
  if (!g) return false;
  if (g.type === "GeometryCollection") return (g.geometries || []).some(geomHasZ);
  return coordsHaveZ(g.coordinates);
}

const fmtN = n => Number.isFinite(+n) ? String(+n) : "0";
const wktPt = (c, z) => `${fmtN(c[0])} ${fmtN(c[1])}${z ? " " + fmtN(c[2]) : ""}`;
const wktLine = (cs, z) => `(${(cs || []).map(c => wktPt(c, z)).join(", ")})`;

function wktGeom(g, z) {
  const Z = z ? " Z" : "";
  const cs = g.coordinates;
  switch (g.type) {
    case "Point": return `POINT${Z} ${isNumArr(cs) ? wktPt(cs, z) : "EMPTY"}`;
    case "MultiPoint": return !cs || !cs.length ? `MULTIPOINT${Z} EMPTY` : `MULTIPOINT${Z} (${cs.map(c => wktPt(c, z)).join(", ")})`;
    case "LineString": return `LINESTRING${Z} ${cs && cs.length ? wktLine(cs, z) : "EMPTY"}`;
    case "MultiLineString": return !cs || !cs.length ? `MULTILINESTRING${Z} EMPTY` : `MULTILINESTRING${Z} (${cs.map(l => wktLine(l, z)).join(", ")})`;
    case "Polygon": return !cs || !cs.length ? `POLYGON${Z} EMPTY` : `POLYGON${Z} (${cs.map(r => wktLine(r, z)).join(", ")})`;
    case "MultiPolygon": return !cs || !cs.length ? `MULTIPOLYGON${Z} EMPTY` : `MULTIPOLYGON${Z} (${cs.map(p => `(${p.map(r => wktLine(r, z)).join(", ")})`).join(", ")})`;
    case "GeometryCollection": return `GEOMETRYCOLLECTION${Z} ${(g.geometries || []).length ? `(${g.geometries.map(x => wktGeom(x, z)).join(", ")})` : "EMPTY"}`;
    default: return "";
  }
}

// GeoJSON ジオメトリ → WKT。座標が3次元を含む場合は " Z" 付きで出力する
export function geometryToWKT(g) {
  return g && g.type ? wktGeom(g, geomHasZ(g)) : "";
}

// ---------- CSV / TSV（WKT 列付き・QGIS GEOMETRY=AS_WKT 互換） ----------
export function toDelimited(fc, delimiter = ",") {
  const features = (fc && fc.features || []).filter(Boolean);
  const cols = [];
  const seen = new Set();
  for (const f of features) {
    const p = f.properties;
    if (p && typeof p === "object") {
      for (const k of Object.keys(p)) {
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
  }
  const esc = v => {
    if (v == null) return "";
    if (typeof v === "object") v = JSON.stringify(v);
    v = String(v);
    return v.includes('"') || v.includes(delimiter) || /[\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const rows = [["WKT", ...cols].map(esc).join(delimiter)];
  for (const f of features) {
    const p = f.properties && typeof f.properties === "object" ? f.properties : {};
    rows.push([geometryToWKT(f.geometry), ...cols.map(c => p[c])].map(esc).join(delimiter));
  }
  return "﻿" + rows.join("\r\n") + "\r\n"; // 先頭は UTF-8 BOM（Excel で文字化けさせないため）
}

// ---------- KML ----------
const xmlEsc = s => String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const kmlCoords = cs => (cs || []).map(c => `${+c[0] || 0},${+c[1] || 0}${c.length > 2 ? "," + (+c[2] || 0) : ""}`).join(" ");
const kmlPoint = c => `<Point><coordinates>${kmlCoords([c])}</coordinates></Point>`;
const kmlLine = cs => `<LineString><coordinates>${kmlCoords(cs)}</coordinates></LineString>`;
const kmlPoly = rings => {
  const [outer, ...inners] = rings;
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(outer)}</coordinates></LinearRing></outerBoundaryIs>`
    + inners.map(r => `<innerBoundaryIs><LinearRing><coordinates>${kmlCoords(r)}</coordinates></LinearRing></innerBoundaryIs>`).join("")
    + `</Polygon>`;
};

function kmlGeom(g) {
  if (!g) return "";
  switch (g.type) {
    case "Point": return kmlPoint(g.coordinates);
    case "MultiPoint": return `<MultiGeometry>${g.coordinates.map(kmlPoint).join("")}</MultiGeometry>`;
    case "LineString": return kmlLine(g.coordinates);
    case "MultiLineString": return `<MultiGeometry>${g.coordinates.map(kmlLine).join("")}</MultiGeometry>`;
    case "Polygon": return kmlPoly(g.coordinates);
    case "MultiPolygon": return `<MultiGeometry>${g.coordinates.map(kmlPoly).join("")}</MultiGeometry>`;
    case "GeometryCollection": return `<MultiGeometry>${(g.geometries || []).map(kmlGeom).join("")}</MultiGeometry>`;
    default: return "";
  }
}

export function toKml(fc, docName = "layer") {
  const marks = (fc.features || []).filter(f => f && f.geometry).map(f => {
    const p = f.properties && typeof f.properties === "object" ? f.properties : {};
    const name = p.name ?? p.title ?? p.NAME;
    const data = Object.entries(p).map(([k, v]) =>
      `<Data name="${xmlEsc(k)}"><value>${xmlEsc(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v)}</value></Data>`).join("");
    return `<Placemark>${name != null && name !== "" ? `<name>${xmlEsc(name)}</name>` : ""}${data ? `<ExtendedData>${data}</ExtendedData>` : ""}${kmlGeom(f.geometry)}</Placemark>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEsc(docName)}</name>${marks}</Document></kml>`;
}

// ---------- FlatGeobuf（動的 import・未読み込み時のみネットワーク取得） ----------
export async function toFlatGeobuf(fc) {
  const { serialize } = await import(FGB_URL);
  const features = (fc.features || []).filter(f => f && f.geometry);
  return serialize({ type: "FeatureCollection", features });
}

// ---------- Shapefile（.shp/.shx/.dbf/.prj/.cpg → 非圧縮 ZIP） ----------
// 形状タイプ: Point=1 Polyline=3 Polygon=5 MultiPoint=8 / Z版=11/13/15/18
const PRJ_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const NULL_REC = new Uint8Array(4); // shape type 0 = Null Shape

function concatBytes(arrs) {
  const n = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function ringArea(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

// GeoJSON ジオメトリ → shapefile のグループ別レコード。
// Multi* は shapefile のパート構造にそのまま対応するため分割せず、
// GeometryCollection のみ構成要素へ展開する
function explodeGeom(g) {
  if (!g) return [];
  switch (g.type) {
    case "Point": case "MultiPoint": return [{ cls: "point", geom: g }];
    case "LineString": case "MultiLineString": return [{ cls: "line", geom: g }];
    case "Polygon": case "MultiPolygon": return [{ cls: "polygon", geom: g }];
    case "GeometryCollection": return (g.geometries || []).flatMap(explodeGeom);
    default: return [];
  }
}

function coordsBBox(cs, z) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const walk = c => {
    if (isNumArr(c)) {
      const x = +c[0] || 0, y = +c[1] || 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z) { const zz = +c[2] || 0; if (zz < z0) z0 = zz; if (zz > z1) z1 = zz; }
      return;
    }
    if (Array.isArray(c)) c.forEach(walk);
  };
  walk(cs);
  return {
    x0: Number.isFinite(x0) ? x0 : 0, y0: Number.isFinite(y0) ? y0 : 0,
    x1: Number.isFinite(x1) ? x1 : 0, y1: Number.isFinite(y1) ? y1 : 0,
    z0: Number.isFinite(z0) ? z0 : 0, z1: Number.isFinite(z1) ? z1 : 0,
  };
}

// ポリゴンのリング列（shapefile 規約: 外環=時計回り・内環=反時計回り）に正規化
function polyPartsFixed(g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : (g.coordinates || []);
  const out = [];
  for (const p of polys) {
    (p || []).forEach((ring, i) => {
      if (!Array.isArray(ring) || ring.length < 3) return;
      const first = ring[0], last = ring[ring.length - 1];
      const closed = first[0] === last[0] && first[1] === last[1];
      const fixed = closed ? ring : [...ring, first];
      const isCW = ringArea(fixed) < 0;
      out.push(isCW === (i === 0) ? fixed : fixed.slice().reverse());
    });
  }
  return out;
}

function recPointBytes(shapeType, c, z) {
  const buf = new DataView(new ArrayBuffer(z ? 36 : 20));
  buf.setInt32(0, shapeType, true);
  buf.setFloat64(4, +c[0] || 0, true);
  buf.setFloat64(12, +c[1] || 0, true);
  if (z) buf.setFloat64(20, +c[2] || 0, true); // m(28) は 0 のまま
  return new Uint8Array(buf.buffer);
}

function recMultiPointBytes(shapeType, pts, z) {
  const n = pts.length;
  const zLen = z ? 16 + n * 8 : 0;
  const buf = new DataView(new ArrayBuffer(4 + 32 + 4 + n * 16 + zLen + zLen));
  const bb = coordsBBox(pts, z);
  let o = 0;
  buf.setInt32(o, shapeType, true); o += 4;
  for (const v of [bb.x0, bb.y0, bb.x1, bb.y1]) { buf.setFloat64(o, v, true); o += 8; }
  buf.setInt32(o, n, true); o += 4;
  for (const c of pts) { buf.setFloat64(o, +c[0] || 0, true); buf.setFloat64(o + 8, +c[1] || 0, true); o += 16; }
  if (z) {
    buf.setFloat64(o, bb.z0, true); buf.setFloat64(o + 8, bb.z1, true); o += 16;
    for (const c of pts) { buf.setFloat64(o, +c[2] || 0, true); o += 8; }
    o += 16; // mmin/mmax
    // m 配列はゼロ初期化のまま
  }
  return new Uint8Array(buf.buffer);
}

function recPolyBytes(shapeType, parts, z) {
  const numPoints = parts.reduce((a, p) => a + p.length, 0);
  const zLen = z ? 16 + numPoints * 8 : 0;
  const buf = new DataView(new ArrayBuffer(4 + 32 + 8 + parts.length * 4 + numPoints * 16 + zLen + zLen));
  const bb = coordsBBox(parts, z);
  let o = 0;
  buf.setInt32(o, shapeType, true); o += 4;
  for (const v of [bb.x0, bb.y0, bb.x1, bb.y1]) { buf.setFloat64(o, v, true); o += 8; }
  buf.setInt32(o, parts.length, true); o += 4;
  buf.setInt32(o, numPoints, true); o += 4;
  let idx = 0;
  for (const p of parts) { buf.setInt32(o, idx, true); o += 4; idx += p.length; }
  for (const p of parts) for (const c of p) { buf.setFloat64(o, +c[0] || 0, true); buf.setFloat64(o + 8, +c[1] || 0, true); o += 16; }
  if (z) {
    buf.setFloat64(o, bb.z0, true); buf.setFloat64(o + 8, bb.z1, true); o += 16;
    for (const p of parts) for (const c of p) { buf.setFloat64(o, +c[2] || 0, true); o += 8; }
    o += 16; // mmin/mmax
  }
  return new Uint8Array(buf.buffer);
}

function recContent(geom, cls, z, singlePointType) {
  if (cls === "point") {
    if (geom.type === "Point" && singlePointType && isNumArr(geom.coordinates)) {
      return recPointBytes(z ? 11 : 1, geom.coordinates, z);
    }
    const pts = geom.type === "Point" ? [geom.coordinates] : (geom.coordinates || []);
    if (!pts.length) return NULL_REC;
    return recMultiPointBytes(z ? 18 : 8, pts, z);
  }
  if (cls === "line") {
    const parts = geom.type === "LineString" ? [geom.coordinates || []] : (geom.coordinates || []);
    const valid = parts.filter(p => p.length >= 2);
    if (!valid.length) return NULL_REC;
    return recPolyBytes(z ? 13 : 3, valid, z);
  }
  const rings = polyPartsFixed(geom).filter(r => r.length >= 4);
  if (!rings.length) return NULL_REC;
  return recPolyBytes(z ? 15 : 5, rings, z);
}

function shpHeader(shapeType, fileLenBytes, bb) {
  const h = new DataView(new ArrayBuffer(100));
  h.setInt32(0, 9994);                  // file code (BE)
  h.setInt32(24, fileLenBytes / 2);     // file length in 16-bit words (BE)
  h.setInt32(28, 1000, true);           // version (LE)
  h.setInt32(32, shapeType, true);
  h.setFloat64(36, bb.x0, true); h.setFloat64(44, bb.y0, true);
  h.setFloat64(52, bb.x1, true); h.setFloat64(60, bb.y1, true);
  h.setFloat64(68, bb.z0, true); h.setFloat64(76, bb.z1, true);
  return new Uint8Array(h.buffer);
}

// DBF フィールド名: 10バイト以内・ユニークに正規化
function dbfName(raw, used) {
  let s = String(raw).replace(/[^\w]/g, "_") || "f";
  while (te.encode(s).length > 10) s = s.slice(0, -1);
  let name = s, n = 1;
  while (used.has(name)) {
    const suf = `_${n++}`;
    let base = s;
    while (te.encode(base).length + suf.length > 10) base = base.slice(0, -1);
    name = base + suf;
  }
  used.add(name);
  return name;
}

function dbfValue(b8, off, f, v) {
  b8.fill(0x20, off, off + f.len);
  if (f.type === "L") { b8[off] = v === true ? 0x54 : v === false ? 0x46 : 0x3F; return; }
  if (v == null) return;
  let s;
  if (f.type === "N") s = Number.isFinite(+v) ? (+v).toFixed(f.dec).slice(0, f.len) : "";
  else s = typeof v === "object" ? JSON.stringify(v) : String(v);
  const nb = te.encode(s);
  if (f.type === "N") b8.set(nb.slice(0, f.len), off + f.len - Math.min(nb.length, f.len)); // 右寄せ
  else b8.set(nb.slice(0, f.len), off); // 左寄せ
}

function buildDbf(rows) {
  const keys = [];
  const seen = new Set();
  for (const p of rows) {
    if (p && typeof p === "object") {
      for (const k of Object.keys(p)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  const used = new Set();
  const fields = keys.map(k => {
    let type = "C", len = 254, dec = 0;
    const vals = rows.map(r => r[k]).filter(v => v != null);
    if (vals.length && vals.every(v => typeof v === "number")) {
      type = "N"; len = 18;
      dec = vals.every(v => Number.isInteger(v)) ? 0 : 6;
    } else if (vals.length && vals.every(v => typeof v === "boolean")) {
      type = "L"; len = 1;
    } else if (!vals.length) {
      len = 80;
    }
    return { key: k, name: dbfName(k, used), type, len, dec };
  });
  const nRec = rows.length;
  const headerLen = 32 + 32 * fields.length + 1;
  const recLen = 1 + fields.reduce((a, f) => a + f.len, 0);
  const b8 = new Uint8Array(headerLen + recLen * nRec + 1);
  const buf = new DataView(b8.buffer);
  const d = new Date();
  b8[0] = 0x03;
  b8[1] = d.getFullYear() - 1900; b8[2] = d.getMonth() + 1; b8[3] = d.getDate();
  buf.setUint32(4, nRec, true);
  buf.setUint16(8, headerLen, true);
  buf.setUint16(10, recLen, true);
  let o = 32;
  for (const f of fields) {
    b8.set(te.encode(f.name).slice(0, 11), o);
    b8[o + 11] = f.type.charCodeAt(0);
    b8[o + 16] = f.len;
    b8[o + 17] = f.dec;
    o += 32;
  }
  b8[o] = 0x0D;
  o = headerLen;
  for (const r of rows) {
    b8[o] = 0x20;
    let p = o + 1;
    for (const f of fields) { dbfValue(b8, p, f, r[f.key]); p += f.len; }
    o += recLen;
  }
  b8[b8.length - 1] = 0x1A;
  return b8;
}

function buildGroup(recs, cls, z, allSinglePoint) {
  const shapeType = cls === "point"
    ? (allSinglePoint ? (z ? 11 : 1) : (z ? 18 : 8))
    : cls === "line" ? (z ? 13 : 3) : (z ? 15 : 5);
  const contents = recs.map(r => recContent(r.geom, cls, z, allSinglePoint));
  const bb = coordsBBox(recs.map(r => r.geom.coordinates), z);
  const shpParts = [];
  const offsets = [];
  let off = 100;
  contents.forEach((c, i) => {
    const rh = new DataView(new ArrayBuffer(8));
    rh.setInt32(0, i + 1);           // record number (BE)
    rh.setInt32(4, c.length / 2);    // content length in words (BE)
    shpParts.push(new Uint8Array(rh.buffer), c);
    offsets.push(off);
    off += 8 + c.length;
  });
  const shp = concatBytes([shpHeader(shapeType, off, bb), ...shpParts]);
  const shxEnt = new DataView(new ArrayBuffer(8 * contents.length));
  contents.forEach((c, i) => {
    shxEnt.setInt32(i * 8, offsets[i] / 2);      // offset in words (BE)
    shxEnt.setInt32(i * 8 + 4, c.length / 2);    // content length in words (BE)
  });
  const shx = concatBytes([shpHeader(shapeType, 100 + 8 * contents.length, bb), new Uint8Array(shxEnt.buffer)]);
  const dbf = buildDbf(recs.map(r => r.props));
  return { shp, shx, dbf };
}

// ---------- ZIP（store 方式・非圧縮） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(entries) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = te.encode(e.name);
    const crc = crc32(e.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034B50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 flag
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, e.data.length, true); lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, e.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014B50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true); cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054B50, true);
  eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdStart, true);
  return concatBytes([...chunks, ...central, new Uint8Array(eocd.buffer)]);
}

function toShapefileZip(fc, baseName) {
  const groups = { point: [], line: [], polygon: [] };
  let skipped = 0;
  for (const f of fc.features || []) {
    if (!f || !f.geometry) { skipped++; continue; }
    const parts = explodeGeom(f.geometry);
    if (!parts.length) { skipped++; continue; }
    const props = f.properties && typeof f.properties === "object" ? f.properties : {};
    for (const p of parts) groups[p.cls].push({ geom: p.geom, props });
  }
  const active = Object.values(groups).filter(r => r.length).length;
  const entries = [];
  const suffix = { point: "points", line: "lines", polygon: "polygons" };
  for (const cls of Object.keys(groups)) {
    const recs = groups[cls];
    if (!recs.length) continue;
    const z = recs.some(r => coordsHaveZ(r.geom.coordinates));
    const allSingle = cls === "point" && recs.every(r => r.geom.type === "Point");
    const g = buildGroup(recs, cls, z, allSingle);
    const stem = active > 1 ? `${baseName}_${suffix[cls]}` : baseName;
    entries.push(
      { name: `${stem}.shp`, data: g.shp },
      { name: `${stem}.shx`, data: g.shx },
      { name: `${stem}.dbf`, data: g.dbf },
      { name: `${stem}.prj`, data: te.encode(PRJ_WGS84) },
      { name: `${stem}.cpg`, data: te.encode("UTF-8") },
    );
  }
  if (!entries.length) return null;
  return { data: zipStore(entries), skipped };
}

// ---------- XLSX（SheetJS 遅延ロード、#73）----------
// xlsx.js(SheetJS CE) は Apache-2.0。未使用時にページ重量へ影響しないよう
// 初回エクスポート時のみ CDN から script 注入する
let _xlsxPromise = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!_xlsxPromise) {
    _xlsxPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error("XLSX init failed"));
      s.onerror = () => reject(new Error("xlsx.js の読み込みに失敗しました"));
      document.head.append(s);
    });
    _xlsxPromise.catch(() => { _xlsxPromise = null; }); // 失敗時は再試行可能に
  }
  return _xlsxPromise;
}

// xlsx 行上限（UI ブロック防止のための安全側。xlsx 仕様上限は 1,048,575）
const XLSX_MAX_ROWS = 200000;

// 複数シート一括 xlsx。sheets: [{ name, rows: [[v,...],...] }]（先頭行=ヘッダ）。
// → { data: Uint8Array, sheets: N, skipped: 上限超過で切り捨てた行数 }
export async function rowsToXlsx(sheets) {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  let skipped = 0;
  for (const { name, rows } of sheets) {
    const src = Array.isArray(rows) ? rows : [];
    const safe = src.slice(0, XLSX_MAX_ROWS);
    skipped += src.length - safe.length;
    const ws = XLSX.utils.aoa_to_sheet(safe);
    XLSX.utils.book_append_sheet(
      wb, ws,
      String(name || "Sheet").replace(/[\\/?*\[\]:]/g, "_").slice(0, 31));
  }
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return { data: new Uint8Array(out), sheets: sheets.length, skipped };
}

// ---------- エクスポート入口 ----------
// fc: GeoJSON FeatureCollection, format: 下記 id, baseName: 出力ファイル名（拡張子なし）
// → { data: string|Uint8Array, ext, mime, count, skipped } または null
export async function exportFeatureCollection(fc, format, baseName = "layer") {
  const features = (fc && fc.features || []).filter(Boolean);
  if (!features.length) return null;
  const count = features.length;
  switch (format) {
    case "geojson":
      return { data: JSON.stringify(fc), ext: "geojson", mime: "application/geo+json", count };
    case "csv":
      return { data: toDelimited(fc, ","), ext: "csv", mime: "text/csv;charset=utf-8", count };
    case "tsv":
      return { data: toDelimited(fc, "\t"), ext: "tsv", mime: "text/tab-separated-values;charset=utf-8", count };
    case "kml":
      return { data: toKml(fc, baseName), ext: "kml", mime: "application/vnd.google-earth.kml+xml", count };
    case "xlsx": {
      // 属性キーの和集合を列にして型を保持（number/boolean はセル値のまま）
      const keys = [...new Set(features.flatMap(f => Object.keys(f.properties || {})))];
      const rows = [keys, ...features.map(f => keys.map(k => {
        const v = f.properties?.[k];
        return v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : v);
      }))];
      const r = await rowsToXlsx([{ name: baseName, rows }]);
      return { data: r.data, ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", count, skipped: r.skipped };
    }
    case "fgb": {
      const noGeom = features.length - features.filter(f => f.geometry).length;
      const data = await toFlatGeobuf(fc);
      return { data, ext: "fgb", mime: "application/octet-stream", count, skipped: noGeom };
    }
    case "shp": {
      const r = toShapefileZip(fc, baseName);
      if (!r) return null;
      return { data: r.data, ext: "zip", mime: "application/zip", count, skipped: r.skipped };
    }
    default:
      return null;
  }
}
