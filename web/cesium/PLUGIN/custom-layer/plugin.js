// custom-layer — 「site」キーで複数レイヤを任意グループにまとめて
// 一括制御するカスタムレイヤパネル。
//
// .kasc のレイヤ行に site=<グループ名> を付けると、その名ごとに
// グループ化されて表示される。Cesium では標準レイヤタブと同じ
// DOM 構造・クラス（layer-group / layer-item / layer-row /
// layer-legend-items）で描画するため、画面構成・文字サイズ・
// 行高・凡例の開閉が標準タブと同一になる。
// site= はこのタブ専用の集約キーで、標準レイヤタブには全レイヤが従来通り
// 表示される（標準一覧から隠すには list=off を使う）。list=off のレイヤは
// 「一覧から除外」なのでこのタブにも表示しない。site= 無しレイヤは
// このタブ末尾の「その他」に集約されて一括 on/off できる。
// メンバー内の表示順は order=<数値> で指定できる。
// タブ名(name=)が組み込みタブと重複する場合、組み込み側は自動的に
// 「システムレイヤ」等に改称される。
//
//   geojson: A工区・ポリゴン | canvas_data/a-poly.geojson | site=A工区 | order=1
//   geojson: A工区・ライン   | canvas_data/a-line.geojson | site=A工区 | order=2
//   geojson: A工区・ポイント | canvas_data/a-pt.geojson   | site=A工区 | order=3
//   plugin: custom-layer | name=レイヤ | url=canvas_data/custom-layer.js | before=layers-panel
//
// manifest.options.key で集約キー名を変えられる（既定 "site"）。

export async function init(api, manifest) {
  const KEY = manifest.options?.key || "site";
  const MISC = "その他";
  const groupCollapsed = new Set();  // site 名ごとの折りたたみ状態
  const legendCollapsed = new Set(); // レイヤ id ごとの凡例折りたたみ
  const style = document.createElement("style");
  style.textContent = `
    .sc-count { color: #778; font-weight: 400; font-size: 0.85em; }
    .sc-empty { padding: 8px; color: #778; font-size: 0.9em; }
    .sc-title { display: flex; align-items: center; gap: 5px;
      min-height: 16px; padding: 1px 7px 1px 4px; line-height: 1;
      font-weight: 700; }
    .sc-title input { width: 15px; min-height: 15px; margin: 0; }
    .sc-label { flex: 1; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; cursor: pointer; }
    .sc-legend { display: flex; align-items: center; gap: 5px;
      min-height: 16px; line-height: 1; }
    .sc-legend input { width: 14px; min-height: 14px; margin: 0; }
    .sc-legend .sw { width: 16px; height: 16px; display: inline-block; }
    .sc-legend img { width: 16px; height: 16px; }
    .sc-legend .lb { flex: 1; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; }
    .sc-legend-toggle { flex: 0 0 auto; width: 14px; min-width: 14px;
      min-height: 16px; margin-right: -4px; padding: 0; border: 0;
      background: transparent; color: #52636d; font-size: 11px;
      line-height: 1; cursor: pointer; }
    .sc-legend-focus { flex: 0 0 auto; width: 24px; min-width: 24px;
      min-height: 16px; padding: 0; border: 0; background: transparent;
      font-size: 15px; line-height: 1; opacity: .7; cursor: pointer; }
    .sc-legend-focus:hover { opacity: 1; }
  `;

  // 現在の一覧順(先頭=最前面)を保ったまま site キーで集約。
  // メンバーは order=<数値> があればその順、無ければ現在順。
  // キー無しレイヤは末尾に「その他」としてまとめて一括制御する
  const collect = () => {
    const map = new Map();
    const misc = [];
    for (const l of api.listLayers() || []) {
      if (l.options?.list === "off") continue; // list=off は一覧に出さない
      const k = l.options?.[KEY];
      if (!k) { misc.push(l); continue; }
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(l);
    }
    const sites = [...map.entries()].map(([name, members]) => ({
      name,
      members: [...members].sort((a, b) =>
        (Number(a.options?.order) || 1e9) - (Number(b.options?.order) || 1e9)),
    }));
    if (misc.length) sites.push({ name: MISC, members: misc, misc: true });
    return sites;
  };

  const swatch = (e, cls) => {
    const url = e?.spec && api.legendSwatchUrl
      ? api.legendSwatchUrl(e.spec) : null;
    if (url) {
      const img = document.createElement("img");
      img.className = "legend-swatch";
      img.src = url;
      img.alt = "";
      return img;
    }
    const sp = document.createElement("span");
    sp.className = `legend-swatch legend-swatch-empty`;
    return sp;
  };

  // 標準タブの凡例項目と同じ構造:
  // <label class="legend-row"><input.legend-checkbox><img.legend-swatch><span.legend-label>
  const legendEntry = (m, e) => {
    const row = document.createElement("label");
    row.className = "legend-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "legend-checkbox";
    cb.checked = e.visible !== false;
    cb.disabled = !e.symbolName || !api.setLayerLegendVisible;
    cb.addEventListener("change",
      () => api.setLayerLegendVisible?.(
        m.id, e.symbolName || e.label, cb.checked));
    const lb = document.createElement("span");
    lb.className = "legend-label";
    lb.textContent = e.label || e.symbolName || "";
    row.append(cb, swatch(e), lb);
    return row;
  };

  // 標準タブの .layer-item と同じ構造:
  // <label class="layer-row">[toggle|spacer][cb][swatch][title][📍]
  // 複数シンボルは .layer-legend-items(開閉可)の凡例行を子に持つ
  const memberItem = m => {
    const item = document.createElement("div");
    item.className = "layer-item";
    const row = document.createElement("label");
    row.className = "layer-row";
    const entries = m.legend || [];
    const multi = entries.length > 1;
    let items = null;
    if (multi) {
      items = document.createElement("div");
      items.className = "layer-legend-items";
      items.hidden = legendCollapsed.has(m.id);
      for (const e of entries) items.appendChild(legendEntry(m, e));
      const tgl = document.createElement("button");
      tgl.type = "button";
      tgl.className = "layer-legend-toggle";
      const collapsed = legendCollapsed.has(m.id);
      tgl.textContent = collapsed ? "▸" : "▾";
      tgl.setAttribute("aria-expanded", String(!collapsed));
      tgl.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const now = !items.hidden;
        items.hidden = now;
        tgl.textContent = now ? "▸" : "▾";
        tgl.setAttribute("aria-expanded", String(!now));
        if (now) legendCollapsed.add(m.id);
        else legendCollapsed.delete(m.id);
      });
      row.appendChild(tgl);
    } else {
      const sp = document.createElement("span");
      sp.className = "layer-legend-toggle-spacer";
      sp.setAttribute("aria-hidden", "true");
      row.appendChild(sp);
    }
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!m.visible;
    cb.addEventListener("change",
      () => api.setLayerVisible(m.id, cb.checked));
    row.appendChild(cb);
    if (entries.length === 1) row.appendChild(swatch(entries[0]));
    const title = document.createElement("span");
    title.textContent = m.title;
    row.appendChild(title);
    if (api.focusLayer) {
      const focus = document.createElement("button");
      focus.type = "button";
      focus.className = "layer-focus";
      focus.title = "フォーカス";
      focus.textContent = "📍";
      focus.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        void api.focusLayer(m.id);
      });
      row.appendChild(focus);
    }
    item.appendChild(row);
    if (items) item.appendChild(items);
    return item;
  };

  // 標準タブの <section class="layer-group grouped"> と同じ構造:
  // .layer-group-title(toggle+group checkbox+label) + .layer-group-children
  const siteSection = site => {
    const sec = document.createElement("section");
    sec.className = "layer-group grouped";
    const collapsed = groupCollapsed.has(site.name);
    const title = document.createElement("div");
    title.className = "layer-group-title";
    const tgl = document.createElement("button");
    tgl.type = "button";
    tgl.className = "layer-group-toggle";
    tgl.textContent = collapsed ? "▸" : "▾";
    tgl.setAttribute("aria-expanded", String(!collapsed));
    const children = document.createElement("div");
    children.className = "layer-group-children";
    children.hidden = collapsed;
    tgl.addEventListener("click", () => {
      const now = !children.hidden;
      children.hidden = now;
      tgl.textContent = now ? "▸" : "▾";
      tgl.setAttribute("aria-expanded", String(!now));
      if (now) groupCollapsed.add(site.name);
      else groupCollapsed.delete(site.name);
    });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "layer-group-checkbox";
    const visCount = site.members.filter(m => m.visible).length;
    cb.checked = visCount === site.members.length;
    cb.indeterminate = visCount > 0 && visCount < site.members.length;
    cb.addEventListener("change", () => {
      for (const m of site.members) api.setLayerVisible(m.id, cb.checked);
    });
    const label = document.createElement("label");
    label.className = "layer-group-label";
    label.textContent = site.name;
    label.title = site.members.map(m => m.title).join(" ／ ");
    const count = document.createElement("span");
    count.className = "sc-count";
    count.textContent = `(${site.members.length})`;
    label.appendChild(count);
    title.append(tgl, cb, label);
    for (const m of site.members) children.appendChild(memberItem(m));
    sec.append(title, children);
    return sec;
  };

  // 非 Cesium エンジン向けの簡易フォールバック(lv-*/sc-* クラス)
  const fallbackSection = site => {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "lv-group-title sc-title";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const visCount = site.members.filter(m => m.visible).length;
    cb.checked = visCount === site.members.length;
    cb.indeterminate = visCount > 0 && visCount < site.members.length;
    cb.addEventListener("change", () => {
      for (const m of site.members) api.setLayerVisible(m.id, cb.checked);
    });
    const label = document.createElement("span");
    label.className = "lv-title sc-label";
    label.textContent = `${site.name} (${site.members.length})`;
    label.title = site.members.map(m => m.title).join(" ／ ");
    row.append(cb, label);
    wrap.appendChild(row);
    for (const m of site.members) {
      const mr = document.createElement("label");
      mr.className = "sc-legend";
      const mcb = document.createElement("input");
      mcb.type = "checkbox";
      mcb.checked = !!m.visible;
      mcb.addEventListener("change",
        () => api.setLayerVisible(m.id, mcb.checked));
      const ml = document.createElement("span");
      ml.className = "lb";
      ml.textContent = m.title;
      mr.append(mcb, ml);
      if (api.focusLayer) {
        const f = document.createElement("button");
        f.type = "button";
        f.className = "sc-legend-focus";
        f.textContent = "📍";
        f.addEventListener("click",
          ev => { ev.preventDefault(); void api.focusLayer(m.id); });
        mr.append(f);
      }
      wrap.appendChild(mr);
    }
    return wrap;
  };

  let list = null;
  const render = () => {
    if (!list) return;
    const native = !!document.getElementById("layer-list");
    const sites = collect();
    list.textContent = "";
    if (!sites.length) {
      const p = document.createElement("div");
      p.className = "sc-empty";
      p.textContent = `site=<グループ名> を付けたレイヤがありません`;
      list.appendChild(p);
      return;
    }
    if (native) {
      // #layer-list { font-size: 18px } と同じ文字サイズに揃える
      const ll = document.getElementById("layer-list");
      list.style.fontSize = getComputedStyle(ll).fontSize;
      for (const site of sites) list.appendChild(siteSection(site));
    } else {
      for (const site of sites) list.appendChild(fallbackSection(site));
    }
  };

  api.registerPanel({
    id: "custom-layer",
    title: manifest.name || "レイヤ",
    onInit(panel) {
      panel.appendChild(style);
      if (document.getElementById("layer-list")) {
        // 標準タブと同じ .layer-head-row(全展開/全折りたたみ)
        const head = document.createElement("div");
        head.className = "layer-head-row";
        const mk = (glyph, title, fn) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "layer-head-btn";
          b.title = title;
          b.textContent = glyph;
          b.addEventListener("click", fn);
          return b;
        };
        const expand = mk("🔽", "すべて展開", () => {
          groupCollapsed.clear();
          legendCollapsed.clear();
          render();
        });
        expand.style.marginLeft = "auto";
        const collapse = mk("🔼", "すべて折りたたみ", () => {
          for (const s of collect()) {
            groupCollapsed.add(s.name);
            for (const m of s.members) {
              if ((m.legend || []).length > 1) legendCollapsed.add(m.id);
            }
          }
          render();
        });
        head.append(expand, collapse);
        panel.appendChild(head);
      }
      list = document.createElement("div");
      panel.appendChild(list);
      render();
    },
    onShow() { render(); },
  });
  api.on?.("layers-changed", () => render());
}
