// KASUGAI Canvas ドキュメント共通ナビゲーション
// 使い方: <script src="nav.js" defer></script>（auth/ 配下は ../nav.js）
// - 左サイドバーにサイト内リンク・デモリンクを生成
// - 現在ページを自動ハイライト
// - JS が無効でも本文は通常表示される（サイドバーだけ出ない）
(function () {
  const base = new URL('.', document.currentScript.src).pathname;
  const VERSION = 'v6.23.0';

  const GROUPS = [
    {
      label: null,
      items: [
        { href: 'index.html', text: '1. トップ・概要' }
      ]
    },
    {
      label: 'マルチエンジン — WebGIS / ローカルアプリ',
      items: [
        { href: 'datahost.html', text: '2. 【WebGIS】ブラウザ WebGIS（外部ホスト配信）' },
        { href: 'guide.html', text: '3. 【アプリ】ローカルアプリ（kasugai_canvas.exe）' },
        { href: 'features/v6.html', text: '4. マルチエンジン（6エンジン）' },
        { href: 'inspector.html', text: '5. .kasc 設定仕様' },
        { href: 'runtime-cache.html', text: '6. ランタイム永続キャッシュ' }
      ]
    },
    {
      label: 'AI — API / ブリッジ',
      items: [
        { href: 'ai-api.html', text: '7. 【API】内蔵AI（Google 連携・AI）' },
        { href: 'ai-bridge.html', text: '8. 【ブリッジ】外部エージェント連携（Copilot・Devin・Antigravity）' },
        { href: 'ai-tools.html', text: '9. AI ツール仕様' },
        { href: 'bridge-hub.html', text: '10. ブリッジハブ（bridge-hub.exe）' }
      ]
    },
    {
      label: 'QGIS連携 — エクスポート / プロジェクト再現',
      items: [
        { href: 'qgis-delivery.html', text: '11. QGIS連携の利用方法' },
        { href: 'qgis-policy.html', text: '12. QGIS・GDAL連携（方針・構想）' },
        { href: 'qgis.html', text: '13. 実装済みの再現範囲' }
      ]
    },
    {
      label: '仕様',
      items: [
        {
          href: 'features.html', text: '14. 機能と実装',
          children: [
            { href: 'features/v0.html', text: 'V0: システム基本構成' },
            { href: 'features/v1.html', text: 'V1: GIS 基本機能' },
            { href: 'features/v2.html', text: 'V2: プレゼンテーション' },
            { href: 'features/v3.html', text: 'V3: AI 連携' },
            { href: 'features/v4.html', text: 'V4: プラグイン・外部連携' },
            { href: 'features/v5.html', text: 'V5: アプリ化（ローカル連携）' },
            { href: 'features/v6.html', text: 'V6: マルチエンジン' },
            { href: 'features/v7.html', text: 'V7: QGIS連携' },
            { href: 'features/v8.html', text: 'V8: 解析（予定）' }
          ]
        }
      ]
    },
    {
      label: '技術選定',
      items: [
        { href: 'data.html', text: '15. データ形式' },
        { href: 'performance.html', text: '16. 描画性能とデータ形式方針' },
        { href: 'library.html', text: '17. ライブラリ' },
        { href: 'architecture.html', text: '18. システム構成' },
        { href: 'security.html', text: '19. セキュリティ対策' }
      ]
    },
    {
      label: '拡張・連携',
      items: [
        {
          href: 'auth/', text: '20. 認証とプラグイン',
          children: [
            { href: 'auth/none.html', text: '0. 認証なし（none）' },
            { href: 'auth/local.html', text: '1. ローカル認証' },
            { href: 'auth/password.html', text: '2. 簡易パスワード' },
            { href: 'auth/pages.html', text: '3. Cloudflare Pages' },
            { href: 'auth/workers.html', text: '4. Cloudflare Workers' },
            { href: 'auth/cloudrun.html', text: '5-7. Cloud Run' }
          ]
        }
      ]
    },
    {
      // NAV には挑戦中のイベントのみ掲載。終了したイベントはここから外し、
      // records.html（終了したイベントの記録）のテーブルへ移して履歴として残す
      label: '記録（挑戦中）',
      items: [
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
    html += '<div class="nav-group">';
    if (g.label) html += `<div class="nav-group-label">${g.label}</div>`;
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
