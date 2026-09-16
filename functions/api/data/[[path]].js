import { verifyToken } from "../../_lib/token.js";

const KEY_RE = /^[A-Za-z0-9_.\-/]+$/;

const CONTENT_TYPES = {
  geojson: "application/geo+json",
  json: "application/json",
  czml: "application/json",
  kml: "application/vnd.google-earth.kml+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pmtiles: "application/octet-stream"
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function keyFrom(context) {
  const segs = context.params.path;
  const key = Array.isArray(segs) ? segs.join("/") : String(segs || "");
  if (!key || !KEY_RE.test(key) || key.includes("..") || key.startsWith("/") || key.endsWith("/")) return null;
  return key;
}

async function authorized(context) {
  const url = new URL(context.request.url);
  let token = url.searchParams.get("token");
  if (!token) {
    const auth = context.request.headers.get("Authorization") || "";
    if (auth.startsWith("Bearer ")) token = auth.slice(7);
  }
  const secret = context.env.KASUGAI_TOKEN_SECRET || context.env.KASUGAI_AUTH_PASS;
  return !!(secret && (await verifyToken(token, secret)));
}

function contentTypeFallback(key) {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

export async function onRequestGet(context) {
  if (!(await authorized(context))) return json({ ok: false, error: "Unauthorized" }, 401);
  const bucket = context.env.KASUGAI_DATA;
  if (!bucket) return json({ ok: false, error: "R2 not bound" }, 500);
  const key = keyFrom(context);
  if (!key) return json({ ok: false, error: "Invalid path" }, 400);

  const obj = await bucket.get(key);
  if (!obj) return json({ ok: false, error: "Not Found" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", contentTypeFallback(key));
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "private, no-store");
  return new Response(obj.body, { headers });
}

export async function onRequestPut(context) {
  if (!(await authorized(context))) return json({ ok: false, error: "Unauthorized" }, 401);
  const bucket = context.env.KASUGAI_DATA;
  if (!bucket) return json({ ok: false, error: "R2 not bound" }, 500);
  const key = keyFrom(context);
  if (!key) return json({ ok: false, error: "Invalid path" }, 400);

  await bucket.put(key, context.request.body, {
    httpMetadata: { contentType: context.request.headers.get("Content-Type") || contentTypeFallback(key) }
  });
  return json({ ok: true }, 200);
}
