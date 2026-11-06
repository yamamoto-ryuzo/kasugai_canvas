// ミニマップ（表示>一般の #display-minimap トグル）。
// 左下の小地図に現在の表示範囲矩形（または中心マーカー）を重ねる。
// Leaflet(UMD)は module import でグローバルに展開されないため script タグで遅延ロードする。
//
// createMinimap({
//   container : "#minimap" | HTMLElement   // ミニマップの配置先（無ければ document.body 直下に生成）
//   checkbox  : "#display-minimap" | HTMLElement | null
//   tileUrl   : () => "{z}/{x}/{y}" テンプレート（省略時は地理院淡色地図）
//   getBounds : () => [[south,west],[north,east]] | null   // 表示範囲矩形
//   getCenter : () => {lat,lng} | null      // bounds が取れない場合のマーカー位置（省略可）
//   flyTo     : ({lng,lat}) => void         // クリック地点への移動（省略可）
// }) → { scheduleUpdate(), update(), dispose() }
const LEAFLET_CDN = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4";
const FALLBACK_TILE = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";

const CSS = `
.kasc-minimap { position: absolute; left: 14px; bottom: 74px; z-index: 1004; width: 220px; height: 150px;
  border: 1px solid rgba(14,32,64,.25); border-radius: 6px; overflow: hidden;
  box-shadow: 0 4px 12px rgba(10,20,40,.2); }
.kasc-minimap .leaflet-container { width: 100%; height: 100%; background: #dfe6ea; cursor: crosshair; }
`;

let styleInjected = false;
function ensureStyle() {
  if (styleInjected || document.querySelector("#kasc-minimap-style")) return;
  styleInjected = true;
  const el = document.createElement("style");
  el.id = "kasc-minimap-style";
  el.textContent = CSS;
  document.head.append(el);
}

let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    if (!document.querySelector('link[href*="leaflet.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${LEAFLET_CDN}/dist/leaflet.css`;
      document.head.append(link);
    }
    leafletPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${LEAFLET_CDN}/dist/leaflet.js`;
      s.onload = () => window.L ? resolve(window.L) : reject(new Error("leaflet load failed"));
      s.onerror = () => reject(new Error("leaflet load failed"));
      document.head.append(s);
    });
    leafletPromise.catch(() => { leafletPromise = null; });
  }
  return leafletPromise;
}

export function createMinimap({ container, checkbox, tileUrl, getBounds, getCenter, flyTo } = {}) {
  ensureStyle();
  const el = typeof container === "string" ? document.querySelector(container) : (container || (() => {
    const d = document.createElement("div");
    d.id = "minimap";
    document.body.append(d);
    return d;
  })());
  const cb = typeof checkbox === "string" ? document.querySelector(checkbox) : checkbox;
  if (!el) return { scheduleUpdate() {}, update() {}, dispose() {} };
  el.classList.add("kasc-minimap");
  el.hidden = true;

  let state = null;   // { map, tile, rect, marker }
  let timer = null;
  let disposed = false;
  const enabled = () => !disposed && (!cb || cb.checked);
  const wantTile = () => {
    const url = tileUrl && tileUrl();
    return /\{z\}.*\{x\}.*\{y\}|\{z\}.*\{y\}.*\{x\}/.test(url || "") ? url : FALLBACK_TILE;
  };

  async function update() {
    if (disposed) return;
    if (!enabled()) { el.hidden = true; return; }
    el.hidden = false;
    const L = await loadLeaflet().catch(() => null);
    if (!L || disposed || !enabled()) { if (!L) el.hidden = true; return; }
    if (!state) {
      const map = L.map(el, {
        zoomControl: false, attributionControl: false, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
        keyboard: false, touchZoom: false, zoomSnap: 0.25,
      });
      const tile = L.tileLayer(wantTile(), { opacity: 0.9 }).addTo(map);
      const rect = L.rectangle([[0, 0], [0, 0]], { color: "#e33d3d", weight: 1.5, fill: false, interactive: false });
      const marker = L.circleMarker([0, 0], { radius: 4, color: "#e33d3d", weight: 1.5, fillColor: "#e33d3d", fillOpacity: 1, interactive: false });
      if (flyTo) map.on("click", e => flyTo({ lng: e.latlng.lng, lat: e.latlng.lat }));
      state = { map, tile, rect, marker };
    } else {
      const want = wantTile();
      if (state.tile._url !== want) state.tile.setUrl(want);
      state.map.invalidateSize();
    }
    const b = getBounds && getBounds();
    if (b) {
      if (!state.rect._map) state.rect.addTo(state.map);
      if (state.marker._map) state.marker.remove();
      state.rect.setBounds(b);
      state.map.fitBounds(b, { animate: false, padding: [24, 24] });
    } else {
      if (state.rect._map) state.rect.remove();
      const c = getCenter && getCenter();
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
        if (!state.marker._map) state.marker.addTo(state.map);
        state.marker.setLatLng([c.lat, c.lng]);
        state.map.setView([c.lat, c.lng], Math.max(2, (state.map.getZoom() || 5) - 2), { animate: false });
      }
    }
  }

  function scheduleUpdate() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void update(); }, 250);
  }

  cb?.addEventListener("change", () => { void update(); });

  return {
    scheduleUpdate,
    update,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      try { state?.map?.remove(); } catch (_) {}
      state = null;
      el.hidden = true;
    },
  };
}
