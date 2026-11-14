// KASUGAI Canvas ドキュメント共通ナビゲーション
// 使い方: <script src="nav.js" defer></script>（auth/ 配下は ../nav.js）
// - 左サイドバーにサイト内リンク・デモリンクを生成
// - 現在ページを自動ハイライト
// - JS が無効でも本文は通常表示される（サイドバーだけ出ない）
(function () {
  const base = new URL('.', document.currentScript.src).pathname;
  const VERSION = 'v6.23.0';

  // ナビ構造 = Canvas UI の章・節構成
  //   章（グループ）= パネルの呼び名（レイヤパネル・ツール・AIチャット・管理・プラグイン）
  //   節（項目）    = パネル内のタブ・ツール・サブペイン名（実際の UI 表記に合わせる）
  // UI に直接対応しないページは「参考 —」章、機能追加の履歴は
  // features.html（バージョン履歴のカード索引）に集約する
  const GROUPS = [
    {
      // ==== 概要（トップページ＝Canvas UI の説明） ====
      section: '概要',
      sectionHref: 'index.html',
      items: [
        { href: 'index.html', text: 'Canvas UI の説明' },
      ]
    },
    {
      // ==== 使い方（UI パネル単位の章立て） ====
      section: '使い方',
      // 画面左パネル（レイヤパネル）のタブ＋パネル下部の engine: 切替リンク。
      // 詳細は v1（画面機能）の各節
      label: '1. レイヤパネル',
      href: 'panel.html',
      items: [
        { href: 'features/v1.html#tab-layer', text: '1-1 レイヤ' },
        { href: 'features/v1.html#tab-legend', text: '1-2 凡例' },
        { href: 'features/v1.html#tab-search', text: '1-3 検索' },
        { href: 'features/v1.html#tab-attr', text: '1-4 属性' },
        { href: 'features/v1.html#tab-camera', text: '1-5 カメラ' },
        { href: 'features/v1.html#tab-display', text: '1-6 表示' },
        { href: 'features/v1.html#tab-info', text: '1-7 情報' },
        { href: 'features/v2.html', text: '1-8 FLY（プレゼンテーション）' },
        { href: 'features/v8.html', text: '1-9 ポータル' },
        { href: 'features/v6.html', text: '1-10 マルチエンジン（engine: 切替）' },
      ]
    },
    {
      // 🧰 ツールボタンで開くツールドックのサブタブ
      label: '2. ツール',
      href: 'panel.html#tools-cards',
      items: [
        { href: 'features/v1.html#tool-measure', text: '2-1 計測' },
        { href: 'features/v1.html#tool-select', text: '2-2 選択・集計' },
        { href: 'features/v1.html#tool-draw', text: '2-3 作図' },
        { href: 'features/v1.html#tool-profile', text: '2-4 標高断面' },
        { href: 'features/v1.html#tool-los', text: '2-5 見通し判定' },
        { href: 'features/v1.html#tool-export', text: '2-6 エクスポート' },
        { href: 'features/v1.html#tool-print', text: '2-7 印刷' },
        { href: 'features/v1.html#tool-time', text: '2-8 時系列' },
      ]
    },
    {
      // 地図右上のナビゲーション操作群
      label: '3. ナビゲーション',
      href: 'features/v1.html#nav',
      items: [
        { href: 'features/v1.html#nav', text: '3-1 コンパス・3D・オービット' },
        { href: 'features/v1.html#nav', text: '3-2 表示履歴 ◀ ▶' },
        { href: 'features/v1.html#nav', text: '3-3 矩形ズーム' },
        { href: 'features/v1.html#nav', text: '3-4 地点座標の取得' },
        { href: 'features/v1.html#nav', text: '3-5 現在地へ移動・フルスクリーン' },
      ]
    },
    {
      // 地図左下のベースマップセレクタ
      label: '4. ベースマップ',
      href: 'features/v1.html#basemap',
      items: [
        { href: 'features/v1.html#basemap', text: '4-1 ベースマップ選択' },
        { href: 'features/v1.html#basemap', text: '4-2 別アプリで開く（CDN・アプリ・Google Earth）' },
      ]
    },
    {
      label: '5. AIチャット',
      href: 'ai-chat.html',
      items: [
        { href: 'ai-api.html', text: '5-1 【API】内蔵AI（Google 連携・AI）' },
        { href: 'ai-bridge.html', text: '5-2 【ブリッジ】外部エージェント連携（Copilot・Devin・Antigravity）' },
        { href: 'ai-tools.html', text: '5-3 AI ツール仕様' },
        { href: 'bridge-hub.html', text: '5-4 ブリッジハブ（bridge-hub.exe）' },
        { href: 'features/v3.html', text: '5-5 AI 連携の構成（V3）' },
        { href: 'features/v9.html', text: '5-6 解析（予定・V9）' },
      ]
    },
    {
      // ⚙ 管理ウィンドウのカテゴリ（プロジェクト・AI・Google Maps・アプリ・その他）
      label: '6. 管理',
      href: 'manage.html',
      items: [
        { href: 'guide.html', text: '6-1 プロジェクト' },
        { href: 'inspector.html', text: '6-2 インスペクター' },
        { href: 'ai-api.html', text: '6-3 AI' },
        { href: 'ai-api.html', text: '6-4 Google Maps' },
        { href: 'features/v5.html', text: '6-5 アプリ' },
        { href: 'features/v1.html', text: '6-6 その他' },
      ]
    },
    {
      // PLUGIN/ に置く拡張パネル（パネルタブへ追加される）
      label: '7. プラグイン',
      href: 'plugins.html',
      items: [
        {
          href: 'auth/', text: '7-1 認証とプラグイン',
          children: [
            { href: 'auth/none.html', text: '認証なし（none）' },
            { href: 'auth/local.html', text: 'ローカル認証' },
            { href: 'auth/password.html', text: '簡易パスワード' },
            { href: 'auth/pages.html', text: 'Cloudflare Pages' },
            { href: 'auth/workers.html', text: 'Cloudflare Workers' },
            { href: 'auth/cloudrun.html', text: 'Cloud Run' }
          ]
        },
        { href: 'features/v4.html', text: '7-2 プラグイン・外部連携（V4）' },
      ]
    },
    {
      // ==== 技術資料（UI パネルに対応しない技術系ドキュメント） ====
      section: '技術資料',
      label: '1. 設定・システム構成',
      items: [
        {
          href: 'ref-qgis.html', text: '1-1 QGIS連携',
          children: [
            { href: 'qgis-delivery.html', text: 'QGIS連携の利用方法' },
            { href: 'features/v7.html', text: 'QGIS連携 — 方針・構想・再現（V7）' },
            { href: 'qgis.html', text: '実装済みの再現範囲' },
          ]
        },
        {
          href: 'ref-runtime.html', text: '1-2 配信・実行形態',
          children: [
            { href: 'datahost.html', text: 'ブラウザ WebGIS（外部ホスト配信）' },
            { href: 'runtime-cache.html', text: 'ランタイム永続キャッシュ' },
          ]
        },
        {
          href: 'ref-spec.html', text: '1-3 設定・内部仕様',
          children: [
            { href: 'data.html', text: 'データ形式' },
            { href: 'performance.html', text: '描画性能とデータ形式方針' },
            { href: 'library.html', text: 'ライブラリ' },
            { href: 'architecture.html', text: 'システム構成' },
            { href: 'features/v0.html', text: '実装詳細（V0: システム基本構成）' },
            { href: 'security.html', text: 'セキュリティ対策' },
          ]
        },
      ]
    },
    {
      // バージョン別の機能追加履歴は features.html のカード索引へ集約。
      // NAV には挑戦中のイベントのみ掲載。終了したイベントは records.html へ
      label: '2. 履歴・記録',
      items: [
        { href: 'features.html', text: '2-1 バージョン履歴（機能カード索引）' },
        { href: 'g-idea.html', text: '2026/09-12 イチBizアワード2026 提案書' },
        { href: 'zennfes.html', text: '2026/11-12 Zennfes Autumn 2026 さくらのAIチャレンジ祭り' },
        { href: 'records.html', text: '📁 終了したイベントの記録' }
      ]
    }
  ];


  const DEMOS = [
    { href: 'https://yamamoto-ryuzo.github.io/kasugai-canvas-web/', text: '▶ デモ（CDN ホスト版）' },
    { href: 'https://yamamoto-ryuzo.github.io/kasugai-canvas-web/V6/', text: '▶ V6 デモ（CDN ホスト版・最終版固定）' },
    { href: 'https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable/cesium/?kasc=https%3A%2F%2Fyamamoto-ryuzo.github.io%2Fkasugai_canvas_webGIS%2Fsample_qgis%2Fkasugai_canvas.kasc', text: '▶ QGIS プロジェクトデモ（sample_qgis）' },
    { href: 'https://github.com/yamamoto-ryuzo/kasugai_canvas/issues', text: '🐛 問い合わせ（GitHub Issues）' }
  ];

  function norm(path) {
    // 末尾の index.html / / を正規化して比較できる形にする
    return path.replace(/index\.html$/, '').replace(/\/$/, '');
  }
  const current = norm(location.pathname);

  function isActive(href) {
    return norm(base + href) === current;
  }

  const nav = document.createElement('aside');
  nav.id = 'site-nav';

  let html = `<div class="nav-title"><a href="${base}index.html">KASUGAI Canvas</a><span class="nav-version">${VERSION}</span></div>`;


  html += '<div class="nav-demos">';
  for (const d of DEMOS) {
    html += `<a class="nav-demo" href="${d.href.startsWith('http') ? d.href : base + d.href}"${d.href.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${d.text}</a>`;
  }
  html += '</div>';

  for (const g of GROUPS) {
    if (g.section) html += g.sectionHref
      ? `<div class="nav-section"><a href="${base}${g.sectionHref}">${g.section}</a></div>`
      : `<div class="nav-section">${g.section}</div>`;
    html += '<div class="nav-group">';
    if (g.label) {
      const lActive = g.href && isActive(g.href) ? ' class="active"' : '';
      html += g.href
        ? `<div class="nav-group-label"><a href="${base}${g.href}"${lActive}>${g.label}</a></div>`
        : `<div class="nav-group-label">${g.label}</div>`;
    }
    html += '<ul>';
    for (const item of g.items) {
      const active = isActive(item.href) ? ' class="active"' : '';
      html += `<li><a href="${base}${item.href}"${active}>${item.text}</a>`;
      if (item.children) {
        html += '<ul class="nav-sub">';
        for (const c of item.children) {
          const cActive = isActive(c.href) ? ' class="active"' : '';
          html += `<li><a href="${base}${c.href}"${cActive}>${c.text}</a></li>`;
        }
        html += '</ul>';
      }
      html += '</li>';
    }
    html += '</ul></div>';
  }

  nav.innerHTML = html;
  document.body.prepend(nav);
  document.body.classList.add('has-nav');

  // モバイル用ハンバーガー
  const btn = document.createElement('button');
  btn.className = 'nav-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'メニュー');
  btn.textContent = '☰';
  btn.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.body.prepend(btn);
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) document.body.classList.remove('nav-open');
  });
})();
