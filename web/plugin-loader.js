async function loadPlugin(manifest) {
  try {
    const url = manifest.url || `./PLUGIN/${manifest.id}/plugin.js`;
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

async function loadPlugins() {
  try {
    const response = await fetch("./plugins.json", { cache: "no-store" });
    if (!response.ok) {
      console.log("[plugin-loader] plugins.json が見つかりません。プラグインをスキップします。");
      return;
    }
    const data = await response.json();
    const plugins = data.plugins || [];
    if (!plugins.length) return;
    console.log("[plugin-loader] 読み込み開始:", plugins.map(p => p.id || p.name));
    for (const manifest of plugins) {
      await loadPlugin(manifest);
    }
    window.kasugaiApi.emit("plugins-loaded", { plugins: window.kasugaiApi.getPlugins() });
  } catch (error) {
    console.error("[plugin-loader] プラグインロード失敗", error);
  }
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
