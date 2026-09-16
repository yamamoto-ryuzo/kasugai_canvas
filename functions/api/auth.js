import { createToken } from "../_lib/token.js";

const KV_KEY_PREFIX = "kasc:";

function normalizeProjectId(id) {
  return String(id).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

async function collectKasc(env) {
  const kasc = {};
  if (!env.KASUGAI_KV) return kasc;
  const list = await env.KASUGAI_KV.list({ prefix: KV_KEY_PREFIX });
  for (const { name } of list.keys) {
    const text = await env.KASUGAI_KV.get(name, "text");
    if (text != null) kasc[normalizeProjectId(name.slice(KV_KEY_PREFIX.length))] = text;
  }
  return kasc;
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { user, pass } = body || {};
  const expectedUser = context.env.KASUGAI_AUTH_USER;
  const expectedPass = context.env.KASUGAI_AUTH_PASS;

  if (!expectedUser || !expectedPass) {
    return new Response(JSON.stringify({ ok: false, error: "Not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (user !== expectedUser || pass !== expectedPass) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const kasc = await collectKasc(context.env);
  const secret = context.env.KASUGAI_TOKEN_SECRET || context.env.KASUGAI_AUTH_PASS;
  const token = await createToken(secret);
  return new Response(JSON.stringify({ ok: true, token, kasc }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
