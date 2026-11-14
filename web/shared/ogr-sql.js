// ogr-sql.js — OGR SQL SELECT 文のクライアント側実行エンジン。
// shared/where-eval.js の式パーサ/評価器を再利用し、SELECT 文全体を
// GeoJSON 地物列へ適用する。対象は ogrsql: 行・AI/クエリ UI からの
// 任意問い合わせ。QGIS(geo_webview)が検出できる場合は GDAL 本体へ
// 委譲する経路も併存する(セマンティクスの正規ルート)。
//
// 対応文法(OGR SQL 仕様 gdal.org/user/ogr_sql_dialect.html 準拠):
//   SELECT [DISTINCT] <項目>[,…] FROM <テーブル> [<別名>]
//          [[LEFT] JOIN <テーブル> [<別名>] ON <式>]…
//          [WHERE <式>] [ORDER BY <式> [ASC|DESC][,…]]
//          [LIMIT <n> [OFFSET <m>]]
//   項目    * | <テーブル>.* | <式> [AS <別名>] | <集計>([DISTINCT] <式>)
//           | COUNT(*) | COUNT(DISTINCT <式>)
//   集計    AVG COUNT MIN MAX SUM STDDEV_POP STDDEV_SAMP(STDDEV=SAMP 扱い)
//           ※OGR SQL に GROUP BY は無い。集計を含む SELECT は全行を1行に集約
//   テーブル <名> | "<名>" | '<参照>' | '<データソース>'.<レイヤー名>
//           ('ds'.layer は OGR SQL の外部データソース参照形式)
//   式      WHERE 句と同じ where-eval 文法(比較/論理/IN/BETWEEN/LIKE/IS NULL/
//           算術/||/SUBSTR/CAST/CONCAT/hstore_get_value/疑似フィールド/
//           <テーブル>.<フィールド> 修飾名)
//   JOIN    OGR SQL の JOIN は LEFT JOIN 意味だが、各プライマリ行に
//           結合されるのは最初に一致した副テーブル行のみ(GDAL実測)
//   解決    FROM 名は resolveSource(ref) コールバックが行う
//           (レイヤータイトル照合・ファイルパス・'ds'.layer 形式は呼び出し側)
//
// parseOgrSelect(text) → ステートメント AST
// executeOgrSelect(text|stmt, resolveSource) → GeoJSON FeatureCollection
//   resolveSource(ref) は Promise<FeatureCollection|feature[]> を返す。
//   ref は {name} | {name, source}('ds'.layer 形式: source=DS, name=層名)
//
// 真偽/比較/NULL の評価規則は where-eval.js の OGR 準拠規則をそのまま使う
// (= /IN は大小区別なし・< > は区別あり・NULL 含む比較は不成立)。

import {
  tokenize, Parser, evalNode, lookup, compareValues, isNullish,
  normalize, toNumeric, ogrToBool, resolvePseudoField, geomToWkt,
  PSEUDO_FIELDS,
} from "./where-eval.js";

const AGGREGATE_NAMES = new Set([
  "AVG", "COUNT", "MIN", "MAX", "SUM", "STDDEV_POP", "STDDEV_SAMP", "STDDEV",
]);

// 句の先頭語。テーブル別名として取り込まない
const CLAUSE_WORDS = new Set([
  "SELECT", "DISTINCT", "FROM", "WHERE", "JOIN", "LEFT", "INNER", "ON",
  "ORDER", "BY", "LIMIT", "OFFSET", "ASC", "DESC", "AS", "UNION",
]);

// ---- ステートメントパーサ ----
// SELECT/FROM/WHERE 等は where-eval トークナイザでは ident トークンとして
// 現れる(AS だけ kw)。句レベルでは word() で名前照合する
class SelectParser extends Parser {
  word(name) {
    const tok = this.peek();
    if ((tok.t === "ident" || tok.t === "kw")
        && String(tok.v).toUpperCase() === name) {
      this.pos++;
      return true;
    }
    return false;
  }
  expectWord(name) {
    if (!this.word(name)) {
      throw new Error(`ogrsql クエリが不正です: ${name} が必要です`);
    }
  }
  parseStatement() {
    this.expectWord("SELECT");
    const distinct = this.word("DISTINCT");
    const fields = this.parseFieldList();
    this.expectWord("FROM");
    const from = this.parseTableSpec();
    const joins = [];
    for (;;) {
      this.word("LEFT"); // OGR SQL の JOIN は LEFT JOIN 意味。明示記述も許容
      if (!this.word("JOIN")) break;
      const spec = this.parseTableSpec();
      this.expectWord("ON");
      joins.push({ ...spec, on: this.parseOr() });
    }
    let where = null;
    if (this.word("WHERE")) where = this.parseOr();
    const orderBy = [];
    if (this.word("ORDER")) {
      this.expectWord("BY");
      for (;;) {
        const expr = this.parseOperandExpr();
        let desc = false;
        if (this.word("DESC")) desc = true;
        else this.word("ASC");
        orderBy.push({ expr, desc });
        if (this.peek().t === ",") { this.next(); continue; }
        break;
      }
    }
    let limit = null, offset = 0;
    if (this.word("LIMIT")) {
      const tok = this.next();
      if (tok.t !== "num") throw new Error("ogrsql クエリが不正です: LIMIT には数値が必要です");
      limit = tok.v;
      if (this.word("OFFSET")) {
        const o = this.next();
        if (o.t !== "num") throw new Error("ogrsql クエリが不正です: OFFSET には数値が必要です");
        offset = o.v;
      }
    }
    if (this.peek().t !== "eof") {
      throw new Error("ogrsql クエリの末尾に余分な入力があります");
    }
    return { distinct, fields, from, joins, where, orderBy, limit, offset };
  }
  parseFieldList() {
    const items = [];
    for (;;) {
      items.push(this.parseFieldItem());
      if (this.peek().t === ",") { this.next(); continue; }
      break;
    }
    return items;
  }
  parseFieldItem() {
    const tok = this.peek();
    if (tok.t === "op" && tok.v === "*") {
      this.next();
      return { k: "star" };
    }
    // <テーブル>.*
    if ((tok.t === "ident" || tok.t === "kw")
        && this.tokens[this.pos + 1]?.t === "."
        && this.tokens[this.pos + 2]?.t === "op" && this.tokens[this.pos + 2].v === "*") {
      this.pos += 3;
      return { k: "star", table: tok.v };
    }
    // 集計関数(SELECT フィールドリスト専用)
    if (tok.t === "ident" && this.tokens[this.pos + 1]?.t === "("
        && AGGREGATE_NAMES.has(tok.v.toUpperCase())) {
      this.pos += 2;
      const name = tok.v.toUpperCase();
      let distinct = false, arg = null;
      if (this.peek().t === "op" && this.peek().v === "*") {
        this.next(); // COUNT(*)
      } else {
        if (this.word("DISTINCT")) distinct = true;
        arg = this.parseOperandExpr();
      }
      this.expect(")");
      return this.parseAlias({ k: "agg", name, arg, distinct });
    }
    const expr = this.parseOperandExpr();
    return this.parseAlias({ k: "expr", expr });
  }
  parseAlias(item) {
    if (this.word("AS")) {
      const t = this.next();
      if (t.t !== "ident" && t.t !== "kw" && t.t !== "str") {
        throw new Error("ogrsql クエリが不正です: AS の後に別名が必要です");
      }
      item.alias = t.v;
    }
    return item;
  }
  parseTableSpec() {
    const tok = this.next();
    let ref;
    if (tok.t === "str") {
      // '<参照>' — ファイルパス/URL、または '<データソース>'.<レイヤー名>
      if (this.peek().t === ".") {
        this.next();
        const n = this.next();
        if (n.t !== "ident" && n.t !== "kw" && n.t !== "str") {
          throw new Error("ogrsql クエリが不正です: . の後にレイヤー名が必要です");
        }
        ref = { name: n.v, source: tok.v };
      } else {
        ref = { name: tok.v };
      }
    } else if (tok.t === "ident" || tok.t === "kw") {
      ref = { name: tok.v };
    } else {
      throw new Error("ogrsql クエリが不正です: FROM/JOIN にテーブル名が必要です");
    }
    this.word("AS");
    const p = this.peek();
    if (p.t === "ident" && !CLAUSE_WORDS.has(String(p.v).toUpperCase())) {
      this.next();
      ref.alias = p.v;
    }
    return ref;
  }
}

export function parseOgrSelect(text) {
  const parser = new SelectParser(tokenize(text));
  return parser.parseStatement();
}

// ---- 式中の識別子収集(静的検証用) ----
function collectIdents(node, out = { plain: [], qualified: [] }) {
  if (!node || typeof node !== "object") return out;
  if (node.k === "ident") out.plain.push(node.name);
  else if (node.k === "qident") out.qualified.push(node);
  for (const key of ["a", "b", "arg"]) {
    if (node[key] && typeof node[key] === "object") collectIdents(node[key], out);
  }
  for (const key of ["args", "values"]) {
    if (Array.isArray(node[key])) node[key].forEach(n => collectIdents(n, out));
  }
  return out;
}

// ---- データセット正規化 ----
// GeoJSON FeatureCollection|feature[] → {features, fieldMap(lower→key)}
function normalizeSource(source, label) {
  const features = Array.isArray(source)
    ? source
    : (source?.features ?? (source?.type === "Feature" ? [source] : null) ?? []);
  const rows = features.map((f, i) => ({
    props: f?.properties || {},
    geometry: f?.geometry || null,
    fid: f?.id ?? i,
  }));
  const fieldMap = new Map();
  for (const r of rows) {
    for (const key of Object.keys(r.props)) {
      const lower = key.toLowerCase();
      if (!fieldMap.has(lower)) fieldMap.set(lower, key);
    }
  }
  return { label, rows, fieldMap };
}

// テーブル行の評価コンテキスト。tables は alias→行({props,geometry,fid}|null)
function rowCtx(cells, mainAlias) {
  const main = cells[mainAlias];
  const props = {};
  for (const cell of Object.values(cells)) {
    if (cell) Object.assign(props, cell.props);
  }
  return {
    props,
    geometry: main?.geometry || null,
    fid: main?.fid,
    tables: cells,
  };
}

// 修飾名が参照するテーブル(別名または FROM 名自身)を特定する
function tableFor(tables, ref) {
  return tables.find(t => t.alias === ref || t.name === ref) || null;
}

function fieldValue(cell, name) {
  if (!cell) return undefined;
  const pseudo = resolvePseudoField(name, { props: cell.props, geometry: cell.geometry, fid: cell.fid });
  if (pseudo.found) return pseudo.v;
  const props = cell.props;
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(props)) {
    if (key.toLowerCase() === lower) return props[key];
  }
  return undefined;
}

// ---- 集計 ----
function aggregateValues(name, values, distinct) {
  const norm = name === "STDDEV" ? "STDDEV_SAMP" : name;
  const nonNull = values.filter(v => !isNullish(normalize(v)));
  if (norm === "COUNT") {
    if (distinct) {
      const seen = new Set(nonNull.map(v => JSON.stringify(normalize(v))));
      return seen.size;
    }
    return nonNull.length;
  }
  if (!nonNull.length) return null;
  if (norm === "MIN" || norm === "MAX") {
    let best = nonNull[0];
    for (const v of nonNull.slice(1)) {
      const op = norm === "MIN" ? "<" : ">";
      if (compareValues(v, best, op)) best = v;
    }
    return normalize(best);
  }
  const nums = nonNull.map(v => toNumeric(normalize(v))).filter(Number.isFinite);
  if (!nums.length) return null;
  if (norm === "SUM") return nums.reduce((a, b) => a + b, 0);
  if (norm === "AVG") return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (norm === "STDDEV_POP" || norm === "STDDEV_SAMP") {
    if (norm === "STDDEV_SAMP" && nums.length < 2) return null;
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const variance = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0)
      / (norm === "STDDEV_POP" ? nums.length : nums.length - 1);
    return Math.sqrt(variance);
  }
  return null;
}

// 並び替えキーの比較。NULL は末尾。数値解釈可能なら数値比較、
// それ以外は大小区別なしの文字列比較(OGR の ORDER BY 規則に近似)
function orderCompare(a, b) {
  const an = isNullish(a), bn = isNullish(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const x = toNumeric(normalize(a)), y = toNumeric(normalize(b));
  if (Number.isFinite(x) && Number.isFinite(y)) return Math.sign(x - y);
  const s = String(normalize(a)).toUpperCase();
  const t = String(normalize(b)).toUpperCase();
  return s < t ? -1 : s > t ? 1 : 0;
}

// 式の出力列名。AS 別名 > 単純属性名 > EXPR_<n> 形式
function fieldLabel(item, index) {
  if (item.alias) return item.alias;
  if (item.k === "expr" && item.expr?.k === "ident") return item.expr.name;
  // GDAL は修飾名をそのまま列名にする(SELECT a.name → "a.name")
  if (item.k === "expr" && item.expr?.k === "qident") return `${item.expr.table}.${item.expr.name}`;
  if (item.k === "agg") {
    const arg = item.arg?.k === "ident" ? item.arg.name
      : item.arg?.k === "qident" ? `${item.arg.table}.${item.arg.name}`
      : item.arg ? "expr" : "*";
    return `${item.name}(${item.distinct ? "DISTINCT " : ""}${arg})`;
  }
  return `EXPR_${index + 1}`;
}

// 値を GeoJSON property へ収める形に正規化
// (geometry オブジェクトは WKT 化・配列/オブジェクトは JSON 文字列化)
function toPropertyValue(v) {
  const n = normalize(v);
  if (n && typeof n === "object") {
    if (n.type && (n.coordinates || n.geometries)) return geomToWkt(n);
    try { return JSON.stringify(n); } catch { return String(n); }
  }
  return n === undefined ? null : n;
}

// ---- 実行 ----
// stmt: parseOgrSelect の結果(またはクエリ文字列)
// resolveSource(ref) → Promise<FeatureCollection|features[]>
//   ref = {name, alias?, source?}。source は 'ds'.layer 形式のデータソース参照
export async function executeOgrSelect(stmt, resolveSource) {
  const query = typeof stmt === "string" ? parseOgrSelect(stmt) : stmt;
  if (typeof resolveSource !== "function") {
    throw new Error("ogrsql: FROM の解決コールバック(resolveSource)が必要です");
  }
  const refs = [query.from, ...query.joins];
  const tables = [];
  for (const ref of refs) {
    const source = await resolveSource(ref);
    const t = normalizeSource(source, ref.name);
    t.name = ref.name;
    t.alias = ref.alias || ref.name;
    tables.push(t);
  }
  const mainAlias = tables[0].alias;

  // ORDER BY は出力列ラベル(AS エイリアス含む)も参照できる。
  // 先に出力ラベル集合を作り、検証と評価の両方で使う
  const outLabels = new Set();
  query.fields.forEach((f, i) => outLabels.add(fieldLabel(f, i).toLowerCase()));

  // 静的検証: 識別子がスキーマで一意に解決できるか
  const allExprs = [
    query.where,
    ...query.joins.map(j => j.on),
    ...query.fields.filter(f => f.k === "expr").map(f => f.expr),
    ...query.fields.filter(f => f.k === "agg" && f.arg).map(f => f.arg),
  ].filter(Boolean);
  const nameCount = name => {
    const lower = name.toLowerCase();
    return tables.filter(t => t.fieldMap.has(lower)).length;
  };
  const checkExpr = (expr, { orderBy = false } = {}) => {
    const { plain, qualified } = collectIdents(expr);
    for (const name of plain) {
      if (PSEUDO_FIELDS.has(String(name).toUpperCase())) continue;
      if (orderBy && outLabels.has(String(name).toLowerCase())) continue;
      const count = nameCount(name);
      if (count === 0) throw new Error(`ogrsql: 属性 "${name}" が見つかりません`);
      if (count > 1) throw new Error(`ogrsql: 属性 "${name}" は複数テーブルに存在します("<テーブル>.<属性>" で修飾してください)`);
    }
    for (const q of qualified) {
      const t = tableFor(tables, q.table);
      if (!t) throw new Error(`ogrsql: テーブル "${q.table}" が FROM/JOIN にありません`);
      if (PSEUDO_FIELDS.has(String(q.name).toUpperCase())) continue;
      if (!t.fieldMap.has(String(q.name).toLowerCase())) {
        throw new Error(`ogrsql: 属性 "${q.table}.${q.name}" が見つかりません`);
      }
    }
  };
  for (const expr of allExprs) checkExpr(expr);
  for (const o of query.orderBy) {
    if (o.expr) checkExpr(o.expr, { orderBy: true });
  }

  // JOIN 実行(LEFT JOIN)。ON 式は両テーブル結合済みコンテキストで評価
  const evalCtx = cells => rowCtx(cells, mainAlias);
  let rows = tables[0].rows.map(row => ({ [mainAlias]: row }));
  for (let j = 0; j < query.joins.length; j++) {
    const join = query.joins[j];
    const right = tables[j + 1];
    const next = [];
    for (const cells of rows) {
      let merged = null;
      // GDAL の JOIN はリレーショナルな直積ではなく、プライマリ行ごとに
      // 最初に一致した副テーブル行を1件だけ結合する(古典的属性結合)。
      // JOIN/LEFT JOIN で挙動は同じ(実測確認済)
      for (const r of right.rows) {
        const m = { ...cells, [right.alias]: r };
        if (ogrToBool(evalNode(join.on, evalCtx(m)))) { merged = m; break; }
      }
      next.push(merged ?? { ...cells, [right.alias]: null });
    }
    rows = next;
  }

  // WHERE フィルタ
  if (query.where) {
    rows = rows.filter(cells => ogrToBool(evalNode(query.where, evalCtx(cells))));
  }

  // star 展開: 全テーブルの全フィールド(同名は <alias>.<名> に修飾)
  const expandStar = tableRef => {
    if (tableRef && !tables.some(t => t.alias === tableRef || t.name === tableRef)) {
      throw new Error(`ogrsql: テーブル "${tableRef}" が FROM/JOIN にありません`);
    }
    const out = [];
    for (const t of tables) {
      if (tableRef && t.alias !== tableRef && t.name !== tableRef) continue;
      for (const name of t.fieldMap.values()) {
        out.push({ t, name, dup: nameCount(name) > 1 });
      }
      if (tableRef) break;
    }
    return out;
  };

  const hasAgg = query.fields.some(f => f.k === "agg");

  const project = cells => {
    const ctx = evalCtx(cells);
    const out = {};
    let idx = 0;
    for (const item of query.fields) {
      idx++;
      if (item.k === "star") {
        for (const f of expandStar(item.table)) {
          const key = f.dup ? `${f.t.alias}.${f.name}` : f.name;
          out[key] = toPropertyValue(fieldValue(cells[f.t.alias], f.name));
        }
      } else if (item.k === "expr") {
        out[fieldLabel(item, idx - 1)] = toPropertyValue(evalNode(item.expr, ctx));
      }
      // agg はここでは埋めない(集約後に一括)
    }
    return out;
  };

  let projected;
  if (hasAgg) {
    // OGR SQL に GROUP BY は無い。集計を含む SELECT は全行を1行に集約し、
    // 非集計項目は先頭行の値を取る(GDAL 近似)
    const out = {};
    let idx = 0;
    const firstCtx = rows.length ? evalCtx(rows[0]) : evalCtx({ [mainAlias]: null });
    for (const item of query.fields) {
      idx++;
      if (item.k === "star") {
        for (const f of expandStar(item.table)) {
          const key = f.dup ? `${f.t.alias}.${f.name}` : f.name;
          out[key] = toPropertyValue(fieldValue(rows[0]?.[f.t.alias] ?? null, f.name));
        }
      } else if (item.k === "expr") {
        out[fieldLabel(item, idx - 1)] = toPropertyValue(evalNode(item.expr, firstCtx));
      } else if (item.k === "agg") {
        const name = fieldLabel(item, idx - 1);
        if (item.arg == null) {
          out[name] = item.name === "COUNT" ? rows.length : null;
        } else {
          let values = rows.map(cells => evalNode(item.arg, evalCtx(cells)));
          if (item.distinct) {
            const seen = new Set();
            values = values.filter(v => {
              const k = JSON.stringify(normalize(v));
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          }
          out[name] = aggregateValues(item.name, values, item.distinct);
        }
      }
    }
    projected = [{ props: out, geometry: null, fid: null, sortCtx: evalCtx({ [mainAlias]: null }) }];
  } else {
    projected = rows.map(cells => ({
      props: project(cells),
      geometry: cells[mainAlias]?.geometry || null,
      fid: cells[mainAlias]?.fid,
      sortCtx: evalCtx(cells),
    }));
  }

  // DISTINCT(射影タプルで重複除去)
  if (query.distinct) {
    const seen = new Set();
    projected = projected.filter(r => {
      const key = JSON.stringify(Object.values(r.props).map(v => normalize(v)));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ORDER BY(評価コンテキストは各行の結合行。出力列ラベルは射影結果を参照)
  if (query.orderBy.length) {
    const orderKey = (o, r) => {
      if (o.expr?.k === "ident") {
        const name = o.expr.name;
        if (Object.prototype.hasOwnProperty.call(r.props, name)) return r.props[name];
        const lower = name.toLowerCase();
        if (outLabels.has(lower)) {
          const hit = Object.keys(r.props).find(k => k.toLowerCase() === lower);
          if (hit !== undefined) return r.props[hit];
        }
      }
      return evalNode(o.expr, r.sortCtx);
    };
    projected = projected.map(r => ({
      ...r,
      _keys: query.orderBy.map(o => orderKey(o, r)),
    }));
    projected.sort((a, b) => {
      for (let i = 0; i < query.orderBy.length; i++) {
        // NULL は ASC/DESC どちらでも末尾(orderCompare の NULL 規則を維持)
        const an = isNullish(a._keys[i]), bn = isNullish(b._keys[i]);
        if (an || bn) {
          if (an && bn) continue;
          return an ? 1 : -1;
        }
        const cmp = orderCompare(a._keys[i], b._keys[i]);
        if (cmp) return query.orderBy[i].desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  // LIMIT / OFFSET
  const offset = Math.max(0, Math.floor(query.offset || 0));
  const limit = query.limit == null ? null : Math.max(0, Math.floor(query.limit));
  const sliced = projected.slice(offset, limit == null ? undefined : offset + limit);

  const features = sliced.map((r, i) => ({
    type: "Feature",
    id: r.fid ?? i,
    geometry: r.geometry,
    properties: r.props,
  }));
  return { type: "FeatureCollection", features };
}
