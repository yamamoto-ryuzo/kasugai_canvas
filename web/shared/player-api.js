// KASUGAI Canvas — 2D プレイヤー用 kasugaiApi アダプタ
// maplibre / openlayers / leaflet の各フロントが共通構造（layerEntries +
// エンジン別の描画フック）を持つため、エンジン差分は hooks として注入し、
// kasugaiApi 互換の API 面をここで構成する。AI チャット（shared/ai-chat.js）の
// ツールはこの api メソッドの有無で公開可否が決まる。
import { camToZoom, zoomToCamHeight, geojsonExtent, splitKascTitle } from "./kasc.js";
import { hasBackendFeature, executeChatTool, showReportModal, listUiControls, controlUi } from "./ai-chat.js";

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

    // 地名検索: OSM Nominatim（キー不要・CORS対応）
    async searchLocation(query) {
      const q = String(query || "").trim();
      if (!q) return [];
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ja&q=${encodeURIComponent(q)}`;
      try {
        const res = await fetch(url);
        const list = await res.json().catch(() => []);
        return (Array.isArray(list) ? list : []).map(r => ({
          title: String(r.display_name || "").split(",")[0],
          address: r.display_name || "",
          latitude: Number(r.lat),
          longitude: Number(r.lon),
        })).filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
      } catch { return []; }
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
      const fetchUrl = hasBackendFeature("fetchProxy") ? `/api/fetch?url=${encodeURIComponent(target)}` : target;
      const response = await fetch(fetchUrl, hasBackendFeature("fetchProxy") ? {} : { mode: "cors" });
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      return { status: response.status, contentType, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
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
