async function loadPlugin(manifest) {
  try {
    const url = manifest.url || `./PLUGIN/${manifest.id}/plugin.js`;
    // layer 宣言があるプラグインは本体側でレイヤーを先に登録し、
    // レイヤ一覧・属性検索・表示切替の対象にする
    if (manifest.layer && window.kasugaiApi?.registerPluginLayer) {
      try {
        await window.kasugaiApi.registerPluginLayer(manifest.layer, manifest.id || "");
      } catch (error) {
        console.warn(`[plugin-loader] レイヤー登録失敗: ${manifest.id}`, error);
      }
    }
    const module = await import(url);
    if (typeof module.init === "function") {
      await module.init(window.kasugaiApi, manifest);
    } else if (typeof module.default === "function") {
      await module.default(window.kasugaiApi, manifest);
    } else {
      console.warn(`[plugin-loader] エントリポイントが見つかりません: ${manifest.id}`);
    }
  } catch (error) {
    console.error(`[plugin-loader] 読み込み失敗: ${manifest.id}`, error);
  }
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
  const blobUrl = loadedStoragePlugins.get(id);
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    loadedStoragePlugins.delete(id);
  }
}

async function loadStoragePlugin(record) {
  const api = window.kasugaiApi;
  if (!api || !record?.id) return { ok: false, error: "invalid record" };
  await unloadStoragePlugin(record.id);
  try {
    if (record.layer && api.registerPluginLayer) {
      await api.registerPluginLayer(record.layer, record.id);
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
    if (typeof module.init === "function") {
      await module.init(api, manifest);
    } else if (typeof module.default === "function") {
      await module.default(api, manifest);
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
  return await loadStoragePlugin(record);
}

// app.js 側（kasugaiApi.saveStoragePlugin 等）からの再読み込みに使う
window.kasugaiPluginLoader = {
  load: loadStoragePluginById,
  unload: unloadStoragePlugin,
};

async function loadPlugins() {
  try {
    const response = await fetch("./plugins.json", { cache: "no-store" });
    if (!response.ok) {
      console.log("[plugin-loader] plugins.json が見つかりません。同梱プラグインをスキップします。");
    } else {
      const data = await response.json();
      const plugins = data.plugins || [];
      if (plugins.length) {
        console.log("[plugin-loader] 読み込み開始:", plugins.map(p => p.id || p.name));
        for (const manifest of plugins) {
          await loadPlugin(manifest);
        }
      }
    }
  } catch (error) {
    console.error("[plugin-loader] プラグインロード失敗", error);
  }

  // 同梱プラグインの後に、IndexedDB のストレージプラグイン（有効なもの）を読み込む
  try {
    const stored = await window.kasugaiApi?.listStoragePlugins?.() || [];
    for (const meta of stored.filter(item => item.enabled)) {
      await loadStoragePluginById(meta.id);
    }
  } catch (error) {
    console.error("[plugin-loader] ストレージプラグイン読込失敗", error);
  }

  window.kasugaiApi.emit("plugins-loaded", { plugins: window.kasugaiApi.getPlugins() });
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
