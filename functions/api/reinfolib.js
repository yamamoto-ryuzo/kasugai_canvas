// Cloudflare Pages Functions / Workers ハンドラ — GET|HEAD /api/reinfolib?url=<target>
// （Pages では functions/ 自動検出、Workers では workers/worker.js が import してルーティング）
// 不動産情報ライブラリ API（国土交通省）への薄い中継プロキシ。
// 公式案内は CORS 回避のためブラウザからの直接リクエストを禁止しているため、
// Ocp-Apim-Subscription-Key をサーバー側で付与して転送する。
// キー: クライアントの Ocp-Apim-Subscription-Key ヘッダ（BYO）があればそのまま転送。
//       無ければ env.REINFOLIB_API_KEY（サーバーキー。ブラウザには出さない）。
// 接続先は https://www.reinfolib.mlit.go.jp/ex-api/external/ 配下のみ。
// 認可: 認証系設定がある環境では資格情報必須（gemini.js と同じ判定）。
import { verifyToken } from "../_lib/token.js";

const UPSTREAM_HOST = "www.reinfolib.mlit.go.jp";
const UPSTREAM_PREFIX = "/ex-api/external/";
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

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
  if (secret && (await verifyToken(cookieToken(request), secret))) return true;
  if (secret && presented && (await verifyToken(presented, secret))) return true;
  const bearer = env.ANTIGRAVITY_TOKEN;
  if (bearer && presented === bearer) return true;
  return !secret && !bearer;
}

// KV バインド時は IP あたり時間制限（best effort。REINFOLIB_RATE_LIMIT=件数/時）
async function rateLimited(request, env) {
  const limit = parseInt(env.REINFOLIB_RATE_LIMIT || "0", 10);
  if (!env.KASUGAI_KV || !(limit > 0)) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const hour = Math.floor(Date.now() / 3600000);
  const key = `rl:reinfolib:${ip}:${hour}`;
  const count = parseInt((await env.KASUGAI_KV.get(key)) || "0", 10);
  if (count >= limit) return true;
  await env.KASUGAI_KV.put(key, String(count + 1), { expirationTtl: 3700 });
  return false;
}

async function relay(context) {
  const { request, env } = context;
  if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);
  if (await rateLimited(request, env)) return json({ error: "rate limit exceeded" }, 429);

  const target = new URL(request.url).searchParams.get("url") || "";
  let dest;
  try {
    dest = new URL(target);
  } catch {
    return json({ error: "url クエリが必要です" }, 400);
  }
  if (
    dest.protocol !== "https:" ||
    dest.hostname !== UPSTREAM_HOST ||
    !dest.pathname.startsWith(UPSTREAM_PREFIX)
  ) {
    return json({ error: `中継できるのは https://${UPSTREAM_HOST}${UPSTREAM_PREFIX}* のみです` }, 400);
  }

  const key = request.headers.get("ocp-apim-subscription-key") || env.REINFOLIB_API_KEY || "";
  if (!key.trim()) {
    return json(
      {
        error: "REINFOLIB_PROXY_NOT_CONFIGURED",
        detail: "REINFOLIB_API_KEY を設定するか Ocp-Apim-Subscription-Key ヘッダを付けてください",
      },
      503,
    );
  }

  const headers = new Headers({ "Ocp-Apim-Subscription-Key": key });
  for (const name of ["range", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const resp = await fetch(dest, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    });
    const out = new Headers({ "Cache-Control": "no-store" });
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = resp.headers.get(name);
      if (value) out.set(name, value);
    }
    // ボディはストリーム中継（上流の gzip 応答も content-encoding ごと透過）
    return new Response(resp.body, { status: resp.status, headers: out });
  } catch (e) {
    return json({ error: `proxy error: ${e}` }, 502);
  }
}

export async function onRequestGet(context) {
  return relay(context);
}

export async function onRequestHead(context) {
  return relay(context);
}
