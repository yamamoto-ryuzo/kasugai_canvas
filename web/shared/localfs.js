// ローカルフォルダ直読み(File System Access API)。
// ホスト版エンジンが .kasc+DATA/ を「localfs:///」疑似URL経由で読む土台。
// - localfs:///path は fetch シムが選択済みフォルダハンドルから読む
// - 相対参照(DATA/x 等)はブラウザのURL解決に任せる(通常の ?kasc= と同型)
// - ハンドルは IndexedDB に保持し、次回は「前回のフォルダで開く」1クリック
// - Chromium 系のみ(Firefox/Safari は showDirectoryPicker 非対応)
// - `<img>` 等のサブリソースは通らないためローカルXYZタイルツリーは未対応
//   (fetch 経由のデータ参照のみ有効)

let rootHandle = null;

export function localfsAvailable() {
  return !!window.showDirectoryPicker;
}

export function getRootHandle() {
  return rootHandle;
}
export function setRootHandle(h) {
  rootHandle = h;
}

// 選択フォルダ内の .kasc を探して localfs:// URL を返す
export async function findKascUrl(dir) {
  try {
    await dir.getFileHandle("kasugai_canvas.kasc");
    return "localfs:///kasugai_canvas.kasc";
  } catch (_) { /* 標準名が無ければフォルダ走査 */ }
  for await (const h of dir.values()) {
    if (h.kind === "file" && /\.kasc$/i.test(h.name)) {
      return "localfs:///" + h.name;
    }
  }
  return null;
}

const _MIME = {
  geojson: "application/geo+json", json: "application/json",
  kasc: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values",
  xml: "application/xml", qml: "application/xml", html: "text/html",
  txt: "text/plain", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  svg: "image/svg+xml", gltf: "model/gltf+json", glb: "model/gltf-binary",
  b3dm: "application/octet-stream", pnts: "application/octet-stream",
  i3dm: "application/octet-stream", cmpt: "application/octet-stream",
  gpkg: "application/x-sqlite3", fgb: "application/octet-stream",
  parquet: "application/octet-stream", wasm: "application/wasm",
};

// localfs:///DATA/x.geojson → 選択フォルダハンドルから File を取る
async function _fileFor(url) {
  if (!rootHandle) throw new Error("フォルダ未選択");
  const rel = url.slice("localfs://".length);
  const parts = decodeURIComponent(rel)
    .split("/").filter(s => s && s !== ".");
  let h = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    h = await h.getDirectoryHandle(parts[i]);
  }
  return (await h.getFileHandle(parts[parts.length - 1])).getFile();
}

// window.fetch を localfs:// 対応に包む(1度だけ有効化)。
// fetch() 経由の読み込み(.kasc・geojson・gpkg・fgb・parquet・qml 等)は全て
// このシムがフォルダハンドルへ流す。https?:// は素通し
let _installed = false;
export function installFetchShim() {
  if (_installed) return;
  _installed = true;
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.startsWith("localfs://")) {
      return _fileFor(url).then(f => {
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        return new Response(f, {
          status: 200,
          headers: {
            "Content-Type": _MIME[ext] || "application/octet-stream",
            "Content-Length": String(f.size),
          },
        });
      });
    }
    return orig.call(this, input, init);
  };
}

// ---- IndexedDB: フォルダハンドルの永続化 ----
const _IDB = "kasugai-localfs", _KEY = "dir";
function _idbOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(_IDB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function _idbGet(key) {
  try {
    const db = await _idbOpen();
    return await new Promise(res => {
      const tx = db.transaction("kv", "readonly").objectStore("kv").get(key);
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => res(null);
    });
  } catch (_) { return null; }
}
async function _idbSet(key, val) {
  try {
    const db = await _idbOpen();
    db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
  } catch (_) { /* 永続化失敗は許容 */ }
}

// ---- フォルダ選択オーバーレイ(ジェスチャ確保のためボタン経由) ----
let _overlay = null;
function _showOverlay(dirName) {
  if (_overlay) return _overlay;
  const el = document.createElement("div");
  el.id = "localfs-overlay";
  el.style.cssText =
    "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
    "justify-content:center;background:rgba(15,20,25,.6);font-family:system-ui,sans-serif";
  const box = document.createElement("div");
  box.style.cssText =
    "background:#fff;border-radius:10px;padding:24px 28px;width:360px;max-width:88vw;text-align:center";
  box.innerHTML =
    "<h2 style='margin:0 0 10px;font-size:16px'>ローカルプロジェクトを開く</h2>" +
    "<p style='margin:0 0 12px;font-size:13px'>.kasc のあるフォルダを選択してください" +
    "（DATA/ はフォルダ内から読み込みます）</p>";
  const btn = document.createElement("button");
  btn.textContent = dirName ? `「${dirName}」で開く` : "フォルダを選択";
  btn.style.cssText = "padding:8px 16px;font-size:14px";
  box.appendChild(btn);
  const note = document.createElement("p");
  note.style.cssText = "margin:10px 0 0;font-size:11px;color:#667";
  note.textContent = "（file:// ではなく http 配信のエンジンで動作します）";
  box.appendChild(note);
  el.appendChild(box);
  document.body.appendChild(el);
  _overlay = { el, btn };
  return _overlay;
}
function _hideOverlay() {
  if (_overlay) { _overlay.el.remove(); _overlay = null; }
}

// フォルダ選択(ジェスチャが必要なためオーバーレイボタンを出す)。
// 前回のハンドルが許可済みならオーバーレイ無しでそのまま使う
export async function pickProjectDir() {
  if (rootHandle) return rootHandle;
  const saved = await _idbGet(_KEY);
  if (saved) {
    try {
      if (await saved.queryPermission({ mode: "read" }) === "granted") {
        rootHandle = saved;
        return saved;
      }
    } catch (_) { /* ハンドル失効は選択へ回す */ }
  }
  if (!localfsAvailable()) {
    throw new Error("このブラウザはローカルフォルダ選択(File System Access API)に未対応です");
  }
  const dir = await new Promise((res, rej) => {
    const ov = _showOverlay(saved && saved.name);
    ov.btn.onclick = async () => {
      try {
        let h = saved;
        if (h && (await h.queryPermission({ mode: "read" })) !== "granted") {
          if ((await h.requestPermission({ mode: "read" })) !== "granted") h = null;
        }
        if (!h) h = await window.showDirectoryPicker({ mode: "read" });
        res(h);
      } catch (e) {
        rej(e); // キャンセル時もオーバーレイは残したままエラー返し
      }
    };
  });
  _hideOverlay();
  rootHandle = dir;
  void _idbSet(_KEY, dir);
  return dir;
}

// ?kasc=local の入口: フォルダ選択 → シム有効化 → .kasc の localfs:// URL を返す
export async function openLocalKascUrl() {
  const dir = await pickProjectDir();
  installFetchShim();
  const url = await findKascUrl(dir);
  if (!url) throw new Error("選択フォルダ内に .kasc が見つかりません");
  return url;
}
