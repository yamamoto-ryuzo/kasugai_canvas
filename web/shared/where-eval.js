// where-eval.js — OGR SQL (WHERE句) 準拠のクライアント側評価器。
// geojson: 等の全件読み込み系ベクターレイヤーの where= オプションや
// view: 行の ;where= 指定を、読み込み済み GeoJSON 地物へ適用する。
// QGIS レイヤーフィルタ(subsetString)の OGR SQL で表現可能な式を
// そのまま解釈できることを目標とする(出典: gdal.org/user/ogr_sql_dialect.html)。
//
// 対応文法(OGR SQL WHERE 句):
//   式        <式> = <リテラル> | <識別子> | <疑似フィールド> | <関数>() |
//             <式> <算術> <式> | ( <式> )   ※再帰
//   比較      = != <> < <= > >=   (=,!=,<> は文字列大小区別なし。<,<=,>,>= は区別。
//             両辺が数値解釈可能なら数値比較、それ以外は文字列比較)
//   論理      AND OR NOT ・括弧   (否定は単項 NOT のみ。x NOT IN 等の中置形は
//             仕様書未記載のため非対応)
//   集合      <式> IN (v1, v2, …)          (= 準拠の大小区別なし照合)
//   範囲      <式> BETWEEN a AND b         (>= AND <= 等価 = 大小区別あり)
//   文字列    <式> LIKE|ILIKE 'pat%' [ESCAPE 'c']  (%=任意文字列、_=任意1文字。
//             LIKE=大小区別(GDAL>=3.1)・ILIKE=非区別)
//   NULL      <式> IS [NOT] NULL           (NULL リテラル自体は文法に無い)
//   算術      + - * / ・単項 - ・|| (文字列連結。NULL を含むと NULL)
//   関数      SUBSTR(s,start[,len]) CAST(x AS type) CONCAT(...) hstore_get_value(h,k)
//   リテラル  '文字列'('' でエスケープ)、"識別子"("" でエスケープ)、数値、
//             裸の属性名([A-Za-z_][A-Za-z0-9_]*。日本語名等は "…" で引用)
//   疑似フィールド  FID(feature.id→配列index) _ogr_geometry_ OGR_GEOMETRY(型名)
//             OGR_GEOM_WKT(WKT化) OGR_GEOM_AREA(面積) OGR_STYLE
//             ※同名の実フィールドより疑似フィールドが優先(仕様準拠)
//   真偽評価  仕様「式は真偽値として評価される」に従い、裸の式も受理して
//             OGR 準拠の真偽化(NULL→false・数値→非0・文字列→数値化で非0)
//   非対応    == / TRUE / FALSE / NULL 値リテラル
//             / NOT の中置形 / 非 ASCII 裸識別子 / % 演算子
//             / 単独の |(ビット演算は OGR SQL 文法外)
//             — OGR SQL 仕様に無いものは受理せずパースエラーとする
//
// compileWhereExpression(text) → (feature|props, index?) => boolean を返す。
// feature({properties,geometry,id})を渡せば疑似フィールドも評価できる。
// properties のみを渡した場合は疑似フィールドは FID=index・geometry 系=未定義。
// 空文字列は全地物を通す述語。パース失敗は Error を投げる。

const KEYWORDS = new Set([
  "AND", "OR", "NOT", "IN", "LIKE", "ILIKE", "IS", "NULL",
  "TRUE", "FALSE", "BETWEEN", "AS", "ESCAPE",
]);

// OGR SQL の疑似フィールド(同名の実フィールドより優先)
const PSEUDO_FIELDS = new Set([
  "FID", "_OGR_GEOMETRY_", "OGR_GEOMETRY", "OGR_GEOM_WKT", "OGR_GEOM_AREA", "OGR_STYLE",
]);

const FUNCTION_NAMES = new Set(["SUBSTR", "CAST", "CONCAT", "HSTORE_GET_VALUE"]);

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
    // 比較演算子(2文字優先)。OGR SQL に無い == は対象外。
    // || は文字列連結演算子(単独の | は文法外として次の throw へ)
    const two = src.slice(i, i + 2);
    if (["!=", "<>", "<=", ">=", "||"].includes(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
    if (ch === "=" || ch === "<" || ch === ">") { tokens.push({ t: "op", v: ch }); i++; continue; }
    // 算術演算子
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") { tokens.push({ t: "op", v: ch }); i++; continue; }
    // 数値(符号は単項演算子としてパーサで処理)
    const numMatch = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (numMatch) { tokens.push({ t: "num", v: Number(numMatch[0]) }); i += numMatch[0].length; continue; }
    // 裸の識別子/キーワード(OGR SQL と同じく ASCII 識別子のみ。
    // 日本語名等は "…" 引用識別子で書く)
    const identMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
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

// ---- 値の正規化・比較 ----

function isNullish(v) { return v === null || v === undefined || v !== v; }

// OGR の比較では bool は整数(1/0)として扱う
function normalize(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  return v;
}

function toNumeric(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || v.trim() === "") return NaN;
  return Number(v);
}

// OGR SQL: = != <> は文字列等価で大文字小文字を区別しない。
// < <= > >= は大小区別あり。両辺が数値解釈可能なら数値比較。
// NULL を含む比較は NULL (= フィルタ上不成立) を返す
function compareValues(a, b, op) {
  const av = normalize(a), bv = normalize(b);
  if (isNullish(av) || isNullish(bv)) return false;
  const an = toNumeric(av), bn = toNumeric(bv);
  let cmp;
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    cmp = Math.sign(an - bn);
  } else {
    const as = String(av), bs = String(bv);
    if (op === "=" || op === "!=" || op === "<>") {
      // 等価系は大小区別なし
      cmp = as.toUpperCase() === bs.toUpperCase() ? 0 : (as.toUpperCase() < bs.toUpperCase() ? -1 : 1);
    } else {
      // 大小比較は大小区別あり(コードポイント順)
      cmp = as === bs ? 0 : (as < bs ? -1 : 1);
    }
  }
  switch (op) {
    case "=": return cmp === 0;
    case "!=": case "<>": return cmp !== 0;
    case "<": return cmp < 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case ">=": return cmp >= 0;
    default: return false;
  }
}

// LIKE/ILIKE パターン → RegExp。%=任意文字列、_=任意1文字、
// ESCAPE 文字は % _ 自身をリテラル化する
function likeToRegExp(pattern, ci, escChar) {
  const src = String(pattern);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escChar && ch === escChar && i + 1 < src.length) {
      out += src[++i].replace(/[.*+^${}()|[\]\\?]/g, "\\$&");
    } else if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, ci ? "iu" : "");
}

// ---- 疑似フィールド ----

const OGR_GEOM_TYPE_NAMES = {
  Point: "POINT", LineString: "LINESTRING", Polygon: "POLYGON",
  MultiPoint: "MULTIPOINT", MultiLineString: "MULTILINESTRING",
  MultiPolygon: "MULTIPOLYGON", GeometryCollection: "GEOMETRYCOLLECTION",
};

function fmtCoord(c) {
  return c.slice(0, 2).map(n => String(Number(n))).join(" ");
}

function geomToWkt(g) {
  if (!g || !g.type) return null;
  const t = g.type, c = g.coordinates;
  switch (t) {
    case "Point": return `POINT (${fmtCoord(c)})`;
    case "MultiPoint": return `MULTIPOINT (${c.map(fmtCoord).join(", ")})`;
    case "LineString": return `LINESTRING (${c.map(fmtCoord).join(", ")})`;
    case "MultiLineString":
      return `MULTILINESTRING (${c.map(l => `(${l.map(fmtCoord).join(", ")})`).join(", ")})`;
    case "Polygon":
      return `POLYGON (${c.map(r => `(${r.map(fmtCoord).join(", ")})`).join(", ")})`;
    case "MultiPolygon":
      return `MULTIPOLYGON (${c.map(p => `(${p.map(r => `(${r.map(fmtCoord).join(", ")})`).join(", ")})`).join(", ")})`;
    case "GeometryCollection":
      return `GEOMETRYCOLLECTION (${(g.geometries || []).map(geomToWkt).join(", ")})`;
    default: return null;
  }
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

function geomArea(g) {
  if (!g || !g.type) return 0;
  if (g.type === "Polygon") {
    return g.coordinates.reduce((acc, r, i) => i === 0 ? acc + Math.abs(ringArea(r)) : acc - Math.abs(ringArea(r)), 0);
  }
  if (g.type === "MultiPolygon") {
    return g.coordinates.reduce((sum, p) =>
      sum + p.reduce((acc, r, i) => i === 0 ? acc + Math.abs(ringArea(r)) : acc - Math.abs(ringArea(r)), 0), 0);
  }
  return 0;
}

// 疑似フィールドの解決。同名の実フィールドより優先(仕様準拠)
function resolvePseudoField(name, ctx) {
  const upper = String(name).toUpperCase();
  if (!PSEUDO_FIELDS.has(upper)) return { found: false };
  switch (upper) {
    case "FID": return { found: true, v: ctx.fid };
    case "_OGR_GEOMETRY_": return { found: true, v: ctx.geometry };
    case "OGR_GEOMETRY": return { found: true, v: OGR_GEOM_TYPE_NAMES[ctx.geometry?.type] || null };
    case "OGR_GEOM_WKT": return { found: true, v: geomToWkt(ctx.geometry) };
    case "OGR_GEOM_AREA": return { found: true, v: ctx.geometry ? geomArea(ctx.geometry) : null };
    case "OGR_STYLE": return { found: true, v: null }; // GeoJSON にスタイルは無い
    default: return { found: false };
  }
}

// 属性名 → 値の取得。疑似フィールド優先(仕様)、次に完全一致→大小文字を無視して探す
function lookup(ctx, name) {
  const pseudo = resolvePseudoField(name, ctx);
  if (pseudo.found) return pseudo.v;
  const props = ctx.props;
  if (props == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(props)) {
    if (key.toLowerCase() === lower) return props[key];
  }
  return undefined;
}

// ---- 関数 ----

function ogrSubstr(s, start, len) {
  const str = s == null ? "" : String(s);
  const n = Number(start);
  // OGR: 1 始まり。負なら末尾から(-1=最後の文字)
  let idx = n >= 1 ? n - 1 : str.length + n;
  if (idx < 0) idx = 0;
  if (len === undefined) return str.slice(idx);
  return str.slice(idx, idx + Math.max(0, Number(len)));
}

function hstoreGetValue(hstore, key) {
  const src = String(hstore || "");
  const k = String(key);
  // 'a=>b, "quoted key"=>"quoted val"' 形式の簡易パーサ
  let i = 0;
  const readToken = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === '"') {
      let j = i + 1, buf = "";
      while (j < src.length && src[j] !== '"') { buf += src[j]; j++; }
      i = j + 1;
      return buf;
    }
    const m = /^[^,=>]+/.exec(src.slice(i));
    const v = m ? m[0].trim() : "";
    i += m ? m[0].length : 0;
    return v;
  };
  while (i < src.length) {
    const k2 = readToken();
    if (src.slice(i, i + 2) === "=>") i += 2;
    const v2 = readToken();
    if (src[i] === ",") i++;
    if (k2 === k) return v2;
  }
  return null;
}

// CAST(x AS type)。WHERE 句では値変換として働く
function ogrCast(v, type, params) {
  const t = String(type).toLowerCase();
  const len = params.length ? Number(params[0]) : 0;
  switch (t) {
    case "boolean":
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      return /^(true|1)$/i.test(String(v).trim());
    case "character": case "char": case "varchar": case "text": {
      const s = v == null ? "" : String(v);
      const n = len > 0 ? len : 1; // 仕様: field_length 既定=1
      return s.slice(0, n);
    }
    case "float": case "numeric": case "real": case "double": {
      const n = toNumeric(normalize(v));
      return Number.isFinite(n) ? n : null;
    }
    case "smallint": case "integer": case "bigint": case "int": {
      const n = toNumeric(normalize(v));
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case "date": case "time": case "timestamp":
      // OGR は 'YYYY-MM-DD' 等の文字列形式。パース不能は null
      return v == null ? null : String(v);
    case "geometry":
      return v; // WKT 文字列等をそのまま返す(幾何演算は非対応)
    default:
      return v;
  }
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
  // 述語 = <式> [IS NULL|IN|BETWEEN|LIKE|ILIKE|比較] | ( <式> )
  parsePredicate() {
    const left = this.parseOperandExpr();
    // IS [NOT] NULL
    if (this.kw("IS")) {
      const negate = this.kw("NOT");
      this.expect("kw", "NULL");
      return { k: "isnull", a: left, neg: negate };
    }
    // IN (値,…)
    if (this.kw("IN")) {
      this.expect("(");
      const values = [];
      for (;;) {
        values.push(this.parseOperandExpr());
        const sep = this.next();
        if (sep.t === ")") break;
        if (sep.t !== ",") throw new Error("where= の IN リストが不正です");
      }
      return { k: "in", a: left, values };
    }
    // BETWEEN a AND b
    if (this.kw("BETWEEN")) {
      const lo = this.parseOperandExpr();
      this.expect("kw", "AND");
      const hi = this.parseOperandExpr();
      return { k: "between", a: left, lo, hi };
    }
    // LIKE|ILIKE 'pat' [ESCAPE 'c']
    if (this.kw("LIKE") || this.kw("ILIKE")) {
      const ci = this.tokens[this.pos - 1].v === "ILIKE";
      const pat = this.parseOperandExpr();
      let esc = null;
      if (this.kw("ESCAPE")) {
        const tok = this.next();
        if (tok.t !== "str" || tok.v.length !== 1) {
          throw new Error("where= の ESCAPE には1文字の文字列リテラルが必要です");
        }
        esc = tok.v;
      }
      return { k: "like", a: left, pattern: pat, ci, esc };
    }
    // 比較演算子
    const tok = this.peek();
    if (tok.t === "op" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(tok.v)) {
      this.next();
      return { k: "cmp", a: left, op: tok.v, b: this.parseOperandExpr() };
    }
    // 比較のない裸の式も受理する(仕様: WHERE 式は真偽値として評価される。
    // 真偽評価は OGR 準拠 ogrToBool = 数値化して非0 で行う)
    return left;
  }
  // <式> = 加減算
  parseOperandExpr() {
    let left = this.parseTerm();
    for (;;) {
      const tok = this.peek();
      if (tok.t === "op" && (tok.v === "+" || tok.v === "-")) {
        this.next();
        left = { k: "arith", op: tok.v, a: left, b: this.parseTerm() };
      } else return left;
    }
  }
  // <式> = 乗除算・文字列連結(|| は左結合。SQLite/OGR では || が
  // * / より強いが、混在式は稀なため同レベルとして扱う)
  parseTerm() {
    let left = this.parseUnaryArith();
    for (;;) {
      const tok = this.peek();
      if (tok.t === "op" && (tok.v === "*" || tok.v === "/" || tok.v === "||")) {
        this.next();
        left = { k: "arith", op: tok.v, a: left, b: this.parseUnaryArith() };
      } else return left;
    }
  }
  parseUnaryArith() {
    const tok = this.peek();
    if (tok.t === "op" && tok.v === "-") {
      this.next();
      return { k: "neg", a: this.parseUnaryArith() };
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const tok = this.next();
    if (tok.t === "(") {
      const node = this.parseOr();
      this.expect(")");
      return { k: "group", a: node };
    }
    if (tok.t === "ident") {
      // 関数呼出 識別子 ( 引数… )
      if (this.peek().t === "(") {
        const fname = tok.v.toUpperCase();
        if (!FUNCTION_NAMES.has(fname)) {
          throw new Error(`where= の式が不正です: 未対応の関数 ${tok.v} です`);
        }
        this.next(); // '(' を消費
        if (fname === "CAST") {
          const arg = this.parseOperandExpr();
          this.expect("kw", "AS");
          const typeTok = this.next();
          if (typeTok.t !== "ident" && typeTok.t !== "kw") {
            throw new Error("where= の CAST の型名が不正です");
          }
          const params = [];
          if (this.peek().t === "(") {
            this.next();
            for (;;) {
              const p = this.next();
              if (p.t === "num") params.push(p.v);
              else if (p.t === "ident" || p.t === "str" || p.t === "kw") params.push(p.v);
              else throw new Error("where= の CAST の引数が不正です");
              const sep = this.next();
              if (sep.t === ")") break;
              if (sep.t !== ",") throw new Error("where= の CAST の引数が不正です");
            }
          }
          this.expect(")");
          return { k: "cast", a: arg, type: typeTok.v, params };
        }
        const args = [];
        if (this.peek().t !== ")") {
          for (;;) {
            args.push(this.parseOperandExpr());
            const sep = this.next();
            if (sep.t === ")") break;
            if (sep.t !== ",") throw new Error(`where= の ${fname} の引数が不正です`);
          }
        } else this.next();
        return { k: "func", name: fname, args };
      }
      return { k: "ident", name: tok.v };
    }
    if (tok.t === "str" || tok.t === "num") return { k: "lit", v: tok.v };
    if (tok.t === "kw") {
      // TRUE/FALSE/NULL は OGR SQL で値リテラルとして使えないため受理しない
      throw new Error(`where= の式が不正です: ${tok.v} の位置に値が必要です`);
    }
    throw new Error("where= の式が不正です: 値または属性名が必要です");
  }
}

// ---- 評価 ----

// OGR の真偽評価: NULL→false、数値→非0、文字列→数値化して非0('abc'→0→false)
function ogrToBool(v) {
  const n = normalize(v);
  if (isNullish(n)) return false;
  if (typeof n === "number") return n !== 0;
  const f = parseFloat(String(n));
  return Number.isFinite(f) && f !== 0;
}

function evalNode(node, ctx) {
  switch (node.k) {
    case "and": return ogrToBool(evalNode(node.a, ctx)) && ogrToBool(evalNode(node.b, ctx));
    case "or": return ogrToBool(evalNode(node.a, ctx)) || ogrToBool(evalNode(node.b, ctx));
    case "not": return !ogrToBool(evalNode(node.a, ctx));
    case "cmp": return compareValues(evalNode(node.a, ctx), evalNode(node.b, ctx), node.op);
    case "isnull": {
      const r = isNullish(evalNode(node.a, ctx));
      return node.neg ? !r : r;
    }
    case "in": {
      const v = evalNode(node.a, ctx);
      return node.values.some(o => compareValues(v, evalNode(o, ctx), "="));
    }
    case "between": {
      const v = evalNode(node.a, ctx);
      return compareValues(v, evalNode(node.lo, ctx), ">=") && compareValues(v, evalNode(node.hi, ctx), "<=");
    }
    case "like": {
      const v = evalNode(node.a, ctx);
      const pat = evalNode(node.pattern, ctx);
      if (isNullish(v) || isNullish(pat)) return false;
      return likeToRegExp(pat, node.ci, node.esc).test(String(v));
    }
    // 値ノード
    case "lit": return node.v;
    case "ident": return lookup(ctx, node.name);
    case "group": return evalNode(node.a, ctx);
    case "neg": {
      const v = toNumeric(normalize(evalNode(node.a, ctx)));
      return Number.isFinite(v) ? -v : null;
    }
    case "arith": {
      if (node.op === "||") {
        // SQL の文字列連結。NULL を含むと結果も NULL(比較は不成立)
        const av = normalize(evalNode(node.a, ctx));
        const bv = normalize(evalNode(node.b, ctx));
        if (isNullish(av) || isNullish(bv)) return null;
        return String(av) + String(bv);
      }
      const a = toNumeric(normalize(evalNode(node.a, ctx)));
      const b = toNumeric(normalize(evalNode(node.b, ctx)));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? null : a / b;
        default: return null;
      }
    }
    case "func": {
      const args = node.args.map(a => evalNode(a, ctx));
      switch (node.name) {
        case "SUBSTR": return ogrSubstr(args[0], args[1], args[2]);
        case "CONCAT": return args.map(v => v == null ? "" : String(v)).join("");
        case "HSTORE_GET_VALUE": return hstoreGetValue(args[0], args[1]);
        default: return null;
      }
    }
    case "cast": return ogrCast(evalNode(node.a, ctx), node.type, node.params);
    default: return null;
  }
}

// 述語の評価コンテキストを構築。feature({properties,geometry,id}) または
// properties オブジェクトのどちらも受け付ける
function makeCtx(arg, index) {
  if (arg != null && typeof arg === "object"
    && (Object.prototype.hasOwnProperty.call(arg, "properties") || arg.type === "Feature")) {
    return {
      props: arg.properties || {},
      geometry: arg.geometry || null,
      fid: arg.id != null ? arg.id : index,
    };
  }
  return { props: arg || {}, geometry: null, fid: index };
}

// where= 式テキスト → (feature|props, index?) => boolean。
// 空/空白のみの入力は常に true を返す述語。パース失敗時は Error を投げる
export function compileWhereExpression(text) {
  const src = String(text || "").trim();
  if (!src) return () => true;
  const ast = new Parser(tokenize(src)).parse();
  return (arg, index) => {
    try { return ogrToBool(evalNode(ast, makeCtx(arg, index))); }
    catch { return false; }
  };
}

// GeoJSON FeatureCollection へ where= 式を適用した浅いコピーを返す。
// 式が空・全件一致なら元オブジェクトをそのまま返す。パース失敗は例外
export function filterGeoJsonByWhere(source, whereText) {
  const pred = compileWhereExpression(whereText);
  const features = source?.features;
  if (!Array.isArray(features) || !features.length) return source;
  const kept = features.filter((f, i) => pred(f, i));
  return kept.length === features.length ? source : { ...source, features: kept };
}
