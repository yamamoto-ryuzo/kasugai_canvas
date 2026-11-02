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
.view-history-list{position:fixed;z-index:1200;min-width:220px;max-width:330px;max-height:320px;overflow-y:auto;background:rgba(255,255,255,.97);border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.4);padding:4px;display:flex;flex-direction:column;gap:2px}
.view-history-item{text-align:left;padding:4px 8px;border:none;border-radius:4px;background:transparent;color:#263643;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.view-history-item:hover{background:#e7f3f0}
.view-history-item.is-current{font-weight:700;background:#eef4f3;cursor:default}
#screenshot-button{font-size:20px;line-height:1;padding:0}
#coords-format{width:100%;min-height:30px;padding:5px 7px;border:1px solid #cbd9de;border-radius:4px;background:#fff;color:#1d2b35;font-size:var(--basemap-select-font-size,13px);box-sizing:border-box}
`;

// スタイルを1度だけ注入する（installViewHistory を単独で使う Cesium 等でも必須）
function ensureNavToolsStyle() {
  if (document.getElementById("nav-tools-style")) return;
  const st = document.createElement("style");
  st.id = "nav-tools-style";
  st.textContent = STYLE;
  document.head.appendChild(st);
}

// 表示履歴の前へ/次へボタンへ「クリック=1ステップ移動 / ダブルクリック=履歴一覧から任意ジャンプ」を装着する
// opts: { backBtn, fwdBtn, getStacks() -> {back,fwd}（ミュータブル配列・endがtop）, getView(), setView(v),
//         label(v), beforeNavigate(), sync() }
export function installViewHistory(opts) {
  const backBtn = typeof opts.backBtn === "string" ? document.querySelector(opts.backBtn) : opts.backBtn;
  const fwdBtn = typeof opts.fwdBtn === "string" ? document.querySelector(opts.fwdBtn) : opts.fwdBtn;
  const label = opts.label || (v => `${Number(v.lat ?? v.latitude).toFixed(5)}, ${Number(v.lng ?? v.longitude).toFixed(5)}`);
  const jump = v => { opts.beforeNavigate?.(); opts.setView(v); opts.sync?.(); };
  const step = dir => {
    const { back, fwd } = opts.getStacks();
    const v = (dir < 0 ? back : fwd).pop();
    if (!v) return;
    const cur = opts.getView();
    if (cur) (dir < 0 ? fwd : back).push(cur);
    jump(v);
  };
  // 履歴内の任意位置へジャンプ（残り分は反対スタックへ移す）
  const jumpToIndex = (where, i) => {
    const { back, fwd } = opts.getStacks();
    const cur = opts.getView();
    if (where === "back") {
      const target = back[i];
      if (cur) fwd.push(cur);
      for (let j = back.length - 1; j > i; j--) fwd.push(back[j]);
      back.length = i;
      jump(target);
    } else {
      const target = fwd[i];
      if (cur) back.push(cur);
      for (let j = fwd.length - 1; j > i; j--) back.push(fwd[j]);
      fwd.length = i;
      jump(target);
    }
  };
  // シングルクリックはダブルクリック判別のため遅延実行
  let clickTimer = null;
  const bindBtn = (btn, dir) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => { clickTimer = null; step(dir); }, 260);
    });
    btn.addEventListener("dblclick", e => { e.preventDefault(); openList(dir); });
  };
  bindBtn(backBtn, -1);
  bindBtn(fwdBtn, 1);

  // ---- 履歴一覧ポップアップ ----
  let listEl = null;
  const onDocDown = e => { if (listEl && !listEl.contains(e.target)) closeList(); };
  const closeList = () => { listEl?.remove(); listEl = null; document.removeEventListener("pointerdown", onDocDown, true); };
  const openList = anchorDir => {
    closeList();
    ensureNavToolsStyle();
    const { back, fwd } = opts.getStacks();
    const cur = opts.getView();
    if (!back.length && !fwd.length && !cur) return;
    listEl = document.createElement("div");
    listEl.className = "view-history-list";
    const entries = [
      ...back.map((v, i) => ({ v, where: "back", i })),
      { v: null, where: "current" },
      ...[...fwd].reverse().map((v, k) => ({ v, where: "fwd", i: fwd.length - 1 - k })),
    ];
    entries.forEach((ent, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "view-history-item" + (ent.where === "current" ? " is-current" : "");
      b.textContent = ent.where === "current" ? `● ${idx + 1}: ${label(cur)}（現在）` : `${idx + 1}: ${label(ent.v)}`;
      if (ent.where !== "current") b.addEventListener("click", () => { jumpToIndex(ent.where, ent.i); closeList(); });
      listEl.appendChild(b);
    });
    const anchor = (anchorDir < 0 ? backBtn : fwdBtn) || backBtn || fwdBtn;
    const r = (anchor || document.body).getBoundingClientRect();
    listEl.style.right = `${Math.max(8, innerWidth - r.left + 8)}px`;
    listEl.style.top = `${Math.max(8, Math.min(r.top, innerHeight - 340))}px`;
    document.body.appendChild(listEl);
    document.addEventListener("pointerdown", onDocDown, true);
  };
  window.addEventListener("keydown", e => { if (e.key === "Escape") closeList(); });
}

export function initNavTools(a) {
  ensureNavToolsStyle();
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
    installViewHistory({
      backBtn: "#view-back", fwdBtn: "#view-forward",
      getStacks: () => ({ back: backStack, fwd: fwdStack }),
      getView: a.getView, setView: a.setView,
      beforeNavigate: () => { navigating = true; },
      sync: syncHistBtns,
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
