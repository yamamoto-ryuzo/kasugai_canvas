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

// QGIS のサイズ単位を px に変換する。MapUnit/MetersInMapUnits は実用上
// 度単位データでは意味を持たないため、近似として px 相当に丸める
function sizeToPx(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  switch (unit) {
    case "MM": return n * MM_TO_PX;
    case "Point": return n * PT_TO_PX;
    case "Pixel": return n;
    case "MapUnit":
    case "MetersInMapUnits":
    default: return n * MM_TO_PX * 0.3; // 近似: 実用サイズに収める
  }
}

// "5;2" のようなカスタムダッシュ(線幅単位)または線種名 → [onPx, offPx, ...]
export function dashPattern(styleName, customDash, widthPx) {
  if (customDash && /^\d/.test(String(customDash))) {
    const seg = String(customDash).split(";").map(v => Number(v) * widthPx).filter(v => v > 0);
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

// <Option name="effects"> のペイントエフェクトスタックを正規化する。
// 実装可能なもの: drawSource/blur/dropShadow/glow/innerGlow/innerShadow/
// colourize/transform。それ以外は呼び出し側で警告する
function parsePaintEffects(props) {
  const raw = props?.effects ?? props?.paintEffect ?? null;
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const out = [];
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
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "||"].includes(two)) { push("op", two); i += 2; continue; }
    if ("+-*/%=<>()".includes(ch)) { push(ch === "(" ? "lparen" : ch === ")" ? "rparen" : "op", ch); i++; continue; }
    if (ch === ",") { push("comma", ch); i++; continue; }
    if (/[A-Za-z_-￿]/.test(ch)) {
      let s = "";
      while (i < n && /[A-Za-z0-9_.$-￿]/.test(src[i])) s += src[i++];
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
  format_number: (v, dp = 0) => Number(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }),
  to_int: v => parseInt(v, 10) || 0, to_real: v => Number(v) || 0,
  to_string: v => String(v ?? ""), to_text: v => String(v ?? ""),
  coalesce: (...a) => a.find(v => v !== null && v !== undefined),
  if: (c, a, b) => (c ? a : b),
  is_layer_visible: name => {
    try { return layerVisibilityResolver ? !!layerVisibilityResolver(String(name ?? "")) : false; }
    catch (e) { return false; }
  },
  scale_linear: (v, a1, a2, b1, b2) => b1 + (Number(v) - a1) * (b2 - b1) / ((a2 - a1) || 1),
  scale_exp: (v, a1, a2, b1, b2) => b1 + (Number(v) - a1) * (b2 - b1) / ((a2 - a1) || 1),
  rand: (a = 0, b = 1) => a + Math.random() * (b - a),
  randf: (a = 0, b = 1) => a + Math.random() * (b - a),
  regexp_match: (s, re) => { try { const m = String(s ?? "").search(new RegExp(String(re))); return m < 0 ? 0 : m + 1; } catch (e) { return 0; } },
  now: () => new Date(),
  year: d => new Date(d).getFullYear(), month: d => new Date(d).getMonth() + 1, day: d => new Date(d).getDate(),
  hour: d => new Date(d).getHours(), minute: d => new Date(d).getMinutes(), second: d => new Date(d).getSeconds(),
  array: (...a) => a,
};

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
    case "field": return props?.[node.v];
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
      const fn = EXPR_FUNCS[node.name];
      if (!fn) return null;
      const args = node.args.map(a => evalAst(a, props));
      if (node.name === "attribute") return props?.[args[0]];
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
      effects: parsePaintEffects(props),
    });
  }
  layers.sort((a, b) => a.pass - b.pass);
  return {
    name: symbolEl.getAttribute("name") || "",
    geomType: symbolEl.getAttribute("type") || "", // marker|line|fill
    alpha: Number(symbolEl.getAttribute("alpha") ?? "1") || 1,
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
  const ctx = { symbols, warnings, legend };

  switch (type) {
    case "singleSymbol": {
      const name = [...symbols.keys()][0];
      if (name) legend.push({ label: "", symbolName: name });
      return { evaluate: () => (name ? [name] : []), ...ctx };
    }
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
          if (c.tagName === "rule") rule.children.push(parseRule(c));
        }
        return rule;
      };
      for (const c of rulesEl?.children || []) {
        if (c.tagName === "rule") rootRules.push(parseRule(c));
      }
      const matchRule = (rules, props, inheritedScale, depth = 0) => {
        if (depth > 16) return null;
        let elseRule = null;
        for (const rule of rules) {
          const scale = {
            min: rule.scaleMin || inheritedScale.min,
            max: rule.scaleMax || inheritedScale.max,
          };
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
        distancePx: sizeToPx(rendererEl.getAttribute("distance") ?? 2, rendererEl.getAttribute("distance_unit") || "MM") || 30,
        ringStyle: String(rendererEl.getAttribute("point_displacement_renderer") ?? ""),
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
      if (!image) {
        warnOnce(warnings, `${layer.cls} の画像を読めませんでした: ${pathKey}(円で代替)`);
        const fill = parseQgisColor(p.color, [0.2, 0.4, 0.9, 1]);
        return [{ kind: "shape", shape: "circle", sizePx, fill, stroke: null, strokeWidthPx: 0, rotationDeg: angle, offsetPx, alpha }];
      }
      return [{ kind: "image", image, sizePx, rotationDeg: angle, offsetPx, alpha }];
    }
    case "FontMarker":
    case "MdiFontMarker": {
      const chr = String(ddValue(dd, ["chr", "char"], props, p.chr ?? ""));
      const font = String(p.font || p.font_family || "sans-serif");
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
      // アニメーションマーカー(#108): 動画再生は未対応のため先頭フレーム(file)を静止表示
      const pathKey = String(p.name ?? p.file ?? "");
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
    default:
      warnOnce(warnings, `マーカーシンボル ${layer.cls} は未対応です(円で代替)`);
      return [{
        kind: "shape", shape: "circle", sizePx,
        fill: parseQgisColor(p.color, [0.2, 0.4, 0.9, 1]),
        stroke: null, strokeWidthPx: 0, rotationDeg: angle, offsetPx, alpha,
      }];
  }
}

function resolveLineLayer(layer, props, warnings, images = null) {
  const p = layer.props;
  const dd = layer.dd;
  const widthUnit = p.line_width_unit || "MM";
  switch (layer.cls) {
    case "SimpleLine": {
      const color = parseQgisColor(ddValue(dd, ["lineColor", "line_color", "color"], props, p.line_color), [0, 0, 0, 1]);
      const widthPx = sizeToPx(ddValue(dd, ["lineWidth", "line_width", "width"], props, p.line_width ?? 0.26), widthUnit);
      const custom = p.use_custom_dash === "1" || p.use_custom_dash === "true" ? p.customdash : null;
      const dash = dashPattern(ddValue(dd, ["lineStyle", "line_style"], props, p.line_style), custom, widthPx);
      if (dash === "none") return null;
      return {
        color, widthPx: Math.max(widthPx, 1), dash,
        // 結合部・端部・オフセット(2D エンジンで反映)
        join: { bevel: "bevel", miter: "miter", miter2: "miter", round: "round" }[String(p.joinstyle || "bevel").toLowerCase()] || "bevel",
        cap: { square: "square", flat: "butt", round: "round" }[String(p.capstyle || "square").toLowerCase()] || "butt",
        offsetPx: sizeToPx(p.offset ?? 0, p.offset_unit || "MM") || 0,
      };
    }
    case "InterpolatedLine": {
      // QGIS の補間ライン: 始点→終点で幅・色を線形補間する。spec.interp を
      // 持ち、対応エンジン(Cesium)では線分細分化で再現する(#108)
      const colorStart = parseQgisColor(ddValue(dd, ["startColor", "start_color"], props,
        p.start_color ?? p.color_start ?? p.single_color ?? p.line_color ?? p.color), [0, 0, 0, 1]);
      const colorEnd = parseQgisColor(ddValue(dd, ["endColor", "end_color"], props,
        p.end_color ?? p.color_end ?? p.start_color ?? p.color_start ?? p.line_color ?? p.color), colorStart);
      const wUnit = p.width_unit || widthUnit;
      const widthStartPx = Math.max(sizeToPx(ddValue(dd, ["widthStart", "width_start"], props,
        p.width_start ?? p.start_width ?? p.line_width_start ?? p.line_width ?? p.width ?? 0.26),
        p.width_start_unit || wUnit) || 0, 0.5);
      const widthEndPx = Math.max(sizeToPx(ddValue(dd, ["widthEnd", "width_end"], props,
        p.width_end ?? p.end_width ?? p.line_width_end ?? p.width_start ?? p.start_width ?? p.line_width ?? p.width ?? 0.26),
        p.width_end_unit || wUnit) || 0, 0.5);
      warnOnce(warnings, "InterpolatedLine は始点→終点の線形補間で近似です(未対応エンジンは単色)");
      // decor {kind:"interpolated"} は対応エンジン(Cesium)が弧長分割で
      // 幅・色補間を再現する契約。非対応エンジンは color/widthPx の単色線
      return {
        color: colorStart, widthPx: Math.max(widthStartPx, widthEndPx, 1), dash: null,
        decor: { kind: "interpolated", c1: colorStart, c2: colorEnd, w1: widthStartPx, w2: widthEndPx },
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
      let widthPx = sizeToPx(p.line_width ?? p.width ?? 0, widthUnit);
      if (!widthPx && layer.subSymbol) {
        // HashLine 等は刻みストロークがサブシンボル(SimpleLine)側にある
        for (const l of layer.subSymbol.layers || []) {
          const w = sizeToPx(l.props?.line_width ?? 0, l.props?.line_width_unit || "MM");
          if (w > 0) { widthPx = w; break; }
        }
      }
      // 装飾内容を保持し、対応エンジンで形状描画する(#54)
      const decor = buildLineDecor(layer, p, props, images, color, widthUnit);
      warnOnce(warnings, cls === "InterpolatedLine" ? "InterpolatedLine はセグメント分割で色・幅を補間した近似描画です" : `ラインシンボル ${layer.cls} は一部エンジンで単色近似です`);
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
function buildLineDecor(layer, p, props, images, color, widthUnit) {
  const cls = layer.cls;
  const intervalPx = sizeToPx(p.interval ?? p.repeat_distance ?? 3, p.interval_unit || p.repeat_distance_unit || "MM") || 0;
  const placement = String(p.placement || "interval").toLowerCase(); // interval|centralpoint|vertex|firstvertex|lastvertex|curvepoint
  if (cls === "MarkerLine") {
    const markers = layer.subSymbol
      ? layer.subSymbol.layers.flatMap(l => l.enabled ? resolveMarkerLayer(l, props, images, new Set()) : [])
      : [];
    return { kind: "markerline", intervalPx: intervalPx || sizeToPx(4, "MM"), placement, markers,
      rotateMarker: String(p.rotate_marker ?? "1") !== "0" };
  }
  if (cls === "HashLine" || cls === "HashedLine") {
    // 刻みの長さ・間隔・角度。QGIS 既定: 斜め 45 度の刻み
    const tick = layer.subSymbol?.layers?.find(l => l.enabled && l.props) || null;
    const tickLenPx = sizeToPx(p.hash_length ?? p.length ?? 1, p.hash_length_unit || "MM") || sizeToPx(1, "MM");
    const tickColor = parseQgisColor(tick?.props?.line_color ?? tick?.props?.color ?? color, [0, 0, 0, 1]);
    const tickWidthPx = sizeToPx(tick?.props?.line_width ?? p.line_width ?? 0.26, "MM") || 1;
    const hashAngle = Number(p.hash_angle ?? p.angle ?? 90);
    return { kind: "hashline", intervalPx: intervalPx || sizeToPx(2, "MM"),
      tick: { color: tickColor, widthPx: Math.max(tickWidthPx, 0.5), lengthPx: tickLenPx, angleDeg: hashAngle } };
  }
  if (cls === "InterpolatedLine") {
    // 始端→終端の色・幅補間(#108)。dd 指定も拾い、描画側がセグメント分割で近似する
    const dd = layer.dd || {};
    const wu = p.width_start_unit || p.line_width_unit || widthUnit;
    const c1 = parseQgisColor(ddValue(dd, ["color_start", "line_color"], props, p.start_color ?? p.line_color ?? p.color), [0, 0, 0, 1]);
    const c2 = parseQgisColor(ddValue(dd, ["color_end"], props, p.end_color ?? p.line_color_2 ?? p.color_2 ?? p.line_color ?? p.color), c1);
    const w1 = Math.max(sizeToPx(ddValue(dd, ["width_start"], props, p.width_start ?? p.line_width ?? 0.26), wu) || 1, 0.5);
    const w2 = Math.max(sizeToPx(ddValue(dd, ["width_end"], props, p.width_end ?? p.width_start ?? p.line_width ?? 0.26), p.width_end_unit || wu) || 1, 0.5);
    return { kind: "interpolated", c1, c2, w1, w2 };
  }
  if (cls === "ArrowLine") {
    return { kind: "arrowline", color: parseQgisColor(color, [0, 0, 0, 1]),
      headLenPx: sizeToPx(p.arrow_head_length ?? 2.5, "MM") || 9,
      headWidthPx: sizeToPx(p.arrow_head_width ?? 2.5, "MM") || 9,
      curved: String(p.curved_arrow ?? "0") === "1" };
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
      const fillStyle = String(ddValue(dd, ["fillStyle", "fill_style"], props, p.fill_style ?? "solid")).toLowerCase();
      const color = parseQgisColor(ddValue(dd, ["fillColor", "color"], props, p.color), [0.5, 0.5, 0.5, 1]);
      const spec = FILL_STYLES[fillStyle];
      if (spec === "none") return { solid: null };
      if (!spec) return { solid: color };
      return { hatch: { color, angles: spec.angles, spacingPx: spec.spacing * MM_TO_PX * 0.8 } };
    }
    case "LinePatternFill": {
      const color = parseQgisColor(ddValue(dd, ["lineColor", "color"], props, p.color), [0, 0, 0, 1]);
      const angle = Number(p.angle ?? 45);
      const distPx = sizeToPx(p.distance ?? 2, p.distance_unit || "MM") || 4;
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
    case "PointPatternFill":
    case "RandomMarkerFill": {
      const dx = Math.max(sizeToPx(p.distance_x ?? p.distance ?? 4, "MM"), 3);
      const dy = Math.max(sizeToPx(p.distance_y ?? p.distance ?? 4, "MM"), 3);
      const markers = layer.subSymbol
        ? layer.subSymbol.layers.flatMap(l => l.enabled ? resolveMarkerLayer(l, props, images, warnings) : [])
        : [{ kind: "shape", shape: "circle", sizePx: 2.5, fill: parseQgisColor(p.color, [0, 0, 0, 1]), stroke: null, strokeWidthPx: 0, rotationDeg: 0, offsetPx: [0, 0], alpha: 1 }];
      return { pointPattern: {
        markers, spacingX: dx, spacingY: dy,
        // 奇数列ごとのずらし(千鳥配置)と全体オフセット
        dispX: sizeToPx(p.displacement_x ?? 0, "MM"), dispY: sizeToPx(p.displacement_y ?? 0, "MM"),
        offX: sizeToPx(p.offset_x ?? 0, "MM"), offY: sizeToPx(p.offset_y ?? 0, "MM"),
        random: layer.cls === "RandomMarkerFill" && String(p.count_method ?? "0") !== "0",
      } };
    }
    case "SVGFill":
    case "RasterFill": {
      // QGIS4 は svgfile の代わりに name(参照名)/data(埋込内容)を使う
      const pathKey = String(p.svgfile ?? p.imageFile ?? p.file ?? p.name ?? "") ||
        (p.data && /^\s*(?:<\?xml|<svg|iVBOR|data:|base64,)/i.test(String(p.data))
          ? (String(p.data).trim().startsWith("<")
              ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(String(p.data))
              : /^iVBOR/.test(String(p.data).trim()) ? "data:image/png;base64," + String(p.data).trim() : String(p.data))
          : "");
      const image = images.get(pathKey) || null;
      if (!image) {
        warnOnce(warnings, `${layer.cls} の画像を読めませんでした: ${pathKey}(単色で代替)`);
        return { solid: parseQgisColor(p.color ?? p.svgFillColor, [0.5, 0.5, 0.5, 0.7]) };
      }
      const w = Math.max(sizeToPx(p.width ?? p.pattern_width ?? 4, "MM"), 4);
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
      const subType = String(p.symbolType ?? p.symbol_type ?? p.type ?? "").toLowerCase()
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
  if (!s || /^\$geometry$/i.test(s)) return geom;
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
    switch (symbol.geomType) {
      case "marker":
        markerLayers.push(...resolveMarkerLayer(layer, props, images, warnings).map(m => {
          if (m.gg) { (out.gg ||= []).push({ kind: "marker", ...m.gg }); return null; }
          return { ...m, blend: m.blend ?? layer.blend, effects: m.effects ?? layer.effects };
        }).filter(Boolean));
        break;
      case "line": {
        const r = resolveLineLayer(layer, props, warnings, images);
        if (r?.gg) { (out.gg ||= []).push({ kind: "line", ...r.gg }); break; }
        // 最後の有効レイヤ(最上位)を採用
        if (r) {
          lineCandidate = { ...r, blend: r.blend ?? layer.blend, effects: r.effects ?? layer.effects };
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
        const part = { ...r, blend: r.blend ?? layer.blend, effects: r.effects ?? layer.effects };
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

// <rendering> の属性を読む。settings 直下の <rendering> 要素
function parseLabelRendering(rd, warnings) {
  const g = name => rd?.getAttribute(name);
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
    obstacle: String(g("obstacle") ?? "1") === "1",
    obstacleFactor: Number(g("obstacleFactor") ?? 1) || 1,
    obstacleType: Number(g("obstacleType")) || 0,
    priority: Number(g("priority") ?? g("priorityLabel") ?? 5) || 0,
    zIndex: Number(g("zIndex")) || 0,
    displayAll: String(g("displayAll") ?? "0") === "1",
    allowDegraded: String(g("allowDegradedPlacement") ?? "0") === "1",
    // 新形式(QGIS 3.4x): 地物オプション側にも書かれる属性をここでも拾う
    fitInsidePolygon: String(g("fitInsidePolygon") ?? "0") === "1",
    labelPerPartFlag: String(g("labelPerPart") ?? "1") !== "0",
    multipartMode: String(g("multipartMode") || "").toLowerCase() || null,
    // QGIS 3.44+ の「重なったラベル」モード:
    // 0=重なりを禁止, 1=無条件で許可, 2=ペナルティなしで許可, 3=必要なら許可。
    // ペナルティ段階は近似として 1・2→displayAll、3→allowDegraded に写像する
    overlapMode: Number(g("overlapMode") ?? -1),
    unplacedVisibility: String(g("unplacedVisibility") ?? "0") === "1",
    wrapChar: g("multiLineWrapChar") || g("wrapChar") || "",
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
  if (out.obstacleType !== 0) warnOnce(warnings, "ラベル障害物タイプ(obstacleType)は地物bboxで近似です(衝突判定のあるエンジンのみ適用)");
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
    const px = Math.max(Math.round(sizePx ?? spec.sizePx), 6);
    const fam = family || spec.family;
    spec1.sizePx = sizeToPx(sizePx ?? (spec.sizePx / PT_TO_PX), "Point") || spec.sizePx;
    spec1.family = fam;
    spec1.bold = effBold; spec1.italic = effItalic;
    spec1.fontCss = `${effItalic ? "italic " : ""}${effBold ? "bold " : ""}${Math.max(Math.round(spec1.sizePx), 6)}px ${fam}`;
  }
  const color = parseQgisColor(get(["Color"]), null);
  if (color) spec1.fill = color;
  spec1.underline = bool(["Underline"], spec.underline);
  spec1.strikeout = bool(["Strikeout"], spec.strikeout);
  spec1.letterSpacingPx = num(["LetterSpacing", "FontLetterSpacing"], spec.letterSpacingPx);
  spec1.wordSpacingPx = num(["WordSpacing", "FontWordSpacing"], spec.wordSpacingPx);
  const hali = String(get(["Hali"]) || "").toLowerCase();
  if (["left", "center", "right", "justify"].includes(hali)) spec1.align = hali;
  const wrapChar = get(["MultiLineWrapChar"]);
  if (wrapChar !== undefined && wrapChar !== "") spec1.wrapChar = String(wrapChar);
  const mlh = Number(get(["MultiLineHeight"]));
  if (Number.isFinite(mlh) && mlh > 0) spec1.lineHeightFactor = mlh;
  const rot = Number(get(["Rotation", "RotationAngle", "LabelRotation"]));
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
      widthPx: Math.max(sizeToPx(bSize ?? (cur?.widthPx || 1) / MM_TO_PX, "MM"), 0),
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
  // 数値フォーマットの DD
  if (qgisBool(get(["NumFormat"]), !!spec.numFormat)) {
    spec1.numFormat = {
      decimals: num(["Decimals"], spec.numFormat?.decimals ?? 0),
      plusSign: bool(["PlusSign"], spec.numFormat?.plusSign ?? false),
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

function parseTextStyle(textStyleEl, settingsEl = null, warnings = new Set()) {
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
  const bufferSize = sizeToPx(b("bufferSize") ?? 1, b("bufferSizeUnit") || b("bufferSizeUnits") || "MM");
  if (bufEl) {
    if (b("bufferBlendMode") && String(b("bufferBlendMode")) !== "0") warnOnce(warnings, "バッファのブレンドモードは未対応です");
    if (bufferDraw && qgisBool(b("bufferNoFill"))) warnOnce(warnings, "bufferNoFill(内側を塗らない)は未対応です");
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
    // QML 実出力は fitInPolygonOnly(placement 属性)。旧名 fitInsidePolygon も拾う
    fitInsidePolygon: qgisBool(plA("fitInsidePolygon")) || qgisBool(plA("fitInPolygonOnly")),
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
  const r = parseLabelRendering(rd, warnings);

  // テキストマスク: 背景近似(マスク色=下層を覆う不透明色で再現)で対応。
  // 真のマスク(地物との抜き差し)はエンジン上できないため最も近い表現
  const maskEl = find("text-mask") || find("mask");
  let maskBg = null;
  if (maskEl && qgisBool(maskEl.getAttribute("maskEnabled") ?? maskEl.getAttribute("enabled"))) {
    const maskSize = sizeToPx(maskEl.getAttribute("maskSize") ?? maskEl.getAttribute("bufferSize") ?? 1, maskEl.getAttribute("maskSizeUnit") || "MM");
    const maskOpacity = Number(maskEl.getAttribute("maskOpacity") ?? 1);
    warnOnce(warnings, "ラベルマスクは不透明背景での近似です");
    maskBg = { type: "rect", fill: withAlpha(parseQgisColor(maskEl.getAttribute("maskColor") ?? "255,255,255,255", [1,1,1,1]), maskOpacity), stroke: null, strokeWidthPx: 0, padPx: [Math.max(maskSize, 1), Math.max(maskSize, 1)], offsetPx: [0,0], rotationDeg: 0 };
  }

  const spec = {
    getText: isExpr ? compileExpr(fieldName) : (props => props?.[fieldName]),
    sizePx,
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
    align: { 0: "left", 1: "center", 2: "right", 3: "justify" }[Number(a("multilineAlignment"))] || "left",
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

function compileLabeling(labelingEl, warnings) {
  if (!labelingEl) return null;
  const type = labelingEl.getAttribute("type") || "simple";
  if (type === "none") return null;
  if (type === "rule-based") {
    const rules = [];
    const rulesEl = [...labelingEl.children].find(c => c.tagName === "rules")
      || labelingEl.querySelector("rules");
    for (const ruleEl of rulesEl?.querySelectorAll?.(":scope > rule") || []) {
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
        style: parseTextStyle(textStyle, settingsEl, warnings),
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
  const style = parseTextStyle(textStyle, settingsEl, warnings);
  return props => finalizeLabelSpec(style, props);
}

// ---------------------------------------------------------------------------
// コンパイル済みスタイル
// ---------------------------------------------------------------------------

export function compileQmlStyle(xmlText, baseUrl, preloadedImages = new Map()) {
  const doc = new DOMParser().parseFromString(String(xmlText), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("QML の XML パースに失敗しました");
  const warnings = new Set();
  const rendererEl = doc.querySelector("renderer-v2");
  if (!rendererEl) throw new Error("QML に renderer-v2 がありません(シンボロジが含まれていません)");
  const renderer = compileRenderer(rendererEl, warnings);
  const diagram = parseDiagram(doc.documentElement, warnings);
  const labelingEl = doc.querySelector("labeling");
  const labelFn = compileLabeling(labelingEl, warnings);
  const images = preloadedImages;

  const evaluate = (props) => {
    const result = renderer.evaluate(props || {});
    // RuleBased は {names, scale}、その他は配列
    const names = Array.isArray(result) ? result : result.names;
    const scale = Array.isArray(result) ? null : result.scale;
    if (!names?.length) return null;
    const out = { markers: null, line: null, fillParts: null, outline: null, centroid: null, scale: null };
    if (scale && (scale.min > 1 || scale.max > 0)) {
      // 縮尺分母 → 概算カメラ距離(m)。表示中の地物はこの距離範囲でのみ描画する近似
      const toDist = s => (s > 0 ? s * 0.00028 * 900 / (2 * Math.tan(Math.PI / 6)) : 0);
      out.scale = { near: toDist(scale.min), far: scale.max > 0 ? toDist(scale.max) : Number.MAX_VALUE };
    }
    for (const name of names) {
      const symbol = renderer.symbols.get(name);
      if (!symbol) continue;
      const resolved = resolveSymbolLayers(symbol, props || {}, images, warnings);
      if (resolved.alpha !== undefined && resolved.alpha !== 1) {
        const mul = (c) => c ? withAlpha(c, resolved.alpha) : c;
        if (resolved.line) resolved.line.color = mul(resolved.line.color);
        if (resolved.fillParts) for (const pt of resolved.fillParts) { if (pt.solid) pt.solid = mul(pt.solid); }
        if (resolved.markers) for (const m of resolved.markers) m.alpha = (m.alpha ?? 1) * resolved.alpha;
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
      try { spec = resolveSymbolLayers(symbol, {}, images, warnings); } catch (err) { spec = null; }
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
    heatmap: renderer.heatmap || null,
    cluster: renderer.cluster || null,
    inverted: !!renderer.inverted,
    diagram,
    symbols: renderer.symbols,
    images,
    // 属性表示メタ。displayFor(props) は displayExpression を評価して
    // 地物の表示名を返す(未設定なら null)
    fields: hasFieldMeta ? fields : null,
    displayFor: displayFn ? (props => displayFn(props)) : null,
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
    opacity: Number(cat?.getAttribute("opacity") ?? 1) || 1,
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

// QML 内で参照される画像 URL を収集して事前ロードする
function collectImagePaths(el, acc) {
  if (!el) return;
  const cls = el.getAttribute?.("class");
  if (cls === "SvgMarker" || cls === "RasterMarker" || cls === "SVGFill" || cls === "RasterFill" || cls === "AnimatedMarker") {
    const props = optionMap(el);
    const key = String(props.name ?? props.imageFile ?? props.svgfile ?? props.file ?? "") ||
      (props.data ? "__inline__" : "");
    if (key) acc.add(key);
  }
  for (const c of el.children || []) collectImagePaths(c, acc);
}

export async function loadQmlStyle(url, fetchText) {
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

  return compileQmlStyle(text, url, images);
}

function findMarkerPropsForKey(el, key) {
  if (!el) return null;
  if (el.tagName === "layer") {
    const props = optionMap(el);
    if (String(props.name ?? props.imageFile ?? props.svgfile ?? props.file ?? "") === key) return props;
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
  ctx.rotate((layer.rotationDeg || 0) * Math.PI / 180);
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
