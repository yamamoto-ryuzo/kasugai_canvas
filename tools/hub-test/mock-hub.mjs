// bridge-hub の HTTP I/F を模倣するモックサーバー（回帰検証用）。
// 環境変数で応答を切替える:
//   MOCK_PORT        待受ポート（既定 8511）
//   MOCK_HUB         "false" で非ハブ占有（hub:false を返す）
//   MOCK_VERSION     /health の version。空文字=フィールド無し（6.5.5 より前の旧ハブ模倣）
//   MOCK_VECTOR      "0" で vector フィールド無し（旧ハブ模倣）
//   MOCK_PROVIDERS   カンマ区切り（例 "copilot,devin" → 各 {available:true}）
// 例: MOCK_VERSION= MOCK_VECTOR=0 node mock-hub.mjs   → 旧ハブ
import http from "node:http";

const port = Number(process.env.MOCK_PORT || 8511);
const isHub = (process.env.MOCK_HUB ?? "true") !== "false";
const version = process.env.MOCK_VERSION ?? "9.9.9";
const withVector = (process.env.MOCK_VECTOR ?? "1") !== "0";
const providers = Object.fromEntries(
  (process.env.MOCK_PROVIDERS ?? "copilot,devin,antigravity")
    .split(",").filter(Boolean).map((p) => [p, { available: true }]));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => {
    res.writeHead(code, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") {
    const body = { hub: isHub, providers };
    if (version) body.version = version;
    if (withVector) body.vector = { duckdb: true, sources: 0 };
    return json(200, body);
  }
  if (url.pathname === "/setup") return json(200, { providers: {} });
  if (url.pathname === "/vector/status") return json(200, { duckdb: true, sources: {} });
  if (url.pathname === "/vector/sources") return json(200, { sources: {} });
  return json(404, { error: "not found" });
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `mock-hub: http://127.0.0.1:${port}/health hub=${isHub} version=${version || "(none)"} vector=${withVector}`
  );
});
