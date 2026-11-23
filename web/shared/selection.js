// 地物選択ハイライト共通モジュール(全6エンジン)。
// QGIS の「選択地物表示」に相当: クリックした地物を指定色(既定:黄)または
// 反転色で強調する。設定は localStorage と URL パラメータで共有する。
//
//   ?selmode=color|invert  表示モード(指定色 / 元の色を反転)
//   ?selcolor=#rrggbb      指定色(invert で元色不明時のフォールバック兼用)
//
// 各エンジンはクリックした地物の GeoJSON ジオメトリを選択オーバーレイへ
// 流し、描画色は selColorOf(feature) で統一する。反転モードでは
// tagSelectionFeature(feature, baseCss) が元色を反転した色を
// feature.properties[SEL_PROP] へ埋める(元色が取れない地物は指定色)。

export const SEL_COLOR_KEY = "kasugai.selectionColor";
export const SEL_MODE_KEY = "kasugai.selectionMode";
export const SEL_DEFAULT_COLOR = "#ffff00"; // QGIS 既定の選択色
export const SEL_PROP = "__selc"; // 解決済み表示色を feature.properties に埋めるキー
export const SEL_FILL_ALPHA = 0.28;
export const SEL_LINE_WIDTH = 3;
export const SEL_POINT_RADIUS = 7;
export const SEL_POINT_OUTLINE = "#111111";

const selParams = new URLSearchParams(location.search);

const store = {
  get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch (_) { /* 無視 */ } },
  remove(key) { try { localStorage.removeItem(key); } catch (_) { /* 無視 */ } },
};

// css 色文字列または [r,g,b,a?] 配列を {r,g,b,a} に正規化する。
// 解釈できない値は null(名前付き色は未対応・フォールバック色を使う)
export function parseCssColor(v) {
  if (Array.isArray(v) && v.length >= 3 && v.every(n => Number.isFinite(n))) {
    return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const d = i => parseInt(h[i] + h[i], 16);
      return { r: d(0), g: d(1), b: d(2), a: h.length === 4 ? d(3) / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const d = i => parseInt(h.slice(i, i + 2), 16);
      return { r: d(0), g: d(2), b: d(4), a: h.length === 8 ? d(6) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(",").map(t => t.trim());
    if (p.length < 3) return null;
    const n = t => t.endsWith("%") ? Number(t.slice(0, -1)) * 2.55 : Number(t);
    const r = n(p[0]), g = n(p[1]), b = n(p[2]);
    const a = p.length > 3 ? Number(p[3]) : 1;
    if ([r, g, b].every(Number.isFinite)) return { r, g, b, a: Number.isFinite(a) ? a : 1 };
  }
  return null;
}

export function rgbToHex({ r, g, b }) {
  const h = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// 色配列・css 文字列を "#rrggbb" に正規化(失敗時 null)
export function normHex(v) {
  const c = parseCssColor(v);
  return c ? rgbToHex(c) : null;
}

// 反転色(RGB 各チャンネルを 255- で反転)。解釈不能なら null
export function invertCssColor(v) {
  const c = parseCssColor(v);
  return c ? rgbToHex({ r: 255 - c.r, g: 255 - c.g, b: 255 - c.b }) : null;
}

// 塗りつぶし用にアルファ付き rgba 文字列へ変換(解釈不能なら入力をそのまま返す)
export function cssWithAlpha(v, alpha) {
  const c = parseCssColor(v);
  if (!c) return typeof v === "string" ? v : `rgba(255,255,0,${alpha})`;
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

export function getSelectionMode() {
  const v = String(selParams.get("selmode") || store.get(SEL_MODE_KEY) || "color").toLowerCase();
  return v === "invert" ? "invert" : "color";
}

export function getSelectionColor() {
  const v = selParams.get("selcolor") || store.get(SEL_COLOR_KEY);
  return normHex(v) || SEL_DEFAULT_COLOR;
}

export function setSelectionMode(mode) {
  store.set(SEL_MODE_KEY, mode === "invert" ? "invert" : "color");
}

export function setSelectionColor(css) {
  const hex = normHex(css);
  if (hex) store.set(SEL_COLOR_KEY, hex);
}

// 現在の設定で地物の強調色を解決する。
// invert モードでは baseCss(地物の元の塗り/線色)の反転色、
// 元色が取れなければ指定色にフォールバックする
export function resolveSelColor(baseCss) {
  if (getSelectionMode() === "invert") {
    const inv = baseCss && invertCssColor(baseCss);
    if (inv) return inv;
  }
  return getSelectionColor();
}

// 地物の強調色を feature.properties[SEL_PROP] へ埋めた複写を返す
export function tagSelectionFeature(feature, baseCss) {
  if (!feature) return feature;
  return {
    ...feature,
    properties: { ...(feature.properties || {}), [SEL_PROP]: resolveSelColor(baseCss) },
  };
}

// オーバーレイ描画時の地物色(未タグなら指定色)
export function selColorOf(feature) {
  const c = feature?.properties?.[SEL_PROP];
  return (typeof c === "string" && c) || getSelectionColor();
}

// ol.Feature 等 get() アクセス用に解決済み色をプロパティキーへ書き込む
export function selPropValue(feature) {
  return selColorOf(feature);
}

// 設定 UI(モード select + color input)を結線する。
// 変更時は localStorage へ保存して onChange を呼ぶ(各エンジンは選択の再描画を行う)
export function initSelectionUI({ modeSel, colorInput, onChange } = {}) {
  if (modeSel) {
    modeSel.value = getSelectionMode();
    modeSel.addEventListener("change", () => { setSelectionMode(modeSel.value); onChange?.(); });
  }
  if (colorInput) {
    colorInput.value = getSelectionColor();
    const apply = () => { setSelectionColor(colorInput.value); onChange?.(); };
    colorInput.addEventListener("input", apply);
    colorInput.addEventListener("change", apply);
  }
}

// 「設定をリセット」ボタン等から既定へ戻すための補助
export function resetSelectionUI({ modeSel, colorInput, onChange } = {}) {
  store.remove(SEL_MODE_KEY);
  store.remove(SEL_COLOR_KEY);
  if (modeSel) modeSel.value = "color";
  if (colorInput) colorInput.value = SEL_DEFAULT_COLOR;
  onChange?.();
}
