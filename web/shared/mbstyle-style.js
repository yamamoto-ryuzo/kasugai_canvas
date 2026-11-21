// Mapbox GL Style (mbstyle) サブセット → compileQmlStyle 互換 spec への
// コンパイラ。OGC 24-050 Portrayal 拡張 gpkgext_stylesheets(format="mbstyle")
// のスタイルシートを MapLibre 以外のエンジンでも描画できるよう、
// sld-style.js と同じ共通 spec(evaluate/namesFor/legend/warnings/labelFor)
// へ変換する。maplibre は applyGpkgPortrayal がネイティブ適用するため本経路不要。
//
// 対象サブセット:
//   レイヤ型: fill(fill-color/fill-opacity/fill-outline-color)・
//     line(line-color/width/opacity/dasharray/cap/join)・
//     circle(color/radius/opacity/stroke-*)・
//     symbol(icon-image → gpkgext_symbols または mbstyle sprite、
//            text-field/size/color/halo/anchor/offset → labelFor)
//   縮尺: layer の minzoom/maxzoom → ルール縮尺範囲(512px 基準ズーム
//     → 縮尺分母。現在縮尺は evalScaleDenom 経由で render 毎に評価)
//   filter: レガシー比較(==/!=/>/>=/</<=/in/!in/has/!has)+ all/any/none/!
//     + 式として truthy なもの。$type はジオメトリ情報を持たないため
//     常に適合扱い(描画要素がジオメトリ種別で自然に選別される)
//   式( paint/layout/filter ): get/has/in/literal/properties/zoom/
//     == 系/all/any/none/!/case/match/step/interpolate(linear・
//     exponential。cubic-bezier は linear 近似・hcl/lab は rgb 近似)/
//     coalesce/to-*/number/string/boolean/算術/concat/upcase/downcase/
//     rgb/rgba/format/let/var
// 未対応は警告化: fill-pattern/line-gradient/line-pattern/heatmap/
//   hillshade/raster/fill-extrusion/background/sky/custom/model レイヤ、
//   promoteId・raster/vector source、未対応演算子。
//
// 返却 spec は compileQmlStyle と同じキーを持つため、item.qmlStyle/
// item._qml へ代入するだけで compileEmbeddedStyle 経由の全エンジンに適用される

import { cssColorToRgba, resolveKascUrl } from "./kasc.js";
import { evalScaleDenom } from "./qml-style.js";

// ---- ズーム ↔ 縮尺分母 ----
// mbstyle の zoom は 512px タイル基準(MapLibre getZoom() と同じ)。
// res(m/px) = 78271.517 / 2^z(赤道・cos(lat)≈1 の近似)、分母 = res / 0.00028
const Z_RES = 78271.51698;
const zoomToDenom = z => Z_RES / (Math.pow(2, z) * 0.00028);
const denomToZoom = d => Math.log2(Z_RES / (d * 0.00028));
// 縮尺分母 → 概算距離(compileQmlStyle/sld-style.js と同じ換算)
const scaleToDist = s => (s > 0 ? s * 0.00028 * 900 / (2 * Math.tan(Math.PI / 6)) : 0);

// ---- 色: 評価値 → [r,g,b,a](0-1) ----
function toSpecColor(v, opacity = 1) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    // [r,g,b,a](0-1) 内表現か [r,g,b](0-255)? interpolate/rgb 出力は 0-1 系
    const nums = v.map(Number);
    if (nums.length >= 3 && nums.every(Number.isFinite)) {
      const big = nums[0] > 1 || nums[1] > 1 || nums[2] > 1;
      return [nums[0] / (big ? 255 : 1), nums[1] / (big ? 255 : 1), nums[2] / (big ? 255 : 1),
        Math.min(1, Math.max(0, (Number.isFinite(nums[3]) ? nums[3] : 1) * opacity))];
    }
    return null;
  }
  const c = cssColorToRgba(String(v));
  if (!c) return null;
  return [c.r / 255, c.g / 255, c.b / 255, Math.min(1, Math.max(0, c.a * opacity))];
}
// 色評価用: 値が色文字列/array なら 0-255 系配列へ統一(補間に使う)
function toColorNums(v) {
  const spec = toSpecColor(v, 1);
  return spec ? [spec[0] * 255, spec[1] * 255, spec[2] * 255, spec[3]] : null;
}
const isColorLike = v =>
  typeof v === "string" && (v.startsWith("#") || /^(rgba?|hsla?)\(|^[a-z]+$/i.test(v)) && !!cssColorToRgba(v);

const warnOnce = (warnings, msg) => { if (!warnings.has(msg)) warnings.add(msg); };

// ---- 式評価(サブセット) ----
// ctx = { props, zoom|null, vars }
function evalExpr(v, ctx, warnings) {
  if (!Array.isArray(v)) return v;
  if (!v.length) return null;
  const op = v[0];
  // 先頭要素が文字列でない配列は式ではなくデータ(例: line-dasharray [2,1])
  if (typeof op !== "string") return v;
  const A = i => evalExpr(v[i], ctx, warnings);
  switch (op) {
    case "literal": return v[1];
    case "get": {
      const key = String(A(1));
      const obj = v[2] !== undefined ? A(2) : ctx.props;
      return obj?.[key] ?? obj?.[key.toLowerCase()] ?? null;
    }
    case "has": {
      const key = String(A(1));
      const obj = v[2] !== undefined ? A(2) : ctx.props;
      return obj != null && key in obj;
    }
    case "properties": return ctx.props || {};
    case "zoom": return ctx.zoom;
    case "geometry-type": warnOnce(warnings, '["geometry-type"] はジオメトリ情報を持たないため評価不能(null)'); return null;
    case "id": return ctx.props?.id ?? ctx.props?.ID ?? null;
    case "at": { const arr = A(2); const i = Number(A(1)); return Array.isArray(arr) && arr.length ? arr[i] ?? null : null; }
    case "in": case "!in": {
      const needle = A(1);
      const rest = v.slice(2).map(x => evalExpr(x, ctx, warnings));
      const hay = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
      const hit = hay.includes(needle);
      return op === "in" ? hit : !hit;
    }
    case "index-of": { const n = A(1); const hay = Array.isArray(A(2)) ? A(2) : String(A(2) ?? ""); return hay.indexOf(n); }
    case "==": case "!=": case "<": case "<=": case ">": case ">=": {
      const a = A(1), b = A(2);
      const [x, y] = (typeof a === "number" || typeof b === "number") ? [Number(a), Number(b)] : [a, b];
      const r = op === "==" ? x === y : op === "!=" ? x !== y
        : op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
      return v.length > 3 ? r && evalExpr([op, ...[v[2], ...v.slice(3)]], ctx, warnings) : r;
    }
    case "all": return v.slice(1).every(x => !!evalExpr(x, ctx, warnings));
    case "any": return v.slice(1).some(x => !!evalExpr(x, ctx, warnings));
    case "none": return !v.slice(1).some(x => !!evalExpr(x, ctx, warnings));
    case "!": return !A(1);
    case "case": {
      for (let i = 1; i + 1 < v.length; i += 2) if (evalExpr(v[i], ctx, warnings)) return evalExpr(v[i + 1], ctx, warnings);
      return v.length % 2 === 0 ? evalExpr(v[v.length - 1], ctx, warnings) : null;
    }
    case "match": {
      const input = A(1);
      for (let i = 2; i + 1 < v.length; i += 2) {
        const labels = Array.isArray(v[i]) ? v[i] : [v[i]];
        if (labels.includes(input)) return evalExpr(v[i + 1], ctx, warnings);
      }
      return v.length > 3 ? evalExpr(v[v.length - 1], ctx, warnings) : null;
    }
    case "step": {
      // ["step", input, out0, z1, out1, ...]。input==null は最終出力(凡例/プレビュー)
      let input = A(1);
      if (input == null || !Number.isFinite(Number(input))) input = Infinity;
      input = Number(input);
      let out = evalExpr(v[2], ctx, warnings);
      for (let i = 3; i + 1 < v.length; i += 2) {
        if (input >= Number(evalExpr(v[i], ctx, warnings))) out = evalExpr(v[i + 1], ctx, warnings);
      }
      return out;
    }
    case "interpolate": case "interpolate-hcl": case "interpolate-lab": {
      if (op !== "interpolate") warnOnce(warnings, `"${op}" は linear/RGB 近似です`);
      const spec = v[1];
      const interpType = Array.isArray(spec) ? spec[0] : null;
      const base = interpType === "exponential" ? Number(spec[1]) || 1 : 1;
      if (interpType && !["linear", "exponential", "cubic-bezier"].includes(interpType))
        warnOnce(warnings, `interpolate 種別 "${interpType}" は未対応(linear 近似)`);
      if (interpType === "cubic-bezier") warnOnce(warnings, "interpolate cubic-bezier は linear 近似です");
      let input = A(2);
      if (input == null || !Number.isFinite(Number(input))) input = Infinity;
      input = Number(input);
      const stops = [];
      for (let i = 3; i + 1 < v.length; i += 2)
        stops.push([Number(evalExpr(v[i], ctx, warnings)), v[i + 1]]);
      if (!stops.length) return null;
      if (input <= stops[0][0]) return evalExpr(stops[0][1], ctx, warnings);
      if (input >= stops[stops.length - 1][0]) return evalExpr(stops.at(-1)[1], ctx, warnings);
      for (let i = 0; i + 1 < stops.length; i++) {
        const [z0, o0] = stops[i];
        const [z1, o1] = stops[i + 1];
        if (input < z0 || input > z1) continue;
        // exponential base: t = (base^input -1)/(base^z1 - base^z0 正規形)
        let t = base === 1 ? (input - z0) / (z1 - z0)
          : (Math.pow(base, input - z0) - 1) / (Math.pow(base, z1 - z0) - 1);
        const c0 = isColorLike(o0) ? toColorNums(evalExpr(o0, ctx, warnings)) : null;
        const c1 = isColorLike(o1) ? toColorNums(evalExpr(o1, ctx, warnings)) : null;
        if (c0 && c1) return c0.map((a, k) => a + (c1[k] - a) * t);
        const n0 = Number(evalExpr(o0, ctx, warnings)), n1 = Number(evalExpr(o1, ctx, warnings));
        if (Number.isFinite(n0) && Number.isFinite(n1)) return n0 + (n1 - n0) * t;
        return input < (z0 + z1) / 2 ? evalExpr(o0, ctx, warnings) : evalExpr(o1, ctx, warnings);
      }
      return evalExpr(stops.at(-1)[1], ctx, warnings);
    }
    case "coalesce": for (let i = 1; i < v.length; i++) { const x = A(i); if (x != null) return x; } return null;
    case "to-number": case "number": { const n = Number(A(1)); return Number.isFinite(n) ? n : null; }
    case "to-string": case "string": { const x = A(1); return x == null ? "" : String(x); }
    case "to-boolean": case "boolean": return !!A(1);
    case "to-color": { const x = A(1); return toSpecColor(x) ?? toColorNums(x) ?? null; }
    case "typeof": { const x = A(1); return x === null ? "null" : Array.isArray(x) ? "array" : typeof x; }
    case "concat": return v.slice(1).map(x => { const s = evalExpr(x, ctx, warnings); return s == null ? "" : String(s); }).join("");
    case "format": return v.slice(1).filter((_, i) => i % 2 === 0)
      .map(x => { const s = evalExpr(x, ctx, warnings); return s == null ? "" : String(s); }).join("");
    case "upcase": return String(A(1) ?? "").toUpperCase();
    case "downcase": return String(A(1) ?? "").toLowerCase();
    case "length": { const x = A(1); return x?.length ?? null; }
    case "slice": { const x = A(1); return x?.slice?.(Number(A(2)), v[3] !== undefined ? Number(A(3)) : undefined) ?? null; }
    case "+": return v.slice(1).reduce((a, x) => a + Number(evalExpr(x, ctx, warnings) || 0), 0);
    case "-": return v.length === 2 ? -Number(A(1)) : Number(A(1)) - Number(A(2));
    case "*": return v.slice(1).reduce((a, x) => a * Number(evalExpr(x, ctx, warnings) ?? 1), 1);
    case "/": { const b = Number(A(2)); return b ? Number(A(1)) / b : null; }
    case "%": { const b = Number(A(2)); return b ? Number(A(1)) % b : null; }
    case "^": return Math.pow(Number(A(1)), Number(A(2)));
    case "abs": return Math.abs(Number(A(1)));
    case "min": return Math.min(...v.slice(1).map(x => Number(evalExpr(x, ctx, warnings))));
    case "max": return Math.max(...v.slice(1).map(x => Number(evalExpr(x, ctx, warnings))));
    case "round": return Math.round(Number(A(1)));
    case "floor": return Math.floor(Number(A(1)));
    case "ceil": return Math.ceil(Number(A(1)));
    case "sqrt": return Math.sqrt(Number(A(1)));
    case "ln": return Math.log(Number(A(1)));
    case "ln2": return Math.log2(Number(A(1)));
    case "log10": return Math.log10(Number(A(1)));
    case "log2": return Math.log2(Number(A(1)));
    case "sin": return Math.sin(Number(A(1)));
    case "cos": return Math.cos(Number(A(1)));
    case "tan": return Math.tan(Number(A(1)));
    case "rgb": return [Number(A(1)), Number(A(2)), Number(A(3)), 1];
    case "rgba": return [Number(A(1)), Number(A(2)), Number(A(3)), Number(A(4))];
    case "let": {
      const vars = { ...(ctx.vars || {}) };
      const body = v[v.length - 1];
      for (let i = 1; i + 1 < v.length - 1; i += 2) vars[String(v[i])] = evalExpr(v[i + 1], ctx, warnings);
      return evalExpr(body, { ...ctx, vars }, warnings);
    }
    case "var": return ctx.vars?.[String(v[1])] ?? null;
    default:
      warnOnce(warnings, `式演算子 "${op}" は未対応(null 扱い)`);
      return null;
  }
}

// ---- layer.filter → props 評価関数 ----
// レガシー形式(["==","key",val] 等)と式形式を識別して扱う
const FILTER_OPS = new Set(["==", "!=", ">", ">=", "<", "<=", "in", "!in", "has", "!has"]);
function compileMbFilter(filter, warnings, layerId = "") {
  if (!Array.isArray(filter) || !filter.length) return null;
  const op = filter[0];
  if (op === "all" || op === "any" || op === "none") {
    const fns = filter.slice(1).map(f => compileMbFilter(f, warnings, layerId)).filter(Boolean);
    if (!fns.length) return null;
    return props => op === "all" ? fns.every(f => f(props))
      : op === "any" ? fns.some(f => f(props)) : !fns.some(f => f(props));
  }
  if (op === "!") {
    const f = compileMbFilter(filter[1], warnings, layerId);
    return f ? (props => !f(props)) : null;
  }
  if (FILTER_OPS.has(op)) {
    const key = String(filter[1] ?? "");
    // 第2引数が式(配列)なら式形式として評価する。$type はジオメトリ
    // 情報を持たないため適合扱い(描画要素がジオメトリ種別で選別される)
    if (key === "$type") {
      warnOnce(warnings, `filter の $type はジオメトリ情報を持たないため全適合扱いです(${layerId})`);
      return () => true;
    }
    if (op === "has" || op === "!has") {
      return props => (props != null && Object.prototype.hasOwnProperty.call(props, key)) === (op === "has");
    }
    const valOf = props => props?.[key];
    if (op === "in" || op === "!in") {
      const hay = filter.slice(2);
      return props => (hay.includes(valOf(props))) === (op === "in");
    }
    const literal = filter[2];
    const cmp = { "==": (a, b) => a === b, "!=": (a, b) => a !== b,
      ">": (a, b) => Number(a) > Number(b), ">=": (a, b) => Number(a) >= Number(b),
      "<": (a, b) => Number(a) < Number(b), "<=": (a, b) => Number(a) <= Number(b) }[op];
    return props => cmp(valOf(props), literal);
  }
  // 上記以外は式として評価し truthy を適合とみなす
  return props => !!evalExpr(filter, { props, zoom: null }, warnings);
}

// ---- gpkgext_symbols/symbol_content → アイコン画像マップ ----
// icon-image が参照する名前(シンボル名/uri)ごとに ImageBitmap を返す。
// スプライト領域(offset_x/y+width/height)は切出す。pixelRatio は保持
async function gpkgSymbolImageMap(symbols, warnings) {
  const map = new Map();
  for (const s of symbols || []) {
    for (const img of s.images || []) {
      if (!img.dataBase64) continue;
      try {
        const bin = atob(img.dataBase64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        let bmp = await createImageBitmap(new Blob([u8], { type: img.format || "image/png" }));
        if ((img.offsetX || img.offsetY) && img.width && img.height)
          bmp = await createImageBitmap(bmp, img.offsetX || 0, img.offsetY || 0, img.width, img.height);
        const entry = { bitmap: bmp, pixelRatio: Number(img.pixelRatio) || 1 };
        for (const name of new Set([s.symbol, s.uri, img.uri].filter(Boolean).map(String)))
          if (!map.has(name)) map.set(name, entry);
      } catch (e) { warnOnce(warnings, `gpkgext シンボル "${s.symbol}" の画像デコード失敗`); }
    }
  }
  return map;
}

// mbstyle sprite(URL or [{id,url}]) → {name: {bitmap, pixelRatio}} へ追加
async function installMbstyleSpriteImages(spriteSpec, baseUrl, iconImages, warnings) {
  const entries = Array.isArray(spriteSpec)
    ? spriteSpec.filter(s => s?.url).map(s => ({ id: String(s.id || ""), url: s.url }))
    : (spriteSpec ? [{ id: "", url: String(spriteSpec) }] : []);
  for (const sp of entries) {
    const base = resolveKascUrl(sp.url, baseUrl);
    try {
      const meta = await (await fetch(`${base}.json`)).json();
      const img = await createImageBitmap(await (await fetch(`${base}.png`)).blob());
      for (const [name, d] of Object.entries(meta || {})) {
        if (!d || !Number.isFinite(d.width)) continue;
        const id = sp.id ? `${sp.id}/${name}` : name;
        if (iconImages.has(id)) continue;
        const part = await createImageBitmap(img, d.x, d.y, d.width, d.height);
        iconImages.set(id, { bitmap: part, pixelRatio: d.pixelRatio || 1, sdf: !!d.sdf });
      }
    } catch (e) { warnOnce(warnings, `mbstyle sprite ${base} の読込に失敗しました`); }
  }
}

// gpkgext_fonts の TTF/OTF → DOM FontFace(glyphs pbf は MapLibre 専用)
async function installGpkgFontsDom(fonts) {
  let n = 0;
  for (const f of fonts || []) {
    if (!f?.fontBase64 || !f?.name) continue;
    try {
      const bin = atob(f.fontBase64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const face = new FontFace(String(f.name), u8);
      await face.load();
      document.fonts.add(face);
      n++;
    } catch (e) { /* 不正フォントは静黙スキップ */ }
  }
  return n;
}

// ---- 数値/色/文字列の paint/layout 値評価 ----
const numVal = (v, ctx, warnings, dflt = null) => {
  if (v === undefined) return dflt;
  const n = Number(evalExpr(v, ctx, warnings));
  return Number.isFinite(n) ? n : dflt;
};
const strVal = (v, ctx, warnings, dflt = null) => {
  if (v === undefined) return dflt;
  const s = evalExpr(v, ctx, warnings);
  return s == null ? dflt : String(s);
};
const colorVal = (v, ctx, warnings, opacity = 1) => {
  if (v === undefined) return null;
  return toSpecColor(evalExpr(v, ctx, warnings), opacity);
};

// ---- レイヤ → frag ビルダ ----
// frag = {markers, lines, fillParts, outline, label}(sld-style.js と同形)
function compileMbLayer(lyr, iconImages, warnings) {
  const type = String(lyr.type || "");
  const paint = lyr.paint || {};
  const layout = lyr.layout || {};
  const knownPaint = new Set(Object.keys(paint));
  const skipPaint = (allowed, kind) => {
    for (const k of knownPaint) if (!allowed.has(k))
      warnOnce(warnings, `${type} レイヤの ${k} は未対応です(${lyr.id || "?"})`);
  };

  switch (type) {
    case "fill": {
      skipPaint(new Set(["fill-color", "fill-opacity", "fill-outline-color", "fill-antialias",
        "fill-sort-key", "fill-translate", "fill-translate-anchor"]), "paint");
      if (paint["fill-pattern"] !== undefined)
        warnOnce(warnings, `fill-pattern は未対応です(${lyr.id || "?"}・単色近似)`);
      return ctx => {
        const color = colorVal(paint["fill-color"] ?? "#000000", ctx, warnings,
          numVal(paint["fill-opacity"], ctx, warnings, 1) ?? 1);
        const frag = { markers: [], lines: [], fillParts: [], outline: null };
        if (color) frag.fillParts.push({ solid: color });
        const oc = colorVal(paint["fill-outline-color"], ctx, warnings, 1);
        if (oc) frag.outline = { color: oc, widthPx: 1, dash: null };
        return [frag];
      };
    }
    case "line": {
      skipPaint(new Set(["line-color", "line-opacity", "line-width", "line-dasharray",
        "line-cap", "line-join", "line-miter-limit", "line-round-limit", "line-sort-key",
        "line-blur", "line-translate", "line-translate-anchor", "line-gap-width",
        "line-offset", "line-gradient", "line-pattern", "line-trim-offset"]), "paint");
      for (const k of ["line-gradient", "line-pattern", "line-gap-width", "line-offset"])
        if (paint[k] !== undefined) warnOnce(warnings, `${k} は未対応です(${lyr.id || "?"})`);
      return ctx => {
        const color = colorVal(paint["line-color"] ?? "#000000", ctx, warnings,
          numVal(paint["line-opacity"], ctx, warnings, 1) ?? 1);
        const dashArr = evalExpr(paint["line-dasharray"], ctx, warnings);
        const frag = { markers: [], lines: [], fillParts: [], outline: null };
        frag.lines.push({
          color: color || [0, 0, 0, 1],
          widthPx: Math.max(numVal(paint["line-width"], ctx, warnings, 1) ?? 1, 0.1),
          dash: Array.isArray(dashArr) && dashArr.length >= 2 ? dashArr.map(Number) : null,
          join: { miter: "miter", round: "round", bevel: "bevel" }[strVal(layout["line-join"], ctx, warnings)] || null,
          cap: { butt: "butt", round: "round", square: "square" }[strVal(layout["line-cap"], ctx, warnings)] || null,
        });
        return [frag];
      };
    }
    case "circle": {
      skipPaint(new Set(["circle-color", "circle-opacity", "circle-radius", "circle-blur",
        "circle-stroke-color", "circle-stroke-opacity", "circle-stroke-width",
        "circle-sort-key", "circle-translate", "circle-translate-anchor",
        "circle-pitch-scale", "circle-pitch-alignment", "circle-emissive-strength"]), "paint");
      return ctx => {
        const r = Math.max(numVal(paint["circle-radius"], ctx, warnings, 5) ?? 5, 0.5);
        const fill = colorVal(paint["circle-color"] ?? "#000000", ctx, warnings,
          numVal(paint["circle-opacity"], ctx, warnings, 1) ?? 1);
        const stroke = colorVal(paint["circle-stroke-color"], ctx, warnings,
          numVal(paint["circle-stroke-opacity"], ctx, warnings, 1) ?? 1);
        const frag = { markers: [], lines: [], fillParts: [], outline: null };
        frag.markers.push({
          kind: "shape", shape: "circle", sizePx: r * 2,
          fill: fill || [0, 0, 0, 1],
          stroke, strokeWidthPx: numVal(paint["circle-stroke-width"], ctx, warnings, 0) ?? 0,
          alpha: 1,
        });
        return [frag];
      };
    }
    case "symbol": {
      return ctx => {
        const frag = { markers: [], lines: [], fillParts: [], outline: null, label: null };
        // ---- icon-image ----
        const iconName = layout["icon-image"] !== undefined ? strVal(layout["icon-image"], ctx, warnings) : null;
        if (iconName) {
          const hit = iconImages.get(iconName);
          const sizeScale = numVal(layout["icon-size"], ctx, warnings, 1) ?? 1;
          if (hit) {
            const off = evalExpr(layout["icon-offset"], ctx, warnings);
            const sizePx = Math.max((hit.bitmap.width / (hit.pixelRatio || 1)) * sizeScale, 1);
            // icon-offset は em 単位(アイコンの表示高=1em 相当)
            const emPx = (hit.bitmap.height / (hit.pixelRatio || 1)) * sizeScale;
            frag.markers.push({
              kind: "image", image: hit.bitmap,
              sizePx,
              rotationDeg: -(numVal(layout["icon-rotate"], ctx, warnings, 0) ?? 0),
              offsetPx: Array.isArray(off) && off.length >= 2 ? [Number(off[0]) * emPx, Number(off[1]) * emPx] : null,
              alpha: Math.min(1, Math.max(0, numVal(paint["icon-opacity"], ctx, warnings, 1) ?? 1)),
            });
          } else {
            warnOnce(warnings, `icon-image "${iconName}" の画像が見つかりません(${lyr.id || "?"}・円で代替)`);
            frag.markers.push({ kind: "shape", shape: "circle", sizePx: 8,
              fill: [0.2, 0.4, 0.9, 1], stroke: null, strokeWidthPx: 0, alpha: 1 });
          }
        }
        // ---- text-field → label ----
        if (layout["text-field"] !== undefined) {
          const transform = strVal(layout["text-transform"], ctx, warnings);
          const getText = props => {
            let s = evalExpr(layout["text-field"], { props, zoom: ctx.zoom, vars: ctx.vars }, warnings);
            if (s == null) s = "";
            s = String(s);
            // "{field}" テンプレート形式(旧記法)
            if (/\{[^}]+\}/.test(s) && s === String(layout["text-field"]))
              s = s.replace(/\{([^}]+)\}/g, (_, k) => props?.[k] ?? "");
            if (transform === "uppercase") s = s.toUpperCase();
            else if (transform === "lowercase") s = s.toLowerCase();
            return s;
          };
          const sizePx = Math.max(numVal(layout["text-size"], ctx, warnings, 16) ?? 16, 6);
          const fonts = layout["text-font"];
          const family = Array.isArray(fonts) && fonts.length ? String(fonts[0]) : "sans-serif";
          const fill = colorVal(paint["text-color"] ?? "#000000", ctx, warnings,
            numVal(paint["text-opacity"], ctx, warnings, 1) ?? 1) || [0, 0, 0, 1];
          const haloColor = colorVal(paint["text-halo-color"], ctx, warnings,
            numVal(paint["text-halo-opacity"], ctx, warnings, 1) ?? 1);
          const haloWidth = numVal(paint["text-halo-width"], ctx, warnings, 0) ?? 0;
          const anchor = strVal(layout["text-anchor"], ctx, warnings, "center") || "center";
          const quad = { h: 0, v: 0 };
          if (/left/.test(anchor)) quad.h = 1; else if (/right/.test(anchor)) quad.h = -1;
          if (/top/.test(anchor)) quad.v = -1; else if (/bottom/.test(anchor)) quad.v = 1;
          const off = evalExpr(layout["text-offset"], ctx, warnings);
          const radial = numVal(layout["text-radial-offset"], ctx, warnings, 0) ?? 0;
          const offsetXPx = (Array.isArray(off) ? Number(off[0]) || 0 : 0) * sizePx;
          const offsetYPx = -((Array.isArray(off) ? Number(off[1]) || 0 : 0) * sizePx + radial * sizePx);
          const rotDeg = -(numVal(layout["text-rotate"], ctx, warnings, 0) ?? 0);
          const isLine = layout["symbol-placement"] === "line";
          frag.label = {
            getText,
            sizePx, sizeUnit: "Pixel", sizeMeters: null,
            family, bold: /bold/i.test(family), italic: /italic|oblique/i.test(family),
            fontCss: `${Math.round(sizePx)}px ${family}`,
            fill,
            halo: haloColor && haloWidth > 0 ? { color: haloColor, widthPx: Math.max(haloWidth, 1) } : null,
            align: "center",
            letterSpacingPx: (numVal(layout["text-letter-spacing"], ctx, warnings, 0) ?? 0) * sizePx,
            wordSpacingPx: 0, kerning: true,
            placement: { quad, distPx: radial * sizePx, offsetXPx, offsetYPx,
              rotationDeg: rotDeg, alongLine: isLine, kind: isLine ? "line" : "point" },
            offsetXPx, offsetYPx, rotationDeg: rotDeg,
            pixelOffsetOf() {
              const pl = this.placement || {};
              const q = pl.quad || { h: 0, v: 0 };
              return [
                (pl.offsetXPx || 0) + (q.h || 0) * (pl.distPx || 0),
                -((pl.offsetYPx || 0) + (q.v || 0) * (pl.distPx || 0)),
              ];
            },
            displayAll: layout["text-allow-overlap"] === true,
            labelScale: null, priority: null,
            drawLabels: true, show: true,
            background: null, shadow: null, callout: null, substitutions: null,
          };
          for (const k of ["text-max-width", "text-line-height", "text-padding",
            "text-justify", "text-variable-anchor", "text-writing-mode", "icon-text-fit"])
            if (layout[k] !== undefined) warnOnce(warnings, `symbol の ${k} は未対応です(${lyr.id || "?"})`);
        }
        return frag.markers.length || frag.label ? [frag] : [];
      };
    }
    case "background": case "sky":
      return null; // 地物レイヤではないため静黙スキップ
    default:
      warnOnce(warnings, `レイヤ型 "${type}" は未対応です(${lyr.id || "?"})`);
      return null;
  }
}

// ---- OGC 24-050 Portrayal: シート選択 ----
// 24-049 sa_reference で地物表の GeoDataClass(sa_id)とスタイル行の
// GeoDataClass が一致するか判定。annotation 未整備の GPKG では誤適用を
// 避け、地物表が1枚だけの時に限り適用する(draft の簡易解釈。
// maplibre applyGpkgPortrayal と同一ロジックの共有版)
export function gpkgSheetAppliesToTable(sh, table, reg) {
  const refs = reg.annotationRefs || [];
  if (!refs.length) return (reg.featureTables || []).length <= 1;
  const tableSas = new Set(refs.filter(r => r.table === table).map(r => r.saId));
  for (const r of refs) {
    if (r.table === "gpkgext_styles" && Number(r.key) === Number(sh.styleId) && tableSas.has(r.saId)) return true;
  }
  return false;
}

// reg(gpkgStyleRegistry 戻り値)から本テーブルへ適用する mbstyle シートを
// 抽出する。gpkgstyle= はスタイル名/uri での直接選択に使う。
// 戻り値: [{ sheet, style, mbstyle }](mbstyle は JSON.parse 済み)
export function selectGpkgMbstyleSheets(reg, { table = "", gpkgstyle = "" } = {}) {
  const wantName = String(gpkgstyle || "");
  const styleRows = new Map((reg?.styles?.list || []).map(s => [s.id, s]));
  const out = [];
  for (const sh of reg?.sheets || []) {
    if (String(sh.format).toLowerCase() !== "mbstyle" || !sh.data) continue;
    const style = styleRows.get(sh.styleId);
    if (wantName && style?.style !== wantName && style?.uri !== wantName) continue;
    if (!gpkgSheetAppliesToTable(sh, table, reg)) continue;
    let mbstyle;
    try { mbstyle = JSON.parse(sh.data); } catch (e) { continue; }
    out.push({ sheet: sh, style, mbstyle });
  }
  return out;
}

// ---- mbstyle → compileQmlStyle 互換 spec ----
// mbstyles: mbstyle JSON(単一 or 複数シートの配列。複数はレイヤを連結)
// symbols: gpkgStyleRegistry の symbols 配列(gpkgsym 画像解決用。省略可)
// fonts:   gpkgStyleRegistry の fonts 配列(TTF/OTF を FontFace 登録。省略可)
export async function compileMbstyle(mbstyles, baseUrl = null, engine = null, symbols = null, fonts = null) {
  const sheets = Array.isArray(mbstyles) ? mbstyles : [mbstyles];
  const warnings = new Set();
  const iconImages = await gpkgSymbolImageMap(symbols, warnings);
  // 全シートの sprite を画像マップへ登録
  for (const st of sheets) {
    if (st?.sprite) await installMbstyleSpriteImages(st.sprite, baseUrl, iconImages, warnings);
  }
  if (fonts?.length) await installGpkgFontsDom(fonts).catch(() => 0);

  // レイヤ → ルール(visibility:"none" と未対応型は除外)
  const rules = [];
  for (const st of sheets) {
    const srcIds = new Set(Object.keys(st?.sources || {}));
    for (const lyr of st?.layers || []) {
      if (!lyr || lyr.type === "background") continue;
      if (srcIds.size && lyr.source && !srcIds.has(lyr.source)) continue;
      const build = compileMbLayer(lyr, iconImages, warnings);
      if (!build) continue;
      const zMin = Number.isFinite(Number(lyr.minzoom)) ? Number(lyr.minzoom) : null;
      const zMax = Number.isFinite(Number(lyr.maxzoom)) ? Number(lyr.maxzoom) : null;
      rules.push({
        name: String(lyr.id || `layer-${rules.length}`),
        title: String(lyr.id || `layer-${rules.length}`),
        filter: compileMbFilter(lyr.filter, warnings, lyr.id),
        // zoom(512px 基準) → 分母へ。minzoom(引き側)=大分母 → scale.max、
        // maxzoom(寄り側)=小分母 → scale.min(visible: min ≤ cur ≤ max)
        scaleMin: zMax != null ? zoomToDenom(zMax) : 0,
        scaleMax: zMin != null ? zoomToDenom(zMin) : 0,
        build,
      });
    }
  }
  if (!rules.length) throw new Error("mbstyle に適用可能なレイヤがありません");

  // ルール照合(縮尺ゲート込み)→ 一致ルールの frag を構築
  const matchFrags = props => {
    const cur = evalScaleDenom();
    const zoom = cur ? denomToZoom(cur) : null;
    const frags = [];
    let scale = null;
    for (const r of rules) {
      if (cur != null && ((r.scaleMin > 0 && cur < r.scaleMin) || (r.scaleMax > 0 && cur > r.scaleMax))) continue;
      if (r.filter) {
        let hit;
        try { hit = !!r.filter(props || {}); } catch (e) { hit = false; }
        if (!hit) continue;
      }
      try { frags.push(...r.build({ props: props || {}, zoom, vars: {} })); } catch (e) { /* 地物毎の失敗は静黙 */ }
      if (r.scaleMin || r.scaleMax) {
        // 一致ルール群の範囲ユニオン: near=最小距離(寄り側=小分母)・
        // far=最大距離(引き側=大分母。未指定ルールは無制限=Infinity)
        scale = {
          near: Math.min(scale?.near ?? Infinity, r.scaleMin ? scaleToDist(r.scaleMin) : 0),
          far: r.scaleMax ? Math.max(scale?.far || 0, scaleToDist(r.scaleMax)) : Infinity,
        };
      }
    }
    return { frags, scale };
  };

  const fragsToSpec = (frags, scale) => {
    const out = { markers: null, line: null, lines: null, fillParts: null, outline: null, centroid: null, scale };
    for (const f of frags) {
      if (f.markers?.length) (out.markers ||= []).push(...f.markers);
      if (f.lines?.length) (out.lines ||= []).push(...f.lines);
      if (f.fillParts?.length) (out.fillParts ||= []).push(...f.fillParts);
      if (f.outline) out.outline = f.outline;
    }
    if (out.lines?.length) out.line = out.lines[0];
    return out;
  };

  const evaluate = props => {
    const { frags, scale } = matchFrags(props);
    if (!frags.length) return null;
    return fragsToSpec(frags, scale);
  };

  const labelFor = props => {
    const { frags } = matchFrags(props);
    const lab = frags.map(f => f.label).find(Boolean);
    if (!lab) return null;
    const text = lab.getText(props || {});
    if (!String(text ?? "").trim()) return null;
    return { ...lab, text: String(text), show: true };
  };

  const namesFor = props => {
    const cur = evalScaleDenom();
    const names = [];
    for (const r of rules) {
      if (cur != null && ((r.scaleMin > 0 && cur < r.scaleMin) || (r.scaleMax > 0 && cur > r.scaleMax))) continue;
      const hit = !r.filter ? true : (() => { try { return !!r.filter(props || {}); } catch (e) { return false; } })();
      if (hit) names.push(r.name);
    }
    return names;
  };

  const legend = rules.map(r => ({
    label: r.title || r.name,
    symbolName: r.name,
    spec: fragsToSpec((() => { try { return r.build({ props: {}, zoom: null, vars: {} }); } catch (e) { return []; } })(), null),
  }));

  const ruleScales = rules.filter(r => r.scaleMin || r.scaleMax).map(r => ({ min: r.scaleMin, max: r.scaleMax }));
  const hasLabel = rules.some(r => {
    try { return r.build({ props: {}, zoom: null, vars: {} }).some(f => f.label); } catch (e) { return false; }
  });
  return {
    evaluate,
    namesFor,
    labelFor: hasLabel ? labelFor : null,
    legend,
    warnings: [...warnings],
    unsupported: warnings.size > 0,
    symbolLevels: false,
    heatmap: null, cluster: null, inverted: false, d25: null, diagram: null,
    symbols: new Map(),
    ruleScales: ruleScales.length ? ruleScales : null,
    layerScale: null,
    images: new Map(),
    fields: null, displayFor: null,
    usesMapScale: false, usesLayerVisibility: false,
    scaleDependent: ruleScales.length > 0,
    mbstyleLayers: rules.length,
  };
}
