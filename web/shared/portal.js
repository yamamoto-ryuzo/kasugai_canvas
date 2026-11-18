// ---- ポータル(portal:/html:/news:/stat:/view:/link:/project: 行で構成する開始画面) ----
// 全エンジン共通のポータルUIモジュール。各エンジンは
//   1) index.html に #portal-open ボタンと #portal-overlay 構造を置き
//   2) app.js で view:/html:/news:/stat:/portal:/link:/project:/form: 行をパースして保持し
//   3) この createKascPortal に「状態getter + applyView/clearView」を渡す
// だけで、カード/セクション/既定コンテンツ/外部リンクの描画と
// 🏠ボタン・Esc・解除ボタンの配線が共有される。
//
// 必須 DOM 構造(index.html):
//   <button id="portal-open"><span>🏠 ポータル</span></button>   (タブバー先頭)
//   <div id="portal-overlay" hidden>
//     <h2 id="portal-title"></h2>
//     <button id="portal-close">地図を開く</button>
//     <div id="portal-body"></div>
//     <div id="portal-footer" hidden>
//       <button id="portal-clear">ビュー解除</button>
//     </div>
//   </div>
// CSS クラスも各エンジンの index.html <style> に同一名で定義する
// (.portal-overlay/.portal-title/.portal-close/.portal-body/
//  .portal-section/.portal-section-body/.portal-views-head/.portal-cards/
//  .portal-card(.active,.portal-card-link)/.portal-card-img
//  (.portal-card-img-empty)/.portal-card-name/.portal-card-desc/
//  .portal-footer/.portal-open
//  .portal-news-list/.portal-news-item/.portal-news-date/
//  .portal-news-importance/.portal-news-title/.portal-news-tag/
//  .portal-news-body/.portal-news-actions/.portal-news-btn)

// cfg:
//   t(key, vars?)          — i18n 関数 (portal.* キーを使う)
//   resolveProjectUrl(path)— canvas_data/ 等の相対パス → URL
//   loadInfoContent(el, spec, unused, {errorText}) — loadKascInfoContent
//   applyView(view)        — view: カード押下時の地図状態適用(async 可)
//   clearView()            — 適用前状態への復元(async 可)
//   applyCam(name)?        — data-cam="カメラ名" の移動(省略可)
//   applyBase(name)?       — data-base="背景名" の背景地図切替(省略可)
//   applyFeature(spec)?    — data-feature="レイヤ/属性=値" の地物検索+ズーム(省略可)
//   resolveProject(entry)? — project: カード/data-project の遷移先解決。
//                          {title,id,kascUrl} または null(未解決=無効カード)
//   applyProject(entry)?   — プロジェクト切替の実行(async 可)
//   getActiveViewName()    — 適用中ビュー名 or null
//   getPortalSpec()        — {enabled,title,open,html?} or null (portal: 行)
//   getPanelTitle()        — title: 行のパネルタイトル or null
//   getHtmlSections()      — [{title,spec}] (html: 行・記述順)
//   getNews()              — [{src,limit,title}] (news: 行・記述順。#128)
//   getSearches()          — [{layer,attr,ph,title}] (search: 行・記述順。#125)
//   searchIndex(query, spec)? — search: 行/data-search 属性の検索実行。
//                          spec={layer,attr}。[{layerId,layerTitle,attr,value,lat,lng}]
//                          を返す(async 可。省略時は検索ボックスを無効表示)
//   applySearchResult(result)? — 候補クリック時の地物ズーム+選択(async 可。
//                          省略時は applyFeature("layer/attr=value") 経路を使う)
//   getStats()             — [{layer,group,value,kind,agg,title,desc}] (stat: 行・記述順。#126)
//   getStatFeatures(layer) — stat: 集計用。レイヤー名→ロード済み GeoJSON Feature[]
//   setStatWhere(layer, where|null)? — セグメントクリックの地図フィルタ適用(async 可。
//                          省略時は stat: カードは閲覧専用)
//   getCards()             — [{kind:"view"|"link"|"form"|"project", entry:{name,desc,img,url?,…}}]
//
// ポータル内HTML(html:/portal html=)で使える data-* 属性:
//   data-view="ビュー名" — ビュー適用＋ポータルを閉じる
//   data-feature="レイヤ/属性=値" — 地物検索+ズーム＋ポータルを閉じる
//   data-link="URL"      — 外部URLを新規タブで開く
//   data-cam="カメラ名"  — カメラプリセットへ移動(ポータルは開いたまま)
//   data-base="背景名"   — 背景地図を切替(none/transparent も可)
//   data-search="レイヤ|all" — <input> を属性検索ボックス化(#125)。
//                          data-search-attr="属性名" で対象属性を限定。
//                          候補クリックでポータルを閉じて地物へズーム+選択
//   data-form="フォーム名" — フォーム投稿画面を開く(form: 行)
//   data-project="id"  — プロジェクト切替(project: 行と同等。data-keep=cam,base 併用可)
//   data-clear           — ビュー解除(適用前状態へ復元)
//   data-close           — ポータルを閉じる
//
// form: 行のフォーム投稿(#131)を使うエンジンはさらに以下を渡す:
//   pickLocation()       — ポータル非表示中の地図クリック1回を
//                          Promise<{lon,lat}|null> で返す(loc フィールド用)
//   cancelPick()         — 未確定の位置拾いを破棄する(ポータル再表示時に呼ぶ)
import { backendUrl } from "./backend.js";
import { embedKascInfoHtml, renderMarkdownLite, parseKascNewsArticles } from "./kasc.js";
import { computeGroupStats } from "./attr-stats.js";

// ---- stat: 行の統計カード(#126) 共用部品 ----
// 値のクォート・数値判定・扇形 path は shared/dashboard.js と同規則。
// グラフ描画は依存追加なしの自前 SVG/CSS(dashboard.js と同方針)
const STAT_LABELS = {
  statTitle: "統計",
  statEmpty: "該当する地物がありません",
  statFilterHint: "クリックで地図をこの値に絞り込み(再クリックで解除)",
  statAgg_count: "件数",
  statAgg_sum: "合計",
  statAgg_avg: "平均",
  statAgg_min: "最小",
  statAgg_max: "最大",
};
const STAT_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
const statQuoteIdent = name => `"${String(name).replace(/"/g, '""')}"`;
const statQuoteStr = value => `'${String(value).replace(/'/g, "''")}'`;
const statNum = v => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const statFmt = v => (v == null || Number.isNaN(v)) ? "-"
  : (Number.isInteger(v) ? v.toLocaleString() : (Math.round(v * 100) / 100).toLocaleString());
// グループ行から表示値を取り出す。value=count(または未指定)は件数、
// 属性指定時は agg=(既定 sum)の集計値。数値なしグループは null → "-"
function statMetric(g, spec, valueField) {
  if (!valueField) return g.count;
  const agg = spec.agg || "sum";
  if (agg === "count") return g.count;
  return g[agg] ?? null;
}
// group= 無し KPI 用: 全地物を一括集計する
function statAggregateAll(features, valueField, agg) {
  if (!valueField || agg === "count") return features.length;
  const nums = features.map(f => statNum(f?.properties?.[valueField])).filter(v => v !== null);
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (agg === "avg") return sum / nums.length;
  if (agg === "min") return Math.min(...nums);
  if (agg === "max") return Math.max(...nums);
  return sum;
}
// 円グラフの扇形 path(viewBox -1.05..1.05)。角度 -π/2(12時)起点・時計回り
function statPieSlice(a0, a1) {
  const pt = a => `${Math.cos(a).toFixed(4)} ${Math.sin(a).toFixed(4)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M 0 0 L ${pt(a0)} A 1 1 0 ${large} 1 ${pt(a1)} Z`;
}

export function createKascPortal(cfg) {
  const {
    t, resolveProjectUrl = u => u, loadInfoContent,
    applyView, clearView, applyCam, applyBase, applyFeature,
    resolveProject = null, applyProject = null,
    pickLocation = null, cancelPick = null,
    getActiveViewName = () => null,
    getPortalSpec = () => null,
    getPanelTitle = () => null,
    getHtmlSections = () => [],
    getNews = () => [],
    getSearches = () => [],
    searchIndex = null,
    applySearchResult = null,
    getStats = () => [],
    getStatFeatures = () => [],
    setStatWhere = null,
    getCards = () => [],
  } = cfg;

  // ポータルを開ける条件。portal:off 明示のみ無効。
  // 宣言が無いプロジェクトでも既定コンテンツ付きで開ける
  function available() {
    const spec = getPortalSpec();
    return !(spec && !spec.enabled);
  }

  function updateButton() {
    const btn = document.querySelector("#portal-open");
    if (!btn) return;
    btn.hidden = !available();
    const label = btn.querySelector("span") || btn;
    label.textContent = "🏠";
    const active = getActiveViewName();
    btn.classList.toggle("active", !!active);
    btn.title = active ? `${active} — ${t("portal.openTitle")}` : t("portal.openTitle");
  }

  // link: カードの外部URLを新規タブで開く。http(s)/mailto のみ許可し
  // javascript: 等のスキームは拒否する
  function openLink(url) {
    try {
      const u = new URL(url, window.location.href);
      if (!["http:", "https:", "mailto:"].includes(u.protocol)) return;
      window.open(u.href, "_blank", "noopener,noreferrer");
    } catch { /* 無効URLは無視 */ }
  }

  // ポータル内HTML(html:/portal html=)中の data-view="ビュー名" /
  // data-link="URL" 要素をカード相当の操作へ割り当てる。
  // カスタムHTMLでもビュー適用・外部リンクがそのまま動く
  let delegated = false;
  function ensureDelegated() {
    const body = document.querySelector("#portal-body");
    if (!body || delegated) return;
    delegated = true;
    body.addEventListener("click", event => {
      const viewEl = event.target.closest("[data-view]");
      if (viewEl && body.contains(viewEl)) {
        const card = getCards().find(c => c.kind === "view" && c.entry.name === viewEl.dataset.view);
        if (card) { void applyView(card.entry); close(); }
        return;
      }
      const featureEl = event.target.closest("[data-feature]");
      if (featureEl && body.contains(featureEl)) {
        if (applyFeature) { void applyFeature(featureEl.dataset.feature); close(); }
        return;
      }
      const formEl = event.target.closest("[data-form]");
      if (formEl && body.contains(formEl)) {
        const card = getCards().find(c => c.kind === "form" && (c.entry.name === formEl.dataset.form || c.entry.title === formEl.dataset.form));
        if (card) openForm(card.entry);
        return;
      }
      const projectEl = event.target.closest("[data-project]");
      if (projectEl && body.contains(projectEl) && applyProject) {
        void applyProject({ name: projectEl.dataset.project, keep: projectEl.dataset.keep || "" });
        return;
      }
      const linkEl = event.target.closest("[data-link]");
      if (linkEl && body.contains(linkEl)) {
        openLink(linkEl.dataset.link || linkEl.getAttribute("href") || "");
        event.preventDefault();
        return;
      }
      const camEl = event.target.closest("[data-cam]");
      if (camEl && body.contains(camEl) && applyCam) {
        applyCam(camEl.dataset.cam);
        return;
      }
      const baseEl = event.target.closest("[data-base]");
      if (baseEl && body.contains(baseEl) && applyBase) {
        applyBase(baseEl.dataset.base);
        return;
      }
      if (event.target.closest("[data-clear]")) {
        void clearView();
        update();
        return;
      }
      if (event.target.closest("[data-close]")) close();
    });
    // <input data-search="レイヤ|all"(data-search-attr="属性名")> の入力を
    // 属性検索へ接続(#125)。search: 行で生成した検索ボックスも同じ属性を
    // 持つため、ここの委譲で両方を一括配線する
    body.addEventListener("input", event => {
      const input = event.target.closest("input[data-search]");
      if (input && body.contains(input)) void runPortalSearch(input);
    });
  }

  // ポータル画面の内容を構築する。applyInspector 完了時と表示言語切替時に呼ぶ
  function update() {
    updateButton();
    // フォームの位置拾いが未確定で残っていれば破棄する
    if (cancelPick) cancelPick();
    ensureDelegated();
    const overlay = document.querySelector("#portal-overlay");
    if (!overlay) return;
    const titleEl = document.querySelector("#portal-title");
    if (titleEl) titleEl.textContent = getPortalSpec()?.title
      || getPanelTitle()
      || t("portal.open");
    const body = document.querySelector("#portal-body");
    if (!body) return;
    body.replaceChildren();
    const errText = { errorText: error => t("portal.loadFailed", { error }) };
    // portal: … | html=ファイル/URL — ボディ全体を1つのHTMLで構成する
    // フルカスタムモード。セクション/カードの自動生成は行わず、HTML 内の
    // data-view="ビュー名"・data-link="URL" がカード操作として動く
    const spec = getPortalSpec();
    if (spec?.html) {
      void loadInfoContent(body, resolveProjectUrl(spec.html), null, errText);
      const footer0 = document.querySelector("#portal-footer");
      if (footer0) footer0.hidden = !getActiveViewName();
      return;
    }
    // search: セクション(記述順・先頭)。ポータル起点の「探す」導線として
    // 検索ボックス+候補一覧を描く(#125)。候補クリックはポータルを閉じて
    // 地物へズーム+選択する。フルカスタム時は data-search 属性の入力が同じ経路で動く
    for (const spec of getSearches()) { body.append(renderSearchSection(spec)); }
    // html: セクション(記述順)。タイトル+内容(インラインHTMLまたはURL/ファイル)
    for (const sec of getHtmlSections()) {
      const wrap = document.createElement("section");
      wrap.className = "portal-section";
      if (sec.title) {
        const h = document.createElement("h3");
        h.textContent = sec.title;
        wrap.append(h);
      }
      const content = document.createElement("div");
      content.className = "portal-section-body";
      wrap.append(content);
      body.append(wrap);
      void loadInfoContent(content, sec.spec, null, errText);
    }
    // news: セクション(記述順・html: の後)。JSON/Markdown のお知らせ一覧を
    // fetch して日付降順で描画する(#128)
    for (const sec of getNews()) {
      const wrap = document.createElement("section");
      wrap.className = "portal-section";
      const head = document.createElement("h3");
      head.textContent = sec.title || t("portal.news");
      const content = document.createElement("div");
      content.className = "portal-section-body portal-news";
      wrap.append(head, content);
      body.append(wrap);
      void loadNewsSection(content, sec, errText);
    }
    // stat: セクション(記述順・news: の後)。レイヤー属性をクライアント集計した
    // KPI/棒/円グラフカード(#126)。セグメントクリックはレイヤーの where= へ反映
    getStats().forEach((spec, idx) => { body.append(renderStatCard(idx, spec)); });
    // view:/link: カード(宣言順で同一グリッド)
    const cards = getCards();
    if (cards.length) {
      const hasView = cards.some(c => c.kind === "view");
      const head = document.createElement("div");
      head.className = "portal-views-head";
      head.textContent = t(hasView ? "portal.views"
        : cards.every(c => c.kind === "form") ? "portal.forms"
        : cards.every(c => c.kind === "project") ? "portal.projects"
        : "portal.links");
      body.append(head);
      const grid = document.createElement("div");
      grid.className = "portal-cards";
      for (const { kind, entry } of cards) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "portal-card";
        const img = document.createElement("span");
        img.className = "portal-card-img";
        if (entry.img) {
          const el = document.createElement("img");
          el.src = resolveProjectUrl(entry.img);
          el.alt = "";
          el.loading = "lazy";
          img.append(el);
        } else {
          img.textContent = (entry.name || "?").slice(0, 1);
          img.classList.add("portal-card-img-empty");
        }
        const name = document.createElement("span");
        name.className = "portal-card-name";
        name.textContent = entry.name;
        card.append(img, name);
        if (entry.desc) {
          const desc = document.createElement("span");
          desc.className = "portal-card-desc";
          desc.textContent = entry.desc;
          card.append(desc);
          card.title = entry.desc;
        }
        if (kind === "view") {
          if (entry.name === getActiveViewName()) card.classList.add("active");
          card.addEventListener("click", () => {
            void applyView(entry);
            close();
          });
        } else if (kind === "form") {
          card.classList.add("portal-card-form");
          card.addEventListener("click", () => openForm(entry));
        } else if (kind === "project") {
          card.classList.add("portal-card-project");
          // project: カード(#130)。遷移先は resolveProject で id/名前/URL から
          // 解決し、未解決なら無効カードとして表示する
          const resolved = resolveProject ? resolveProject(entry) : null;
          if (resolved?.title) name.textContent = resolved.title;
          if (!resolved) {
            card.disabled = true;
            card.classList.add("portal-card-unresolved");
            const msg = t("portal.projectUnresolved", { name: entry.name });
            card.title = card.title ? `${card.title} — ${msg}` : msg;
          } else {
            card.addEventListener("click", () => { void applyProject(entry); });
          }
        } else {
          card.classList.add("portal-card-link");
          if (entry.url) card.title = card.title ? `${card.title} — ${entry.url}` : entry.url;
          card.addEventListener("click", () => openLink(entry.url));
        }
        grid.append(card);
      }
      body.append(grid);
    }
    // 宣言が一切無いプロジェクト向けの既定コンテンツ。
    // お知らせ→ビュー説明→機能説明(HTML)の順で、html:/view:/link: の
    // 書き方そのものをガイドとして表示する
    if (!getHtmlSections().length && !getNews().length && !getStats().length && !getSearches().length && !cards.length) {
      const news = document.createElement("section");
      news.className = "portal-section";
      const newsHead = document.createElement("h3");
      newsHead.textContent = t("portal.news");
      const newsBody = document.createElement("div");
      newsBody.className = "portal-section-body";
      newsBody.textContent = t("portal.defaultNews");
      news.append(newsHead, newsBody);
      const views = document.createElement("section");
      views.className = "portal-section";
      const viewsHead = document.createElement("h3");
      viewsHead.textContent = t("portal.views");
      const viewsBody = document.createElement("div");
      viewsBody.className = "portal-section-body";
      viewsBody.textContent = t("portal.defaultViews");
      views.append(viewsHead, viewsBody);
      const about = document.createElement("section");
      about.className = "portal-section";
      const aboutHead = document.createElement("h3");
      aboutHead.textContent = t("portal.about");
      const aboutBody = document.createElement("div");
      aboutBody.className = "portal-section-body";
      about.append(aboutHead, aboutBody);
      body.append(news, views, about);
      void loadInfoContent(aboutBody, t("portal.aboutHtml"), null, errText);
    }
    const footer = document.querySelector("#portal-footer");
    if (footer) footer.hidden = !getActiveViewName();
  }

  // ---- news: 行のお知らせフィード(#128) ----
  // JSON([{date,title,body,link,view,feature,tags,importance}])または
  // FrontMatter 付き Markdown 一覧を fetch no-store で取得し、日付降順・
  // limit 適用で記事カードを描く。本文は info: 行と同じサニタイズ経路
  // (embedKascInfoHtml)を通し、記事の view/link/feature は data-* 属性ボタン
  // として ensureDelegated の既存ハンドラで地図・外部サイトへ遷移する
  async function loadNewsSection(container, sec, errText) {
    const fail = error => {
      const message = error instanceof Error ? error.message : String(error);
      container.textContent = typeof errText?.errorText === "function"
        ? errText.errorText(message)
        : `お知らせを読み込めませんでした: ${message}`;
    };
    const url = resolveProjectUrl(sec.src);
    let articles;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      articles = parseKascNewsArticles(await response.text());
    } catch (error) {
      fail(error);
      return;
    }
    articles.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    const shown = sec.limit > 0 ? articles.slice(0, sec.limit) : articles;
    container.replaceChildren();
    if (!shown.length) {
      container.textContent = t("portal.newsEmpty");
      return;
    }
    const list = document.createElement("div");
    list.className = "portal-news-list";
    for (const article of shown) {
      const item = document.createElement("article");
      item.className = "portal-news-item";
      const head = document.createElement("div");
      head.className = "portal-news-head";
      if (article.date) {
        const date = document.createElement("time");
        date.className = "portal-news-date";
        date.textContent = article.date;
        head.append(date);
      }
      if (article.importance) {
        const badge = document.createElement("span");
        badge.className = "portal-news-importance";
        badge.textContent = article.importance;
        head.append(badge);
      }
      const title = document.createElement("span");
      title.className = "portal-news-title";
      title.textContent = article.title || article.date;
      head.append(title);
      for (const tag of article.tags) {
        const el = document.createElement("span");
        el.className = "portal-news-tag";
        el.textContent = tag;
        head.append(el);
      }
      item.append(head);
      if (article.body) {
        const bodyEl = document.createElement("div");
        bodyEl.className = "portal-news-body";
        embedKascInfoHtml(bodyEl,
          article.format === "md" ? renderMarkdownLite(article.body) : article.body,
          null);
        item.append(bodyEl);
      }
      const actions = [];
      if (article.view) actions.push(["data-view", article.view, article.view]);
      if (article.feature) actions.push(["data-feature", article.feature, t("portal.newsFeature")]);
      if (article.link) actions.push(["data-link", article.link, t("portal.newsOpen")]);
      if (actions.length) {
        const bar = document.createElement("div");
        bar.className = "portal-news-actions";
        for (const [attr, value, label] of actions) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "portal-news-btn";
          button.setAttribute(attr, value);
          button.textContent = label;
          bar.append(button);
        }
        item.append(bar);
      }
      list.append(item);
    }
    container.append(list);
  }

  // ---- stat: 行の統計カード(#126) ----
  // dash: 行ダッシュボード(#123)のポータル内プリミティブ。
  // `stat:レイヤー名 | group=属性 | value=属性|count | kind=kpi|bar|pie |
  //   agg=count|sum|avg|min|max | title=見出し | desc=説明`
  // getStatFeatures(レイヤー名) が返すロード済み GeoJSON properties を
  // attr-stats.js でクライアント集計し KPI/棒/円グラフを描く。
  // group= のセグメント(棒・扇・KPIタイル)クリックは `"group" = '値'` の
  // where= を setStatWhere 経由で地図へ適用(再クリックで解除)

  const statTr = key => {
    const text = t ? t(`portal.${key}`) : null;
    if (text && !text.startsWith("portal.")) return text;
    const fallback = STAT_LABELS[key];
    return typeof fallback === "function" ? fallback() : (fallback ?? key);
  };

  // セグメント選択状態(stat: 行 index → {layer,key})
  const statSel = new Map();

  let statStyleDone = false;
  function ensureStatStyle() {
    if (statStyleDone) return;
    statStyleDone = true;
    const st = document.createElement("style");
    st.textContent = `
.portal-stat-card{padding:.6em .9em}
.portal-stat-title{margin:.1em 0 .4em;font-size:1em}
.portal-stat-desc{color:#555;font-size:.85em;margin:.2em 0 .4em}
.portal-stat-empty{color:#777;font-size:.85em}
.portal-stat-kpis{display:flex;flex-wrap:wrap;gap:.5em}
.portal-stat-kpi{font:inherit;display:flex;flex-direction:column;align-items:center;min-width:5.5em;padding:.4em .7em;border:1px solid #e0e0e0;border-radius:6px;background:#fafafa}
.portal-stat-kpi-key{font-size:.8em;color:#555;max-width:10em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.portal-stat-kpi-value{font-size:1.5em;font-weight:700}
.portal-stat-seg{font:inherit;text-align:left;background:none;border:none;padding:0;cursor:pointer;width:100%}
.portal-stat-static{cursor:default}
.portal-stat-bars{display:flex;flex-direction:column;gap:2px}
.portal-stat-bar-row{display:grid;grid-template-columns:9em 1fr 4em;align-items:center;gap:.5em;padding:1px 2px;border-radius:4px}
.portal-stat-bar-row:hover,.portal-stat-legend .portal-stat-seg:hover{background:#eef3f9}
.portal-stat-bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.85em}
.portal-stat-bar-track{background:#eee;border-radius:3px;height:.9em;overflow:hidden}
.portal-stat-bar-fill{display:block;height:100%;background:#4e79a7}
.portal-stat-bar-value{text-align:right;font-size:.85em;font-variant-numeric:tabular-nums}
.portal-stat-pie-wrap{display:flex;align-items:center;gap:1em;flex-wrap:wrap}
.portal-stat-pie{width:9em;height:9em;flex:none}
.portal-stat-pie path{cursor:pointer;stroke:#fff;stroke-width:.02}
.portal-stat-legend{display:flex;flex-direction:column;gap:2px;min-width:10em}
.portal-stat-legend .portal-stat-seg{display:flex;align-items:center;gap:.4em;padding:1px 2px;border-radius:4px;font-size:.85em}
.portal-stat-swatch{width:.8em;height:.8em;border-radius:2px;flex:none}
.portal-stat-active{outline:2px solid #2f6fbf;outline-offset:1px}
`;
    document.head.append(st);
  }

  // セグメントクリック → `"group" = '値'` の where= をレイヤーへ適用。
  // 同じセグメントの再クリックで解除。同一レイヤーを集計する他 stat: の
  // 選択は where= が上書きされるため解除扱いにする
  function statSegClick(idx, spec, key) {
    if (!setStatWhere || !spec.group) return;
    const off = statSel.get(idx)?.key === key;
    for (const [i, sel] of statSel) {
      if (i !== idx && sel.layer === spec.layer) statSel.delete(i);
    }
    if (off) statSel.delete(idx); else statSel.set(idx, { layer: spec.layer, key });
    const where = off ? null : `${statQuoteIdent(spec.group)} = ${statQuoteStr(key)}`;
    void Promise.resolve(setStatWhere(spec.layer, where)).then(() => update());
  }

  // クリック可能なセグメント要素(button)。setStatWhere 無し・group 無しは静的表示
  function statSegButton(cls, key, idx, spec) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = cls;
    if (spec.group && setStatWhere) {
      el.title = statTr("statFilterHint");
      el.addEventListener("click", () => statSegClick(idx, spec, key));
      if (statSel.get(idx)?.key === key) el.classList.add("portal-stat-active");
    } else {
      el.classList.add("portal-stat-static");
    }
    return el;
  }

  function renderStatCard(idx, spec) {
    ensureStatStyle();
    const card = document.createElement("section");
    card.className = `portal-section portal-stat-card portal-stat-${spec.kind || "bar"}`;
    const head = document.createElement("h3");
    head.className = "portal-stat-title";
    head.textContent = spec.title || spec.layer || statTr("statTitle");
    card.append(head);
    if (spec.desc) {
      const desc = document.createElement("div");
      desc.className = "portal-stat-desc";
      desc.textContent = spec.desc;
      card.append(desc);
    }
    const features = getStatFeatures(spec.layer) || [];
    const valueField = spec.value && spec.value !== "count" ? spec.value : null;
    if (!features.length) {
      const empty = document.createElement("div");
      empty.className = "portal-stat-empty";
      empty.textContent = statTr("statEmpty");
      card.append(empty);
      return card;
    }
    if (!spec.group) {
      // group= 無し: レイヤー全体を1つのKPIとして表示(クリック連動なし)
      const box = document.createElement("div");
      box.className = "portal-stat-kpis";
      const tile = document.createElement("div");
      tile.className = "portal-stat-kpi portal-stat-static";
      const v = document.createElement("span");
      v.className = "portal-stat-kpi-value";
      v.textContent = statFmt(statAggregateAll(features, valueField, spec.agg || "sum"));
      tile.append(v);
      if (valueField) {
        const k = document.createElement("span");
        k.className = "portal-stat-kpi-key";
        k.textContent = `${statTr("statAgg_" + (spec.agg || "sum"))}: ${valueField}`;
        tile.append(k);
      }
      box.append(tile);
      card.append(box);
      return card;
    }
    const rows = computeGroupStats(features, spec.group, valueField);
    const vals = rows.map(r => statMetric(r, spec, valueField));
    if (spec.kind === "kpi") {
      const box = document.createElement("div");
      box.className = "portal-stat-kpis";
      rows.forEach((row, i) => {
        const tile = statSegButton("portal-stat-kpi", row.key, idx, spec);
        const k = document.createElement("span");
        k.className = "portal-stat-kpi-key";
        k.textContent = row.key || "(empty)";
        const v = document.createElement("span");
        v.className = "portal-stat-kpi-value";
        v.textContent = statFmt(vals[i]);
        tile.append(k, v);
        box.append(tile);
      });
      card.append(box);
    } else if (spec.kind === "pie") {
      const wrap = document.createElement("div");
      wrap.className = "portal-stat-pie-wrap";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "-1.05 -1.05 2.1 2.1");
      svg.classList.add("portal-stat-pie");
      const legend = document.createElement("div");
      legend.className = "portal-stat-legend";
      const total = vals.reduce((a, v) => a + (v || 0), 0);
      let angle = -Math.PI / 2;
      rows.forEach((row, i) => {
        const val = vals[i] || 0;
        const color = STAT_COLORS[i % STAT_COLORS.length];
        if (val > 0 && total > 0) {
          const slice = val >= total
            ? document.createElementNS("http://www.w3.org/2000/svg", "circle")
            : document.createElementNS("http://www.w3.org/2000/svg", "path");
          if (val >= total) {
            slice.setAttribute("r", "1");
          } else {
            const a1 = Math.min(angle + (val / total) * Math.PI * 2, Math.PI * 1.5);
            slice.setAttribute("d", statPieSlice(angle, a1));
            angle = a1;
          }
          slice.setAttribute("fill", color);
          if (spec.group && setStatWhere) {
            slice.addEventListener("click", () => statSegClick(idx, spec, row.key));
            if (statSel.get(idx)?.key === row.key) slice.classList.add("portal-stat-active");
          }
          svg.append(slice);
        }
        const item = statSegButton("portal-stat-seg", row.key, idx, spec);
        const sw = document.createElement("span");
        sw.className = "portal-stat-swatch";
        sw.style.background = color;
        const lb = document.createElement("span");
        const pct = total > 0 ? ` (${Math.round((val / total) * 1000) / 10}%)` : "";
        lb.textContent = `${row.key || "(empty)"} — ${statFmt(val)}${pct}`;
        item.append(sw, lb);
        legend.append(item);
      });
      wrap.append(svg, legend);
      card.append(wrap);
    } else {
      // kind=bar(既定): 水平棒グラフ
      const box = document.createElement("div");
      box.className = "portal-stat-bars";
      const max = Math.max(...vals.map(v => v || 0), 0);
      rows.forEach((row, i) => {
        const val = vals[i] || 0;
        const btn = statSegButton("portal-stat-seg portal-stat-bar-row", row.key, idx, spec);
        const label = document.createElement("span");
        label.className = "portal-stat-bar-label";
        label.textContent = row.key || "(empty)";
        const track = document.createElement("span");
        track.className = "portal-stat-bar-track";
        const fill = document.createElement("span");
        fill.className = "portal-stat-bar-fill";
        fill.style.width = `${max > 0 ? (val / max) * 100 : 0}%`;
        track.append(fill);
        const num = document.createElement("span");
        num.className = "portal-stat-bar-value";
        num.textContent = statFmt(val);
        btn.append(label, track, num);
        box.append(btn);
      });
      card.append(box);
    }
    return card;
  }

  // ---- search: 行 / data-search 属性のポータル埋め込み検索(#125) ----
  // `search: <レイヤー|all> | attr=属性名 | ph=… | title=…` 行は検索セクションを
  // 生成し、ポータル内HTMLの <input data-search="レイヤ|all" data-search-attr="属性">
  // も同じ検索へ接続する。絞り込みはエンジン提供の searchIndex(ベクター検索索引)
  // へ委譲し、候補クリックでポータルを閉じて地物へズーム+選択する
  const SEARCH_LABELS = {
    searchTitle: "検索",
    searchPlaceholder: "住所・施設名・属性値で検索",
    searchNoResults: "該当する地物がありません",
    searchUnsupported: "このエンジンでは埋め込み検索に対応していません",
  };
  const searchTr = key => {
    const text = t ? t(`portal.${key}`) : null;
    if (text && !text.startsWith("portal.")) return text;
    return SEARCH_LABELS[key] ?? key;
  };

  let searchStyleDone = false;
  function ensureSearchStyle() {
    if (searchStyleDone) return;
    searchStyleDone = true;
    const st = document.createElement("style");
    st.textContent = `
.portal-search-input{width:100%;box-sizing:border-box;padding:.45em .6em;font:inherit;border:1px solid #cbd9de;border-radius:6px}
.portal-search-results{display:flex;flex-direction:column;margin-top:.3em;max-height:16em;overflow:auto}
.portal-search-results:empty{display:none}
.portal-search-result{font:inherit;display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;text-align:left;padding:.3em .45em;border:none;border-bottom:1px solid #e4ecef;background:none;cursor:pointer}
.portal-search-result:hover{background:#eef3f9}
.portal-search-value{font-size:.95em}
.portal-search-meta{color:#52636d;font-size:.78em}
.portal-search-empty{color:#777;font-size:.85em;padding:.3em .45em}
`;
    document.head.append(st);
  }

  // 検索入力ごとの結果表示領域(input 直後の .portal-search-results)を取得。
  // 無ければ input の直後へ生成する(カスタムHTMLの data-search 入力用)
  function ensureSearchResultsEl(input) {
    const next = input.nextElementSibling;
    if (next && next.classList.contains("portal-search-results")) return next;
    const box = document.createElement("div");
    box.className = "portal-search-results";
    input.after(box);
    return box;
  }

  // 候補クリック: ポータルを閉じて地物へズーム+選択。
  // applySearchResult 未提供のエンジンは data-feature と同じ applyFeature 経路
  function gotoSearchResult(r) {
    close();
    if (applySearchResult) { void applySearchResult(r); return; }
    if (applyFeature && r?.attr) {
      const layer = r.layerTitle || r.layer || "";
      void applyFeature(layer ? `${layer}/${r.attr}=${r.value}` : `${r.attr}=${r.value}`);
    }
  }

  // 入力のたびに searchIndex へ問い合わせて候補一覧を描き直す。
  // searchSeq で古い応答(打鍵中の先行リクエスト)を破棄する
  let searchSeq = 0;
  async function runPortalSearch(input) {
    const box = ensureSearchResultsEl(input);
    const q = String(input.value || "").trim();
    if (!q) { box.replaceChildren(); return; }
    const note = text => {
      box.replaceChildren();
      const el = document.createElement("div");
      el.className = "portal-search-empty";
      el.textContent = text;
      box.append(el);
    };
    if (!searchIndex) { note(searchTr("searchUnsupported")); return; }
    const spec = { layer: input.dataset.search || "all", attr: input.dataset.searchAttr || "" };
    const gen = ++searchSeq;
    let results;
    try {
      results = await Promise.resolve(searchIndex(q, spec));
    } catch (error) {
      if (gen === searchSeq) note(String(error?.message || error));
      return;
    }
    if (gen !== searchSeq || !input.isConnected) return;
    if (!results?.length) { note(searchTr("searchNoResults")); return; }
    box.replaceChildren();
    for (const r of results.slice(0, 30)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "portal-search-result";
      const value = document.createElement("span");
      value.className = "portal-search-value";
      value.textContent = r.value;
      const meta = document.createElement("span");
      meta.className = "portal-search-meta";
      meta.textContent = [r.layerTitle, r.attr].filter(Boolean).join(" / ");
      btn.append(value, meta);
      btn.addEventListener("click", () => gotoSearchResult(r));
      box.append(btn);
    }
  }

  function renderSearchSection(spec) {
    ensureSearchStyle();
    const wrap = document.createElement("section");
    wrap.className = "portal-section portal-search-section";
    const head = document.createElement("h3");
    head.textContent = spec.title || searchTr("searchTitle");
    wrap.append(head);
    const box = document.createElement("div");
    box.className = "portal-search";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "portal-search-input";
    input.setAttribute("data-search", spec.layer || "all");
    if (spec.attr) input.setAttribute("data-search-attr", spec.attr);
    input.placeholder = spec.ph || searchTr("searchPlaceholder");
    if (!searchIndex) input.disabled = true;
    const results = document.createElement("div");
    results.className = "portal-search-results";
    box.append(input, results);
    wrap.append(box);
    return wrap;
  }

  // ---- form: 行のフォーム投稿(#131) ----
  // カード/data-form 属性から開く入力フォーム。loc フィールドは地図クリックで
  // 座標を拾い(pickLocation 経由・ポータルは一時的に閉じる)、送信は
  // {form, geometry:GeoJSON Point|null, properties:{…}} を to=URL または
  // backend:パス へ JSON POST する。投稿結果の地図反映(即時ピン)は後続課題

  // 位置拾いでポータルを閉じても入力を保持する下書き(フォーム名→値)
  const formDrafts = new Map();

  function openForm(form) {
    const body = document.querySelector("#portal-body");
    if (!body || !form) return;
    const draft = formDrafts.get(form.name) || { values: {}, loc: null };
    formDrafts.set(form.name, draft);
    body.replaceChildren();
    const wrap = document.createElement("section");
    wrap.className = "portal-section portal-form";
    const head = document.createElement("h3");
    head.textContent = form.title || form.name;
    wrap.append(head);
    if (form.desc) {
      const desc = document.createElement("div");
      desc.className = "portal-section-body";
      desc.textContent = form.desc;
      wrap.append(desc);
    }
    const inputs = {};
    for (const field of form.fields) {
      const label = document.createElement("label");
      label.className = "portal-form-field";
      label.style.display = "block";
      label.style.margin = "0.6em 0";
      const cap = document.createElement("span");
      cap.className = "portal-form-label";
      cap.style.display = "block";
      cap.textContent = field.label;
      label.append(cap);
      let input;
      if (field.type === "textarea") {
        input = document.createElement("textarea");
        input.rows = 4;
      } else if (field.type === "select") {
        input = document.createElement("select");
        const empty = document.createElement("option");
        empty.value = "";
        input.append(empty);
        for (const opt of field.options) {
          const option = document.createElement("option");
          option.value = option.textContent = opt;
          input.append(option);
        }
      } else if (field.type === "date") {
        input = document.createElement("input");
        input.type = "date";
      } else if (field.type === "photo") {
        input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
      } else if (field.type === "loc" && pickLocation) {
        // 位置指定: ポータルを閉じて地図クリック1回で座標を拾う
        input = document.createElement("div");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "portal-form-loc-btn";
        const out = document.createElement("span");
        out.className = "portal-form-loc-value";
        btn.textContent = t("portal.formPickLocation");
        out.textContent = draft.loc ? ` ${draft.loc.lon.toFixed(6)}, ${draft.loc.lat.toFixed(6)}` : "";
        btn.addEventListener("click", () => {
          // 入力中の値を下書きへ退避してから位置拾いへ移る
          for (const f of form.fields) {
            const el = inputs[f.name];
            if (el && f.type !== "photo") draft.values[f.name] = el.value;
          }
          if (form.cam && applyCam) applyCam(form.cam);
          close();
          void Promise.resolve(pickLocation()).then(lonlat => {
            if (lonlat) draft.loc = { lon: lonlat.lon, lat: lonlat.lat };
            open();
            openForm(form);
          });
        });
        input.append(btn, out);
      } else {
        // text / pickLocation 未提供エンジンでの loc(`lon,lat` 手入力)
        input = document.createElement("input");
        input.type = "text";
        if (field.type === "loc") input.placeholder = "lon,lat";
      }
      if (input.tagName !== "DIV") {
        if (field.type !== "photo" && draft.values[field.name] != null) input.value = draft.values[field.name];
        inputs[field.name] = input;
      }
      label.append(input);
      wrap.append(label);
    }
    const status = document.createElement("div");
    status.className = "portal-form-status";
    const actions = document.createElement("div");
    actions.className = "portal-form-actions";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = t("portal.formBack");
    back.addEventListener("click", () => update());
    const send = document.createElement("button");
    send.type = "button";
    send.className = "portal-form-submit";
    send.textContent = t("portal.formSubmit");
    send.addEventListener("click", () => { void submit(); });
    actions.append(back, send);
    wrap.append(actions, status);
    body.append(wrap);

    async function submit() {
      const properties = {};
      for (const f of form.fields) {
        if (f.type === "loc") {
          // 手入力 `lon,lat`(pickLocation 無し環境)も geometry へ変換
          const el = inputs[f.name];
          if (el && el.value) {
            const [lon, lat] = el.value.split(",").map(Number);
            if (Number.isFinite(lon) && Number.isFinite(lat)) draft.loc = { lon, lat };
          }
          continue;
        }
        const el = inputs[f.name];
        if (!el) continue;
        if (f.type === "photo") {
          const file = el.files && el.files[0];
          if (file) properties[f.name] = await readFileAsDataUrl(file);
        } else {
          properties[f.name] = el.value;
        }
      }
      const payload = {
        form: form.name,
        geometry: draft.loc ? { type: "Point", coordinates: [draft.loc.lon, draft.loc.lat] } : null,
        properties,
      };
      send.disabled = true;
      status.textContent = t("portal.formSending");
      try {
        await postForm(form.to, payload);
        formDrafts.delete(form.name);
        status.textContent = t("portal.formSent");
      } catch (error) {
        status.textContent = t("portal.formFailed", { error: String(error && error.message || error) });
      } finally {
        send.disabled = false;
      }
    }
  }

  // to= の送信先へ JSON POST。`backend:パス` はローカルバックエンド
  // (アプリ/functions 側が保存を実装する前提の薄い口)のパスとして解決する
  async function postForm(to, payload) {
    if (!to) throw new Error("to= is not set");
    const url = /^backend:/i.test(to)
      ? backendUrl("/" + to.replace(/^backend:/i, "").replace(/^\/+/, ""))
      : to;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`POST ${url} -> ${response.status}`);
    return response;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function open() {
    if (!available()) return;
    update();
    const overlay = document.querySelector("#portal-overlay");
    if (overlay) overlay.hidden = false;
  }

  function close() {
    const overlay = document.querySelector("#portal-overlay");
    if (overlay) overlay.hidden = true;
  }

  function isOpen() {
    const overlay = document.querySelector("#portal-overlay");
    return !!overlay && !overlay.hidden;
  }

  // 🏠ボタンで開始画面を開く / 「地図を開く」・Esc で閉じる / 「ビュー解除」で復元
  function bindEvents() {
    document.querySelector("#portal-open")?.addEventListener("click", open);
    document.querySelector("#portal-close")?.addEventListener("click", close);
    document.querySelector("#portal-clear")?.addEventListener("click", () => { void clearView(); update(); });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") close();
    });
  }

  return { available, updateButton, update, open, close, isOpen, bindEvents };
}
