// KASUGAI Canvas ブリッジハブ — 127.0.0.1:8511 で待受け、AI プロバイダ
// （copilot / devin / antigravity）ごとのブリッジを子プロセスとして
// 「必要になった時点で1本だけ」起動し、/agent・/models をプロキシする。
//
// 従来はアプリが3つのブリッジ（8511/8512/8513）を常駐させていたが、
// このハブに集約し、選択中プロバイダのブリッジのみ遅延起動する。
// 子ブリッジは内部ポート（8521/8522/8523）で待受け、プロバイダ切替時は
// 前の子プロセスを停止する（常時1プロセスのみ）。
//
// ルーティング:
//   GET  /health              → ハブ自身の状態（provider 指定で子の状態も）
//   GET  /models?provider=<p> → 子ブリッジを起動して /models をプロキシ
//   POST /agent               → body.provider で子ブリッジを選択・起動し中継
//
// 手動起動の既存ブリッジ（8788/8789/8791）はこのハブとは別にそのまま使える。
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.BRIDGE_HUB_PORT || 8511);
const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));

// 子ブリッジの待受ポート基準。copilot=base+1・devin=base+2・antigravity=base+3。
// 既定 8520（=8521〜8523）。複数ハブを同時稼働させて子ポートが衝突する
// 場合だけ BRIDGE_HUB_CHILD_BASE でずらす（例: 8530→8531〜8533）
const CHILD_BASE = Number(process.env.BRIDGE_HUB_CHILD_BASE || 8520);

// プロバイダごとの子ブリッジ定義。dir は bridge-hub/ と同階層に置く
const PROVIDERS = {
  copilot: {
    dir: "copilot-bridge",
    portEnv: "COPILOT_BRIDGE_PORT",
    internalPort: CHILD_BASE + 1,
    disableEnv: "KASUGAI_NO_COPILOT_BRIDGE",
    needsInstall: true, // package.json に依存あり（@github/copilot-sdk）
  },
  devin: {
    dir: "devin-bridge",
    portEnv: "DEVIN_BRIDGE_PORT",
    internalPort: CHILD_BASE + 2,
    disableEnv: "KASUGAI_NO_DEVIN_BRIDGE",
  },
  antigravity: {
    dir: "antigravity-bridge",
    portEnv: "ANTIGRAVITY_BRIDGE_PORT",
    internalPort: CHILD_BASE + 3,
    disableEnv: "KASUGAI_NO_ANTIGRAVITY_BRIDGE",
  },
};

// 配布物に存在するブリッジのみ利用可（KASUGAI_NO_*_BRIDGE で個別無効化）
function providerDir(name) {
  const p = PROVIDERS[name];
  if (!p || process.env[p.disableEnv]) return null;
  const dir = path.resolve(HUB_DIR, "..", p.dir);
  return fs.existsSync(path.join(dir, "server.mjs")) ? dir : null;
}
function providerAvailable(name) {
  return !!providerDir(name);
}

// ---- 子ブリッジ管理（常時1プロセスのみ） ----
let active = null; // {name, child, port}
// 起動・切替は直列化して競合を防ぐ
let switching = Promise.resolve();
const serialize = (fn) => { switching = switching.then(fn, fn); return switching; };

function stopActive() {
  if (!active) return;
  const { name, child } = active;
  active = null;
  console.log(`[hub] ${name} ブリッジを停止します`);
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32") {
    // taskkill /T で devin acp・agy 等の孫プロセスまで落とす
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { child.kill("SIGTERM"); } catch (e) {}
    // 生き残った場合だけ強制終了（active を遅延参照すると次の子を殺すので固定する）
    setTimeout(() => {
      try { if (child.exitCode === null) child.kill("SIGKILL"); } catch (e) {}
    }, 3000).unref();
  }
}

// 配布 ZIP には node_modules を含めないため、依存のあるブリッジは初回のみ
// npm install を実行する（Rust 側の従来挙動と同じ）
function installDepsIfNeeded(name, dir) {
  if (!PROVIDERS[name]?.needsInstall) return true;
  if (fs.existsSync(path.join(dir, "node_modules"))) return true;
  console.log(`[hub] ${name}: 依存をインストールしています (npm install)...`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: dir, stdio: "inherit", timeout: 300000 });
  return !r.error && r.status === 0;
}

async function waitHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// 指定プロバイダの子ブリッジを起動済みにして内部ポートを返す。
// 別プロバイダが動いていれば先に停止する（serialize の内側でのみ呼ぶこと）
async function ensureProvider(name) {
  if (active?.name === name && !active.child.killed && active.child.exitCode === null) {
    return active.port;
  }
  stopActive();
  const p = PROVIDERS[name];
  const dir = providerDir(name);
  if (!p || !dir) throw new Error(`プロバイダ "${name}" は利用できません（未同梱または無効化）`);
  if (!installDepsIfNeeded(name, dir)) throw new Error(`${name}: npm install に失敗しました`);
  console.log(`[hub] ${name} ブリッジを起動します (127.0.0.1:${p.internalPort})`);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: dir,
    env: { ...process.env, [p.portEnv]: String(p.internalPort), NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", d => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", d => process.stderr.write(`[${name}] ${d}`));
  child.on("exit", (code) => {
    console.log(`[hub] ${name} ブリッジが終了しました (code=${code})`);
    if (active?.child === child) active = null;
  });
  active = { name, child, port: p.internalPort };
  const ok = await waitHealth(p.internalPort);
  if (!ok) {
    stopActive();
    throw new Error(`${name} ブリッジの起動がタイムアウトしました`);
  }
  return p.internalPort;
}

// 起動確認からプロキシ完了までを直列化する。
// これをしないと、/agent 処理中に別プロバイダの /models が来た際に
// 子プロセスを途中で kill して進行中の会話を断ち切ってしまう
function withProvider(name, fn) {
  return serialize(async () => fn(await ensureProvider(name)));
}

// 子ブリッジへの薄いプロキシ（ボディ・ヘッダをそのまま転送）。
// 応答書き込み完了で resolve する（呼び出し側が直列化スロットを保持するため）
function proxyTo(port, req, res, body) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // クライアント中断・タイムアウト・上流応答のどの経路でも必ず resolve する。
    // クライアントが先に切った場合は上流も切って子ブリッジ側の処理を止める
    res.on("finish", finish);
    res.on("close", () => { if (!res.writableEnded && !res.destroyed) { try { upstream.destroy(); } catch (e) {} } finish(); });
    const fail = (status, obj) => {
      if (res.headersSent || res.destroyed) res.destroy();
      else { try { sendJson(res, status, obj); } catch (e) {} }
      finish();
    };
    const upstream = http.request({
      host: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
      timeout: 180000,
    }, (up) => {
      if (res.destroyed || res.closed) { up.destroy(); return finish(); }
      try {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      } catch (e) {
        up.destroy();
        finish();
      }
      up.on("error", () => { res.destroy(); finish(); });
    });
    upstream.on("timeout", () => { upstream.destroy(); fail(504, { error: "bridge timeout" }); });
    upstream.on("error", (e) => fail(502, { error: `bridge unreachable: ${e.message}` }));
    if (body) upstream.write(body);
    upstream.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => {
      data += c;
      if (data.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

process.on("unhandledRejection", (e) => console.error("[hub] unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => console.error("[hub] uncaughtException:", e?.message || e));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopActive(); process.exit(0); });

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Devin-Api-Key");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "GET" && url.pathname === "/health") {
    const providers = {};
    for (const name of Object.keys(PROVIDERS)) {
      providers[name] = {
        available: providerAvailable(name),
        running: active?.name === name,
      };
    }
    return sendJson(res, 200, {
      ok: true,
      bridge: "hub",
      hub: true,
      active: active?.name || null,
      providers,
      model: null,
      sessions: active ? 1 : 0,
    });
  }

  if (req.method === "GET" && url.pathname === "/models") {
    const provider = url.searchParams.get("provider") || active?.name || "";
    try {
      // /models パスへそのまま中継（クエリの provider は子側では無視される）
      req.url = "/models";
      await withProvider(provider, port => proxyTo(port, req, res));
      return;
    } catch (e) {
      return sendJson(res, 502, { error: e.message, models: [] });
    }
  }

  if (req.method === "POST" && url.pathname === "/agent") {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    let provider = "";
    try { provider = JSON.parse(body || "{}")?.provider || ""; } catch (e) {}
    if (!provider) provider = active?.name || "";
    if (!provider) return sendJson(res, 400, { error: "provider を指定してください（copilot / devin / antigravity）" });
    try {
      await withProvider(provider, port => proxyTo(port, req, res, body));
      return;
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  const avail = Object.keys(PROVIDERS).filter(providerAvailable);
  console.log(`[hub] listening: http://127.0.0.1:${PORT}/agent`);
  console.log(`[hub] 利用可能プロバイダ: ${avail.join(", ") || "なし"}`);
  console.log(`[hub] ブリッジはプロバイダ選択・初回利用時に遅延起動します（常時1プロセスのみ）`);
});
