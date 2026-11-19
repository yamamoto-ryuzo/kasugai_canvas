// SLD/SE (Styled Layer Descriptor / Symbology Encoding) サブセット →
// compileQmlStyle 互換 spec へのコンパイラ。
// 対象: GeoPackage layer_styles.styleSLD / gpkgext_stylesheets format="sld"
// のような SLD テキスト。SLD 1.0/1.1 の実用サブセット:
//   NamedLayer/UserStyle/FeatureTypeStyle/Rule
//   Filter: PropertyIsEqualTo/NotEqualTo/GreaterThan(+OrEqual)/LessThan(+OrEqual)/
//           PropertyIsBetween/PropertyIsLike(wildcard)/PropertyIsNull + And/Or/Not
//   ElseFilter(その他ルール)
//   PointSymbolizer(Graphic→Mark: WellKnownName circle/square/triangle/star/
//           cross/x + Fill/Stroke + Size/Opacity, ExternalGraphic: data URI・
//           http(s) URL・gpkgsym: URI → symbolImages マップ経由)
//   LineSymbolizer(Stroke: stroke/stroke-width/stroke-opacity/stroke-dasharray)
//   PolygonSymbolizer(Fill: fill/fill-opacity + Stroke)
//   Min/MaxScaleDenominator → spec.scale の概算距離ゲート(compileQmlStyle と同じ換算)
// 未対応は警告化(静黙ドロップしない): RasterSymbolizer/
//   Function 式/Displacement 以外の配置/Geometry 変換/VendorOption 等。
//
// 返却 spec は compileQmlStyle と同じキーを持つ(evaluate/namesFor/legend/
// warnings/fields=null/usesMapScale=false …)。エンジン側の消費経路は
// そのまま共有できる(item.qmlStyle/item._qml へ代入するだけで全エンジン適用)。

// ---- ヘルパ ----
const lname = el => (el?.localName || el?.tagName || "").split(":").pop();
const kids = (el, name) => {
  const out = [];
  for (const c of el?.children || []) if (lname(c) === name) out.push(c);
  return out;
};
const first = (el, name) => kids(el, name)[0] || null;
// 深さ優先で最初の子孫要素を取得(直下優先)
const deepFirst = (el, name) => {
  if (!el) return null;
  for (const c of el.children || []) {
    if (lname(c) === name) return c;
    const hit = deepFirst(c, name);
    if (hit) return hit;
  }
  return null;
};
const textOf = el => el?.textContent?.trim() || "";

// CssParameter/SvgParameter の name→値 マップ
function cssParams(el) {
  const m = {};
  const walk = e => {
    for (const c of e?.children || []) {
      const n = lname(c);
      if (n === "CssParameter" || n === "SvgParameter") {
        m[c.getAttribute("name")] = textOf(c);
      } else walk(c);
    }
  };
  walk(el);
  return m;
}

// #rgb/#rrggbb/#rrggbbaa → [r,g,b,a](0-1)。opacity は乗算
function parseSldColor(v, opacity = 1) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(v || "").trim());
  let r = 0, g = 0, b = 0, a = Number(opacity);
  if (!Number.isFinite(a)) a = 1;
  a = Math.min(1, Math.max(0, a));
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join("");
    r = parseInt(h.slice(0, 2), 16) / 255;
    g = parseInt(h.slice(2, 4), 16) / 255;
    b = parseInt(h.slice(4, 6), 16) / 255;
    if (h.length === 8) a *= parseInt(h.slice(6, 8), 16) / 255;
  }
  return [r, g, b, a];
}

// "2 4" / "2,4" → [2,4]
function parseDash(v) {
  const m = String(v || "").trim().match(/[\d.]+/g);
  return m && m.length >= 2 ? m.map(Number) : null;
}

// ---- ogc:Filter → props 評価関数 ----
function operandValue(el, props) {
  if (!el) return null;
  const n = lname(el);
  if (n === "PropertyName") {
    const key = textOf(el);
    return props?.[key] ?? props?.[key.toLowerCase()] ?? null;
  }
  if (n === "Literal") return textOf(el);
  // Function/Add/Sub 等はサブセット外(呼び出し側が警告済み)
  return null;
}
function numCoerce(a, b) {
  const na = Number(a), nb = Number(b);
  return (a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) ? [na, nb] : [a, b];
}
function compileSldFilter(fel) {
  if (!fel) return null;
  const inner = [...(fel.children || [])].find(c => lname(c) !== "description");
  if (!inner) return null;
  const n = lname(inner);
  if (n === "And") {
    const fns = kids(inner, "Filter").length ? [] : [...(inner.children || [])].map(compileSldFilterEl).filter(Boolean);
    return props => fns.every(f => f(props));
  }
  if (n === "Or") {
    const fns = [...(inner.children || [])].map(compileSldFilterEl).filter(Boolean);
    return props => fns.some(f => f(props));
  }
  if (n === "Not") {
    const fn = [...(inner.children || [])].map(compileSldFilterEl).filter(Boolean)[0];
    return fn ? (props => !fn(props)) : null;
  }
  const cmp = {
    PropertyIsEqualTo: (a, b) => { const [x, y] = numCoerce(a, b); return x === y; },
    PropertyIsNotEqualTo: (a, b) => { const [x, y] = numCoerce(a, b); return x !== y; },
    PropertyIsLessThan: (a, b) => Number(a) < Number(b),
    PropertyIsGreaterThan: (a, b) => Number(a) > Number(b),
    PropertyIsLessThanOrEqualTo: (a, b) => Number(a) <= Number(b),
    PropertyIsGreaterThanOrEqualTo: (a, b) => Number(a) >= Number(b),
  }[n];
  if (cmp) {
    const ops = (inner.children || []).filter(c => ["PropertyName", "Literal"].includes(lname(c)));
    if (ops.length < 2) return null;
    return props => cmp(operandValue(ops[0], props), operandValue(ops[1], props));
  }
  if (n === "PropertyIsBetween") {
    const pn = first(inner, "PropertyName");
    const lo = deepFirst(first(inner, "LowerBoundary") || inner, "Literal");
    const hi = deepFirst(first(inner, "UpperBoundary") || inner, "Literal");
    if (!pn || !lo || !hi) return null;
    const key = textOf(pn);
    return props => {
      const v = Number(props?.[key]);
      return Number.isFinite(v) && v >= Number(textOf(lo)) && v <= Number(textOf(hi));
    };
  }
  if (n === "PropertyIsLike") {
    const pn = first(inner, "PropertyName");
    const lit = first(inner, "Literal");
    if (!pn || !lit) return null;
    const wild = inner.getAttribute("wildCard") ?? "%";
    const single = inner.getAttribute("singleChar") ?? "_";
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pat = textOf(lit).split("").map(c =>
      c === wild ? ".*" : c === single ? "." : esc(c)).join("");
    const re = new RegExp(`^${pat}$`);
    const key = textOf(pn);
    return props => re.test(String(props?.[key] ?? ""));
  }
  if (n === "PropertyIsNull") {
    const pn = first(inner, "PropertyName");
    if (!pn) return null;
    const key = textOf(pn);
    return props => props?.[key] == null;
  }
  return null; // 未対応フィルタ要素
}
function compileSldFilterEl(el) {
  return lname(el) === "Filter" ? compileSldFilter(el) : compileSldFilter({ children: [el] });
}

// ---- 縮尺分母 → 概算距離(compileQmlStyle の toDist と同一換算) ----
const sldScaleToDist = s => (s > 0 ? s * 0.00028 * 900 / (2 * Math.tan(Math.PI / 6)) : 0);

// WellKnownName → MARKER_SHAPES 名(drawMarkerLayerTo と共有)
const SLD_MARKS = {
  circle: "circle", square: "square", triangle: "triangle",
  star: "star", cross: "cross", x: "x",
  "ttf://": null, // ttf://font#code はフォントグリフ(未対応警告)
};

// ---- シンボライザ → spec 断片 ----
// 返り値 {markers, lines, fillParts, outline, warnings}
function compileSymbolizer(symEl, baseUrl, symbolImages, images, warnings) {
  const out = { markers: [], lines: [], fillParts: [], outline: null };
  const n = lname(symEl);
  if (n === "LineSymbolizer") {
    const p = cssParams(deepFirst(symEl, "Stroke"));
    const color = parseSldColor(p.stroke ?? "#404040", p["stroke-opacity"]);
    out.lines.push({
      color,
      widthPx: Number(p["stroke-width"]) || 1,
      dash: parseDash(p["stroke-dasharray"]),
    });
  } else if (n === "PolygonSymbolizer") {
    const fillEl = deepFirst(symEl, "Fill");
    const fp = cssParams(fillEl);
    const hasGraphicFill = !!deepFirst(fillEl, "GraphicFill");
    if (hasGraphicFill) warnings.add("PolygonSymbolizer の GraphicFill(パターン塗り)は未対応のため単色近似なし");
    else if (fp.fill !== undefined || fp["fill-opacity"] !== undefined) {
      out.fillParts.push({ solid: parseSldColor(fp.fill ?? "#808080", fp["fill-opacity"]) });
    }
    const strokeEl = deepFirst(symEl, "Stroke");
    if (strokeEl) {
      const sp = cssParams(strokeEl);
      if (sp.stroke !== undefined || sp["stroke-opacity"] !== undefined || sp["stroke-width"] !== undefined) {
        out.outline = {
          color: parseSldColor(sp.stroke ?? "#404040", sp["stroke-opacity"]),
          widthPx: Number(sp["stroke-width"]) || 1,
          dash: parseDash(sp["stroke-dasharray"]),
        };
      }
    }
  } else if (n === "PointSymbolizer") {
    const graphic = deepFirst(symEl, "Graphic");
    const opacity = Number(textOf(first(symEl, "Opacity")) || 1);
    if (!graphic) { warnings.add("PointSymbolizer に Graphic がありません"); return out; }
    // SLD の Size はマーカ全体の幅(px)。MARKER_SHAPES 系の sizePx も全体幅なので一致
    const size = Number(textOf(first(graphic, "Size")) || 8);
    const mark = deepFirst(graphic, "Mark");
    const ext = deepFirst(graphic, "ExternalGraphic");
    if (mark) {
      const well = textOf(deepFirst(mark, "WellKnownName")) || "circle";
      const shape = SLD_MARKS[well.toLowerCase()];
      if (shape === null || shape === undefined && !(well.toLowerCase() in SLD_MARKS)) {
        warnings.add(`Mark の WellKnownName "${well}" は未対応です(circle 近似)`);
      }
      const fp = cssParams(deepFirst(mark, "Fill"));
      const sp = cssParams(deepFirst(mark, "Stroke"));
      out.markers.push({
        kind: "shape", shape: shape || "circle",
        sizePx: Math.max(size, 2),
        fill: parseSldColor(fp.fill ?? "#808080", (fp["fill-opacity"] ?? 1) * opacity),
        stroke: sp.stroke !== undefined || sp["stroke-width"] !== undefined
          ? parseSldColor(sp.stroke ?? "#000000", sp["stroke-opacity"]) : null,
        strokeWidthPx: Number(sp["stroke-width"]) || 0,
        alpha: Number.isFinite(opacity) ? opacity : 1,
      });
    } else if (ext) {
      const href = first(ext, "OnlineResource")?.getAttribute("xlink:href")
        || first(ext, "OnlineResource")?.getAttribute("href") || "";
      // gpkgsym: URI → GeoPackage gpkgext_symbols の画像(symbolImages マップ)
      const img = symbolImages?.get(href) || symbolImages?.get(href.replace(/^gpkgsym:(:|\/{1,2})/, "")) || null;
      if (img) {
        out.markers.push({ kind: "image", image: img, sizePx: Math.max(size, 2), alpha: Number.isFinite(opacity) ? opacity : 1 });
      } else if (/^data:image\//i.test(href)) {
        const el = new Image();
        el.src = href;
        images.set(href, el);
        out.markers.push({ kind: "image", image: el, sizePx: Math.max(size, 2), alpha: Number.isFinite(opacity) ? opacity : 1 });
      } else if (/^https?:\/\//i.test(href) && baseUrl) {
        warnings.add(`ExternalGraphic の外部画像 ${href} は未対応です(gpkgsym:/data: URI のみ)`);
      } else if (href) {
        warnings.add(`ExternalGraphic の参照 ${href} は解決できません(gpkgsym:/data: URI のみ)`);
      }
    } else {
      warnings.add("PointSymbolizer の Graphic に Mark/ExternalGraphic がありません");
    }
  } else if (n === "TextSymbolizer") {
    // Label: <PropertyName>/Literal の連結(式関数は警告して省略)
    const labelEl = deepFirst(symEl, "Label");
    const labelParts = [];
    for (const c of labelEl?.children || []) {
      const ln = lname(c);
      if (ln === "PropertyName") labelParts.push({ t: "field", v: textOf(c) });
      else if (ln === "Literal") labelParts.push({ t: "lit", v: textOf(c) });
      else warnings.add(`TextSymbolizer Label の ${ln}(式)は未対応のため省略します`);
    }
    const litText = labelEl && !(labelEl.children?.length) ? textOf(labelEl) : "";
    if (!labelParts.length && !litText) { warnings.add("TextSymbolizer の Label が空です"); return out; }
    const getText = props => labelParts.length
      ? labelParts.map(p => p.t === "field" ? (props?.[p.v] ?? props?.[p.v?.toLowerCase?.()] ?? "") : p.v).join("")
      : litText;

    const font = cssParams(deepFirst(symEl, "Font"));
    const family = font["font-family"] || "sans-serif";
    const sizePx = Math.max(Number(font["font-size"]) || 10, 6);
    const bold = /bold|demi/i.test(font["font-weight"] || "");
    const italic = /italic|oblique/i.test(font["font-style"] || "");
    const fp = cssParams(deepFirst(symEl, "Fill"));
    const haloEl = deepFirst(symEl, "Halo");
    let halo = null;
    if (haloEl) {
      const hp = cssParams(deepFirst(haloEl, "Fill"));
      halo = {
        color: parseSldColor(hp.fill ?? "#ffffff", hp["fill-opacity"]),
        widthPx: Math.max(Number(textOf(deepFirst(haloEl, "Radius"))) || 1, 1),
      };
    }
    // LabelPlacement: PointPlacement(AnchorPoint/Displacement/Rotation) or
    // LinePlacement(PerpendicularOffset)。SLD の AnchorPoint は (0,0)=左下
    // (1,1)=右上、DisplacementY/Rotation は上向き正・反時計回り
    const placeEl = deepFirst(symEl, "LabelPlacement");
    const pp = deepFirst(placeEl, "PointPlacement");
    const lp = deepFirst(placeEl, "LinePlacement");
    let quad = { h: 0, v: 0 }, offsetXPx = 0, offsetYPx = 0, distPx = 0, rotDeg = 0, alongLine = false;
    if (pp) {
      const ax = Number(textOf(deepFirst(pp, "AnchorPointX")) || 0.5);
      const ay = Number(textOf(deepFirst(pp, "AnchorPointY")) || 0.5);
      quad = {
        h: ax <= 0.25 ? -1 : ax >= 0.75 ? 1 : 0,
        v: ay <= 0.25 ? -1 : ay >= 0.75 ? 1 : 0,
      };
      offsetXPx = Number(textOf(deepFirst(pp, "DisplacementX"))) || 0;
      offsetYPx = -(Number(textOf(deepFirst(pp, "DisplacementY"))) || 0);
      rotDeg = -Number(textOf(deepFirst(pp, "Rotation")) || 0);
    } else if (lp) {
      alongLine = true;
      distPx = Number(textOf(deepFirst(lp, "PerpendicularOffset"))) || 0;
    }
    // VendorOption: conflictResolution=false → 重なっても全表示
    let displayAll = false;
    for (const c of symEl.children || []) {
      if (lname(c) === "VendorOption" && c.getAttribute("name") === "conflictResolution"
          && /^(false|0)$/i.test(textOf(c))) displayAll = true;
    }
    // シンボライザ直下の縮尺分母(Rule のものとは別に持てる)
    const smin = Number(textOf(deepFirst(symEl, "MinScaleDenominator"))) || 0;
    const smax = Number(textOf(deepFirst(symEl, "MaxScaleDenominator"))) || 0;
    const labelScale = (smin || smax)
      ? { minScale: smin || null, maxScale: smax || null } : null;
    const priority = Number(textOf(deepFirst(symEl, "Priority"))) || null;
    out.label = {
      getText,
      sizePx, sizeUnit: "Pixel", sizeMeters: null,
      family, bold, italic,
      fontCss: `${italic ? "italic " : ""}${bold ? "bold " : ""}${Math.round(sizePx)}px ${family}`,
      fill: parseSldColor(fp.fill ?? "#000000", fp["fill-opacity"]),
      halo,
      align: "center",
      letterSpacingPx: 0, wordSpacingPx: 0, kerning: true,
      placement: { quad, distPx, offsetXPx, offsetYPx, rotationDeg: rotDeg, alongLine, kind: lp ? "line" : "point" },
      offsetXPx, offsetYPx, rotationDeg: rotDeg,
      pixelOffsetOf() {
        const pl = this.placement || {};
        const q = pl.quad || { h: 0, v: 0 };
        return [
          (pl.offsetXPx || 0) + (q.h || 0) * (pl.distPx || 0),
          -((pl.offsetYPx || 0) + (q.v || 0) * (pl.distPx || 0)),
        ];
      },
      displayAll, labelScale, priority,
      drawLabels: true, show: true,
      background: null, shadow: null, callout: null, substitutions: null,
    };
  } else if (n === "RasterSymbolizer") {
    warnings.add("RasterSymbolizer は未対応です");
  } else {
    warnings.add(`${n} は未対応のシンボライザです`);
  }
  return out;
}

// Rule 1本 → spec 断片
function compileRule(ruleEl, baseUrl, symbolImages, images, warnings) {
  const name = textOf(deepFirst(ruleEl, "Name")) || textOf(deepFirst(ruleEl, "Title")) || "rule";
  const title = textOf(deepFirst(ruleEl, "Title")) || name;
  const filter = compileSldFilter(deepFirst(ruleEl, "Filter"));
  const isElse = !!deepFirst(ruleEl, "ElseFilter");
  const minScale = Number(textOf(deepFirst(ruleEl, "MinScaleDenominator"))) || 0;
  const maxScale = Number(textOf(deepFirst(ruleEl, "MaxScaleDenominator"))) || 0;
  const frags = [];
  const walk = el => {
    for (const c of el?.children || []) {
      const n = lname(c);
      if (/Symbolizer$/.test(n)) frags.push(compileSymbolizer(c, baseUrl, symbolImages, images, warnings));
      else walk(c);
    }
  };
  walk(ruleEl);
  return { name, title, filter, isElse, minScale, maxScale, frags };
}

// spec 断片 → evaluate 出力(compileQmlStyle と同じキー)
function fragsToSpec(frags, scale) {
  const out = { markers: null, line: null, lines: null, fillParts: null, outline: null, centroid: null, scale };
  for (const f of frags) {
    if (f.markers?.length) (out.markers ||= []).push(...f.markers);
    if (f.lines?.length) (out.lines ||= []).push(...f.lines);
    if (f.fillParts?.length) (out.fillParts ||= []).push(...f.fillParts);
    if (f.outline) out.outline = f.outline;
  }
  if (out.lines?.length) out.line = out.lines[0];
  return out;
}

// SLD テキスト → compileQmlStyle 互換 spec。
// symbolImages: Map<gpkgsym URI またはシンボル名, HTMLImageElement|ImageBitmap>
// (GeoPackage gpkgext_symbols 由来。省略時は null)
export function compileSldStyle(xmlText, baseUrl = null, engine = null, symbolImages = null) {
  const doc = new DOMParser().parseFromString(String(xmlText), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("SLD の XML パースに失敗しました");
  const warnings = new Set();
  const images = new Map();

  const rules = [];
  const collect = el => {
    for (const c of el?.children || []) {
      const n = lname(c);
      if (n === "Rule") rules.push(compileRule(c, baseUrl, symbolImages, images, warnings));
      else collect(c);
    }
  };
  collect(doc.documentElement);
  if (!rules.length) throw new Error("SLD に Rule がありません(FeatureTypeStyle/Rule を含んでいません)");

  // フィルタ照合(ElseFilter 含む)→ 一致ルールの断片と scale を返す
  const matchFrags = props => {
    let matched = false;
    const frags = [];
    let scale = null;
    for (const r of rules) {
      let hit = false;
      if (r.isElse) hit = false; // ElseFilter は後段で「他が全て非一致」なら適用
      else if (!r.filter) hit = true;
      else { try { hit = !!r.filter(props || {}); } catch (e) { hit = false; } }
      if (hit) {
        matched = true;
        frags.push(...r.frags);
        if (r.minScale || r.maxScale) {
          scale = {
            near: Math.max(scale?.near || 0, r.maxScale ? sldScaleToDist(r.maxScale) : 0),
            far: Math.min(scale?.far ?? Infinity, r.minScale ? sldScaleToDist(r.minScale) : Infinity),
          };
        }
      }
    }
    if (!matched) {
      // ElseFilter ルール: 非 ELSE のどのルールにも一致しなかった地物へ適用
      for (const r of rules) if (r.isElse) frags.push(...r.frags);
    }
    return { frags, scale };
  };

  const evaluate = props => {
    const { frags, scale } = matchFrags(props);
    if (!frags.length) return null;
    return fragsToSpec(frags, scale);
  };

  // TextSymbolizer → labelFor(compileQmlStyle 互換)。
  // 一致ルールの最初のラベル定義を採用し、getText で地物属性から本文を解決する
  const labelFor = props => {
    const { frags } = matchFrags(props);
    const lab = frags.map(f => f.label).find(Boolean);
    if (!lab) return null;
    const text = lab.getText(props || {});
    if (!String(text ?? "").trim()) return null;
    return { ...lab, text: String(text), show: true };
  };

  const namesFor = props => {
    const names = [];
    let matched = false;
    for (const r of rules) {
      if (r.isElse) continue;
      const hit = !r.filter ? true : (() => { try { return !!r.filter(props || {}); } catch (e) { return false; } })();
      if (hit) { matched = true; names.push(r.name); }
    }
    if (!matched) for (const r of rules) if (r.isElse) names.push(r.name);
    return names;
  };

  // 凡例: 各ルールの title/name + そのルールの spec(空 props で解決)
  const legend = rules.map(r => ({
    label: r.title || r.name,
    symbolName: r.name,
    spec: fragsToSpec(r.frags, null),
  }));

  const ruleScales = rules.filter(r => r.minScale || r.maxScale).map(r => ({ min: r.minScale, max: r.maxScale }));

  const hasLabel = rules.some(r => r.frags.some(f => f.label));
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
    images,
    fields: null, displayFor: null,
    usesMapScale: false, usesLayerVisibility: false,
    scaleDependent: ruleScales.length > 0,
    sldRules: rules.length,
  };
}
