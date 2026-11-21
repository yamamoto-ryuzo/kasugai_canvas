// sample-layer-panel — registerPanel でパネルタブへユーザーパネルを追加する例。
// 標準レイヤタブとは別に、プラグイン独自のレイヤ表示（ここでは型別グループ＋
// 表示件数バッジ＋フィルタ有無マーク）を行う。
//
// registerPanel(spec) → { key, tab, panel }
//   spec.id    : プラグイン内で一意のID（owner は自動でマニフェストID）
//   spec.title : タブラベル / spec.icon : ラベル先頭の絵文字 / spec.after : 挿入位置
//   spec.onInit(panel) / onShow(panel) / onHide(panel)
//
// api.bindLayerView(container, opts) は「レイヤ一覧の最小描画＋自動追従」。
// 完全に独自の表示は listLayers()/setLayerVisible()/focusLayer() と
// "layers-changed" イベントを直接使って構築する。

export async function init(api, manifest) {
  let view = null;

  const entry = api.registerPanel({
    id: "layers2",
    title: manifest.name || "レイヤ2",
    icon: "🗂",
    onInit(panel) {
      // bindLayerView: listLayers() + layers-changed で自動再描画される一覧。
      // groupBy/sort/filter/decorateRow/decorateGroup で表示を自由に変えられる
      view = api.bindLayerView(panel, {
        // 例: .kasc の group ではなく行タイプ別にまとめる
        groupBy: l => l.type || "その他",
        // 例: タイトル五十音順
        sort: ls => [...ls].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "ja")),
        // グループ見出しに「表示数/総数」を付ける
        decorateGroup: (head, key, ls) => {
          const n = document.createElement("small");
          n.style.cssText = "margin-left:auto;color:#6a7d87;font-weight:400;";
          n.textContent = `${ls.filter(l => l.visible).length}/${ls.length}`;
          head.append(n);
        },
        // フィルタ付きレイヤに ⏷ マークを付ける
        decorateRow: (row, l) => {
          if (!l.filter) return;
          const b = document.createElement("small");
          b.style.cssText = "color:#4a7d8c;";
          b.textContent = "⏷";
          b.title = `filter: ${l.filter}`;
          row.append(b);
        },
      });
    },
  });

  if (!entry) {
    console.warn("[sample-layer-panel] registerPanel が使えません（このエンジンは未対応）");
    return;
  }

  api.registerPlugin({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    dispose() { view?.unbind(); },
  });
}
