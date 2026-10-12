// Cloudflare Pages Functions / Workers ハンドラ — POST /api/mcp?url=<target>
// （Pages では functions/ 自動検出、Workers では workers/worker.js が import してルーティング）
// CORS 非対応のリモート MCP サーバー（Streamable HTTP）への薄い中継プロキシ。
// ユーザーの Bearer トークンをそのまま転送するだけで、キー隠蔽は行わない
//（トークンは BYO として各ユーザーのブラウザから付く）。
// 接続先は https のみ。環境変数 MCP_ALLOWED_HOSTS（カンマ区切りホスト名）で限定可。
// 認可: 認証系設定がある環境では資格情報必須（gemini.js と同じ判定）。
import { verifyToken } from "../_lib/token.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "authorization",
  "mcp-session-id",
  "mcp-protocol-version",
];
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id"];

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function cookieToken(request) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "kasugai_session") return v.join("=");
  }
  return null;
}

async function authorized(request, env) {
  const secret = env.KASUGAI_TOKEN_SECRET || env.KASUGAI_AUTH_PASS;
  const presented = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  // 注意: kasugai セッション確認のあと、そのまま upstream に渡すユーザー Bearer と
  // 区別するため、verifyToken は secret 由来トークンのみを検証する
  if (secret && (await verifyToken(cookieToken(request), secret))) return true;
  if (secret && presented && (await verifyToken(presented, secret))) return true;
  const bearer = env.ANTIGRAVITY_TOKEN;
  if (bearer && presented === bearer) return true;
  return !secret && !bearer;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);

  const target = new URL(request.url).searchParams.get("url") || "";
  let dest;
  try {
    dest = new URL(target);
  } catch {
    return json({ error: "url クエリが必要です" }, 400);
  }
  // workers 公開環境では https のみ許可（http 中継は local ティアの領分）
  if (dest.protocol !== "https:") return json({ error: "https のみ中継できます" }, 400);
  const allow = (env.MCP_ALLOWED_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(dest.hostname.toLowerCase())) {
    return json({ error: `host は許可されていません: ${dest.hostname}` }, 400);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return json({ error: "リクエストが大きすぎます" }, 400);
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const resp = await fetch(dest, { method: "POST", headers, body });
    const out = new Headers({ "Cache-Control": "no-store" });
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = resp.headers.get(name);
      if (value) out.set(name, value);
    }
    // SSE 応答も含めてボディはストリーム中継する
    return new Response(resp.body, { status: resp.status, headers: out });
  } catch (e) {
    return json({ error: `proxy error: ${e}` }, 502);
  }
}
