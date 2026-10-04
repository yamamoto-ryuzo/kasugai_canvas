// KASUGAI Canvas ドキュメント共通ナビゲーション
// 使い方: <script src="nav.js" defer></script>（auth/ 配下は ../nav.js）
// - 左サイドバーにサイト内リンク・デモリンク・ページ内目次を生成
// - 現在ページを自動ハイライト
// - JS が無効でも本文は通常表示される（サイドバーだけ出ない）
(function () {
  const base = new URL('.', document.currentScript.src).pathname;
  const VERSION = 'v4.20.0';

  const GROUPS = [
    {
      label: null,
      items: [
        { href: 'index.html', text: 'トップ・概要' },
        { href: 'guide.html', text: '使い方・インストール' },
        { href: 'features.html', text: '機能と実装' },
        { href: 'inspector.html', text: '.kasc 設定仕様' }
      ]
    },
    {
      label: '技術選定',
      items: [
        { href: 'data.html', text: 'データ形式' },
        { href: 'library.html', text: 'ライブラリ' },
        { href: 'architecture.html', text: 'システム構成' }
      ]
    },
    {
      label: '拡張・連携',
      items: [
        {
          href: 'auth/', text: '認証とプラグイン',
          children: [
            { href: 'auth/none.html', text: '0. 認証なし（none）' },
            { href: 'auth/local.html', text: '1. ローカル認証' },
            { href: 'auth/password.html', text: '2. 簡易パスワード' },
            { href: 'auth/pages.html', text: '3. Cloudflare Pages' },
            { href: 'auth/workers.html', text: '4. Cloudflare Workers' },
            { href: 'auth/cloudrun.html', text: '5-7. Cloud Run' }
          ]
        },
        { href: 'google.html', text: 'Google 連携・AI' },
        { href: 'qgis.html', text: 'QGIS・GDAL 連携（構想）' }
      ]
    },
    {
      label: '記録',
      items: [
        { href: 'hackathon.html', text: 'ハッカソン' }
      ]
    }
  ];

  const DEMOS = [
    { href: 'web/', text: '▶ デモ（このサイト内）' },
    { href: 'https://cesium-5ie.pages.dev/', text: '▶ デモ（Cloudflare Pages）' },
    { href: 'https://kasugai-canvas.ryu-3cb.workers.dev/', text: '▶ デモ（Cloudflare Workers）' }
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

  // ページ内目次（h2 が複数あれば h2、単一なら h3 から自動生成）
  const h2s = document.querySelectorAll('main h2');
  const heads = h2s.length > 1 ? h2s : document.querySelectorAll('main h3');
  if (heads.length > 1) {
    html += '<div class="nav-group"><div class="nav-group-label">このページ</div><ul class="nav-toc">';
    heads.forEach((h, i) => {
      if (!h.id) h.id = 'sec-' + i;
      html += `<li><a href="#${h.id}">${h.textContent.trim()}</a></li>`;
    });
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
