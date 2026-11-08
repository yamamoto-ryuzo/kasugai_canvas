// bridge-hub (127.0.0.1:8511) のモックサーバー (issue #89)
// /health 応答をシナリオで切り替え、hub-diag / ai-chat のハブ依存パスを検証する。
//   node mock-hub.mjs [--port 8511] [--scenario normal]
//   実行中の切替: POST /__scenario  {"scenario":"<name>"} / GET /__scenario
// シナリオ: normal / old(version・vector無し) / noversion / noduckdb /
//           nosource(/vectorは動くがソース未登録) / nothub(hubフィールド無し=別アプリ占有)
import http from "node:http";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt("port", 8511));
let scenario = opt("scenario", "normal");

const PROVIDERS = {
  copilot: { available: true, running: false },
  devin: { available: true, running: false },
  antigravity: { available: false, running: false },
};
const GEOJSON = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [139.0, 35.0] }, properties: { name: "p1" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [139.1, 35.1] }, properties: { name: "p2" } },
  ],
};
const VECTOR_SCENARIOS = new Set(["normal", "nosource", "noversion", "noduckdb"]);

function health() {
  switch (scenario) {
    case "nothub":
      return { status: "ok" }; // hub フィールド無し = 8511 を別アプリが占有
    case "old":
      return { ok: true, bridge: "hub", hub: true, providers: PROVIDERS, active: null, model: null }; // version・vector 無し
    case "noversion":
      return { ok: true, bridge: "hub", hub: true, providers: PROVIDERS, active: null, vector: { duckdb: true }, model: null };
    case "noduckdb":
      return { ok: true, bridge: "hub", hub: true, version: "6.99.0-mock", providers: PROVIDERS, active: null, vector: { duckdb: false }, model: null };
    default:
      return { ok: true, bridge: "hub", hub: true, version: "6.99.0-mock", providers: PROVIDERS, active: null, vector: { duckdb: true }, model: null, sessions: 0 };
  }
}
const sources = () => (scenario === "nosource" ? {} : { mock_points: { kind: "geojson", rows: 2 } });

const server = http.createServer((req, res) => {
  const send = (code, obj, type = "application/json") => {
    const body = typeof obj === "string" ? obj : JSON.stringify(obj);
    res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
    res.end(body);
  };
  const u = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return send(204, "");
  if (u.pathname === "/__scenario") {
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { try { scenario = JSON.parse(b).scenario || scenario; } catch {} send(200, { scenario }); });
      return;
    }
    return send(200, { scenario });
  }
  if (u.pathname === "/health") return send(200, health());
  if (u.pathname.startsWith("/vector") && !VECTOR_SCENARIOS.has(scenario)) return send(404, { error: "not found" });
  if (u.pathname === "/vector/status") return send(200, { ok: true, duckdb: scenario !== "noduckdb", store: "C:/mock/vector.duckdb", sources: Object.keys(sources()) });
  if (u.pathname === "/vector/sources") {
    if (req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => send(200, { ok: true })); return; }
    return send(200, { sources: sources() });
  }
  if (/^\/vector\/geojson\//.test(u.pathname) || u.pathname === "/vector/query") return send(200, GEOJSON, "application/geo+json");
  if (u.pathname === "/models") return send(200, { models: [{ id: "mock-model" }] });
  if (u.pathname === "/setup") {
    if (req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => send(200, { ok: true, status: { cli_found: true, cli_path: "C:/mock/cli.exe" } })); return; }
    return send(200, { ok: true, copilot: { cli_found: true, cli_path: "C:/mock/copilot" }, devin: { cli_found: false }, antigravity: { cli_found: false }, duckdb: { cli_found: scenario !== "noduckdb" } });
  }
  if (u.pathname === "/agent") return send(200, { ok: false, error: "mock agent" });
  if (u.pathname === "/") return send(200, "<html><body>mock bridge-hub</body></html>", "text/html");
  return send(404, { error: "not found" });
});
server.listen(PORT, "127.0.0.1", () => console.log(`[mock-hub] 127.0.0.1:${PORT} scenario=${scenario}`));
