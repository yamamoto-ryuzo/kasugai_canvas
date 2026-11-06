// ---- ローカル座標系（現場独自座標）: 対応点定義・変換・設定UI 全エンジン共通 ----
// 基準フレームは平面直角座標系(JGD系・GRS80楕円体)。対応点
// (公共座標の緯度経度 ↔ ローカル座標の X,Y) から変換を推定する:
//   対応点1点  → 平行移動（1点オフセット・型押し）
//   対応点2点  → 相似変換（回転+一様スケール+平行移動）
//   対応点3点以上 → アフィン変換（6パラメータ最小二乗推定）
// 定義は localStorage "kasugai:localcrs" に保存（ブラウザごとのユーザー設定）。
// 表示は formatLatLng の format=local 経路のみで行う（検索・入力の逆変換は持たない）。

import { t } from "./i18n.js";
import { gaussKruger, jpxZoneAt, jpxZoneOrigin } from "./coords-format.js";

const STORAGE_KEY = "kasugai:localcrs";

function _tr(key, fallback) {
  const s = t(key);
  return s === key ? fallback : s;
}

// 定義: { zone: 系番号(0-18), points: [{lat,lon,x,y}] }
// zone は対応点の重心最近傍を保存時に確定する（表示・編集で系がブレないようにする）
export function getLocalCrs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const def = JSON.parse(raw);
    if (!def || !Array.isArray(def.points)) return null;
    const points = def.points.filter(p =>
      Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && Number.isFinite(p?.x) && Number.isFinite(p?.y));
    if (!points.length || !Number.isInteger(def.zone)) return null;
    return { zone: def.zone, points };
  } catch (e) { return null; }
}

export function setLocalCrs(def) {
  try {
    if (!def || !Array.isArray(def.points) || !def.points.length) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ zone: def.zone, points: def.points }));
  } catch (e) { /* ignore */ }
}

// 緯度経度 → 定義 zone の平面直角 XY（公共座標）
function toPublicXY(latDeg, lonDeg, zoneIndex) {
  const origin = jpxZoneOrigin(zoneIndex);
  return gaussKruger(latDeg, lonDeg, origin.lat0, origin.lon0, 0.9999);
}

// 3x3 連立一次方程式（最小二乗の正規方程式用。ガウス消去・ピボット付き）
function solve3(a, b) {
  const m = a.map((row, i) => [row[0], row[1], row[2], b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = col + 1; r < 3; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= 3; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    x[r] = (m[r][3] - m[r][0] * x[0] - m[r][1] * x[1] - m[r][2] * x[2]) / m[r][r];
  }
  return x;
}

// 対応点から変換を推定する。
// 戻り値: { kind:"offset"|"similarity"|"affine", zone, params, residuals:[各点の残差(m)], rms }
// 公共座標(px,py) → ローカル座標(x,y):
//   offset:     x = px + dx,              y = py + dy
//   similarity: x = c*px - s*py + tx,     y = s*px + c*py + ty   （c=scale·cosθ, s=scale·sinθ）
//   affine:     x = a*px + b*py + tx,     y = c*px + d*py + ty
export function solveLocalTransform(def) {
  const points = (def?.points || []).filter(p =>
    Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (!points.length || !Number.isInteger(def?.zone)) return null;
  // px,py = 公共(平面直角)座標、lx,ly = ローカル座標
  const pts = points.map(p => {
    const q = toPublicXY(p.lat, p.lon, def.zone);
    return { px: q.x, py: q.y, lx: p.x, ly: p.y };
  });
  let params, kind;
  if (pts.length === 1) {
    kind = "offset";
    params = { dx: pts[0].lx - pts[0].px, dy: pts[0].ly - pts[0].py };
  } else if (pts.length === 2) {
    kind = "similarity";
    const [p1, p2] = pts;
    const dpx = p2.px - p1.px, dpy = p2.py - p1.py;
    const dlx = p2.lx - p1.lx, dly = p2.ly - p1.ly;
    const a = dpx * dlx + dpy * dly;           // 公共差分とローカル差分の内積
    const b = dpx * dly - dpy * dlx;           // 外積
    const r2 = dpx * dpx + dpy * dpy;
    if (r2 < 1e-12) return null;
    const c = a / r2, s = b / r2;
    params = { c, s, tx: p1.lx - (c * p1.px - s * p1.py), ty: p1.ly - (s * p1.px + c * p1.py) };
  } else {
    kind = "affine";
    // X = a*px + b*py + tx, Y = c*px + d*py + ty を最小二乗で推定
    const sumPP = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const sumPLx = [0, 0, 0], sumPLy = [0, 0, 0];
    for (const p of pts) {
      const row = [p.px, p.py, 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) sumPP[i][j] += row[i] * row[j];
        sumPLx[i] += row[i] * p.lx;
        sumPLy[i] += row[i] * p.ly;
      }
    }
    const xSol = solve3(sumPP, sumPLx);
    const ySol = solve3(sumPP, sumPLy);
    if (!xSol || !ySol) return null;
    params = { a: xSol[0], b: xSol[1], tx: xSol[2], c: ySol[0], d: ySol[1], ty: ySol[2] };
  }
  const residuals = pts.map(p => {
    const { x, y } = applyLocalTransform({ kind, params }, p.px, p.py);
    return Math.hypot(x - p.lx, y - p.ly);
  });
  const rms = Math.sqrt(residuals.reduce((acc, v) => acc + v * v, 0) / residuals.length);
  return { kind, zone: def.zone, params, residuals, rms };
}

// 変換を公共XYへ適用（内部用）
function applyLocalTransform(tr, px, py) {
  const p = tr.params;
  if (tr.kind === "offset") return { x: px + p.dx, y: py + p.dy };
  if (tr.kind === "similarity") return { x: p.c * px - p.s * py + p.tx, y: p.s * px + p.c * py + p.ty };
  return { x: p.a * px + p.b * py + p.tx, y: p.c * px + p.d * py + p.ty };
}

// 緯度経度 → ローカルXY（定義が無い/系外なら null）
export function toLocalXY(latDeg, lonDeg, def = getLocalCrs()) {
  const tr = solveLocalTransform(def);
  if (!tr) return null;
  const pub = toPublicXY(latDeg, lonDeg, def.zone);
  return applyLocalTransform(tr, pub.x, pub.y);
}

// formatLatLng の format=local 表示用文字列
export function localCoordsString(latDeg, lonDeg) {
  const def = getLocalCrs();
  if (!def) return _tr("coords.localNotSet", "ローカル座標未設定");
  const xy = toLocalXY(latDeg, lonDeg, def);
  if (!xy) return _tr("coords.localNotSet", "ローカル座標未設定");
  return `LOCAL(${jpxZoneOrigin(def.zone).name}) X=${xy.x.toFixed(3)} Y=${xy.y.toFixed(3)}`;
}

// ---- 対応点設定 UI ----
// installLocalCrsUI({ anchor, pickLatLng, onChange })
//   anchor:     設定ボタンを挿入する位置の基準要素（#coords-datum の <label> 等）
//   pickLatLng: (callback) => void — 「地図で拾う」押下時に1回だけ地図クリックを
//               受け取り {lat,lon} で callback を呼ぶ実装をエンジン側が渡す
//   onChange:   定義変更時に呼ばれる（未指定でも表示系は次回 formatLatLng で反映）

const CSS = `
.localcrs-edit-btn { margin-left: 6px; padding: 2px 8px; font-size: 12px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; color: #52636d; cursor: pointer; }
.localcrs-edit-btn:hover { background: #eef5f7; }
.localcrs-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.25); z-index: 4000; }
.localcrs-dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 4001; width: 460px; max-width: 92vw; max-height: 80vh; overflow-y: auto; background: #fff; border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.3); padding: 14px; font-family: system-ui, "Yu Gothic", sans-serif; font-size: 13px; }
.localcrs-dialog h3 { margin: 0 0 8px; font-size: 14px; }
.localcrs-table { width: 100%; border-collapse: collapse; }
.localcrs-table th { font-size: 11px; color: #71818d; text-align: left; padding: 2px 4px; }
.localcrs-table td { padding: 2px; }
.localcrs-table input { width: 100%; box-sizing: border-box; padding: 4px 6px; border: 1px solid #cbd9de; border-radius: 4px; font-size: 12px; }
.localcrs-pick { padding: 4px 6px; font-size: 11px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; cursor: pointer; white-space: nowrap; }
.localcrs-pick.armed { background: #ffe9c9; border-color: #e67e22; }
.localcrs-del { padding: 4px 8px; font-size: 12px; border: 1px solid #e4ecef; border-radius: 4px; background: #fff; color: #a82020; cursor: pointer; }
.localcrs-add { margin-top: 8px; padding: 4px 10px; font-size: 12px; border: 1px solid #cbd9de; border-radius: 4px; background: #f6f9fb; cursor: pointer; }
.localcrs-status { margin-top: 8px; font-size: 12px; color: #52636d; }
.localcrs-actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 8px; }
.localcrs-actions button { padding: 6px 14px; font-size: 13px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; cursor: pointer; }
.localcrs-note { margin-top: 6px; font-size: 11px; color: #71818d; }
`;

let styleDone = false;
function ensureLocalCrsStyle() {
  if (styleDone) return;
  styleDone = true;
  const el = document.createElement("style");
  el.textContent = CSS;
  document.head.append(el);
}

export function installLocalCrsUI({ anchor, pickLatLng } = {}) {
  ensureLocalCrsStyle();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "local-crs-edit";
  btn.className = "localcrs-edit-btn";
  btn.textContent = _tr("coords.localSetup", "ローカル座標…");
  const host = anchor?.closest?.("label") || anchor;
  if (host) host.insertAdjacentElement("afterend", btn);
  else document.body.append(btn);

  let rows = []; // [{lat,lon,x,y}] 編集中の対応点（未確定値は NaN 許容）
  let dialog = null;
  let pickRow = -1;

  const KIND_LABEL = () => ({
    offset: _tr("coords.localKindOffset", "平行移動（1点オフセット）"),
    similarity: _tr("coords.localKindSimilarity", "相似変換（回転+縮尺）"),
    affine: _tr("coords.localKindAffine", "アフィン変換（最小二乗）"),
  });

  function saveFromRows() {
    const points = rows.filter(r =>
      Number.isFinite(r.lat) && Number.isFinite(r.lon) && Number.isFinite(r.x) && Number.isFinite(r.y));
    if (!points.length) { setLocalCrs(null); return; }
    const clat = points.reduce((a, p) => a + p.lat, 0) / points.length;
    const clon = points.reduce((a, p) => a + p.lon, 0) / points.length;
    setLocalCrs({ zone: jpxZoneAt(clat, clon).index, points });
  }

  function renderStatus() {
    const el = dialog?.querySelector(".localcrs-status");
    if (!el) return;
    const def = getLocalCrs();
    const tr = def && solveLocalTransform(def);
    if (!tr) {
      el.textContent = _tr("coords.localStatusEmpty", "有効な対応点がありません（公共・ローカル両方を入力）");
      return;
    }
    const kind = KIND_LABEL()[tr.kind] || tr.kind;
    const res = tr.kind === "offset" ? "" : ` / ${_tr("coords.localResidual", "残差(RMS)")} ${tr.rms.toFixed(3)} m`;
    el.textContent = `${_tr("coords.localStatus", "推定方式")}: ${kind}（${jpxZoneOrigin(def.zone).name}${_tr("coords.localZone", "系基準")}）${res}`;
  }

  function renderRows() {
    const tbody = dialog.querySelector(".localcrs-tbody");
    tbody.replaceChildren();
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const mk = (key, placeholder) => {
        const td = document.createElement("td");
        const inp = document.createElement("input");
        inp.type = "number"; inp.step = "any"; inp.placeholder = placeholder;
        if (Number.isFinite(r[key])) inp.value = String(r[key]);
        inp.addEventListener("input", () => {
          const v = Number(inp.value);
          r[key] = inp.value.trim() === "" ? NaN : v;
          saveFromRows(); renderStatus();
        });
        td.append(inp);
        return td;
      };
      tr.append(mk("lat", "35.681"), mk("lon", "139.767"));
      const pickTd = document.createElement("td");
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "localcrs-pick" + (pickRow === i ? " armed" : "");
      pick.textContent = _tr("coords.localPick", "地図で拾う");
      pick.disabled = !pickLatLng;
      pick.addEventListener("click", () => {
        if (!pickLatLng || pickRow >= 0) return;
        pickRow = i;
        pick.classList.add("armed");
        pickLatLng(latlon => {
          pickRow = -1;
          pick.classList.remove("armed");
          if (!latlon) return;
          rows[i].lat = latlon.lat;
          rows[i].lon = latlon.lon ?? latlon.lng;
          saveFromRows(); renderRows(); renderStatus();
        });
      });
      pickTd.append(pick);
      tr.append(pickTd, mk("x", "0.000"), mk("y", "0.000"));
      const delTd = document.createElement("td");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "localcrs-del";
      del.textContent = "×";
      del.addEventListener("click", () => {
        rows.splice(i, 1); pickRow = -1; saveFromRows(); renderRows(); renderStatus();
      });
      delTd.append(del);
      tr.append(delTd);
      tbody.append(tr);
    });
  }

  function open() {
    close();
    const def = getLocalCrs();
    rows = def ? def.points.map(p => ({ ...p })) : [];
    if (!rows.length) rows.push({ lat: NaN, lon: NaN, x: NaN, y: NaN });
    const backdrop = document.createElement("div");
    backdrop.className = "localcrs-backdrop";
    dialog = document.createElement("div");
    dialog.className = "localcrs-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `
      <h3>${_tr("coords.localTitle", "ローカル座標 対応点設定")}</h3>
      <div class="localcrs-note">${_tr("coords.localDesc", "公共座標（緯度・経度）とローカル座標（X・Y）の対応点を登録します。1点=平行移動、2点=相似変換、3点以上=アフィン変換です。")}</div>
      <table class="localcrs-table">
        <thead><tr>
          <th>${_tr("coords.localLat", "緯度")}</th><th>${_tr("coords.localLon", "経度")}</th><th></th>
          <th>X</th><th>Y</th><th></th>
        </tr></thead>
        <tbody class="localcrs-tbody"></tbody>
      </table>
      <button type="button" class="localcrs-add" id="local-crs-add">+ ${_tr("coords.localAdd", "対応点を追加")}</button>
      <div class="localcrs-status"></div>
      <div class="localcrs-note">${_tr("coords.localNote", "公共座標の基準は平面直角座標系（JGD）です。対応点の重心から最寄りの系を自動選択します。")}</div>
      <div class="localcrs-actions"><button type="button" id="local-crs-close">${_tr("coords.localClose", "閉じる")}</button></div>`;
    document.body.append(backdrop, dialog);
    backdrop.addEventListener("click", close);
    dialog.querySelector("#local-crs-close").addEventListener("click", close);
    dialog.querySelector("#local-crs-add").addEventListener("click", () => {
      rows.push({ lat: NaN, lon: NaN, x: NaN, y: NaN });
      renderRows(); renderStatus();
    });
    renderRows(); renderStatus();
  }

  function close() {
    document.querySelectorAll(".localcrs-dialog,.localcrs-backdrop").forEach(el => el.remove());
    dialog = null; pickRow = -1;
  }

  btn.addEventListener("click", open);
  return { open, close };
}
