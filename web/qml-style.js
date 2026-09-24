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

function toCesiumColor(rgba) {
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
function dashPattern(styleName, customDash, widthPx) {
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

// <data_defined_properties> → { propName: {active, expression, field, type} }
function parseDataDefined(symbolOrLayerEl) {
  const container = [...(symbolOrLayerEl?.children || [])].find(c => c.tagName === "data_defined_properties");
  const map = optionMap(container);
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
        if (value === "" || value == null) elseSymbol = symbolName || elseSymbol;
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
    case "RuleBased": {
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
      // マスク描画は再現できないため、外側シンボルで全地物を描く近似
      const name = [...symbols.keys()][0];
      warnOnce(warnings, "invertedPolygonRenderer は近似描画です(外側シンボルを全面適用)");
      return { evaluate: () => (name ? [name] : []), ...ctx };
    }
    case "heatmapRenderer":
      warnOnce(warnings, `レンダラ ${type} には未対応です(既定スタイルで描画)`);
      return { evaluate: () => [], ...ctx, unsupported: true };
    default: {
      // mergedFeatureRenderer / pointCluster / pointDisplacement / embedded 等の
      // ラッパー系は内側の renderer-v2 に委譲する
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

// 画像の遅延ロード管理(コンパイル時に収集した URL を一括ロードする)
function resolveResourceUrl(path, baseUrl) {
  const s = String(path || "").trim();
  if (!s) return null;
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  // Windows/Unix の絶対パスはブラウザから読めないためベース名で相対解決を試みる
  if (/^([a-z]:[\\/]|\\\\|\/)/i.test(s)) {
    const base = s.split(/[\\/]/).pop();
    try { return new URL(base, baseUrl).href; } catch (e) { return null; }
  }
  try { return new URL(s, baseUrl).href; } catch (e) { return s; }
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

function rgbaToCss(rgba) {
  const [r, g, b, a] = rgba.map(v => Math.round(v * 255));
  return a >= 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(rgba[3]).toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// マーカー/ライン/塗りつぶしレイヤの正規化(DD 適用済みの「描ける形」)
// ---------------------------------------------------------------------------

function resolveMarkerLayer(layer, props, images, warnings) {
  const p = layer.props;
  const dd = layer.dd;
  const sizeUnit = p.size_unit || "MM";
  const sizePx = sizeToPx(ddValue(dd, ["size"], props, p.size ?? 2), sizeUnit);
  const angle = Number(ddValue(dd, ["angle"], props, p.angle ?? 0)) || 0;
  const offset = String(ddValue(dd, ["offset"], props, p.offset ?? "0,0")).split(",").map(Number);
  const alpha = 1;

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
        offsetPx: [offset[0] * MM_TO_PX || 0, -(offset[1] * MM_TO_PX || 0)],
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
        rotationDeg: angle, offsetPx: [0, 0], alpha,
      }];
    }
    case "SvgMarker":
    case "RasterMarker": {
      const pathKey = String(p.name ?? p.imageFile ?? p.path ?? "");
      const image = images.get(pathKey) || null;
      if (!image) {
        warnOnce(warnings, `${layer.cls} の画像を読めませんでした: ${pathKey}(円で代替)`);
        const fill = parseQgisColor(p.color, [0.2, 0.4, 0.9, 1]);
        return [{ kind: "shape", shape: "circle", sizePx, fill, stroke: null, strokeWidthPx: 0, rotationDeg: angle, offsetPx: [0, 0], alpha }];
      }
      return [{ kind: "image", image, sizePx, rotationDeg: angle, offsetPx: [0, 0], alpha }];
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
        rotationDeg: angle, offsetPx: [0, 0], alpha,
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
        stroke, strokeWidthPx: strokeWidth, rotationDeg: angle, offsetPx: [0, 0], alpha,
      }];
    }
    case "GeometryGenerator":
      warnOnce(warnings, "GeometryGenerator マーカーは未対応です(スキップ)");
      return [];
    default:
      warnOnce(warnings, `マーカーシンボル ${layer.cls} は未対応です(円で代替)`);
      return [{
        kind: "shape", shape: "circle", sizePx,
        fill: parseQgisColor(p.color, [0.2, 0.4, 0.9, 1]),
        stroke: null, strokeWidthPx: 0, rotationDeg: angle, offsetPx: [0, 0], alpha,
      }];
  }
}

function resolveLineLayer(layer, props, warnings) {
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
      return { color, widthPx: Math.max(widthPx, 1), dash };
    }
    case "MarkerLine":
    case "HashedLine":
    case "InterpolatedLine":
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
      const widthPx = Math.max(sizeToPx(p.line_width ?? p.width ?? 0.26, widthUnit), 1);
      warnOnce(warnings, `ラインシンボル ${layer.cls} は単色ラインに近似しています`);
      return { color: color || [0, 0, 0, 1], widthPx, dash: null };
    }
    case "GeometryGenerator":
      warnOnce(warnings, "GeometryGenerator ラインは未対応です(スキップ)");
      return null;
    default:
      warnOnce(warnings, `ラインシンボル ${layer.cls} は未対応です`);
      return { color: parseQgisColor(p.line_color ?? p.color, [0, 0, 0, 1]), widthPx: 1, dash: null };
  }
}

function resolveMarkerLayerForLine(symbol, props) {
  for (const l of symbol?.layers || []) {
    const c = parseQgisColor(l.props?.color, null);
    if (c) return c;
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
          const r = resolveLineLayer(l, props, warnings);
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
      return { pointPattern: { markers, spacingX: dx, spacingY: dy } };
    }
    case "SVGFill":
    case "RasterFill": {
      const pathKey = String(p.svgfile ?? p.imageFile ?? p.file ?? "");
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
    case "GeometryGenerator":
      warnOnce(warnings, "GeometryGenerator 塗りつぶしは未対応です(スキップ)");
      return {};
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
function resolveSymbolLayers(symbol, props, images, warnings) {
  const out = { markers: null, line: null, fillParts: null, outline: null, centroid: null, alpha: symbol.alpha };
  const markerLayers = [];
  const fillParts = [];
  let outline = null;
  let centroid = null;
  let lineCandidate = null;

  for (const layer of symbol.layers) {
    if (!layer.enabled) continue;
    switch (symbol.geomType) {
      case "marker":
        markerLayers.push(...resolveMarkerLayer(layer, props, images, warnings));
        break;
      case "line": {
        const r = resolveLineLayer(layer, props, warnings);
        if (r) lineCandidate = r; // 最後の有効レイヤ(最上位)を採用
        break;
      }
      case "fill": {
        const r = resolveFillLayer(layer, props, images, warnings);
        if (!r) break;
        if (r.centroid) { centroid = r.centroid; break; }
        const o = resolveOutline(layer, props, warnings);
        if (o) outline = o;
        if (r.solid !== undefined && r.solid !== null) fillParts.push(r);
        else if (r.solid === null) fillParts.push({ solid: null });
        else fillParts.push(r);
        break;
      }
    }
  }
  if (symbol.geomType === "marker" && markerLayers.length) out.markers = markerLayers;
  if (symbol.geomType === "line" && lineCandidate) out.line = lineCandidate;
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

function parseTextStyle(textStyleEl) {
  const a = name => textStyleEl?.getAttribute(name);
  const isExpr = String(a("isExpression") ?? "0") === "1" || String(a("isExpression")).toLowerCase() === "true";
  const fieldName = a("fieldName") || "";
  const sizeUnit = a("fontSizeUnit") || "Point";
  const fontSize = Number(a("fontSize")) || 10;
  const sizePx = sizeUnit === "MM" ? fontSize * MM_TO_PX : fontSize * PT_TO_PX;
  const textColor = parseQgisColor(a("textColor") || a("namedColor"), [0, 0, 0, 1]);
  const textOpacity = Number(a("textOpacity") ?? "1");
  const bufferDraw = String(a("bufferDraw") ?? "0") === "1" || String(a("bufferDraw")).toLowerCase() === "true";
  const bufferColor = parseQgisColor(a("bufferColor"), [1, 1, 1, 1]);
  const bufferSize = sizeToPx(a("bufferSize") ?? 1, a("bufferSizeUnit") || "MM");
  const bold = String(a("fontBold") ?? "0") === "1" || String(a("fontBold")).toLowerCase() === "true";
  const italic = String(a("fontItalic") ?? "0") === "1" || String(a("fontItalic")).toLowerCase() === "true";
  const family = a("fontFamily") || "sans-serif";
  return {
    getText: isExpr ? compileExpr(fieldName) : (props => props?.[fieldName]),
    sizePx,
    fontCss: `${italic ? "italic " : ""}${bold ? "bold " : ""}${Math.max(Math.round(sizePx), 6)}px ${family}`,
    fill: withAlpha(textColor, Number.isFinite(textOpacity) ? textOpacity : 1),
    halo: bufferDraw ? { color: bufferColor, widthPx: Math.max(bufferSize, 1) } : null,
  };
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
      const settings = ruleEl.querySelector("settings text-style") || ruleEl.querySelector("text-style");
      if (!settings) continue;
      rules.push({ fn: filter && !/^ELSE$/i.test(filter) ? compileExpr(filter) : null, isElse: /^ELSE$/i.test(String(filter || "")), style: parseTextStyle(settings) });
    }
    if (!rules.length) return null;
    return props => {
      let elseStyle = null;
      for (const r of rules) {
        if (r.isElse) { elseStyle = r.style; continue; }
        if (!r.fn || r.fn(props)) return r.style;
      }
      return elseStyle;
    };
  }
  // simple / perimeter 等は text-style をそのまま使う
  const textStyle = labelingEl.querySelector("text-style");
  if (!textStyle) return null;
  const style = parseTextStyle(textStyle);
  if (!style.getText) return null;
  return () => style;
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
      if (resolved.fillParts && !out.fillParts) out.fillParts = resolved.fillParts;
      if (resolved.outline && !out.outline) out.outline = resolved.outline;
      if (resolved.centroid && !out.centroid) out.centroid = resolved.centroid;
    }
    return out;
  };

  const legend = renderer.legend.map(e => {
    const symbol = renderer.symbols.get(e.symbolName);
    let spec = null;
    if (symbol) {
      try { spec = resolveSymbolLayers(symbol, {}, images, warnings); } catch (err) { spec = null; }
    }
    return { label: e.label, spec };
  });

  return {
    evaluate,
    labelFor: labelFn ? (props => labelFn(props)) : null,
    legend,
    warnings: [...warnings],
    unsupported: !!renderer.unsupported,
    symbols: renderer.symbols,
    images,
  };
}

// QML 内で参照される画像 URL を収集して事前ロードする
function collectImagePaths(el, acc) {
  if (!el) return;
  const cls = el.getAttribute?.("class");
  if (cls === "SvgMarker" || cls === "RasterMarker" || cls === "SVGFill" || cls === "RasterFill") {
    const props = optionMap(el);
    const key = String(props.name ?? props.imageFile ?? props.svgfile ?? props.file ?? "");
    if (key) acc.add(key);
  }
  for (const c of el.children || []) collectImagePaths(c, acc);
}

export async function loadQmlStyle(url, fetchText) {
  const text = await fetchText(url);
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

// マーカーレイヤ群を1枚の canvas に合成する。返り値 {canvas, anchorY}
export function markerLayersToCanvas(markerLayers) {
  const maxSize = Math.max(...markerLayers.map(m => m.sizePx || m.widthPx || 8), 4);
  const pad = Math.max(...markerLayers.map(m => (m.strokeWidthPx || 0) + 2), 2);
  const size = maxSize + pad * 2;
  const key = `mk:${JSON.stringify(markerLayers.map(m => ({ ...m, image: m.image ? (m.image.src || "img") : undefined })))}`;
  const canvas = getCanvas(key, size, (ctx, W) => {
    for (const layer of markerLayers) {
      ctx.save();
      ctx.translate(W / 2 + (layer.offsetPx?.[0] || 0), W / 2 + (layer.offsetPx?.[1] || 0));
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
      if (pt.hatch) {
        drawHatch(ctx, W, pt.hatch.angles, pt.hatch.spacingPx, pt.hatch.color);
      } else if (pt.linePattern) {
        drawHatch(ctx, W, [pt.linePattern.angleDeg], pt.linePattern.spacingPx, pt.linePattern.color, pt.linePattern.widthPx);
      } else if (pt.pointPattern) {
        const { markers, spacingX, spacingY } = pt.pointPattern;
        const stamp = markerLayersToCanvas(markers);
        const stepX = Math.max(spacingX, 4), stepY = Math.max(spacingY, 4);
        for (let y = 0; y < W + stepY; y += stepY) {
          for (let x = 0; x < W + stepX; x += stepX) {
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
    }
  });
  return { solidBase, tile: canvas, tileMeters: tilePx * METERS_PER_PX };
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

// ---------------------------------------------------------------------------
// Cesium への適用
// ---------------------------------------------------------------------------

function entityFeatureProps(entity, time) {
  try {
    const p = entity.properties;
    return p?.getValue ? (p.getValue(time) || {}) : (p || {});
  } catch (e) {
    return {};
  }
}

function entityCentroid(entity, time) {
  try {
    const hierarchy = entity.polygon?.hierarchy?.getValue?.(time);
    const positions = hierarchy?.positions || entity.polyline?.positions?.getValue?.(time);
    if (!positions?.length) return null;
    const sum = positions.reduce((acc, p) => Cesium.Cartesian3.add(acc, p, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    return Cesium.Cartesian3.divideByScalar(sum, positions.length, new Cesium.Cartesian3());
  } catch (e) {
    return null;
  }
}

// polyline 用の破線マテリアル。[on,off]px → 16bit パターン
function dashMaterialProperty(color, dash) {
  if (!dash?.length) return new Cesium.ColorMaterialProperty(toCesiumColor(color));
  const total = dash.reduce((a, b) => a + b, 0);
  let pattern = 0;
  for (let i = 0; i < 16; i++) {
    const t = ((i + 0.5) / 16) * total;
    let acc = 0, on = true;
    for (let j = 0; j < dash.length; j++) {
      if (t < acc + dash[j]) { on = j % 2 === 0; break; }
      acc += dash[j];
    }
    if (on) pattern |= (1 << (15 - i));
  }
  if (!pattern) pattern = 0xffff;
  return new Cesium.PolylineDashMaterialProperty({ color: toCesiumColor(color), dashPattern: pattern, dashLength: total });
}

// エンティティ(entity 描画経路)にコンパイル済みスタイルを適用する。
// clamp: 地形ドレープ中か(ドレープ時はポリゴンのアウトラインが描かれないため
// 周線を別途 polyline で引く)
export function applyQmlStyleToDataSource(ds, style, { clamp = false, time = null } = {}) {
  if (!style) return;
  const t = time || Cesium.JulianDate.now();
  for (const entity of ds.entities.values) {
    const props = entityFeatureProps(entity, t);
    const spec = style.evaluate(props);
    const hasPoint = !!entity.billboard;
    const hasLine = !!entity.polyline;
    const hasFill = !!entity.polygon;

    if (!spec) {
      if (entity.billboard) entity.billboard.show = new Cesium.ConstantProperty(false);
      if (entity.polyline) entity.polyline.show = new Cesium.ConstantProperty(false);
      if (entity.polygon) entity.polygon.show = new Cesium.ConstantProperty(false);
      continue;
    }

    const ddc = spec.scale ? new Cesium.DistanceDisplayCondition(spec.scale.near, spec.scale.far) : null;

    // ポイント → billboard(canvas 合成アイコン)
    if (hasPoint) {
      if (spec.markers?.length) {
        const canvas = markerLayersToCanvas(spec.markers);
        entity.billboard.image = new Cesium.ConstantProperty(canvas);
        entity.billboard.scale = new Cesium.ConstantProperty(1);
        entity.billboard.verticalOrigin = new Cesium.ConstantProperty(Cesium.VerticalOrigin.CENTER);
        entity.billboard.horizontalOrigin = new Cesium.ConstantProperty(Cesium.HorizontalOrigin.CENTER);
        const rot = spec.markers[0]?.rotationDeg || 0;
        if (rot) entity.billboard.rotation = new Cesium.ConstantProperty(-rot * Math.PI / 180);
        if (ddc) entity.billboard.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      } else {
        entity.billboard.show = new Cesium.ConstantProperty(false);
      }
    }

    // ライン
    if (hasLine) {
      if (spec.line) {
        entity.polyline.material = dashMaterialProperty(spec.line.color, spec.line.dash);
        entity.polyline.width = new Cesium.ConstantProperty(spec.line.widthPx);
        if (ddc) entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      } else {
        entity.polyline.show = new Cesium.ConstantProperty(false);
      }
    }

    // ポリゴン
    if (hasFill) {
      if (spec.fillParts?.length) {
        const { solidBase, tile, tileMeters } = fillPartsToTile(spec.fillParts);
        if (tile) {
          const repeat = computeFillRepeat(entity, t, tileMeters);
          entity.polygon.material = new Cesium.ImageMaterialProperty({ image: tile, repeat, transparent: true });
        } else if (solidBase) {
          entity.polygon.material = new Cesium.ColorMaterialProperty(toCesiumColor(solidBase));
        } else {
          entity.polygon.material = new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT);
        }
        if (ddc) entity.polygon.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      } else {
        entity.polygon.show = new Cesium.ConstantProperty(false);
      }
      // アウトライン: ドレープ時は polygon.outline が効かないため polyline で引く。
      // ただし entity が元から polyline を持つ(GeometryCollection)場合は上書きしない
      if (spec.outline) {
        const ring = outlinePositions(entity, t);
        if (hasLine) {
          entity.polygon.outline = new Cesium.ConstantProperty(true);
          entity.polygon.outlineColor = new Cesium.ConstantProperty(toCesiumColor(spec.outline.color));
        } else if (ring?.length) {
          if (!entity.polyline) entity.polyline = new Cesium.PolylineGraphics();
          entity.polyline.show = new Cesium.ConstantProperty(true);
          entity.polyline.positions = new Cesium.ConstantProperty(ring.concat([ring[0]]));
          entity.polyline.width = new Cesium.ConstantProperty(spec.outline.widthPx);
          entity.polyline.material = dashMaterialProperty(spec.outline.color, spec.outline.dash);
          entity.polyline.clampToGround = new Cesium.ConstantProperty(clamp);
          entity.polyline.arcType = new Cesium.ConstantProperty(Cesium.ArcType.GEODESIC);
          if (clamp) {
            entity.polyline.classificationType = entity.polygon.classificationType;
          }
          if (ddc) entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
        } else {
          entity.polygon.outline = new Cesium.ConstantProperty(true);
          entity.polygon.outlineColor = new Cesium.ConstantProperty(toCesiumColor(spec.outline.color));
        }
      } else if (spec.fillParts?.length) {
        entity.polygon.outline = new Cesium.ConstantProperty(false);
      }
      // 重心マーカー(CentroidFill)
      if (spec.centroid?.length) {
        const center = entityCentroid(entity, t);
        if (center) {
          entity.position = new Cesium.ConstantPositionProperty(center);
          if (!entity.billboard) entity.billboard = new Cesium.BillboardGraphics();
          const canvas = markerLayersToCanvas(spec.centroid);
          entity.billboard.image = new Cesium.ConstantProperty(canvas);
          entity.billboard.verticalOrigin = new Cesium.ConstantProperty(Cesium.VerticalOrigin.CENTER);
          entity.billboard.horizontalOrigin = new Cesium.ConstantProperty(Cesium.HorizontalOrigin.CENTER);
        }
      }
    }

    // ラベル
    if (style.labelFor) {
      const labelSpec = style.labelFor(props);
      const text = labelSpec ? String(labelSpec.getText?.(props) ?? "") : "";
      if (labelSpec && text) {
        if (!entity.position && (hasLine || hasFill)) {
          const center = entityCentroid(entity, t);
          if (center) entity.position = new Cesium.ConstantPositionProperty(center);
        }
        entity.label = new Cesium.LabelGraphics({
          text,
          font: labelSpec.fontCss,
          fillColor: toCesiumColor(labelSpec.fill),
          outlineColor: labelSpec.halo ? toCesiumColor(labelSpec.halo.color) : Cesium.Color.BLACK,
          outlineWidth: labelSpec.halo ? labelSpec.halo.widthPx : 0,
          style: labelSpec.halo ? Cesium.LabelStyle.FILL_AND_OUTLINE : Cesium.LabelStyle.FILL,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: hasPoint ? new Cesium.Cartesian2(0, -12) : new Cesium.Cartesian2(0, 0),
        });
        if (ddc) entity.label.distanceDisplayCondition = new Cesium.ConstantProperty(ddc);
      }
    }
  }
}

function outlinePositions(entity, time) {
  try {
    const h = entity.polygon?.hierarchy?.getValue?.(time);
    return h?.positions || null;
  } catch (e) {
    return null;
  }
}

// パターンタイルの実寸(概算)からポリゴンの bbox に対する repeat を計算する
function computeFillRepeat(entity, time, tileMeters) {
  const def = new Cesium.Cartesian2(1, 1);
  if (!tileMeters || tileMeters <= 0) return def;
  try {
    const h = entity.polygon?.hierarchy?.getValue?.(time);
    const positions = h?.positions;
    if (!positions?.length) return def;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const p of positions) {
      const c = Cesium.Cartographic.fromCartesian(p);
      const lon = c.longitude, lat = c.latitude;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const midLat = (minLat + maxLat) / 2;
    const mPerDegX = 111320 * Math.cos(midLat);
    const mPerDegY = 110540;
    const wM = Math.max((maxLon - minLon) * mPerDegX, tileMeters);
    const hM = Math.max((maxLat - minLat) * mPerDegY, tileMeters);
    return new Cesium.Cartesian2(Math.max(wM / tileMeters, 1), Math.max(hM / tileMeters, 1));
  } catch (e) {
    return def;
  }
}

// GeoJsonPrimitive(バッチ描画経路)にスタイルを適用する。
// Buffer 系は featureId 単位で setMaterial できる。シェイプ・破線・パターンは
// 表現できないため色・サイズ・線幅の対応のみ(フォールバック)
export function applyQmlStyleToPrimitive(primitive, style) {
  if (!style || !primitive) return;
  const materialCache = new Map();
  const matFor = (kind, spec) => {
    const key = kind + JSON.stringify(spec);
    let m = materialCache.get(key);
    if (!m) {
      if (kind === "point") {
        const mk = spec.markers?.[0];
        m = new Cesium.BufferPointMaterial({
          color: toCesiumColor(mk?.fill || [0.2, 0.4, 0.9, 1]),
          size: Math.max(mk?.sizePx || 6, 2),
          outlineColor: toCesiumColor(mk?.stroke || [0, 0, 0, 1]),
          outlineWidth: mk?.stroke ? Math.max(mk.strokeWidthPx || 1, 1) : 0,
        });
      } else if (kind === "line") {
        m = new Cesium.BufferPolylineMaterial({
          color: toCesiumColor(spec.line?.color || [0, 0, 0, 1]),
          width: Math.max(spec.line?.widthPx || 1, 1),
        });
      } else {
        const solids = (spec.fillParts || []).filter(pt => pt.solid);
        const base = solids.length ? solids[solids.length - 1].solid : [0.5, 0.5, 0.5, 0.7];
        m = new Cesium.BufferPolygonMaterial({
          color: toCesiumColor(base),
          outlineColor: toCesiumColor(spec.outline?.color || base),
          outlineWidth: spec.outline ? Math.max(spec.outline.widthPx || 1, 1) : 0,
        });
      }
      materialCache.set(key, m);
    }
    return m;
  };

  const applyTo = (collection, ctor, kind, pick) => {
    if (!collection) return;
    const scratch = new ctor();
    for (let i = 0; i < collection.primitiveCount; i++) {
      collection.get(i, scratch);
      const props = primitive.getProperties(scratch.featureId) || {};
      const spec = style.evaluate(props);
      if (!spec || !pick(spec)) {
        scratch.setMaterial(transparentMaterial(kind));
        continue;
      }
      scratch.setMaterial(matFor(kind, spec));
    }
  };

  applyTo(primitive.points, Cesium.BufferPoint, "point", s => s.markers?.length);
  applyTo(primitive.polylines, Cesium.BufferPolyline, "line", s => !!s.line);
  applyTo(primitive.polygons, Cesium.BufferPolygon, "fill", s => !!s.fillParts?.length);
}

function transparentMaterial(kind) {
  const t = new Cesium.Color(0, 0, 0, 0);
  if (kind === "point") return new Cesium.BufferPointMaterial({ color: t, size: 1 });
  if (kind === "line") return new Cesium.BufferPolylineMaterial({ color: t, width: 1 });
  return new Cesium.BufferPolygonMaterial({ color: t });
}
