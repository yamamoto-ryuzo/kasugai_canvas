// ベクターデコードの共有モジュール。app.js(メインスレッド)と
// gpkg-worker.js(Web Worker)の両方から import されるため、
// DOM・window・Cesium に依存するコードは置かない

// WKB(ISO/EWKB)を GeoJSON ジオメトリに変換する。
// meta を渡すと EWKB SRID 等の付帯情報を meta.srid に記録する
export function wkbToGeoJsonGeometry(bytes, meta) {
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
    // ISOの次元付き型番(×1000)はEWKBフラグが全く無い場合のみ。SRID単独
    // (0x20000000|1)でも raw>=1000 になるため hasSrid も除外条件に含める
    if (!hasZ && !hasM && !hasSrid && raw >= 1000) {
      const variant = Math.floor(raw / 1000);
      hasZ = variant === 1 || variant === 3;
      hasM = variant === 2 || variant === 3;
      base = raw % 1000;
    }
    if (hasSrid) {
      // EWKB SRID を読み取り meta へ記録(座標変換はしない。呼び出し側が
      // 非 WGS84 を警告する判断材料に使う)
      const srid = view.getUint32(pos, littleEndian);
      pos += 4;
      if (meta) meta.srid = srid;
    }
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
    // 3点を通る円弧を折線近似する。p0 の次点から p2 までを out へ積む。
    // 共線(中心が求まらない)時は直線扱い。曲線の Z/M は近似に使わず 2D で出力する
    const strokeArc = (p0, p1, p2, out) => {
      const ax = p0[0], ay = p0[1], bx = p1[0], by = p1[1], cx = p2[0], cy = p2[1];
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (!Number.isFinite(d) || Math.abs(d) < 1e-15) { out.push([cx, cy]); return; }
      const aa = ax * ax + ay * ay, bb = bx * bx + by * by, cc = cx * cx + cy * cy;
      const ux = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / d;
      const uy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / d;
      const r = Math.hypot(ax - ux, ay - uy);
      const t0 = Math.atan2(ay - uy, ax - ux);
      const t1 = Math.atan2(by - uy, bx - ux);
      let t2 = Math.atan2(cy - uy, cx - ux);
      // t0→t2 の掃引方向は「経路上に t1 が来る向き」。反時計回りで正規化して
      // t1 が t0→t2 に収まらなければ時計回り側へ取り直す
      const ccw = a => { while (a <= t0) a += 2 * Math.PI; return a; };
      if (ccw(t1) <= ccw(t2)) t2 = ccw(t2);
      else { const cw = a => { while (a >= t0) a -= 2 * Math.PI; return a; }; t2 = cw(t2); }
      const n = Math.max(4, Math.ceil(Math.abs(t2 - t0) / (Math.PI / 18))); // ~10度分割
      for (let i = 1; i <= n; i++) {
        const t = t0 + (t2 - t0) * (i / n);
        out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]);
      }
    };
    // CircularString: 奇数個の制御点を (p0,p1,p2)(p2,p3,p4)… の連続円弧として展開
    const circularString = () => {
      const pts = points();
      if (pts.length < 3) return pts.map(p => [p[0], p[1]]);
      const out = [[pts[0][0], pts[0][1]]];
      let i = 0;
      for (; i + 2 < pts.length; i += 2) strokeArc(pts[i], pts[i + 1], pts[i + 2], out);
      // 偶数個など spec 違反の残り点は直線で繋ぐ
      for (; i < pts.length; i++) out.push([pts[i][0], pts[i][1]]);
      return out;
    };
    // CompoundCurve: LineString/CircularString の列を接続点重複なしで連結
    const joinCurveParts = geoms => {
      const out = [];
      for (const g of geoms) {
        const seg = g && g.coordinates;
        if (!Array.isArray(seg) || !seg.length) continue;
        out.push(...(out.length ? seg.slice(1) : seg));
      }
      return out;
    };
    // CurvePolygon: リング要素が「曲線」(LineString/CircularString/CompoundCurve)
    const curveRings = () => {
      const a = new Array(count());
      for (let i = 0; i < a.length; i++) {
        const g = readGeometry();
        a[i] = g && g.coordinates ? g.coordinates : [];
      }
      return a;
    };
    switch (base) {
      case 1: return { type: "Point", coordinates: point() };
      case 2: return { type: "LineString", coordinates: points() };
      case 3: return { type: "Polygon", coordinates: rings() };
      case 4: return { type: "MultiPoint", coordinates: children().map(g => g && g.coordinates) };
      case 5: return { type: "MultiLineString", coordinates: children().map(g => g && g.coordinates) };
      case 6: return { type: "MultiPolygon", coordinates: children().map(g => g && g.coordinates) };
      case 7: return { type: "GeometryCollection", geometries: children().filter(Boolean) };
      // ISO 曲線系(WKB 8-17)。GeoJSON に曲線型は無いため円弧を折線近似して展開する
      case 8: return { type: "LineString", coordinates: circularString() };             // CircularString
      case 9: return { type: "LineString", coordinates: joinCurveParts(children()) };    // CompoundCurve
      case 10: return { type: "Polygon", coordinates: curveRings() };                    // CurvePolygon
      case 11: return { type: "MultiLineString", coordinates: children().map(g => g && g.coordinates).filter(Boolean) }; // MultiCurve
      case 12: return { type: "MultiPolygon", coordinates: children().map(g => g && g.coordinates).filter(Boolean) };  // MultiSurface
      case 13: case 14: return null; // Curve/Surface は抽象型
      case 15: case 16: return { type: "MultiPolygon", coordinates: children().map(g => g && g.coordinates).filter(Boolean) }; // PolyhedralSurface/TIN
      case 17: return { type: "Polygon", coordinates: rings() };                         // Triangle(構造は Polygon 同型)
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

// GeoJSON ジオメトリの座標を走査して {west,south,east,north} を返す。
// GPkgBinary ヘッダにエンベロープが無い地物の中心点計算用
export function geoJsonGeometryEnvelope(geom) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && coords.length >= 2) {
      const x = coords[0], y = coords[1];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (x < west) west = x;
        if (x > east) east = x;
        if (y < south) south = y;
        if (y > north) north = y;
      }
      return;
    }
    for (const c of coords) visit(c);
  };
  if (geom && geom.type === "GeometryCollection") {
    for (const g of geom.geometries || []) {
      const env = geoJsonGeometryEnvelope(g);
      if (env) {
        if (env.west < west) west = env.west;
        if (env.east > east) east = env.east;
        if (env.south < south) south = env.south;
        if (env.north > north) north = env.north;
      }
    }
  } else if (geom && geom.coordinates) {
    visit(geom.coordinates);
  }
  return west <= east && south <= north ? { west, south, east, north } : null;
}

// 座標変換 fn(x, y) → [x', y'] を GeoJSON ジオメトリの全座標へその場で適用する。
// z/m 等の3番目以降の座標値はそのまま保持する(GPKG 投影座標→WGS84 再投影用)
export function transformGeoJsonGeometry(geom, fn) {
  if (!geom || !fn) return geom;
  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && coords.length >= 2) {
      const [x, y] = fn(coords[0], coords[1]);
      coords[0] = x;
      coords[1] = y;
      return;
    }
    for (const c of coords) visit(c);
  };
  if (geom.type === "GeometryCollection") {
    for (const g of geom.geometries || []) transformGeoJsonGeometry(g, fn);
  } else {
    visit(geom.coordinates);
  }
  return geom;
}

// ネイティブ座標のエンベロープ {west,south,east,north} を変換後の座標系の
// エンベロープへ。投影法によっては変換後も軸平行にならないため、4隅を変換して
// 外接矩形を取る(フィルター判定なので上位集合側に倒す)
export function transformEnvelope(env, fn) {
  if (!env || !fn) return env;
  const pts = [
    fn(env.west, env.south), fn(env.east, env.south),
    fn(env.west, env.north), fn(env.east, env.north),
  ];
  const xs = pts.map(p => p[0]).filter(Number.isFinite);
  const ys = pts.map(p => p[1]).filter(Number.isFinite);
  if (!xs.length || !ys.length) return env;
  return { west: Math.min(...xs), south: Math.min(...ys), east: Math.max(...xs), north: Math.max(...ys) };
}

export const quoteSqlIdent = name => `"${String(name).replace(/"/g, '""')}"`;
export const quoteSqlLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
