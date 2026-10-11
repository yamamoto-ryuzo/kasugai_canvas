// Cloudflare Pages Functions / Workers ハンドラ — GET /health
// detectBackend() の到達確認用（{ok:true} で capabilities 取得に進む）
export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
