// time= / time_end= オプション用の共有タイムスライダー (#57)。
// geo_webview が QGIS の時間対応レイヤから出力するフィールド名指定を受け、
// 2D エンジン(maplibre/openlayers/leaflet)共通の「現在時刻 T で地物を絞る」
// UI を提供する。
//   instant(終端無し): time <= T の地物を表示
//   ranged(終端あり):  time <= T かつ (time_end 無し or time_end >= T)
// 値は ISO8601 文字列(辞書順比較)または数値(epoch 等)を想定する。

export function kascTimeSpec(item) {
  const tf = item?.opts?.time;
  if (!tf) return null;
  return { tf, te: item.opts?.time_end || item.opts?.timeend || null };
}

// GeoJSON features から time フィールドのユニーク値一覧を収集する
export function collectTimeValues(geojson, spec) {
  const out = new Set();
  for (const f of geojson?.features || []) {
    const v = f?.properties?.[spec.tf];
    if (v !== undefined && v !== null && v !== "") out.add(v);
  }
  return [...out];
}

// 値を比較用キーへ正規化。数値は number、それ以外は文字列
export function timeKey(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : s;
}

// 現在時刻 T で地物が表示対象か
export function featureInTime(props, spec, t) {
  const s = timeKey(props?.[spec.tf]);
  if (s == null) return false;
  if (s > t) return false;
  if (spec.te) {
    const e = timeKey(props?.[spec.te]);
    if (e != null && e < t) return false;
  }
  return true;
}

// ドメイン値を表示用にソート(数値と文字列が混在した場合は数値優先)
function sortDomain(values) {
  return values.slice().sort((a, b) => {
    const ka = timeKey(a), kb = timeKey(b);
    const na = typeof ka === "number", nb = typeof kb === "number";
    if (na && nb) return ka - kb;
    if (na !== nb) return na ? -1 : 1;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// layers: [{ label, spec, values, apply(t|null) }]
// apply には t=正規化キー(null=フィルタ解除)を渡す。
// コントロールを生成して container へ追加し、{el, setLayers} を返す。
export function buildKascTimeControl(container, layers) {
  const el = document.createElement("div");
  el.className = "kasc-time-dock";
  el.style.cssText = "position:absolute;left:10px;bottom:34px;z-index:12;"
    + "background:rgba(20,24,30,.82);color:#eee;border-radius:8px;"
    + "padding:6px 10px;font:12px/1.4 sans-serif;display:flex;"
    + "align-items:center;gap:8px;max-width:min(520px,70vw)";
  const icon = document.createElement("span");
  icon.textContent = "🕒";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.step = "1";
  slider.style.width = "180px";
  const cur = document.createElement("span");
  cur.style.cssText = "white-space:nowrap;overflow:hidden;"
    + "text-overflow:ellipsis;max-width:14em";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "全期間";
  reset.title = "時間フィルタを解除";
  reset.style.cssText = "background:transparent;border:1px solid #888;"
    + "color:inherit;border-radius:4px;padding:1px 6px;cursor:pointer";
  el.append(icon, slider, cur, reset);
  container.appendChild(el);

  let state = { layers: [], domain: [] };
  const applyAll = t => {
    for (const l of state.layers) { try { l.apply(t); } catch (_) {} }
    cur.textContent = t == null ? "(全期間)" : String(t);
    cur.title = cur.textContent;
  };
  slider.addEventListener("input", () => {
    const i = Number(slider.value);
    applyAll(state.domain[i]);
  });
  reset.addEventListener("click", () => { applyAll(null); });

  const setLayers = next => {
    const vals = [];
    for (const l of next || []) vals.push(...(l.values || []));
    state = { layers: next || [], domain: sortDomain([...new Set(vals)]) };
    slider.max = String(Math.max(0, state.domain.length - 1));
    slider.value = slider.max;
    const has = state.layers.length && state.domain.length;
    el.style.display = has ? "flex" : "none";
    if (has) applyAll(state.domain.at(-1));
    else applyAll(null);
  };
  setLayers(layers);
  return { el, setLayers };
}
