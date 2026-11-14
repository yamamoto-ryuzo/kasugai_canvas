// ---- ポータル(portal:/html:/view:/link: 行で構成する開始画面) ----
// 全エンジン共通のポータルUIモジュール。各エンジンは
//   1) index.html に #portal-open ボタンと #portal-overlay 構造を置き
//   2) app.js で view:/html:/portal:/link: 行をパースして保持し
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
//  .portal-footer/.portal-open)

// cfg:
//   t(key, vars?)          — i18n 関数 (portal.* キーを使う)
//   resolveProjectUrl(path)— DATA/ 等の相対パス → URL
//   loadInfoContent(el, spec, unused, {errorText}) — loadKascInfoContent
//   applyView(view)        — view: カード押下時の地図状態適用(async 可)
//   clearView()            — 適用前状態への復元(async 可)
//   applyCam(name)?        — data-cam="カメラ名" の移動(省略可)
//   applyBase(name)?       — data-base="背景名" の背景地図切替(省略可)
//   getActiveViewName()    — 適用中ビュー名 or null
//   getPortalSpec()        — {enabled,title,open,html?} or null (portal: 行)
//   getPanelTitle()        — title: 行のパネルタイトル or null
//   getHtmlSections()      — [{title,spec}] (html: 行・記述順)
//   getCards()             — [{kind:"view"|"link", entry:{name,desc,img,url?,…}}]
//
// ポータル内HTML(html:/portal html=)で使える data-* 属性:
//   data-view="ビュー名" — ビュー適用＋ポータルを閉じる
//   data-link="URL"      — 外部URLを新規タブで開く
//   data-cam="カメラ名"  — カメラプリセットへ移動(ポータルは開いたまま)
//   data-base="背景名"   — 背景地図を切替(none/transparent も可)
//   data-clear           — ビュー解除(適用前状態へ復元)
//   data-close           — ポータルを閉じる
export function createKascPortal(cfg) {
  const {
    t, resolveProjectUrl = u => u, loadInfoContent,
    applyView, clearView, applyCam, applyBase,
    getActiveViewName = () => null,
    getPortalSpec = () => null,
    getPanelTitle = () => null,
    getHtmlSections = () => [],
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
  }

  // ポータル画面の内容を構築する。applyInspector 完了時と表示言語切替時に呼ぶ
  function update() {
    updateButton();
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
    // view:/link: カード(宣言順で同一グリッド)
    const cards = getCards();
    if (cards.length) {
      const hasView = cards.some(c => c.kind === "view");
      const head = document.createElement("div");
      head.className = "portal-views-head";
      head.textContent = t(hasView ? "portal.views" : "portal.links");
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
    if (!getHtmlSections().length && !cards.length) {
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
