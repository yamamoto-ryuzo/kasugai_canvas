// ベクターデコードの共有モジュール。app.js(メインスレッド)と
// gpkg-worker.js(Web Worker)の両方から import されるため、
// DOM・window・Cesium に依存するコードは置かない

// WKB(ISO/EWKB)を GeoJSON ジオメトリに変換する
export function wkbToGeoJsonGeometry(bytes) {
  if (!bytes || !bytes.byteLength) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const readGeometry = () => {
    const littleEndian = view.getUint8(pos) === 1; pos += 1;
    const raw = view.getUint32(pos, littleEndian); pos += 4;
    let base = raw & 0xffff;
    let hasZ = (raw & 0x80000000) !== 0;
    let hasM = (raw & 0x40000000) !== 0;
    const hasSrid = (raw & 0x20000000) !== 0;
    if (!hasZ && !hasM && raw >= 1000) {
      const variant = Math.floor(raw / 1000);
      hasZ = variant === 1 || variant === 3;
      hasM = variant === 2 || variant === 3;
      base = raw % 1000;
    }
    if (hasSrid) pos += 4;
    const count = () => { const n = view.getUint32(pos, littleEndian); pos += 4; return n; };
    const point = () => {
      const c = [view.getFloat64(pos, littleEndian), view.getFloat64(pos + 8, littleEndian)];
      pos += 16;
      if (hasZ) { c.push(view.getFloat64(pos, littleEndian)); pos += 8; }
      if (hasM) pos += 8; // M 値は描画しない
      return c;
    };
    const points = () => { const a = new Array(count()); for (let i = 0; i < a.length; i++) a[i] = point(); return a; };
    const rings = () => { const a = new Array(count()); for (let i = 0; i < a.length; i++) a[i] = points(); return a; };
    const children = () => { const a = new Array(count()); for (let i = 0; i < a.length; i++) a[i] = readGeometry(); return a; };
    switch (base) {
      case 1: return { type: "Point", coordinates: point() };
      case 2: return { type: "LineString", coordinates: points() };
      case 3: return { type: "Polygon", coordinates: rings() };
      case 4: return { type: "MultiPoint", coordinates: children().map(g => g && g.coordinates) };
      case 5: return { type: "MultiLineString", coordinates: children().map(g => g && g.coordinates) };
      case 6: return { type: "MultiPolygon", coordinates: children().map(g => g && g.coordinates) };
      case 7: return { type: "GeometryCollection", geometries: children().filter(Boolean) };
      default: return null;
    }
  };
  try { return readGeometry(); } catch { return null; }
}

// ベクター属性値を GeoJSON properties に載せられる形へ正規化する
export function sanitizeVectorPropertyValue(value) {
  return typeof value === "bigint"
    ? (Number.isSafeInteger(Number(value)) ? Number(value) : value.toString())
    : value;
}

// GeoPackage バイナリ(GPkgBinary)から WKB 部分を切り出す。
// ヘッダ: 'GP'(2B) + version(1B) + flags(1B) + srs_id(4B) + エンベロープ(0/32/48/64B)。
// flags bit1-3 がエンベロープ種別(0=無し,1=XY,2=XYZ,3=XYM,4=XYZM)
export function gpkgGeometryToWkb(value) {
  if (!(value instanceof Uint8Array) || value.length < 8 || value[0] !== 0x47 || value[1] !== 0x50) return null;
  const envelopeBytes = [0, 32, 48, 48, 64][(value[3] >> 1) & 0x07] ?? 0;
  const wkb = value.subarray(8 + envelopeBytes);
  return wkb.length ? wkb : null;
}

// GPkgBinary ヘッダのエンベロープを {west,south,east,north} で返す。
// flags bit0 がヘッダ値のエンディアン(1=little)。属性一覧の行位置(中心点)に使う
export function gpkgGeometryEnvelope(value) {
  if (!(value instanceof Uint8Array) || value.length < 40 || value[0] !== 0x47 || value[1] !== 0x50) return null;
  const type = (value[3] >> 1) & 0x07;
  if (type < 1 || type > 4) return null;
  const little = (value[3] & 1) === 1;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  try {
    return { west: view.getFloat64(8, little), east: view.getFloat64(16, little), south: view.getFloat64(24, little), north: view.getFloat64(32, little) };
  } catch { return null; }
}

export const quoteSqlIdent = name => `"${String(name).replace(/"/g, '""')}"`;
export const quoteSqlLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
