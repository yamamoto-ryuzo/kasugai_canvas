import { verifyToken } from "../_lib/token.js";

const PROJECT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT_BYTES = 1024 * 1024;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const env = context.env;
  const secret = env.KASUGAI_TOKEN_SECRET || env.KASUGAI_AUTH_PASS;
  if (!secret || !(await verifyToken(body?.token, secret))) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!env.KASUGAI_KV) {
    return json({ ok: false, error: "KV not bound" }, 500);
  }

  const { project, text } = body;
  if (typeof project !== "string" || !PROJECT_RE.test(project)) {
    return json({ ok: false, error: "Invalid project" }, 400);
  }
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    return json({ ok: false, error: "Invalid text" }, 400);
  }

  await env.KASUGAI_KV.put(`kasc:${project}`, text);
  return json({ ok: true }, 200);
}
