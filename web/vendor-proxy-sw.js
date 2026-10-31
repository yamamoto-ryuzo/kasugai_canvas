// KASUGAI Canvas — vendor 同一オリジン・プロキシ Service Worker
// web/vendor/ は配布物・リポジトリ・CDN のいずれにも実体を置かない。
// この SW がスコープ配下の vendor/* GET/HEAD を拾い、上流オリジナル
// (vendor.json のピン先)からそのまま供給する。応答はページと同一オリジン
// として返るため、importmap・Worker(import.meta.url 相対)・iframe 制御
// (GSI.GLOBALS) の同一オリジン制約を満たしたまま外部 CDN 直読みができる。
// navara 等の index.html ガードが登録する（登録されない環境では無害に無効）。
//
// upstream 解決（既定 = オリジナル直読み）:
//   vendor/<name>/<rest> → スコープ直下 <name>/vendor.json のピンへ解決
//     npm ピン(navara):     https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<tail>
//     github ピン(gsimaps): https://cdn.jsdelivr.net/gh/<repo>@<sha>/<rest>
//       → 失敗時 raw.githubusercontent.com/<repo>/<sha>/<rest> に再試行
//   SW スクリプト URL に ?u=<base> が明示指定された場合はミラーモード:
//   <base>/vendor/<rel> をそのまま参照する（自前ミラー・オフライン開発用。
//   postMessage だと初回プローブと競合し得るため URL クエリで渡す）。
const mirrorBase = (() => {
  const u = new URL(self.location.href).searchParams.get("u");
  return u && /^https:\/\/[\w.-]+(?::\d+)?\//.test(u)
    ? u.replace(/\/?$/, "/")
    : null; // 未指定 = オリジナル直読みモード
})();
const JSDELIVR = "https://cdn.jsdelivr.net/";
const RAW_GH = "https://raw.githubusercontent.com/";
const CACHE_NAME = "kasugai-vendor-v1";

// jsdelivr/gh・raw.githubusercontent は Content-Type: text/plain を返すため、
// 包み直す応答の Content-Type は拡張子で決め打ちする（module script・
// Worker・<link>・iframe は MIME 厳格判定で text/plain だと拒否される）
const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  geojson: "application/geo+json", topojson: "application/json; charset=utf-8",
  wasm: "application/wasm",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  glsl: "text/plain; charset=utf-8", vert: "text/plain; charset=utf-8",
  frag: "text/plain; charset=utf-8", wgsl: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  xml: "application/xml; charset=utf-8", kml: "application/vnd.google-earth.kml+xml",
  pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
  ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
};

function contentTypeFor(path, upstreamType) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const t = m && MIME[m[1].toLowerCase()];
  return t || upstreamType || "application/octet-stream";
}

// <scope>/<engine>/vendor.json を遅延読み込みしてピン情報をキャッシュ
let specPromise = null;
function vendorSpecs() {
  if (!specPromise) {
    specPromise = (async () => {
      const out = {};
      for (const name of ["gsimaps", "navara"]) {
        try {
          const r = await fetch(
            new URL(name + "/vendor.json", self.registration.scope),
            { cache: "no-store" });
          if (r.ok) out[name] = await r.json();
        } catch (_) {}
      }
      return out;
    })();
  }
  return specPromise;
}

// vendor/<name>/<rest> を上流 URL 候補列へ解決（先頭から順に試す）
async function upstreamUrls(rel) {
  if (mirrorBase) return [mirrorBase + "vendor/" + rel];
  const i = rel.indexOf("/");
  const name = i < 0 ? rel : rel.slice(0, i);
  const rest = rel.slice(name.length + 1);
  const spec = (await vendorSpecs())[name];
  const urls = [];
  if (spec && spec.npm) {
    // npm ピン: パッケージ名は先頭1セグメント(@scope なら2セグメント)
    const segs = rest.split("/");
    const n = segs[0] && segs[0].startsWith("@") ? 2 : 1;
    const pkg = segs.slice(0, n).join("/");
    const ver = spec.npm[pkg];
    if (ver) urls.push(JSDELIVR + "npm/" + pkg + "@" + ver + "/" +
      segs.slice(n).join("/"));
  } else if (spec && spec.repo) {
    const ref = spec.sha || spec.ref;
    urls.push(
      JSDELIVR + "gh/" + spec.repo + "@" + ref + "/" + rest,
      RAW_GH + spec.repo + "/" + ref + "/" + rest);
  }
  return urls;
}

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
  // Range/条件付きを転送。SW 内の fetch は自 SW を再経由しないため
  // 素通しでオリジンへ届く
  const headers = new Headers();
  for (const k of ["range", "if-none-match", "if-modified-since"]) {
    const v = request.headers.get(k);
    if (v) headers.set(k, v);
  }
  let up = null;
  try {
    for (const u of await upstreamUrls(rel)) {
      try {
        const r = await fetch(u, { headers, cache: "no-store" });
        if (r.ok || r.status === 304) { up = r; break; }
        if (!up) up = r; // 最後の応答をエラー返却用に保持
      } catch (_) {}
    }
  } catch (_) {}
  if (!up) {
    const cached = await caches.match(request);
    return cached || new Response(null, { status: 502 });
  }
  // 上流 Response を包み直して同一オリジン化する（url は転送先のままなので
  // new Response で包む。import.meta.url がクロスオリジン化すると Worker
  // 生成が SecurityError で失敗するため）。
  // CORS 応答で読み出せるのは safelist ヘッダのみだが、モジュール/Worker/
  // WASM には content-type があれば足りる。nosniff 付き text/plain 対策として
  // Content-Type は拡張子で上書きする
  const h = new Headers(up.headers);
  h.set("content-type", contentTypeFor(rel, up.headers.get("content-type")));
  h.delete("x-content-type-options");
  const wrapped = new Response(up.body, {
    status: up.status,
    statusText: up.statusText,
    headers: h,
  });
  // 成功応答は上流不通時の保険としてキャッシュ（no-store で毎回新規取得する
  // ためピン更新後の陳腐化は起きない）
  if (up.ok && request.method === "GET") {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, wrapped.clone());
  }
  return wrapped;
}
