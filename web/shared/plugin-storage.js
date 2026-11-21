// KASUGAI Canvas — ストレージプラグイン（IndexedDB・ブラウザローカル）
//
// ユーザー側設置のプラグイン保存領域と、それを読み込む最小ランタイム。
// 同一オリジンの IndexedDB "kasugai-canvas" の "plugins" ストアを使うため、
// CDN 配信（書き込み不可の PLUGIN/）でも全エンジンで同じ取込済みプラグインを
// 共有できる。レコード形式は cesium app.js 由来:
//   {id, name, version, description, layer, code, enabled, updatedAt, lastError}
//
// 使い方（プレイヤー系エンジン）:
//   installStoragePluginSupport(window.kasugaiApi);
//   → api に listStoragePlugins/getStoragePlugin/saveStoragePlugin/
//     removeStoragePlugin/setStoragePluginEnabled/setStoragePluginError/
//     publishStoragePlugin が追加され、有効なプラグインが自動ロードされる
//
// 読み込みは Blob URL の動的 import。プラグインには pluginId スタンプ済みの
// scoped api を渡す（registerPanel の所有者が自動付与され、unload で撤去）。

import { backendUrl, hasBackendFeature } from "./backend.js";
import { confirmPluginApply } from "./ai-chat.js";

// IndexedDB "kasugai-canvas": handles(保存先フォルダ) / routes(描画ルート) / plugins(プラグイン)
// cesium app.js の openAppDb と同じバージョン・ストア構成に揃える
// （どちらが先に DB を作っても必要なストアが揃うようにするため）
function openAppDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kasugai-canvas", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ["handles", "routes", "plugins"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const pluginStore = {
  async list() {
    try {
      const db = await openAppDb();
      return await new Promise(resolve => {
        const query = db.transaction("plugins", "readonly").objectStore("plugins").getAll();
        query.onsuccess = () => resolve(query.result || []);
        query.onerror = () => resolve([]);
      });
    } catch (e) { return []; }
  },
  async get(id) {
    try {
      const db = await openAppDb();
      return await new Promise(resolve => {
        const query = db.transaction("plugins", "readonly").objectStore("plugins").get(id);
        query.onsuccess = () => resolve(query.result ?? null);
        query.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  },
  async put(record) {
    const db = await openAppDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("plugins", "readwrite");
      tx.objectStore("plugins").put(record, record.id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async remove(id) {
    const db = await openAppDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("plugins", "readwrite");
      tx.objectStore("plugins").delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async setError(id, message) {
    const record = await this.get(id);
    if (!record) return;
    record.lastError = message || "";
    try { await this.put(record); } catch (e) {}
  },
};

// kasugaiApi へストレージプラグイン系メソッドと最小ローダーを取り付ける。
// registerPluginLayer 未対応エンジンでも layer 宣言は無視して init だけ動かす
export function installStoragePluginSupport(api) {
  if (!api) return null;

  const loaded = new Map();      // id -> blobUrl
  const pluginMeta = new Map();  // id -> registerPlugin(meta) で登録されたメタ

  function storageScopedApi(pluginId, panelDefaults = {}) {
    const scoped = Object.create(api);
    scoped.pluginId = pluginId;
    if (api.registerPanel) {
      scoped.registerPanel = (spec = {}) => api.registerPanel(
        { ...(panelDefaults.before != null ? { before: panelDefaults.before } : {}),
          ...(panelDefaults.after != null ? { after: panelDefaults.after } : {}), ...spec },
        pluginId,
      );
      scoped.unregisterPanel = keyOrId => api.unregisterPanel(keyOrId, pluginId);
      scoped.selectPanel = keyOrId => api.selectPanel(keyOrId, pluginId);
    }
    scoped.registerPlugin = meta => { pluginMeta.set(meta?.id || pluginId, meta); };
    scoped.unregisterPlugin = id => {
      const meta = pluginMeta.get(id);
      if (meta) { try { meta.dispose?.(); } catch (e) { console.error(e); } pluginMeta.delete(id); }
    };
    return scoped;
  }

  async function unload(id) {
    const meta = pluginMeta.get(id);
    if (meta) { try { meta.dispose?.(); } catch (e) { console.error(e); } pluginMeta.delete(id); }
    try { api.removePluginPanels?.(id); } catch (e) { /* ignore */ }
    const blobUrl = loaded.get(id);
    if (blobUrl) { URL.revokeObjectURL(blobUrl); loaded.delete(id); }
  }

  async function load(record, options) {
    if (!record?.id) return { ok: false, error: "invalid record" };
    await unload(record.id);
    try {
      const blobUrl = URL.createObjectURL(new Blob([record.code || ""], { type: "text/javascript" }));
      const module = await import(blobUrl);
      loaded.set(record.id, blobUrl);
      const manifest = {
        id: record.id, name: record.name, version: record.version,
        layer: record.layer, storage: true,
      };
      if (record.url) manifest.url = record.url;
      if (options) manifest.options = options;
      const scoped = storageScopedApi(record.id,
        { after: options?.after, before: options?.before });
      if (typeof module.init === "function") {
        await module.init(scoped, manifest);
      } else if (typeof module.default === "function") {
        await module.default(scoped, manifest);
      } else {
        throw new Error("エントリポイント(init/default)がありません");
      }
      await pluginStore.setError(record.id, "");
      console.log(`[storage-plugins] 読込: ${record.id}`);
      return { ok: true };
    } catch (error) {
      console.error(`[storage-plugins] 読込失敗: ${record.id}`, error);
      await unload(record.id);
      await pluginStore.setError(record.id, String(error?.message || error));
      return { ok: false, error: String(error?.message || error) };
    }
  }

  async function loadById(id) {
    const record = await pluginStore.get(id);
    if (!record) return { ok: false, error: "plugin not found" };
    if (!record.enabled) return { ok: true, skipped: true };
    return await load(record);
  }

  api.listStoragePlugins = async () => (await pluginStore.list()).map(({ code, ...meta }) => meta);
  api.getStoragePlugin = async id => await pluginStore.get(id);
  api.saveStoragePlugin = async record => {
    if (!record || typeof record.id !== "string" || !record.id.trim()) return { ok: false, error: "id is required" };
    if (typeof record.code !== "string" || !record.code.trim()) return { ok: false, error: "code is required" };
    const id = record.id.trim();
    const prev = await pluginStore.get(id);
    const next = {
      id,
      name: String(record.name || prev?.name || id),
      version: String(record.version || prev?.version || "0.1.0"),
      description: String(record.description ?? prev?.description ?? ""),
      layer: record.layer !== undefined ? record.layer : (prev?.layer ?? null),
      code: record.code,
      enabled: record.enabled !== undefined ? !!record.enabled : (prev?.enabled ?? true),
      updatedAt: Date.now(),
      lastError: "",
    };
    try {
      await pluginStore.put(next);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
    let loadResult = { ok: true, skipped: true };
    if (next.enabled) loadResult = await loadById(id);
    api.emit?.("storage-plugins-changed", {});
    return { ok: true, id, loaded: !!loadResult.ok && !loadResult.skipped, loadError: loadResult.error || null };
  };
  api.removeStoragePlugin = async id => {
    const record = await pluginStore.get(id);
    if (!record) return false;
    await unload(id);
    await pluginStore.remove(id);
    api.emit?.("storage-plugins-changed", {});
    return true;
  };
  api.setStoragePluginEnabled = async (id, enabled) => {
    const record = await pluginStore.get(id);
    if (!record) return false;
    record.enabled = !!enabled;
    record.updatedAt = Date.now();
    await pluginStore.put(record);
    if (enabled) await loadById(id); else await unload(id);
    api.emit?.("storage-plugins-changed", {});
    return true;
  };
  api.setStoragePluginError = async (id, message) => {
    await pluginStore.setError(id, message);
    api.emit?.("storage-plugins-changed", {});
  };
  api.publishStoragePlugin = async id => {
    if (!hasBackendFeature("pluginWrite")) {
      return { error: "pluginWrite はローカルサーバー版のみで利用できます" };
    }
    const record = await pluginStore.get(id);
    if (!record) return { error: `plugin '${id}' not found` };
    try {
      const response = await fetch(backendUrl("/api/plugins"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: record.id, name: record.name, version: record.version,
          description: record.description, layer: record.layer, code: record.code,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) return { error: data.error || `publish failed (${response.status})` };
      return { ok: true };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  };

  // runCode/AI からも使えるよう loader を公開
  api.storagePluginLoader = { load: loadById, unload };

  // ---- inspector(plugin:行)プラグイン（プレイヤー系エンジン用） ----
  // Cesium は plugin-loader.js が差分管理する。こちらは shared/kasc.js の
  // parseKascPluginLine で集めた spec を受け取り、url=（.kasc 埋め込み）または
  // IndexedDB ストレージプラグインの id を解決して起動/停止する
  const inspectorLoaded = new Map(); // id -> signature
  const approvedInline = new Set();  // `${id}|${url}|${codeHash}`（セッション内）

  function hashInlineCode(code) {
    let hash = 5381;
    for (let i = 0; i < code.length; i++) hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
  }

  async function loadInlinePlugin(spec) {
    const resolved = api.resolveProjectUrl?.(spec.url) || spec.url;
    const absolute = new URL(resolved, window.location.href).href;
    let code = "";
    try {
      const response = await fetch(absolute, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      code = await response.text();
    } catch (error) {
      console.warn(`[storage-plugins] plugin: url= の取得失敗 "${spec.id}": ${absolute}`, error);
      return { ok: false };
    }
    if (new URL(absolute).origin !== window.location.origin) {
      const key = `${spec.id}|${absolute}|${hashInlineCode(code)}`;
      if (!approvedInline.has(key)) {
        const ok = await confirmPluginApply({ id: spec.id, name: spec.options?.name || absolute, code });
        if (!ok) return { ok: false };
        approvedInline.add(key);
      }
    }
    return await load({ id: spec.id, name: spec.options?.name || spec.id, code, url: absolute }, spec.options || null);
  }

  let inspectorReconcileRunning = false;
  let inspectorReconcileQueued = false;

  api.setInspectorPlugins = async specs => {
    const specById = new Map();
    for (const spec of specs || []) {
      if (spec?.id) specById.set(spec.id, spec); // 同一 id は後の行を採用
    }
    if (inspectorReconcileRunning) { inspectorReconcileQueued = true; return; }
    inspectorReconcileRunning = true;
    try {
      const desired = new Map();
      for (const [id, spec] of specById) {
        if (spec.off) continue;
        desired.set(id, {
          spec,
          signature: `${spec.url || ""}|${JSON.stringify(spec.options || {})}`,
        });
      }
      for (const [id, signature] of [...inspectorLoaded]) {
        if (!desired.has(id) || desired.get(id).signature !== signature) {
          await unload(id);
          inspectorLoaded.delete(id);
        }
      }
      for (const [id, want] of desired) {
        if (inspectorLoaded.has(id)) continue;
        let result;
        if (want.spec.url) {
          result = await loadInlinePlugin(want.spec);
        } else {
          const record = await pluginStore.get(id);
          if (!record) {
            console.warn(`[storage-plugins] plugin: 未解決のプラグインID "${id}"`);
            continue;
          }
          const named = want.spec.options?.name ? { ...record, name: want.spec.options.name } : record;
          result = await load(named, want.spec.options || null);
        }
        if (result?.ok) inspectorLoaded.set(id, want.signature);
      }
    } finally {
      inspectorReconcileRunning = false;
      if (inspectorReconcileQueued) { inspectorReconcileQueued = false; void api.setInspectorPlugins(specs); }
    }
  };

  // 有効なプラグインを起動時に自動ロード
  (async () => {
    try {
      for (const meta of await pluginStore.list()) {
        if (meta?.enabled && meta.id) await loadById(meta.id);
      }
    } catch (e) { console.warn("[storage-plugins] 自動ロード失敗:", e); }
  })();

  return { load: loadById, unload };
}
