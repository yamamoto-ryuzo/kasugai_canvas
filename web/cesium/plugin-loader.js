// プラグインのカタログと有効化状態を管理するローダー。
//
// web/plugins.json は「利用可能な同梱プラグイン」のカタログであり、
// 既定では自動ロードしない。ロードされるのは以下のいずれか:
//   1. .kasc（インスペクタ）の plugin: 行で宣言されたプラグイン
//      （inspector-plugins-changed 経由。プロジェクトスコープで起動し、
//        行の削除・プロジェクト切替でレイヤー除去＋dispose する）
//   2. plugins.json で "auto": true を明示したエントリ（全プロジェクトで常駐）
//   3. 管理タブで有効化された IndexedDB ストレージプラグイン
//
// inspector(plugin:行)で起動したプラグインにはプロジェクトスコープの API を渡し、
// registerPluginLayer の scope を強制的に "project" にする。

import { confirmPluginApply } from "../shared/ai-chat.js";

const bundledCatalog = new Map(); // id -> manifest
// 起動中プラグイン。signature が変わったら再起動（オプション変更・スコープ切替）
const activePlugins = new Map();  // id -> { source:"auto"|"inspector"|"storage", signature }

// プラグインへ渡すスコープ付き API。全プラグインへ pluginId をスタンプし、
// registerPanel/unregisterPanel の所有者を自動付与する（unregisterPlugin で
// パネルが自動撤去される）。projectScope 時は registerPluginLayer で
// scope:"project" を強制し、プロジェクト切替時に本体側がレイヤーを自動除去する
function pluginScopedApi(api, pluginId, projectScope, panelDefaults = {}) {
  const scoped = Object.create(api);
  scoped.pluginId = pluginId;
  scoped.registerPanel = (spec = {}) => api.registerPanel?.(
    { ...(panelDefaults.before != null ? { before: panelDefaults.before } : {}),
      ...(panelDefaults.after != null ? { after: panelDefaults.after } : {}), ...spec },
    pluginId,
  );
  scoped.unregisterPanel = (keyOrId) => api.unregisterPanel?.(keyOrId, pluginId);
  scoped.selectPanel = (keyOrId) => api.selectPanel?.(keyOrId, pluginId);
  if (projectScope) {
    scoped.registerPluginLayer = (config = {}, pid) =>
      api.registerPluginLayer({ ...config, scope: "project" }, pid);
  }
  return scoped;
}

async function loadPlugin(manifest, { projectScope = false } = {}) {
  const api = window.kasugaiApi;
  try {
    const url = manifest.url || `./PLUGIN/${manifest.id}/plugin.js`;
    // layer 宣言があるプラグインは本体側でレイヤーを先に登録し、
    // レイヤ一覧・属性検索・表示切替の対象にする
    if (manifest.layer && api?.registerPluginLayer) {
      try {
        const layerConfig = projectScope ? { ...manifest.layer, scope: "project" } : manifest.layer;
        await api.registerPluginLayer(layerConfig, manifest.id || "");
      } catch (error) {
        console.warn(`[plugin-loader] レイヤー登録失敗: ${manifest.id}`, error);
      }
    }
    const module = await import(url);
    const pluginApi = pluginScopedApi(api, manifest.id, projectScope,
      { after: manifest.options?.after, before: manifest.options?.before });
    if (typeof module.init === "function") {
      await module.init(pluginApi, manifest);
    } else if (typeof module.default === "function") {
      await module.default(pluginApi, manifest);
    } else {
      console.warn(`[plugin-loader] エントリポイントが見つかりません: ${manifest.id}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[plugin-loader] 読み込み失敗: ${manifest.id}`, error);
    return false;
  }
}

// プラグインの停止。作ったレイヤーをすべて除去し、registerPlugin で登録された
// meta（dispose があれば呼び出す）を登録解除する。JSモジュール自体はアンロード
// できないため、次回起動時は同じモジュールの init が再実行される
async function deactivatePlugin(id) {
  if (loadedStoragePlugins.has(id)) {
    await unloadStoragePlugin(id);
    return;
  }
  const api = window.kasugaiApi;
  if (api?.removePluginLayer) {
    for (let i = 0; i < 20; i++) {
      if (!(await api.removePluginLayer(id))) break;
    }
  }
  api?.unregisterPlugin?.(id);
}

// ストレージプラグイン（IndexedDB保存・AI生成/ユーザー取込）。
// Blob URL で import する。JSモジュールはアンロードできないため、
// 無効化・更新時は「プラグインが作ったレイヤーを外して再 init する」方式で近似する。
// 完全にクリーンな状態にするにはページ再読み込みが必要
const loadedStoragePlugins = new Map(); // id → blobUrl

async function unloadStoragePlugin(id) {
  const api = window.kasugaiApi;
  if (api?.removePluginLayer) {
    // 同一 pluginId のレイヤーをすべて除去（removePluginLayer は1件ずつ処理する）
    for (let i = 0; i < 20; i++) {
      if (!(await api.removePluginLayer(id))) break;
    }
  }
  api?.unregisterPlugin?.(id);
  const blobUrl = loadedStoragePlugins.get(id);
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    loadedStoragePlugins.delete(id);
  }
}

async function loadStoragePlugin(record, { projectScope = false, options = null } = {}) {
  const api = window.kasugaiApi;
  if (!api || !record?.id) return { ok: false, error: "invalid record" };
  await unloadStoragePlugin(record.id);
  try {
    if (record.layer && api.registerPluginLayer) {
      const layerConfig = projectScope ? { ...record.layer, scope: "project" } : record.layer;
      await api.registerPluginLayer(layerConfig, record.id);
    }
    const blobUrl = URL.createObjectURL(new Blob([record.code || ""], { type: "text/javascript" }));
    const module = await import(blobUrl);
    loadedStoragePlugins.set(record.id, blobUrl);
    const manifest = {
      id: record.id,
      name: record.name,
      version: record.version,
      layer: record.layer,
      storage: true,
    };
    if (record.url) manifest.url = record.url;
    if (options) manifest.options = options;
    const pluginApi = pluginScopedApi(api, manifest.id, projectScope,
      { after: manifest.options?.after, before: manifest.options?.before });
    if (typeof module.init === "function") {
      await module.init(pluginApi, manifest);
    } else if (typeof module.default === "function") {
      await module.default(pluginApi, manifest);
    } else {
      throw new Error("エントリポイント(init/default)がありません");
    }
    await api.setStoragePluginError?.(record.id, "");
    console.log(`[plugin-loader] ストレージプラグイン読込: ${record.id}`);
    return { ok: true };
  } catch (error) {
    console.error(`[plugin-loader] ストレージプラグイン読込失敗: ${record.id}`, error);
    await unloadStoragePlugin(record.id);
    // 失敗理由を保存し、AIの getPluginCode 修正ループと管理画面にフィードバックする
    await api.setStoragePluginError?.(record.id, String(error && error.message || error));
    return { ok: false, error: String(error && error.message || error) };
  }
}

async function loadStoragePluginById(id) {
  const record = await window.kasugaiApi?.getStoragePlugin?.(id);
  if (!record) return { ok: false, error: "plugin not found" };
  if (!record.enabled) return { ok: true, skipped: true };
  const result = await loadStoragePlugin(record);
  if (result.ok) activePlugins.set(id, { source: "storage", signature: "storage" });
  return result;
}

// plugin: id | url=<JS> — .kasc 埋め込みのプラグイン設置場所。
// canvas_data/ 等の相対パスは api.resolveProjectUrl で .kasc 基準へ解決されるため、
// .kasc+canvas_data/+プラグインJS をまとめて配布すれば CDN でも動作する。
// クロスオリジン（共有 .kasc が指す外部ホストのJS）だけ、任意コード実行防止のため
// コードを確認するダイアログを出す（セッション内では同一コードへの承認を記憶）
const approvedInlinePlugins = new Set(); // `${id}|${absoluteUrl}|${codeHash}`

function hashInlineCode(code) {
  let hash = 5381;
  for (let i = 0; i < code.length; i++) hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

async function loadUrlPlugin(spec) {
  const api = window.kasugaiApi;
  const id = spec?.id;
  if (!api || !id || !spec.url) return false;
  const resolved = api.resolveProjectUrl?.(spec.url) || spec.url;
  const absolute = new URL(resolved, window.location.href).href;
  let code = "";
  try {
    const response = await fetch(absolute, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    code = await response.text();
  } catch (error) {
    console.warn(`[plugin-loader] plugin: url= の取得失敗 "${id}": ${absolute}`, error);
    return false;
  }
  if (new URL(absolute).origin !== window.location.origin) {
    const key = `${id}|${absolute}|${hashInlineCode(code)}`;
    if (!approvedInlinePlugins.has(key)) {
      const ok = await confirmPluginApply({ id, name: spec.options?.name || absolute, code });
      if (!ok) {
        console.warn(`[plugin-loader] plugin: url= がユーザーに拒否されました "${id}"`);
        return false;
      }
      approvedInlinePlugins.add(key);
    }
  }
  const result = await loadStoragePlugin(
    { id, name: spec.options?.name || id, code, url: absolute },
    { projectScope: true, options: spec.options || null },
  );
  return !!result?.ok;
}

async function activatePlugin(id, want) {
  const api = window.kasugaiApi;
  if (want.source === "auto") {
    const manifest = bundledCatalog.get(id);
    return manifest ? await loadPlugin(manifest) : false;
  }
  if (want.source === "inspector") {
    // url= 指定は .kasc 埋め込みの設置場所指定。明示された場合は
    // カタログ/ストレージより優先してそのJSを読み込む
    if (want.spec?.url) return await loadUrlPlugin(want.spec);
    // カタログ(plugins.json)優先、無ければストレージプラグインを id で解決する。
    // 外部 URL の直接指定は受け付けない（共有 .kasc による任意コード読み込み防止）
    const catalogManifest = bundledCatalog.get(id);
    if (catalogManifest) {
      const manifest = {
        ...catalogManifest,
        name: want.spec?.options?.name || catalogManifest.name,
        options: { ...(catalogManifest.options || {}), ...(want.spec?.options || {}) },
        inspector: true,
      };
      return await loadPlugin(manifest, { projectScope: true });
    }
    const record = await api?.getStoragePlugin?.(id).catch(() => null);
    if (record) {
      const named = want.spec?.options?.name ? { ...record, name: want.spec.options.name } : record;
      const result = await loadStoragePlugin(named, { projectScope: true, options: want.spec?.options || null });
      return !!result?.ok;
    }
    console.warn(`[plugin-loader] plugin: 未解決のプラグインID "${id}"`);
    return false;
  }
  if (want.source === "storage") {
    const result = await loadStoragePluginById(id);
    return !!result?.ok;
  }
  return false;
}

// inspector 宣言・auto エントリ・有効なストレージプラグインの「あるべき状態」と
// 起動中プラグインを突き合わせ、差分だけロード/停止する
let reconcileRunning = false;
let reconcileQueued = false;

async function reconcilePlugins() {
  const api = window.kasugaiApi;
  if (!api) return;
  if (reconcileRunning) { reconcileQueued = true; return; }
  reconcileRunning = true;
  try {
    const specs = api.getInspectorPlugins?.() || [];
    const specById = new Map();
    for (const spec of specs) {
      if (spec?.id) specById.set(spec.id, spec);
    }
    const desired = new Map(); // id -> { source, spec?, signature }
    for (const [id, manifest] of bundledCatalog) {
      if (manifest.auto === true || manifest.enabled === true) {
        desired.set(id, { source: "auto", signature: "auto" });
      }
    }
    for (const [id, spec] of specById) {
      if (spec.off) desired.delete(id); // 明示 off は auto/有効ストレージより優先
      else desired.set(id, { source: "inspector", spec, signature: `inspector|${spec.url || ""}|${JSON.stringify(spec.options || {})}` });
    }
    const stored = await api.listStoragePlugins?.().catch(() => []) || [];
    for (const meta of stored) {
      if (!meta?.enabled || !meta.id) continue;
      if (specById.has(meta.id)) continue; // plugin: 行で管理（off 指定での抑制を含む）
      if (!desired.has(meta.id)) desired.set(meta.id, { source: "storage", signature: "storage" });
    }

    for (const [id, active] of [...activePlugins]) {
      const want = desired.get(id);
      if (!want || want.signature !== active.signature) {
        await deactivatePlugin(id);
        activePlugins.delete(id);
      }
    }
    for (const [id, want] of desired) {
      if (activePlugins.has(id)) continue;
      if (await activatePlugin(id, want)) {
        activePlugins.set(id, { source: want.source, signature: want.signature });
      }
    }
  } finally {
    reconcileRunning = false;
    if (reconcileQueued) { reconcileQueued = false; void reconcilePlugins(); }
  }
}

// app.js 側（kasugaiApi.saveStoragePlugin 等）からの再読み込みに使う
window.kasugaiPluginLoader = {
  load: loadStoragePluginById,
  async unload(id) {
    await unloadStoragePlugin(id);
    activePlugins.delete(id);
  },
  catalog() {
    return [...bundledCatalog.values()].map(({ id, name, version, auto }) => ({ id, name, version, auto: !!auto }));
  },
};

async function loadPlugins() {
  const api = window.kasugaiApi;
  try {
    const response = await fetch("./plugins.json", { cache: "no-store" });
    if (!response.ok) {
      console.log("[plugin-loader] plugins.json が見つかりません。同梱プラグインカタログは空です。");
    } else {
      const data = await response.json();
      for (const manifest of data.plugins || []) {
        if (manifest?.id) bundledCatalog.set(manifest.id, manifest);
      }
    }
  } catch (error) {
    console.error("[plugin-loader] プラグインカタログ読み込み失敗", error);
  }

  // inspector(plugin:行)の宣言変更で差分ロード/停止する
  api.on("inspector-plugins-changed", () => void reconcilePlugins());
  // プロジェクト切替では scope:project のプラグインレイヤーが本体側で除去されるため、
  // inspector 起動プラグインは全て再起動対象にする（続投するプラグインもレイヤーが
  // 消えているので init をやり直してレイヤーを張り直す）
  api.on("project-changed", () => {
    for (const active of activePlugins.values()) {
      if (active.source === "inspector") active.signature = "__stale__";
    }
  });
  await reconcilePlugins();

  api.emit("plugins-loaded", { plugins: api.getPlugins() });
}

if (window.kasugaiApi?.isReady) {
  loadPlugins();
} else if (window.kasugaiApi) {
  window.kasugaiApi.on("ready", loadPlugins);
} else {
  window.addEventListener("DOMContentLoaded", () => {
    if (window.kasugaiApi?.isReady) loadPlugins();
    else if (window.kasugaiApi) window.kasugaiApi.on("ready", loadPlugins);
  });
}
