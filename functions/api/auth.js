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

  const dataKey = context.env.KASUGAI_DATA_KEY || null;
  return new Response(JSON.stringify({ ok: true, token: "cloudflare", dataKey }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
