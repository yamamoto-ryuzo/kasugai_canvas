// Cloudflare Pages Functions / Workers ハンドラ — POST /api/gemini
// （Pages では functions/ 自動検出、Workers では workers/worker.js が import してルーティング）
// 内蔵AI向けの薄いキー隠蔽プロキシ。
// ブラウザの Gemini generateContent リクエストをサーバーキー付きで転送するだけで、
// 推論ループはブラウザ側（内蔵AI）に留まる。エージェント実装ではない。
// 認可: 認証系設定がある環境では資格情報必須（Cookie トークン or Bearer）。
// キー: env の GEMINI_API_KEY/GOOGLE_API_KEY のみ（BYO = Bring Your Own の apiKey
//       同梱は受け付けない。ユーザーキーはブラウザから直接 Gemini を呼ぶ経路で使う）。
import { verifyToken } from "../_lib/token.js";

const MAX_BODY_BYTES = 1024 * 1024;

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
  if (secret && (await verifyToken(cookieToken(request), secret))) return true;
  const bearer = env.ANTIGRAVITY_TOKEN;
  if (bearer && request.headers.get("Authorization") === `Bearer ${bearer}`) return true;
  return !secret && !bearer;
}

// KV バインド時は IP あたり時間制限（best effort）
async function rateLimited(request, env) {
  const limit = parseInt(env.ANTIGRAVITY_RATE_LIMIT || "0", 10);
  if (!env.KASUGAI_KV || !(limit > 0)) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const hour = Math.floor(Date.now() / 3600000);
  const key = `rl:gemini:${ip}:${hour}`;
  const count = parseInt((await env.KASUGAI_KV.get(key)) || "0", 10);
  if (count >= limit) return true;
  await env.KASUGAI_KV.put(key, String(count + 1), { expirationTtl: 3700 });
  return false;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
  if (!apiKey) {
    return json({ error: "AI_PROXY_NOT_CONFIGURED", detail: "GEMINI_API_KEY を設定してください" }, 503);
  }
  if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);
  if (await rateLimited(request, env)) return json({ error: "rate limit exceeded" }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.contents)) {
    return json({ error: "contents が必要です" }, 400);
  }
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY_BYTES) {
    return json({ error: "リクエストが大きすぎます" }, 400);
  }
  // モデルはクライアント指定必須。許可リスト（GEMINI_MODELS・カンマ区切り）が
  // あれば制限する（高額モデルの乱用防止）
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    return json({ error: "model が必要です" }, 400);
  }
  const allow = (env.GEMINI_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(model)) {
    return json({ error: `model は許可されていません: ${model}` }, 400);
  }

  // 転送するフィールドは generateContent の既知キーのみ（予期しない拡張の持ち込み防止）
  const forward = {
    contents: body.contents,
    ...(body.systemInstruction ? { systemInstruction: body.systemInstruction } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.generationConfig ? { generationConfig: body.generationConfig } : {}),
  };
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(forward),
      },
    );
    const data = await resp.json().catch(() => ({}));
    return new Response(JSON.stringify(data), {
      status: resp.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return json({ error: `proxy error: ${e}` }, 502);
  }
}
