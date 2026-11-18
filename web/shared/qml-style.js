// QGIS レイヤースタイル(.qml / QGIS Layer Style)のパース・コンパイルと Cesium への適用。
// QGIS 3.x/4.x が出力する <renderer-v2> 形式を対象に、レンダラ(単一/分類/段階/ルール)・
// シンボルレイヤ(マーカー/ライン/塗りつぶし)・データ定義プロパティ・ラベルを
// 「属性 → 正規化スタイル」の関数にコンパイルする。
// Cesium で再現できない要素(ジオメトリジェネレータ・SVGのパス解釈不能なもの等)は
// 最も近い表現にフォールバックし、warnings に記録する。

const Cesium = window.Cesium;

const MM_TO_PX = 96 / 25.4;       // 1mm ≒ 3.78px (96dpi 換算)
const PT_TO_PX = 96 / 72;         // 1pt ≒ 1.33px
// 塗りつぶしパターンの実寸換算に使う仮の参照縮尺(1:S)。QGIS の mm 指定を
// 「S 分の1 の表示縮尺での見た目」に揃えるための近似値
const REFERENCE_SCALE = 10000;
const METERS_PER_PX = 0.00028 * REFERENCE_SCALE; // 1px ≒ 2.8m

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

function warnOnce(warnings, message) {
  if (!warnings.has(message)) warnings.add(message);
}

// エンジン別のラベル機能カバレッジ(警告の出し分け用)。
// hollowHalo: bufferNoFill(中空ハロー)を canvas ラスタライズで描ける
// obstacle: ラベル障害物の扱い。"geo"=投影ジオメトリで実交差判定(cesium)、
// "bbox"=地物 bbox 近似(leaflet)、false=適用されない
// テーブルに無いエンジン(navara/gsimaps)は未対応扱いで警告を出す
const QML_LABEL_CAPS = {
  cesium:     { hollowHalo: true,  obstacle: "geo"  },
  maplibre:   { hollowHalo: true,  obstacle: false  },
  openlayers: { hollowHalo: true,  obstacle: false  },
  leaflet:    { hollowHalo: true,  obstacle: "bbox" },
};

// "r,g,b,a[,spec:...]" / "#rrggbb[aa]" / "r,g,b" → [r,g,b,a] (0-1 float)
function parseQgisColor(value, fallback = null) {
  if (value == null) return fallback;
  const s = String(value).trim();
  if (!s) return fallback;
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const n = parseInt(hex, 16);
    if (Number.isNaN(n)) return fallback;
    if (hex.length === 8) return [((n >> 24) & 255) / 255, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    if (hex.length === 6) return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    return fallback;
  }
  const parts = s.split(",");
  if (parts.length < 3) return fallback;
  const r = Number(parts[0]), g = Number(parts[1]), b = Number(parts[2]);
  if (![r, g, b].every(Number.isFinite)) return fallback;
  // 5つ目以降は "rgb:..." 等のカラースペース注記なので無視
  const a = parts.length >= 4 && parts[3].indexOf(":") < 0 ? Number(parts[3]) : 255;
  return [r / 255, g / 255, b / 255, Number.isFinite(a) ? a / 255 : 1];
}

export function toCesiumColor(rgba) {
  return new Cesium.Color(rgba[0], rgba[1], rgba[2], rgba[3]);
}

function withAlpha(rgba, alpha) {
  return [rgba[0], rgba[1], rgba[2], rgba[3] * alpha];
}

// 0-1 係数の属性値パース。"0" も有効値(完全透明)とし、非数・未指定は fallback
function alphaAttr(v, fallback = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

// fillParts 内の全色へ係数を乗算した新パーツ配列を返す。
// solid だけでなくハッチ/ラインパターン/ポイントパターン/グラデーション/
// 画像パターン(alphaMul)も対象(レイヤ透過度・シンボル alpha 共通)
export function scaleFillPartsAlpha(fillParts, f) {
  if (!Array.isArray(fillParts) || !Number.isFinite(f) || f >= 1) return fillParts;
  const mul = c => (c ? withAlpha(c, f) : c);
  return fillParts.map(pt => {
    if (!pt) return pt;
    const c = { ...pt };
    if (c.solid) c.solid = mul(c.solid);
    if (c.hatch) c.hatch = { ...c.hatch, color: mul(c.hatch.color) };
    if (c.linePattern) c.linePattern = { ...c.linePattern, color: mul(c.linePattern.color) };
    if (c.gradient) c.gradient = { ...c.gradient, color1: mul(c.gradient.color1), color2: mul(c.gradient.color2) };
    if (c.pointPattern) c.pointPattern = { ...c.pointPattern, markers: (c.pointPattern.markers || []).map(m => ({ ...m, alpha: (m.alpha ?? 1) * f })) };
    if (c.imagePattern) c.alphaMul = (c.alphaMul ?? 1) * f;
    return c;
  });
}

// シンボル単位の透明度(spec.alpha)を解決済み spec の全色へ乗算する(破壊的)。
// QGIS のシンボル透過度は塗り・枠線・積層ライン・パターン・生成ジオメトリ
// までシンボル全体に効くため spec 全体を対象にする
export function applySymbolAlpha(spec) {
  const a = Math.max(0, Math.min(1, Number(spec?.alpha)));
  if (!Number.isFinite(a) || a >= 1) return;
  const mul = c => (c ? withAlpha(c, a) : c);
  const mulMarkers = ms => { for (const m of ms || []) m.alpha = (m.alpha ?? 1) * a; };
  if (spec.line) spec.line.color = mul(spec.line.color);
  for (const l of spec.lines || []) { if (l) l.color = mul(l.color); }
  if (spec.outline) spec.outline.color = mul(spec.outline.color);
  mulMarkers(spec.markers);
  mulMarkers(spec.centroid);
  if (spec.fillParts) spec.fillParts = scaleFillPartsAlpha(spec.fillParts, a);
  for (const g of spec.gg || []) {
    if (g.line) g.line.color = mul(g.line.color);
    if (g.outline) g.outline.color = mul(g.outline.color);
    mulMarkers(g.markers);
    if (g.fillParts) g.fillParts = scaleFillPartsAlpha(g.fillParts, a);
  }
}

// QGIS のサイズ単位を px に変換する。MapUnit/MetersInMapUnits は実用上
// 度単位データでは意味を持たないため、近似として px 相当に丸める
function sizeToPx(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  switch (unit) {
    case "MM": return n * MM_TO_PX;
    case "Point": return n * PT_TO_PX;
    case "Pixel": return n;
    case "Inches": return n * 96;
    case "Percentage": return n; // 割合値はpx換算不能(近似:数値をそのまま返す)
    case "MapUnit":
    case "MetersInMapUnits":
    default: return n * MM_TO_PX * 0.3; // 近似: 実用サイズに収める
  }
}

// MapUnit/MetersInMapUnits は px 近似とは別にメートル値も保持し、
// 対応エンジン(Cesium)が距離連動スケーリングで再現する
function mapUnitMeters(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (unit === "MapUnit" || unit === "MetersInMapUnits") ? n : null;
}

// "5;2" のようなカスタムダッシュ(線幅単位)または線種名 → [onPx, offPx, ...]
export function dashPattern(styleName, customDash, widthPx, customUnit = "MM") {
  if (customDash && /^\d/.test(String(customDash))) {
    // カスタム破線は指定単位(既定MM)の絶対長。線幅倍数ではない
    const seg = String(customDash).split(";").map(v => sizeToPx(v, customUnit)).filter(v => v > 0);
    if (seg.length >= 2) return seg;
  }
  switch (String(styleName || "solid").toLowerCase().replace(/[_\s]/g, "")) {
    case "solid": return null;
    case "dash":
    case "dashline": return [4 * widthPx, 2 * widthPx];
    case "dot": return [1.5 * widthPx, 2 * widthPx];
    case "dashdot":
    case "dashdotline": return [4 * widthPx, 2 * widthPx, 1.5 * widthPx, 2 * widthPx];
    case "dashdotdot":
    case "dashdotdotline": return [4 * widthPx, 2 * widthPx, 1.5 * widthPx, 2 * widthPx, 1.5 * widthPx, 2 * widthPx];
    case "nopen":
    case "no": return "none";
    default: return null;
  }
}

// <Option> ツリー → JS 値(Map は再帰、それ以外は value 属性かテキスト)
function optionValue(el) {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "map" || type === "list") {
    const out = type === "map" ? {} : [];
    for (const child of el.children) {
      if (child.tagName !== "Option") continue;
      const name = child.getAttribute("name");
      if (type === "map") out[name] = optionValue(child);
      else out.push(optionValue(child));
    }
    return out;
  }
  const v = el.getAttribute("value");
  return v !== null ? v : (el.textContent || "");
}

function optionMap(containerEl) {
  if (!containerEl) return {};
  const opt = [...containerEl.children].find(c => c.tagName === "Option" && (c.getAttribute("type") || "").toLowerCase() === "map")
    || [...containerEl.children].find(c => c.tagName === "Option");
  if (!opt) return {};
  const parsed = optionValue(opt);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

// QGIS ブレンドモード(QgsPainting::BlendingMode) → canvas の
// globalCompositeOperation。近似できないものは null(通常合成)
const BLEND_TO_COMPOSITE = {
  0: null, 1: "lighter", 2: "screen", 3: "lighter", 4: "lighter",
  5: "darken", 6: "multiply", 7: "color-burn", 8: "overlay",
  9: "soft-light", 10: "hard-light", 11: "difference", 12: "lighter",
  13: "source-over", 14: "destination-over", 15: "destination-out",
  16: "source-in", 17: "destination-in", 18: "destination-out",
  19: "source-atop", 20: "destination-atop", 21: "xor", 22: "lighter",
};

function qgisBlendToComposite(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return BLEND_TO_COMPOSITE[n] ?? null;
}

// シンボルレイヤのペイントエフェクトスタックを正規化する。
// 実機 QGIS4 構造(検証済み): <layer> の子要素 <effect type="dropShadow"> で、
// type は要素属性・各プロパティは内側の <Option type="Map">。
// (Option マップ内の name="effects" という形式は存在しない)
// 実装可能なもの: drawSource/blur/dropShadow/glow/innerGlow/innerShadow/
// colourize/transform。それ以外は呼び出し側で警告する
function parsePaintEffects(layerEl, props) {
  const out = [];
  for (const c of layerEl?.children || []) {
    if (c.tagName !== "effect") continue;
    const p = optionMap(c) || {};
    if (String(p.enabled ?? "1") === "0") continue;
    out.push({ ...p, type: c.getAttribute("type") || p.type || "drawSource" });
  }
  if (out.length) return out;
  // 手書き・旧形式: Option マップ内の effects/paintEffect キーも拾う
  const raw = props?.effects ?? props?.paintEffect ?? null;
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    if (String(e.enabled ?? "1") === "0") continue;
    out.push(e);
  }
  return out.length ? out : null;
}

// <colorramp type="gradient|random|preset|cpt-city"> → [{offset, rgba}]
// gradient は color1/color2 + "stops"("0.25;r,g,b,a;0.75;r,g,b,a")、
// それ以外はランプ内の <Option type="List"> を順に拾う
function parseColorRamp(rampEl) {
  const stops = [];
  if (!rampEl) return null;
  const add = (offset, v) => {
    const c = parseQgisColor(v, null);
    if (c) stops.push({ offset: Math.min(Math.max(offset, 0), 1), color: c });
  };
  if (rampEl.tagName === "colorramp") {
    const props = optionMap(rampEl);
    if (props.color1) add(0, props.color1);
    if (props.color2) add(1, props.color2);
    // "0.25;r,g,b,a;0.75;r,g,b,a" 形式(カンマ入り色のため2要素ずつ結合)
    const rawStops = String(props.stops || "").split(";");
    for (let i = 0; i + 1 < rawStops.length; i += 2) {
      const off = Number(rawStops[i]);
      if (Number.isFinite(off)) add(off, rawStops[i + 1]);
    }
    for (const [k, v] of Object.entries(props)) {
      const m = /^stop_(\d+)$/.exec(k) || /^color_(\d+)$/.exec(k);
      if (m && typeof v === "string" && v.includes(",")) {
        const [r, g, b, a] = v.split(",");
        add(Number(m[1]) / 100, `${r},${g},${b}${a ? "," + a : ""}`);
      }
    }
  } else {
    // <Option> ツリー直接渡し or リスト内ランプ
    for (const o of rampEl.querySelectorAll?.("Option") || []) {
      const n = o.getAttribute("name") || "";
      if (/^stop_/.test(n)) add(Number(n.slice(5)) / 100, o.getAttribute("value") || o.textContent);
    }
  }
  stops.sort((a, b) => a.offset - b.offset);
  return stops.length ? stops : null;
}

// <data_defined_properties>/<dd_properties> → { propName: {active, expression, field, type} }
// QML は <Option name="properties" type="Map"> 内に各プロパティを持つため
// その層へも潜る
function parseDataDefined(symbolOrLayerEl) {
  const container = [...(symbolOrLayerEl?.children || [])].find(c =>
    c.tagName === "data_defined_properties" || c.tagName === "dd_properties");
  let map = optionMap(container);
  if (map.properties && typeof map.properties === "object") map = map.properties;
  const out = {};
  for (const [name, def] of Object.entries(map)) {
    if (!def || typeof def !== "object") continue;
    const active = String(def.active ?? "0") === "1" || String(def.active).toLowerCase() === "true";
    if (!active) continue;
    out[name] = { expression: def.expression ?? "", field: def.field ?? "", type: String(def.type ?? "") };
  }
  return out;
}

// DD エントリから値を解決する。expression 優先、なければ field 参照
function ddValue(dd, names, props, fallback) {
  for (const name of names) {
    const entry = dd?.[name];
    if (!entry) continue;
    if (entry.expression) {
      const v = evalExpression(entry.expression, props);
      if (v !== undefined && v !== null) return v;
    }
    if (entry.field && props && props[entry.field] !== undefined) return props[entry.field];
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// QGIS 式評価器(ルールベース・graduated の式・データ定義プロパティ用)
// サブセット実装: リテラル・フィールド参照・比較/算術/論理・IN/LIKE/IS NULL・
// CASE WHEN・主要関数。評価不能な式は例外 → 呼び出し側でフォールバックする
// ---------------------------------------------------------------------------

function tokenizeExpr(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  const push = (t, v) => tokens.push({ t, v });
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let s = "";
      i++;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++; break;
        }
        s += src[i++];
      }
      push("str", s);
      continue;
    }
    if (ch === '"') {
      let s = "";
      i++;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++; break;
        }
        s += src[i++];
      }
      push("field", s);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let s = "";
      while (i < n && /[0-9.eE+-]/.test(src[i])) {
        // e+/- 以外の +/- は数値の一部にしない
        if ((src[i] === "+" || src[i] === "-") && !/[eE]/.test(src[i - 1] || "")) break;
        s += src[i++];
      }
      push("num", Number(s));
      continue;
    }
    if (ch === "@") {
      // @map_scale 等の式コンテキスト変数。解決は exprVarResolver 側(描画時点の値)
      let s = "";
      i++;
      while (i < n && /[A-Za-z0-9_.$\u0080-\uffff]/.test(src[i])) s += src[i++];
      push("var", s);
      continue;
    }
    if (ch === "$") {
      // $scale 等の QGIS 式 $変数(@変数と同じ var 経路で解決)
      let s = "";
      i++;
      while (i < n && /[A-Za-z0-9_.\u0080-\uffff]/.test(src[i])) s += src[i++];
      push("var", "$" + s);
      continue;
    }
    const two = src.slice(i, i + 2);
    // QGIS 式のコメント: -- 行コメント / /* */ ブロックコメント
    if (two === "--") { while (i < n && src[i] !== "\n") i++; continue; }
    if (two === "/*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (["<=", ">=", "<>", "!=", "||"].includes(two)) { push("op", two); i += 2; continue; }
    if ("+-*/%=<>()".includes(ch)) { push(ch === "(" ? "lparen" : ch === ")" ? "rparen" : "op", ch); i++; continue; }
    if (ch === ",") { push("comma", ch); i++; continue; }
    if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let s = "";
      while (i < n && /[A-Za-z0-9_.$\u0080-\uffff]/.test(src[i])) s += src[i++];
      push("ident", s);
      continue;
    }
    // 未知の文字はスキップ
    i++;
  }
  return tokens;
}

// QGIS 式関数 is_layer_visible('名前') の解決先。
// アプリ側が setLayerVisibilityResolver で「レイヤー名 → 表示状態か」を注入する。
// 未設定時・レイヤー未発見時は false(QGIS でレイヤー無し/非表示と同じ扱い)
let layerVisibilityResolver = null;
export function setLayerVisibilityResolver(fn) {
  layerVisibilityResolver = (typeof fn === "function") ? fn : null;
}

// QGIS 式変数 @map_scale(現在の地図縮尺分母)の供給元。
// アプリ側が setMapScaleGetter で「現在の縮尺」を注入する。
// 未設定時は null → 式内の @map_scale は undefined 扱い(else 分岐へフォールバック)
let mapScaleGetter = null;
export function setMapScaleGetter(fn) {
  mapScaleGetter = (typeof fn === "function") ? fn : null;
}
let evalScaleOverride = null;
// 評価呼出し単位で縮尺を与える経路(olQmlStyleFunction の resolution 等)。
// null で getter へフォールスルー
export function setEvalScale(v) {
  evalScaleOverride = Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
}
function currentMapScale() {
  let v = evalScaleOverride;
  if (v == null) { try { v = Number(mapScaleGetter?.()); } catch (e) { v = null; } }
  return Number.isFinite(v) && v > 0 ? v : null;
}

// @map_scale 等の式コンテキスト変数(@xxx)の解決先。
// アプリ側が setExpressionVariableResolver で「変数名(@抜き) → 値」を注入する。
// undefined を返した変数は NULL 扱い(QGIS の未定義変数と同じ)
let exprVarResolver = null;
export function setExpressionVariableResolver(fn) {
  exprVarResolver = (typeof fn === "function") ? fn : null;
}
function resolveExprVar(name) {
  try {
    const v = exprVarResolver ? exprVarResolver(String(name ?? "")) : undefined;
    if (v !== undefined) return v;
  } catch (e) { return null; }
  // 組み込み変数: @map_scale/@scale/$scale は setMapScaleGetter/setEvalScale の供給値を使う
  const vn = String(name ?? "").toLowerCase().replace(/^\$/, "");
  if (vn === "map_scale" || vn === "scale") return currentMapScale();
  return null;
}

// 式の値 → Date。文字列/数値/Date を受け、解釈不能は null(QGIS の NULL)
function toExprDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t;
}
// format_date のサブセット: yyyy yy MM M dd d HH mm ss + リテラル
function formatExprDate(d, fmt) {
  const t = toExprDate(d);
  if (!t) return "";
  const map = {
    yyyy: String(t.getFullYear()).padStart(4, "0"),
    yy: String(t.getFullYear() % 100).padStart(2, "0"),
    MM: String(t.getMonth() + 1).padStart(2, "0"),
    M: String(t.getMonth() + 1),
    dd: String(t.getDate()).padStart(2, "0"),
    d: String(t.getDate()),
    HH: String(t.getHours()).padStart(2, "0"),
    mm: String(t.getMinutes()).padStart(2, "0"),
    ss: String(t.getSeconds()).padStart(2, "0"),
  };
  return String(fmt ?? "").replace(/yyyy|yy|MM|M|dd|d|HH|mm|ss/g, m => map[m] ?? m);
}
// ISO-8601 週番号(QGIS week() 相当)
function isoWeekNumber(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  return 1 + Math.round((t - firstThu) / (7 * 86400000));
}

// 名前付きカラーランプ(ramp_color 用)。実機 QgsStyle.defaultStyle() 採取値
// (QGIS 4.0.1 の全35ランプ。cividis 等の 256 ストップ版は 34 点へ間引き)。
// エントリは [offset, "r,g,b,a"]。未登録名は警告して null
const NAMED_RAMPS = {
  "blues":[[0.0,"247,251,255,255"],[0.13,"222,235,247,255"],[0.26,"198,219,239,255"],[0.39,"158,202,225,255"],[0.52,"107,174,214,255"],[0.65,"66,146,198,255"],[0.78,"33,113,181,255"],[0.9,"8,81,156,255"],[1.0,"8,48,107,255"]],
  "brbg":[[0.0,"166,97,26,255"],[0.25,"223,194,125,255"],[0.5,"245,245,245,255"],[0.75,"128,205,193,255"],[1.0,"1,133,113,255"]],
  "bugn":[[0.0,"237,248,251,255"],[0.25,"178,226,226,255"],[0.5,"102,194,164,255"],[0.75,"44,162,95,255"],[1.0,"0,109,44,255"]],
  "bupu":[[0.0,"237,248,251,255"],[0.25,"179,205,227,255"],[0.5,"140,150,198,255"],[0.75,"136,86,167,255"],[1.0,"129,15,124,255"]],
  "cividis":[[0.0,"0,32,77,255"],[0.0312,"0,38,90,255"],[0.0586,"0,43,103,255"],[0.0898,"0,48,111,255"],[0.1211,"1,54,110,255"],[0.1484,"26,59,109,255"],[0.1797,"42,64,108,255"],[0.2109,"53,70,107,255"],[0.2422,"63,76,107,255"],[0.2695,"71,81,107,255"],[0.3008,"79,87,108,255"],[0.332,"87,92,109,255"],[0.3594,"93,97,110,255"],[0.3906,"100,103,112,255"],[0.4219,"108,109,114,255"],[0.4492,"114,114,116,255"],[0.4805,"120,120,119,255"],[0.5117,"128,126,121,255"],[0.543,"135,132,121,255"],[0.5703,"142,138,121,255"],[0.6016,"150,144,120,255"],[0.6328,"158,150,119,255"],[0.6602,"165,156,118,255"],[0.6914,"174,163,116,255"],[0.7227,"182,169,113,255"],[0.75,"190,175,111,255"],[0.7812,"198,182,107,255"],[0.8125,"207,189,103,255"],[0.8438,"216,197,99,255"],[0.8711,"224,203,94,255"],[0.9023,"233,211,88,255"],[0.9336,"242,218,80,255"],[0.9609,"250,225,73,255"],[1.0,"255,234,70,255"]],
  "gnbu":[[0.0,"240,249,232,255"],[0.25,"186,228,188,255"],[0.5,"123,204,196,255"],[0.75,"67,162,202,255"],[1.0,"8,104,172,255"]],
  "greens":[[0.0,"247,252,245,255"],[0.13,"229,245,224,255"],[0.26,"199,233,192,255"],[0.39,"161,217,155,255"],[0.52,"116,196,118,255"],[0.65,"65,171,93,255"],[0.78,"35,139,69,255"],[0.9,"0,109,44,255"],[1.0,"0,68,27,255"]],
  "greys":[[0.0,"250,250,250,255"],[1.0,"5,5,5,255"]],
  "inferno":[[0.0,"0,0,4,255"],[0.0392,"5,4,23,255"],[0.0588,"10,7,34,255"],[0.098,"22,11,57,255"],[0.1176,"30,12,69,255"],[0.1569,"47,10,91,255"],[0.1765,"56,9,98,255"],[0.2157,"73,11,106,255"],[0.2353,"81,14,108,255"],[0.2745,"97,19,110,255"],[0.2941,"105,22,110,255"],[0.3333,"120,28,109,255"],[0.3725,"136,34,106,255"],[0.3922,"144,37,104,255"],[0.4314,"160,42,99,255"],[0.451,"168,46,95,255"],[0.4902,"183,53,87,255"],[0.5098,"191,57,82,255"],[0.549,"204,66,72,255"],[0.5686,"211,71,67,255"],[0.6078,"223,83,55,255"],[0.6275,"228,90,49,255"],[0.6667,"237,105,37,255"],[0.7059,"244,121,24,255"],[0.7255,"247,130,18,255"],[0.7647,"250,148,7,255"],[0.7843,"251,157,7,255"],[0.8235,"252,176,20,255"],[0.8431,"251,186,31,255"],[0.8824,"248,205,55,255"],[0.902,"246,215,70,255"],[0.9412,"242,234,105,255"],[0.9608,"242,242,125,255"],[1.0,"252,255,164,255"]],
  "magma":[[0.0,"0,0,4,255"],[0.0392,"5,4,22,255"],[0.0588,"9,7,32,255"],[0.098,"20,14,54,255"],[0.1176,"26,16,66,255"],[0.1569,"41,17,90,255"],[0.1765,"49,17,101,255"],[0.2157,"66,15,117,255"],[0.2353,"74,16,121,255"],[0.2745,"90,22,126,255"],[0.2941,"98,25,128,255"],[0.3333,"114,31,129,255"],[0.3725,"129,37,129,255"],[0.3922,"137,40,129,255"],[0.4314,"153,45,128,255"],[0.451,"161,48,126,255"],[0.4902,"178,53,123,255"],[0.5098,"186,56,120,255"],[0.549,"202,62,114,255"],[0.5686,"210,66,111,255"],[0.6078,"224,76,103,255"],[0.6275,"231,82,99,255"],[0.6667,"241,96,93,255"],[0.7059,"247,114,92,255"],[0.7255,"249,123,93,255"],[0.7647,"252,142,100,255"],[0.7843,"253,152,105,255"],[0.8235,"254,170,116,255"],[0.8431,"254,180,123,255"],[0.8824,"254,198,138,255"],[0.902,"254,207,146,255"],[0.9412,"253,226,163,255"],[0.9608,"253,235,172,255"],[1.0,"252,253,191,255"]],
  "mako":[[0.0,"11,4,5,255"],[0.0312,"20,9,16,255"],[0.0586,"27,15,26,255"],[0.0898,"35,21,38,255"],[0.1211,"42,27,51,255"],[0.1484,"48,32,62,255"],[0.1797,"53,38,76,255"],[0.2109,"58,44,89,255"],[0.2422,"62,51,103,255"],[0.2695,"64,57,116,255"],[0.3008,"65,64,130,255"],[0.332,"64,73,142,255"],[0.3594,"61,81,149,255"],[0.3906,"58,91,155,255"],[0.4219,"55,100,158,255"],[0.4492,"54,108,160,255"],[0.4805,"53,117,161,255"],[0.5117,"53,126,164,255"],[0.543,"52,135,166,255"],[0.5703,"52,143,167,255"],[0.6016,"52,152,169,255"],[0.6328,"53,161,171,255"],[0.6602,"56,169,172,255"],[0.6914,"60,178,173,255"],[0.7227,"67,186,173,255"],[0.75,"75,194,173,255"],[0.7812,"87,203,173,255"],[0.8125,"106,210,173,255"],[0.8438,"130,216,176,255"],[0.8711,"150,221,181,255"],[0.9023,"171,226,190,255"],[0.9336,"190,232,202,255"],[0.9609,"204,237,214,255"],[1.0,"222,245,229,255"]],
  "orrd":[[0.0,"254,240,217,255"],[0.25,"253,204,138,255"],[0.5,"252,141,89,255"],[0.75,"227,74,51,255"],[1.0,"179,0,0,255"]],
  "oranges":[[0.0,"255,245,235,255"],[0.13,"254,230,206,255"],[0.26,"253,208,162,255"],[0.39,"253,174,107,255"],[0.52,"253,141,60,255"],[0.65,"241,105,19,255"],[0.78,"217,72,1,255"],[0.9,"166,54,3,255"],[1.0,"127,39,4,255"]],
  "prgn":[[0.0,"123,50,148,255"],[0.25,"194,165,207,255"],[0.5,"247,247,247,255"],[0.75,"166,219,160,255"],[1.0,"0,136,55,255"]],
  "piyg":[[0.0,"208,28,139,255"],[0.25,"241,182,218,255"],[0.5,"247,247,247,255"],[0.75,"184,225,134,255"],[1.0,"77,172,38,255"]],
  "plasma":[[0.0,"13,8,135,255"],[0.0392,"38,5,145,255"],[0.0588,"47,5,150,255"],[0.098,"65,4,157,255"],[0.1176,"73,3,160,255"],[0.1569,"89,1,165,255"],[0.1765,"97,0,167,255"],[0.2157,"113,0,168,255"],[0.2353,"120,1,168,255"],[0.2745,"135,7,166,255"],[0.2941,"142,12,164,255"],[0.3333,"156,23,158,255"],[0.3725,"168,34,150,255"],[0.3922,"174,40,146,255"],[0.4314,"186,51,136,255"],[0.451,"191,57,132,255"],[0.4902,"201,68,122,255"],[0.5098,"205,74,118,255"],[0.549,"214,85,109,255"],[0.5686,"218,91,105,255"],[0.6078,"226,102,96,255"],[0.6275,"230,108,92,255"],[0.6667,"237,121,83,255"],[0.7059,"243,133,75,255"],[0.7255,"245,140,70,255"],[0.7647,"249,154,62,255"],[0.7843,"251,161,57,255"],[0.8235,"253,175,49,255"],[0.8431,"254,183,45,255"],[0.8824,"253,198,39,255"],[0.902,"252,206,37,255"],[0.9412,"248,223,37,255"],[0.9608,"246,232,38,255"],[1.0,"240,249,33,255"]],
  "pubu":[[0.0,"241,238,246,255"],[0.25,"189,201,225,255"],[0.5,"116,169,207,255"],[0.75,"43,140,190,255"],[1.0,"4,90,141,255"]],
  "pubugn":[[0.0,"246,239,247,255"],[0.25,"189,201,225,255"],[0.5,"103,169,207,255"],[0.75,"28,144,153,255"],[1.0,"1,108,89,255"]],
  "puor":[[0.0,"230,97,1,255"],[0.25,"253,184,99,255"],[0.5,"247,247,247,255"],[0.75,"178,171,210,255"],[1.0,"94,60,153,255"]],
  "purd":[[0.0,"241,238,246,255"],[0.25,"215,181,216,255"],[0.5,"223,101,176,255"],[0.75,"221,28,119,255"],[1.0,"152,0,67,255"]],
  "purples":[[0.0,"252,251,253,255"],[0.13,"239,237,245,255"],[0.26,"218,218,235,255"],[0.39,"188,189,220,255"],[0.52,"158,154,200,255"],[0.65,"128,125,186,255"],[0.75,"106,81,163,255"],[0.9,"84,39,143,255"],[1.0,"63,0,125,255"]],
  "rdbu":[[0.0,"202,0,32,255"],[0.25,"244,165,130,255"],[0.5,"247,247,247,255"],[0.75,"146,197,222,255"],[1.0,"5,113,176,255"]],
  "rdgy":[[0.0,"202,0,32,255"],[0.25,"244,165,130,255"],[0.5,"255,255,255,255"],[0.75,"186,186,186,255"],[1.0,"64,64,64,255"]],
  "rdpu":[[0.0,"254,235,226,255"],[0.25,"251,180,185,255"],[0.5,"247,104,161,255"],[0.75,"197,27,138,255"],[1.0,"122,1,119,255"]],
  "rdylbu":[[0.0,"215,25,28,255"],[0.25,"253,174,97,255"],[0.5,"255,255,191,255"],[0.75,"171,217,233,255"],[1.0,"44,123,182,255"]],
  "rdylgn":[[0.0,"215,25,28,255"],[0.25,"253,174,97,255"],[0.5,"255,255,192,255"],[0.75,"166,217,106,255"],[1.0,"26,150,65,255"]],
  "reds":[[0.0,"255,245,240,255"],[0.13,"254,224,210,255"],[0.26,"252,187,161,255"],[0.39,"252,146,114,255"],[0.52,"251,106,74,255"],[0.65,"239,59,44,255"],[0.78,"203,24,29,255"],[0.9,"165,15,21,255"],[1.0,"103,0,13,255"]],
  "rocket":[[0.0,"3,5,26,255"],[0.0312,"13,10,33,255"],[0.0586,"23,15,40,255"],[0.0898,"34,19,49,255"],[0.1211,"46,23,57,255"],[0.1484,"56,26,64,255"],[0.1797,"69,28,71,255"],[0.2109,"81,30,77,255"],[0.2422,"94,31,82,255"],[0.2695,"105,31,85,255"],[0.3008,"118,31,88,255"],[0.332,"132,30,90,255"],[0.3594,"144,29,91,255"],[0.3906,"158,26,91,255"],[0.4219,"171,24,90,255"],[0.4492,"183,22,87,255"],[0.4805,"196,23,83,255"],[0.5117,"207,30,77,255"],[0.543,"217,40,71,255"],[0.5703,"225,51,66,255"],[0.6016,"232,64,62,255"],[0.6328,"237,80,62,255"],[0.6602,"240,94,66,255"],[0.6914,"242,109,75,255"],[0.7227,"244,124,85,255"],[0.75,"245,136,96,255"],[0.7812,"245,150,108,255"],[0.8125,"246,163,122,255"],[0.8438,"246,176,137,255"],[0.8711,"246,187,151,255"],[0.9023,"247,199,168,255"],[0.9336,"248,211,186,255"],[0.9609,"249,221,201,255"],[1.0,"250,235,221,255"]],
  "spectral":[[0.0,"215,25,28,255"],[0.25,"253,174,97,255"],[0.5,"255,255,191,255"],[0.75,"171,221,164,255"],[1.0,"43,131,186,255"]],
  "turbo":[[0.0,"48,18,59,255"],[0.0312,"57,42,115,255"],[0.0586,"63,62,156,255"],[0.0898,"68,84,195,255"],[0.1211,"70,105,224,255"],[0.1484,"71,123,242,255"],[0.1797,"68,143,254,255"],[0.2109,"58,163,252,255"],[0.2422,"44,183,240,255"],[0.2695,"32,199,223,255"],[0.3008,"24,215,202,255"],[0.332,"26,228,182,255"],[0.3594,"39,238,164,255"],[0.3906,"63,246,138,255"],[0.4219,"93,252,111,255"],[0.4492,"121,254,89,255"],[0.4805,"150,254,68,255"],[0.5117,"172,251,56,255"],[0.543,"193,243,52,255"],[0.5703,"210,233,53,255"],[0.6016,"227,219,56,255"],[0.6328,"241,203,58,255"],[0.6602,"249,188,57,255"],[0.6914,"254,169,51,255"],[0.7227,"254,147,42,255"],[0.75,"251,126,33,255"],[0.7812,"244,102,23,255"],[0.8125,"235,80,14,255"],[0.8438,"223,63,8,255"],[0.8711,"210,49,5,255"],[0.9023,"193,35,2,255"],[0.9336,"172,23,1,255"],[0.9609,"152,14,1,255"],[1.0,"122,4,3,255"]],
  "viridis":[[0.0,"68,1,84,255"],[0.0392,"71,16,99,255"],[0.0588,"72,23,105,255"],[0.098,"72,36,117,255"],[0.1176,"71,42,122,255"],[0.1569,"69,55,129,255"],[0.1765,"67,61,132,255"],[0.2157,"63,72,137,255"],[0.2353,"61,78,138,255"],[0.2745,"56,89,140,255"],[0.2941,"53,94,141,255"],[0.3333,"49,104,142,255"],[0.3725,"44,113,142,255"],[0.3922,"42,118,142,255"],[0.4314,"39,128,142,255"],[0.451,"37,132,142,255"],[0.4902,"33,142,141,255"],[0.5098,"32,146,140,255"],[0.549,"30,156,137,255"],[0.5686,"31,161,136,255"],[0.6078,"36,170,131,255"],[0.6275,"40,174,128,255"],[0.6667,"53,183,121,255"],[0.7059,"70,192,111,255"],[0.7255,"80,196,106,255"],[0.7647,"101,203,94,255"],[0.7843,"112,207,87,255"],[0.8235,"137,213,72,255"],[0.8431,"149,216,64,255"],[0.8824,"176,221,47,255"],[0.902,"189,223,38,255"],[0.9412,"216,226,25,255"],[0.9608,"229,228,25,255"],[1.0,"253,231,37,255"]],
  "ylgn":[[0.0,"255,255,204,255"],[0.25,"194,230,153,255"],[0.5,"120,198,121,255"],[0.75,"49,163,84,255"],[1.0,"0,104,55,255"]],
  "ylgnbu":[[0.0,"255,255,204,255"],[0.25,"161,218,180,255"],[0.5,"65,182,196,255"],[0.75,"44,127,184,255"],[1.0,"37,52,148,255"]],
  "ylorbr":[[0.0,"255,255,212,255"],[0.25,"254,217,142,255"],[0.5,"254,153,41,255"],[0.75,"217,95,14,255"],[1.0,"153,52,4,255"]],
  "ylorrd":[[0.0,"255,255,178,255"],[0.25,"254,204,92,255"],[0.5,"253,141,60,255"],[0.75,"240,59,32,255"],[1.0,"189,0,38,255"]],
};
const _warnedRamps = new Set();
function rampColorAt(stops, v) {
  const t = Math.min(Math.max(Number(v) || 0, 0), 1);
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let k = 0; k < stops.length; k++) {
    if (stops[k][0] >= t) { hi = stops[k]; lo = stops[k - 1] || stops[0]; break; }
    lo = stops[k];
  }
  const span = hi[0] - lo[0];
  const f = span > 0 ? (t - lo[0]) / span : 0;
  const pa = lo[1].split(",").map(Number), pb = hi[1].split(",").map(Number);
  const mix = pa.map((a, i) => Math.round(a + (pb[i] - a) * f));
  return `${mix[0]},${mix[1]},${mix[2]},${mix[3]}`;
}

const EXPR_FUNCS = {
  abs: Math.abs,
  ceil: Math.ceil, ceiling: Math.ceil, floor: Math.floor,
  round: (v, dp = 0) => { const m = 10 ** dp; return Math.round(Number(v) * m) / m; },
  exp: Math.exp, ln: Math.log, log10: Math.log10, sqrt: Math.sqrt,
  log: (a, b) => (b === undefined ? Math.log10(a) : Math.log(b) / Math.log(a)),
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: (a, b) => Math.atan2(a, b),
  radians: v => v * Math.PI / 180, degrees: v => v * 180 / Math.PI,
  pi: () => Math.PI,
  min: (...a) => Math.min(...a.map(Number)), max: (...a) => Math.max(...a.map(Number)),
  clamp: (mn, v, mx) => Math.min(Math.max(v, mn), mx),
  sign: v => Math.sign(Number(v)) || 0, log2: v => Math.log2(Number(v)),
  lower: s => String(s ?? "").toLowerCase(), upper: s => String(s ?? "").toUpperCase(),
  title: s => String(s ?? "").replace(/\b\w/g, c => c.toUpperCase()),
  length: s => String(s ?? "").length, len: s => String(s ?? "").length,
  substr: (s, start, len) => String(s ?? "").substr(Number(start) - 1, len === undefined ? undefined : Number(len)),
  left: (s, n) => String(s ?? "").slice(0, Number(n)), right: (s, n) => String(s ?? "").slice(-Number(n)),
  strpos: (s, sub) => { const i = String(s ?? "").indexOf(String(sub)); return i < 0 ? 0 : i + 1; },
  replace: (s, a, b) => String(s ?? "").split(String(a)).join(String(b)),
  trim: s => String(s ?? "").trim(), ltrim: s => String(s ?? "").replace(/^\s+/, ""), rtrim: s => String(s ?? "").replace(/\s+$/, ""),
  lpad: (s, n, c = " ") => String(s ?? "").padStart(Number(n), String(c)),
  rpad: (s, n, c = " ") => String(s ?? "").padEnd(Number(n), String(c)),
  concat: (...a) => a.map(v => v ?? "").join(""),
  format: (fmt, ...a) => String(fmt ?? "").replace(/%(\d+)/g,
    (m, d) => (a[Number(d) - 1] !== undefined ? String(a[Number(d) - 1]) : m)),
  format_number: (v, dp = 0) => Number(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }),
  char: n => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ""; } },
  unicode: s => { const c = String(s ?? "").codePointAt(0); return c === undefined ? null : c; },
  wordwrap: (s, w, delim = "\n") => {
    const width = Math.max(Number(w) || 0, 1);
    return String(s ?? "").split(" ").reduce((lines, word) => {
      const cur = lines[lines.length - 1];
      if ((cur + (cur ? " " : "") + word).length > width) lines.push(word);
      else lines[lines.length - 1] = cur ? `${cur} ${word}` : word;
      return lines;
    }, [""]).join(String(delim));
  },
  to_int: v => parseInt(v, 10) || 0, to_real: v => Number(v) || 0,
  to_string: v => String(v ?? ""), to_text: v => String(v ?? ""),
  toint: v => parseInt(v, 10) || 0, toreal: v => Number(v) || 0, // QGIS2 旧名エイリアス
  tostring: v => String(v ?? ""),
  to_date: v => toExprDate(v), to_datetime: v => toExprDate(v), to_time: v => toExprDate(v),
  todate: v => toExprDate(v), todatetime: v => toExprDate(v), totime: v => toExprDate(v),
  format_date: (d, fmt) => formatExprDate(d, fmt),
  make_date: (y, m, d) => toExprDate(`${Number(y)}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`),
  make_datetime: (y, mo, d, h = 0, mi = 0, s = 0) =>
    toExprDate(`${Number(y)}-${String(Number(mo)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}T${String(Number(h)).padStart(2, "0")}:${String(Number(mi)).padStart(2, "0")}:${String(Number(s)).padStart(2, "0")}`),
  make_time: (h, m, s = 0) => toExprDate(`1970-01-01T${String(Number(h)).padStart(2, "0")}:${String(Number(m)).padStart(2, "0")}:${String(Number(s)).padStart(2, "0")}`),
  day_of_week: d => { const t = toExprDate(d); return t ? t.getDay() : null; },
  week: d => { const t = toExprDate(d); return t ? isoWeekNumber(t) : null; },
  coalesce: (...a) => a.find(v => v !== null && v !== undefined),
  if: (c, a, b) => (c ? a : b),
  nullif: (a, b) => (a == b || String(a) === String(b)) ? null : a,
  try: v => v, // 引数は評価済みのためそのまま返す(構文エラーはコンパイル時 null 関数へ)
  is_layer_visible: name => {
    try { return layerVisibilityResolver ? !!layerVisibilityResolver(String(name ?? "")) : false; }
    catch (e) { return false; }
  },
  scale_linear: (v, a1, a2, b1, b2) => b1 + (Number(v) - a1) * (b2 - b1) / ((a2 - a1) || 1),
  // QGIS の scale_exp は 6 引数(末尾=指数)。指数1なら線形と同値
  scale_exp: (v, a1, a2, b1, b2, e = 1) =>
    b1 + (b2 - b1) * Math.pow((Number(v) - a1) / ((a2 - a1) || 1), Number(e)),
  ramp_color: (name, v) => {
    const stops = NAMED_RAMPS[String(name ?? "").toLowerCase()];
    if (!stops) {
      if (!_warnedRamps.has(String(name))) { _warnedRamps.add(String(name)); console.warn(`[qml-style] ramp_color のランプ ${name} は未登録です`); }
      return null;
    }
    return rampColorAt(stops, v);
  },
  // ramp_color_object は QColor 版だが、DD の色解釈は文字列 "r,g,b,a" を
  // parseQgisColor へ渡すため ramp_color と同じ戻り値でよい
  ramp_color_object: (name, v) => EXPR_FUNCS.ramp_color(name, v),
  // geo_userfunc ユーザー関数 line_width(base,min,ref_scale,scale) を
  // 通常関数へ展開したもの: clamp(min, base*ref_scale/scale, base)。
  // 基準縮尺 ref_scale で base mm、ズームアウト(分母増)で線形に細く min で
  // 打止め、ズームイン側は base で頭打ち。同プロジェクトの
  // if(@map_scale>=25000,(1/@map_scale*2.5*25000),2.5) と同じ縮尺則。
  // (実機 QGIS でも未登録のため実側は 0.26mm フォールバック中。関数定義が
  // 見つからない環境でも意図どおり評価されるよう組込み化)
  line_width: (base, min, ref, scale) => {
    const b = Number(base), m = Number(min), r = Number(ref), s = Number(scale);
    if (!Number.isFinite(b)) return null;
    if (!(r > 0) || !(s > 0)) return Number.isFinite(m) ? m : b;
    return Math.min(Math.max(b * r / s, Number.isFinite(m) ? m : -Infinity), b);
  },
  rand: (a = 0, b = 1) => a + Math.random() * (b - a),
  randf: (a = 0, b = 1) => a + Math.random() * (b - a),
  uuid: () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    })),
  regexp_match: (s, re) => { try { const m = String(s ?? "").search(new RegExp(String(re))); return m < 0 ? 0 : m + 1; } catch (e) { return 0; } },
  regexp_substr: (s, re) => {
    try { const m = String(s ?? "").match(new RegExp(String(re))); return m ? m[0] : ""; }
    catch (e) { return ""; }
  },
  // QGIS の置換後方参照は \1 形式 → JS の $1 へ変換して適用
  regexp_replace: (s, re, rep) => {
    try {
      const jsRep = String(rep ?? "").replace(/\\(\d)/g, "$$$1");
      return String(s ?? "").replace(new RegExp(String(re), "g"), jsRep);
    } catch (e) { return String(s ?? ""); }
  },
  regexp_escape: s => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  now: () => new Date(),
  year: d => { const t = toExprDate(d); return t ? t.getFullYear() : null; },
  month: d => { const t = toExprDate(d); return t ? t.getMonth() + 1 : null; },
  day: d => { const t = toExprDate(d); return t ? t.getDate() : null; },
  hour: d => { const t = toExprDate(d); return t ? t.getHours() : null; },
  minute: d => { const t = toExprDate(d); return t ? t.getMinutes() : null; },
  second: d => { const t = toExprDate(d); return t ? t.getSeconds() : null; },
  array: (...a) => a,
  array_get: (arr, i) => (Array.isArray(arr) ? arr[Number(i)] : undefined),
  array_length: arr => (Array.isArray(arr) ? arr.length : 0),
  array_first: arr => (Array.isArray(arr) ? arr[0] : undefined),
  array_last: arr => (Array.isArray(arr) ? arr[arr.length - 1] : undefined),
  array_contains: (arr, v) => Array.isArray(arr) && arr.some(x => x == v || String(x) === String(v)),
  array_append: (arr, v) => [...(Array.isArray(arr) ? arr : []), v],
  array_prepend: (arr, v) => [v, ...(Array.isArray(arr) ? arr : [])],
  array_cat: (...arrs) => arrs.flatMap(a => Array.isArray(a) ? a : []),
  array_distinct: arr => Array.isArray(arr) ? [...new Set(arr)] : [],
  array_reverse: arr => Array.isArray(arr) ? [...arr].reverse() : [],
  array_slice: (arr, start, end) => Array.isArray(arr)
    ? arr.slice(Number(start), end === undefined ? undefined : Number(end) + 1) : [],
  array_sort: (arr, asc = true) => Array.isArray(arr) ? [...arr].sort((a, b) => (asc ? 1 : -1) * String(a).localeCompare(String(b), undefined, { numeric: true })) : [],
  array_to_string: (arr, delim = ",") => (Array.isArray(arr) ? arr.join(String(delim)) : String(arr ?? "")),
  string_to_array: (s, delim = ",") => String(s ?? "").split(String(delim)),
  // geo_userfunc ユーザー関数の移植(正本: qgis_live_harness/qgis-plugin/geo_userfunc/functions/user_functions.py)
  // zen2han: 全角英数字(０-９ Ａ-Ｚ ａ-ｚ)→半角。記号・かな・全角スペースは対象外
  // (han2zen は QGIS 側で @qgsfunction 未登録=未対応のままとし、実機と同じ null 扱いにする)
  zen2han: s => {
    if (s === null || s === undefined) return null;
    return [...String(s)].map(c => {
      const cp = c.codePointAt(0);
      const fw = (cp >= 0xFF10 && cp <= 0xFF19) ||
        (cp >= 0xFF21 && cp <= 0xFF3A) || (cp >= 0xFF41 && cp <= 0xFF5A);
      return fw ? String.fromCodePoint(cp - 0xFEE0) : c;
    }).join("");
  },
};

// 未対応の式関数(ユーザー定義 @qgsfunction 等)は一度だけ警告して null 扱い
const _warnedExprFns = new Set();
function warnUnknownExprFunc(name) {
  if (_warnedExprFns.has(name)) return;
  _warnedExprFns.add(name);
  console.warn(`[qml-style] QGIS 式の未対応関数 ${name}() は評価できません(フォールバック値を使用)`);
}

function parseExpr(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isKw = (kw) => peek()?.t === "ident" && peek().v.toUpperCase() === kw;
  const eatKw = (kw) => { if (isKw(kw)) { pos++; return true; } return false; };

  function parseOr() {
    let left = parseAnd();
    while (isKw("OR")) { next(); left = { t: "or", a: left, b: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isKw("AND")) { next(); left = { t: "and", a: left, b: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (eatKw("NOT")) return { t: "not", a: parseNot() };
    return parseCmp();
  }
  function parseCmp() {
    let left = parseAdd();
    for (;;) {
      const tk = peek();
      if (tk?.t === "op" && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(tk.v)) {
        next();
        left = { t: "cmp", op: tk.v, a: left, b: parseAdd() };
        continue;
      }
      const not = isKw("NOT") ? (next(), true) : false;
      if (isKw("IN")) {
        next();
        const items = [];
        if (peek()?.t === "lparen") {
          next();
          while (peek() && peek().t !== "rparen") {
            items.push(parseOr());
            if (peek()?.t === "comma") next();
          }
          if (peek()?.t === "rparen") next();
        }
        left = { t: "in", a: left, items, not };
        continue;
      }
      if (isKw("LIKE") || isKw("ILIKE")) {
        const ci = next().v.toUpperCase() === "ILIKE";
        left = { t: "like", a: left, pattern: parseAdd(), ci, not };
        continue;
      }
      if (isKw("BETWEEN")) {
        next();
        const lo = parseAdd();
        eatKw("AND");
        const hi = parseAdd();
        left = { t: "between", a: left, lo, hi, not };
        continue;
      }
      if (isKw("IS")) {
        next();
        const n2 = eatKw("NOT");
        eatKw("NULL");
        left = { t: "isnull", a: left, not: n2 || not };
        continue;
      }
      if (not) { pos--; } // NOT を消費したが後続が比較語でない場合は戻す
      break;
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    for (;;) {
      const tk = peek();
      if (tk?.t === "op" && (tk.v === "+" || tk.v === "-" || tk.v === "||")) {
        next();
        left = { t: "arith", op: tk.v, a: left, b: parseMul() };
        continue;
      }
      break;
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (tk?.t === "op" && (tk.v === "*" || tk.v === "/" || tk.v === "%")) {
        next();
        left = { t: "arith", op: tk.v, a: left, b: parseUnary() };
        continue;
      }
      break;
    }
    return left;
  }
  function parseUnary() {
    const tk = peek();
    if (tk?.t === "op" && (tk.v === "-" || tk.v === "+")) {
      next();
      return { t: "unary", op: tk.v, a: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = next();
    if (!tk) return { t: "lit", v: null };
    if (tk.t === "num") return { t: "lit", v: tk.v };
    if (tk.t === "str") return { t: "lit", v: tk.v };
    if (tk.t === "field") return { t: "field", v: tk.v };
    if (tk.t === "var") return { t: "var", v: tk.v };
    if (tk.t === "lparen") {
      const e = parseOr();
      if (peek()?.t === "rparen") next();
      return e;
    }
    if (tk.t === "ident") {
      const name = tk.v;
      const upper = name.toUpperCase();
      if (upper === "CASE") {
        // CASE [operand] WHEN c THEN v ... [ELSE v] END
        let operand = null;
        if (!isKw("WHEN")) operand = parseOr();
        const whens = [];
        let elseExpr = null;
        while (isKw("WHEN")) {
          next();
          const cond = parseOr();
          if (isKw("THEN")) next();
          const val = parseOr();
          whens.push([cond, val]);
        }
        if (isKw("ELSE")) { next(); elseExpr = parseOr(); }
        eatKw("END");
        return { t: "case", operand, whens, elseExpr };
      }
      if (upper === "NULL") return { t: "lit", v: null };
      if (upper === "TRUE") return { t: "lit", v: true };
      if (upper === "FALSE") return { t: "lit", v: false };
      if (peek()?.t === "lparen") {
        next();
        const args = [];
        while (peek() && peek().t !== "rparen") {
          args.push(parseOr());
          if (peek()?.t === "comma") next();
        }
        if (peek()?.t === "rparen") next();
        return { t: "call", name: name.toLowerCase(), args };
      }
      // クオート無し識別子はフィールド参照として扱う(QGIS の式も同じ解釈)
      return { t: "field", v: name };
    }
    return { t: "lit", v: null };
  }
  return parseOr();
}

function evalAst(node, props) {
  switch (node.t) {
    case "lit": return node.v;
    case "field": {
      const v = props?.[node.v];
      // 裸の map_scale 参照(@なし・フィールド優先)も縮尺として解決する。
      // 地物に同名フィールドが無いときは現在の縮尺分母を返す
      if (v === undefined && node.v === "map_scale") return currentMapScale();
      return v;
    }
    case "var": return resolveExprVar(node.v); // @xxx 変数 → exprVarResolver/組み込み解決
    case "or": return evalAst(node.a, props) || evalAst(node.b, props);
    case "and": return evalAst(node.a, props) && evalAst(node.b, props);
    case "not": return !evalAst(node.a, props);
    case "unary": { const v = Number(evalAst(node.a, props)); return node.op === "-" ? -v : v; }
    case "arith": {
      const a = evalAst(node.a, props), b = evalAst(node.b, props);
      if (node.op === "||") return String(a ?? "") + String(b ?? "");
      switch (node.op) {
        case "+": return Number(a) + Number(b);
        case "-": return Number(a) - Number(b);
        case "*": return Number(a) * Number(b);
        case "/": return Number(b) === 0 ? null : Number(a) / Number(b);
        case "%": return Number(b) === 0 ? null : Number(a) % Number(b);
      }
      return null;
    }
    case "cmp": {
      const a = evalAst(node.a, props), b = evalAst(node.b, props);
      switch (node.op) {
        case "=": return a == b || String(a) === String(b);
        case "<>": case "!=": return !(a == b || String(a) === String(b));
        case "<": return Number(a) < Number(b);
        case "<=": return Number(a) <= Number(b);
        case ">": return Number(a) > Number(b);
        case ">=": return Number(a) >= Number(b);
      }
      return false;
    }
    case "in": {
      const v = evalAst(node.a, props);
      const hit = node.items.some(item => {
        const iv = evalAst(item, props);
        return iv == v || String(iv) === String(v);
      });
      return node.not ? !hit : hit;
    }
    case "like": {
      const v = String(evalAst(node.a, props) ?? "");
      const p = String(evalAst(node.pattern, props) ?? "")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
      const hit = new RegExp(`^${p}$`, node.ci ? "i" : "").test(v);
      return node.not ? !hit : hit;
    }
    case "between": {
      const v = Number(evalAst(node.a, props));
      const hit = v >= Number(evalAst(node.lo, props)) && v <= Number(evalAst(node.hi, props));
      return node.not ? !hit : hit;
    }
    case "isnull": {
      const v = evalAst(node.a, props);
      const isNull = v === null || v === undefined;
      return node.not ? !isNull : isNull;
    }
    case "case": {
      const operand = node.operand ? evalAst(node.operand, props) : undefined;
      for (const [cond, val] of node.whens) {
        const c = evalAst(cond, props);
        const hit = node.operand ? (c == operand || String(c) === String(operand)) : !!c;
        if (hit) return evalAst(val, props);
      }
      return node.elseExpr ? evalAst(node.elseExpr, props) : null;
    }
    case "call": {
      const args = node.args.map(a => evalAst(a, props));
      if (node.name === "attribute") return props?.[args[0]];
      if (node.name === "var") return resolveExprVar(args[0]); // var('map_scale') 形式
      const fn = EXPR_FUNCS[node.name];
      if (!fn) { warnUnknownExprFunc(node.name); return null; }
      try { return fn(...args); } catch (e) { return null; }
    }
  }
  return null;
}

const exprCache = new Map();
// 式文字列 → (props)=>value の関数にコンパイルする。失敗時は常に null を返す関数
function compileExpr(src) {
  const key = String(src || "");
  if (exprCache.has(key)) return exprCache.get(key);
  let fn;
  try {
    const ast = parseExpr(tokenizeExpr(key));
    fn = props => evalAst(ast, props);
  } catch (e) {
    fn = () => null;
  }
  exprCache.set(key, fn);
  return fn;
}

function evalExpression(src, props) {
  return compileExpr(src)(props);
}

// 検証・プローブ用: QGIS 式文字列を直接評価する公開口
// (DD/ルール/ラベル等の内部経路と同一の評価器・変数リゾルバを使う)
export function evalQgisExpression(src, props) {
  return evalExpression(src, props);
}

// ---------------------------------------------------------------------------
// QML パース: <symbols>/<renderer-v2>/<labeling>
// ---------------------------------------------------------------------------

function parseSymbolEl(symbolEl) {
  const layers = [];
  for (const layerEl of symbolEl.children) {
    if (layerEl.tagName !== "layer") continue;
    const props = optionMap(layerEl);
    let subSymbol = null;
    for (const c of layerEl.children) {
      if (c.tagName === "symbol") { subSymbol = parseSymbolEl(c); break; }
    }
    layers.push({
      cls: layerEl.getAttribute("class") || "",
      enabled: layerEl.getAttribute("enabled") !== "0",
      locked: layerEl.getAttribute("locked") === "1",
      pass: Number(layerEl.getAttribute("pass")) || 0,
      props,
      dd: parseDataDefined(layerEl),
      subSymbol,
      // シンボルレイヤの合成モードとペイントエフェクト(#58)
      blend: qgisBlendToComposite(layerEl.getAttribute("blend_mode") ?? props.blend_mode ?? props.blendMode),
      effects: parsePaintEffects(layerEl, props),
    });
  }
  layers.sort((a, b) => a.pass - b.pass);
  return {
    name: symbolEl.getAttribute("name") || "",
    geomType: symbolEl.getAttribute("type") || "", // marker|line|fill
    alpha: alphaAttr(symbolEl.getAttribute("alpha")),
    dd: parseDataDefined(symbolEl),
    layers,
  };
}

function parseSymbols(rendererEl) {
  const symbols = new Map();
  const container = [...rendererEl.children].find(c => c.tagName === "symbols");
  if (!container) return symbols;
  for (const s of container.children) {
    if (s.tagName !== "symbol") continue;
    const parsed = parseSymbolEl(s);
    symbols.set(parsed.name, parsed);
  }
  return symbols;
}

// renderer-v2 → { evaluate(props)->symbolName[], legend:[{label,symbolName}] }
function compileRenderer(rendererEl, warnings) {
  const type = rendererEl.getAttribute("type") || "singleSymbol";
  const symbols = parseSymbols(rendererEl);
  const legend = [];
  // symbollevels="1": シンボルレイヤ pass 番号で地物をまたいだ描画順を制御
  // する QGIS モード。全レイヤを pass 順に一括描画する本物の再現は Web
  // エンジンでは不可能なため、各地物の最小 pass を z 順位近似として使う
  const symbolLevels = String(rendererEl.getAttribute("symbollevels") ?? "0") === "1"
    || String(rendererEl.getAttribute("symbollevels") ?? "").toLowerCase() === "true";
  const ctx = { symbols, warnings, legend, symbolLevels };

  switch (type) {
    case "singleSymbol": {
      const name = [...symbols.keys()][0];
      if (name) legend.push({ label: "", symbolName: name });
      return { evaluate: () => (name ? [name] : []), ...ctx };
    }
    case "25dRenderer": // QGIS4 の実レンダラ名(実機検証済み)。"25d" は旧/手書き名
    case "25d": {
      // QGIS 2.5D レンダラ: 屋根色(面シンボル)+立体表示。高さは QML に
      // 保持されず固定値のため、Cesium polygon.extrudedHeight で簡易近似(#64)
      const name = [...symbols.keys()][0];
      if (name) legend.push({ label: "", symbolName: name });
      warnOnce(warnings, "25dRenderer は固定高さの簡易 2.5D 近似です(ドレープ時は無効)");
      return { evaluate: () => (name ? [name] : []), ...ctx, d25: { height: 10 } };
    }
    case "categorizedSymbol": {
      const attr = rendererEl.getAttribute("attr") || "";
      const getAttr = compileExpr(attr);
      const cats = [];
      const catEl = [...rendererEl.children].find(c => c.tagName === "categories");
      let elseSymbol = null;
      for (const c of catEl?.children || []) {
        if (c.tagName !== "category") continue;
        const value = c.getAttribute("value") ?? "";
        const symbolName = c.getAttribute("symbol") || "";
        const label = c.getAttribute("label") || String(value);
        const render = c.getAttribute("render") !== "false";
        if (value === "" || value == null) {
          // 「その他」カテゴリ(ELSE 相当)も凡例に載せる。空 value が複数あっても1件だけ
          if (!elseSymbol && symbolName) { elseSymbol = symbolName; legend.push({ label, symbolName }); }
        }
        else { cats.push({ value, symbolName, render }); legend.push({ label, symbolName }); }
      }
      return {
        evaluate(props) {
          const v = getAttr(props);
          for (const cat of cats) {
            if (!cat.render) continue;
            if (cat.value == v || String(cat.value) === String(v)) return [cat.symbolName];
          }
          return elseSymbol ? [elseSymbol] : [];
        },
        ...ctx,
      };
    }
    case "graduatedSymbol": {
      const attr = rendererEl.getAttribute("attr") || "";
      const getAttr = compileExpr(attr);
      const ranges = [];
      const rangeEl = [...rendererEl.children].find(c => c.tagName === "ranges");
      for (const r of rangeEl?.children || []) {
        if (r.tagName !== "range") continue;
        const entry = {
          lower: Number(r.getAttribute("lower")),
          upper: Number(r.getAttribute("upper")),
          symbolName: r.getAttribute("symbol") || "",
          render: r.getAttribute("render") !== "false",
        };
        ranges.push(entry);
        legend.push({ label: r.getAttribute("label") || `${entry.lower} - ${entry.upper}`, symbolName: entry.symbolName });
      }
      return {
        evaluate(props) {
          const v = Number(getAttr(props));
          if (!Number.isFinite(v)) return [];
          for (const r of ranges) {
            if (!r.render) continue;
            if (v >= r.lower && v <= r.upper) return [r.symbolName];
          }
          return [];
        },
        ...ctx,
      };
    }
    // QGIS writes the type as "RuleRenderer"; "RuleBased" is kept for
    // hand-authored/renamed files that already use it.
    case "RuleBased":
    case "RuleRenderer": {
      const rulesEl = [...rendererEl.children].find(c => c.tagName === "rules");
      const rootRules = [];
      const parseRule = (ruleEl) => {
        // checkstate="0" は無効ルール(QGIS 実出力)。子ルールも描画しない
        if (ruleEl.getAttribute("checkstate") === "0") return null;
        const filter = ruleEl.getAttribute("filter");
        const rule = {
          symbolName: ruleEl.getAttribute("symbol") || null,
          label: ruleEl.getAttribute("label") || "",
          scaleMin: Number(ruleEl.getAttribute("scalemindenom")) || 0,
          scaleMax: Number(ruleEl.getAttribute("scalemaxdenom")) || 0,
          isElse: /^ELSE$/i.test(String(filter || "").trim()),
          filterFn: filter && !/^ELSE$/i.test(filter) ? compileExpr(filter) : null,
          children: [],
        };
        if (rule.symbolName && rule.label) legend.push({ label: rule.label, symbolName: rule.symbolName });
        for (const c of ruleEl.children) {
          if (c.tagName === "rule") {
            const sub = parseRule(c);
            if (sub) rule.children.push(sub);
          }
        }
        return rule;
      };
      for (const c of rulesEl?.children || []) {
        if (c.tagName === "rule") {
          const r = parseRule(c);
          if (r) rootRules.push(r);
        }
      }
      // 各ルールの有効スケール範囲(継承込み)を列挙。レイヤー全体の
      // 表示範囲(ユニオン)計算に使う
      const ruleScales = [];
      (function collectScales(rs, inh) {
        for (const r of rs) {
          const s = { min: r.scaleMin || inh.min, max: r.scaleMax || inh.max };
          ruleScales.push(s);
          collectScales(r.children, s);
        }
      })(rootRules, { min: 0, max: 0 });
      const matchRule = (rules, props, inheritedScale, depth = 0) => {
        if (depth > 16) return null;
        let elseRule = null;
        // 現在縮尺が取れる場合のみ、範囲外のルールをスキップして次の
        // ルールへ進める(QGIS のルール別縮尺切替)。取れない場合は
        // 従来通り条件一致のみで判定し、範囲は描画側の表示ゲートに任せる
        const curScale = currentMapScale();
        for (const rule of rules) {
          const scale = {
            min: rule.scaleMin || inheritedScale.min,
            max: rule.scaleMax || inheritedScale.max,
          };
          if (curScale != null && ((scale.max > 0 && curScale > scale.max) || (scale.min > 0 && curScale < scale.min))) continue;
          if (rule.isElse) { elseRule = { rule, scale }; continue; }
          const ok = rule.filterFn ? !!rule.filterFn(props) : true;
          if (!ok) continue;
          // 子ルール(ネスト絞り込み)を優先し、なければ自身のシンボル
          const childHit = rule.children.length ? matchRule(rule.children, props, scale, depth + 1) : null;
          if (childHit) return childHit;
          if (rule.symbolName) return { symbolName: rule.symbolName, scale };
          if (!rule.symbolName && rule.children.length) {
            const hit = matchRule(rule.children, props, scale, depth + 1);
            if (hit) return hit;
          }
          return null;
        }
        if (elseRule) {
          const { rule, scale } = elseRule;
          const childHit = rule.children.length ? matchRule(rule.children, props, scale, depth + 1) : null;
          if (childHit) return childHit;
          if (rule.symbolName) return { symbolName: rule.symbolName, scale };
        }
        return null;
      };
      return {
        evaluate(props) {
          const hit = matchRule(rootRules, props, { min: 0, max: 0 });
          if (!hit) return { names: [], scale: null };
          return { names: [hit.symbolName], scale: hit.scale };
        },
        ruleScales,
        ...ctx,
      };
    }
    case "nullSymbol":
      return { evaluate: () => [], ...ctx };
    case "invertedPolygonRenderer": {
      // 「地物の外側を塗る」マスク。内側の renderer-v2 を評価したうえで
      // spec に inverted フラグを立て、エンジン側が
      // 世界矩形 − 地物リング(穴)のポリゴンで描画する
      const inner = [...rendererEl.children].find(c => c.tagName === "renderer-v2");
      const compiledInner = inner ? compileRenderer(inner, warnings) : null;
      if (compiledInner) {
        const innerEval = compiledInner.evaluate;
        return {
          evaluate(props) {
            const r = innerEval(props);
            if (r == null) return r;
            if (Array.isArray(r)) return r;
            return r; // ルール形は {names, scale}
          },
          ...compiledInner,
          inverted: true,
        };
      }
      // 内側 renderer 無し: 最初のシンボルで近似
      const name = [...symbols.keys()][0];
      warnOnce(warnings, "invertedPolygonRenderer は近似描画です(外側シンボルを全面適用)");
      return { evaluate: () => (name ? [name] : []), ...ctx, inverted: true };
    }
    case "heatmapRenderer": {
      // ヒートマップ: 半径・重み式・カラーランプを spec として保持し、
      // 対応エンジン(OpenLayers/MapLibre)ではネイティブヒートマップを使う
      const ramp = parseColorRamp([...rendererEl.children].find(c => c.tagName === "colorramp"));
      const heatmap = {
        radiusPx: Math.max(sizeToPx(rendererEl.getAttribute("radius") ?? 10, rendererEl.getAttribute("radius_unit") || "MM"), 1),
        weightFn: rendererEl.getAttribute("weight_expression") ? compileExpr(rendererEl.getAttribute("weight_expression")) : null,
        maxValue: Number(rendererEl.getAttribute("maximum_value")) || 0,
        ramp,
        quality: Number(rendererEl.getAttribute("quality")) || 0,
      };
      warnOnce(warnings, "heatmapRenderer は対応エンジンのみネイティブ描画です(未対応エンジンは点シンボルで近似)");
      // ヒートマップ非対応エンジン用のフォールバック点シンボル
      const fbName = "__kasc_heatmap_default__";
      if (!symbols.has(fbName)) {
        symbols.set(fbName, {
          name: fbName, geomType: "marker", alpha: 1, dd: {},
          layers: [{
            cls: "SimpleMarker", enabled: true, locked: false, pass: 0, dd: {}, subSymbol: null,
            props: { name: "circle", size: "2", size_unit: "MM", color: "58,123,213,178", outline_color: "44,94,168,255" },
          }],
        });
      }
      return { evaluate: () => [fbName], ...ctx, unsupported: true, heatmap };
    }
    case "pointCluster":
    case "pointDisplacement": {
      // クラスタ/変位: 内側レンダラのシンボルを引き継ぎ、対応エンジンは
      // ネイティブのクラスタ表示を使う(OpenLayers/MapLibre)
      const inner = [...rendererEl.children].find(c => c.tagName === "renderer-v2");
      const compiledInner = inner ? compileRenderer(inner, warnings) : null;
      const cluster = {
        kind: type === "pointCluster" ? "cluster" : "displacement",
        // 実属性名(実機 QGIS4 検証済み): クラスタ/変位の距離は
        // tolerance + toleranceUnit。distance/distance_unit は存在しない旧名フォールバック
        distancePx: sizeToPx(rendererEl.getAttribute("tolerance") ?? rendererEl.getAttribute("distance") ?? 2,
          rendererEl.getAttribute("toleranceUnit") || rendererEl.getAttribute("distance_unit") || "MM") || 30,
        // pointDisplacement の配置方式は placement(0=Ring,1=ConcentricRings,2=Grid)。
        // point_displacement_renderer は存在しない旧名フォールバック
        ringStyle: { 0: "ring", 1: "concentric", 2: "grid" }[Number(rendererEl.getAttribute("placement"))]
          ?? String(rendererEl.getAttribute("point_displacement_renderer") ?? ""),
        // 中心シンボルは <symbol> 子要素(属性ではない)。旧属性名も読むが
        // 実機 QGIS4 の出力には存在しない
        renderer: rendererEl.getAttribute("renderer") || rendererEl.getAttribute("centerSymbol") || "",
      };
      if (type === "pointDisplacement") {
        warnOnce(warnings, "pointDisplacement は点群の放射配置を再現しません(中心点シンボルで近似)");
      }
      if (compiledInner) return { ...compiledInner, cluster };
      warnOnce(warnings, `レンダラ ${type} には未対応です(既定スタイルで描画)`);
      return { evaluate: () => [], ...ctx, unsupported: true, cluster };
    }
    default: {
      // mergedFeatureRenderer / embedded 等のラッパー系は内側の renderer-v2 に委譲する
      const inner = [...rendererEl.children].find(c => c.tagName === "renderer-v2");
      if (inner) return compileRenderer(inner, warnings);
      warnOnce(warnings, `レンダラ ${type} には未対応です(既定スタイルで描画)`);
      return { evaluate: () => [], ...ctx, unsupported: true };
    }
  }
}

// ---------------------------------------------------------------------------
// シンボルレイヤ → 正規化スタイル
// ---------------------------------------------------------------------------

// マーカー形状名 → canvas パス描画関数(中心0,0・半径1に正規化)
const MARKER_SHAPES = {
  circle(ctx) { ctx.arc(0, 0, 1, 0, Math.PI * 2); },
  semi_circle(ctx) { ctx.arc(0, 0, 1, Math.PI, 0); ctx.closePath(); },
  third_circle(ctx) { ctx.arc(0, 0, 1, Math.PI * 0.83, Math.PI * 0.17); ctx.closePath(); },
  quarter_circle(ctx) { ctx.moveTo(0, 0); ctx.arc(0, 0, 1, -Math.PI / 2, 0); ctx.closePath(); },
  square(ctx) { ctx.rect(-0.85, -0.85, 1.7, 1.7); },
  rectangle(ctx) { ctx.rect(-1, -0.7, 2, 1.4); },
  rounded_square(ctx) { ctx.roundRect(-0.85, -0.85, 1.7, 1.7, 0.3); },
  rounded_rectangle(ctx) { ctx.roundRect(-1, -0.7, 2, 1.4, 0.25); },
  diamond(ctx) { ctx.moveTo(0, -1); ctx.lineTo(0.8, 0); ctx.lineTo(0, 1); ctx.lineTo(-0.8, 0); ctx.closePath(); },
  pentagon(ctx) { polygonPath(ctx, 5, -Math.PI / 2); },
  hexagon(ctx) { polygonPath(ctx, 6, -Math.PI / 2); },
  octagon(ctx) { polygonPath(ctx, 8, -Math.PI / 2); },
  triangle(ctx) { polygonPath(ctx, 3, -Math.PI / 2); },
  equilateral_triangle(ctx) { polygonPath(ctx, 3, -Math.PI / 2); },
  right_triangle(ctx) { ctx.moveTo(-1, 1); ctx.lineTo(1, 1); ctx.lineTo(1, -1); ctx.closePath(); },
  star(ctx) { starPath(ctx, 5, 0.4); },
  regular_star(ctx) { starPath(ctx, 5, 0.4); },
  rounded_star(ctx) { starPath(ctx, 5, 0.5); },
  asterisk_fill(ctx) { starPath(ctx, 6, 0.55); },
  heart(ctx) {
    ctx.moveTo(0, 0.9);
    ctx.bezierCurveTo(-1.4, -0.1, -0.8, -1.1, 0, -0.5);
    ctx.bezierCurveTo(0.8, -1.1, 1.4, -0.1, 0, 0.9);
    ctx.closePath();
  },
  cross(ctx) {
    const w = 0.28;
    ctx.moveTo(-w, -1); ctx.lineTo(w, -1); ctx.lineTo(w, -w); ctx.lineTo(1, -w);
    ctx.lineTo(1, w); ctx.lineTo(w, w); ctx.lineTo(w, 1); ctx.lineTo(-w, 1);
    ctx.lineTo(-w, w); ctx.lineTo(-1, w); ctx.lineTo(-1, -w); ctx.lineTo(-w, -w);
    ctx.closePath();
  },
  cross_fill(ctx) { MARKER_SHAPES.cross(ctx); },
  cross2(ctx) {
    ctx.moveTo(-1, -1); ctx.lineTo(1, 1); ctx.moveTo(1, -1); ctx.lineTo(-1, 1);
  },
  x(ctx) { MARKER_SHAPES.cross2(ctx); },
  diagonal_cross(ctx) { MARKER_SHAPES.cross2(ctx); },
  line(ctx) { ctx.moveTo(0, -1); ctx.lineTo(0, 1); },
  arrow(ctx) {
    ctx.moveTo(0, 1); ctx.lineTo(0, -0.45);
    ctx.moveTo(-0.55, 0); ctx.lineTo(0, -0.45); ctx.lineTo(0.55, 0);
  },
  arrowhead(ctx) { ctx.moveTo(-0.7, 0.7); ctx.lineTo(0, -0.4); ctx.lineTo(0.7, 0.7); },
  filled_arrowhead(ctx) { ctx.moveTo(-0.7, 0.7); ctx.lineTo(0, -0.6); ctx.lineTo(0.7, 0.7); ctx.closePath(); },
  half_square(ctx) { ctx.rect(-0.85, 0, 1.7, 0.85); },
  quarter_square(ctx) { ctx.rect(0, 0, 0.85, 0.85); },
  third_square(ctx) { ctx.rect(-0.85, 0.28, 1.7, 0.57); },
  trapezoid(ctx) { ctx.moveTo(-0.6, -0.8); ctx.lineTo(0.6, -0.8); ctx.lineTo(1, 0.8); ctx.lineTo(-1, 0.8); ctx.closePath(); },
  parallelogram_left(ctx) { ctx.moveTo(-0.5, -0.8); ctx.lineTo(1, -0.8); ctx.lineTo(0.5, 0.8); ctx.lineTo(-1, 0.8); ctx.closePath(); },
  parallelogram_right(ctx) { ctx.moveTo(-1, -0.8); ctx.lineTo(0.5, -0.8); ctx.lineTo(1, 0.8); ctx.lineTo(-0.5, 0.8); ctx.closePath(); },
  shield(ctx) {
    ctx.moveTo(0, -0.9); ctx.lineTo(0.8, -0.6); ctx.lineTo(0.7, 0.3);
    ctx.quadraticCurveTo(0.6, 0.8, 0, 1); ctx.quadraticCurveTo(-0.6, 0.8, -0.7, 0.3);
    ctx.lineTo(-0.8, -0.6); ctx.closePath();
  },
  play(ctx) { polygonPath(ctx, 3, 0); },
};

function polygonPath(ctx, sides, startAngle) {
  for (let i = 0; i < sides; i++) {
    const a = startAngle + (i / sides) * Math.PI * 2;
    const x = Math.cos(a), y = Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function starPath(ctx, points, innerRatio) {
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 1 : innerRatio;
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// 線のみの形状(塗りつぶさずストロークのみ)
const STROKE_ONLY_SHAPES = new Set(["cross2", "x", "diagonal_cross", "line", "arrow", "arrowhead"]);

import { kascZipLogicalUrl, resolveKascUrl } from "./kasc.js";

// 画像の遅延ロード管理(コンパイル時に収集した URL を一括ロードする)
function resolveResourceUrl(path, baseUrl) {
  const s = String(path || "").trim();
  if (!s) return null;
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  // baseUrl が ZIP メンバ由来の blob: なら論理 kasczip:// 基点へ戻して
  // 相対解決し、結果は resolveKascUrl で blob: へ変換する
  const base = (typeof kascZipLogicalUrl === "function" && kascZipLogicalUrl(baseUrl)) || baseUrl;
  // Windows/Unix の絶対パスはブラウザから読めないためベース名で相対解決を試みる
  if (/^([a-z]:[\\/]|\\\\|\/)/i.test(s)) {
    const b = s.split(/[\\/]/).pop();
    try { return resolveKascUrl(new URL(b, base).href); } catch (e) { return null; }
  }
  try { return resolveKascUrl(new URL(s, base).href); } catch (e) { return s; }
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// SVG を param(fill)/param(outline) で再着色して data URL 化する
async function loadSvgRecolored(url, fillColor, strokeColor, fetchText) {
  try {
    const text = await fetchText(url);
    let svg = String(text);
    if (fillColor) {
      const c = rgbaToCss(fillColor);
      svg = svg.replace(/param\(fill[^)]*\)/gi, c).replace(/fill="(?!none)[^"]*"/gi, `fill="${c}"`);
    }
    if (strokeColor) {
      const c = rgbaToCss(strokeColor);
      svg = svg.replace(/param\(outline[^)]*\)/gi, c).replace(/stroke="(?!none)[^"]*"/gi, `stroke="${c}"`);
    }
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    return img;
  } catch (e) {
    return null;
  }
}

export function rgbaToCss(rgba) {
  const [r, g, b, a] = rgba.map(v => Math.round(v * 255));
  return a >= 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(rgba[3]).toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// マーカー/ライン/塗りつぶしレイヤの正規化(DD 適用済みの「描ける形」)
// ---------------------------------------------------------------------------

// マーカーのオフセット("x,y" + offset_unit)とアンカー点
// (horizontal_anchor_point/vertical_anchor_point または anchor_x/anchor_y: 0..1)を
// ピクセルオフセットへ正規化する。アンカーはシンボル内の基準点(0.5=中央)で、
// (0.5-anchor)*sizePx だけ描画位置がずれる
function markerOffsetPx(p, dd, props, sizePx) {
  const raw = String(ddValue(dd, ["offset"], props, p.offset ?? "0,0"));
  const [ox0, oy0] = raw.split(",").map(Number);
  const unit = p.offset_unit || "MM";
  let ox = sizeToPx(ox0 || 0, unit);
  let oy = -sizeToPx(oy0 || 0, unit);
  const ax = Number(p.horizontal_anchor_point ?? p.anchor_x);
  const ay = Number(p.vertical_anchor_point ?? p.anchor_y);
  if (Number.isFinite(ax) && ax !== 0.5) ox += (ax - 0.5) * (sizePx || 0);
  if (Number.isFinite(ay) && ay !== 0.5) oy += (ay - 0.5) * (sizePx || 0);
  return [ox || 0, oy || 0];
}

function resolveMarkerLayer(layer, props, images, warnings) {
  const arr = resolveMarkerLayerBase(layer, props, images, warnings) || [];
  // MapUnit/MetersInMapUnits のマーカーサイズはメートル値を保持する。
  // 対応エンジンがカメラ距離連動で拡縮し、非対応エンジンは sizePx 近似のまま
  const unit = layer?.props?.size_unit || "MM";
  if (unit === "MapUnit" || unit === "MetersInMapUnits") {
    const n = Number(ddValue(layer?.dd, ["size"], props, layer?.props?.size ?? 2));
    if (Number.isFinite(n) && n > 0) {
      warnOnce(warnings, "MapUnit/MetersInMapUnits のマーカーサイズは距離連動スケーリングです(非対応エンジンは px 近似)");
      for (const m of arr) if (m && typeof m === "object") m.sizeMeters = n;
    }
  }
  return arr;
}

function resolveMarkerLayerBase(layer, props, images, warnings) {
  const p = layer.props;
  const dd = layer.dd;
  const sizeUnit = p.size_unit || "MM";
  const sizePx = sizeToPx(ddValue(dd, ["size"], props, p.size ?? 2), sizeUnit);
  const angle = Number(ddValue(dd, ["angle"], props, p.angle ?? 0)) || 0;
  const alpha = 1;
  const offsetPx = markerOffsetPx(p, dd, props, sizePx);

  switch (layer.cls) {
    case "SimpleMarker": {
      const name = String(ddValue(dd, ["name"], props, p.name ?? "circle")).toLowerCase();
      const fill = parseQgisColor(ddValue(dd, ["fillColor", "color"], props, p.color), [0.2, 0.4, 0.9, 1]);
      const stroke = parseQgisColor(ddValue(dd, ["outlineColor", "outline_color", "color_border"], props, p.outline_color ?? p.color_border), null);
      const outlineStyle = String(p.outline_style || "solid");
      const strokeWidth = sizeToPx(ddValue(dd, ["outlineWidth", "outline_width"], props, p.outline_width ?? 0), p.outline_width_unit || "MM");
      return [{
        kind: "shape",
        shape: MARKER_SHAPES[name] ? name : "circle",
        sizePx, fill,
        stroke: outlineStyle === "no" ? null : stroke,
        strokeWidthPx: strokeWidth,
        rotationDeg: angle,
        offsetPx,
        alpha,
      }];
    }
    case "EllipseMarker": {
      const w = sizeToPx(ddValue(dd, ["width", "symbol_width"], props, p.symbol_width ?? p.size ?? 2), sizeUnit);
      const h = sizeToPx(ddValue(dd, ["height", "symbol_height"], props, p.symbol_height ?? p.size ?? 2), sizeUnit);
      const fill = parseQgisColor(ddValue(dd, ["fillColor", "color"], props, p.color), [0.2, 0.4, 0.9, 1]);
      const stroke = parseQgisColor(ddValue(dd, ["outlineColor", "outline_color"], props, p.outline_color), null);
      const strokeWidth = sizeToPx(ddValue(dd, ["outlineWidth", "outline_width"], props, p.outline_width ?? 0), p.outline_width_unit || "MM");
      return [{
        kind: "ellipse", widthPx: w, heightPx: h, fill,
        stroke: String(p.outline_style) === "no" ? null : stroke,
        strokeWidthPx: strokeWidth,
        rotationDeg: angle, offsetPx, alpha,
      }];
    }
    case "SvgMarker":
    case "RasterMarker": {
      const pathKey = String(p.name ?? p.imageFile ?? p.path ?? "");
      const image = images.get(pathKey) || null;
      // SVG/ラスタマーカーは幅・高さの DD(size とは別名)で拡縮される(#dd)
      const wdd = ddValue(dd, ["width", "symbol_width"], props, null);
      const hdd = ddValue(dd, ["height", "symbol_height"], props, null);
      const imgSizePx = (wdd != null || hdd != null)
        ? Math.max(sizeToPx(wdd ?? hdd, sizeUnit) || 0, sizeToPx(hdd ?? wdd, sizeUnit) || 0, 1)
        : sizePx;
      if (!image) {
        warnOnce(warnings, `${layer.cls} の画像を読めませんでした: ${pathKey}(円で代替)`);
        const fill = parseQgisColor(p.color, [0.2, 0.4, 0.9, 1]);
        return [{ kind: "shape", shape: "circle", sizePx: imgSizePx, fill, stroke: null, strokeWidthPx: 0, rotationDeg: angle, offsetPx, alpha }];
      }
      return [{ kind: "image", image, sizePx: imgSizePx, rotationDeg: angle, offsetPx, alpha }];
    }
    case "FontMarker":
    case "MdiFontMarker": {
      const chr = String(ddValue(dd, ["char", "chr"], props, p.chr ?? ""));
      const font = String(ddValue(dd, ["fontFamily"], props, p.font) || p.font || p.font_family || "sans-serif");
      const fill = parseQgisColor(ddValue(dd, ["fillColor", "color"], props, p.color), [0.2, 0.2, 0.2, 1]);
      const stroke = parseQgisColor(ddValue(dd, ["outlineColor", "outline_color"], props, p.outline_color), null);
      const strokeWidth = sizeToPx(ddValue(dd, ["outlineWidth", "outline_width"], props, p.outline_width ?? 0), "MM");
      return [{
        kind: "text", text: chr, fontFamily: font, sizePx, fill,
        stroke, strokeWidthPx: strokeWidth,
        rotationDeg: angle, offsetPx, alpha,
      }];
    }
    case "FilledMarker": {
      // 内部の fill サブシンボル色で形状を塗る
      const name = String(ddValue(dd, ["name"], props, p.name ?? "circle")).toLowerCase();
      let fill = parseQgisColor(p.color, [0.5, 0.5, 0.5, 1]);
      if (layer.subSymbol) {
        const sub = resolveSymbolLayers(layer.subSymbol, props, images, warnings);
        const solid = sub.fillParts?.find(pt => pt.kind === "solid");
        if (solid) fill = solid.color;
      }
      const stroke = parseQgisColor(ddValue(dd, ["outlineColor", "outline_color"], props, p.outline_color), null);
      const strokeWidth = sizeToPx(ddValue(dd, ["outlineWidth", "outline_width"], props, p.outline_width ?? 0), "MM");
      return [{
        kind: "shape", shape: MARKER_SHAPES[name] ? name : "circle", sizePx, fill,
        stroke, strokeWidthPx: strokeWidth, rotationDeg: angle, offsetPx, alpha,
      }];
    }
    case "AnimatedMarker": {
      // アニメーションマーカー(#108): 動画再生は未対応のため先頭フレームを静止表示。
      // 実プロパティ名は imageFile(実機検証済み)
      const pathKey = String(p.imageFile ?? p.name ?? p.file ?? "");
      const image = pathKey ? images.get(pathKey) || null : null;
      if (image) {
        warnOnce(warnings, "AnimatedMarker は先頭フレームのみ静止表示です(アニメーション未対応)");
        return [{ kind: "image", image, sizePx, rotationDeg: angle, offsetPx, alpha }];
      }
      warnOnce(warnings, `AnimatedMarker の画像を読めませんでした: ${pathKey || "?"}(円で代替)`);
      const fill = parseQgisColor(p.color, [0.2, 0.4, 0.9, 1]);
      return [{ kind: "shape", shape: "circle", sizePx, fill, stroke: null, strokeWidthPx: 0, rotationDeg: angle, offsetPx, alpha }];
    }
    case "GeometryGenerator": {
      // 一般形(#64): 式を spec へ持ち出し、描画側が地物ジオメトリへ評価する。
      // サブシンボルは通常のマーカー解決を再利用
      const expr = String(p.geometryModifier ?? p.geometry_modifier ?? "") || "$geometry";
      if (layer.subSymbol) {
        const sub = resolveSymbolLayers(layer.subSymbol, props, images, warnings);
        if (sub.markers?.length) {
          warnOnce(warnings, `GeometryGenerator は近似評価です(buffer/translate/centroid/exterior_ring/boundary/convex_hull/envelope 等の常用関数のみ)`);
          return [{ gg: { expr, markers: sub.markers } }];
        }
      }
      warnOnce(warnings, "GeometryGenerator マーカーは未対応です(スキップ)");
      return [];
    }
    case "VectorField": {
      // ベクトル場(QGIS4・実機検証済み)。実プロパティ名:
      //   x_attribute/y_attribute=成分フィールド名
      //   vector_field_type=0 Cartesian(x,y) / 1 Polar(x=向き,y=大きさ) / 2 HeightOnly
      //   angle_orientation=0 北基準時計回り / 1 東基準反時計回り(数学角)
      //   angle_units=0 度 / 1 ラジアン。scale=大きさ乗数、distance_unit=成分単位
      //   size/size_unit=矢印長のフォールバック(属性欠損・凡例用)
      // サブシンボルは line シンボル(矢印の線色・太さ)。描画は矢印画像の
      // 地物別回転/拡縮で近似する(真の線形描画ではない)
      const xAttr = String(p.x_attribute ?? "");
      const yAttr = String(p.y_attribute ?? "");
      const ftype = Number(p.vector_field_type ?? 0);
      const scale = Number(p.scale ?? 1) || 1;
      const xv = xAttr ? Number(props?.[xAttr]) : NaN;
      const yv = yAttr ? Number(props?.[yAttr]) : NaN;
      let rotDeg = 0, mag = NaN;
      if (ftype === 1) {
        // Polar: x=向き y=大きさ
        if (Number.isFinite(xv) && Number.isFinite(yv)) {
          let a = xv;
          if (Number(p.angle_units ?? 0) === 1) a = a * 180 / Math.PI;
          rotDeg = Number(p.angle_orientation ?? 0) === 1 ? 90 - a : a;
          mag = yv;
        }
      } else if (ftype === 2) {
        // HeightOnly: 大きさ=y 属性(向きは固定上向き)
        if (Number.isFinite(yv)) mag = yv;
      } else {
        // Cartesian: ベクトル角=atan2(x,y)。北=0 で時計回り
        if (Number.isFinite(xv) && Number.isFinite(yv)) {
          rotDeg = Math.atan2(xv, yv) * 180 / Math.PI;
          mag = Math.hypot(xv, yv);
        }
      }
      if (!Number.isFinite(mag)) {
        if (!xAttr && !yAttr) mag = Number(p.size ?? 2) || 2; // 属性未設定→固定矢印(凡例)
        else {
          warnOnce(warnings, `VectorField の属性(${xAttr || "?"},${yAttr || "?"})が地物に無いか数値ではありません(スキップ)`);
          return [];
        }
      }
      const lenPx = mag * scale;
      if (!(lenPx > 0)) return [];
      const arrowPx = Math.max(sizeToPx(lenPx, p.distance_unit || "MM"), 1);
      let color = parseQgisColor(p.color ?? p.line_color, [0, 0, 0, 1]);
      let strokeWidthPx = Math.max(sizeToPx(0.26, "MM"), 0.8);
      if (layer.subSymbol) {
        for (const l of layer.subSymbol.layers || []) {
          if (!l.enabled) continue;
          const r = resolveLineLayer(l, props, warnings, images);
          if (r?.color) { color = r.color; strokeWidthPx = r.widthPx || strokeWidthPx; break; }
        }
      }
      warnOnce(warnings, "VectorField は矢印画像の回転/拡縮で近似します(線形描画ではありません)");
      return [{
        kind: "arrow", sizePx: arrowPx,
        // 向きは canvas へ焼き込む(rotationDeg=0 として billboard/Icon 側の
        // 再回転を抑止。地物別の向きは spec 評価値として保持)
        rotationDeg: 0,
        bakeRotationDeg: Number.isFinite(rotDeg) ? rotDeg : 0,
        color, strokeWidthPx, offsetPx, alpha,
      }];
    }
    case "MaskMarker": {
      // マスク形状マーカー(QGIS4): サブシンボル(マーカー)をそのまま描画する。
      // QGIS ではこの形状がラベル/他シンボルレイヤの「マスク」としても登録される
      // が、Web エンジンでは真のマスク効果(遮蔽抜き)は実現不能なため形状のみ
      warnOnce(warnings, "MaskMarker のマスク効果(ラベル/シンボル遮蔽)は未対応です(形状のみ描画)");
      if (!layer.subSymbol) return [];
      return layer.subSymbol.layers.flatMap(l =>
        l.enabled ? resolveMarkerLayer(l, props, images, warnings) : []);
    }
    default:
      warnOnce(warnings, `マーカーシンボル ${layer.cls} は未対応です(円で代替)`);
      return [{
        kind: "shape", shape: "circle", sizePx,
        fill: parseQgisColor(p.color, [0.2, 0.4, 0.9, 1]),
        stroke: null, strokeWidthPx: 0, rotationDeg: angle, offsetPx, alpha,
      }];
  }
}

// LinearReferencing の text_format / numeric_format は Option 値内の
// エスケープ済み XML 文字列(<text-style>/<numericFormat>)。実機 QGIS4 で確認
function parseEmbeddedXml(xmlStr) {
  const s = String(xmlStr || "").trim();
  if (!s.startsWith("<")) return null;
  try {
    const d = new DOMParser().parseFromString(s, "application/xml");
    if (d.querySelector("parsererror")) return null;
    return d.documentElement || null;
  } catch (_) { return null; }
}

// 里程標ラベルのフォント情報(text_format → <text-style>)。ラベル配置一式は
// 不要なためフォント・色・バッファのみ抜く
function parseLinRefTextFormat(xmlStr) {
  const el = parseEmbeddedXml(xmlStr);
  if (!el) return null;
  const a = n => el.getAttribute(n);
  const sizePx = Math.max(sizeToPx(Number(a("fontSize")) || 10, a("fontSizeUnit") || "Point"), 6);
  const bufEl = el.querySelector?.("text-buffer") || null;
  const halo = qgisBool(bufEl?.getAttribute("bufferDraw"))
    ? { color: withAlpha(parseQgisColor(bufEl.getAttribute("bufferColor"), [1, 1, 1, 1]),
        Number(bufEl.getAttribute("bufferOpacity") ?? 1)),
        widthPx: Math.max(sizeToPx(bufEl.getAttribute("bufferSize") ?? 1,
          bufEl.getAttribute("bufferSizeUnits") || bufEl.getAttribute("bufferSizeUnit") || "MM"), 1) }
    : null;
  const namedStyle = String(a("namedStyle") || "").toLowerCase();
  const bold = qgisBool(a("fontBold")) || qgisBool(a("forcedBold"))
    || Number(a("fontWeight")) >= 50 || namedStyle.includes("bold") || namedStyle.includes("太");
  const italic = qgisBool(a("fontItalic")) || qgisBool(a("forcedItalic"))
    || namedStyle.includes("italic") || namedStyle.includes("oblique");
  const family = a("fontFamily") || "sans-serif";
  return {
    fill: withAlpha(parseQgisColor(a("textColor"), [0, 0, 0, 1]), Number(a("textOpacity") ?? 1)),
    sizePx, halo, family, bold, italic,
    fontCss: `${italic ? "italic " : ""}${bold ? "bold " : ""}${Math.round(sizePx)}px ${family}`,
  };
}

// 里程標の数値書式(numeric_format → <numericFormat id="basic"><Option>…)。
// rounding_type=0 小数桁 / 1 有効桁(近似で同桁丸め)。basic 以外(currency 等)も
// 近似として basic に畳む
function parseLinRefNumericFormat(xmlStr) {
  const el = parseEmbeddedXml(xmlStr);
  if (!el) return null;
  const m = optionMap(el) || {};
  return {
    id: String(el.getAttribute("id") || "basic"),
    decimals: Number.isFinite(Number(m.decimals)) ? Number(m.decimals) : 0,
    plus: qgisBool(m.show_plus),
    thousands: String(m.show_thousand_separator ?? "true").toLowerCase() !== "false"
      && String(m.show_thousand_separator) !== "0",
    trailingZeros: qgisBool(m.show_trailing_zeros),
  };
}

// 里程標ラベル文字列。distM: 線先端からの累積距離(メートル)
export function linRefFormatText(distM, num) {
  const n = num || {};
  const dec = Number.isFinite(n.decimals) ? n.decimals : 0;
  let s;
  if (n.trailingZeros) s = Number(distM).toFixed(Math.max(dec, 0));
  else {
    s = dec > 0 ? Number(distM).toFixed(dec).replace(/\.?0+$/, "") : String(Math.round(distM));
  }
  if (n.thousands) {
    const neg = s.startsWith("-");
    const body = neg ? s.slice(1) : s;
    const [i, f] = body.split(".");
    s = (neg ? "-" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
  }
  if (n.plus && distM > 0) s = "+" + s;
  return s;
}

function resolveLineLayer(layer, props, warnings, images = null) {
  const p = layer.props;
  const dd = layer.dd;
  const widthUnit = p.line_width_unit || "MM";
  switch (layer.cls) {
    case "SimpleLine": {
      // 実 QML の DD 名: 線色=outlineColor, 線幅=outlineWidth, 線種=outlineStyle,
      // トリム=trimStart/trimEnd(実機 QGIS4 検証済み。qml-spec スキル参照)
      const color = parseQgisColor(ddValue(dd, ["outlineColor", "lineColor", "line_color", "color"], props, p.line_color), [0, 0, 0, 1]);
      const widthPx = sizeToPx(ddValue(dd, ["outlineWidth", "width", "lineWidth", "line_width", "outline_width"], props, p.line_width ?? 0.26), widthUnit);
      const ddDash = ddValue(dd, ["customDash"], props, null);
      const custom = (ddDash != null && ddDash !== "") ? String(ddDash)
        : (p.use_custom_dash === "1" || p.use_custom_dash === "true" ? p.customdash : null);
      const dash = dashPattern(ddValue(dd, ["outlineStyle", "lineStyle", "line_style"], props, p.line_style), custom, widthPx, p.customdash_unit);
      if (dash === "none") return null;
      // 線端トリム・破線開始オフセット。trim はジオメトリ近似で再現するため
      // px 値を spec に保持する(対応しないエンジンは無視)
      const trimStartPx = sizeToPx(ddValue(dd, ["trimStart", "trimDistanceStart", "trim_distance_start"], props,
        p.trim_distance_start ?? 0), p.trim_distance_start_unit || "MM") || 0;
      const trimEndPx = sizeToPx(ddValue(dd, ["trimEnd", "trimDistanceEnd", "trim_distance_end"], props,
        p.trim_distance_end ?? 0), p.trim_distance_end_unit || "MM") || 0;
      const dashOffsetPx = sizeToPx(ddValue(dd, ["dashPatternOffset", "dash_pattern_offset"], props,
        p.dash_pattern_offset ?? 0), p.dash_pattern_offset_unit || "MM") || 0;
      if (trimStartPx || trimEndPx) {
        warnOnce(warnings, "trim_distance はジオメトリ切断で近似再現します(基準縮尺1:1万換算)");
      }
      return {
        color, widthPx: Math.max(widthPx, 1), dash,
        // 結合部・端部・オフセット(2D エンジンで反映)
        join: { bevel: "bevel", miter: "miter", miter2: "miter", round: "round" }[String(p.joinstyle || "bevel").toLowerCase()] || "bevel",
        cap: { square: "square", flat: "butt", round: "round" }[String(p.capstyle || "square").toLowerCase()] || "butt",
        offsetPx: sizeToPx(ddValue(dd, ["offset"], props, p.offset ?? 0), p.offset_unit || "MM") || 0,
        trimStartPx, trimEndPx, dashOffsetPx,
      };
    }
    case "InterpolatedLine": {
      // QGIS の補間ライン: 始点→終点で幅・色を線形補間する。decor.interpolated を
      // 持ち、対応エンジン(Cesium)では線分細分化で再現する(#108)。
      // 実プロパティ名(実機検証済み): coloring_method/single_color/color_ramp_shader/
      // line_width/width_varying_is_variable_width/width_varying_minimum_width/
      // width_varying_maximum_width。DD は lineStartColorValue/lineEndColorValue/
      // lineStartWidthValue/lineEndWidthValue
      const ramp = p.color_ramp_shader && typeof p.color_ramp_shader === "object" ? p.color_ramp_shader : null;
      const rampC1 = ramp ? (ramp.color1 ?? ramp["stop_0"]) : null;
      const rampC2 = ramp ? (ramp.color2 ?? ramp["stop_100"]) : null;
      const isRamp = /colorramp|ramp/i.test(String(p.coloring_method ?? ""));
      const colorStart = parseQgisColor(ddValue(dd, ["lineStartColorValue", "startColor", "start_color", "color_start"], props,
        (isRamp ? rampC1 : p.single_color) ?? rampC1 ?? p.single_color ?? p.line_color ?? p.color), [0, 0, 0, 1]);
      const colorEnd = parseQgisColor(ddValue(dd, ["lineEndColorValue", "endColor", "end_color", "color_end"], props,
        (isRamp ? rampC2 : null) ?? rampC2 ?? p.single_color ?? p.line_color ?? p.color), colorStart);
      // 可変幅: width_varying_is_variable_width=1 のとき minimum/maximum_width、
      // それ以外は両端 line_width
      const variable = String(p.width_varying_is_variable_width ?? "0") === "1"
        || String(p.width_varying_is_variable_width).toLowerCase() === "true";
      const w1v = variable ? (p.width_varying_minimum_width ?? p.line_width ?? 0.26) : (p.line_width ?? 0.26);
      const w2v = variable ? (p.width_varying_maximum_width ?? w1v) : w1v;
      const widthStartPx = Math.max(sizeToPx(ddValue(dd, ["lineStartWidthValue", "widthStart", "width_start"], props,
        w1v), widthUnit) || 0, 0.5);
      const widthEndPx = Math.max(sizeToPx(ddValue(dd, ["lineEndWidthValue", "widthEnd", "width_end"], props,
        w2v), widthUnit) || 0, 0.5);
      warnOnce(warnings, "InterpolatedLine は始点→終点の線形補間で近似です(未対応エンジンは単色)");
      // decor {kind:"interpolated"} は対応エンジン(Cesium)が弧長分割で
      // 幅・色補間を再現する契約。非対応エンジンは color/widthPx の単色線
      return {
        color: colorStart, widthPx: Math.max(widthStartPx, widthEndPx, 1), dash: null,
        decor: { kind: "interpolated", c1: colorStart, c2: colorEnd, w1: widthStartPx, w2: widthEndPx },
      };
    }
    case "FilledLine": {
      // 塗りつぶしライン(QGIS4・実機検証済み)。line_width 幅のコリドーを
      // fill サブシンボルで塗る。全エンジンで「太線」として成立するよう
      // 塗り色→color・line_width→widthPx へ畳み、Cesium は
      // decor.filledline で CorridorGraphics によるネイティブ塗りへ振り分ける
      const widthPx = Math.max(sizeToPx(ddValue(dd, ["outlineWidth", "width", "lineWidth", "line_width", "outline_width"], props,
        p.line_width ?? 1), widthUnit), 1);
      let fillParts = null, flOutline = null;
      if (layer.subSymbol) {
        const sub = resolveSymbolLayers(layer.subSymbol, props, images, warnings);
        fillParts = sub.fillParts;
        flOutline = sub.outline;
      }
      // 線描画エンジン用の代表色: 塗り部品から優先度順に拾う
      const solid = fillParts?.find(pt => pt.solid)?.solid
        ?? fillParts?.find(pt => pt.hatch)?.color
        ?? fillParts?.find(pt => pt.linePattern)?.color
        ?? fillParts?.find(pt => pt.pointPattern)?.markers?.[0]?.fill
        ?? fillParts?.find(pt => pt.gradient)?.color1
        ?? parseQgisColor(p.color, [0.5, 0.5, 0.5, 1]);
      if (fillParts?.some(pt => !pt.solid)) {
        warnOnce(warnings, "FilledLine のパターン塗りはベース色で近似します");
      }
      const flJoin = { bevel: "bevel", miter: "miter", miter2: "miter", round: "round" }[String(p.joinstyle || "bevel").toLowerCase()] || "bevel";
      return {
        color: solid, widthPx, dash: null,
        join: flJoin,
        cap: { square: "square", flat: "butt", round: "round" }[String(p.capstyle || "square").toLowerCase()] || "butt",
        offsetPx: sizeToPx(ddValue(dd, ["offset"], props, p.offset ?? 0), p.offset_unit || "MM") || 0,
        // ネイティブ塗り用の情報(Cesium Corridor)
        decor: { kind: "filledline", widthPx, fillParts, outline: flOutline, join: flJoin },
      };
    }
    case "LinearReferencing": {
      // 里程標(QGIS4・実機検証済み)。線上に一定間隔で距離ラベル/マーカーを配置。
      // 実プロパティ名: interval(地図単位=m)/placement(IntervalCartesian2D等
      // の enum 文字列)/source(CartesianDistance2D)/rotate/show_marker/
      // skip_multiples/label_offset("x,y")/average_angle_length/
      // text_format(エスケープ<text-style>XML)/numeric_format(<numericFormat>XML)
      const intervalM = Math.max(Number(ddValue(dd, ["interval"], props, p.interval ?? 1000)) || 1000, 1);
      const loUnit = p.label_offset_unit || "MM";
      const [lox, loy] = String(p.label_offset ?? "0,0").split(",").map(Number);
      // QGIS の y+ は上方向 → canvas の y+ (下) と符号反転
      const labelOffsetPx = [sizeToPx(lox || 0, loUnit), -sizeToPx(loy || 0, loUnit)];
      const placement = String(p.placement ?? "IntervalCartesian2D").toLowerCase();
      const source = String(p.source ?? "CartesianDistance2D");
      if (!/cartesiandistance2d/i.test(source)) {
        warnOnce(warnings, `LinearReferencing の source=${source} は平面距離で近似します`);
      }
      if (!/interval/i.test(placement)) {
        warnOnce(warnings, `LinearReferencing の placement=${p.placement} は interval 配置で近似します`);
      }
      const markers = layer.subSymbol
        ? layer.subSymbol.layers.flatMap(l => l.enabled ? resolveMarkerLayer(l, props, images, warnings) : [])
        : [];
      warnOnce(warnings, "LinearReferencing(里程標)は線上等間隔配置の近似です(地図単位=m 換算)");
      return {
        // 本体は基線(ラベルのみでも地物は残す)。QGIS では線自体は描かないため
        // 描画側で decor.linref を検出して折れ線を隠す
        color: parseQgisColor(p.line_color ?? p.color, [0, 0, 0, 1]), widthPx: 1, dash: null,
        decor: {
          kind: "linref", intervalM, placement,
          rotate: String(p.rotate ?? "1") !== "0" && String(p.rotate).toLowerCase() !== "false",
          showMarker: String(p.show_marker ?? "0") === "1" || String(p.show_marker).toLowerCase() === "true",
          skipMultiples: Math.max(Number(p.skip_multiples) || 0, 0),
          avgAnglePx: sizeToPx(p.average_angle_length ?? 4, p.average_angle_unit || "MM") || 0,
          labelOffsetPx,
          startMeasure: Number(p.start_measure) || 0,
          text: parseLinRefTextFormat(p.text_format),
          num: parseLinRefNumericFormat(p.numeric_format),
          markers,
        },
      };
    }
    case "MarkerLine":
    // QGIS のハッシュ線(崖線・鉄道等の刻み)は "HashLine"、"HashedLine" は手書き・改名済みファイル用
    case "HashLine":
    case "HashedLine":
    case "Lineburst":
    case "ArrowLine":
    case "RasterLine":
    case "FadedLine": {
      // 装飾系ラインは単色ラインに近似する。色はサブシンボルや固有プロパティから拾う
      let color = parseQgisColor(p.line_color ?? p.color ?? p.start_color ?? p.single_color, null);
      if (!color && layer.subSymbol) {
        const sub = resolveMarkerLayerForLine(layer.subSymbol, props);
        color = sub;
      }
      let widthPx = sizeToPx(ddValue(dd, ["outlineWidth", "width", "lineWidth", "line_width", "outline_width"], props,
        p.line_width ?? p.width ?? 0), widthUnit);
      if (!widthPx && layer.subSymbol) {
        // HashLine 等は刻みストロークがサブシンボル(SimpleLine)側にある
        for (const l of layer.subSymbol.layers || []) {
          const w = sizeToPx(ddValue(l.dd, ["outlineWidth", "width", "lineWidth", "line_width", "outline_width"], props,
            l.props?.line_width ?? 0), l.props?.line_width_unit || "MM");
          if (w > 0) { widthPx = w; break; }
        }
      }
      // 装飾内容を保持し、対応エンジンで形状描画する(#54)
      const decor = buildLineDecor(layer, p, props, images, color, widthUnit, warnings);
      warnOnce(warnings, `ラインシンボル ${layer.cls} は一部エンジンで単色近似です`);
      return { color: color || [0, 0, 0, 1], widthPx: Math.max(widthPx || sizeToPx(0.26, "MM"), 1), dash: null, decor };
    }
    case "GeometryGenerator": {
      const expr = String(p.geometryModifier ?? p.geometry_modifier ?? "") || "$geometry";
      if (layer.subSymbol) {
        const sub = resolveSymbolLayers(layer.subSymbol, props, images, warnings);
        const line = sub.line;
        if (line) {
          warnOnce(warnings, `GeometryGenerator は近似評価です(buffer/translate/centroid/exterior_ring/boundary/convex_hull/envelope 等の常用関数のみ)`);
          return { gg: { expr, line } };
        }
      }
      warnOnce(warnings, "GeometryGenerator ラインは未対応です(スキップ)");
      return null;
    }
    default:
      warnOnce(warnings, `ラインシンボル ${layer.cls} は未対応です`);
      return { color: parseQgisColor(p.line_color ?? p.color, [0, 0, 0, 1]), widthPx: 1, dash: null };
  }
}

function resolveMarkerLayerForLine(symbol, props) {
  for (const l of symbol?.layers || []) {
    const c = parseQgisColor(l.props?.color ?? l.props?.line_color, null);
    if (c) return c;
  }
  return null;
}

// MarkerLine/HashLine/ArrowLine 等の装飾内容を正規化して返す。
// 幾何学的に描けるエンジン(OpenLayers 等)で形状再現し、それ以外は単色近似
function buildLineDecor(layer, p, props, images, color, widthUnit, warnings) {
  const cls = layer.cls;
  const dd = layer.dd;
  // DD: interval/placement は実名(実機検証済み)
  const intervalPx = sizeToPx(ddValue(dd, ["interval"], props, p.interval ?? p.repeat_distance ?? 3),
    p.interval_unit || p.repeat_distance_unit || "MM") || 0;
  // QGIS4 は placements(enum名文字列: Interval/Vertex/...)。旧名 placement も拾う
  const placement = String(ddValue(dd, ["placement"], props, p.placements ?? p.placement ?? "interval")).toLowerCase(); // interval|centralpoint|vertex|firstvertex|lastvertex|curvepoint
  if (cls === "MarkerLine") {
    const markers = layer.subSymbol
      ? layer.subSymbol.layers.flatMap(l => l.enabled ? resolveMarkerLayer(l, props, images, warnings) : [])
      : [];
    return { kind: "markerline", intervalPx: intervalPx || sizeToPx(4, "MM"), placement, markers,
      // QGIS4 は rotate(bool)。旧名 rotate_marker も拾う
      rotateMarker: String(p.rotate ?? p.rotate_marker ?? "1") !== "0" };
  }
  if (cls === "HashLine" || cls === "HashedLine") {
    // 刻みの長さ・間隔・角度。QGIS 既定: 斜め 45 度の刻み
    const tick = layer.subSymbol?.layers?.find(l => l.enabled && l.props) || null;
    const tickLenPx = sizeToPx(p.hash_length ?? p.length ?? 1, p.hash_length_unit || "MM") || sizeToPx(1, "MM");
    const tickColor = parseQgisColor(tick?.props?.line_color ?? tick?.props?.color ?? color, [0, 0, 0, 1]);
    const tickWidthPx = sizeToPx(ddValue(tick?.dd, ["outlineWidth", "width", "lineWidth", "line_width", "outline_width"], props,
      tick?.props?.line_width ?? p.line_width ?? 0.26), "MM") || 1;
    const hashAngle = Number(p.hash_angle ?? p.angle ?? 90);
    return { kind: "hashline", intervalPx: intervalPx || sizeToPx(2, "MM"),
      tick: { color: tickColor, widthPx: Math.max(tickWidthPx, 0.5), lengthPx: tickLenPx, angleDeg: hashAngle } };
  }
  if (cls === "InterpolatedLine") {
    // 始端→終端の色・幅補間(#108)。dd 指定も拾い、描画側がセグメント分割で近似する。
    // 実プロパティ名は width_varying_*/single_color/color_ramp_shader(実機検証済み)
    const dd = layer.dd || {};
    const ramp = p.color_ramp_shader && typeof p.color_ramp_shader === "object" ? p.color_ramp_shader : null;
    const rampC1 = ramp ? (ramp.color1 ?? ramp["stop_0"]) : null;
    const rampC2 = ramp ? (ramp.color2 ?? ramp["stop_100"]) : null;
    const c1 = parseQgisColor(ddValue(dd, ["lineStartColorValue", "color_start", "start_color"], props,
      p.single_color ?? rampC1 ?? p.line_color ?? p.color), [0, 0, 0, 1]);
    const c2 = parseQgisColor(ddValue(dd, ["lineEndColorValue", "color_end", "end_color"], props,
      rampC2 ?? p.single_color ?? p.line_color ?? p.color), c1);
    const variable = String(p.width_varying_is_variable_width ?? "0") === "1"
      || String(p.width_varying_is_variable_width).toLowerCase() === "true";
    const w1v = variable ? (p.width_varying_minimum_width ?? p.line_width ?? 0.26) : (p.line_width ?? 0.26);
    const w2v = variable ? (p.width_varying_maximum_width ?? w1v) : w1v;
    const w1 = Math.max(sizeToPx(ddValue(dd, ["lineStartWidthValue", "width_start"], props, w1v), widthUnit) || 1, 0.5);
    const w2 = Math.max(sizeToPx(ddValue(dd, ["lineEndWidthValue", "width_end"], props, w2v), widthUnit) || 1, 0.5);
    return { kind: "interpolated", c1, c2, w1, w2 };
  }
  if (cls === "ArrowLine") {
    // 実プロパティ名: head_length/head_thickness(単位付き)/is_curved。
    // arrow_head_length/arrow_head_width/curved_arrow は存在しない旧名フォールバック
    return { kind: "arrowline", color: parseQgisColor(color, [0, 0, 0, 1]),
      headLenPx: sizeToPx(p.head_length ?? p.arrow_head_length ?? 2.5, p.head_length_unit || "MM") || 9,
      headWidthPx: sizeToPx(p.head_thickness ?? p.arrow_head_width ?? 2.5, p.head_thickness_unit || "MM") || 9,
      tailWidthPx: sizeToPx(p.arrow_width ?? 0, p.arrow_width_unit || "MM") || null,
      curved: String(p.is_curved ?? p.curved_arrow ?? "0") === "1" };
  }
  if (cls === "RasterLine") {
    // ラスターライン: imageFile の画像を線幅高さで線に沿って繰り返す。
    // image は事前ロード済み(collectImagePaths)なら images から取れる
    const pathKey = String(p.imageFile ?? p.path ?? p.file ?? "");
    const image = pathKey ? images?.get(pathKey) || null : null;
    if (!image) warnOnce(warnings, `RasterLine の画像を読めませんでした: ${pathKey || "?"}(単色線で近似)`);
    return { kind: "rasterline", image,
      offsetPx: sizeToPx(p.offset ?? 0, p.offset_unit || "MM") || 0 };
  }
  return null;
}

// fill_style(ハッチ)名 → パターン描画パラメータ
const FILL_STYLES = {
  solid: null,
  horizontal: { angles: [0], spacing: 3 },
  vertical: { angles: [90], spacing: 3 },
  cross: { angles: [0, 90], spacing: 3 },
  "b_diagonal": { angles: [45], spacing: 3 },
  "f_diagonal": { angles: [-45], spacing: 3 },
  "diagonal_x": { angles: [45, -45], spacing: 3 },
  dense1: { angles: [45], spacing: 2 },
  dense2: { angles: [45], spacing: 2.5 },
  dense3: { angles: [45], spacing: 3 },
  dense4: { angles: [45], spacing: 3.5 },
  dense5: { angles: [45, -45], spacing: 3 },
  dense6: { angles: [45, -45], spacing: 3.5 },
  dense7: { angles: [45, -45], spacing: 4 },
  "no": "none",
  "no_brush": "none",
};

function resolveFillLayer(layer, props, images, warnings, tileCache) {
  const p = layer.props;
  const dd = layer.dd;
  switch (layer.cls) {
    case "SimpleFill": {
      // 実プロパティ名は style(実機検証済み)。fill_style は存在しない旧名フォールバック
      const fillStyle = String(ddValue(dd, ["fillStyle", "fill_style"], props, p.style ?? p.fill_style ?? "solid")).toLowerCase();
      const color = parseQgisColor(ddValue(dd, ["fillColor", "color"], props, p.color), [0.5, 0.5, 0.5, 1]);
      const spec = FILL_STYLES[fillStyle];
      if (spec === "none") return { solid: null };
      if (!spec) return { solid: color };
      return { hatch: { color, angles: spec.angles, spacingPx: spec.spacing * MM_TO_PX * 0.8 } };
    }
    case "LinePatternFill": {
      // DD は fillColor/lineAngle/lineDistance が実名(実機検証済み)。
      // lineColor/color は存在しない旧名フォールバック
      const color = parseQgisColor(ddValue(dd, ["fillColor", "lineColor", "color"], props, p.color), [0, 0, 0, 1]);
      const angle = Number(ddValue(dd, ["lineAngle"], props, p.angle ?? 45));
      const distPx = sizeToPx(ddValue(dd, ["lineDistance"], props, p.distance ?? 2), p.distance_unit || "MM") || 4;
      const widthPx = Math.max(sizeToPx(p.line_width ?? p.outline_width ?? 0.3, p.line_width_unit || "MM"), 0.8);
      let lineColor = color, lineWidth = widthPx;
      if (layer.subSymbol) {
        for (const l of layer.subSymbol.layers || []) {
          const r = resolveLineLayer(l, props, warnings, images);
          if (r) { lineColor = r.color; lineWidth = r.widthPx; }
        }
      }
      return { linePattern: { color: lineColor, angleDeg: angle, spacingPx: Math.max(distPx, 2), widthPx: lineWidth } };
    }
    case "PointPatternFill": {
      // DD: distanceX/distanceY/displacementX/displacementY/offsetX/offsetY(実機検証済み)
      const dx = Math.max(sizeToPx(ddValue(dd, ["distanceX"], props, p.distance_x ?? p.distance ?? 4), p.distance_x_unit || "MM"), 3);
      const dy = Math.max(sizeToPx(ddValue(dd, ["distanceY"], props, p.distance_y ?? p.distance ?? 4), p.distance_y_unit || "MM"), 3);
      const markers = layer.subSymbol
        ? layer.subSymbol.layers.flatMap(l => l.enabled ? resolveMarkerLayer(l, props, images, warnings) : [])
        : [{ kind: "shape", shape: "circle", sizePx: 2.5, fill: parseQgisColor(p.color, [0, 0, 0, 1]), stroke: null, strokeWidthPx: 0, rotationDeg: 0, offsetPx: [0, 0], alpha: 1 }];
      return { pointPattern: {
        markers, spacingX: dx, spacingY: dy,
        // 奇数列ごとのずらし(千鳥配置)と全体オフセット
        dispX: sizeToPx(ddValue(dd, ["displacementX"], props, p.displacement_x ?? 0), p.displacement_x_unit || "MM"),
        dispY: sizeToPx(ddValue(dd, ["displacementY"], props, p.displacement_y ?? 0), p.displacement_y_unit || "MM"),
        offX: sizeToPx(ddValue(dd, ["offsetX"], props, p.offset_x ?? 0), p.offset_x_unit || "MM"),
        offY: sizeToPx(ddValue(dd, ["offsetY"], props, p.offset_y ?? 0), p.offset_y_unit || "MM"),
      } };
    }
    case "RandomMarkerFill": {
      // 実プロパティ名(実機検証済み): count_method(0=個数直接/1=面積密度)/
      // point_count/density_area(+density_area_unit)/seed/clip_points。
      // distance_x/displacement_x 系は PointPatternFill の名前であり存在しない
      // DD: pointCount/densityArea/randomSeed/clipPoints
      const densityBased = String(p.count_method ?? "0") === "1";
      const pointCount = Math.max(Number(ddValue(dd, ["pointCount"], props, p.point_count ?? 10)) || 10, 1);
      // 面積密度: QGIS は sqrt(density_area) を描画単位へ変換した領域あたり
      // point_count 個を撒く → 間隔 ≈ sqrt(density_area_px^2 / point_count)
      let spacing = sizeToPx(4, "MM");
      if (densityBased) {
        const densPx = sizeToPx(Math.sqrt(Number(ddValue(dd, ["densityArea"], props, p.density_area ?? 250)) || 250),
          p.density_area_unit || "MM");
        spacing = densPx / Math.sqrt(pointCount);
      }
      const markers = layer.subSymbol
        ? layer.subSymbol.layers.flatMap(l => l.enabled ? resolveMarkerLayer(l, props, images, warnings) : [])
        : [{ kind: "shape", shape: "circle", sizePx: 2.5, fill: parseQgisColor(p.color, [0, 0, 0, 1]), stroke: null, strokeWidthPx: 0, rotationDeg: 0, offsetPx: [0, 0], alpha: 1 }];
      return { pointPattern: {
        markers, spacingX: Math.max(spacing, 3), spacingY: Math.max(spacing, 3),
        dispX: 0, dispY: 0, offX: 0, offY: 0,
        // RandomMarkerFill は本質的にランダム配置。タイル近似では規則配置に
        // なるため個数・シード・クリップを spec へ保持する
        random: true,
        count: densityBased ? 0 : pointCount,
        seed: Number(ddValue(dd, ["randomSeed"], props, p.seed ?? 0)) || 0,
        clipPoints: String(ddValue(dd, ["clipPoints"], props, p.clip_points ?? "1")) !== "0",
      } };
    }
    case "SVGFill":
    case "RasterFill": {
      // 実プロパティ名(実機検証済み): SVGFill は svgFile(参照)/data(hex 化 SVG
      // バイト列の埋込)、RasterFill は imageFile。svgfile/name/file は旧名フォールバック
      const pathKey = String(p.svgFile ?? p.imageFile ?? p.svgfile ?? p.file ?? p.name ?? "")
        || svgFillEmbeddedUri(p);
      const image = images.get(pathKey) || null;
      if (!image) {
        warnOnce(warnings, `${layer.cls} の画像を読めませんでした: ${pathKey}(単色で代替)`);
        return { solid: parseQgisColor(p.color ?? p.svgFillColor, [0.5, 0.5, 0.5, 0.7]) };
      }
      const w = Math.max(sizeToPx(p.width ?? p.pattern_width ?? 4, p.pattern_width_unit || "MM"), 4);
      return { imagePattern: { image, widthPx: w } };
    }
    case "GradientFill":
    case "ShapeburstFill":
    case "ColorRampFill": {
      const c1 = parseQgisColor(p.color ?? p.gradient_color2 ?? p.color1 ?? p.two_color_second, [0.5, 0.5, 0.5, 1]);
      const c2 = parseQgisColor(p.gradient_color2 ?? p.color2 ?? p.two_color_second, null);
      // グラデーションはタイルで近似
      return { gradient: { color1: c1, color2: c2 || [c1[0], c1[1], c1[2], 0], angleDeg: Number(p.angle ?? 0) } };
    }
    case "CentroidFill": {
      const markers = layer.subSymbol
        ? layer.subSymbol.layers.flatMap(l => l.enabled ? resolveMarkerLayer(l, props, images, warnings) : [])
        : [];
      return { centroid: markers };
    }
    case "GeometryGenerator": {
      const mod = String(p.geometryModifier ?? p.geometry_modifier ?? "");
      // 実プロパティ名は SymbolType(先頭大文字・値 Marker|Line|Fill。実機検証済み)
      const subType = String(p.SymbolType ?? p.symbolType ?? p.symbol_type ?? p.type ?? "").toLowerCase()
        || (layer.subSymbol?.geomType || "");
      const isCentroid = /centroid|point_on_surface|pole_of_inaccessibility/i.test(mod);
      if (isCentroid && /marker|point/i.test(subType) && layer.subSymbol) {
        // 重心マーカー: エンジン側の centroid 描画経路をそのまま使う
        const markers = layer.subSymbol.layers.flatMap(l =>
          l.enabled ? resolveMarkerLayer(l, props, images, warnings) : []);
        return { centroid: markers };
      }
      if (/exterior_ring/i.test(mod)) {
        warnOnce(warnings, "GeometryGenerator exterior_ring は外周描画で近似します");
        return { solid: null, outlineViaGenerator: true };
      }
      // 一般形(#64): symbolType に応じたサブシンボルを解決し、式は
      // 描画側が地物ジオメトリへ評価する。生成物の種別=symbolType
      if (layer.subSymbol) {
        const expr = mod || "$geometry";
        const sub = resolveSymbolLayers(layer.subSymbol, props, images, warnings);
        if (/marker|point/i.test(subType) && sub.markers?.length) {
          warnOnce(warnings, `GeometryGenerator は近似評価です(buffer/translate/centroid/exterior_ring/boundary/convex_hull/envelope 等の常用関数のみ)`);
          return { gg: { expr, markers: sub.markers } };
        }
        if (/line/i.test(subType) && sub.line) {
          warnOnce(warnings, `GeometryGenerator は近似評価です(buffer/translate/centroid/exterior_ring/boundary/convex_hull/envelope 等の常用関数のみ)`);
          return { gg: { expr, line: sub.line } };
        }
        if (sub.fillParts?.length || sub.outline) {
          warnOnce(warnings, `GeometryGenerator は近似評価です(buffer/translate/centroid/exterior_ring/boundary/convex_hull/envelope 等の常用関数のみ)`);
          return { gg: { expr, fillParts: sub.fillParts || [{ solid: null }], outline: sub.outline || null } };
        }
      }
      warnOnce(warnings, `GeometryGenerator(${mod.slice(0, 40) || "?"}) 塗りつぶしは未対応です(スキップ)`);
      return {};
    }
    default:
      warnOnce(warnings, `塗りつぶしシンボル ${layer.cls} は未対応です(単色で代替)`);
      return { solid: parseQgisColor(p.color, [0.5, 0.5, 0.5, 0.7]) };
  }
}

function resolveOutline(layer, props, warnings) {
  const p = layer.props;
  const dd = layer.dd;
  const style = String(ddValue(dd, ["outlineStyle", "outline_style"], props, p.outline_style ?? "solid")).toLowerCase();
  if (style === "no") return null;
  const color = parseQgisColor(ddValue(dd, ["outlineColor", "outline_color"], props, p.outline_color), null);
  if (!color) return null;
  const widthPx = sizeToPx(ddValue(dd, ["outlineWidth", "outline_width"], props, p.outline_width ?? 0.26), p.outline_width_unit || "MM");
  const dash = dashPattern(style, null, Math.max(widthPx, 1));
  return { color, widthPx: Math.max(widthPx, 1), dash: dash === "none" ? null : dash };
}

// <symbol> を feature 属性で正規化する
// ---------------------------------------------------------------------------
// GeometryGenerator 一般形: $geometry + 常用ジオメトリ関数を GeoJSON 上で評価
// (#64)。turf.js は loadQmlStyle で GG 検出時に先行読込済み(turfSync で同期取得)。
// 距離系(buffer/translate)はメートルとして測地計算する。
// ---------------------------------------------------------------------------
import { geomCentroid, geomBbox, destinationPoint, turfSync, ensureTurf } from "./spatial-ops.js";

// トップレベルのカンマで式引数を分割(ネスト括弧・クォート対応)
function splitExprArgs(s) {
  const out = [];
  let depth = 0, q = null, cur = "";
  for (const ch of String(s)) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

function mapGeomCoords(geom, fn) {
  const map = c => typeof c[0] === "number" ? fn(c) : c.map(map);
  return { type: geom.type, coordinates: map(geom.coordinates) };
}

function flatPoints(geom, acc = []) {
  const walk = c => { if (typeof c[0] === "number") acc.push(c); else c.forEach(walk); };
  if (geom?.coordinates) walk(geom.coordinates);
  return acc;
}

// Andrew の単調チェーン法で凸包リング
function convexHullRing(pts) {
  const u = [...new Map(pts.map(p => [p.join(","), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (u.length < 3) return u.length ? [...u, u[0]] : null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of u) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (const p of [...u].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1), lower[0]];
}

function translateGeom(geom, dx, dy) {
  const dist = Math.hypot(dx, dy);
  const brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return mapGeomCoords(geom, c => destinationPoint(c, brg, dist));
}

function boundaryGeom(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") return { type: "MultiLineString", coordinates: geom.coordinates };
  if (geom.type === "MultiPolygon") return { type: "MultiLineString", coordinates: geom.coordinates.flat(1) };
  if (geom.type === "LineString") {
    const c = geom.coordinates;
    return c.length >= 2 ? { type: "MultiPoint", coordinates: [c[0], c[c.length - 1]] } : null;
  }
  if (geom.type === "MultiLineString") {
    const pts = geom.coordinates.flatMap(c => (c.length >= 2 ? [c[0], c[c.length - 1]] : []));
    return pts.length ? { type: "MultiPoint", coordinates: pts } : null;
  }
  return null;
}

// QGIS ジオメトリ生成式を GeoJSON(4326) 上で評価する。未対応式は null。
// 再帰的に fn(g,数値..) 形を処理する
export function evalGeomExpr(expr, geom) {
  if (!geom) return null;
  const s = String(expr || "").trim();
  // QGIS4 の既定 geometryModifier は "@geometry"。$geometry は旧名
  if (!s || /^[@$]geometry$/i.test(s)) return geom;
  const m = /^([A-Za-z_][\w]*)\s*\((.*)\)$/s.exec(s);
  if (!m) return null;
  const fn = m[1].toLowerCase();
  const args = splitExprArgs(m[2]);
  const g = i => evalGeomExpr(args[i] ?? "", geom);
  const num = i => Number(String(args[i] ?? "").trim());
  const T = turfSync();
  switch (fn) {
    case "buffer": {
      const d = num(1); const sub = g(0);
      if (!T?.buffer || !sub || !Number.isFinite(d)) return null;
      return T.buffer({ type: "Feature", properties: {}, geometry: sub }, d / 1000, { units: "kilometers" })?.geometry ?? null;
    }
    case "translate": {
      const dx = num(1), dy = num(2), sub = g(0);
      return sub && Number.isFinite(dx) && Number.isFinite(dy) ? translateGeom(sub, dx, dy) : null;
    }
    case "centroid": case "point_on_surface": case "pointonsurface": case "pole_of_inaccessibility": {
      const c = geomCentroid(g(0));
      return c ? { type: "Point", coordinates: c } : null;
    }
    case "exterior_ring": {
      const p = g(0);
      const ring = p?.type === "Polygon" ? p.coordinates[0] : p?.type === "MultiPolygon" ? p.coordinates[0]?.[0] : null;
      return ring ? { type: "LineString", coordinates: ring } : null;
    }
    case "boundary": return boundaryGeom(g(0));
    case "convex_hull": case "convexhull": {
      const ring = convexHullRing(flatPoints(g(0)));
      return ring ? { type: "Polygon", coordinates: [ring] } : null;
    }
    case "envelope": case "bounds": {
      const b = geomBbox(g(0));
      return b ? { type: "Polygon", coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] } : null;
    }
    case "simplify": {
      const sub = g(0);
      return (T?.simplify && sub)
        ? (T.simplify({ type: "Feature", properties: {}, geometry: sub }, { tolerance: num(1) || 0.0001 })?.geometry ?? sub)
        : sub;
    }
    default: return null;
  }
}

function resolveSymbolLayers(symbol, props, images, warnings) {
  const out = {
    markers: null, line: null, fillParts: null, outline: null, centroid: null,
    // シンボル単位の透明度は DD でも上書きできる
    alpha: Number.isFinite(Number(ddValue(symbol.dd, ["alpha", "transparency"], props, NaN)))
      ? Number(ddValue(symbol.dd, ["alpha", "transparency"], props, NaN)) : symbol.alpha,
  };
  const markerLayers = [];
  const fillParts = [];
  let outline = null;
  let centroid = null;
  let lineCandidate = null;
  const lineLayers = [];

  for (const layer of symbol.layers) {
    if (!layer.enabled) continue;
    // symbollevels=<レンダラ属性> 用に pass(シンボルレイヤ描画順位)を保持
    if (Number.isFinite(layer.pass)) out.minPass = Math.min(out.minPass ?? Infinity, layer.pass);
    switch (symbol.geomType) {
      case "marker":
        markerLayers.push(...resolveMarkerLayer(layer, props, images, warnings).map(m => {
          if (m.gg) { (out.gg ||= []).push({ kind: "marker", ...m.gg }); return null; }
          return { ...m, blend: m.blend ?? layer.blend, effects: m.effects ?? layer.effects, pass: layer.pass };
        }).filter(Boolean));
        break;
      case "line": {
        const r = resolveLineLayer(layer, props, warnings, images);
        if (r?.gg) { (out.gg ||= []).push({ kind: "line", ...r.gg }); break; }
        // 最後の有効レイヤ(最上位)を採用
        if (r) {
          lineCandidate = { ...r, blend: r.blend ?? layer.blend, effects: r.effects ?? layer.effects, pass: layer.pass };
          // 複数シンボルレイヤ積層(ケーシング等)の描画順リスト(QGISは先が下)
          lineLayers.push(lineCandidate);
        }
        break;
      }
      case "fill": {
        const r = resolveFillLayer(layer, props, images, warnings);
        if (!r) break;
        if (r.centroid) { centroid = r.centroid; break; }
        if (r.gg) { (out.gg ||= []).push({ kind: "fill", ...r.gg }); break; }
        const o = resolveOutline(layer, props, warnings);
        if (o) outline = o;
        const part = { ...r, blend: r.blend ?? layer.blend, effects: r.effects ?? layer.effects, pass: layer.pass };
        if (r.solid !== undefined && r.solid !== null) fillParts.push(part);
        else if (r.solid === null) fillParts.push({ solid: null, blend: part.blend });
        else fillParts.push(part);
        break;
      }
    }
  }
  if (symbol.geomType === "marker" && markerLayers.length) out.markers = markerLayers;
  if (symbol.geomType === "line" && lineCandidate) {
    out.line = lineCandidate;
    // 全ラインシンボルレイヤ(積層順=描画順)。out.line は最上位(=最後)
    if (lineLayers.length > 1) out.lines = lineLayers;
  }
  if (symbol.geomType === "fill") {
    if (fillParts.length) out.fillParts = fillParts;
    if (outline) out.outline = outline;
    if (centroid) out.centroid = centroid;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ラベル(<labeling>)
// ---------------------------------------------------------------------------

// QgsPalLayerSettings::QuadrantPosition → ラベル矩形のアンカー
// {h: -1..1(左..右), v: -1..1(下..上)}。QGIS の配置方位を
// 「地物に接する側の角」を示すアンカーへ変換する
const QUAD_ANCHORS = {
  0: { h: -1, v: 1 },   // AboveLeft: 地物の左上
  1: { h: 0,  v: 1 },   // Above
  2: { h: 1,  v: 1 },   // AboveRight
  3: { h: -1, v: 0 },   // Left
  4: { h: 0,  v: 0 },   // Over
  5: { h: 1,  v: 0 },   // Right
  6: { h: -1, v: -1 },  // BelowLeft
  7: { h: 0,  v: -1 },  // Below
  8: { h: 1,  v: -1 },  // BelowRight
};

// QgsPalLayerSettings::Placement → 正規化配置モード
// placement 番号は layerType で enum が異なる(QgsPalLayerSettings::Placement)
const PLACEMENT_MODES_POINT = {
  0: "around",   // AroundPoint
  1: "over",     // OverPoint
  2: "line",     // Line (ライン追従)
  3: "curved",   // Curved
  4: "horizontal",
  5: "free",
  6: "ordered",  // OrderedPositionsAroundPoint
  7: "perimeter",// PerimeterCurved
  8: "outside",
};
const PLACEMENT_MODES_POLY = {
  0: "around",   // OffsetAroundCentroid
  1: "horizontal", // Horizontal (重心水平)
  2: "over",     // AroundCentroid (重心直上)
  3: "free",     // Free (外周優先)
  4: "horizontal", // Long (長軸沿い→水平近似)
  5: "ordered",  // OrderedPositionsAroundPoint
  6: "perimeter",// Perimeter (外周)
  7: "outside",  // OutsidePosition
  8: "curved",
};
const PLACEMENT_MODES_LINE = {
  0: "line", 1: "curved", 2: "line", 3: "curved",
  4: "horizontal", 5: "free", 6: "ordered", 7: "perimeter", 8: "outside",
};
const PLACEMENT_MODES = PLACEMENT_MODES_POINT;

function parseLabelBackground(bgEl, warnings) {
  if (!bgEl) return null;
  const g = name => bgEl.getAttribute(name);
  const draw = String(g("shapeDraw") ?? "0") === "1";
  if (!draw) return null;
  const typeNum = Number(g("shapeType") ?? 0); // 0 rect,1 square,2 ellipse,3 circle,4 svg,5 marker
  const type = { 0: "rect", 1: "square", 2: "ellipse", 3: "circle", 4: "image", 5: "image" }[typeNum] || "rect";
  if (type === "image") warnOnce(warnings, "ラベル背景の画像(SVG/マーカー)は未対応です(矩形で代替)");
  const opacity = Number(g("shapeOpacity") ?? 1);
  const fill = withAlpha(parseQgisColor(g("shapeFillColor"), [1, 1, 1, 1]), Number.isFinite(opacity) ? opacity : 1);
  const stroke = parseQgisColor(g("shapeBorderColor"), null);
  const strokeWidthPx = sizeToPx(g("shapeBorderWidth") ?? 0, g("shapeBorderWidthUnit") || "MM");
  const padXPx = sizeToPx(g("shapeSizeX") ?? 0, g("shapeSizeUnit") || "MM");
  const padYPx = sizeToPx(g("shapeSizeY") ?? 0, g("shapeSizeUnit") || "MM");
  const radiusPx = Math.max(
    sizeToPx(g("shapeRadiiX") ?? 0, g("shapeRadiiUnit") || "MM"),
    sizeToPx(g("shapeRadiiY") ?? 0, g("shapeRadiiUnit") || "MM"));
  return {
    type,
    fill, stroke, strokeWidthPx: Math.max(strokeWidthPx, 0),
    // shapeSizeType 0=Buffer(テキストの周囲バッファ) / 1=Fixed(絶対サイズ)
    sizeType: String(g("shapeSizeType") ?? "0"),
    radiusPx,
    padPx: [padXPx, padYPx],
    offsetPx: [
      sizeToPx(g("shapeOffsetX") ?? 0, g("shapeOffsetUnit") || "MM"),
      sizeToPx(g("shapeOffsetY") ?? 0, g("shapeOffsetUnit") || "MM")],
    rotationDeg: Number(g("shapeRotation")) || 0,
  };
}

function parseLabelShadow(shEl, warnings) {
  if (!shEl) return null;
  const g = name => shEl.getAttribute(name);
  if (String(g("shadowDraw") ?? "0") !== "1") return null;
  const dist = sizeToPx(g("shadowOffsetDist") ?? 0, g("shadowOffsetUnit") || "MM");
  const ang = (Number(g("shadowOffsetAngle")) || 0) * Math.PI / 180;
  return {
    offsetPx: [Math.cos(ang) * dist, Math.sin(ang) * dist],
    radiusPx: sizeToPx(g("shadowRadius") ?? 0, g("shadowRadiusUnit") || "MM"),
    color: withAlpha(parseQgisColor(g("shadowColor"), [0, 0, 0, 1]), Number(g("shadowOpacity") ?? 0.7) || 0.7),
  };
}

// コールアウト(引き出し線)。ネストした Option ツリーからライン色/幅を掘る
function parseLabelCallout(coEl) {
  if (!coEl) return null;
  const props = optionMap(coEl) || {};
  if (String(props.enabled ?? "0") !== "1" && String(props.enabled ?? "").toLowerCase() !== "true") return null;
  let color = null, widthPx = null;
  const dig = o => {
    if (!o || typeof o !== "object") return;
    const c = parseQgisColor(o.line_color ?? o.color, null);
    if (c && !color) color = c;
    const w = sizeToPx(o.line_width ?? o.width ?? 0, o.line_width_unit || o.width_unit || "MM");
    if (w && !widthPx) widthPx = w;
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(dig); else if (v && typeof v === "object") dig(v);
    }
  };
  dig(props.lineSymbol ?? props.symbol ?? props);
  return {
    type: coEl.getAttribute("type") || "simple",
    line: { color: color || [0, 0, 0, 1], widthPx: Math.max(widthPx || 1, 0.5) },
  };
}

function parseLabelSubstitutions(subEl) {
  const out = {};
  if (!subEl) return out;
  const map = optionMap(subEl);
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  for (const c of subEl.querySelectorAll?.("Option[name]") || []) {
    const n = c.getAttribute("name");
    const v = c.getAttribute("value") || c.textContent;
    if (n && v && !out[n]) out[n] = v;
  }
  return out;
}

// レンダリング・書式・配置系の属性を読む。QGIS4 は <settings> 直下の
// <rendering>/<placement>/<text-format> に属性が分散しており、
// QGIS3 フラット形式では <settings> 自身の属性。両対応の合成ゲッターで拾う
// (実機検証済み: priority=placement, wrapChar/方向記号/数値書式=text-format)
function parseLabelRendering(setEl, warnings, caps = null) {
  const rd = setEl?.querySelector?.("rendering") || null;
  const pl = setEl?.querySelector?.("placement") || null;
  const tf = setEl?.querySelector?.("text-format") || null;
  // 属性名は各要素間で一意なため、rendering→placement→text-format→settings
  // (QGIS3 フラット)の順に探す
  const g = name => rd?.getAttribute(name) ?? pl?.getAttribute(name)
    ?? tf?.getAttribute(name) ?? setEl?.getAttribute(name);
  const out = {
    drawLabels: String(g("drawLabels") ?? "1") === "1",
    upsidedown: String(g("upsidedownLabels") ?? "0") === "0" ? "upright" : "show",
    labelPerPart: String(g("labelPerPart") ?? "0") === "1",
    mergeLines: String(g("mergeLines") ?? "0") === "1",
    maxNumLabels: Number(g("maxNumLabels")) || 0,
    limitNumLabels: String(g("limitNumLabels") ?? "0") === "1",
    minFeatureSizePx: sizeToPx(g("minFeatureSize") ?? 0, "MM"),
    fontMinPixelSize: Number(g("fontMinPixelSize")) || 0,
    fontMaxPixelSize: Number(g("fontMaxPixelSize")) || 0,
    fontLimitPixelSize: String(g("fontLimitPixelSize") ?? "0") === "1",
    // obstacle: 地物を他ラベルの障害物として登録するか(QGIS 既定は false)。
    // obstacleType はポリゴンの判定モード(0=内部/1=境界のみ/2=全体)
    obstacle: String(g("obstacle") ?? "0") === "1",
    // "0" が || で 1 へ化けないよう有限数チェック(factor=0 は障害物費用0=非障害物)
    obstacleFactor: (() => { const n = Number(g("obstacleFactor") ?? 1); return Number.isFinite(n) ? n : 1; })(),
    obstacleType: Number(g("obstacleType")) || 0,
    priority: Number(g("priority") ?? g("priorityLabel") ?? 5) || 0,
    zIndex: Number(g("zIndex")) || 0,
    displayAll: String(g("displayAll") ?? "0") === "1",
    // QGIS4 は <placement allowDegraded>。旧名 allowDegradedPlacement も拾う
    allowDegraded: qgisBool(g("allowDegraded") ?? g("allowDegradedPlacement")),
    // QGIS4 は <placement fitInPolygonOnly>/<placement multipartBehavior>
    fitInsidePolygon: qgisBool(g("fitInPolygonOnly")) || String(g("fitInsidePolygon") ?? "0") === "1",
    labelPerPartFlag: String(g("labelPerPart") ?? "1") !== "0",
    multipartMode: String(g("multipartBehavior") || g("multipartMode") || "").toLowerCase() || null,
    // QGIS 3.44+ の「重なったラベル」モード:
    // 0=重なりを禁止, 1=無条件で許可, 2=ペナルティなしで許可, 3=必要なら許可。
    // ペナルティ段階は近似として 1・2→displayAll、3→allowDegraded に写像する
    // QGIS4 は <placement overlapHandling="PreventOverlap|AllowOverlap...">(文字列)
    overlapMode: Number(g("overlapMode") ?? -1),
    overlapHandling: String(g("overlapHandling") || ""),
    unplacedVisibility: String(g("unplacedVisibility") ?? "0") === "1",
    // QGIS4 は <text-format wrapChar>
    wrapChar: g("wrapChar") || g("multiLineWrapChar") || "",
    autoWrapLength: Number(g("autoWrapLength")) || 0,
    useMaxLineLengthForAutoWrap: String(g("useMaxLineLengthForAutoWrap") ?? "1") === "1",
    labelScale: null,
  };
  if (String(g("scaleVisibility") ?? "0") === "1") {
    const lo = Number(g("scaleMin")) || 0;
    const hi = Number(g("scaleMax")) || 0;
    if (lo > 0 || hi > 0) out.labelScale = { minScale: lo || null, maxScale: hi || null };
  }
  // 方向記号(NSEW)
  if (String(g("addDirectionSymbol") ?? "0") === "1") {
    out.dirSymbol = {
      placement: Number(g("placeDirectionSymbol")) || 0, // 0=AboveLeft? QGIS: 0=SymbolLeftRight,1=SymbolAbove,2=SymbolBelow
      left: g("leftDirectionSymbol") || "<",
      right: g("rightDirectionSymbol") || ">",
      reverse: String(g("reverseDirectionSymbol") ?? "0") === "1",
    };
  }
  // 数値フォーマット
  if (String(g("formatNumbers") ?? "0") === "1") {
    out.numFormat = {
      decimals: Number(g("decimals")) || 0,
      plusSign: String(g("plussign") ?? "0") === "1",
    };
  }
  // overlapMode を displayAll/allowDegraded へ写像(ペナルティ段階は近似)
  if (out.overlapMode === 1 || out.overlapMode === 2) out.displayAll = true;
  else if (out.overlapMode === 3) out.allowDegraded = true;
  if (out.mergeLines) warnOnce(warnings, "ラベルのライン結合(mergeLines)は未対応です");
  if (out.unplacedVisibility) warnOnce(warnings, "未配置ラベルの表示(unplacedVisibility)は未対応です");
  if (out.obstacle && out.obstacleFactor > 0) {
    if (caps?.obstacle === "geo") warnOnce(warnings, "ラベル障害物(obstacle)は地物ジオメトリの画面投影で近似判定です");
    else if (caps?.obstacle === "bbox") warnOnce(warnings, "ラベル障害物(obstacle)は地物bboxで近似です");
    else warnOnce(warnings, caps
      ? "ラベル障害物(obstacle)はこのエンジンでは適用されません(衝突判定なし)"
      : "ラベル障害物(obstacle)は衝突判定のあるエンジンのみ適用されます");
  }
  return out;
}

// QGIS 式の isExpression 値を bool 化
function qgisBool(v, def = false) {
  if (v == null) return def;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true";
}

// ラベルデータ定義プロパティ(<dd_properties> または text-style の
// data_defined_properties)を地物プロパティで評価して spec へ適用する
function applyLabelDD(spec, dd, props) {
  if (!dd || !Object.keys(dd).length) return spec;
  const get = names => ddValue(dd, names, props, undefined);
  const spec1 = { ...spec };
  if (get(["Show"]) !== undefined && !qgisBool(get(["Show"]), true)) return null;
  if (qgisBool(get(["AlwaysShow"]), false)) spec1.allowOverlap = true;
  const num = (names, cur) => {
    const v = Number(get(names));
    return Number.isFinite(v) ? v : cur;
  };
  const bool = (names, cur) => {
    const v = get(names);
    return v === undefined ? cur : qgisBool(v, cur);
  };
  const sizePx = num(["Size"], null);
  const family = get(["Family"]);
  const bold = bool(["Bold"], spec.bold);
  const italic = bool(["Italic"], spec.italic);
  const fontStyle = String(get(["FontStyle"]) || "").toLowerCase();
  const effBold = fontStyle ? (fontStyle.includes("bold") || fontStyle.includes("太")) : bold;
  const effItalic = fontStyle ? (fontStyle.includes("italic") || fontStyle.includes("oblique") || fontStyle.includes("斜")) : italic;
  if (sizePx != null || family || effBold !== spec.bold || effItalic !== spec.italic) {
    // DD の Size 値はフォントサイズと同じ単位(fontSizeUnit)で解釈する
    if (sizePx != null) spec1.sizePx = sizeToPx(sizePx, spec.sizeUnit || "Point") || spec.sizePx;
    const fam = family || spec.family;
    spec1.family = fam;
    spec1.bold = effBold; spec1.italic = effItalic;
    spec1.fontCss = `${effItalic ? "italic " : ""}${effBold ? "bold " : ""}${Math.max(Math.round(spec1.sizePx), 6)}px ${fam}`;
  }
  const color = parseQgisColor(get(["Color"]), null);
  if (color) spec1.fill = color;
  spec1.underline = bool(["Underline"], spec.underline);
  spec1.strikeout = bool(["Strikeout"], spec.strikeout);
  spec1.letterSpacingPx = num(["FontLetterSpacing", "LetterSpacing"], spec.letterSpacingPx);
  spec1.wordSpacingPx = num(["FontWordSpacing", "WordSpacing"], spec.wordSpacingPx);
  const hali = String(get(["Hali"]) || "").toLowerCase();
  if (["left", "center", "right", "justify"].includes(hali)) spec1.align = hali;
  const wrapChar = get(["MultiLineWrapChar"]);
  if (wrapChar !== undefined && wrapChar !== "") spec1.wrapChar = String(wrapChar);
  const mlh = Number(get(["MultiLineHeight"]));
  if (Number.isFinite(mlh) && mlh > 0) spec1.lineHeightFactor = mlh;
  const rot = Number(get(["Rotation", "LabelRotation", "RotationAngle"]));
  if (Number.isFinite(rot)) spec1.placement = { ...spec.placement, rotationDeg: rot };
  const off = get(["OffsetXY"]);
  if (off != null) {
    const [ox, oy] = String(off).split(",").map(Number);
    if (Number.isFinite(ox) || Number.isFinite(oy)) {
      spec1.placement = {
        ...spec.placement,
        offsetXPx: Number.isFinite(ox) ? ox * MM_TO_PX : spec.placement.offsetXPx,
        offsetYPx: Number.isFinite(oy) ? oy * MM_TO_PX : spec.placement.offsetYPx,
      };
    }
  }
  const quad = get(["OffsetQuad"]);
  if (quad !== undefined && Number.isFinite(Number(quad))) {
    spec1.placement = { ...spec.placement, quad: QUAD_ANCHORS[Number(quad)] || spec.placement.quad };
  }
  // バッファの DD
  const bDraw = bool(["BufferDraw"], undefined);
  const bSize = num(["BufferSize"], null);
  const bColor = parseQgisColor(get(["BufferColor"]), null);
  const bOp = num(["BufferOpacity"], null);
  if (bDraw !== undefined || bSize != null || bColor || bOp != null) {
    const cur = spec.halo;
    const draw = bDraw !== undefined ? bDraw : !!cur;
    spec1.halo = draw ? {
      color: bColor || cur?.color || [1, 1, 1, 1],
      // DD BufferSize は bufferSizeUnits と同じ単位で解釈される(QGIS準拠)
      widthPx: Math.max(bSize != null ? sizeToPx(bSize, spec.haloSizeUnit || "MM") : (cur?.widthPx || 1), 0),
    } : null;
    if (spec1.halo && bOp != null) spec1.halo.color = withAlpha(spec1.halo.color, bOp);
  }
  // 位置の DD(地図単位 lon/lat として解釈)
  const px = Number(get(["PositionX"])), py = Number(get(["PositionY"]));
  if (Number.isFinite(px) && Number.isFinite(py)) spec1.position = { x: px, y: py };
  spec1.priority = num(["Priority"], spec.priority);
  spec1.obstacle = bool(["IsObstacle"], spec.obstacle);
  spec1.obstacleFactor = num(["ObstacleFactor"], spec.obstacleFactor);
  spec1.labelPerPart = bool(["LabelAllParts"], spec.labelPerPart);
  const mn = Number(get(["MinScale"])), mx = Number(get(["MaxScale"]));
  if (Number.isFinite(mn) || Number.isFinite(mx)) {
    spec1.labelScale = { minScale: Number.isFinite(mn) && mn > 0 ? mn : null, maxScale: Number.isFinite(mx) && mx > 0 ? mx : null };
  }
  // 数値フォーマットの DD。実 DD 名は NumDecimals/NumPlusSign(実機検証済み)
  if (qgisBool(get(["NumFormat"]), !!spec.numFormat)) {
    spec1.numFormat = {
      decimals: num(["NumDecimals", "Decimals"], spec.numFormat?.decimals ?? 0),
      plusSign: bool(["NumPlusSign", "PlusSign"], spec.numFormat?.plusSign ?? false),
    };
  }
  if (qgisBool(get(["DirSymbDraw"]), !!spec.dirSymbol)) {
    spec1.dirSymbol = {
      placement: Number(get(["DirSymbPlacement"])) || spec.dirSymbol?.placement || 0,
      left: String(get(["DirSymbLeft"]) ?? spec.dirSymbol?.left ?? "<"),
      right: String(get(["DirSymbRight"]) ?? spec.dirSymbol?.right ?? ">"),
      reverse: qgisBool(get(["DirSymbReverse"]), spec.dirSymbol?.reverse ?? false),
    };
  }
  return spec1;
}

// テキスト変換(数値フォーマット・方向記号・折返し文字・大文字化)
export function formatLabelText(spec, rawText, props) {
  let text = rawText;
  if (text == null) return "";
  if (spec.numFormat && typeof text === "number" || (spec.numFormat && /^-?\d+(\.\d+)?$/.test(String(text).trim()))) {
    const n = Number(text);
    let s = n.toFixed(spec.numFormat.decimals);
    if (spec.numFormat.plusSign && n > 0) s = "+" + s;
    text = s;
  }
  text = String(text);
  if (spec.dirSymbol) {
    const { placement, left, right } = spec.dirSymbol;
    if (placement === 0) text = `${left}${text}${right}`;        // SymbolLeftRight
    else if (placement === 1) text = `${left}\n${text}\n${right}`; // Above(近似)
    else text = `${left}${text}${right}`;
  }
  if (spec.wrapChar) text = text.split(spec.wrapChar).join("\n");
  switch (Number(spec.capitalization)) {
    case 1: text = text.toUpperCase(); break;
    case 2: text = text.toLowerCase(); break;
    case 3: text = text.charAt(0).toUpperCase() + text.slice(1); break;
    case 5: text = text.replace(/(^|\s)(\S)/g, (m, sp, c) => sp + c.toUpperCase()); break;
    case 4: case 6: text = text.toUpperCase(); break; // SmallCaps は全大写で近似
  }
  return text;
}

function parseTextStyle(textStyleEl, settingsEl = null, warnings = new Set(), caps = null) {
  const a = name => textStyleEl?.getAttribute(name);
  const isExpr = qgisBool(a("isExpression"));
  const fieldName = a("fieldName") || "";
  const sizeUnit = a("fontSizeUnit") || "Point";
  const fontSize = Number(a("fontSize")) || 10;
  const sizePx = sizeToPx(fontSize, sizeUnit) || fontSize * PT_TO_PX;
  const textColor = parseQgisColor(a("textColor") || a("namedColor"), [0, 0, 0, 1]);
  const textOpacity = Number(a("textOpacity") ?? "1");
  // バッファ(ハロー)は <text-style> または親 <settings> の子要素
  // <text-buffer> に持つ。属性として残る旧形式もフォールバックで拾う(#55)
  const setElForBuf = settingsEl || textStyleEl?.parentElement || null;
  const bufEl = textStyleEl?.querySelector?.("text-buffer")
    || setElForBuf?.querySelector?.("text-buffer") || null;
  const b = name => bufEl?.getAttribute(name) ?? a(name);
  const bufferDraw = qgisBool(b("bufferDraw"));
  const bufferOpacity = Number(b("bufferOpacity") ?? "1");
  const bufferColor = withAlpha(
    parseQgisColor(b("bufferColor"), [1, 1, 1, 1]),
    Number.isFinite(bufferOpacity) ? bufferOpacity : 1);
  // 実名は bufferSizeUnits(実機検証済み)。bufferSizeUnit は旧名フォールバック
  const bufferSize = sizeToPx(b("bufferSize") ?? 1, b("bufferSizeUnits") || b("bufferSizeUnit") || "MM");
  if (bufEl) {
    if (b("bufferBlendMode") && String(b("bufferBlendMode")) !== "0") warnOnce(warnings, "バッファのブレンドモードは未対応です");
    // bufferNoFill(中空ハロー)は対応エンジンが canvas ラスタライズへ切替済み。
    // 未対応エンジン(navara/gsimaps 等)でのみ警告する
    if (bufferDraw && qgisBool(b("bufferNoFill")) && !caps?.hollowHalo) {
      warnOnce(warnings, caps
        ? "bufferNoFill(内側を塗らない)はこのエンジンでは未対応です"
        : "bufferNoFill(内側を塗らない)は一部エンジンで未対応です");
    }
  }
  // QFont weight(0-99, >=50 が太字相当)・namedStyle も太字/斜体の決定に使う
  const namedStyle = String(a("namedStyle") || "").toLowerCase();
  const fontWeight = Number(a("fontWeight"));
  const bold = qgisBool(a("fontBold")) || qgisBool(a("forcedBold")) || fontWeight >= 50
    || (namedStyle.includes("bold") || namedStyle.includes("太"));
  const italic = qgisBool(a("fontItalic")) || qgisBool(a("forcedItalic"))
    || (namedStyle.includes("italic") || namedStyle.includes("oblique") || namedStyle.includes("斜"));
  const family = a("fontFamily") || "sans-serif";
  const underline = qgisBool(a("fontUnderline"));
  const strikeout = qgisBool(a("fontStrikeout"));
  // <placement>/<rendering> は <text-style> の親 <settings> の子。
  // 呼び出し側から settingsEl が渡されなければ親要素から辿る
  const setEl = settingsEl || textStyleEl?.parentElement || null;
  const find = tag => setEl?.querySelector?.(tag) || null;

  // <placement>: 配置モード・オフセット・回転(#55)
  const pl = find("placement");
  const plA = name => pl?.getAttribute(name);
  const layerType = String(plA("layerType") || "");
  const modeTable = layerType === "PolygonGeometry" ? PLACEMENT_MODES_POLY
    : layerType === "LineGeometry" ? PLACEMENT_MODES_LINE : PLACEMENT_MODES;
  const placementMode = modeTable[Number(plA("placement") ?? -1)] || "around";
  const quadOffset = Number(plA("quadOffset") ?? 4);
  const flags = Number(plA("placementFlags")) || 0;
  const linePlacement = flags & 2 ? "above" : flags & 4 ? "below" : flags & 1 ? "on" : null;
  const distPx = sizeToPx(plA("dist") ?? 0, plA("distUnits") || "MM");
  const placement = {
    mode: placementMode,
    quad: QUAD_ANCHORS[quadOffset] || QUAD_ANCHORS[8],
    distPx,
    offsetXPx: sizeToPx(plA("xOffset") ?? 0, plA("offsetUnits") || "MM"),
    offsetYPx: sizeToPx(plA("yOffset") ?? 0, plA("offsetUnits") || "MM"),
    rotationDeg: Number(plA("rotationAngle")) || 0,
    linePlacement,
    mapOrientation: (flags & 8) !== 0,
    repeatDistancePx: sizeToPx(plA("repeatDistance") ?? 0, plA("repeatDistanceUnits") || "MM"),
    overrunDistancePx: sizeToPx(plA("overrunDistance") ?? 0, plA("overrunDistanceUnit") || "MM"),
    centroidWhole: qgisBool(plA("centroidWhole")),
    centroidInside: qgisBool(plA("centroidInside")),
    // QML 実出力は fitInPolygonOnly(placement 属性・実名)。旧名 fitInsidePolygon はフォールバック
    fitInsidePolygon: qgisBool(plA("fitInPolygonOnly")) || qgisBool(plA("fitInsidePolygon")),
    // QGIS 3.4x の重なり制御: overlapHandling="Prevent|AllowOverlapAtNoCost|
    // AllowOverlapWithoutPenalty|AllowOverlapIfNecessary"(実出力は文字列)
    overlapHandling: String(plA("overlapHandling") || ""),
    multipartBehavior: String(plA("multipartBehavior") || ""),
    allowDegraded: qgisBool(plA("allowDegraded")),
    maximumDistancePx: sizeToPx(plA("maximumDistance") ?? 0, plA("maximumDistanceUnit") || "MM"),
    preserveRotation: qgisBool(plA("preserveRotation"), true),
    maxCurvedCharAngleIn: Number(plA("maxCurvedCharAngleIn")) || 25,
    maxCurvedCharAngleOut: Number(plA("maxCurvedCharAngleOut")) || -25,
    polygonFlags: Number(plA("polygonPlacementFlags")) || 0,
    predefinedOrder: String(plA("predefinedPositionOrder") || "").split(",").filter(Boolean),
  };
  if (["ordered", "outside"].includes(placementMode)) {
    warnOnce(warnings, `ラベル配置モード ${placementMode} は近似実装です(重心/周囲配置で代替)`);
  }
  if (plA("geometryGeneratorEnabled") === "1") {
    warnOnce(warnings, "ラベルのジオメトリジェネレータは未対応です(地物ジオメトリで代替)");
  }

  const rd = find("rendering");
  const tf = find("text-format");
  const r = parseLabelRendering(setEl, warnings, caps);

  // テキストマスク: 背景近似(マスク色=下層を覆う不透明色で再現)で対応。
  // 真のマスク(地物との抜き差し)はエンジン上できないため最も近い表現
  const maskEl = find("text-mask") || find("mask");
  let maskBg = null;
  if (maskEl && qgisBool(maskEl.getAttribute("maskEnabled") ?? maskEl.getAttribute("enabled"))) {
    // 実属性名は maskSizeUnits(実機検証済み)
    const maskSize = sizeToPx(maskEl.getAttribute("maskSize") ?? maskEl.getAttribute("bufferSize") ?? 1,
      maskEl.getAttribute("maskSizeUnits") || maskEl.getAttribute("maskSizeUnit") || "MM");
    const maskOpacity = Number(maskEl.getAttribute("maskOpacity") ?? 1);
    warnOnce(warnings, "ラベルマスクは不透明背景での近似です");
    maskBg = { type: "rect", fill: withAlpha(parseQgisColor(maskEl.getAttribute("maskColor") ?? "255,255,255,255", [1,1,1,1]), maskOpacity), stroke: null, strokeWidthPx: 0, padPx: [Math.max(maskSize, 1), Math.max(maskSize, 1)], offsetPx: [0,0], rotationDeg: 0 };
  }

  const spec = {
    getText: isExpr ? compileExpr(fieldName) : (props => props?.[fieldName]),
    sizePx,
    // ラベルサイズの単位。DD の Size はこの単位で解釈される(QGIS 準拠)
    sizeUnit,
    // fontSizeUnit=MapUnit/MetersInMapUnits はメートル値も保持し、
    // 対応エンジン(Cesium)が距離連動でラベルを拡縮する
    sizeMeters: mapUnitMeters(fontSize, sizeUnit),
    family,
    bold, italic,
    fontCss: `${italic ? "italic " : ""}${bold ? "bold " : ""}${Math.max(Math.round(sizePx), 6)}px ${family}`,
    fill: withAlpha(textColor, Number.isFinite(textOpacity) ? textOpacity : 1),
    halo: bufferDraw ? { color: bufferColor, widthPx: Math.max(bufferSize, 1), noFill: qgisBool(b("bufferNoFill")) } : null,
    underline, strikeout,
    letterSpacingPx: sizeToPx(a("fontLetterSpacing") ?? 0, "Point") || Number(a("fontLetterSpacing")) || 0,
    wordSpacingPx: sizeToPx(a("fontWordSpacing") ?? 0, "Point") || Number(a("fontWordSpacing")) || 0,
    kerning: qgisBool(a("fontKerning"), true),
    capitalization: Number(a("capitalization")) || 0,
    textOrientation: String(a("textOrientation") || "horizontal"),
    stretchFactor: Number(a("stretchFactor")) || null,
    lineHeightFactor: Number(a("multilineHeight")) || 1,
    lineHeightUnit: String(a("multilineHeightUnit") || "Percentage"),
    // multilineAlign は <text-format>(QGIS3 は settings 直下)。実値:
    // 0=左 1=中央 2=右 3=配置に従う(既定) 4=両端揃え。3 は quad の水平方向へ写像
    align: (() => {
      const v = Number(tf?.getAttribute("multilineAlign") ?? setEl?.getAttribute("multilineAlign")
        ?? a("multilineAlign") ?? a("multilineAlignment") ?? 3);
      if (v === 3) { const h = placement.quad?.h || 0; return h < 0 ? "right" : h > 0 ? "left" : "center"; }
      return { 0: "left", 1: "center", 2: "right", 4: "justify" }[v] || "left";
    })(),
    // バッファサイズの単位(DD BufferSize はこの単位で解釈。QGIS準拠)
    haloSizeUnit: b("bufferSizeUnits") || b("bufferSizeUnit") || "MM",
    placement,
    ...r,
    // 後方互換のトップレベルエイリアス(正本は placement.* / labelScale)
    offsetXPx: placement.offsetXPx,
    offsetYPx: placement.offsetYPx,
    rotationDeg: placement.rotationDeg,
    // quad 方向を含む実効オフセット(px。+x=右, +y=下)
    pixelOffsetOf() {
      const pl = this.placement || {};
      const q = pl.quad || { h: 0, v: 0 };
      return [
        (pl.offsetXPx || 0) + (q.h || 0) * (pl.distPx || 0),
        -((pl.offsetYPx || 0) + (q.v || 0) * (pl.distPx || 0)),
      ];
    },
    background: parseLabelBackground(find("background"), warnings) || maskBg,
    shadow: parseLabelShadow(find("shadow"), warnings),
    callout: parseLabelCallout(find("callout")),
    substitutions: parseLabelSubstitutions(find("substitutions")),
    dd: parseDataDefined(setEl) || {},
    position: null,
  };
  if (a("blendMode") && String(a("blendMode")) !== "0") {
    warnOnce(warnings, "ラベルのブレンドモードは未対応です");
  }
  if (spec.textOrientation === "rotation-based") {
    warnOnce(warnings, "回転ベースの縦書きは水平で代替します");
  }
  // 地物オプション側(rendering)にも書かれる属性を placement へ正規化する
  spec.placement.fitInsidePolygon = !!(spec.placement.fitInsidePolygon || r.fitInsidePolygon);
  // マルチパート: multipartBehavior=LabelLargestPartOnly(実出力) / multipartMode / labelPerPart=0
  spec.largestPartOnly = /largest/i.test(spec.placement.multipartBehavior)
    || (r.multipartMode || "").includes("largest")
    || (rd && String(rd.getAttribute("labelPerPart")) === "0") || false;
  // 重なり制御: overlapHandling(実出力文字列) を displayAll/allowDegraded へ写像
  const oh = spec.placement.overlapHandling;
  if (/AllowOverlapAtNoCost|AllowOverlapWithoutPenalty|AllowOverlap/i.test(oh) && !/IfNecessar|IfNeeded/i.test(oh)) spec.displayAll = true;
  if (/IfNecessar|IfNeeded/i.test(oh)) spec.allowDegraded = true;
  if (spec.placement.allowDegraded) spec.allowDegraded = true;
  if (qgisBool(a("allowHtml"))) warnOnce(warnings, "HTML 書式ラベルは未対応です(テキスト表示に限定)");
  // tabStopDistance は既定値が常時出力されるため、明示的な tabStops のみ警告する
  if (a("tabStops")) warnOnce(warnings, "タブストップ付きラベルは未対応です");
  if (spec.lineHeightUnit && spec.lineHeightUnit !== "Percentage") {
    warnOnce(warnings, "行高さの絶対指定(MM/Point)は割合値で近似します");
  }
  const anchorPct = Number(plA("lineAnchorPercent") ?? 0.5);
  const anchorType = String(plA("lineAnchorType") ?? "0");
  const anchorClip = String(plA("lineAnchorClipping") ?? "0");
  if ((anchorPct !== 0.5 || anchorType !== "0" || anchorClip !== "0")
      && ["line", "curved"].includes(placementMode)) {
    warnOnce(warnings, "ラインアンカー(lineAnchor*)は中点近似です");
  }
  if (a("fontSizeMapUnitScale") && String(a("fontSizeMapUnitScale")) !== "3x:0,0,0,0,0,0") {
    warnOnce(warnings, "縮尺連動フォントサイズ(fontSizeMapUnitScale)は固定値近似です");
  }
  for (const [k, msg] of [
    ["repeatDistanceMapUnitScale", "縮尺連動リピート距離"],
    ["distMapUnitScale", "縮尺連動ラベル距離"],
    ["overrunDistanceMapUnitScale", "縮尺連動オーバーラン距離"],
    ["labelOffsetMapUnitScale", "縮尺連動オフセット"],
  ]) {
    const v = pl?.getAttribute(k);
    if (v && String(v) !== "3x:0,0,0,0,0,0") warnOnce(warnings, `${msg}は固定値近似です`);
  }
  if (Number(pl?.getAttribute("offsetType") ?? 0) !== 0) {
    warnOnce(warnings, "offsetType(シンボル外接/左上基準)は点基準で近似します");
  }
  if (a("useSubstitutions") && !qgisBool(a("useSubstitutions"))) {
    spec.substitutions = {}; // 置換を明示的に無効化
  }
  return spec;
}

// パース済み spec にテキスト変換を適用した最終 spec を返す。
// エンジン側は spec.text / spec.fontCss / spec.fill 等をそのまま使う
function finalizeLabelSpec(spec, props) {
  const s = spec.dd ? applyLabelDD(spec, spec.dd, props) : spec;
  if (!s || !s.drawLabels) return null;
  const raw = s.getText ? s.getText(props) : null;
  const text = formatLabelText(s, raw, props);
  if (!String(text).trim()) return null;
  return { ...s, text: String(text), show: true };
}

function compileLabeling(labelingEl, warnings, caps = null) {
  if (!labelingEl) return null;
  const type = labelingEl.getAttribute("type") || "simple";
  if (type === "none") return null;
  if (type === "rule-based") {
    const rules = [];
    const rulesEl = [...labelingEl.children].find(c => c.tagName === "rules")
      || labelingEl.querySelector("rules");
    for (const ruleEl of rulesEl?.querySelectorAll?.(":scope > rule") || []) {
      // active="0" は無効ラベルルール(QGIS 実出力。レンダラの checkstate と別名)
      if (ruleEl.getAttribute("active") === "0") continue;
      const filter = ruleEl.getAttribute("filter");
      const settingsEl = ruleEl.querySelector("settings") || ruleEl.parentElement;
      const textStyle = ruleEl.querySelector("settings text-style")
        || ruleEl.querySelector("text-style")
        || ruleEl.querySelector("settings text-format")
        || ruleEl.querySelector("text-format");
      if (!textStyle) continue;
      rules.push({
        fn: filter && !/^ELSE$/i.test(filter) ? compileExpr(filter) : null,
        isElse: /^ELSE$/i.test(String(filter || "")),
        style: parseTextStyle(textStyle, settingsEl, warnings, caps),
      });
    }
    if (!rules.length) return null;
    return props => {
      let elseStyle = null;
      for (const r of rules) {
        if (r.isElse) { elseStyle = r.style; continue; }
        if (!r.fn || r.fn(props)) return finalizeLabelSpec(r.style, props);
      }
      return elseStyle ? finalizeLabelSpec(elseStyle, props) : null;
    };
  }
  // simple / perimeter 等は text-style をそのまま使う
  const settingsEl = labelingEl.querySelector("settings") || null;
  const textStyle = labelingEl.querySelector("settings text-style")
    || labelingEl.querySelector("text-style")
    || labelingEl.querySelector("settings text-format")
    || labelingEl.querySelector("text-format");
  if (!textStyle) return null;
  const style = parseTextStyle(textStyle, settingsEl, warnings, caps);
  return props => finalizeLabelSpec(style, props);
}

// ---------------------------------------------------------------------------
// コンパイル済みスタイル
// ---------------------------------------------------------------------------

export function compileQmlStyle(xmlText, baseUrl, preloadedImages = new Map(), engine = null) {
  // エンジン名でラベル機能カバレッジを引き、未対応のものだけ警告する
  // (engine 未指定は従来通り全警告を出す。未知名は未対応扱い)
  const labelCaps = engine ? (QML_LABEL_CAPS[engine] || {}) : null;
  const doc = new DOMParser().parseFromString(String(xmlText), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("QML の XML パースに失敗しました");
  const warnings = new Set();
  const rendererEl = doc.querySelector("renderer-v2");
  if (!rendererEl) throw new Error("QML に renderer-v2 がありません(シンボロジが含まれていません)");
  const renderer = compileRenderer(rendererEl, warnings);
  const diagram = parseDiagram(doc.documentElement, warnings);
  // ルート <qgis labelsEnabled="0"> はラベル無効の実出力属性。
  // <labeling> 設定が残っていても描画しない(QGIS 準拠)
  const labelsEnabled = String(doc.documentElement.getAttribute("labelsEnabled") ?? "1");
  const labelingEl = labelsEnabled === "0" ? null : doc.querySelector("labeling");
  const labelFn = compileLabeling(labelingEl, warnings, labelCaps);
  // ルート <qgis> のレイヤー縮尺依存表示
  // (hasScaleBasedVisibilityFlag + minScale/maxScale、分母値)。
  // minScale=縮尺分母の下限(これより縮小側では非表示)、maxScale=上限(拡大側で非表示)
  const layerScale = String(doc.documentElement.getAttribute("hasScaleBasedVisibilityFlag") ?? "0") === "1"
    ? { minScale: Number(doc.documentElement.getAttribute("minScale")) || 0,
        maxScale: Number(doc.documentElement.getAttribute("maxScale")) || 0 }
    : null;
  const images = preloadedImages;

  const evaluate = (props) => {
    const result = renderer.evaluate(props || {});
    // RuleBased は {names, scale}、その他は配列
    const names = Array.isArray(result) ? result : result.names;
    const scale = Array.isArray(result) ? null : result.scale;
    if (!names?.length) return null;
    const out = { markers: null, line: null, fillParts: null, outline: null, centroid: null, scale: null };
    // 縮尺分母 → 概算カメラ距離(m)。表示中の地物はこの距離範囲でのみ描画する近似
    const toDist = s => (s > 0 ? s * 0.00028 * 900 / (2 * Math.tan(Math.PI / 6)) : 0);
    let near = 0, far = Number.MAX_VALUE;
    if (scale && (scale.min > 1 || scale.max > 0)) {
      near = toDist(scale.min);
      far = scale.max > 0 ? toDist(scale.max) : far;
    }
    if (layerScale) {
      // レイヤー自体の縮尺依存表示を積集合で合流。
      // <qgis> の minScale=縮小側境界(大分母)→遠距離、maxScale=拡大側→近距離
      if (layerScale.maxScale > 0) near = Math.max(near, toDist(layerScale.maxScale));
      if (layerScale.minScale > 0) far = Math.min(far, toDist(layerScale.minScale));
    }
    if (near > 0 || far < Number.MAX_VALUE) out.scale = { near, far };
    for (const name of names) {
      const symbol = renderer.symbols.get(name);
      if (!symbol) continue;
      const resolved = resolveSymbolLayers(symbol, props || {}, images, warnings);
      applySymbolAlpha(resolved);
      // symbollevels 近似用の順位(その地物が使うシンボルの最小 pass)
      if (Number.isFinite(resolved.minPass)) {
        out.zRank = Math.min(out.zRank ?? Infinity, resolved.minPass);
      }
      if (resolved.markers && !out.markers) out.markers = resolved.markers;
      if (resolved.line && !out.line) out.line = resolved.line;
      if (resolved.lines && !out.lines) out.lines = resolved.lines;
      if (resolved.fillParts && !out.fillParts) out.fillParts = resolved.fillParts;
      if (resolved.outline && !out.outline) out.outline = resolved.outline;
      if (resolved.centroid && !out.centroid) out.centroid = resolved.centroid;
      if (resolved.gg) (out.gg ||= []).push(...resolved.gg);
    }
    return out;
  };

  // 地物プロパティからシンボル名の配列を返す(凡例の条件別表示/非表示切替用)
  const namesFor = (props) => {
    const result = renderer.evaluate(props || {});
    return Array.isArray(result) ? result : (result?.names || []);
  };

  const legend = renderer.legend.map(e => {
    const symbol = renderer.symbols.get(e.symbolName);
    let spec = null;
    if (symbol) {
      try { spec = resolveSymbolLayers(symbol, {}, images, warnings); applySymbolAlpha(spec); } catch (err) { spec = null; }
    }
    return { label: e.label, symbolName: e.symbolName, spec };
  });

  // ---- 属性表示メタデータ(#56) ----
  // <aliases><alias field= name=>、<attributetableconfig><column name= hidden=>、
  // <previewExpression>(表示式)、<mapTip> を属性パネル/ポップアップ向けに抽出する
  const fields = { alias: {}, hidden: new Set(), order: [], displayExpr: "", mapTip: "" };
  for (const al of doc.querySelectorAll("aliases > alias")) {
    const f = al.getAttribute("field"), n = al.getAttribute("name");
    if (f && n) fields.alias[f] = n;
  }
  const atc = doc.querySelector("attributetableconfig");
  for (const col of atc?.querySelectorAll("columns > column") || []) {
    const nm = col.getAttribute("name");
    if (!nm || col.getAttribute("type") === "actions") continue;
    fields.order.push(nm);
    if (col.getAttribute("hidden") === "1") fields.hidden.add(nm);
  }
  fields.displayExpr = doc.querySelector("previewExpression")?.textContent?.trim() || "";
  fields.mapTip = doc.querySelector("mapTip")?.textContent?.trim() || "";
  const displayFn = fields.displayExpr ? compileExpr(fields.displayExpr) : null;
  const hasFieldMeta = Object.keys(fields.alias).length > 0 || fields.hidden.size > 0 || fields.order.length > 0 || !!fields.displayExpr;

  return {
    evaluate,
    namesFor,
    labelFor: labelFn ? (props => labelFn(props)) : null,
    legend,
    warnings: [...warnings],
    unsupported: !!renderer.unsupported,
    // symbollevels=1 か。true のとき evaluate() の spec.zRank に最小 pass が入る
    // (Web エンジンではレイヤ単位の完全な cross-feature 順序制御は不可能なため
    //  地物単位の z 順位近似。仕様の限界は qml-coverage 台帳を参照)
    symbolLevels: !!renderer.symbolLevels,
    heatmap: renderer.heatmap || null,
    cluster: renderer.cluster || null,
    inverted: !!renderer.inverted,
    // 25dRenderer: {height} を保持(Cesium/Navara の押出し近似用)
    d25: renderer.d25 || null,
    diagram,
    symbols: renderer.symbols,
    // ルール別縮尺(scalemin/maxdenom)の一覧。描画側はユニオンで
    // レイヤー制限に使う(ルール切替でレイヤーごと消えないように)
    ruleScales: renderer.ruleScales || null,
    // レイヤー自体の縮尺依存表示(<qgis> ルート属性)。null=縮尺無制限
    layerScale,
    images,
    // 属性表示メタ。displayFor(props) は displayExpression を評価して
    // 地物の表示名を返す(未設定なら null)
    fields: hasFieldMeta ? fields : null,
    displayFor: displayFn ? (props => displayFn(props)) : null,
    // QML 内に @map_scale を含むか。エンジンは縮尺変化時にこのフラグの
    // レイヤだけスタイルを再評価すればよい(パン/全量再描画を避ける)
    usesMapScale: /[@$](?:map_)?scale\b|var\(\s*['"](?:map_)?scale['"]\s*\)/i.test(String(xmlText)),
    // is_layer_visible() を含むか。他レイヤーの登録・表示切替後に
    // スタイル/ラベルの再評価が必要になるため、エンジンはこれをゲートにする
    usesLayerVisibility: /is_layer_visible\s*\(/i.test(String(xmlText)),
    // @map_scale/@scale DD/式 またはルール別縮尺(scalemin/maxdenom)を含むか。
    // 縮尺変化でシンボル解決が変わるため、エンジンはこれをゲートに
    // ズーム確定後の再評価を行う
    scaleDependent: /[@$](?:map_)?scale\b|var\(\s*['"](?:map_)?scale['"]\s*\)/i.test(String(xmlText))
      || !!(renderer.ruleScales?.some(s => s.min > 0 || s.max > 0))
      || !!(layerScale && (layerScale.minScale > 0 || layerScale.maxScale > 0)),
  };
}

// <SingleCategoryDiagramRenderer>/<LinearlyInterpolatedDiagramRenderer> +
// <DiagramLayerSettings> → ダイアグラム spec(#108)。renderer-v2 とは独立した
// レイヤ設定として記録される。enabled=0 や属性フィールド無しは未使用とみなす
function parseDiagram(rootEl, warnings) {
  let dr = null;
  const walk = el => {
    if (!el?.children) return;
    for (const c of el.children) {
      if (String(c.tagName).endsWith("DiagramRenderer")) dr = dr || c;
      walk(c);
    }
  };
  walk(rootEl);
  if (!dr) return null;
  const cat = [...dr.children].find(c => c.tagName === "DiagramCategory");
  if (cat && !qgisBool(cat.getAttribute("enabled") ?? "1")) return null;
  const attrs = [...(cat?.children || [])].filter(c => c.tagName === "attribute")
    .map(a => ({
      field: a.getAttribute("field") || "",
      label: a.getAttribute("label") || a.getAttribute("field") || "",
      color: parseQgisColor(a.getAttribute("color"), [0.3, 0.5, 0.8, 1]),
    }))
    .filter(a => a.field);
  if (!attrs.length) return null;
  const sizeUnit = cat?.getAttribute("sizeType") || "MM";
  const bg = parseQgisColor(cat?.getAttribute("backgroundColor"), null);
  if (bg) bg[3] *= Number(cat?.getAttribute("backgroundAlpha") ?? 255) / 255;
  const pen = parseQgisColor(cat?.getAttribute("penColor"), null);
  if (pen) pen[3] *= Number(cat?.getAttribute("penAlpha") ?? 255) / 255;
  const diagram = {
    type: dr.getAttribute("diagramType") || "Pie",
    orientation: cat?.getAttribute("diagramOrientation") || "Up",
    widthPx: sizeToPx(cat?.getAttribute("width") ?? 15, sizeUnit) || 40,
    heightPx: sizeToPx(cat?.getAttribute("height") ?? 15, sizeUnit) || 40,
    barWidthPx: sizeToPx(cat?.getAttribute("barWidth") ?? 5, sizeUnit) || 12,
    bg, pen,
    penWidthPx: sizeToPx(cat?.getAttribute("penWidth") ?? 0, "MM") || 0,
    opacity: alphaAttr(cat?.getAttribute("opacity")),
    attrs,
    // LinearlyInterpolatedDiagramRenderer: 分類属性値でサイズを線形変化(近似)
    scale: dr.tagName === "LinearlyInterpolatedDiagramRenderer" ? {
      attr: cat?.getAttribute("classificationAttributeExpression") || dr.getAttribute("classificationAttributeExpression") || "",
      lo: Number(cat?.getAttribute("lowerValue") ?? dr.getAttribute("lowerValue")) || 0,
      hi: Number(cat?.getAttribute("upperValue") ?? dr.getAttribute("upperValue")) || 0,
      loW: sizeToPx(cat?.getAttribute("lowerWidth") ?? 0, sizeUnit) || 0,
      hiW: sizeToPx(cat?.getAttribute("upperWidth") ?? 0, sizeUnit) || 0,
      loH: sizeToPx(cat?.getAttribute("lowerHeight") ?? 0, sizeUnit) || 0,
      hiH: sizeToPx(cat?.getAttribute("upperHeight") ?? 0, sizeUnit) || 0,
    } : null,
  };
  warnOnce(warnings, `ダイアグラム(${diagram.type})は Canvas 簡易描画です(軸・ラベル・優先度制御は未対応)`);
  return diagram;
}

// SVGFill の埋込 `data` プロパティを data: URI へ変換する。
// QGIS4 は SVG バイト列を hex 文字列として格納する(QByteArray::toHex)。
// 直接書かれた <svg>/base64/data: 形式も後方互換として拾う
function svgFillEmbeddedUri(p) {
  const raw = String(p?.data ?? "").trim();
  if (!raw) return "";
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    let text = "";
    for (let i = 0; i < raw.length; i += 2) text += String.fromCharCode(parseInt(raw.slice(i, i + 2), 16));
    if (/^\s*(?:<\?xml|<svg)/i.test(text)) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
    return ""; // PNG 等のバイナリ埋込は未対応
  }
  if (/^\s*(?:<\?xml|<svg)/i.test(raw)) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(raw);
  if (/^iVBOR/.test(raw)) return "data:image/png;base64," + raw;
  if (/^(?:data:|base64,)/i.test(raw)) return raw;
  return "";
}

// QML 内で参照される画像 URL を収集して事前ロードする
function collectImagePaths(el, acc) {
  if (!el) return;
  const cls = el.getAttribute?.("class");
  if (cls === "SvgMarker" || cls === "RasterMarker" || cls === "SVGFill" || cls === "RasterFill" || cls === "AnimatedMarker" || cls === "RasterLine") {
    const props = optionMap(el);
    // 実名(svgFile/imageFile/name)を優先、旧名はフォールバック。
    // SVGFill 埋込 data は data: URI に変換して画像マップのキーと一致させる
    const key = String(props.name ?? props.svgFile ?? props.imageFile ?? props.svgfile ?? props.file ?? props.path ?? "")
      || svgFillEmbeddedUri(props);
    if (key) acc.add(key);
  }
  for (const c of el.children || []) collectImagePaths(c, acc);
}

export async function loadQmlStyle(url, fetchText, engine = null) {
  const text = await fetchText(url);
  // GeometryGenerator を含む QML は式評価の turf.js を先読みする(#64)
  if (/GeometryGenerator|geometryModifier/i.test(String(text))) await ensureTurf();
  const doc = new DOMParser().parseFromString(String(text), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("QML の XML パースに失敗しました");

  // 画像の事前ロード(相対パスは .qml のディレクトリ基準)
  const pathKeys = new Set();
  collectImagePaths(doc.documentElement, pathKeys);
  const images = new Map();
  await Promise.all([...pathKeys].map(async key => {
    const resolved = resolveResourceUrl(key, url);
    if (!resolved) return;
    let img = null;
    if (/\.svg(\?|#|$)/i.test(key) || /^data:image\/svg/i.test(resolved)) {
      // SVG は param() 再着色を試みる(失敗時は素の画像)
      const markerProps = findMarkerPropsForKey(doc.documentElement, key) || {};
      const fill = parseQgisColor(markerProps.color, null);
      const stroke = parseQgisColor(markerProps.outline_color, null);
      img = await loadSvgRecolored(resolved, fill, stroke, fetchText);
      if (!img) img = await loadImage(resolved);
    } else {
      img = await loadImage(resolved);
    }
    if (img) images.set(key, img);
  }));

  return compileQmlStyle(text, url, images, engine);
}

function findMarkerPropsForKey(el, key) {
  if (!el) return null;
  if (el.tagName === "layer") {
    const props = optionMap(el);
    if (String(props.name ?? props.svgFile ?? props.imageFile ?? props.svgfile ?? props.file ?? "") === key) return props;
  }
  for (const c of el.children || []) {
    const hit = findMarkerPropsForKey(c, key);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// canvas 生成(マーカー画像・塗りつぶしパターンタイル)
// ---------------------------------------------------------------------------

const canvasCache = new Map();
const CANVAS_CACHE_MAX = 400;

function getCanvas(key, size, draw) {
  let hit = canvasCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.max(Math.ceil(size), 2);
  const ctx = canvas.getContext("2d");
  draw(ctx, canvas.width);
  if (canvasCache.size >= CANVAS_CACHE_MAX) canvasCache.clear();
  canvasCache.set(key, canvas);
  return canvas;
}

// マーカーレイヤ1枚を ctx の原点(中心)へ描く
function drawMarkerLayerTo(ctx, layer) {
  ctx.save();
  ctx.translate(layer.offsetPx?.[0] || 0, layer.offsetPx?.[1] || 0);
  // bakeRotationDeg: canvas へ焼き込む回転(VectorField 等)。billboard/Icon 側の
  // rotationDeg 適用(地物別再回転)と二重にならないよう分離する
  ctx.rotate(((layer.bakeRotationDeg ?? layer.rotationDeg) || 0) * Math.PI / 180);
  ctx.globalAlpha = layer.alpha ?? 1;
  const half = (layer.sizePx || 8) / 2;
  if (layer.kind === "shape") {
    const shapeFn = MARKER_SHAPES[layer.shape] || MARKER_SHAPES.circle;
    ctx.beginPath();
    ctx.save();
    ctx.scale(half, half);
    shapeFn(ctx);
    ctx.restore();
    if (STROKE_ONLY_SHAPES.has(layer.shape)) {
      ctx.strokeStyle = rgbaToCss(layer.stroke || layer.fill || [0, 0, 0, 1]);
      ctx.lineWidth = layer.strokeWidthPx || Math.max(half * 0.3, 1.5);
      ctx.stroke();
    } else {
      if (layer.fill) {
        ctx.fillStyle = rgbaToCss(layer.fill);
        ctx.fill();
      }
      if (layer.stroke && layer.strokeWidthPx > 0) {
        ctx.strokeStyle = rgbaToCss(layer.stroke);
        ctx.lineWidth = layer.strokeWidthPx;
        ctx.stroke();
      }
    }
  } else if (layer.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, (layer.widthPx || 8) / 2, (layer.heightPx || 8) / 2, 0, 0, Math.PI * 2);
    if (layer.fill) { ctx.fillStyle = rgbaToCss(layer.fill); ctx.fill(); }
    if (layer.stroke) { ctx.strokeStyle = rgbaToCss(layer.stroke); ctx.lineWidth = layer.strokeWidthPx || 1; ctx.stroke(); }
  } else if (layer.kind === "image" && layer.image) {
    const img = layer.image;
    const ratio = img.height / (img.width || 1);
    const w = layer.sizePx, h = layer.sizePx * (Number.isFinite(ratio) ? ratio : 1);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  } else if (layer.kind === "text") {
    ctx.font = `${Math.round(layer.sizePx || 10)}px ${layer.fontFamily || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (layer.stroke) {
      ctx.strokeStyle = rgbaToCss(layer.stroke);
      ctx.lineWidth = layer.strokeWidthPx || 1;
      ctx.strokeText(layer.text, 0, 0);
    }
    ctx.fillStyle = rgbaToCss(layer.fill || [0, 0, 0, 1]);
    ctx.fillText(layer.text, 0, 0);
  } else if (layer.kind === "arrow") {
    // VectorField 用矢印: sizePx の長さで上向き(北)に描き、rotationDeg で回す
    const len = layer.sizePx || 10;
    const w = Math.max(layer.strokeWidthPx || 1, 0.8);
    const head = Math.min(Math.max(len * 0.28, w * 3), len * 0.45);
    ctx.strokeStyle = rgbaToCss(layer.color || [0, 0, 0, 1]);
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    // 軸(下端→先端手前)
    ctx.moveTo(0, len / 2);
    ctx.lineTo(0, -len / 2 + head * 0.4);
    // 矢じり(先端から斜め後方へ2本)
    ctx.moveTo(-head * 0.5, -len / 2 + head);
    ctx.lineTo(0, -len / 2);
    ctx.lineTo(head * 0.5, -len / 2 + head);
    ctx.stroke();
  }
  ctx.restore();
}

// ペイントエフェクト1段を canvas へ適用する(canvas 全体を変換)
function applyEffectToCanvas(cur, fx) {
  const type = String(fx.type || "drawSource").toLowerCase();
  if (type === "drawsource" || type === "source") return cur;
  const out = document.createElement("canvas");
  out.width = cur.width; out.height = cur.height;
  const ctx = out.getContext("2d");
  const W = cur.width, H = cur.height;
  const col = parseQgisColor(fx.color ?? fx.fill_color ?? fx.glow_color, [1, 0.8, 0, 1]);
  const css = rgbaToCss(withAlpha(col, Number(fx.opacity ?? 1) || 1));
  const blurPx = sizeToPx(fx.blur_level ?? fx.blur_radius ?? 0, fx.blur_unit || "MM");
  const distPx = sizeToPx(fx.offset_distance ?? fx.offset ?? 0, fx.offset_unit || "MM");
  const ang = (Number(fx.offset_angle) || 0) * Math.PI / 180;
  switch (type) {
    case "blur":
      ctx.filter = `blur(${Math.max(blurPx, 0.5)}px)`;
      ctx.drawImage(cur, 0, 0);
      break;
    case "dropshadow":
      ctx.shadowColor = css;
      ctx.shadowOffsetX = Math.cos(ang) * distPx;
      ctx.shadowOffsetY = Math.sin(ang) * distPx;
      ctx.shadowBlur = Math.max(blurPx, 0);
      ctx.drawImage(cur, 0, 0);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.drawImage(cur, 0, 0);
      break;
    case "glow":
    case "outerglow": {
      ctx.shadowColor = css;
      ctx.shadowBlur = Math.max(blurPx || Number(fx.spread) * MM_TO_PX || 4, 1);
      ctx.drawImage(cur, 0, 0);
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
      ctx.drawImage(cur, 0, 0);
      break;
    }
    case "innerglow":
    case "innershadow": {
      // source-in で形状内部へ色を滲ませる近似
      if (type === "innershadow") {
        ctx.shadowOffsetX = Math.cos(ang) * distPx;
        ctx.shadowOffsetY = Math.sin(ang) * distPx;
      }
      ctx.shadowColor = css;
      ctx.shadowBlur = Math.max(blurPx, 1);
      ctx.globalCompositeOperation = "source-in";
      ctx.drawImage(cur, 0, 0);
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(cur, 0, 0);
      break;
    }
    case "colourize":
    case "colorize": {
      ctx.drawImage(cur, 0, 0);
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "transform": {
      const sx = Number(fx.scale_x ?? 1) || 1;
      const sy = Number(fx.scale_y ?? 1) || 1;
      const rx = Number(fx.reflect_x ?? 0) ? -1 : 1;
      const ry = Number(fx.reflect_y ?? 0) ? -1 : 1;
      const tx = sizeToPx(fx.translate_x ?? 0, fx.translate_unit || "MM");
      const ty = sizeToPx(fx.translate_y ?? 0, fx.translate_unit || "MM");
      const rot = (Number(fx.rotation) || 0) * Math.PI / 180;
      ctx.translate(W / 2 + tx, H / 2 + ty);
      ctx.rotate(rot);
      ctx.scale(sx * rx, sy * ry);
      ctx.drawImage(cur, -W / 2, -H / 2);
      break;
    }
    default:
      ctx.drawImage(cur, 0, 0);
      break;
  }
  return out;
}

// マーカーレイヤ群を1枚の canvas に合成する。返り値 {canvas, anchorY}
// ダイアグラム(#108): 地物属性値から円グラフ/棒グラフの canvas を生成する。
// 値が全て 0/欠損の地物は null(=ダイアグラム非表示)
export function diagramCanvas(diagram, props) {
  const vals = diagram.attrs.map(a => ({ v: Math.max(0, Number(props?.[a.field]) || 0), color: a.color }));
  const total = vals.reduce((s, x) => s + x.v, 0);
  if (!(total > 0)) return null;
  let w = diagram.widthPx, h = diagram.heightPx;
  if (diagram.scale?.attr) {
    const sv = Number(props?.[diagram.scale.attr]);
    if (Number.isFinite(sv) && diagram.scale.hi > diagram.scale.lo) {
      const f = Math.min(1, Math.max(0, (sv - diagram.scale.lo) / (diagram.scale.hi - diagram.scale.lo)));
      w = (diagram.scale.loW || w) + ((diagram.scale.hiW || w) - (diagram.scale.loW || w)) * f;
      h = (diagram.scale.loH || h) + ((diagram.scale.hiH || h) - (diagram.scale.loH || h)) * f;
    }
  }
  const pad = Math.max(diagram.penWidthPx + 2, 3);
  const S = Math.max(Math.ceil(Math.max(w, h)) + pad * 2, 8);
  const key = `dg:${diagram.type}:${Math.round(w)}x${Math.round(h)}:${vals.map(x => x.v).join(",")}:${JSON.stringify(diagram.attrs.map(a => a.color))}`;
  return getCanvas(key, S, (ctx) => {
    ctx.globalAlpha = diagram.opacity;
    if (diagram.type === "Histogram") {
      const max = Math.max(...vals.map(x => x.v), 1e-9);
      const bw = diagram.barWidthPx;
      const totalW = vals.length * bw;
      const x0 = (S - totalW) / 2, yBase = S - pad;
      if (diagram.bg && diagram.bg[3] > 0) { ctx.fillStyle = rgbaToCss(diagram.bg); ctx.fillRect(x0, pad, totalW, h); }
      vals.forEach((x, i) => {
        const bh = Math.max((x.v / max) * h, x.v > 0 ? 1 : 0);
        ctx.fillStyle = rgbaToCss(x.color);
        ctx.fillRect(x0 + i * bw, yBase - bh, Math.max(bw - 0.5, 1), bh);
      });
      return;
    }
    // Pie(既定): 北(12時)から時計回りに各スライス
    const r = Math.max((Math.min(w, h) || S - pad * 2) / 2, 1);
    const cx = S / 2, cy = S / 2;
    if (diagram.bg && diagram.bg[3] > 0) {
      ctx.fillStyle = rgbaToCss(diagram.bg);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    let a0 = -Math.PI / 2;
    for (const x of vals) {
      if (!(x.v > 0)) continue;
      const a1 = a0 + (x.v / total) * Math.PI * 2;
      ctx.fillStyle = rgbaToCss(x.color);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a0, a1); ctx.closePath(); ctx.fill();
      a0 = a1;
    }
    if (diagram.pen && diagram.penWidthPx > 0) {
      ctx.strokeStyle = rgbaToCss(diagram.pen);
      ctx.lineWidth = diagram.penWidthPx;
      ctx.beginPath(); ctx.arc(cx, cy, r - diagram.penWidthPx / 2, 0, Math.PI * 2); ctx.stroke();
    }
  });
}

export function markerLayersToCanvas(markerLayers) {
  const maxSize = Math.max(...markerLayers.map(m => m.sizePx || m.widthPx || 8), 4);
  const pad = Math.max(...markerLayers.map(m => (m.strokeWidthPx || 0) + 2), 2);
  const size = maxSize + pad * 2;
  const key = `mk:${JSON.stringify(markerLayers.map(m => ({ ...m, image: m.image ? (m.image.src || "img") : undefined })))}`;
  const canvas = getCanvas(key, size, (ctx, W) => {
    for (const layer of markerLayers) {
      ctx.save();
      if (layer.blend) ctx.globalCompositeOperation = layer.blend;
      if (layer.effects?.length) {
        // エフェクト付きレイヤは単独 canvas に描いてからエフェクトを通す
        const tmp = document.createElement("canvas");
        tmp.width = tmp.height = size;
        const tctx = tmp.getContext("2d");
        tctx.translate(size / 2, size / 2);
        drawMarkerLayerTo(tctx, layer);
        const fxCanvas = layer.effects.reduce((c, fx) => applyEffectToCanvas(c, fx), tmp);
        ctx.drawImage(fxCanvas, 0, 0);
      } else {
        ctx.translate(W / 2, W / 2);
        drawMarkerLayerTo(ctx, layer);
      }
      ctx.restore();
    }
  });
  return canvas;
}

// 塗りつぶしパターンを1枚のタイル canvas に合成する。
// {canvas, tileMeters} を返す。全パートが solid のみなら null(単色描画に分岐)
export function fillPartsToTile(fillParts) {
  const patterns = fillParts.filter(pt => pt.hatch || pt.linePattern || pt.pointPattern || pt.imagePattern || pt.gradient);
  const solids = fillParts.filter(pt => pt.solid);
  const solidBase = solids.length ? solids[solids.length - 1].solid : null;
  if (!patterns.length) return { solidBase, tile: null, tileMeters: 0 };

  const maxSpacing = Math.max(...patterns.map(pt =>
    pt.hatch ? pt.hatch.spacingPx : pt.linePattern ? pt.linePattern.spacingPx : pt.pointPattern ? Math.max(pt.pointPattern.spacingX, pt.pointPattern.spacingY) : pt.imagePattern ? pt.imagePattern.widthPx : 32), 8);
  const tilePx = Math.min(Math.max(Math.ceil(maxSpacing), 8), 128);
  const key = `ft:${JSON.stringify(fillParts.map(pt => ({ ...pt, imagePattern: pt.imagePattern ? { w: pt.imagePattern.widthPx, src: pt.imagePattern.image.src } : undefined, pointPattern: pt.pointPattern ? { sx: pt.pointPattern.spacingX, sy: pt.pointPattern.spacingY, n: pt.pointPattern.markers.length } : undefined })))}`;
  const canvas = getCanvas(key, tilePx, (ctx, W) => {
    if (solidBase) {
      ctx.fillStyle = rgbaToCss(solidBase);
      ctx.fillRect(0, 0, W, W);
    }
    for (const pt of patterns) {
      ctx.save();
      if (pt.blend) ctx.globalCompositeOperation = pt.blend;
      if (pt.alphaMul != null) ctx.globalAlpha *= pt.alphaMul;
      if (pt.hatch) {
        drawHatch(ctx, W, pt.hatch.angles, pt.hatch.spacingPx, pt.hatch.color);
      } else if (pt.linePattern) {
        drawHatch(ctx, W, [pt.linePattern.angleDeg], pt.linePattern.spacingPx, pt.linePattern.color, pt.linePattern.widthPx);
      } else if (pt.pointPattern) {
        const { markers, spacingX, spacingY, dispX = 0, dispY = 0, offX = 0, offY = 0 } = pt.pointPattern;
        const stamp = markerLayersToCanvas(markers);
        const stepX = Math.max(spacingX, 4), stepY = Math.max(spacingY, 4);
        let row = 0;
        for (let y = offY; y < W + stepY; y += stepY, row++) {
          const shift = row % 2 ? (dispX || 0) : 0;
          for (let x = offX + shift; x < W + stepX; x += stepX) {
            ctx.drawImage(stamp, x - stamp.width / 2, y - stamp.height / 2);
          }
        }
      } else if (pt.imagePattern && pt.imagePattern.image) {
        const img = pt.imagePattern.image;
        const w = pt.imagePattern.widthPx;
        const h = w * (img.height / (img.width || 1) || 1);
        for (let y = 0; y < W + h; y += h) {
          for (let x = 0; x < W + w; x += w) {
            ctx.drawImage(img, x, y, w, h);
          }
        }
      } else if (pt.gradient) {
        const a = (pt.gradient.angleDeg || 0) * Math.PI / 180;
        const g = ctx.createLinearGradient(0, 0, Math.cos(a) * W, Math.sin(a) * W);
        g.addColorStop(0, rgbaToCss(pt.gradient.color1));
        g.addColorStop(1, rgbaToCss(pt.gradient.color2));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, W);
      }
      ctx.restore();
    }
  });
  return { solidBase, tile: canvas, tileMeters: tilePx * METERS_PER_PX };
}

// --- ラベル spec → canvas ラスタライザ ---
// bufferNoFill(中空ハロー)・背景・影を含む実描画が必要な経路用。
// 返り値: {canvas, anchorX, anchorY}(0..1)。中心アンカー基準で offset は消費側が扱う
export function qmlLabelCanvas(spec) {
  const text = String(spec?.text ?? "");
  if (!text.trim()) return null;
  const font = spec.fontCss || `${Math.max(spec.sizePx || 12, 6)}px sans-serif`;
  const halo = spec.halo;
  const haloW = halo ? Math.max(Number(halo.widthPx) || 1, 1) : 0;
  const bg = spec.background;
  const padX = (bg ? (bg.padPx?.[0] ?? 2) : 0) + 2;
  const padY = (bg ? (bg.padPx?.[1] ?? 2) : 0) + 2;
  const lines = text.split("\n");
  const lineH = (spec.sizePx || 12) * (spec.lineHeightFactor || 1) * 1.15;
  const meas = document.createElement("canvas").getContext("2d");
  meas.font = font;
  let textW = 0;
  for (const ln of lines) textW = Math.max(textW, meas.measureText(ln).width);
  if (spec.letterSpacingPx) textW += spec.letterSpacingPx * Math.max(...lines.map(l => [...l].length - 1), 0);
  const W = Math.ceil(textW + haloW * 2 + padX * 2) | 0;
  const H = Math.ceil(lines.length * lineH + haloW * 2 + padY * 2) | 0;
  const cv = document.createElement("canvas");
  cv.width = Math.max(W, 2); cv.height = Math.max(H, 2);
  const ctx = cv.getContext("2d");
  const cx = cv.width / 2;
  const y0 = haloW + padY + lineH / 2;

  // 背景(rect/ellipse)。回転は近似で無視(消費側の回転で代替)
  if (bg?.fill) {
    ctx.save();
    ctx.fillStyle = rgbaToCss(bg.fill);
    if (bg.type === "ellipse" || bg.type === "circle") {
      ctx.beginPath();
      ctx.ellipse(cx, cv.height / 2, (cv.width - haloW * 2) / 2, (cv.height - haloW * 2) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const r = bg.radiusPx || 0;
      ctx.beginPath();
      if (r && ctx.roundRect) ctx.roundRect(1, 1, cv.width - 2, cv.height - 2, r);
      else ctx.rect(0, 0, cv.width, cv.height);
      ctx.fill();
      if (bg.stroke) { ctx.strokeStyle = rgbaToCss(bg.stroke); ctx.lineWidth = Math.max(bg.strokeWidthPx || 1, 1); ctx.stroke(); }
    }
    ctx.restore();
  }

  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const each = fn => lines.forEach((ln, i) => fn(ln, cx, y0 + i * lineH, i));

  // ドロップシャドウ(先に描く)
  if (spec.shadow) {
    ctx.save();
    ctx.fillStyle = rgbaToCss(spec.shadow.color);
    each((ln, x, y) => ctx.fillText(ln, x + spec.shadow.offsetPx[0], y + spec.shadow.offsetPx[1]));
    ctx.restore();
  }

  // ハロー。noFill(中空)は別canvasに描いてからグリフ内側をくり抜く
  if (halo) {
    ctx.lineWidth = haloW * 2;
    ctx.lineJoin = "round";
    ctx.strokeStyle = rgbaToCss(halo.color);
    if (halo.noFill) {
      const oc = document.createElement("canvas");
      oc.width = cv.width; oc.height = cv.height;
      const oc2 = oc.getContext("2d");
      oc2.font = font; oc2.textAlign = "center"; oc2.textBaseline = "middle";
      oc2.lineWidth = haloW * 2; oc2.lineJoin = "round"; oc2.strokeStyle = rgbaToCss(halo.color);
      each((ln, x, y) => oc2.strokeText(ln, x, y));
      oc2.globalCompositeOperation = "destination-out";
      oc2.fillStyle = "#000";
      each((ln, x, y) => oc2.fillText(ln, x, y));
      ctx.drawImage(oc, 0, 0);
    } else {
      each((ln, x, y) => ctx.strokeText(ln, x, y));
    }
  }

  // 本文(下線・取り消し線込み)
  ctx.fillStyle = rgbaToCss(spec.fill);
  each((ln, x, y) => ctx.fillText(ln, x, y));
  if (spec.underline || spec.strikeout) {
    ctx.strokeStyle = rgbaToCss(spec.fill);
    ctx.lineWidth = Math.max((spec.sizePx || 12) / 12, 1);
    const uw = textW / 2;
    each((ln, x, y) => {
      ctx.beginPath();
      const yy = y + (spec.underline ? lineH * 0.42 : lineH * 0.05);
      ctx.moveTo(x - uw, yy); ctx.lineTo(x + uw, yy); ctx.stroke();
    });
  }
  return { canvas: cv, anchorX: 0.5, anchorY: 0.5 };
}

function drawHatch(ctx, W, anglesDeg, spacingPx, color, widthPx = 1) {
  ctx.save();
  ctx.strokeStyle = rgbaToCss(color);
  ctx.lineWidth = Math.max(widthPx, 0.7);
  const diag = W * Math.SQRT2;
  for (const deg of anglesDeg) {
    ctx.save();
    ctx.translate(W / 2, W / 2);
    ctx.rotate(deg * Math.PI / 180);
    for (let x = -diag; x <= diag; x += spacingPx) {
      ctx.beginPath();
      ctx.moveTo(x, -diag);
      ctx.lineTo(x, diag);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}
