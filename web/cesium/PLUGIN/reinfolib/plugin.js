// 不動産情報ライブラリ API（国土交通省）→ 表示範囲連動レイヤー
//
// /api/reinfolib 中継（local: server/src/main.rs / workers: functions/api/reinfolib.js）
// 経由で XYZ タイル形式の GeoJSON を取得し、表示範囲をカバーするタイルを
// まとめて FeatureCollection にして setPluginLayerData で本体の geojson
// レイヤー経路（ベクター検索・属性パネル・表示切替・描画件数バジェット）に流す。
//
// APIキーは中継側が注入する（local: 環境変数 REINFOLIB_API_KEY、
// workers: secret REINFOLIB_API_KEY）。BYO は localStorage.reinfolibApiKey に
// キーを置くと Ocp-Apim-Subscription-Key ヘッダで同梱する。
// plugins.json の options で取得対象・期間・タイル条件を変えられる:
//   "options": { "zoom": 11, "maxTiles": 16, "from": "20254", "to": "20254",
//                "datasets": { "price": true, "shelter": true, "station": true, "zoning": false } }
// .kasc の plugin: 行からは datasets=price,shelter のような配列指定も受け付ける。
// from/to は YYYYN 形式（YYYY=西暦, N=四半期 1-4。XPT001 の必須パラメータ）

const UPSTREAM_BASE = "https://www.reinfolib.mlit.go.jp/ex-api/external";
const ATTRIBUTION = "不動産情報ライブラリ（国土交通省）";
const LAYER_GROUP = "不動産情報";
const FETCH_GAP_MS = 250; // 公式案内の「連続実行しない」に合わせてタイル取得を空ける

// 対象API。params は options を受けてクエリ片（urlencode前）を返す
// style: レイヤー描画用の QGIS スタイル(.qml)。registerPluginLayer の style
// オプション経由で本体の geojson 描画に適用される(styleUrl)。
const DATASETS = {
  price: {
    api: "XPT001",
    title: opts => `取引価格ポイント(${opts.from.slice(0, 4)}Q${opts.from.slice(4)})`,
    params: opts => `from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`,
    style: "./PLUGIN/reinfolib/qml/price.qml",
  },
  shelter: { api: "XGT001", title: () => "指定緊急避難場所", params: () => "", style: "./PLUGIN/reinfolib/qml/shelter.qml" },
  station: { api: "XKT015", title: () => "駅別乗降客数", params: () => "", style: "./PLUGIN/reinfolib/qml/station.qml" },
  zoning: { api: "XKT002", title: () => "用途地域", params: () => "", style: "./PLUGIN/reinfolib/qml/zoning.qml" },
};

const DEFAULT_OPTIONS = {
  zoom: 11,        // API のタイル z（11-15。11=市レベル。取得数を抑えるため既定11）
  maxTiles: 16,    // 1データセット1回の取得で許容するタイル数（超えたら案内して取得しない）
  from: "20254",   // XPT001 の対象期間（from/to）。最新は API のお知らせで確認して更新
  to: "20254",
  datasets: { price: true, shelter: true, station: true, zoning: false },
};

const state = {
  api: null,
  layers: new Map(),   // datasetKey -> layerItemId
  cache: new Map(),    // "api|z|x|y" -> features[]
  running: false,
  queued: false,
  timer: null,
  errors: new Set(),   // datasetKey（エラー中）
  opts: DEFAULT_OPTIONS,
};

function statusEl() {
  let el = document.getElementById("reinfolib-status");
  if (!el) {
    el = document.createElement("div");
    el.id = "reinfolib-status";
    el.style.cssText =
      "position:fixed;left:10px;bottom:56px;z-index:9000;max-width:420px;" +
      "background:rgba(20,32,44,0.85);color:#fff;font-size:12px;line-height:1.4;" +
      "padding:6px 10px;border-radius:6px;pointer-events:none;display:none;";
    document.body.appendChild(el);
  }
  return el;
}

let hideTimer = null;
function showStatus(text, { sticky = false } = {}) {
  const el = statusEl();
  el.textContent = text;
  el.style.display = text ? "block" : "none";
  clearTimeout(hideTimer);
  if (text && !sticky) hideTimer = setTimeout(() => { el.style.display = "none"; }, 5000);
}

function byoKey() {
  try { return localStorage.getItem("reinfolibApiKey") || ""; } catch { return ""; }
}

function relayUrl(upstreamUrl) {
  return `/api/reinfolib?url=${encodeURIComponent(upstreamUrl)}`;
}

// エラーを利用者向けの案内文に分類する
function describeFailure(status) {
  if (status === 401 || status === 403) {
    return "APIキーが無効か未承認です。REINFOLIB_API_KEY（または localStorage.reinfolibApiKey）を確認してください";
  }
  if (status === 503) {
    return "APIキーが未設定です。サーバーに REINFOLIB_API_KEY を設定するか、localStorage.reinfolibApiKey にキーを保存してください";
  }
  if (status === 429) return "レート制限に達しました。しばらく待ってから移動し直してください";
  if (status === 404) return "不動産情報ライブラリの中継（/api/reinfolib）がありません。local または workers 環境で起動してください";
  return `取得に失敗しました（HTTP ${status}）`;
}

async function fetchTile(dataset, z, x, y) {
  const key = `${dataset.api}|${z}|${x}|${y}`;
  if (state.cache.has(key)) return state.cache.get(key);
  const params = dataset.params(state.opts);
  const upstream = `${UPSTREAM_BASE}/${dataset.api}?response_format=geojson&z=${z}&x=${x}&y=${y}${params ? `&${params}` : ""}`;
  const headers = {};
  const key2 = byoKey();
  if (key2) headers["Ocp-Apim-Subscription-Key"] = key2;
  const resp = await fetch(relayUrl(upstream), { headers });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const geojson = await resp.json();
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  state.cache.set(key, features);
  return features;
}

// 表示範囲（lon/lat度）をカバーする XYZ タイル列挙。広すぎる場合は null
function tilesInView(Cesium, z) {
  const viewer = state.api.getViewer();
  const rect = viewer.camera.computeViewRectangle(Cesium.Ellipsoid.WGS84, new Cesium.Rectangle());
  if (!rect) return null;
  const west = Math.max(-180, Cesium.Math.toDegrees(rect.west));
  const east = Math.min(180, Cesium.Math.toDegrees(rect.east));
  const south = Math.max(-85, Cesium.Math.toDegrees(rect.south));
  const north = Math.min(85, Cesium.Math.toDegrees(rect.north));
  if (!(west < east && south < north)) return null;
  const n = 2 ** z;
  const lonToX = lon => Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n)));
  const latToY = lat => {
    const r = Cesium.Math.toRadians(Math.min(85, Math.max(-85, lat)));
    return Math.min(n - 1, Math.max(0, Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)));
  };
  const tiles = [];
  for (let x = lonToX(west); x <= lonToX(east); x++) {
    for (let y = latToY(north); y <= latToY(south); y++) tiles.push({ x, y });
  }
  return tiles;
}

function dedupKey(feature) {
  const p = feature?.properties || {};
  if (p._id != null) return `id:${p._id}`;
  return `${JSON.stringify(feature.geometry)}|${p.common_id || p.district_code || p.S12_001c || ""}`;
}

async function refresh() {
  if (state.running) { state.queued = true; return; }
  state.running = true;
  try {
    const Cesium = state.api.getCesium();
    const z = state.opts.zoom;
    const tiles = tilesInView(Cesium, z);
    if (!tiles) { showStatus("地図範囲を取得できません"); return; }
    if (tiles.length > state.opts.maxTiles) {
      showStatus(`表示範囲が広すぎます（${tiles.length}タイル必要）。市町村レベルまで拡大してください`, { sticky: true });
      return;
    }
    const enabled = Object.entries(DATASETS).filter(([k]) => state.opts.datasets[k] && state.layers.has(k));
    const failed = new Map();
    for (const [key, dataset] of enabled) {
      const features = [];
      const seen = new Set();
      let hadError = null;
      for (const t of tiles) {
        try {
          for (const f of await fetchTile(dataset, z, t.x, t.y)) {
            const dk = dedupKey(f);
            if (seen.has(dk)) continue;
            seen.add(dk);
            features.push(f);
          }
        } catch (e) {
          hadError = e;
          break; // 認証/中継エラーは全タイル共通。残りタイルは叩かない
        }
        await new Promise(r => setTimeout(r, FETCH_GAP_MS));
      }
      if (hadError) {
        failed.set(key, hadError);
        continue; // 前回表示を残す（中途半端な空描画にしない）
      }
      await state.api.setPluginLayerData(state.layers.get(key), { type: "FeatureCollection", features });
    }
    if (failed.size) {
      const first = [...failed.values()][0];
      const names = [...failed.keys()].map(k => DATASETS[k].title(state.opts)).join("、");
      showStatus(`${names}: ${describeFailure(first.status ?? 0)}`, { sticky: true });
    } else {
      const total = enabled.length ? "取得しました" : "";
      showStatus(total ? `不動産情報ライブラリ: ${tiles.length}タイル ${total}` : "");
      state.errors.clear();
    }
  } catch (e) {
    console.warn("[reinfolib] refresh failed", e);
    showStatus(`不動産情報ライブラリ: ${describeFailure(e.status ?? 0)}`, { sticky: true });
  } finally {
    state.running = false;
    if (state.queued) { state.queued = false; void refresh(); }
  }
}

export async function init(api, manifest) {
  state.api = api;
  state.opts = { ...DEFAULT_OPTIONS, ...(manifest.options || {}) };
  const datasetsOpt = manifest.options?.datasets;
  // datasets は {price:true,...} のオブジェクトのほか、plugin: 行からの
  // ["price","shelter"] 配列指定も受け付ける（カンマ区切り→配列に変換済みで来る）
  state.opts.datasets = Array.isArray(datasetsOpt)
    ? Object.fromEntries(Object.keys(DATASETS).map(key => [key, datasetsOpt.includes(key)]))
    : { ...DEFAULT_OPTIONS.datasets, ...(datasetsOpt || {}) };
  const Cesium = api.getCesium();
  if (!Cesium || !api.getViewer?.()) {
    console.warn("[reinfolib] Cesium/viewer が見つかりません");
    return;
  }

  // レイヤー登録（本体の geojson 描画経路に載る format:"geojson"）
  for (const [key, dataset] of Object.entries(DATASETS)) {
    if (!state.opts.datasets[key]) continue;
    try {
      const item = await api.registerPluginLayer({
        title: dataset.title(state.opts),
        group: LAYER_GROUP,
        format: "geojson",
        visible: true,
        scope: "app",
        attribution: ATTRIBUTION,
        style: dataset.style,
      }, manifest.id);
      if (item?.id) state.layers.set(key, item.id);
    } catch (e) {
      console.warn(`[reinfolib] レイヤー登録失敗: ${key}`, e);
    }
  }
  if (!state.layers.size) {
    showStatus("不動産情報ライブラリ: レイヤーを登録できませんでした", { sticky: true });
    return;
  }

  const onCameraChanged = () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void refresh(), 500);
  };

  api.registerPlugin({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    refresh,
    // inspector(plugin:行)起動時は宣言解除・プロジェクト切替で呼ばれ、
    // イベント購読とタイマーを解放して停止する
    dispose() {
      clearTimeout(state.timer);
      api.off("camera-changed", onCameraChanged);
      state.layers.clear();
      document.getElementById("reinfolib-status")?.remove();
    },
  });

  api.on("camera-changed", onCameraChanged);
  showStatus("不動産情報ライブラリ: データ取得中…", { sticky: true });
  await refresh();
}
