// KASUGAI Canvas — 2D プレイヤー用 kasugaiApi アダプタ
// maplibre / openlayers / leaflet の各フロントが共通構造（layerEntries +
// エンジン別の描画フック）を持つため、エンジン差分は hooks として注入し、
// kasugaiApi 互換の API 面をここで構成する。AI チャット（shared/ai-chat.js）の
// ツールはこの api メソッドの有無で公開可否が決まる。
import { camToZoom, zoomToCamHeight, geojsonExtent, splitKascTitle } from "./kasc.js";
import { hasBackendFeature, isFetchProxyTarget, executeChatTool, showReportModal, listUiControls, controlUi } from "./ai-chat.js";
import { getLanguage, t } from "./i18n.js";

// hooks:
//   engine            : "maplibre" | "openlayers" | "leaflet"
//   getEntries()      : () => 現在のレイヤーエントリ配列 {item, ...}
//   getBaseEntries()  : () => ベースマップエントリ配列 {item, lids|layer}
//   getProjectId()    : () => 現在のプロジェクト ID
//   getBaseUrl()      : () => 相対参照解決の baseUrl
//   loadProject(id)   : プロジェクト切替
//   applyInspectorText(text) : インスペクタ適用
//   getInspectorText(): () => インスペクタの .kasc テキスト
//   applyEntryVisibility(entry) / focusEntry(entry) / maybeLoadEntry(entry)
//   applyLegendFilter(entry)  : 凡例シンボル絞り込みの反映
//   rerenderLayers()          : レイヤー行の再描画
//   getThemes() / applyThemeByName(name)
//   flyToView(view)   : {latitude,longitude,zoom,height,heading,pitch} → 地図移動
//   getViewInfo()     : () => {latitude,longitude,zoom,heading,pitchDeg}
//   fitBoundsView(w,s,e,n)
//   mountEntry(entry, preloaded) : 新規エントリを地図へ追加（item._preloaded に GeoJSON 可）
//   unmountEntry(entry)          : 地図から除去
//   reloadEntryData(entry)       : item.opts.where 反映後の再読み込み（setLayerFilter 用）
//   getEntryGeoJson(entry)       : () => GeoJSON（未対応なら省略可）
//   setBaseEntryVisible(entry, on) : ベースマップ1枚の表示切替
//   getCams()                   : () => cam: プリセット配列
//   getFlyPaths()               : () => fly_geojson: 由来のルート設定配列
//                                 [{title,url(解決済み),speed(m/s),height,pitch,loop,view,_item}]（省略可）
//   persistFlyPath(title, geojson, path) : addFlyPath/flyRoute の永続化（省略可）
//   syncFlyPathLine(item)       : setFlySettings 変更をインスペクタ行へ書き戻す（省略可）
//   getViewInfo() が返す zoom は fly の既定ズームにも使う

// Google Maps 系 API キー（BYO・localStorage）
function getMapsWsKey() {
  try {
    return localStorage.getItem("googleMapsWsApiKey") || localStorage.getItem("googleMapsApiKey") || "";
  } catch { return ""; }
}

// Google Geocoding API。{title,address,latitude,longitude}[] を返す
async function googleGeocodeSearch(query, key) {
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}&language=${encodeURIComponent(getLanguage())}`, { mode: "cors", signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error_message || t("search.failedStatus", { status: response.status }));
  if (data?.status !== "OK" && data?.status !== "ZERO_RESULTS") {
    throw new Error(data?.error_message || data?.status || t("search.failed"));
  }
  return (data?.results || []).map(item => ({
    title: item.formatted_address || "",
    address: item.formatted_address || "",
    latitude: Number(item.geometry?.location?.lat),
    longitude: Number(item.geometry?.location?.lng),
  }));
}

// Google Places API (New) テキスト検索。{title,address,latitude,longitude}[] を返す
async function googlePlacesSearch(query, key) {
  if (!key) throw new Error(t("google.needKey"));
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify({ textQuery: String(query || ""), languageCode: getLanguage(), pageSize: 10 }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || t("search.failedStatus", { status: response.status }));
  return (data?.places || []).map(place => ({
    title: place.displayName?.text || "",
    address: place.formattedAddress || "",
    latitude: Number(place.location?.latitude),
    longitude: Number(place.location?.longitude),
  }));
}

// 地名検索プロバイダ。いずれも {title,address,latitude,longitude}[] を返す。
// 既定は gsi（地理院・キー不要）。google/places は Maps API キー必須
const searchProviders = {
  async gsi(query) {
    const response = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`, { mode: "cors", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(await response.text() || t("search.failedStatus", { status: response.status }));
    const data = await response.json().catch(() => []);
    return (Array.isArray(data) ? data : []).map(item => ({
      title: item.properties?.title || item.properties?.name || item.properties?.Name || "",
      address: item.properties?.address || item.properties?.Address || item.properties?.title || "",
      latitude: Number(item.geometry?.coordinates?.[1]),
      longitude: Number(item.geometry?.coordinates?.[0]),
    }));
  },
  // ハイブリッド検索: Geocoding（住所向け）と Places（施設向け）を並列で呼んでマージ
  async google(query) {
    const key = getMapsWsKey();
    if (!key) throw new Error(t("google.needKey"));
    const [geocode, places] = await Promise.allSettled([
      googleGeocodeSearch(query, key),
      googlePlacesSearch(query, key),
    ]);
    const items = [];
    if (geocode.status === "fulfilled") items.push(...geocode.value);
    if (places.status === "fulfilled") items.push(...places.value);
    if (!items.length) {
      if (geocode.status === "rejected") throw geocode.reason;
      if (places.status === "rejected") throw places.reason;
    }
    const seen = new Set();
    return items.filter(item => {
      if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return false;
      const k = `${Math.round(item.latitude * 1e4)},${Math.round(item.longitude * 1e4)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  async places(query) {
    return googlePlacesSearch(query, getMapsWsKey());
  },
  // OSM Nominatim（キー不要・CORS対応）
  async osm(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ja&q=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const list = await res.json().catch(() => []);
      return (Array.isArray(list) ? list : []).map(r => ({
        title: String(r.display_name || "").split(",")[0],
        address: r.display_name || "",
        latitude: Number(r.lat),
        longitude: Number(r.lon),
      })).filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
    } catch { return []; }
  },
};
searchProviders.nominatim = searchProviders.osm;

// セマンティックバージョンの緩い比較（cesium 版と同じ運用: 数値列の前順比較）
function compareVersions(a, b) {
  const pa = String(a || "").split(/[.-]/).map(Number);
  const pb = String(b || "").split(/[.-]/).map(Number);
  for (let i = 0, n = Math.max(pa.length, pb.length); i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// ---- フライパス共通部品 ----
const FLY_DEG = Math.PI / 180;
const flySleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 2点間の地表距離(m)
function flyLegDist(a, b) {
  const R = 6371000;
  const dLat = (b[1] - a[1]) * FLY_DEG, dLng = (b[0] - a[0]) * FLY_DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * FLY_DEG) * Math.cos(b[1] * FLY_DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
// 2点間の方位角(度・北=0)
function flyBearing(a, b) {
  const y = Math.sin((b[0] - a[0]) * FLY_DEG) * Math.cos(b[1] * FLY_DEG);
  const x = Math.cos(a[1] * FLY_DEG) * Math.sin(b[1] * FLY_DEG)
    - Math.sin(a[1] * FLY_DEG) * Math.cos(b[1] * FLY_DEG) * Math.cos((b[0] - a[0]) * FLY_DEG);
  return (Math.atan2(y, x) / FLY_DEG + 360) % 360;
}
// GeoJSON → ルート座標列 [[lng,lat,(alt)]...]（LineString/MultiLineString/Point 列を順に平坦化）
function flyCoordsFromGeoJson(gj) {
  const lines = [];
  const push = g => {
    if (!g) return;
    if (g.type === "LineString") lines.push(g.coordinates);
    else if (g.type === "MultiLineString") lines.push(...(g.coordinates || []));
    else if (g.type === "Point") lines.push([g.coordinates]);
    else if (g.type === "MultiPoint") lines.push(g.coordinates || []);
    else if (g.type === "GeometryCollection") (g.geometries || []).forEach(push);
  };
  const feats = gj?.type === "FeatureCollection" ? (gj.features || [])
    : (gj?.type === "Feature" ? [gj] : []);
  if (feats.length) feats.forEach(f => push(f?.geometry));
  else push(gj);
  return lines.flat().filter(c => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1]));
}
// 距離d(m)地点の座標・方位・補間高度を返す
function flyPointAtDistance(pts, d) {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const leg = flyLegDist(a, b);
    if (d <= acc + leg || i + 2 === pts.length) {
      const r = leg > 0 ? Math.min(1, Math.max(0, (d - acc) / leg)) : 0;
      const za = Number(a[2]), zb = Number(b[2]);
      return {
        pos: [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r],
        heading: flyBearing(a, b),
        alt: Number.isFinite(za) && Number.isFinite(zb) ? za + (zb - za) * r : undefined,
      };
    }
    acc += leg;
  }
  const last = pts[pts.length - 1];
  return { pos: [last[0], last[1]], heading: flyBearing(pts[pts.length - 2] || last, last), alt: Number(last[2]) || undefined };
}
// 総距離から適当な走行速度(km/h)を決める（短距離=低速、長距離=高速）
function flyAutoSpeedKmh(totalDistance) {
  return totalDistance < 5e3 ? 60 : totalDistance < 5e4 ? 300 : 900;
}

export function createPlayerApi(hooks) {
  const listeners = new Map();

  const findEntry = name => {
    const key = String(name ?? "").trim();
    if (!key) return null;
    return hooks.getEntries().find(e =>
      e.item.title === key || splitKascTitle(e.item.title).title === key ||
      e.item.url === key || e.item.id === key || e.sid === key) || null;
  };

  // ベースマップ: .kasc の base: 行一覧 + 「なし」疑似項目
  let baseHidden = false;
  const setBaseAllVisible = on => {
    for (const e of hooks.getBaseEntries()) hooks.setBaseEntryVisible(e, on);
  };

  // ---- フライパス ----
  let flyToken = 0;                 // 再生世代(stopFly/別ルート再生で中断)
  let lastFlyPath = null;           // setFlySettings の name省略時対象
  const memoryFlyPaths = [];        // addFlyPath/flyRoute で登録したルート
  // .kasc 由来(hook) + 登録済み(memory)。タイトル重複は先勝ち
  const flyAll = () => {
    const list = [...(hooks.getFlyPaths?.() || []), ...memoryFlyPaths];
    const seen = new Set();
    return list.filter(p => p && p.title && !seen.has(p.title) && seen.add(p.title));
  };
  const flyFind = nameOrIndex => {
    const list = flyAll();
    if (Number.isInteger(nameOrIndex)) return list[nameOrIndex] || null;
    const key = String(nameOrIndex ?? "");
    return list.find(p => p.title === key || String(p.title).includes(key)) || null;
  };
  // 座標列の解決: インライン coords 優先、url 指定は fetch → GeoJSON 抽出(結果はキャッシュ)
  const resolveFlyCoords = async path => {
    if (Array.isArray(path.coords) && path.coords.length >= 2) return path.coords;
    const holder = path._item || path;
    if (holder._flyCoords) return holder._flyCoords;
    if (!path.url) return null;
    const res = await fetch(path.url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`fly path fetch failed: HTTP ${res.status}`);
    const gj = await res.json();
    const coords = flyCoordsFromGeoJson(gj);
    if (coords.length >= 2) holder._flyCoords = coords;
    return coords.length >= 2 ? coords : null;
  };
  // 再生: 総距離を speed(m/s) で進み、100ms 毎に flyToView へ位置・方位・高度を流す。
  // autoplay=false はルート先頭への移動のみ
  const flyPlay = async (path, autoplay = true) => {
    const coords = await resolveFlyCoords(path).catch(() => null);
    if (!coords || coords.length < 2) return false;
    const token = ++flyToken;
    lastFlyPath = path;
    const view = hooks.getViewInfo?.() || {};
    const height = Number.isFinite(+path.height) ? +path.height : undefined;
    const zoom = Number.isFinite(+path.zoom) ? +path.zoom
      : (Number.isFinite(height) ? camToZoom({ latitude: coords[0][1], height }) : view.zoom);
    const pitch = Number.isFinite(+path.pitch) ? +path.pitch : -10;
    const moveTo = at => hooks.flyToView({
      latitude: at.pos[1], longitude: at.pos[0], zoom,
      height: Number.isFinite(at.alt) ? at.alt + (height || 0) : height,
      heading: at.heading, pitch, instant: true,
    });
    moveTo({ pos: coords[0], heading: flyBearing(coords[0], coords[1]), alt: Number(coords[0][2]) || undefined });
    if (!autoplay) return true;
    const speed = Number(path.speed) > 0 ? Number(path.speed) : 30; // m/s
    const total = coords.slice(1).reduce((s, p, i) => s + flyLegDist(coords[i], p), 0);
    if (!(total > 0)) return false;
    do {
      let travelled = 0;
      let last = performance.now();
      while (token === flyToken && travelled < total) {
        await flySleep(100);
        const now = performance.now();
        travelled += speed * (now - last) / 1000;
        last = now;
        moveTo(flyPointAtDistance(coords, Math.min(travelled, total)));
      }
    } while (token === flyToken && path.loop);
    return token === flyToken;
  };

  const api = {
    isReady: true,
    engine: hooks.engine,

    getProjectId: hooks.getProjectId,

    flyTo(view = {}) {
      hooks.flyToView(view);
      return true;
    },
    async flyToFeature(lat, lng, opts = {}) {
      hooks.flyToView({ latitude: lat, longitude: lng, ...opts });
      return true;
    },
    getCamera() {
      const v = hooks.getViewInfo();
      if (!v) return null;
      return {
        latitude: v.latitude,
        longitude: v.longitude,
        zoom: v.zoom,
        height: zoomToCamHeight(v.latitude, v.zoom),
        heading: v.heading ?? 0,
        pitch: (v.pitchDeg ?? 0) - 90,
      };
    },
    // Cesium 版の drone 既定（対象地上+200m）相当: 2D では zoom≈17 になる高さを返す
    async sampleGroundHeight() { return 0; },

    listLayers() {
      return hooks.getEntries().map(e => {
        const item = e.item;
        const entry = {
          id: item.id ?? e.sid ?? item.title,
          title: item.title || item.url,
          group: splitKascTitle(item.title).group || "",
          visible: item.visible !== false,
          type: item.type,
          filter: item.opts?.where || "",
        };
        const legend = item._qml?.legend;
        if (legend?.length > 1) {
          entry.legend = legend.map(le => ({ label: le.label || le.symbolName, visible: !item._legendHidden?.has(le.symbolName) }));
        }
        return entry;
      });
    },
    setLayerVisible(name, visible) {
      const e = findEntry(name);
      if (!e) return false;
      const on = !!visible;
      // 排他グループ（ラジオ）の場合は他メンバーを OFF にする
      if (on && e.cb?.type === "radio" && e._siblings) {
        for (const sib of e._siblings) {
          if (sib === e) continue;
          sib.item.visible = false;
          if (sib.cb) sib.cb.checked = false;
          hooks.applyEntryVisibility(sib);
        }
      }
      e.item.visible = on;
      if (e.cb) e.cb.checked = on;
      hooks.applyEntryVisibility(e);
      hooks.maybeLoadEntry(e);
      e._groupCtl?.sync?.();
      return true;
    },
    setLayerLegendVisible(name, label, visible) {
      const e = findEntry(name);
      const legend = e?.item._qml?.legend;
      if (!e || !legend?.length) return false;
      const key = String(label ?? "").trim();
      const le = legend.find(x => x.label === key || x.symbolName === key);
      if (!le?.symbolName) return false;
      e.item._legendHidden ||= new Set();
      if (visible) e.item._legendHidden.delete(le.symbolName);
      else e.item._legendHidden.add(le.symbolName);
      if (!e.item._legendHidden.size) e.item._legendHidden = null;
      hooks.applyLegendFilter(e);
      return true;
    },
    async focusLayer(name) {
      const e = findEntry(name);
      if (!e) return false;
      hooks.focusEntry(e);
      return true;
    },
    async setLayerFilter(name, filter) {
      const e = findEntry(name);
      if (!e) return { ok: false, reason: "notFound" };
      if (!hooks.reloadEntryData) return { ok: false, reason: "unsupported" };
      const t = e.item.type;
      if (!new Set(["gpkg", "geopackage", "duckdb", "flatgeobuf", "fgb", "geoparquet", "parquet"]).has(t)) {
        return { ok: false, reason: "unsupported" };
      }
      e.item.opts ||= {};
      e.item.opts.where = String(filter ?? "").trim() || undefined;
      try {
        await hooks.reloadEntryData(e);
        return { ok: true };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },

    listBasemaps() {
      const sel = document.querySelector("#basemap-select");
      const active = Number(sel?.value ?? 0);
      return [
        { id: "none", title: "ベースマップなし", selected: baseHidden },
        ...hooks.getBaseEntries().map((e, i) => ({ id: String(i), title: e.item.title || `base ${i}`, selected: !baseHidden && i === active })),
      ];
    },
    setBasemap(name) {
      const key = String(name ?? "").trim();
      const sel = document.querySelector("#basemap-select");
      if (/^(none|なし|ベースマップなし)$/i.test(key)) {
        baseHidden = true;
        setBaseAllVisible(false);
        return true;
      }
      const idx = hooks.getBaseEntries().findIndex(e => e.item.title === key || splitKascTitle(e.item.title).title === key);
      if (idx < 0) return false;
      baseHidden = false;
      if (sel) { sel.value = String(idx); sel.dispatchEvent(new Event("change")); }
      else setBaseAllVisible(true);
      return true;
    },

    listThemes() {
      return (hooks.getThemes?.() || []).map(th => ({ name: th.name, layers: [...(th.layers || [])] }));
    },
    applyTheme(name) {
      if (!hooks.applyThemeByName) return false;
      return hooks.applyThemeByName(name);
    },

    listCameraPresets() {
      return (hooks.getCams?.() || []).map(c => ({ name: c.name || `${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`, latitude: c.latitude, longitude: c.longitude }));
    },
    flyToPreset(name) {
      const cam = (hooks.getCams?.() || []).find(c => (c.name || "") === String(name ?? ""));
      if (!cam) return false;
      hooks.flyToView({ latitude: cam.latitude, longitude: cam.longitude, height: cam.height, zoom: cam.zoom });
      return true;
    },

    // 地名検索: provider は gsi(既定)/google/places/osm(nominatim)
    async searchLocation(query, provider) {
      const q = String(query || "").trim();
      if (!q) return [];
      const fn = searchProviders[String(provider || "gsi").toLowerCase()] || searchProviders.gsi;
      const items = await fn(q);
      return items.slice(0, 5);
    },
    // Google Places API (New) テキスト検索。Maps API キー必須
    async searchPlaces(query) {
      return googlePlacesSearch(query, getMapsWsKey());
    },
    // Google ストリートビューを別タブで開く。存在確認は metadata(無料)で行う
    async openStreetView(latitude, longitude) {
      const key = getMapsWsKey();
      if (!key) throw new Error(t("google.needKey"));
      const lat = Number(latitude);
      const lng = Number(longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(t("error.invalidUrl"));
      const fetchMeta = async source => {
        const response = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${encodeURIComponent(key)}${source ? `&source=${source}` : ""}`, { mode: "cors", signal: AbortSignal.timeout(15000) });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error_message || t("search.failedStatus", { status: response.status }));
        return data;
      };
      let data = await fetchMeta("outdoor");
      if (data?.status !== "OK") data = await fetchMeta("");
      if (data?.status !== "OK") return { ok: false, status: data?.status || "UNKNOWN" };
      const panoLat = Number(data.location?.lat);
      const panoLng = Number(data.location?.lng);
      const viewpoint = `${Number.isFinite(panoLat) ? panoLat : lat},${Number.isFinite(panoLng) ? panoLng : lng}`;
      const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${viewpoint}${data.pano_id ? `&panoid=${encodeURIComponent(data.pano_id)}` : ""}`;
      window.open(url, "_blank", "noopener");
      return { ok: true, url };
    },
    // 読込済みベクターの全属性を対象にした前方一致検索（検索タブと同じ対象）
    vectorSearch(query) {
      const needle = String(query || "").trim().toLowerCase();
      if (!needle) return [];
      const out = [];
      for (const e of hooks.getEntries()) {
        const feats = hooks.getEntryGeoJson ? (hooks.getEntryGeoJson(e)?.features || []) : (e.item._geojson?.features || []);
        for (const f of feats) {
          const hit = Object.entries(f.properties || {}).find(([k, v]) => String(v).toLowerCase().includes(needle));
          if (!hit) continue;
          const env = geojsonExtent({ features: [f] });
          out.push({
            layer: e.item.title, property: hit[0], value: hit[1],
            longitude: env ? (env.west + env.east) / 2 : undefined,
            latitude: env ? (env.south + env.north) / 2 : undefined,
          });
          if (out.length >= 20) return out;
        }
      }
      return out;
    },

    getShareUrl() { return window.location.href; },
    buildShareUrl({ latitude, longitude, height, zoom, pitch, heading, project } = {}) {
      const params = new URLSearchParams();
      params.set("engine", hooks.engine);
      params.set("project", project || hooks.getProjectId() || "default");
      const hash = new URLSearchParams();
      const c = hooks.getViewInfo() || {};
      const lat2 = Number.isFinite(latitude) ? latitude : c.latitude;
      const lng2 = Number.isFinite(longitude) ? longitude : c.longitude;
      if (Number.isFinite(lat2)) hash.set("latitude", lat2.toFixed(6));
      if (Number.isFinite(lng2)) hash.set("longitude", lng2.toFixed(6));
      const z = Number.isFinite(zoom) ? zoom : (Number.isFinite(height) ? camToZoom({ latitude: lat2, height }) : c.zoom);
      if (Number.isFinite(z)) hash.set("zoom", z.toFixed(3));
      return `${window.location.origin}${window.location.pathname}?${params}#${hash}`;
    },

    listProjects() {
      const sel = document.querySelector("#project-select");
      return [...(sel?.options || [])].map(o => ({ id: o.value, title: o.textContent, selected: o.value === sel.value }));
    },
    async switchProject(projectId) {
      const sel = document.querySelector("#project-select");
      const exists = [...(sel?.options || [])].some(o => o.value === projectId);
      if (!exists) return false;
      await hooks.loadProject(projectId);
      if (sel) sel.value = projectId;
      this.emit("project-changed", { projectId });
      return true;
    },

    async applyInspector(text) {
      await hooks.applyInspectorText(String(text ?? ""));
      return true;
    },
    exportInspector() {
      document.querySelector("#export-inspector")?.click();
      return true;
    },

    // GeoJSON を一時レイヤーとして追加（プレイヤーでは永続化しない）
    async addDataLayer(title, geojson) {
      if (!geojson || !Array.isArray(geojson.features)) return null;
      const item = { type: "geojson", title: String(title || "data"), visible: true, _geojson: geojson, _preloaded: { geojson } };
      item._env = geojsonExtent(geojson) || null;
      const entry = { item, pending: false };
      hooks.getEntries().push(entry);
      await hooks.mountEntry(entry, { geojson });
      hooks.rerenderLayers();
      return { id: item.title, title: item.title };
    },
    async removeDataLayer(name) {
      const e = findEntry(name);
      if (!e || !hooks.unmountEntry) return false;
      hooks.unmountEntry(e);
      const arr = hooks.getEntries();
      arr.splice(arr.indexOf(e), 1);
      hooks.rerenderLayers();
      return true;
    },
    // type:target|options の新規レイヤー行追加（インスペクタにも追記して永続化）
    async addLayer(title, target, { type = "geojson", options = "" } = {}) {
      const line = `${type}:${String(title || target)} | ${target}${options ? ` | ${options}` : ""}`;
      hooks.setInspectorText?.(`${(hooks.getInspectorText() || "").replace(/\s*$/, "")}\n${line}\n`);
      const opts = {};
      for (const part of String(options).split("|")) {
        const m = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(part);
        if (m) opts[m[1].toLowerCase()] = m[2];
      }
      const item = { type, title: String(title || target), url: target, opts, visible: true, _idx: 1e9 };
      const entry = { item, pending: true };
      hooks.getEntries().push(entry);
      try {
        await hooks.mountEntry(entry);
      } catch (e) {
        const arr = hooks.getEntries();
        arr.splice(arr.indexOf(entry), 1);
        hooks.rerenderLayers();
        throw e;
      }
      entry.pending = false;
      hooks.rerenderLayers();
      return true;
    },
    async addGeoJsonLayer(title, url) {
      return this.addLayer(title, url, { type: "geojson" }).then(() => true).catch(() => false);
    },
    getLayerGeoJson(name) {
      const e = findEntry(name);
      if (!e) return null;
      return hooks.getEntryGeoJson ? hooks.getEntryGeoJson(e) : (e.item._geojson || null);
    },

    // ---- フライパス（flyToView hook 経由のカメラ巡回）----
    // 2Dはパン/ズームの巡回、gsimaps Globe 等の3Dでは高度・方位・ピッチも
    // flyToView 側へそのまま渡る。地形追従サンプリングは行わない簡易版
    listFlyPaths() {
      return flyAll().map((p, index) => ({ index, title: p.title }));
    },
    playFlyPath(nameOrIndex, autoplay = true) {
      const path = flyFind(nameOrIndex);
      if (!path) return false;
      void flyPlay(path, autoplay).catch(e => console.warn("[fly]", e));
      return true;
    },
    stopFly() { flyToken++; return true; },
    // name省略時は再生中（最後に再生したもの）を対象にする
    async setFlySettings(nameOrIndex, settings = {}) {
      const path = (nameOrIndex == null || nameOrIndex === "") ? lastFlyPath : flyFind(nameOrIndex);
      if (!path) return { ok: false };
      const kmh = v => Number.isFinite(+v) && +v > 0 ? +v / 3.6 : undefined; // ツール値はkm/h
      if (kmh(settings.speed) !== undefined) path.speed = kmh(settings.speed);
      if (Number.isFinite(+settings.agl)) path.height = +settings.agl;
      else if (Number.isFinite(+settings.height)) path.height = (path.height || 0) + +settings.height;
      if (Number.isFinite(+settings.pitch)) path.pitch = Math.max(-85, Math.min(0, +settings.pitch));
      if (settings.loop !== undefined) path.loop = !!settings.loop;
      if (settings.view !== undefined) path.view = settings.view;
      // .kasc 由来は item.opts へ書き戻し、インスペクタ行も同期する
      const it = path._item;
      if (it) {
        it.opts ||= {};
        if (Number.isFinite(path.speed)) it.opts.speed = String(Math.round(path.speed * 10) / 10);
        if (Number.isFinite(path.height)) it.opts.height = String(path.height);
        if (Number.isFinite(path.pitch)) it.opts.pitch = String(path.pitch);
        it.opts.loop = path.loop ? "true" : "false";
        if (path.view) it.opts.view = path.view;
        try { hooks.syncFlyPathLine?.(it); } catch (_) {}
      }
      return { ok: true };
    },
    async addFlyPath(name, geojson, options = {}) {
      const title = String(name || "").trim();
      let parsed = null;
      try { parsed = typeof geojson === "string" ? JSON.parse(geojson) : geojson; } catch { parsed = null; }
      const coords = parsed ? flyCoordsFromGeoJson(parsed) : [];
      if (!title || coords.length < 2) return { ok: false };
      const total = coords.slice(1).reduce((s, p, i) => s + flyLegDist(coords[i], p), 0);
      const kmh = Number.isFinite(+options.speed) && +options.speed > 0 ? +options.speed : flyAutoSpeedKmh(total);
      const path = {
        title, coords,
        speed: kmh / 3.6, // 内部は m/s（.kasc fly_geojson の speed= と同じ）
        height: Number.isFinite(+options.height) ? +options.height : undefined,
        pitch: Number.isFinite(+options.pitch) ? +options.pitch : -10,
        loop: !!options.loop, view: options.view,
      };
      const prev = memoryFlyPaths.findIndex(p => p.title === title);
      if (prev >= 0) memoryFlyPaths.splice(prev, 1);
      memoryFlyPaths.push(path);
      if (hooks.persistFlyPath) { try { await hooks.persistFlyPath(title, parsed, path); } catch (_) {} }
      return { ok: true, name: title };
    },
    // 地点列(座標・地名・地物属性値)からルート生成→登録→(既定)再生。地名解決は searchLocation
    async flyRoute(waypoints, options = {}) {
      const list = Array.isArray(waypoints) ? waypoints : [];
      if (list.length < 2) return { ok: false, reason: "tooFewWaypoints" };
      const resolved = [];
      for (const wp of list) {
        let pt = null;
        if (wp && Number.isFinite(+wp.latitude) && Number.isFinite(+wp.longitude)) {
          pt = { latitude: +wp.latitude, longitude: +wp.longitude, label: wp.name || `${(+wp.latitude).toFixed(4)},${(+wp.longitude).toFixed(4)}` };
        } else {
          if (wp?.feature) {
            const hit = api.vectorSearch(wp.feature).find(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
            if (hit) pt = { latitude: hit.latitude, longitude: hit.longitude, label: String(wp.feature) };
          }
          if (!pt) {
            const q = wp?.query ?? wp?.name ?? (typeof wp === "string" ? wp : "");
            if (q) {
              try {
                const hit = (await api.searchLocation(String(q), options.provider))
                  .find(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
                if (hit) pt = { latitude: hit.latitude, longitude: hit.longitude, label: hit.title || String(q) };
              } catch (_) {}
            }
          }
        }
        resolved.push(pt);
      }
      const failIndex = resolved.findIndex(p => !p);
      if (failIndex >= 0) {
        const wp = list[failIndex] || {};
        return { ok: false, reason: "waypointFailed", index: failIndex, query: String(wp.query || wp.feature || wp.name || wp || failIndex + 1) };
      }
      const coords = resolved.map(p => [p.longitude, p.latitude]);
      const total = coords.slice(1).reduce((s, p, i) => s + flyLegDist(coords[i], p), 0);
      const kmh = Number.isFinite(+options.speed) && +options.speed > 0 ? +options.speed : flyAutoSpeedKmh(total);
      const title = String(options.name || "").trim() || `${resolved[0].label}→${resolved[resolved.length - 1].label}`;
      const path = {
        title, coords,
        speed: kmh / 3.6,
        height: Number.isFinite(+options.height) ? +options.height
          : (Number.isFinite(+options.agl) ? +options.agl : undefined),
        pitch: Number.isFinite(+options.pitch) ? +options.pitch : -10,
        loop: !!options.loop, view: options.view,
      };
      const prev = memoryFlyPaths.findIndex(p => p.title === title);
      if (prev >= 0) memoryFlyPaths.splice(prev, 1);
      memoryFlyPaths.push(path);
      const geojson = { type: "Feature", properties: { name: title }, geometry: { type: "LineString", coordinates: coords } };
      if (hooks.persistFlyPath) { try { await hooks.persistFlyPath(title, geojson, path); } catch (_) {} }
      if (options.autoplay !== false) void flyPlay(path).catch(e => console.warn("[fly]", e));
      return { ok: true, name: title, distance: Math.round(total) };
    },

    showReport(args = {}) { showReportModal(args); },

    // ---- DATA/ ファイル（fileWrite 能力 = ローカルサーバー版のみ）----
    async listDataFiles() {
      if (!hasBackendFeature("fileWrite")) return [];
      const project = hooks.getProjectId() || "default";
      const response = await fetch(`/api/files?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
      const data = await response.json().catch(() => ({}));
      return Array.isArray(data?.files) ? data.files : [];
    },
    async saveDataFile(name, content) {
      if (!hasBackendFeature("fileWrite")) return { ok: false, error: "fileWrite はローカルサーバー版のみで利用できます" };
      const project = hooks.getProjectId() || "default";
      const rel = String(name || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
      if (!rel) return { ok: false, error: "name is required" };
      const response = await fetch(`/api/files/${encodeURIComponent(project)}/${rel}`, { method: "PUT", body: content });
      if (!response.ok) return { ok: false, error: await response.text() || `HTTP ${response.status}` };
      return { ok: true, name };
    },
    async deleteDataFile(name) {
      if (!hasBackendFeature("fileWrite")) return { ok: false, error: "fileWrite はローカルサーバー版のみで利用できます" };
      const project = hooks.getProjectId() || "default";
      const rel = String(name || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
      if (!rel) return { ok: false, error: "name is required" };
      const response = await fetch(`/api/files/${encodeURIComponent(project)}/${rel}`, { method: "DELETE" });
      if (!response.ok) return { ok: false, error: await response.text() || `HTTP ${response.status}` };
      return { ok: true, name };
    },
    async fetchData(url, { maxChars = 400000 } = {}) {
      const target = String(url || "");
      if (!/^https?:\/\//i.test(target)) throw new Error("invalid url");
      const useProxy = hasBackendFeature("fetchProxy") && isFetchProxyTarget(target);
      const response = await fetch(useProxy ? `/api/fetch?url=${encodeURIComponent(target)}` : target,
        useProxy ? { signal: AbortSignal.timeout(30000) } : { mode: "cors", signal: AbortSignal.timeout(30000) });
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      return { status: response.status, contentType, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
    },

    // ---- 更新・停止（ローカルサーバー版のみ。features: update/shutdown）----
    // cesium 版は設定パネルのボタン経由だが、2D プレイヤーは該当 UI を持たないため
    // バックエンド API を直接呼ぶ
    async checkUpdate() {
      if (!hasBackendFeature("update")) return { ok: false, message: "この配信元では更新機能を利用できません" };
      try {
        const [healthRes, latestRes] = await Promise.all([
          fetch("/health", { cache: "no-store" }),
          fetch("/api/update/latest"),
        ]);
        if (!latestRes.ok) throw new Error(`HTTP ${latestRes.status}`);
        const health = healthRes.ok ? await healthRes.json().catch(() => ({})) : {};
        const latest = await latestRes.json().catch(() => ({}));
        const current = health.version || "";
        const latestVersion = latest.version || "";
        return {
          ok: true, current, latest: latestVersion,
          updateAvailable: !!(current && latestVersion && compareVersions(current, latestVersion) < 0),
        };
      } catch (e) { return { ok: false, message: String(e?.message || e) }; }
    },
    // 適用は確認ダイアログ後にバックエンドへ委譲し、再起動を待ってページを再読込する
    async installUpdate() {
      if (!hasBackendFeature("update")) return false;
      let latest = "";
      try {
        const r = await fetch("/api/update/latest");
        latest = (await r.json().catch(() => ({}))).version || "";
      } catch (_) {}
      if (!window.confirm(t("update.confirm", { version: latest || "?" }))) return false;
      const response = await fetch("/api/update/install", { method: "POST" });
      if (!response.ok) return false;
      const ping = async () => { try { return (await fetch("/health", { cache: "no-store" })).ok; } catch { return false; } };
      void (async () => {
        for (let i = 0; i < 60 && await ping(); i++) await flySleep(1000); // 旧サーバー停止待ち
        for (let i = 0; i < 120; i++) {                                    // 新サーバー起動待ち
          await flySleep(1000);
          if (await ping()) { window.location.reload(); return; }
        }
      })();
      return true;
    },
    async shutdownApp() {
      if (!hasBackendFeature("shutdown")) return false;
      if (!window.confirm(t("app.confirmShutdown"))) return false;
      try { await fetch("/api/shutdown", { method: "POST" }); } catch (_) {}
      return true;
    },

    // ---- AI キー（BYO・localStorage）----
    getGoogleApiKey() { try { return localStorage.getItem("googleApiKey") || ""; } catch { return ""; } },
    getGeminiModel() { try { return localStorage.getItem("googleGeminiModel") || "gemini-3.1-flash-lite"; } catch { return "gemini-3.1-flash-lite"; } },
    getGoogleMapsApiKey() { try { return localStorage.getItem("googleMapsApiKey") || ""; } catch { return ""; } },
    getGoogleMapsWsApiKey() { try { return localStorage.getItem("googleMapsWsApiKey") || localStorage.getItem("googleMapsApiKey") || ""; } catch { return ""; } },

    // ---- 汎用 UI ブリッジ（共有実装そのまま）----
    listUiControls: listUiControls,
    controlUi: controlUi,

    async executeChatTool(name, args = {}) {
      return await executeChatTool(name, args);
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      if (event === "ready" && this.isReady) { try { handler(this); } catch (e) { console.error(e); } }
    },
    off(event, handler) { listeners.get(event)?.delete(handler); },
    emit(event, payload) {
      for (const h of listeners.get(event) || []) { try { h(payload); } catch (e) { console.error(e); } }
    },
    getAuth() { return window.kasugaiAuth || null; },
  };
  return api;
}
