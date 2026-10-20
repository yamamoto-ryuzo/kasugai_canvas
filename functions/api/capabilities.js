// Cloudflare Pages Functions / Workers ハンドラ — GET /api/capabilities
// フロントへの能力通知（workers ティア）。
// agent/app/main.py capabilities() と同一形式。実バインド状況に応じて features を返す。
export async function onRequestGet(context) {
  const env = context.env;
  const authed = !!(env.KASUGAI_TOKEN_SECRET || env.KASUGAI_AUTH_PASS);
  const features = [];
  if (authed) features.push("auth");
  if (authed && env.KASUGAI_KV) features.push("kascWrite");
  if (authed && env.KASUGAI_DATA) features.push("dataStore");
  // サーバーキーによる内蔵AI用 Gemini プロキシ（キー隠蔽。訪問者はキー不要）
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) features.push("aiProxy");
  // リモート MCP サーバーへの薄い中継（BYO トークン転送のみ・常時提供）
  features.push("mcpProxy");
  // 不動産情報ライブラリ API 中継（BYO キー転送または REINFOLIB_API_KEY 注入・常時提供）
  features.push("reinfolibProxy");
  return new Response(
    JSON.stringify({
      tier: "workers",
      features,
      auth: { mode: authed ? "cookie" : null },
      ai: { endpoint: "/api/gemini" },
      // agent/app/main.py と同一契約。ブラウザから直接付くキーなので秘匿ではなく、
      // GCP 側の HTTP リファラ制限で保護する
      ...(env.GOOGLE_MAPS_API_KEY ? { google: { mapsApiKey: env.GOOGLE_MAPS_API_KEY } } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}
