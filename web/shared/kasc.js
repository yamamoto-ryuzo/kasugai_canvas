// .kasc 行パーサー + プロジェクトローダー（エンジン非依存コア）
// 行形式: 種類:タイトル|URL|出典|オプション名=値|on/off   （docs/inspector.html 参照）
// 対象: /projects/<id>/ の標準プロジェクト（外部登録プロジェクトの @parent 解決は未対応）
import { backendBaseUrl, detectBackend } from "./backend.js";

const BOOL_RE = /^(on|off|true|false)$/i;
const KV_RE = /^([A-Za-z_][\w-]*)\s*=\s*(.*)$/;

// parts 配列を出典/オプション/表示フラグに分類する。
// kv で始まるトークンは opts へ、on/off/true/false は visible へ、
// それ以外の最初のトークンは出典(attr)として扱う
function classifyParts(parts, item) {
  item.opts = {};
  item.attr = "";
  item.visible = true;
  for (const part of parts) {
    if (!part) continue;
    if (BOOL_RE.test(part)) {
      item.visible = !/^(off|false)$/i.test(part);
      continue;
    }
    const kv = part.match(KV_RE);
    if (kv) {
      item.opts[kv[1].toLowerCase()] = kv[2];
      continue;
    }
    if (!item.attr) item.attr = part;
    else item.opts.extra = item.opts.extra ? item.opts.extra + " | " + part : part;
  }
  return item;
}

function parseCamLine(parts) {
  // cam:名|緯度|経度|h=高さ|p=ピッチ|d=方位
  const cam = { name: parts[0] || "", latitude: Number(parts[1]), longitude: Number(parts[2]) };
  for (const part of parts.slice(3)) {
    const kv = part.match(KV_RE);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = Number(kv[2]);
    if (key === "h") cam.height = value;
    else if (key === "p") cam.pitch = value;
    else if (key === "d") cam.heading = value;
  }
  return cam;
}

// .kasc テキストを構造化する。lines は生の解釈結果、rest は型別の便利マップ
export function parseKasc(text) {
  const doc = { layers: [], bases: [], cams: [], bookmarks: [], unsupported: [], background: null, info: null, legends: [], themes: [], title: null, defaultStyles: { point: null, line: null, polygon: null } };
  let order = 0;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const type = line.slice(0, sep).trim().toLowerCase();
    const parts = line.slice(sep + 1).split("|").map(part => part.trim());

    if (type === "cam") {
      doc.cams.push(parseCamLine(parts));
      continue;
    }
    if (type === "background") {
      doc.background = parts[0] || null;
      continue;
    }
    if (type === "info") {
      doc.info = parts.slice(1).join("|") || parts[0];
      continue;
    }
    if (type === "legend") {
      // legend:<URL>（1フィールド）と legend:タイトル|<URL> の2形式がある
      doc.legends.push(parts[1] ? { title: parts[0], url: parts[1] } : { title: null, url: parts[0] });
      continue;
    }
    if (type === "bookmark") {
      // QGIS ブックマークエクスポート XML(qgis_bookmarks 形式)への参照。
      // bookmark:<URL> / bookmark:タイトル|<URL>。内容はカメラプリセットへ展開
      doc.bookmarks.push(parts[1] ? { title: parts[0], url: parts[1] } : { title: null, url: parts[0] });
      continue;
    }
    if (type === "theme") {
      // theme:名前 | 表示するレイヤタイトル[|タイトル…]（`*` で全表示）
      // QGIS のマップテーマ相当の可視性プリセット。スタイルは含まない
      doc.themes.push({ name: parts[0] || "", layers: parts.slice(1).filter(Boolean), line });
      continue;
    }
    if (type === "title") {
      // title: アプリ表示名 — パネルタイトルとブラウザタブのタイトルを差し替える。
      // 複数行ある場合は最後の行を採用。空値・行なしは既定表示に戻す
      doc.title = line.slice(sep + 1).trim() || null;
      continue;
    }

    const item = classifyParts(type === "sql" ? parts.slice(1) : parts.slice(2), {
      type,
      title: parts[0] || "",
      url: type === "sql" ? parts.slice(1).join("|") : (parts[1] || ""),
      line,
    });
    // 行の出現順（doc.layers と doc.unsupported に分かれても元の並びを復元できる）
    item._idx = order++;
    // sql: には出典スロットが無い（クエリ断片を attr へ誤記録しないよう必ず空にする）
    if (type === "sql") item.attr = "";
    if (type === "base") {
      // base: 表示名 | transparent | none は URL ではなくモード指定
      const mode = parts[1] && parts[1].toLowerCase();
      if (mode === "transparent" || mode === "none") item.mode = mode;
      doc.bases.push(item);
      continue;
    }
    if (["xyz", "tile", "geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb",
         "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql", "wms", "wmts"].includes(type)) {
      doc.layers.push(item);
      continue;
    }
    // default_style: point|line|polygon | key=value…
    // スタイル未指定地物の既定スタイル(地物側 simplestyle や style=QML が優先)
    if (type === "default_style" || type === "defaultstyle") {
      const spec = parseDefaultStyleSpec(parts);
      if (spec) doc.defaultStyles[spec.kind] = spec.values;
      continue;
    }
    // このコアでは未対応の行タイプ（geoparquet/flatgeobuf/gpkg/duckdb/sql/
    // 3dtiles/fly_geojson/plugin/cloud/yahooappid 等）は呼び出し側へ通知
    doc.unsupported.push(item);
  }
  return doc;
}

// 可視性フラグ(on/off)の書き換え対象外となる非レイヤ行タイプ。
// これ以外の既知・未知の行タイプはすべて「表示を持つレイヤ行」として扱う
const NON_LAYER_TYPES = new Set([
  "cam", "background", "info", "legend", "theme", "base",
  "bookmark", "cloud", "plugin", "yahooappid", "title",
]);

// .kasc 1行の可視性フラグを書き換えて返す。
// show は「表示するタイトル」の Set、null/undefined なら全表示(`*` 相当)。
// レイヤ行は末尾の既存 on/off/true/false トークンを除去した上で、
// 非表示なら `| off` を付与、表示ならフラグなし(既定=on)に戻す。
// 非レイヤ行・コメント・空行はそのまま返す。
export function rewriteKascLineVisibility(line, show) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return line;
  const sep = trimmed.indexOf(":");
  if (sep < 0) return line;
  const type = trimmed.slice(0, sep).trim().toLowerCase();
  if (NON_LAYER_TYPES.has(type)) return line;
  const fields = trimmed.split("|").map(f => f.trim());
  // タイトルは / 区切りの空白揺れを正規化して照合する。
  // show は正規化済みキー(フルパス+葉名)を含む前提
  const rawTitle = (fields[0].slice(fields[0].indexOf(":") + 1) || "").trim();
  const title = rawTitle.split("/").map(s => s.trim()).join("/");
  const leaf = title.split("/").pop();
  const visible = show == null ? true : (show.has(title) || show.has(leaf));
  if (BOOL_RE.test(fields[fields.length - 1] || "")) fields.pop();
  if (!visible) fields.push("off");
  return fields.join(" | ");
}

// .kasc テキスト全体のレイヤ行の可視性フラグを書き換えて返す。
// show は「表示するタイトル」の Set/配列、null/undefined で全表示。
export function rewriteKascVisibility(text, show) {
  const set = show == null ? null : (show instanceof Set ? show : new Set(show));
  return String(text || "").split(/\r?\n/)
    .map(line => rewriteKascLineVisibility(line, set))
    .join("\n");
}

// ---- theme: 行（QGIS マップテーマ相当の可視性プリセット）の共通処理 ----

// 照合キー正規化: "/"区切りタイトルの空白揺れを吸収する
export function normKascTitle(title) {
  return String(title || "").split("/").map(s => s.trim()).join("/");
}

// theme エントリ → 「表示するタイトル」の照合セット（正規化フルパス+葉名）。
// `*` を含む場合は null（全表示）を返す。rewriteKascVisibility へもそのまま渡せる
export function themeShowSet(theme) {
  const layers = theme?.layers || [];
  if (layers.includes("*")) return null;
  const show = new Set();
  for (const k of layers) {
    const n = normKascTitle(k);
    if (!n) continue;
    show.add(n);
    show.add(n.split("/").pop());
  }
  return show;
}

// レイヤタイトルがテーマの表示対象か（フルパスまたは葉名で一致）
export function kascTitleInTheme(title, show) {
  const n = normKascTitle(title);
  return show.has(n) || show.has(n.split("/").pop());
}

// #theme-select の中身を構築する。themes が空なら非表示化
export function fillThemeSelect(select, themes, promptText = "テーマを選択") {
  if (!select) return;
  select.innerHTML = "";
  if (!themes?.length) { select.hidden = true; return; }
  const prompt = document.createElement("option");
  prompt.value = "";
  prompt.textContent = promptText;
  select.append(prompt);
  for (const theme of themes) {
    const opt = document.createElement("option");
    opt.value = theme.name;
    opt.textContent = theme.name;
    select.append(opt);
  }
  select.hidden = false;
}

// title: 行 → パネルタイトルとブラウザタブ(document.title)へ反映する。
// .panel-title-text は「テキスト + <small>エンジン名</small>」構造(全エンジン共通)
// を想定し、<small> 手前のテキストノードだけを差し替えてエンジン名は残す。
// 空値・行なしはページ初期表示のタイトルへ戻す
let defaultPanelTitle = null;
let defaultDocumentTitle = null;
export function applyPanelTitle(title) {
  const el = document.querySelector(".panel-title-text");
  if (!el) return;
  const small = el.querySelector("small");
  if (defaultPanelTitle == null) {
    const node = small ? Array.from(el.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) : null;
    defaultPanelTitle = (node ? node.textContent : el.textContent).trim() || "KASUGAI Canvas";
  }
  if (defaultDocumentTitle == null) defaultDocumentTitle = document.title;
  const text = String(title || "").trim() || defaultPanelTitle;
  const label = text + (small ? " " : "");
  const texts = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
  const node = texts.find(n => n.textContent.trim()) || texts[0];
  if (node) node.textContent = label;
  else if (small) small.before(document.createTextNode(label));
  else el.textContent = text;
  // 省略表示(text-overflow:ellipsis)時にホバーで全文を見られるよう title を付ける
  el.title = text;
  document.title = text === defaultPanelTitle ? defaultDocumentTitle : text;
}

// projects/ 静的配信への基準パス。各エンジンのページは <root>/<stage>/<engine>/
// にあるため ../projects でルート配信(localhost)・ステージ配信(CDN)の両方を
// カバーする。ローカルアプリをバックエンド検出した環境ではそちらの
// /projects/ へ向ける（静的＋外部登録プロジェクトをマージした一覧が返り、
// QGIS 出力等のローカル .kasc+DATA/ もホスト版エンジンから読める）。
// baseUrl は絶対 URL で返し、呼び出し側の URL 解決を統一する
export const PROJECTS_MANIFEST_URL = "../projects/projects.json";
export function projectsManifestUrl() {
  return backendBaseUrl()
    ? `${backendBaseUrl()}/projects/projects.json`
    : PROJECTS_MANIFEST_URL;
}
export function projectsBaseUrl(id = "default") {
  const base = backendBaseUrl();
  return base
    ? `${base}/projects/${encodeURIComponent(id || "default")}/`
    : new URL(`../projects/${encodeURIComponent(id || "default")}/`, location.href).href;
}
// projectsBaseUrl と同じ解決をページオリジン(=配信元)側へ固定して行う。
// ローカルアプリへ向けて存在しないプロジェクトを CDN 側で探すフォールバック用
export function hostedProjectsBaseUrl(id = "default") {
  return new URL(`../projects/${encodeURIComponent(id || "default")}/`, location.href).href;
}

// .kasc 内の参照を絶対 URL へ解決する。
// 相対パスは projectBaseUrl(/projects/<id>/ または ?kasc= 用の絶対URL) 基準。
// `..` はブラウザの URL 正規化で1階層上（共有 DATA/ 等）に畳まれる
export function resolveKascUrl(url, projectBaseUrl) {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // http/data/blob/localfs 等は素通し
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(projectBaseUrl || ""))
    ? projectBaseUrl
    : new URL(String(projectBaseUrl || "./"), location.href).href;
  return new URL(url, base).href;
}

// .kasc と同じフォルダの project.json から表示タイトルを取る。
// geo_webview 等が .kasc+DATA/ と一緒に出力する {"title": ...} を使い、
// 無ければ null（呼び出し側は .kasc ファイル名へフォールバックする）
export async function fetchKascProjectTitle(baseUrl) {
  try {
    const res = await fetch(new URL("project.json", baseUrl).href, { cache: "no-store" });
    if (!res.ok) return null;
    const title = (await res.json())?.title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch (_) {
    return null;
  }
}

// .kasc の URL をプロジェクトとして読み込む(?kasc= モード)。
// DATA/ 等の相対参照は .kasc のある URL を基準に解決されるため、
// projects/ 構造を持たない任意フォルダを静的配信するだけで動く。
// ?kasc=local はローカルフォルダ直読み(File System Access API):
// ホスト版ページが選択フォルハンドル内の .kasc+DATA/ を fetch シムで読む
async function loadKascUrl(kascParam) {
  if (kascParam === "local" || kascParam === "localfs") {
    const { openLocalKascUrl } = await import("./localfs.js");
    kascParam = await openLocalKascUrl();
  } else if (kascParam.startsWith("localfs://")) {
    // 共有URL/再読込で localfs:// が残った場合もフォルダ選択から復帰する
    const lf = await import("./localfs.js");
    await lf.pickProjectDir();
    lf.installFetchShim();
  }
  const kascUrl = new URL(kascParam, location.href).href;
  let res;
  try {
    res = await fetch(kascUrl, { cache: "no-store" });
  } catch (e) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(kascUrl))
      throw new Error(
        ".kasc を読み込めません(ローカルサーバーへの接続がブラウザにブロックされました)。" +
        "アドレスバー左のサイト設定で「ローカルネットワークアクセス」を許可してください: " + kascUrl);
    throw e;
  }
  if (!res.ok) throw new Error(`.kasc を読み込めません: ${kascUrl} (${res.status})`);
  const text = await res.text();
  const baseUrl = new URL("./", kascUrl).href;
  const title = await fetchKascProjectTitle(baseUrl);
  const name = decodeURIComponent(
    new URL(kascUrl).pathname.split("/").pop() || "")
    .replace(/\.kasc$/i, "") || "kasc";
  let manifest = [];
  try {
    const res2 = await fetch(projectsManifestUrl(), { cache: "no-store" });
    if (res2.ok) manifest = await res2.json();
  } catch (_) { /* 静的配信で一覧が無い場合もあり得る */ }
  // 選択中プロジェクトとして一覧へ表示できるよう先頭に仮エントリを足す
  if (!manifest.some(e => (e.id || e) === name)) {
    manifest.unshift({ id: name, title: title || name, external: true });
  }
  // id がファイル名由来の仮名のため、?project=<name> へのURL生成・再選択・
  // 共有URLから復帰できるよう .kasc の URL を記憶しておく
  try {
    lastKascUrl = kascUrl;
    lastKascName = name;
    localStorage.setItem(`kasc:lastProjectUrl:${name}`, kascUrl);
  } catch (e) {}
  return { id: name, title: title || name, manifest, baseUrl, doc: parseKasc(text), raw: text, kascUrl };
}

// ?kasc= で読んだ直近の .kasc URL とファイル名由来の仮 id。
// ?project=<name> 形式のURL（共有・仮エントリ再選択）を ?kasc= へ復元する
let lastKascUrl = null;
let lastKascName = null;
export function rememberedKascUrl(name) {
  if (lastKascName === name && lastKascUrl) return lastKascUrl;
  try { return localStorage.getItem(`kasc:lastProjectUrl:${name}`); } catch (e) { return null; }
}

// プロジェクト一覧と .kasc を読み込む。
// 優先順位: 明示引数 > ?kasc=<url> > ?project=<id> > マニフェスト先頭(default)
export async function loadKascProject(projectId) {
  // projects/ の向き先（同一オリジン or ローカルアプリ）を決めるため、
  // バックエンド検出を先に確定する（検出 Promise はモジュール内で共有済み）
  await detectBackend();
  const params = new URLSearchParams(location.search);
  const kascParam = params.get("kasc");
  if (kascParam && !projectId) return loadKascUrl(kascParam);

  let manifest = [];
  try {
    const res = await fetch(projectsManifestUrl(), { cache: "no-store" });
    if (res.ok) manifest = await res.json();
  } catch (_) { /* 静的配信で一覧が無い場合もあり得る */ }

  const requested = projectId || params.get("project");
  const id = requested || (manifest[0] && (manifest[0].id || manifest[0])) || "default";
  let baseUrl = projectsBaseUrl(id);
  let res = await fetch(`${baseUrl}kasugai_canvas.kasc`, { cache: "no-store" });
  if (!res.ok && backendBaseUrl()) {
    // 配信元にのみ存在するプロジェクトをローカルアプリへ向けて失敗した
    // 場合は、配信元側でも探す（CDN 専用プロジェクトの直リンク対策）
    const fallback = hostedProjectsBaseUrl(id);
    const res2 = await fetch(`${fallback}kasugai_canvas.kasc`, { cache: "no-store" }).catch(() => res);
    if (res2.ok) {
      baseUrl = fallback;
      res = res2;
    }
  }
  if (!res.ok && requested) {
    // id が .kasc ファイル名由来の仮名（?project=<ファイル名> の共有URLや
    // ?kasc= 仮エントリの再選択）だった場合、記憶した .kasc URL から復元する
    const saved = rememberedKascUrl(requested);
    if (saved) return loadKascUrl(saved);
  }
  if (!res.ok) throw new Error(`.kasc を読み込めません: ${baseUrl}kasugai_canvas.kasc (${res.status})`);
  const text = await res.text();
  return { id, manifest, baseUrl, doc: parseKasc(text), raw: text };
}

// wms: 行 → WMS GetMap タイル URL テンプレートを組み立てる。
// url が既に BBOX=/{bbox…} を含む完全テンプレートならそのまま返す。
// bboxToken には呼び出し側エンジンのプレースホルダを渡す:
//   MapLibre raster: "{bbox-epsg-3857}"
//   Cesium UrlTemplateImageryProvider:
//     "{westProjected},{southProjected},{eastProjected},{northProjected}"
// opts: layers/styles/format/transparent/version(既定1.1.1)/tilesize(既定256)
// version が 1.3.x の場合は CRS=、それ以外は SRS= パラメータを使う。
// 追加の拡張パラメータ(theme= 等)は url 側に ?key=value で付ければ
// 標準パラメータと & で連結される
export function buildWmsTileTemplate(url, opts = {}, bboxToken = "{bbox-epsg-3857}") {
  if (!url) return url;
  if (/[?&]bbox=/i.test(url) || /\{bbox/i.test(url)) return url;
  const version = String(opts.version || "1.1.1").trim();
  const srsKey = /^1\.3/.test(version) ? "CRS" : "SRS";
  const transparent = /^(false|0|off)$/i.test(String(opts.transparent ?? "true")) ? "FALSE" : "TRUE";
  const size = Number(opts.tilesize || opts.tileSize) || 256;
  const params = [
    "SERVICE=WMS",
    "VERSION=" + encodeURIComponent(version),
    "REQUEST=GetMap",
    "LAYERS=" + encodeURIComponent(opts.layers ?? ""),
    "STYLES=" + encodeURIComponent(opts.styles ?? ""),
    "FORMAT=" + encodeURIComponent(opts.format || "image/png"),
    "TRANSPARENT=" + transparent,
    srsKey + "=EPSG:3857",
    "BBOX=" + bboxToken,
    "WIDTH=" + size,
    "HEIGHT=" + size,
  ];
  return url + (url.includes("?") ? "&" : "?") + params.join("&");
}

// wmts: 行 → {z}/{x}/{y} タイル URL テンプレートへ正規化する。
// - URL に {z}/{x}/{y} を含む: そのまま(XYZ テンプレートとして扱う)
// - {TileMatrix}/{TileRow}/{TileCol} を含む RESTful テンプレート:
//   {z}/{y}/{x} へ置換し、{TileMatrixSet}/{Style}/{Format} は opts で埋める
// - それ以外: KVP GetTile エンドポイントとして標準クエリを構築する
//   (opts: layer=/style=/tilematrixset= 既定 EPSG:3857/format=/matrixprefix=)
export function buildWmtsTileTemplate(url, opts = {}) {
  if (!url) return url;
  if (/\{z\}/.test(url) && /\{x\}/.test(url) && /\{y\}/.test(url)) return url;
  if (/\{TileMatrix\}/.test(url) || /\{TileRow\}/.test(url) || /\{TileCol\}/.test(url)) {
    const tms = opts.tilematrixset || opts.matrixset || "EPSG:3857";
    const style = opts.style || "default";
    const fmt = String(opts.format || "png").split("/").pop();
    return url
      .replace(/\{TileMatrixSet\}/g, encodeURIComponent(tms))
      .replace(/\{Style\}/g, encodeURIComponent(style))
      .replace(/\{Format\}/g, fmt)
      .replace(/\{TileMatrix\}/g, "{z}")
      .replace(/\{TileRow\}/g, "{y}")
      .replace(/\{TileCol\}/g, "{x}");
  }
  const layer = opts.layer ?? "";
  const style = opts.style || "default";
  const tms = opts.tilematrixset || opts.matrixset || "EPSG:3857";
  const format = opts.format || "image/png";
  const prefix = opts.matrixprefix || "";
  const params = [
    "SERVICE=WMTS",
    "REQUEST=GetTile",
    "VERSION=1.0.0",
    "LAYER=" + encodeURIComponent(layer),
    "STYLE=" + encodeURIComponent(style),
    "TILEMATRIXSET=" + encodeURIComponent(tms),
    "FORMAT=" + encodeURIComponent(format),
    "TILEMATRIX=" + encodeURIComponent(prefix) + "{z}",
    "TILEROW={y}",
    "TILECOL={x}",
  ];
  return url + (url.includes("?") ? "&" : "?") + params.join("&");
}

// GeoJSON の範囲 {west,south,east,north} を返す（空なら null）
export function geojsonExtent(geojson) {
  let env = null;
  const visit = coords => {
    if (typeof coords?.[0] === "number") {
      const [x, y] = coords;
      if (!env) env = { west: x, south: y, east: x, north: y };
      else { env.west = Math.min(env.west, x); env.south = Math.min(env.south, y); env.east = Math.max(env.east, x); env.north = Math.max(env.north, y); }
      return;
    }
    if (Array.isArray(coords)) coords.forEach(visit);
  };
  for (const f of geojson?.features || []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "GeometryCollection") (g.geometries || []).forEach(x => visit(x.coordinates));
    else visit(g.coordinates);
  }
  return env;
}

// .kasc の出典(attr)に含まれるHTMLを許可リストでサニタイズする。
// <a>/<img>/装飾タグのみ残し、URLスキームを検証する（Cesium 版と同規則）
const ATTR_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "sub", "sup", "br", "span", "small", "img"]);
const ATTR_DROP = new Set(["script", "style", "iframe", "object", "embed", "template"]);
function isSafeAttrUrl(url) {
  return /^https?:/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url);
}
export function sanitizeAttributionFragment(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const clean = parent => {
    const fragment = document.createDocumentFragment();
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        fragment.append(document.createTextNode(child.textContent));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (ATTR_DROP.has(tag)) continue;
        if (!ATTR_TAGS.has(tag)) {
          fragment.append(clean(child));
          continue;
        }
        const el = document.createElement(tag);
        if (tag === "a") {
          const href = (child.getAttribute("href") || "").trim();
          if (isSafeAttrUrl(href)) {
            el.setAttribute("href", href);
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          }
        } else if (tag === "img") {
          const src = (child.getAttribute("src") || "").trim();
          if (isSafeAttrUrl(src)) el.setAttribute("src", src);
          const alt = child.getAttribute("alt");
          if (alt) el.setAttribute("alt", alt);
        }
        const title = child.getAttribute("title");
        if (title) el.setAttribute("title", title);
        el.append(clean(child));
        fragment.append(el);
      }
    }
    return fragment;
  };
  return clean(doc.body);
}

// 行の出典表記を取り出す（出典スロット or attr=/attribution= オプション）
export function layerAttribution(item) {
  return String(item?.attr || item?.opts?.attr || item?.opts?.attribution || "").trim();
}

// ---- info: 行の外部HTML埋め込み（情報タブ） ----
// info: <URL> で指定した HTML 文書を fetch・サニタイズして情報タブへ埋め込む。
// Cesium 版 loadInfoContent と同じ規則を全エンジンで共有する。
// 中身ごと捨てる要素（script のコード文字列や外部リソース読込・フォーム送信を防ぐ）
const INFO_DROP_SELECTOR = "script, iframe, object, embed, form, link, style";
// info HTML 内の相対参照を info 文書の URL 基準で絶対化する属性
const INFO_RESOURCE_ATTRS = new Set(["src", "href", "poster", "background"]);

// 情報HTML内のサブタブ（.tab-button と .tab-content の組）を配線する。
// 対象が無ければ何もしない。Cesium 版 setupInfoTabs と同じ規則
export function setupKascInfoTabs(content) {
  const buttons = [...content.querySelectorAll(".tab-button")];
  const panels = [...content.querySelectorAll(".tab-content")];
  if (!buttons.length || !panels.length) return;
  const activate = index => {
    buttons.forEach((button, i) => button.classList.toggle("active", i === index));
    panels.forEach((panel, i) => {
      panel.classList.toggle("active", i === index);
      panel.hidden = i !== index;
    });
  };
  buttons.forEach((button, index) => button.addEventListener("click", () => activate(index)));
  activate(Math.max(0, buttons.findIndex(button => button.classList.contains("active"))));
}

// 取得済みの info HTML をサニタイズして container へ埋め込む。
// docUrl は info 文書自身の URL（相対 img/href の解決基準。不明なら null 可）
export function embedKascInfoHtml(container, html, docUrl = null) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll(INFO_DROP_SELECTOR).forEach(node => node.remove());
  parsed.querySelectorAll("*").forEach(node => {
    [...node.attributes].forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value || "";
      if (/^on/i.test(name) || /javascript:/i.test(value)) {
        node.removeAttribute(attribute.name);
        return;
      }
      // 相対参照は .kasc ではなく info 文書の URL を基準に解決する。
      // #fragment は同一文書内アンカーとして残す
      if (docUrl && INFO_RESOURCE_ATTRS.has(name) && value && !value.startsWith("#") &&
          !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        try { node.setAttribute(attribute.name, new URL(value, docUrl).href); } catch (_) { /* 不正URLはそのまま */ }
      }
    });
    // パネル内リンクでアプリ自体を遷移させない（target 未指定は新規タブへ）
    if (node.tagName === "A" && !node.getAttribute("target")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  container.replaceChildren(...[...parsed.body.childNodes].map(node => document.importNode(node, true)));
  setupKascInfoTabs(container);
}

// container ごとの読み込みシーケンス。プロジェクト切替等で遅れて届いた
// fetch 結果が新しい内容を上書きしないよう、古い応答を破棄する
const infoLoadSeq = new WeakMap();

// 情報タブを空にし、飛行中の読み込みを無効化する（.kasc 適用時のリセット用）
export function clearKascInfoContent(container) {
  if (!container) return;
  infoLoadSeq.set(container, (infoLoadSeq.get(container) || 0) + 1);
  container.replaceChildren();
}

// info: 行の値（URL または `<` で始まるインラインHTML）を情報タブへ読み込む。
// errorText は失敗時の表示文字列を返す関数（i18n 済みの文言を渡す用）
export async function loadKascInfoContent(container, spec, projectBaseUrl, { errorText } = {}) {
  if (!container) return;
  const seq = (infoLoadSeq.get(container) || 0) + 1;
  infoLoadSeq.set(container, seq);
  container.replaceChildren();
  const value = String(spec || "").trim();
  if (!value) return;
  // インライン HTML（`<` 始まり）は fetch せず直接埋め込む
  if (value.startsWith("<")) {
    embedKascInfoHtml(container, value, null);
    return;
  }
  const url = resolveKascUrl(value, projectBaseUrl);
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(await response.text());
    const html = await response.text();
    if (infoLoadSeq.get(container) !== seq) return;
    embedKascInfoHtml(container, html, url);
  } catch (error) {
    if (infoLoadSeq.get(container) !== seq) return;
    const message = error instanceof Error ? error.message : String(error);
    container.textContent = typeof errorText === "function"
      ? errorText(message)
      : `情報を読み込めませんでした: ${message}`;
  }
}

// .kasc タイトルを グループ/末端名 に分解する（"A/B/C" → グループ "A / B"・末端 "C"。
// 区切りが二重 "//"・"\\" の場合は排他グループ。Cesium 版 parseLayerTitle と同じ規則）
export function splitKascTitle(title) {
  const raw = String(title || "");
  const parts = raw.split(/[\\/]/).map(s => s.trim()).filter(Boolean);
  return {
    title: parts.at(-1) || raw,
    group: parts.slice(0, -1).join(" / "),
    exclusiveGroup: /[\\/]{2}/.test(raw),
  };
}

// "グループ/名前" タイトルの候補群を <select> へ追加する。
// タイトルにグループを含む項目は同名 <optgroup> へ集約し、
// グループ無しの項目はトップレベルの <option> のまま並べる
// （ベースマップ選択のグループ化表示用）。optgroup は初出位置に
// 挿入され、メンバーは元の並び順を保つ。
// makeOption(item, leafTitle, index) が <option> 要素を返す。
export function appendGroupedTitleOptions(select, items, makeOption) {
  const groups = new Map();
  items.forEach((item, index) => {
    const { group, title } = splitKascTitle(item?.title || "");
    const opt = makeOption(item, title, index);
    if (!opt) return;
    if (!group) { select.append(opt); return; }
    if (!groups.has(group)) {
      const og = document.createElement("optgroup");
      og.label = group;
      groups.set(group, og);
      select.append(og);
    }
    groups.get(group).append(opt);
  });
}

// select 単位の折りたたみ状態(WeakMap で再描画・プロジェクト切替後も保持)
const _basemapListState = new WeakMap();

// <select>(optgroup 対応)をミラーする折りたたみ可能なリスト UI
// (.basemap-list) を select の親内へ同期描画する。
// - optgroup が無い場合は素の select を表示し、リストは除去する
// - optgroup がある場合は select を隠し、グループ見出し(▸/▾で
//   折りたたみ)付きのリストへ置き換える。グループは初期状態で閉じ
//   (expanded に含まれるもののみ展開)。先頭の「すべて展開」
//   「すべて閉じる」ボタンで一括操作できる
// - 項目クリックは select.value 更新 + change 発火なので、
//   既存の select.onchange ハンドラ・AI 制御がそのまま動く
// - labels.expandAll / labels.collapseAll でボタン文言を上書きできる
export function syncBasemapList(select, labels) {
  if (!select?.parentElement) return null;
  const container = select.parentElement;
  let list = container.querySelector(".basemap-list");
  if (!select.querySelector("optgroup")) {
    list?.remove();
    select.hidden = false;
    return null;
  }
  select.hidden = true;
  if (!list) {
    list = document.createElement("div");
    list.className = "basemap-list";
    select.after(list);
  }
  let st = _basemapListState.get(select);
  if (!st) {
    // 初期表示は選択中の1レイヤのみを示す畳み状態(open=false)に統一し、
    // クリックで一覧を展開する
    st = { expanded: new Set(), open: false, changeBound: false };
    _basemapListState.set(select, st);
  }
  if (!st.changeBound) {
    // select 側からの変更(AI/プログラム操作)にも選択ハイライトを追従
    select.addEventListener("change", () => {
      list.querySelectorAll(".basemap-item").forEach(el =>
        el.classList.toggle("selected", el.dataset.value === select.value));
    });
    st.changeBound = true;
  }
  list.replaceChildren();
  if (!st.open) {
    // 選択後の畳み状態: 現在値だけを1行表示し、クリックで一覧を再展開
    const cur = document.createElement("div");
    cur.className = "basemap-item selected basemap-current";
    const selOpt = [...select.options].find(o => o.value === select.value)
      || select.selectedOptions?.[0];
    const og = selOpt?.parentElement;
    const tg = document.createElement("span");
    tg.className = "basemap-group-toggle";
    tg.textContent = "▸";
    cur.append(tg, document.createTextNode(
      og?.tagName === "OPTGROUP"
        ? og.label + "/" + selOpt.textContent
        : (selOpt?.textContent || "")));
    cur.addEventListener("click", () => {
      st.open = true;
      syncBasemapList(select, labels);
    });
    list.append(cur);
    return list;
  }
  const groupNames = [...select.querySelectorAll("optgroup")]
    .map(o => o.label);
  if (groupNames.length) {
    const tools = document.createElement("div");
    tools.className = "basemap-list-tools";
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "basemap-tool";
    expand.textContent = labels?.expandAll || "すべて展開";
    expand.addEventListener("click", () => {
      groupNames.forEach(g => st.expanded.add(g));
      syncBasemapList(select, labels);
    });
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "basemap-tool";
    collapse.textContent = labels?.collapseAll || "すべて閉じる";
    collapse.addEventListener("click", () => {
      st.expanded.clear();
      syncBasemapList(select, labels);
    });
    tools.append(expand, collapse);
    list.append(tools);
  }
  const makeItem = opt => {
    const row = document.createElement("div");
    row.className = "basemap-item" + (opt.selected ? " selected" : "");
    row.dataset.value = opt.value;
    row.textContent = opt.textContent;
    row.addEventListener("click", () => {
      select.value = opt.value;
      select.dispatchEvent(new Event("change"));
      // 選択後は従来の select と同様、現在値のみ表示する状態へ畳む
      st.open = false;
      syncBasemapList(select, labels);
    });
    return row;
  };
  for (const el of select.children) {
    if (el.tagName === "OPTGROUP") {
      const gname = el.label;
      const collapsed = !st.expanded.has(gname);
      const head = document.createElement("div");
      head.className = "basemap-group-head";
      const toggle = document.createElement("span");
      toggle.className = "basemap-group-toggle";
      toggle.textContent = collapsed ? "▸" : "▾";
      head.append(toggle, document.createTextNode(gname));
      const items = document.createElement("div");
      items.className = "basemap-group-items";
      items.hidden = collapsed;
      for (const opt of el.children) items.append(makeItem(opt));
      head.addEventListener("click", () => {
        if (st.expanded.has(gname)) st.expanded.delete(gname);
        else st.expanded.add(gname);
        syncBasemapList(select, labels);
      });
      list.append(head, items);
    } else if (el.tagName === "OPTION") {
      list.append(makeItem(el));
    }
  }
  return list;
}

// カメラ高さ(m) → Web メルカトルズームの近似変換
// m/px ≈ height * 2 / 256（視野角45°・画面高512px相当の近似）
export function camToZoom(cam) {
  const lat = Math.max(-80, Math.min(80, cam.latitude || 0));
  const h = Math.max(10, cam.height || 3000);
  const zoom = Math.log2((156543.03392 * Math.cos(lat * Math.PI / 180)) / (h * 2 / 256));
  return Math.max(2, Math.min(20, zoom));
}

// Web メルカトルズーム → カメラ高さ(m) の逆変換（camToZoom の逆。URL への height 併記用）
export function zoomToCamHeight(latitude, zoom) {
  const lat = Math.max(-80, Math.min(80, latitude || 0));
  return 156543.03392 * Math.cos(lat * Math.PI / 180) * 128 / Math.pow(2, zoom);
}

// 実ビューポートを考慮した高度⇄ズーム変換。
// camToZoom/zoomToCamHeight は固定近似（画面512px・視野角45°相当）だが、実際の
// 見え方は垂直FOVとキャンバス高で決まる。3Dエンジン(Cesium)で他エンジンと
// スケールを揃えるため、実値で相互変換する版。傾斜時は直下換算の近似。
export function camToZoomView(cam, viewportHeightPx = 512, fovYDeg = 60) {
  const lat = Math.max(-80, Math.min(80, cam.latitude || 0));
  const h = Math.max(1, cam.height || 3000);
  const vh = Math.max(1, viewportHeightPx || 512);
  const mpp = (2 * h * Math.tan(fovYDeg * Math.PI / 360)) / vh;
  const zoom = Math.log2((156543.03392 * Math.cos(lat * Math.PI / 180)) / mpp);
  return Math.max(2, Math.min(20, zoom));
}

export function zoomToCamHeightView(latitude, zoom, viewportHeightPx = 512, fovYDeg = 60) {
  const lat = Math.max(-80, Math.min(80, latitude || 0));
  const vh = Math.max(1, viewportHeightPx || 512);
  const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
  return (mpp * vh) / (2 * Math.tan(fovYDeg * Math.PI / 360));
}

// ---- bookmark: 行（QGIS ブックマークエクスポート XML → カメラプリセット） ----

// qgis_bookmarks XML の sr_id は QGIS 内部 srsid で EPSG とは一致しない。
// この機能で出力する XML は EPSG:4326(srsid=3452) に正規化済みが前提。
// 外部でエクスポートされた XML 用に 3857 と値の大きさによる推定も用意する
const QGIS_SRSID_4326 = 3452;
const QGIS_SRSID_3857 = 3857;
const WEBMERC_R = 6378137;
const mercatorToLon = x => x / WEBMERC_R * 180 / Math.PI;
const mercatorToLat = y => (2 * Math.atan(Math.exp(y / WEBMERC_R)) - Math.PI / 2) * 180 / Math.PI;

// qgis_bookmarks 形式の XML テキスト → [{name, group, xmin..ymax, rotation, srid}]
export function parseQgisBookmarksXml(text) {
  const dom = new DOMParser().parseFromString(String(text || ""), "text/xml");
  if (!dom || dom.querySelector("parsererror")) return [];
  const out = [];
  for (const el of dom.querySelectorAll("bookmark")) {
    const tag = name => (el.getElementsByTagName(name)[0]?.textContent ?? "").trim();
    const [xmin, ymin, xmax, ymax] = ["xmin", "ymin", "xmax", "ymax"].map(t => Number(tag(t)));
    if (![xmin, ymin, xmax, ymax].every(Number.isFinite)) continue;
    out.push({
      name: tag("name"),
      group: tag("project"), // エクスポートXMLでは project 要素にグループ名が入る
      xmin, ymin, xmax, ymax,
      rotation: Number(tag("rotation")) || 0,
      srid: Number(tag("sr_id")) || 0,
    });
  }
  return out;
}

// ブックマーク矩形 → cam プリセット相当オブジェクト。
// height は extent が画面512px相当に収まる近似（camToZoom の逆: m/px≒h*2/256）
export function qgisBookmarkToCam(bm) {
  const { xmin, ymin, xmax, ymax, srid } = bm;
  const mercator = srid === QGIS_SRSID_3857 ||
    (srid !== QGIS_SRSID_4326 &&
      Math.max(Math.abs(xmin), Math.abs(ymin), Math.abs(xmax), Math.abs(ymax)) > 180);
  let longitude, latitude, w, h;
  const extent = {};
  if (mercator) {
    longitude = mercatorToLon((xmin + xmax) / 2);
    latitude = mercatorToLat((ymin + ymax) / 2);
    w = Math.abs(xmax - xmin);
    h = Math.abs(ymax - ymin);
    extent.west = mercatorToLon(Math.min(xmin, xmax));
    extent.east = mercatorToLon(Math.max(xmin, xmax));
    extent.south = mercatorToLat(Math.min(ymin, ymax));
    extent.north = mercatorToLat(Math.max(ymin, ymax));
  } else {
    longitude = (xmin + xmax) / 2;
    latitude = (ymin + ymax) / 2;
    w = Math.abs(xmax - xmin) * 111320 * Math.cos(latitude * Math.PI / 180);
    h = Math.abs(ymax - ymin) * 111320;
    extent.west = Math.min(xmin, xmax);
    extent.east = Math.max(xmin, xmax);
    extent.south = Math.min(ymin, ymax);
    extent.north = Math.max(ymin, ymax);
  }
  const name = (bm.group ? `${bm.group}/` : "") + (bm.name || "Bookmark");
  const cam = {
    name, title: name, latitude, longitude,
    height: Math.max(120, Math.min(20000000, Math.max(w, h) / 4)),
    pitch: -90,
    // ブックマークは本来「範囲」。遷移時に height 近似ではなく範囲フィットを
    // 使い、ズーム規約の異なるエンジン間でも同一の表示に揃えるため保持する
    _extent: extent,
  };
  if (bm.rotation) cam.heading = ((bm.rotation % 360) + 360) % 360;
  return cam;
}

// bookmark: 行の XML を取得してカメラプリセット配列へ展開する。
// specs は parseKasc の doc.bookmarks（{title, url}）。失敗した参照は無視
export async function loadKascBookmarks(specs, projectBaseUrl) {
  const cams = [];
  for (const spec of specs || []) {
    if (!spec?.url) continue;
    try {
      const res = await fetch(resolveKascUrl(spec.url, projectBaseUrl), { cache: "no-store" });
      if (!res.ok) continue;
      // bookmark: 由来であることを UI で区別できるようフラグを付ける
      for (const bm of parseQgisBookmarksXml(await res.text())) {
        const cam = qgisBookmarkToCam(bm);
        cam.bookmark = true;
        cams.push(cam);
      }
    } catch (_) { /* 読めない bookmark: 参照は無視する */ }
  }
  return cams;
}

// cam プリセット配列 → qgis_bookmarks 形式の XML テキスト。
// cam が持つのは中心+高さだけなので extent は逆算する:
// 表示高≒h*4(m・camToZoom 規約)の正方形範囲をEPSG:4326(sr_id=3452)で書く。
// このファイルは bookmark: 行や QGIS のブックマークインポートで再利用できる
export function camsToQgisBookmarksXml(cams) {
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = (cams || [])
    .filter(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
    .map((c, i) => {
      const h = Math.max(10, c.height || 3000);
      const half = h * 2; // 表示高 h*4 の半分
      const dLat = half / 111320;
      const dLon = half / (111320 * Math.cos(c.latitude * Math.PI / 180) || 1e-6);
      const name = c.name || c.title || `cam ${i + 1}`;
      return [
        "  <bookmark>",
        `    <id>{00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}}</id>`,
        `    <name>${esc(name)}</name>`,
        "    <project></project>",
        `    <xmin>${c.longitude - dLon}</xmin>`,
        `    <ymin>${c.latitude - dLat}</ymin>`,
        `    <xmax>${c.longitude + dLon}</xmax>`,
        `    <ymax>${c.latitude + dLat}</ymax>`,
        `    <rotation>${Number(c.heading) || 0}</rotation>`,
        "    <sr_id>3452</sr_id>",
        "  </bookmark>",
      ].join("\n");
    });
  return "<!DOCTYPE qgis_bookmarks>\n<qgis_bookmarks>\n"
    + items.join("\n") + "\n</qgis_bookmarks>\n";
}

// cam プリセットを qgis_bookmarks XML としてダウンロードする
export function downloadQgisBookmarksXml(cams, filename = "bookmarks.xml") {
  downloadTextFile(camsToQgisBookmarksXml(cams), filename, "text/xml");
}

// cam プリセット → .kasc の cam: 行テキスト(完全往復形式)。
// 緯度・経度・高さ・ピッチ・方位をすべて保持する。インスペクタへ
// 貼り付けたり別プロジェクトへ持ち出す用途
export function camsToKascLines(cams) {
  return (cams || [])
    .filter(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
    .map(c => {
      const name = String(c.name || c.title || "cam").replace(/[|\r\n]+/g, " ").trim() || "cam";
      let line = `cam:${name}|${(+c.latitude).toFixed(6)}|${(+c.longitude).toFixed(6)}`;
      if (Number.isFinite(c.height)) line += `|h=${(+c.height).toFixed(1)}`;
      if (Number.isFinite(c.pitch)) line += `|p=${(+c.pitch).toFixed(2)}`;
      if (Number.isFinite(c.heading)) line += `|d=${(+c.heading).toFixed(2)}`;
      return line;
    }).join("\n") + "\n";
}

// cam プリセットを cam: 行テキストとしてダウンロードする
export function downloadKascCamLines(cams, filename = "cams.txt") {
  downloadTextFile(camsToKascLines(cams), filename, "text/plain");
}

function downloadTextFile(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a); // detached <a> では download が発火しない環境がある
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ビュー状態を表す URL パラメータ（Cesium 版と同形式）の読み書き。
// 形式: #latitude=…&longitude=…&height=…&pitch=…&heading=…（2D エンジンは zoom= も併記）
// pitch/heading は Cesium 規約（pitch: 直下=-90・水平=0、heading: 北=0・時計回り）。
// 読み取りはハッシュ優先・クエリをフォールバックとし、欠けた値は NaN で返す
export function parseUrlView(source = window.location.search + window.location.hash) {
  const hashIndex = source.indexOf("#");
  const searchPart = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const hashPart = hashIndex >= 0 ? source.slice(hashIndex + 1) : "";
  const searchParams = new URLSearchParams(searchPart.startsWith("?") ? searchPart.slice(1) : searchPart);
  const hashParams = new URLSearchParams(hashPart);
  const getNumber = name => {
    const raw = hashParams.get(name) ?? searchParams.get(name);
    const value = Number(raw);
    return raw !== null && raw !== "" && Number.isFinite(value) ? value : NaN;
  };
  return {
    latitude: getNumber("latitude"),
    longitude: getNumber("longitude"),
    zoom: getNumber("zoom"),
    height: getNumber("height"),
    pitch: getNumber("pitch"),
    heading: getNumber("heading"),
  };
}

export function hasUrlView(view) {
  return Number.isFinite(view?.latitude) && Number.isFinite(view?.longitude);
}

// 現在のクエリ（project= 等）を保ちつつビュー状態をハッシュへ反映する。
// パラメータをクエリ側へ置いて来た古い URL 形式もハッシュ側へ寄せる
export function writeUrlView(view, projectId) {
  if (!hasUrlView(view)) return;
  const params = new URLSearchParams(window.location.search);
  ["latitude", "longitude", "zoom", "height", "pitch", "heading"].forEach(key => params.delete(key));
  // 実プロジェクトへ切り替えた時は ?kasc= モードを抜けるため除去する
  if (projectId) { params.set("project", projectId); params.delete("kasc"); }
  const hashParams = new URLSearchParams();
  hashParams.set("latitude", Number(view.latitude).toFixed(6));
  hashParams.set("longitude", Number(view.longitude).toFixed(6));
  if (Number.isFinite(view.zoom)) hashParams.set("zoom", Number(view.zoom).toFixed(3));
  if (Number.isFinite(view.height)) hashParams.set("height", Number(view.height).toFixed(1));
  if (Number.isFinite(view.pitch)) hashParams.set("pitch", Number(view.pitch).toFixed(2));
  if (Number.isFinite(view.heading)) hashParams.set("heading", Number(view.heading).toFixed(2));
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}#${hashParams.toString()}`);
}

// ---- default_style: 行（ベクター地物の既定スタイル）----
// default_style: point|line|polygon | key=value…
// スタイル未指定地物への既定値。地物側の simplestyle(marker-color/stroke/fill 等)
// や style=QML が優先され、ここは「未設定項目」のフォールバックとして働く。
// 値は CSS 色文字列・数値のまま保持し、変換は各エンジンが行う
export function parseDefaultStyleSpec(parts) {
  const token = (parts[0] || "").toLowerCase();
  const kind = /^(point|p|marker|dot)$/.test(token) ? "point"
    : /^(line|l|polyline)$/.test(token) ? "line"
    : /^(polygon|poly|area|fill)$/.test(token) ? "polygon" : null;
  if (!kind) return null;
  const values = {};
  const markerSizes = { small: 24, medium: 48, large: 64 };
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase().replace(/-/g, "_");
    const raw = part.slice(eq + 1).trim();
    if (!raw) continue;
    const number = Number(raw);
    const opacity = Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
    if (kind === "point") {
      if (key === "color" || key === "marker_color" || key === "fill") values.color = raw;
      else if (key === "size" || key === "marker_size") {
        const size = markerSizes[raw.toLowerCase()] ?? number;
        if (Number.isFinite(size) && size > 0) values.size = size;
      }
      else if (key === "symbol" || key === "marker_symbol") values.symbol = raw;
      else if (key === "opacity" && opacity !== null) values.opacity = opacity;
    } else if (kind === "line") {
      if (key === "color" || key === "stroke") values.color = raw;
      else if ((key === "width" || key === "stroke_width") && Number.isFinite(number) && number > 0) values.width = number;
      else if ((key === "opacity" || key === "stroke_opacity") && opacity !== null) values.opacity = opacity;
    } else {
      // polygon: fill/fill_opacity は塗り、stroke/stroke_width/stroke_opacity は輪郭
      if (key === "fill" || key === "color") values.fill = raw;
      else if ((key === "fill_opacity" || key === "opacity") && opacity !== null) values.fillOpacity = opacity;
      else if (key === "stroke" || key === "outline" || key === "outline_color" || key === "line") values.stroke = raw;
      else if ((key === "stroke_width" || key === "outline_width" || key === "width") && Number.isFinite(number) && number > 0) values.strokeWidth = number;
      else if ((key === "stroke_opacity" || key === "outline_opacity") && opacity !== null) values.strokeOpacity = opacity;
    }
  }
  return { kind, values };
}

// CSS 色を {r,g,b(0-255),a(0-1)} へ正規化する(canvas fillStyle の正規化を借用)。
// 解釈できない色は null
let _colorProbe = null;
export function cssColorToRgba(css) {
  try {
    _colorProbe = _colorProbe || document.createElement("canvas").getContext("2d");
    _colorProbe.fillStyle = "#000";
    _colorProbe.fillStyle = String(css);
    const v = _colorProbe.fillStyle;
    let m = /^#([0-9a-f]{8})$/i.exec(v);
    if (m) { const n = parseInt(m[1], 16); return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: (n & 255) / 255 }; }
    m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) { const n = parseInt(m[1], 16); return { r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255, a: 1 }; }
    m = /^rgba?\(([^)]+)\)$/i.exec(v);
    if (m) { const p = m[1].split(",").map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  } catch (_) { /* 不正な色指定は null */ }
  return null;
}
export function cssColorAlpha(css) { return cssColorToRgba(css)?.a ?? 1; }
// CSS 色に不透明度を掛けた rgba() 文字列を返す(色自体のアルファと乗算)
export function cssColorWithAlpha(css, alpha) {
  const c = cssColorToRgba(css);
  if (!c) return css;
  const a = Math.max(0, Math.min(1, c.a * (Number.isFinite(alpha) ? alpha : 1)));
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

// ピンサイズ(px) → 2D エンジンのドット半径(直径≈size/6)
export function defaultPointRadius(pinPx) {
  return Math.max(Math.round((Number(pinPx) || 0) / 6), 2);
}

const _num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// 不透明度の解決: 明示指定(地物 > default_style) > 色のアルファ込みなら1 > エンジン既定。
// エンジン側は「色のアルファ × この opacity」を最終アルファとして描画する
function _effOpacity(ownOpacity, dfltOpacity, winningColor, engineOpacity) {
  if (ownOpacity != null) return ownOpacity;
  if (dfltOpacity != null) return dfltOpacity;
  return cssColorAlpha(winningColor) < 1 ? 1 : engineOpacity;
}
const _MARKER_SIZES = { small: 24, medium: 48, large: 64 };
const _markerSize = v => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : _MARKER_SIZES[String(v || "").toLowerCase()] ?? _num(v));

// 地物 simplestyle > default_style: > engineDefault で各項目を解決する。
// 戻り値は {color,size(px),opacity,symbol} / {color,width,opacity} /
// {fill,fillOpacity,stroke,strokeWidth,strokeOpacity}
export function resolveDefaultPointStyle(props, dflt, engine = {}) {
  const p = props || {};
  const color = p["marker-color"] ?? dflt?.color ?? engine.color;
  return {
    color,
    size: _markerSize(p["marker-size"]) ?? dflt?.size ?? engine.size,
    opacity: _effOpacity(null, dflt?.opacity, color, engine.opacity ?? 1),
    symbol: p["marker-symbol"] ?? dflt?.symbol,
  };
}
export function resolveDefaultLineStyle(props, dflt, engine = {}) {
  const p = props || {};
  const color = p.stroke ?? dflt?.color ?? engine.color;
  return {
    color,
    width: _num(p["stroke-width"]) ?? dflt?.width ?? engine.width,
    opacity: _effOpacity(_num(p["stroke-opacity"]), p.stroke != null ? null : dflt?.opacity, color, engine.opacity ?? 1),
  };
}
export function resolveDefaultPolygonStyle(props, dflt, lineDflt, engine = {}) {
  const p = props || {};
  const fill = p.fill ?? dflt?.fill ?? engine.fill;
  const stroke = p.stroke ?? dflt?.stroke ?? lineDflt?.color ?? engine.stroke;
  return {
    fill,
    fillOpacity: _effOpacity(_num(p["fill-opacity"]), dflt?.fillOpacity, fill, engine.fillOpacity ?? 1),
    stroke,
    strokeWidth: _num(p["stroke-width"]) ?? dflt?.strokeWidth ?? lineDflt?.width ?? engine.strokeWidth,
    strokeOpacity: _effOpacity(_num(p["stroke-opacity"]), p.stroke != null ? null : (dflt?.strokeOpacity ?? lineDflt?.opacity), stroke, engine.strokeOpacity ?? 1),
  };
}
