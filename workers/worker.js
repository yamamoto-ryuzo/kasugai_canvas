import { onRequestPost as handleAuth } from "../functions/api/auth.js";
import { onRequestPost as handleKasc } from "../functions/api/kasc.js";
import { onRequestGet as handleDataGet, onRequestPut as handleDataPut } from "../functions/api/data/[[path]].js";
import { verifyToken } from "../functions/_lib/token.js";

const COOKIE = "kasugai_session";
const COOKIE_MAX_AGE = 12 * 60 * 60;

// 認証前（ログイン画面の表示）に必要な最小限の公開パス
const PUBLIC_PATHS = new Set([
  "/",
  "/index.html",
  "/styles.css",
  "/favicon.ico",
  "/auth-selector.js",
  "/auth-login-form.js",
  "/auth-methods.json"
]);
const PUBLIC_PREFIXES = ["/PLUGIN/auth-"];

function isPublic(path) {
  return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some(p => path.startsWith(p));
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function authorized(request, env) {
  const token = getCookie(request, COOKIE);
  const secret = env.KASUGAI_TOKEN_SECRET || env.KASUGAI_AUTH_PASS;
  return !!(secret && (await verifyToken(token, secret)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/auth") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const res = await handleAuth({ request, env });
      const data = await res.clone().json().catch(() => null);
      if (!data?.ok || !data.token) return res;
      const headers = new Headers(res.headers);
      headers.set("Set-Cookie", `${COOKIE}=${data.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
      return new Response(res.body, { status: res.status, headers });
    }

    if (path === "/api/kasc") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return handleKasc({ request, env });
    }

    if (path.startsWith("/api/data/")) {
      const segs = path.slice("/api/data/".length).split("/").map(s => {
        try { return decodeURIComponent(s); } catch { return s; }
      });
      const context = { request, env, params: { path: segs } };
      if (request.method === "GET") return handleDataGet(context);
      if (request.method === "PUT") return handleDataPut(context);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (isPublic(path)) return env.ASSETS.fetch(request);
    if (!(await authorized(request, env))) return new Response("Unauthorized", { status: 401 });
    return env.ASSETS.fetch(request);
  }
};
