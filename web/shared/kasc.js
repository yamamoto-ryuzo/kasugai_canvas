// .kasc 行パーサー + プロジェクトローダー（エンジン非依存コア）
// 行形式: 種類:タイトル|URL|出典|オプション名=値|on/off   （docs/inspector.html 参照）
// 対象: /projects/<id>/ の標準プロジェクト（外部登録プロジェクトの @parent 解決は未対応）

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
  const doc = { layers: [], bases: [], cams: [], unsupported: [], background: null, info: null, legends: [] };
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
      doc.legends.push({ title: parts[0], url: parts[1] });
      continue;
    }

    const item = classifyParts(parts.slice(1), {
      type,
      title: parts[0] || "",
      url: type === "sql" ? parts.slice(1).join("|") : (parts[1] || ""),
      line,
    });
    if (type === "base") {
      // base: 表示名 | transparent | none は URL ではなくモード指定
      const mode = parts[1] && parts[1].toLowerCase();
      if (mode === "transparent" || mode === "none") item.mode = mode;
      doc.bases.push(item);
      continue;
    }
    if (["xyz", "geojson", "layer", "geoparquet", "parquet", "flatgeobuf", "fgb",
         "gpkg", "geopackage", "csv", "tsv", "duckdb", "sql"].includes(type)) {
      doc.layers.push(item);
      continue;
    }
    // このコアでは未対応の行タイプ（geoparquet/flatgeobuf/gpkg/duckdb/sql/
    // 3dtiles/fly_geojson/plugin/cloud/yahooappid 等）は呼び出し側へ通知
    doc.unsupported.push(item);
  }
  return doc;
}

// .kasc 内の参照を絶対 URL へ解決する。
// 相対パスは projectBaseUrl(/projects/<id>/) 基準。`..` はブラウザの URL 正規化で
// projects/ 直下（=全プロジェクト共有）に畳まれる
export function resolveKascUrl(url, projectBaseUrl) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || url.startsWith("data:") || url.startsWith("blob:")) return url;
  return new URL(url, location.origin + projectBaseUrl).href;
}

// プロジェクト一覧と .kasc を読み込む。
// ?project=<id> 指定があればそれを、なければマニフェスト先頭（または default）
export async function loadKascProject(projectId) {
  let manifest = [];
  try {
    const res = await fetch("/projects/projects.json", { cache: "no-store" });
    if (res.ok) manifest = await res.json();
  } catch (_) { /* 静的配信で一覧が無い場合もあり得る */ }

  const requested = projectId || new URLSearchParams(location.search).get("project");
  const id = requested || (manifest[0] && (manifest[0].id || manifest[0])) || "default";
  const baseUrl = `/projects/${encodeURIComponent(id)}/`;
  const res = await fetch(`${baseUrl}kasugai_canvas.kasc`, { cache: "no-store" });
  if (!res.ok) throw new Error(`.kasc を読み込めません: ${baseUrl}kasugai_canvas.kasc (${res.status})`);
  const text = await res.text();
  return { id, manifest, baseUrl, doc: parseKasc(text), raw: text };
}

// カメラ高さ(m) → Web メルカトルズームの近似変換
// m/px ≈ height * 2 / 256（視野角45°・画面高512px相当の近似）
export function camToZoom(cam) {
  const lat = Math.max(-80, Math.min(80, cam.latitude || 0));
  const h = Math.max(10, cam.height || 3000);
  const zoom = Math.log2((156543.03392 * Math.cos(lat * Math.PI / 180)) / (h * 2 / 256));
  return Math.max(2, Math.min(20, zoom));
}
