// deck.gl Tile3DLayer 用: テレイン概念のない 2D エンジン（MapLibre/OpenLayers/Leaflet）で
// 絶対高を持つ 3D Tiles が z=0 平面から浮いて見える問題を補正する。
// バウンディングボリュームの最小測地高を見積もり、tileset.modelMatrix に
// ローカル Up 方向の平行移動を左掛けして最下端を z≈0 に接地させる。
// .kasc オプション: ground=off で自動接地を無効化、zoffset=<m> で高さを手動補正（+で上げる）

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

// ECEF → 測地座標（Bowring 法。度数法で {lon,lat,h(m)} を返す）
function ecefToGeodetic(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  if (p < 1e-9) return { lon, lat: Math.sign(z) * Math.PI / 2, h: Math.abs(z) - WGS84_B };
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const st = Math.sin(theta), ct = Math.cos(theta);
  const lat = Math.atan2(z + WGS84_EP2 * WGS84_B * st * st * st, p - WGS84_E2 * WGS84_A * ct * ct * ct);
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return { lon, lat, h: p / Math.cos(lat) - n };
}

// box（center + 3半軸ベクトル）の8隅の最小測地高
function boxMinHeight(cx, cy, cz, ax, ay, az) {
  let min = Infinity;
  for (let i = 0; i < 8; i++) {
    const s0 = i & 1 ? 1 : -1, s1 = i & 2 ? 1 : -1, s2 = i & 4 ? 1 : -1;
    const h = ecefToGeodetic(
      cx + s0 * ax[0] + s1 * ay[0] + s2 * az[0],
      cy + s0 * ax[1] + s1 * ay[1] + s2 * az[1],
      cz + s0 * ax[2] + s1 * ay[2] + s2 * az[2]).h;
    if (h < min) min = h;
  }
  return min;
}

// バウンディングボリュームの最小測地高を推定する。
// 戻り値: { h, exact } — exact=true は box/region 由来の確定的な最小値。
// sphere は水平半径が支配する緩い球なので h-r は下振れし得るため exact=false 扱い
function bvMinHeight(bv, depth = 0) {
  if (!bv || depth > 4) return null;
  // loaders.gl Tile3DBoundingVolume 系ラッパーは .boundingVolume に実体を持つ
  if (bv.boundingVolume && bv.boundingVolume !== bv) {
    const inner = bvMinHeight(bv.boundingVolume, depth + 1);
    if (inner) return inner;
  }
  // region: [west,south,east,north,minH,maxH]（rad, m）
  if (Array.isArray(bv.region)) return { h: bv.region[4], exact: true };
  if (typeof bv.minimumHeight === "number") return { h: bv.minimumHeight, exact: true };
  // box: [cx,cy,cz, a1x,a1y,a1z, a2.., a3..] 12数値
  if (Array.isArray(bv.box) && bv.box.length === 12) {
    return { h: boxMinHeight(bv.box[0], bv.box[1], bv.box[2], bv.box.slice(3, 6), bv.box.slice(6, 9), bv.box.slice(9, 12)), exact: true };
  }
  // math.gl OrientedBoundingBox: center(Vector3) + halfAxes(Matrix3, 列優先9要素)
  const center = bv.center || bv.boundingSphere?.center;
  if (center && (bv.halfAxes || bv.halfAxis)) {
    const ha = bv.halfAxes || bv.halfAxis;
    const col = i => [ha[i * 3], ha[i * 3 + 1], ha[i * 3 + 2]];
    return { h: boxMinHeight(center[0], center[1], center[2], col(0), col(1), col(2)), exact: true };
  }
  // sphere: [x,y,z,r] または {center, radius}。水平半径が支配する緩い球なので
  // h-r は下振れし得る下限推定。500m 超の荒い球は包絡が緩すぎるため中心高のみを
  // 採用し、タイトな末端タイルの球ほど実地形に近い値になるのを利用する
  const sph = Array.isArray(bv.sphere) ? bv.sphere
    : (typeof bv.radius === "number" && center ? [center[0], center[1], center[2], bv.radius] : null);
  if (sph) {
    const h = ecefToGeodetic(sph[0], sph[1], sph[2]).h;
    return { h: sph[3] <= 500 ? h - sph[3] : h, exact: false };
  }
  return null;
}

// タイルセット全体の接地高さ（最下端の測地高）を推定する。
// ルートから children を再帰走査して全タイルヘッダの boundingVolume を見る
// （loaders.gl は region を OrientedBoundingBox に変換済みで .region は残らない）。
// box/region 由来の確定値を優先、無ければ sphere の推定値、それも無ければ
// cartographicCenter の高さにフォールバックする
function tilesetMinGroundHeight(tileset) {
  let exactMin = Infinity, looseMin = Infinity;
  const add = bv => {
    const r = bvMinHeight(bv);
    if (!r || !Number.isFinite(r.h)) return;
    if (r.exact) { if (r.h < exactMin) exactMin = r.h; }
    else if (r.h < looseMin) looseMin = r.h;
  };
  add(tileset.boundingVolume);
  // 子タイルほど bounds がタイトなので最小値が実地形に近づく（sphere の緩さを実質緩和）。
  // 外部 tileset.json 参照は未ロードだが、参照を持つ親タイルの bounds がその分をカバーする
  let count = 0;
  const walk = header => {
    if (!header || count++ > 20000) return;
    add(header.boundingVolume);
    const ch = header.children;
    if (Array.isArray(ch)) for (const c of ch) walk(c);
  };
  walk(tileset.root);
  if (exactMin !== Infinity) return exactMin;
  // sphere 由来の推定は緩く、負値（=コンテンツが楕円体より下）を信用すると
  // タイルセットを不当に持ち上げ得るため 0 以上にクランプ（下げる方向のみ許可）
  if (looseMin !== Infinity) return Math.max(looseMin, 0);
  const c = tileset.cartographicCenter;
  return Array.isArray(c) && Number.isFinite(c[2]) ? c[2] : null;
}

// タイルセットを接地させる。onTilesetLoad で呼ぶほか、MapLibre テレインの
// ON/OFF・DEM 読込に合わせて groundLevel を変えて再呼出しできる
// （_kascOrigMatrix に初回の元行列を保持し、毎回そこから再計算する）
// opts: .kasc 行の opts（ground=off で無効化、zoffset=<m> で手動補正）
// groundLevel: 接地先の高さ[m]（MapLibre テレインの queryTerrainElevation =
//   DEM 標高×誇張を渡す。既定 0 = z=0 平面へ接地）
// 戻り値: 適用した高さシフト[m]（未適用なら null）
export function groundDeckTileset(tileset, opts = {}, groundLevel = 0) {
  try {
    if (!tileset) return null;
    const m = tileset.modelMatrix;
    if (!m || typeof m.multiplyLeft !== "function") return null;
    if (!tileset._kascOrigMatrix) tileset._kascOrigMatrix = m.clone();
    const orig = tileset._kascOrigMatrix;
    const auto = !/^(off|false|0|no)$/i.test(String(opts.ground ?? "on"));
    const zoffset = Number(opts.zoffset ?? 0) || 0;
    let shift = (Number.isFinite(groundLevel) ? groundLevel : 0) + zoffset;
    if (auto) {
      const minH = tilesetMinGroundHeight(tileset);
      if (Number.isFinite(minH)) shift -= minH;
    }
    tileset._kascGrounded = true;
    if (!Number.isFinite(shift) || Math.abs(shift) < 0.5) {
      tileset.modelMatrix = orig;
      return null;
    }
    const c = tileset.cartographicCenter;
    if (!Array.isArray(c)) return null;
    // ローカル Up = 測地法線方向（ECEF の楕円体法線）
    const lon = c[0] * Math.PI / 180, lat = c[1] * Math.PI / 180;
    const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const t = new orig.constructor().identity().translate([up[0] * shift, up[1] * shift, up[2] * shift]);
    tileset.modelMatrix = t.multiplyRight(orig);
    return shift;
  } catch (_) {
    return null;
  }
}
