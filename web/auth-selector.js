function stripComments(text) {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

async function loadAuthConfig() {
  try {
    const response = await fetch("./auth-methods.json", { cache: "no-store" });
    if (response.ok) {
      const text = await response.text();
      return JSON.parse(stripComments(text));
    }
  } catch (error) {
    console.log("[auth-selector] auth-methods.json が見つかりません。内蔵デフォルトを使います。");
  }
  return { default: "none", methods: { none: null } };
}

async function runAuth() {
  let config = await loadAuthConfig();
  if (typeof config.control === "number") {
    const controlMap = {
      0: { default: "none", methods: { none: null } },
      1: { default: "local", methods: { none: null, local: "./PLUGIN/auth-local/auth.js" } },
      2: { default: "cloudflare", methods: { cloudflare: "./PLUGIN/auth-cloudflare/auth.js" } },
      3: { default: "password", methods: { password: "./PLUGIN/auth-password/auth.js" } }
    };
    config = controlMap[config.control] || controlMap[0];
  }
  const available = new Set(Object.keys(config.methods || {}));

  let storedMethod = null;
  try { storedMethod = localStorage.getItem("kasugaiAuthMethod"); } catch (e) {}
  const param = new URLSearchParams(window.location.search).get("auth");
  const requested = param || storedMethod;
  const fallback = config.default || "none";

  const method = requested && available.has(requested) ? requested : (available.has(fallback) ? fallback : "none");
  if (requested && requested !== method) {
    console.warn(`[auth-selector] 未設定の認証方式: ${requested}、${method} にフォールバック`);
  }

  const loader = (config.methods || {})[method];

  if (method === "none" || loader == null) {
    if (method !== "none") {
      console.warn(`[auth-selector] 未知の認証方式: ${method}`);
    }
    window.kasugaiAuth = null;
    console.log("[auth-selector] 認証なしで起動");
    return;
  }

  try {
    const mod = await import(loader);
    if (typeof mod.authenticate !== "function") {
      throw new Error(`認証プラグインに authenticate が定義されていません: ${method}`);
    }
    const auth = await mod.authenticate();
    window.kasugaiAuth = { method, ...auth };
    console.log(`[auth-selector] 認証成功: ${method}`);
  } catch (error) {
    console.error(`[auth-selector] 認証失敗: ${method}`, error);
    throw error;
  }
}

async function injectModule(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`読み込み失敗: ${url}`));
    document.head.appendChild(script);
  });
}

(async () => {
  try {
    await runAuth();
    await injectModule("./app.js");
    await injectModule("./plugin-loader.js");
  } catch (error) {
    const container = document.body;
    const notice = document.createElement("div");
    notice.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;color:#a82020;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif;";
    notice.textContent = `起動できません: ${error instanceof Error ? error.message : error}`;
    container.append(notice);
  }
})();
