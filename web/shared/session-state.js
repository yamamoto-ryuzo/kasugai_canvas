// KASUGAI Canvas — カレント状態ファイル（エンジン共通・Cesium 規約）
//
// 「現在地」を失わずにエンジン間を遷移するための共有状態。
// 稼働中のエンジンが自身の状態を Cesium 規約に正規化して常時書き込み、
// 切替先エンジンは起動時にこれを読んで復元する。
//
// 正典スキーマ（localStorage "kasugai:session-state"）:
//   {
//     v: 1, engine, at,
//     project, kasc,                 // 書込み時点の URL 識別子（復元は同一プロジェクトのみ）
//     camera: { latitude, longitude, zoom, height, pitch, heading },  // URL ハッシュと同じ Cesium 規約
//     inspector,                     // 現在の .kasc テキスト（ファイル初期値ではなく現在値）
//     theme,                         // #theme-select の値
//     basemap: { id, title },        // 選択中のベースマップ（title は item.title 正典）
//     vis: { "完全タイトル": bool }, // レイヤ可視性（kasugaiApi.listLayers の title キー）
//   }
//
// 「初期表示」の定義: 鮮度(TTL)内の一致セッションが無い起動。
// その場合は .kasc の初期値で描画する（このモジュールは null を返し、
// 各エンジンは従来通りファイル内容を使う）。
//
// 命名規則（2段ルール）:
//   - ルート直下の無印フィールド = Cesium 規約の正典値のみ置く
//   - 規約・単位が異なる別表現の値は `x-` プレフィックス（例: x-zoomNative）
//   - エンジン固有情報は `engines.<id>` 名前空間へ隔離する（例: engines.navara.fx）
// 将来の拡張フィールドはこの規則に従い v を据え置いて追加する

import { parseUrlView, hasUrlView, splitKascTitle, heightToViewZoom } from "./kasc.js";

const KEY = "kasugai:session-state";
const TTL = 120000; // セッションを「生きている」とみなす鮮度。切替・リロード直後のみ引き継ぐ

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
const leafOf = t => String(t ?? "").split("/").map(s => s.trim()).pop();

// ---- 読み書き ----

// 保存済みカレント状態を返す。壊れていれば null
export function readSessionState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const st = JSON.parse(raw);
    return st && st.v === 1 ? st : null;
  } catch (_) { return null; }
}

// 部分更新。engine/project/kasc/at は自動補完する
export function patchSessionState(patch, engine) {
  try {
    const prev = readSessionState() || {};
    const params = new URLSearchParams(window.location.search);
    const st = {
      ...prev, v: 1, at: Date.now(),
      engine: engine ?? prev.engine ?? null,
      project: params.get("project") || null,
      kasc: params.get("kasc") || null,
      ...patch,
    };
    localStorage.setItem(KEY, JSON.stringify(st));
    return st;
  } catch (_) { return null; }
}

// 起動時判定: 同一プロジェクト(?project=/?kasc= が一致)かつ鮮度内なら
// 遷移・継続セッションとしてカレント状態を返す。不一致・古いものは
// 「初期表示」とみなして null（呼び出し側は .kasc 初期値を使う）。
// 読み取りで消去しない — カレントファイルは常駐し、稼働エンジンが上書きしていく
export function matchSessionState() {
  const st = readSessionState();
  if (!st || Date.now() - Number(st.at || 0) > TTL) return null;
  const params = new URLSearchParams(window.location.search);
  if ((st.kasc || null) !== (params.get("kasc") || null)) return null;
  if ((st.project || null) !== (params.get("project") || null)) return null;
  return st;
}

// ---- 書き込み側（現在値の反映） ----

// 現在のエンジン状態を採取してパッチを返す(書き込みはしない)。
// ソースは kasugaiApi（listLayers/listBasemaps/getViewInfo/getCamera/
// getInspectorText）と #inspector-input/#theme-select の DOM で、
// エンジン非依存に動く。getViewInfo は pitchDeg(直下=0)、getCamera は
// Cesium 規約の pitch を返すため、正典は pitch(直下=-90) へ揃える
function collectSessionPatch() {
  const api = window.kasugaiApi;
  const patch = {};

  const layers = api?.listLayers?.();
  if (Array.isArray(layers)) {
    // 可視性キーは完全タイトル("グループ/名前")へ正規化する。
    // sourceTitle(.kasc 元タイトル)があればそれが正典 — "//"(排他グループ)を
    // 保持しないと通常/排他の同名レイヤ("A/B"と"A//B")が1キーに潰れる。
    // 無い場合は title に "/" があれば完全形とみなし、葉名+group 別
    // フィールド形式は結合する
    const fullKey = l => {
      const t = String(l.sourceTitle || l.title || "");
      if (t.includes("/") || t.includes("\\")) return t;
      const g = String(l.group || "").split("/").map(s => s.trim()).filter(Boolean).join("/");
      return g ? `${g}/${t}` : t;
    };
    // 完全タイトルが完全に重複するレイヤは区別不能のため OR で併合する
    // (どれか1つでも表示なら表示として記録。last-write だと表示中の
    //  レイヤが同名の非表示レイヤに上書きされて引継ぎで消える)
    patch.vis = {};
    for (const l of layers) {
      const k = fullKey(l);
      patch.vis[k] = !!patch.vis[k] || !!l.visible;
    }
  }

  const insp = api?.getInspectorText?.() ?? document.querySelector("#inspector-input")?.value;
  if (typeof insp === "string" && insp) patch.inspector = insp;

  const themeSel = document.querySelector("#theme-select");
  if (themeSel) patch.theme = themeSel.value || null;

  const bases = api?.listBasemaps?.();
  const sel = Array.isArray(bases) ? bases.find(b => b.selected) : null;
  if (sel) patch.basemap = { id: sel.id, title: sel.title };

  // カメラは正典化済みの URL ハッシュを優先し、欠けた分だけ
  // getViewInfo(pitchDeg系)/getCamera(Cesium pitch系)で補う
  // (エンジン固有 zoom — MapLibre 512px基準等 — が正典へ紛れ込むのを防ぐ。
  //  正典ハッシュは zoom を持たないため、zoom は正典 height から camToZoom で導出する)
  const hv = parseUrlView();
  const c = api?.getViewInfo?.() || api?.getCamera?.();
  const camHeight = num(hv.height) ?? num(c?.height);
  const camLatitude = num(hv.latitude) ?? num(c?.latitude);
  const cam = {
    latitude: camLatitude,
    longitude: num(hv.longitude) ?? num(c?.longitude),
    zoom: num(hv.zoom)
      ?? (camHeight != null && camLatitude != null ? heightToViewZoom(camLatitude, camHeight, 512) : undefined),
    height: camHeight,
    heading: num(hv.heading) ?? num(c?.heading),
    pitch: num(hv.pitch) ?? (num(c?.pitch) ?? (num(c?.pitchDeg) != null ? num(c.pitchDeg) - 90 : undefined)),
  };
  if (Object.values(cam).some(v => v !== undefined)) {
    patch.camera = Object.fromEntries(Object.entries(cam).filter(([, v]) => v !== undefined));
  }

  return patch;
}

// 現在の状態をまるごと採取してカレントファイルへ即時反映する。
// 切替リンク押下直前の最新化など「この時点の完全な現在値」が必要な場面用
export function snapshotSessionState(engine) {
  return patchSessionState(collectSessionPatch(), engine);
}

// session-state は「同期対象」ではなくエンジンの内部データそのもの
// (現在値の正典)。定期採取・ポーリングは行わず、状態変化のイベントが
// 起きた時点でだけ正典へ反映する(write-through)。
// 変化の検知面(エンジン非依存):
//   - DOM の input/change 捕捉: インスペクタ編集・テーマ/ベースマップ選択・
//     レイヤ可視性チェック等の UI 起因変更
//   - history.replaceState フック: 全エンジンがカメラ移動時に正典ハッシュを
//     書く共通経路(replaceState は hashchange を発火させないため横取りする)
//   - kasugaiApi メソッド呼出し: AI ツール等 API 経路の変更も拾う
// 反映は連続イベントを束ねる debounce と内容差分ガードで行い、
// 無変化なら localStorage を書かない。戻り値は停止関数
export function bindSessionState(engine) {
  let lastJson = null;
  let timer = 0;
  const flush = () => {
    const patch = collectSessionPatch();
    if (!Object.keys(patch).length) return;
    const json = JSON.stringify(patch);
    if (json === lastJson) return;             // 無変化 → 書き込まない
    lastJson = json;
    patchSessionState(patch, engine);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 120); };

  document.addEventListener("input", schedule, true);
  document.addEventListener("change", schedule, true);

  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    schedule();
    return r;
  };

  const api = window.kasugaiApi;
  const SKIP = new Set(["emit", "on", "off", "once", "addEventListener", "removeEventListener"]);
  if (api && !api.__sessionBound) {
    try {
      Object.defineProperty(api, "__sessionBound", { value: true });
      for (const k of Object.keys(api)) {
        const fn = api[k];
        if (typeof fn !== "function" || SKIP.has(k)) continue;
        api[k] = function (...args) {
          const r = fn.apply(this, args);
          Promise.resolve(r).finally(schedule);
          return r;
        };
      }
    } catch (_) {}
  }

  window.addEventListener("pagehide", flush);
  const onVis = () => { if (document.hidden) flush(); };
  document.addEventListener("visibilitychange", onVis);
  flush();                              // 起動時に現在値を構築
  setTimeout(flush, 1500);              // 遅延ロード分の追い付き(1回のみ)
  return () => {
    clearTimeout(timer);
    document.removeEventListener("input", schedule, true);
    document.removeEventListener("change", schedule, true);
    history.replaceState = origReplace;
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVis);
  };
}

// ---- 読み取り側（復元ヘルパー） ----

// vis マップ照合: 完全タイトル → 葉名(一意のみ) の2段。
// 戻り値は適用すべき [{entry, on}]（現状と異なるものだけ）。
// entries の既定形状は {item:{title,visible}}（maplibre/ol/leaflet/navara）。
// cesium のように別形状の場合は getTitle/getVisible を渡す
export function sessionVisChanges(entries, vis, getTitle = e => e.item?.title, getVisible = e => e.item?.visible !== false) {
  if (!vis || typeof vis !== "object") return [];
  const want = Array.isArray(vis)
    ? vis.map(v => [v.t, !!v.v])                 // 旧 [{t,v}] 形も受ける
    : Object.entries(vis).map(([t, v]) => [t, !!v]);
  if (!want.length) return [];
  // 完全タイトル一致は同名重複を全件保持する（書込み側の OR 併合と対称）
  const exact = new Map();
  for (const e of entries) {
    const k = getTitle(e);
    const m = exact.get(k);
    if (!m) exact.set(k, e);
    else if (Array.isArray(m)) m.push(e);
    else exact.set(k, [m, e]);
  }
  const byLeaf = new Map();
  for (const e of entries) {
    const k = leafOf(getTitle(e));
    byLeaf.set(k, byLeaf.has(k) ? null : e);
  }
  const out = [];
  for (const [title, on] of want) {
    const m = exact.get(title);
    const targets = m ? (Array.isArray(m) ? m : [m]) : (byLeaf.get(leafOf(title)) ? [byLeaf.get(leafOf(title))] : []);
    for (const e of targets) {
      if (e && !!getVisible(e) !== on) out.push({ entry: e, on });
    }
  }
  return out;
}

// テーマ選択を <select> へ反映（存在する値のみ。change は発火しない —
// 可視性自体は vis マップが担う）
export function applySessionTheme(select, name) {
  if (name && select && [...select.options].some(o => o.value === name)) {
    select.value = name;
    return true;
  }
  return false;
}

// ベースマップ選択を復元。まず kasugaiApi.setBasemap（none/transparent
// 等の疑似項目を扱える）へ委譲し、API 未生成や不一致なら
// #basemap-select の option を直接選んで change を発火する
export function applySessionBasemap(bm) {
  if (!bm) return false;
  const api = window.kasugaiApi;
  try {
    if (bm.id != null && api?.setBasemap?.(bm.id)) return true;
    if (bm.title && api?.setBasemap?.(bm.title)) return true;
  } catch (_) {}
  const sel = document.querySelector("#basemap-select");
  if (!sel) return false;
  const leaf = leafOf(bm.title);
  const opt = [...sel.options].find(o =>
    o.value === String(bm.id) || o.textContent === bm.title || (leaf && o.textContent === leaf));
  if (!opt) return false;
  sel.value = opt.value;
  sel.dispatchEvent(new Event("change"));
  return true;
}

// ---- 統一適用エントリ ----

// セッションのレイヤ関連（vis・theme・basemap）をエンジンへ一括適用する。
// 各エンジンは起動時の初回描画後に一度だけ呼ぶ。フック:
//   entries     : レイヤエントリ配列（形状は getTitle/getVisible で調整）
//   themeSelect : #theme-select 要素
//   setVisible  : (entry, on) => 可視性を実適用するエンジン固有処理
//   rerender    : 変更があった時の行再描画（省略可）
//   getTitle/getVisible: sessionVisChanges へ渡すアクセサ（既定 {item:{title,visible}}）
export function applySessionState(st, { entries, themeSelect, setVisible, rerender, getTitle = e => e.item?.title, getVisible = e => e.item?.visible !== false }) {
  if (!st) return false;
  let changed = false;
  const grpOf = e => { const sp = splitKascTitle(getTitle(e)); return `${sp.group}|${sp.exclusiveGroup}`; };
  const isExcl = e => splitKascTitle(getTitle(e)).exclusiveGroup;
  for (const { entry, on } of sessionVisChanges(entries, st.vis, getTitle, getVisible)) {
    setVisible(entry, on);
    // 排他グループ(//)のメンバーをONにしたら兄弟はOFFに揃える
    // （排他=同時1つの正典。vis 書込み側で兄弟ONが残っていてもここで正す）
    if (on && isExcl(entry)) {
      const g = grpOf(entry);
      for (const sib of entries) {
        if (sib !== entry && grpOf(sib) === g && getVisible(sib)) setVisible(sib, false);
      }
    }
    changed = true;
  }
  if (changed) rerender?.();
  applySessionTheme(themeSelect, st.theme);
  applySessionBasemap(st.basemap);
  return true;
}

// 起動時のビュー解決: URL ハッシュ > セッション camera > null。
// 返す形は parseUrlView と同じ（欠けた値は NaN）
export function sessionBootView(st) {
  const uv = parseUrlView();
  if (hasUrlView(uv)) return uv;
  const c = st?.camera;
  if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
    return {
      latitude: c.latitude, longitude: c.longitude,
      zoom: num(c.zoom) ?? NaN, height: num(c.height) ?? NaN,
      pitch: num(c.pitch) ?? NaN, heading: num(c.heading) ?? NaN,
    };
  }
  return uv;
}
