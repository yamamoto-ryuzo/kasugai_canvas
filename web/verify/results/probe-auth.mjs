// V4 認証セレクタ検証プローブ (skill: verify-auth)
//  実行: node web/verify/results/probe-auth.mjs
//  AU1 auth-selector 配線  AU2 認証方式プラグイン(0-7)の実在  AU3 実ログイン(要実機)
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const skip = (id, detail) => { results.push({ id, ok: null });
  console.log(`SKIP ${id} :: ${detail}`); };

const BASE = "http://127.0.0.1:8510";
const code = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); return r.status; }
  catch { return -1; } };

// AU1: セレクタと設定ファイル
const sel = await code(`${BASE}/cesium/auth-selector.js`);
const cfg = await code(`${BASE}/cesium/auth-methods.json`);
rec("AU1", sel === 200, `auth-selector.js=${sel} auth-methods.json=${cfg}(404=内蔵既定)`);

// AU2: 認証方式 PLUGIN の実在(auth.js 配信可否)
const methods = ["auth-local", "auth-password", "auth-cloudflare", "auth-cloudrun", "auth-iap"];
let found = [], missing = [];
for (const m of methods) {
  const s = await code(`${BASE}/cesium/PLUGIN/${m}/auth.js`);
  (s === 200 ? found : missing).push(`${m}:${s}`);
}
rec("AU2", missing.length === 0, `plugins OK=${found.join(",")} NG=${missing.join(",") || "なし"}`);

// AU3: 方式切替の構造確認(auth-methods.json パース + auth-login-form 実在)
const form = await code(`${BASE}/cesium/auth-login-form.js`);
let selOk = false, modes = "";
try {
  const src = await (await fetch(`${BASE}/cesium/auth-selector.js`)).text();
  const m = [...src.matchAll(/(\d):\s*\{[^}]*default:\s*"([^"]+)"/g)].map(x => `${x[1]}=${x[2]}`);
  modes = m.join(",");
  selOk = m.length >= 5;
} catch {}
rec("AU3", form === 200 && selOk, `auth-login-form.js=${form} 方式マップ: ${modes}`);

skip("AU4", "実ログイン・トークン検証は各認証バックエンド(Cloudflare/CloudRun/IAP/local)が必要(要実機)");

const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
