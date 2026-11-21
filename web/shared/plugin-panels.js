// KASUGAI Canvas — プラグインパネルホスト（エンジン非依存）
//
// プラグインがコントロールパネルへ「ユーザーパネル（タブ＋パネル）」を追加する
// ための共通機構。タブ/パネルの DOM 規約はエンジンで異なるため mode で吸収する:
//
//   mode "sections" — Cesium 型
//     タブ:  <button class="panel-tab" data-panel="<panelId>">
//     パネル: <section id="<panelId>" class="plugin-panel">
//     表示: .active クラスで切替（非表示は display:none）
//   mode "panes" — 2D プレイヤー型（maplibre/openlayers/leaflet/navara）
//     タブ:  <button class="tab" data-tab="<key>">
//     パネル: <div id="pane-<key>" class="tab-pane">
//     表示: hidden 属性で切替（タブは .active）
//
// 生成したタブは汎用ブリッジの列挙属性（data-panel / data-tab）を持つため、
// AI（listUiControls/controlUi）からそのまま操作できる。
//
// 使い方:
//   const host = createPanelHost({ nav, panels, mode: "sections" });
//   attachPanelApi(window.kasugaiApi, host);
//   → api.registerPanel({ id, title, icon?, after?, onInit?, onShow?, onHide? }, pluginId)
//     api.unregisterPanel(idOrKey, pluginId?) / api.selectPanel(idOrKey)
//     api.listPanels() / api.removePluginPanels(owner)
//
// 表示状態は MutationObserver で追跡するため、組み込みタブ経由の切替でも
// onShow/onHide が正しく発火する。

import { t } from "./i18n.js";

function sanitizeKeyPart(s) {
  return String(s || "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createPanelHost({ nav, panels, mode = "sections" } = {}) {
  if (!nav || !panels) {
    console.warn("[plugin-panels] nav/panels が見つかりません。パネル機能は無効です。");
    return {
      register: () => null, unregister: () => false, select: () => false,
      list: () => [], removeByOwner: () => 0, active: () => null,
    };
  }

  const isPanes = mode === "panes";
  const tabClass = isPanes ? "tab" : "panel-tab";
  const tabAttr = isPanes ? "tab" : "panel";            // dataset キー
  const panelTag = isPanes ? "div" : "section";
  const panelClass = isPanes ? "tab-pane" : "plugin-panel";
  const panelDomId = key => (isPanes ? `pane-${key}` : key);
  const isVisible = el => (isPanes ? !el.hidden : el.classList.contains("active"));
  const setVisible = (el, on) => {
    if (isPanes) el.hidden = !on; else el.classList.toggle("active", on);
  };

  const entries = new Map(); // key -> { key,id,title,owner,spec,tab,panel,_visible }
  // プラグインタブと同名に改称された組み込みタブ（el -> 元の表示情報）
  const renamedTabs = new Map();
  let serial = 0;

  // プラグインタブの表示名が組み込みタブと重複する場合、組み込み側を
  // 「システムレイヤ」等のシステム名に改称して区別する。
  // 重複が全て解消（unregister）されると元の表示へ自動復元する。
  function updateBuiltinTabTitles() {
    const titles = new Set();
    for (const e of entries.values()) titles.add(e.title);
    nav.querySelectorAll(`[data-${tabAttr}]`).forEach(el => {
      if (el.classList.contains("plugin-provided-tab")) return;
      const orig = renamedTabs.get(el);
      const base = orig ? orig.text.trim() : el.textContent.trim();
      if (!titles.has(base)) {
        if (orig) {
          if (orig.i18n != null) el.dataset.i18n = orig.i18n;
          else delete el.dataset.i18n;
          el.textContent = orig.text;
          renamedTabs.delete(el);
        }
        return;
      }
      if (orig) return;
      renamedTabs.set(el, { text: el.textContent, i18n: el.dataset.i18n ?? null });
      // "<i18nキー>.system" があればそれを使い、無ければ汎用プレフィックスを前置
      const sysKey = el.dataset.i18n ? `${el.dataset.i18n}.system` : "";
      if (sysKey && t(sysKey) !== sysKey) {
        el.dataset.i18n = sysKey;
        el.textContent = t(sysKey);
      } else {
        delete el.dataset.i18n;
        el.textContent = `${t("tab.systemPrefix")}${base}`;
      }
    });
  }

  function nextKey(owner, id) {
    const base = `pugp-${sanitizeKeyPart(owner) || "x"}-${sanitizeKeyPart(id) || `p${++serial}`}`;
    return entries.has(base) ? `${base}-${++serial}` : base;
  }

  function resolve(keyOrId, owner = "") {
    if (!keyOrId) return null;
    if (entries.has(keyOrId)) return keyOrId;
    for (const [key, e] of entries) {
      if (e.id === keyOrId && (!owner || e.owner === owner)) return key;
    }
    // panes モードで pane- 付き id が渡された場合も解決する
    const stripped = String(keyOrId).replace(/^pane-/, "");
    if (entries.has(stripped)) return stripped;
    return null;
  }

  // タブ選択。プラグインタブ自身のクリック以外（組み込みタブ・AI・API）で
  // 切り替わっても整合するよう、対象コンテナ内の全タブ/全パネルを走査する
  function select(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    const targetId = panelDomId(key);
    nav.querySelectorAll(`[data-${tabAttr}]`).forEach(el => {
      el.classList.toggle("active", el.dataset[tabAttr] === key);
    });
    panels.querySelectorAll(`.${panelClass}`).forEach(el => {
      setVisible(el, el.id === targetId);
    });
    return true;
  }

  function active() {
    for (const [key, e] of entries) if (e._visible) return key;
    return null;
  }

  function register(spec = {}, owner = "") {
    const key = nextKey(owner, spec.id);
    const title = String(spec.title || spec.id || key);

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `${tabClass} plugin-provided-tab`;
    tab.dataset[tabAttr] = key;
    tab.title = spec.tooltip || title;
    tab.setAttribute("aria-label", spec.tooltip || title);
    if (spec.icon) {
      const ic = document.createElement("span");
      ic.className = "plugin-tab-icon";
      ic.textContent = `${spec.icon} `;
      tab.append(ic);
    }
    const label = document.createElement("span");
    label.textContent = title;
    tab.append(label);

    const panel = document.createElement(panelTag);
    panel.id = panelDomId(key);
    panel.className = `${panelClass} plugin-provided-panel`;
    if (isPanes) panel.hidden = true;

    const entry = { key, id: spec.id || "", title, owner, spec, tab, panel, _visible: false };
    panel.__panelEntry = entry;

    // spec.before/spec.after: 挿入位置（組み込みタブの data- 属性値 or
    // プラグインの key）。before 優先、after はそのタブの直後
    const tabs = [...nav.querySelectorAll(`[data-${tabAttr}]`)];
    const beforeTab = spec.before
      ? tabs.find(el => el.dataset[tabAttr] === spec.before)
      : null;
    const afterTab = !beforeTab && spec.after
      ? tabs.find(el => el.dataset[tabAttr] === spec.after)
      : null;
    if (beforeTab) nav.insertBefore(tab, beforeTab);
    else if (afterTab?.nextSibling) nav.insertBefore(tab, afterTab.nextSibling);
    else nav.appendChild(tab);
    // #engines 等のフッター要素がある場合はその直前へ挿し、
    // 組み込みパネルと同じ「フッターが最下部」の構成を維持する
    const tail = panels.querySelector("#engines");
    if (tail) panels.insertBefore(panel, tail);
    else panels.appendChild(panel);

    entries.set(key, entry);
    tab.addEventListener("click", () => select(key));
    try { spec.onInit?.(panel, entry); } catch (e) { console.error(`[plugin-panels] onInit 失敗: ${key}`, e); }
    updateBuiltinTabTitles();
    // 組み込みタブと同名で改称が発生した場合、そのプラグインタブが
    // 組み込みの代替なので初期表示もそちらへ切り替える
    for (const [, orig] of renamedTabs) {
      if (orig.text.trim() === title) { select(key); break; }
    }
    return entry;
  }

  function unregister(keyOrId, owner = "") {
    const key = resolve(keyOrId, owner);
    const entry = key && entries.get(key);
    if (!entry) return false;
    const wasVisible = entry._visible;
    if (wasVisible && entry.spec?.onHide) {
      try { entry.spec.onHide(entry.panel, entry); } catch (e) { console.error(e); }
    }
    entry.tab.remove();
    entry.panel.remove();
    entries.delete(key);
    // 表示中パネルを消した場合は先頭の組み込みタブへ戻す
    if (wasVisible) {
      const firstTab = nav.querySelector(`[data-${tabAttr}]`);
      if (firstTab) select(firstTab.dataset[tabAttr]);
    }
    updateBuiltinTabTitles();
    return true;
  }

  function removeByOwner(owner) {
    let n = 0;
    for (const [key, e] of [...entries]) {
      if (e.owner === owner && unregister(key)) n++;
    }
    return n;
  }

  function list() {
    return [...entries.values()].map(e => ({
      key: e.key, id: e.id, title: e.title, owner: e.owner, visible: e._visible,
    }));
  }

  // 表示切替の検知。class/hidden の変化を監視し、プラグイン提供パネルの
  // 可視状態が実際に変わったときだけ onShow/onHide を発火する
  const observer = new MutationObserver(records => {
    for (const rec of records) {
      const el = rec.target;
      const entry = el.__panelEntry;
      if (!entry) continue;
      const vis = isVisible(el);
      if (vis === entry._visible) continue;
      entry._visible = vis;
      const hook = vis ? entry.spec?.onShow : entry.spec?.onHide;
      if (hook) { try { hook(el, entry); } catch (e) { console.error(`[plugin-panels] ${entry.key} のフック失敗`, e); } }
    }
  });
  observer.observe(panels, { attributes: true, attributeFilter: ["class", "hidden"], subtree: true });

  return { register, unregister, select, list, active, removeByOwner, resolve };
}

// kasugaiApi へパネル系メソッドを取り付ける。
// registerPanel(spec, pluginId) は戻り値 { key, tab, panel }。
// プラグインからは plugin-loader が pluginId をスタンプした scoped api 経由で呼ばれる。
export function attachPanelApi(api, host) {
  if (!api || !host) return api;
  api.registerPanel = (spec = {}, pluginId = "") => {
    const entry = host.register(spec, pluginId || spec.owner || "");
    return entry ? { key: entry.key, tab: entry.tab, panel: entry.panel } : null;
  };
  api.unregisterPanel = (keyOrId, pluginId = "") => host.unregister(keyOrId, pluginId);
  api.selectPanel = (keyOrId, pluginId = "") => {
    const key = host.resolve(keyOrId, pluginId);
    return key ? host.select(key) : false;
  };
  api.listPanels = () => host.list();
  api.removePluginPanels = owner => host.removeByOwner(owner);
  return api;
}
