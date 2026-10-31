// KASUGAI Canvas — vendor 同一オリジン・プロキシ Service Worker
// web/vendor/ は配布物・リポジトリに同梱しない。github.io/kasugai_canvas のような
// サーバーレス静的配信では vendor 実体が無いため、この SW がスコープ配下の
// vendor/* GET/HEAD を拾い、ローカル実体 → CDN(kasugai-canvas-web) の順で供給する。
// 応答はページと同一オリジンとして返るため、importmap・Worker(import.meta.url 相対)
// ・iframe 制御(GSI.GLOBALS) の同一オリジン制約を満たしたまま CDN 直読みができる。
// navara 等の index.html ガードが登録する（登録されない環境では無害に無効）。
// 転送先は登録 URL の ?u=<base> で指定する（postMessage だと初回プローブと
// 競合し得るため、SW スクリプト URL のクエリで確定的に渡す）。

const DEFAULT_UPSTREAM = "https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable/";
const upstreamBase = (() => {
  const u = new URL(self.location.href).searchParams.get("u");
  return u && /^https:\/\/[\w.-]+(?::\d+)?\//.test(u)
    ? u.replace(/\/?$/, "/")
    : DEFAULT_UPSTREAM;
})();
const CACHE_NAME = "kasugai-vendor-v1";

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" && e.request.method !== "HEAD") return;
  const url = new URL(e.request.url);
  const prefix = new URL(self.registration.scope).pathname + "vendor/";
  if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) return;
  e.respondWith(proxyVendor(e.request, url.pathname.slice(prefix.length)));
});

async function proxyVendor(request, rel) {
  // 1) ローカル実体（CDN ホスト版・fetch_vendor.py で置いた開発用実体）を優先。
  //    SW 内の fetch は自 SW を再経由しないため素通しでオリジンへ届く
  const local = await fetch(request).catch(() => null);
  if (local && local.status !== 404) return local;
  // 2) 実体が無ければ自前 CDN へ中継（Range/条件付きを転送）
  const headers = new Headers();
  for (const k of ["range", "if-none-match", "if-modified-since"]) {
    const v = request.headers.get(k);
    if (v) headers.set(k, v);
  }
  let up;
  try {
    up = await fetch(upstreamBase + "vendor/" + rel, { headers, cache: "no-store" });
  } catch (_) {
    const cached = await caches.match(request);
    return cached || local || new Response(null, { status: 502 });
  }
  // 3) 上流 Response の url は転送先のままなので new Response で包み直す。
  //    このまま返すとモジュールの import.meta.url がクロスオリジン化し、
  //    Worker 生成が SecurityError で失敗する（url 空=リクエスト URL 扱いに
  //    なるため同一オリジンが維持される）。CORS 応答で読み出せるヘッダは
  //    safelist 分のみだが、モジュール/Worker/WASM 読み込みには content-type
  //    があれば足りる
  const wrapped = new Response(up.body, {
    status: up.status,
    statusText: up.statusText,
    headers: up.headers,
  });
  // 4) 成功応答は CDN 不通時の保険としてキャッシュ（no-store で毎回新規取得する
  //    ため stable チャンネル更新後の陳腐化は起きない）
  if (up.ok && request.method === "GET") {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, wrapped.clone());
  }
  return wrapped;
}
