// where-eval.js — SQL WHERE サブセットのクライアント側評価器。
// geojson: 等の全件読み込み系ベクターレイヤーの where= オプションや
// view: 行の ;where= 指定を、読み込み済み GeoJSON の properties へ適用する。
// クエリ系(duckdb:/sql:/gpkg:)が SQL エンジンへ投げる式と同じ文法に揃え、
// 同一テキストがどちらの経路でも動くようにする。
//
// 対応文法:
//   比較      = == != <> < <= > >=   (両辺が数値なら数値比較、それ以外は文字列比較)
//   論理      AND OR NOT ・括弧
//   集合      x [NOT] IN (v1, v2, …)
//   範囲      x [NOT] BETWEEN a AND b
//   文字列    x [NOT] LIKE 'pat%'   (%=任意文字列、_=任意1文字、大小文字区別)
//             x [NOT] ILIKE 'pat%'  (大小文字を無視)
//   NULL      x IS [NOT] NULL
//   リテラル  '文字列'('' でエスケープ)、"識別子"("" でエスケープ)、
//             数値、TRUE/FALSE/NULL、裸の属性名(空白・演算子を含まない範囲。
//             日本語属性名もそのまま書ける)
//
// compileWhereExpression(text) → (props:object) => boolean を返す。
// 空文字列は全地物を通す述語。パース失敗は Error を投げる。

const KEYWORDS = new Set(["AND", "OR", "NOT", "IN", "LIKE", "ILIKE", "IS", "NULL", "TRUE", "FALSE", "BETWEEN"]);

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const src = String(text || "");
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(" || ch === ")" || ch === ",") { tokens.push({ t: ch }); i++; continue; }
    if (ch === "'") {
      let j = i + 1, buf = "";
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { buf += "'"; j += 2; continue; }
          j++; break;
        }
        buf += src[j]; j++;
      }
      if (j > src.length) throw new Error("where= の文字列リテラルが閉じていません");
      tokens.push({ t: "str", v: buf });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1, buf = "";
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { buf += '"'; j += 2; continue; }
          j++; break;
        }
        buf += src[j]; j++;
      }
      if (j > src.length) throw new Error("where= の識別子が閉じていません");
      tokens.push({ t: "ident", v: buf });
      i = j;
      continue;
    }
    // 比較演算子(2文字優先)
    const two = src.slice(i, i + 2);
    if (["!=", "<>", "<=", ">=", "=="].includes(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
    if (ch === "=" || ch === "<" || ch === ">") { tokens.push({ t: "op", v: ch }); i++; continue; }
    // 数値
    const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (numMatch) { tokens.push({ t: "num", v: Number(numMatch[0]) }); i += numMatch[0].length; continue; }
    // 裸の識別子/キーワード(区切り文字以外の連続)
    const identMatch = /^[^\s=<>!()"',;|]+/.exec(src.slice(i));
    if (identMatch) {
      const word = identMatch[0];
      const upper = word.toUpperCase();
      if (KEYWORDS.has(upper)) tokens.push({ t: "kw", v: upper });
      else tokens.push({ t: "ident", v: word });
      i += word.length;
      continue;
    }
    throw new Error(`where= の式を解釈できません(${i + 1} 文字目): ${src.slice(i, i + 10)}`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

// 属性名 → 値の取得。完全一致を優先し、無ければ大小文字を無視して探す
function lookup(props, name) {
  if (props == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(props)) {
    if (key.toLowerCase() === lower) return props[key];
  }
  return undefined;
}

function isNullish(v) { return v === null || v === undefined || v !== v; }

function toComparable(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return v.getTime();
  return v;
}

function compareValues(a, b, op) {
  const av = toComparable(a), bv = toComparable(b);
  const numeric = typeof av === "number" && typeof bv === "number"
    && !Number.isNaN(av) && !Number.isNaN(bv);
  const aNum = numeric ? av : Number(av);
  const bNum = numeric ? bv : Number(bv);
  const bothNumeric = numeric || (String(av).trim() !== "" && String(bv).trim() !== ""
    && Number.isFinite(aNum) && Number.isFinite(bNum) && typeof av !== "boolean" && typeof bv !== "boolean");
  let cmp;
  if (isNullish(av) || isNullish(bv)) cmp = NaN;
  else if (bothNumeric) cmp = Math.sign(Number(av) - Number(bv));
  else cmp = String(av).localeCompare(String(bv));
  switch (op) {
    case "=": case "==": return cmp === 0;
    case "!=": case "<>": return cmp !== 0;
    case "<": return cmp < 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case ">=": return cmp >= 0;
    default: return false;
  }
}

function likeToRegExp(pattern, ci) {
  const esc = String(pattern).replace(/[.*+^${}()|[\]\\?]/g, "\\$&")
    .replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${esc}$`, ci ? "i" : "");
}

// ---- パーサ(再帰下降) ----
class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(t, what) {
    const tok = this.next();
    if (tok.t !== t && !(t === "kw" && tok.v === what)) {
      throw new Error(`where= の式が不正です: ${what || t} が必要です`);
    }
    return tok;
  }
  kw(name) {
    const tok = this.peek();
    if (tok.t === "kw" && tok.v === name) { this.pos++; return true; }
    return false;
  }
  parse() {
    const node = this.parseOr();
    if (this.peek().t !== "eof") throw new Error("where= の式の末尾に余分な入力があります");
    return node;
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.kw("OR")) left = { k: "or", a: left, b: this.parseAnd() };
    return left;
  }
  parseAnd() {
    let left = this.parseUnary();
    while (this.kw("AND")) left = { k: "and", a: left, b: this.parseUnary() };
    return left;
  }
  parseUnary() {
    if (this.kw("NOT")) return { k: "not", a: this.parseUnary() };
    return this.parsePredicate();
  }
  parsePredicate() {
    const tok = this.peek();
    if (tok.t === "(") {
      this.next();
      const node = this.parseOr();
      this.expect(")");
      return node;
    }
    const left = this.parseOperand();
    // IS [NOT] NULL
    if (this.kw("IS")) {
      const negate = this.kw("NOT");
      this.expect("kw", "NULL");
      return { k: "isnull", a: left, neg: negate };
    }
    // [NOT] IN / BETWEEN / LIKE / ILIKE
    const negate = this.kw("NOT");
    if (this.kw("IN")) {
      this.expect("(");
      const values = [];
      for (;;) {
        values.push(this.parseOperand());
        const sep = this.next();
        if (sep.t === ")") break;
        if (sep.t !== ",") throw new Error("where= の IN リストが不正です");
      }
      return { k: "in", a: left, values, neg: negate };
    }
    if (this.kw("BETWEEN")) {
      const lo = this.parseOperand();
      this.expect("kw", "AND");
      const hi = this.parseOperand();
      return { k: "between", a: left, lo, hi, neg: negate };
    }
    if (this.kw("LIKE") || this.kw("ILIKE")) {
      const ci = this.tokens[this.pos - 1].v === "ILIKE";
      const pat = this.parseOperand();
      return { k: "like", a: left, pattern: pat, ci, neg: negate };
    }
    if (negate) return { k: "not", a: this.parseComparisonAfter(left) };
    return this.parseComparisonAfter(left);
  }
  // operand の後に来る比較(= expr / expr)。右辺が無い裸の operand は真偽値として評価
  parseComparisonAfter(left) {
    const tok = this.peek();
    if (tok.t === "op") {
      this.next();
      return { k: "cmp", a: left, op: tok.v, b: this.parseOperand() };
    }
    return { k: "truthy", a: left };
  }
  parseOperand() {
    const tok = this.next();
    if (tok.t === "ident") return { k: "ident", name: tok.v };
    if (tok.t === "str") return { k: "lit", v: tok.v };
    if (tok.t === "num") return { k: "lit", v: tok.v };
    if (tok.t === "kw") {
      if (tok.v === "TRUE") return { k: "lit", v: true };
      if (tok.v === "FALSE") return { k: "lit", v: false };
      if (tok.v === "NULL") return { k: "lit", v: null };
      // AND/OR 等を属性名として使うケースは想定外だが、識別子フォールバックはしない
      throw new Error(`where= の式が不正です: ${tok.v} の位置に値が必要です`);
    }
    throw new Error("where= の式が不正です: 値または属性名が必要です");
  }
}

function evalNode(node, props) {
  switch (node.k) {
    case "and": return evalNode(node.a, props) && evalNode(node.b, props);
    case "or": return evalNode(node.a, props) || evalNode(node.b, props);
    case "not": return !evalNode(node.a, props);
    case "truthy": {
      const v = evalOperand(node.a, props);
      return isNullish(v) ? false : !!v && v !== "false";
    }
    case "cmp": return compareValues(evalOperand(node.a, props), evalOperand(node.b, props), node.op);
    case "isnull": {
      const r = isNullish(evalOperand(node.a, props));
      return node.neg ? !r : r;
    }
    case "in": {
      const v = evalOperand(node.a, props);
      const hit = node.values.some(o => compareValues(v, evalOperand(o, props), "="));
      return node.neg ? !hit : hit;
    }
    case "between": {
      const v = evalOperand(node.a, props);
      const ok = compareValues(v, evalOperand(node.lo, props), ">=") && compareValues(v, evalOperand(node.hi, props), "<=");
      return node.neg ? !ok : ok;
    }
    case "like": {
      const v = evalOperand(node.a, props);
      const pat = evalOperand(node.pattern, props);
      const hit = !isNullish(v) && likeToRegExp(pat, node.ci).test(String(v));
      return node.neg ? !hit : hit;
    }
    default: return false;
  }
}

function evalOperand(node, props) {
  if (node.k === "lit") return node.v;
  if (node.k === "ident") return lookup(props, node.name);
  return undefined;
}

// where= 式テキスト → 地物 properties を受け取る述語関数。
// 空/空白のみの入力は常に true を返す述語。パース失敗時は Error を投げる
export function compileWhereExpression(text) {
  const src = String(text || "").trim();
  if (!src) return () => true;
  const ast = new Parser(tokenize(src)).parse();
  return props => {
    try { return !!evalNode(ast, props || {}); }
    catch { return false; }
  };
}

// GeoJSON FeatureCollection へ where= 式を適用した浅いコピーを返す。
// 式が空・全件一致なら元オブジェクトをそのまま返す。パース失敗は例外
export function filterGeoJsonByWhere(source, whereText) {
  const pred = compileWhereExpression(whereText);
  const features = source?.features;
  if (!Array.isArray(features) || !features.length) return source;
  const kept = features.filter(f => pred(f?.properties || {}));
  return kept.length === features.length ? source : { ...source, features: kept };
}
