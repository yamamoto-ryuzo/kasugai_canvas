// 座標ピンの共有ストア。
// ピンをエンジン固有の Entity/Marker ではなく GeoJSON FeatureCollection として保持し、
// 各エンジンは setRenderer() で「GeoJSON → 自前レイヤー」への同期関数を登録する。
// これによりピンは一般ベクターレイヤーと同じ扱い(レイヤ一覧・属性表示・属性検索・
// getLayerGeoJson 等の既存機能がそのまま使える)になる。
// sessionStorage に保持するため、エンジン切替やページリロードをまたいでも残る
const STORE_KEY = "kasugai_coord_pins";

function loadCollection() {
  try {
    const data = JSON.parse(sessionStorage.getItem(STORE_KEY));
    if (data?.type === "FeatureCollection" && Array.isArray(data.features)) return data;
  } catch (_) {}
  return { type: "FeatureCollection", features: [] };
}

const collection = loadCollection();
let renderer = null;
let seq = Number(collection.kasugaiPinSeq) || collection.features.length;

const persist = () => {
  collection.kasugaiPinSeq = seq;
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(collection)); } catch (_) {}
};

const notify = () => {
  persist();
  if (!renderer) return;
  try { renderer(collection); } catch (e) { console.error("[coord-pins] renderer failed:", e); }
};

export const coordPins = {
  // ピンを1件追加する。address は逆ジオコーディング地名(未取得は "")
  // simplestyle の marker-color は各エンジンの既定ピン色として利用される
  add({ lat, lng, address = "" } = {}) {
    const la = Number(lat), lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    const feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lo, la] },
      properties: {
        name: `座標ピン ${++seq}`,
        "marker-color": "#e33d3d",
        緯度: la.toFixed(6),
        経度: lo.toFixed(6),
        地名: address || "",
        作成時刻: new Date().toLocaleString(),
      },
    };
    collection.features.push(feature);
    notify();
    return feature;
  },
  clear() {
    if (!collection.features.length) return;
    collection.features.length = 0;
    notify();
  },
  // 正本コレクション(読み取り・item._geojson 参照用)。直接変更しない
  get collection() { return collection; },
  hasRenderer() { return !!renderer; },
  // エンジンが GeoJSON→レイヤー同期関数を登録する(1エンジン=1レンダラ)
  setRenderer(fn) {
    renderer = typeof fn === "function" ? fn : null;
    if (renderer) notify();
  },
  // プロジェクト再描画で管理レイヤーが剥がれた後にエンジン側から呼ぶ再同期
  refresh() { notify(); },
};
