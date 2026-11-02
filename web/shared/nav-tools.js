// ナビゲーションツールバー共通機能（全エンジン共用・アダプタ注入式）
// フルスクリーン / 表示履歴 / 現在地(GPS) / 地点座標取得 / 矩形ズーム / スクリーンショット / 検索座標直入力
// adapter 仕様は各エンジン app.js の initNavTools 呼び出しを参照。機能が無い場合は該当ボタンを隠す
import { formatLatLng, parseCoordinateQuery } from "./coords-format.js";

const STYLE = `
.nav-history-row{display:flex;gap:4px}
.nav-history-row button{min-width:28px!important}
.navigation-toolbar .nav-extra-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.navigation-toolbar .nav-extra-grid button{min-width:28px!important}
.navigation-toolbar button.nav-active{border-color:#31564f;background:#31564f;color:#fff}
.navigation-toolbar button:disabled{opacity:.45;cursor:default}
.navigation-toolbar.collapsed .nav-history-row,.navigation-toolbar.collapsed .nav-extra-grid{display:none}
.rect-zoom-box{position:absolute;z-index:1009;border:2px dashed #31564f;background:rgba(49,86,79,.12);pointer-events:none;box-sizing:border-box}
#coord-popup{position:absolute;z-index:1010;min-width:200px;max-width:280px;background:rgba(255,255,255,.96);border-radius:6px;padding:8px 10px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
#coord-popup .coord-popup-text{font-family:monospace;font-weight:600;color:#1d2b35;overflow-wrap:anywhere}
#coord-popup .coord-popup-address{margin-top:2px;color:#52636d;font-size:11px;overflow-wrap:anywhere}
#coord-popup .coord-popup-actions{display:flex;gap:4px;margin-top:5px}
#coord-popup .coord-popup-actions button{padding:2px 8px;border:1px solid rgba(0,0,0,.1);border-radius:4px;background:#f1f4f8;color:#263643;cursor:pointer;font-size:11px}
#coord-popup .coord-popup-actions button:hover{background:#e7f3f0}
#screenshot-button{font-size:20px;line-height:1;padding:0}
#coords-format{width:100%;min-height:30px;padding:5px 7px;border:1px solid #cbd9de;border-radius:4px;background:#fff;color:#1d2b35;font-size:var(--basemap-select-font-size,13px);box-sizing:border-box}
`;

export function initNavTools(a) {
  if (!document.getElementById("nav-tools-style")) {
    const st = document.createElement("style");
    st.id = "nav-tools-style";
    st.textContent = STYLE;
    document.head.appendChild(st);
  }
  const $ = s => document.querySelector(s);
  const hide = id => { const el = $(id); if (el) el.style.display = "none"; };

  // ---- フルスクリーン ----
  const fsBtn = $("#fullscreen-button");
  fsBtn?.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void (a.el || document.documentElement).requestFullscreen?.();
  });
  document.addEventListener("fullscreenchange", () => {
    fsBtn?.classList.toggle("nav-active", !!document.fullscreenElement);
  });

  // ---- 表示履歴（前へ/次へ）----
  const backStack = [], fwdStack = [];
  let pending = null, navigating = false, restView = a.getView ? a.getView() : null;
  const viewsEqual = a.viewsEqual || ((x, y) => x && y && Math.abs(x.lat - y.lat) < 1e-7 && Math.abs(x.lng - y.lng) < 1e-7 && Math.abs((x.zoom ?? 0) - (y.zoom ?? 0)) < 0.001);
  const syncHistBtns = () => { const b = $("#view-back"), f = $("#view-forward"); if (b) b.disabled = !backStack.length; if (f) f.disabled = !fwdStack.length; };
  if (a.getView && a.setView && a.onMoveEnd) {
    a.onMoveStart?.(() => { if (!navigating) pending = a.getView(); });
    a.onMoveEnd(() => {
      if (navigating) { navigating = false; return; }
      const start = pending || restView;
      pending = null;
      if (!start) return;
      restView = a.getView();
      if (viewsEqual(start, restView)) return;
      backStack.push(start);
      if (backStack.length > 100) backStack.shift();
      fwdStack.length = 0;
      syncHistBtns();
    });
    $("#view-back")?.addEventListener("click", () => {
      const v = backStack.pop(); if (!v) return;
      fwdStack.push(a.getView()); navigating = true; a.setView(v); syncHistBtns();
    });
    $("#view-forward")?.addEventListener("click", () => {
      const v = fwdStack.pop(); if (!v) return;
      backStack.push(a.getView()); navigating = true; a.setView(v); syncHistBtns();
    });
    window.addEventListener("keydown", e => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); $("#view-back")?.click(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); $("#view-forward")?.click(); }
    });
  } else { hide("#view-back"); hide("#view-forward"); }

  // ---- 現在地 (GPS) ----
  const locateBtn = $("#locate-button");
  let locateWatch = null, locateMarker = null;
  const stopLocate = () => {
    if (locateWatch !== null) { navigator.geolocation.clearWatch(locateWatch); locateWatch = null; }
    a.setMarker?.(null, locateMarker); locateMarker = null;
    locateBtn?.classList.remove("nav-active");
  };
  if (a.flyTo && navigator.geolocation) {
    locateBtn?.addEventListener("click", () => {
      if (locateWatch !== null) { stopLocate(); return; }
      locateBtn.classList.add("nav-active");
      let lastFly = 0;
      locateWatch = navigator.geolocation.watchPosition(pos => {
        const { latitude, longitude, accuracy } = pos.coords;
        locateMarker = { lat: latitude, lng: longitude, accuracy };
        a.setMarker?.({ lat: latitude, lng: longitude, accuracy, kind: "locate" }, locateMarker);
        const now = Date.now();
        if (now - lastFly > 3000) { lastFly = now; a.flyTo(latitude, longitude); }
      }, () => stopLocate(), { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
    });
  } else hide("#locate-button");

  // ---- 地点座標取得 ----
  const pickBtn = $("#coordpick-button");
  if (a.toLatLng && a.el) {
    let popup = $("#coord-popup");
    if (!popup) {
      popup = document.createElement("div");
      popup.id = "coord-popup";
      popup.hidden = true;
      popup.innerHTML = `<div id="coord-popup-text" class="coord-popup-text"></div><div id="coord-popup-address" class="coord-popup-address"></div><div class="coord-popup-actions"><button id="coord-popup-copy" type="button">コピー</button><button id="coord-popup-pin" type="button">ピン</button><button id="coord-popup-close" type="button">×</button></div>`;
      (a.el || document.body).appendChild(popup);
    }
    const pText = popup.querySelector("#coord-popup-text"), pAddr = popup.querySelector("#coord-popup-address");
    let pickMode = false, lastDeg = null;
    pickBtn?.addEventListener("click", () => {
      pickMode = !pickMode;
      pickBtn.classList.toggle("nav-active", pickMode);
      if (a.el) a.el.style.cursor = pickMode ? "crosshair" : "";
      if (!pickMode) popup.hidden = true;
    });
    popup.querySelector("#coord-popup-close").addEventListener("click", () => { popup.hidden = true; });
    popup.querySelector("#coord-popup-copy").addEventListener("click", async e => {
      if (!lastDeg) return;
      await navigator.clipboard?.writeText(`${lastDeg.lat.toFixed(6)}, ${lastDeg.lng.toFixed(6)}`);
      e.target.textContent = "コピーしました";
      setTimeout(() => { e.target.textContent = "コピー"; }, 1500);
    });
    popup.querySelector("#coord-popup-pin").addEventListener("click", () => {
      if (lastDeg) a.setMarker?.({ ...lastDeg, kind: "pin" }, lastDeg);
    });
    a.el.addEventListener("click", e => {
      if (!pickMode) return;
      e.stopPropagation();
      const r = a.el.getBoundingClientRect();
      const ll = a.toLatLng(e.clientX - r.left, e.clientY - r.top);
      if (!ll) return;
      lastDeg = { lat: ll.lat, lng: ll.lng };
      pText.textContent = formatLatLng(ll.lat, ll.lng);
      pAddr.textContent = "";
      popup.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 290)}px`;
      popup.style.top = `${Math.max(8, e.clientY - r.top - 10)}px`;
      popup.hidden = false;
      const q = lastDeg;
      fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lon=${q.lng}&lat=${q.lat}`)
        .then(r2 => (r2.ok ? r2.json() : null))
        .then(d => { if (d?.results && lastDeg === q) pAddr.textContent = `${d.results.lv01Nm || ""} (muniCd: ${d.results.muniCd || "-"})`.trim(); })
        .catch(() => {});
    }, true);
  } else hide("#coordpick-button");

  // ---- 矩形ズーム ----
  const rzBtn = $("#rectzoom-button");
  if (a.toLatLng && a.fitBounds && a.el) {
    let mode = false, rz = null;
    const rel = e => { const r = a.el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const begin = (x, y) => {
      if (rz) return;
      const box = document.createElement("div");
      box.className = "rect-zoom-box";
      a.el.appendChild(box);
      rz = { x0: x, y0: y, x1: x, y1: y, box };
    };
    const update = (x, y) => {
      if (!rz) return;
      rz.x1 = x; rz.y1 = y;
      Object.assign(rz.box.style, {
        left: `${Math.min(rz.x0, rz.x1)}px`, top: `${Math.min(rz.y0, rz.y1)}px`,
        width: `${Math.abs(rz.x1 - rz.x0)}px`, height: `${Math.abs(rz.y1 - rz.y0)}px`,
      });
    };
    const end = (x, y, commit) => {
      if (!rz) return;
      update(x, y);
      const { x0, y0, x1, y1 } = rz;
      rz.box.remove(); rz = null;
      if (!commit || Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) return;
      const c0 = a.toLatLng(Math.min(x0, x1), Math.min(y0, y1));
      const c1 = a.toLatLng(Math.max(x0, x1), Math.max(y0, y1));
      if (!c0 || !c1) return;
      a.fitBounds(Math.min(c0.lng, c1.lng), Math.min(c0.lat, c1.lat), Math.max(c0.lng, c1.lng), Math.max(c0.lat, c1.lat));
    };
    a.el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const useRect = mode || (!a.nativeBoxZoom && e.shiftKey);
      if (!useRect) return;
      e.preventDefault(); e.stopPropagation();
      const [x, y] = rel(e);
      begin(x, y);
      a.el.setPointerCapture(e.pointerId);
    }, true);
    a.el.addEventListener("pointermove", e => {
      if (!rz) return;
      e.preventDefault(); e.stopPropagation();
      const [x, y] = rel(e);
      update(x, y);
    }, true);
    a.el.addEventListener("pointerup", e => {
      if (!rz) return;
      e.preventDefault(); e.stopPropagation();
      const [x, y] = rel(e);
      end(x, y, true);
    }, true);
    rzBtn?.addEventListener("click", () => {
      mode = !mode;
      rzBtn.classList.toggle("nav-active", mode);
      if (!mode && rz) end(0, 0, false);
    });
    window.addEventListener("keydown", e => { if (e.key === "Escape" && rz) end(0, 0, false); });
  } else hide("#rectzoom-button");

  // ---- スクリーンショット ----
  const ssBtn = $("#screenshot-button");
  if (a.capturePng) {
    ssBtn?.addEventListener("click", () => {
      void (async () => {
        const blob = await a.capturePng();
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `kasugai_canvas_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.png`;
        document.body.appendChild(link);
        link.click(); link.remove();
        URL.revokeObjectURL(url);
      })();
    });
  } else hide("#screenshot-button");

  // ---- 検索窓の座標直入力（Enter で座標なら FlyTo）----
  const searchInput = $(a.searchSel || "#search-input");
  if (a.flyTo && searchInput) {
    searchInput.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const c = parseCoordinateQuery(searchInput.value);
      if (c) { e.stopPropagation(); a.flyTo(c.lat, c.lng); }
    }, true);
  }
}
