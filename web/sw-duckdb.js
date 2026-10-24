// DuckDB-WASM の CDN 資産(~60MB)を CacheStorage に永続キャッシュする
// Service Worker。初回起動時だけ CDN(jsdelivr/extensions.duckdb.org)から
// 取得し、以後はキャッシュから返す。URL にバージョン(@1.32.0 / v1.4.3)が
// 含まれるためキャッシュキーは URL そのまま使い、activate 時に
// 現バージョンと一致しない古いエントリだけを掃除する。
// 対象: duckdb-wasm 本体(jsdelivr の +esm/dist/*)と拡張(extensions.duckdb.org)。
// ページ・Worker 内のフェッチ(importScripts・拡張 INSTALL の内部取得含む)を
// 透過的に扱う。セキュアコンテキスト(localhost/https)でのみ有効。
const CACHE_NAME = "kasugai-duckdb-wasm";
// 現在使用するバージョン。app.js の DUCKDB_WASM_VERSION・duckdb コアバージョンと同期
const CURRENT_ASSET_MARKERS = [
  "/npm/@duckdb/duckdb-wasm@1.32.0",
  "/v1.4.3/",
];

function isDuckDbAsset(url) {
  return (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/npm/@duckdb/duckdb-wasm@"))
    || url.hostname === "extensions.duckdb.org";
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // 旧バージョンのエントリを削除(同バージョンの資産は残す)
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      await Promise.all(keys.map((request) =>
        CURRENT_ASSET_MARKERS.some((marker) => request.url.includes(marker))
          ? null
          : cache.delete(request)));
    } catch (e) { /* ignore */ }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  let url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (!isDuckDbAsset(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const response = await fetch(event.request);
    if (response && response.ok) {
      try { await cache.put(event.request, response.clone()); } catch (e) { /* ignore */ }
    }
    return response;
  })());
});
