// bridge-hub.exe --serve の実起動スモーク。/health・/vector/status を実疎通する。
// 既定の対象は web/download/bridge-hub.exe（配布物）。引数で exe パスを変えられる。
// 使い方: node smoke.mjs [bridge-hub.exe のパス]
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const exe = process.argv[2]
  || fileURLToPath(new URL("../../web/download/bridge-hub.exe", import.meta.url));

const freePort = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

console.log(`smoke: ${exe} --serve (BRIDGE_HUB_PORT=${freePort})`);
const child = spawn(exe, ["--serve"], {
  env: { ...process.env, BRIDGE_HUB_PORT: String(freePort) },
  stdio: "ignore",
});

const get = (path) => fetch(`http://127.0.0.1:${freePort}${path}`)
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let failed = false;
const check = (name, cond, detail = "") => {
  if (!cond) failed = true;
  console.log(`${cond ? "PASS" : "FAIL"} ${name} ${detail}`);
};
try {
  // 起動待ち（bounded: 15s）
  let health = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await get("/health");
      if (res.status === 200 && res.body) { health = res.body; break; }
    } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  check("/health 応答", !!health, JSON.stringify(health));
  check("/health hub:true", health?.hub === true, `hub=${health?.hub}`);
  check("/health version あり", typeof health?.version === "string" && health.version.length > 0, `version=${health?.version}`);
  const status = await get("/vector/status").catch(() => null);
  check("/vector/status 200+ok+duckdb",
    status?.status === 200 && status.body?.ok === true && "duckdb" in (status.body || {}),
    JSON.stringify(status)?.slice(0, 140));
} finally {
  child.kill();
  await new Promise(r => setTimeout(r, 500));
}
process.exit(failed ? 1 : 0);
