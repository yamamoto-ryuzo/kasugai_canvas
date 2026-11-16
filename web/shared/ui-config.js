// KASUGAI Canvas — UI カスタマイズ (shared/ui-config.js)
//
// index.html と同じフォルダに `ui.config.json` を置くと、起動時の
// 初期状態としてパネル機能の表示/非表示とコントロール初期値を
// カスタマイズできる。ファイルが無い場合(404)は何もしない。
// JSON は // ・/* */ コメントと末尾カンマを許容する。
//
//   {
//     // 非表示にする機能。機能名または CSS セレクタで指定
//     "hide": ["attr", "tools:los", "manage:gmaps", "chat", "#help-open"],
//     // コントロールの初期値(id → 値)。checkbox は true/false
//     "defaults": { "terrain-toggle": false, "dem-source": "gsi5m" },
//     "helpUrl": "https://example.com/help/"   ← ?(ヘルプ)ボタンのリンク先上書き
//     // 起動時に開くタブ(機能名)
//     "open": "search"
//   }
//
// hide の機能名はエンジン別のタブ命名規則を総当たりで解決する:
//   プレフィックスなし … パネルタブ(レイヤ/凡例/検索/属性/カメラ/表示/情報)
//                       + 同名のサブタブ・管理タブ・任意要素(#名前)
//   tools:<名>          … ツールドック (tools-<名>-panel)
//   display:<名>        … 表示タブ内サブタブ (display-<名>-panel)
//   settings:<名>       … 任意のサブタブ (data-settings-panel)
//   manage:<名>         … 管理ウィンドウの大分類 (manage-<名> / data-settab)
//   managesub:<名>      … 管理ウィンドウ内サブタブ (data-manage-sub)
//   chat / portal / engines … AIチャット・ポータル・エンジン切替の固定名
//   #id / .class / <要素id> … CSS セレクタまたは要素 id 直指定
//                             (time-bar, tools-dock, help-open 等)
// タブを隠すと対応パネルも隠し、アクティブだった場合は先頭の
// 表示タブへ繰り上げる。適用は起動時の1回のみ(後から動的に
// 追加される要素は対象外)。

const DEFAULT_CONFIG_URL = "./ui.config.json";

// auth-selector.js と同じく // ・/* */ コメントを許容する。
// 文字列リテラル内の // /* (URL 値等)は除去対象外とし、
// ユーザーが手編集するファイルのため末尾カンマも取り除いて寛容に読む
function stripJsonComments(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // for 側の i++ で '/' も越える
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function loadUiConfig(url = DEFAULT_CONFIG_URL) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return {};
    const cfg = JSON.parse(stripJsonComments(await res.text()));
    return cfg && typeof cfg === "object" && cfg ? cfg : {};
  } catch (e) {
    console.warn("[ui-config] ui.config.json の読み込みに失敗しました:", e);
    return {};
  }
}

// ---- hide 指定 → CSS セレクタ群 ----

const PREFIXED_SELECTORS = {
  tab: n => [`[data-panel="${n}-panel"]`, `[data-tab="${n}"]`, `#${n}-panel`, `#pane-${n}`],
  tools: n => [`[data-settings-panel="tools-${n}-panel"]`, `#tools-${n}-panel`],
  display: n => [`[data-settings-panel="display-${n}-panel"]`, `#display-${n}-panel`],
  settings: n => [`[data-settings-panel="${n}-panel"]`, `[data-settings-panel="${n}"]`, `#${n}-panel`, `#${n}`],
  manage: n => [`[data-manage-pane="manage-${n}"]`, `[data-settab="${n}"]`, `#manage-${n}`, `#setpane-${n}`],
  managesub: n => [`[data-manage-sub="${n}-panel"]`, `[data-manage-sub="${n}"]`, `#${n}-panel`],
  sub: n => [`[data-manage-sub="${n}-panel"]`, `[data-manage-sub="${n}"]`, `#${n}-panel`],
};

// 機能名そのまま使える固定名(タブ規約に載らないUI部品)
const BARE_SELECTORS = {
  chat: ["#chat-panel", "#ai-section"],
  portal: ["#portal-open", "#portal-overlay"],
  engines: ["#engines"],
};

// プレフィックスなしの機能名はタブ/サブタブ/管理タブ/要素 id を総当たりで解決
function genericSelectors(n) {
  return [
    `[data-panel="${n}-panel"]`, `[data-tab="${n}"]`,
    `[data-settings-panel="${n}-panel"]`, `[data-manage-pane="manage-${n}"]`,
    `[data-manage-sub="${n}-panel"]`, `[data-settab="${n}"]`,
    `#${n}-panel`, `#pane-${n}`, `#${n}`,
  ];
}

function selectorsFor(spec) {
  const s = String(spec ?? "").trim();
  if (!s) return [];
  // #id / .class / [attr] / 複合セレクタはそのまま使う
  if (/^[#.\[: >+~*]/.test(s)) return [s];
  const m = /^([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(s);
  if (m) {
    const builder = PREFIXED_SELECTORS[m[1].toLowerCase()];
    if (builder) return builder(m[2].trim());
    return [s]; // 未知プレフィックスはセレクタとして解釈を試みる
  }
  const bare = BARE_SELECTORS[s.toLowerCase()];
  if (bare) return bare;
  // 命名規約に載らない複合セレクタ指定("nav > .x" 等)のため、
  // 最後に生の文字列もセレクタとして試す
  return [...genericSelectors(s), s];
}

export function resolveTargets(spec, root = document) {
  const out = new Set();
  for (const sel of selectorsFor(spec)) {
    try {
      root.querySelectorAll(sel).forEach(el => out.add(el));
    } catch (e) {
      console.warn(`[ui-config] 不正なセレクタをスキップ: ${sel}`);
    }
  }
  return [...out];
}

// ---- タブ・パネル切替 ----
// cesium 系: [data-panel]/[data-settings-panel]/[data-manage-pane]/[data-manage-sub]
//            → パネルは .active クラスで表示
// 2D 系:     [data-tab](→ #pane-*) / [data-settab](→ #setpane-*)
//            → パネルは hidden 属性で表示
// 両規約を DOM の実態(class)で判別して扱う

function tabPanelId(tab) {
  const d = tab.dataset || {};
  if (d.panel) return d.panel;
  if (d.tab) return `pane-${d.tab}`;
  if (d.settingsPanel) return d.settingsPanel;
  if (d.managePane) return d.managePane;
  if (d.manageSub) return d.manageSub;
  if (d.settab) return `setpane-${d.settab}`;
  return "";
}
const isTabLike = el => !!tabPanelId(el);
const linkedPanel = tab => document.getElementById(tabPanelId(tab));

function panelIsOpen(panel) {
  const cls = panel.classList;
  if (cls.contains("tab-pane") || cls.contains("set-pane") || cls.contains("display-subpane")) return !panel.hidden;
  return cls.contains("active");
}

function setPanelOpen(panel, on) {
  const cls = panel.classList;
  if (cls.contains("tab-pane") || cls.contains("set-pane") || cls.contains("display-subpane")) {
    panel.hidden = !on;
  } else {
    cls.toggle("active", on);
  }
}

// ハンドラ非依存のタブ切替(click ではなく DOM 直接操作。
// ツールドックのドロップダウン型タブを誤って開かないため)
function activateTab(tab) {
  const panel = linkedPanel(tab);
  for (const sib of tab.parentElement?.children || []) {
    if (sib === tab || !isTabLike(sib)) continue;
    sib.classList.remove("active");
    const p = linkedPanel(sib);
    if (p) setPanelOpen(p, false);
  }
  tab.classList.add("active");
  if (panel) setPanelOpen(panel, true);
}

// ---- hide 適用 ----

let hiddenStyleEl = null;

// display:flex 等のクラス指定が [hidden] の UA ルールを上書きする要素
// (#chat-panel 等)も確実に隠すため、data 属性ベースの !important ルールを使う
function ensureHiddenStyle() {
  if (hiddenStyleEl || document.getElementById("ui-config-hidden-style")) return;
  hiddenStyleEl = document.createElement("style");
  hiddenStyleEl.id = "ui-config-hidden-style";
  hiddenStyleEl.textContent = '[data-ui-hidden="1"]{display:none!important}';
  document.head.appendChild(hiddenStyleEl);
}

function hideNow(el) {
  ensureHiddenStyle();
  el.hidden = true;
  if (el.dataset) el.dataset.uiHidden = "1";
}

// ---- defaults (コントロール初期値) ----

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return !/^(|false|0|off|no)$/i.test(String(v).trim());
}

function applyDefaultValue(el, value) {
  if (el instanceof HTMLSelectElement) {
    const v = String(value);
    if (![...el.options].some(o => o.value === v)) {
      console.warn(`[ui-config] defaults: #${el.id} に選択肢 "${v}" がありません`);
      return;
    }
    if (el.value === v) return;
    el.value = v;
  } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const v = truthy(value);
    if (el.checked === v) return;
    el.checked = v;
  } else if ("value" in el) {
    const v = String(value);
    if (el.value === v) return;
    el.value = v;
  } else {
    return;
  }
  // 実ユーザー操作と同じ順序(input → change)で発火し、
  // JS 側の状態変数・再描画ハンドラへ値を同期させる
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ---- 適用本体 ----

export function applyUiConfig(cfg = {}) {
  const hideSpecs = Array.isArray(cfg.hide) ? cfg.hide : (cfg.hide ? [cfg.hide] : []);

  // 1) 非表示: タブと対応パネルをまとめて隠す
  const targets = new Set();
  for (const spec of hideSpecs) {
    for (const el of resolveTargets(spec)) {
      targets.add(el);
      if (isTabLike(el)) {
        const p = linkedPanel(el);
        if (p) targets.add(p);
      }
    }
  }
  // 隠す前に「開いていたタブ」を記録(表示繰り上げのため)
  const reopenScopes = new Set();
  for (const el of targets) {
    if (!isTabLike(el)) continue;
    const p = linkedPanel(el);
    if (el.classList.contains("active") || (p && panelIsOpen(p))) reopenScopes.add(el.parentElement);
  }
  for (const el of targets) hideNow(el);
  for (const scope of reopenScopes) {
    const next = [...(scope?.children || [])].find(c => isTabLike(c) && !c.hidden && !targets.has(c));
    if (next) activateTab(next);
  }

  // 2) コントロール初期値(ユーザー操作と同じイベントで JS 側状態へ同期)
  for (const [id, value] of Object.entries(cfg.defaults || {})) {
    const el = document.getElementById(id);
    if (!el) { console.warn(`[ui-config] defaults: #${id} が見つかりません`); continue; }
    try { applyDefaultValue(el, value); } catch (e) { console.warn(`[ui-config] defaults: #${id}`, e); }
  }

  // 3) ヘルプボタンのリンク先
  if (typeof cfg.helpUrl === "string" && cfg.helpUrl.trim()) {
    for (const a of document.querySelectorAll("a#help-open")) a.href = cfg.helpUrl.trim();
  }

  // 4) 起動時に開くタブ
  if (cfg.open) {
    const tab = resolveTargets(cfg.open).find(el => isTabLike(el) && !el.hidden);
    if (tab) activateTab(tab);
    else console.warn(`[ui-config] open: "${cfg.open}" に一致するタブがありません`);
  }
}

export async function initUiConfig(url = DEFAULT_CONFIG_URL) {
  const cfg = await loadUiConfig(url);
  if (Object.keys(cfg).length) applyUiConfig(cfg);
  return cfg;
}
