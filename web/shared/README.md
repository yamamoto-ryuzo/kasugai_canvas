# shared — エンジン非依存コア

KASUGAI Canvas のマルチエンジン化に伴う、エンジン非依存モジュールの置き場。

## レイアウト方針

- `web/index.html` … エンジン選択リダイレクト（`?engine=`・既定 cesium）
- `web/cesium/` … Cesium フロント（メインエンジン・現行アプリ）
- `web/maplibre/` … MapLibre フロント（.kasc プレイヤー・実装済み）
- `web/openlayers/` … OpenLayers フロント（.kasc プレイヤー・実装済み）
- `web/leaflet/` … Leaflet フロント（.kasc プレイヤー・実装済み）
- `web/gsimaps/` … GSI Maps フロント（中間エンジン。vendored 地理院地図
  `web/vendor/gsimaps/` を同一オリジン iframe で組み込み、.kasc を
  GSI/Leaflet API 経由で再生。上流コードは無改変）
- `web/shared/` … 本ディレクトリ。エンジン横断で使うコードをここへ集約する
- `web/projects/` … 静的配信用の同梱プロジェクトデータ（エンジン非依存）

## 収録モジュール

| ファイル | 役割 |
|---|---|
| `kasc.js` | .kasc 行パーサー＋プロジェクトローダー（cam↔zoom・URL ビュー・テーマ・ブックマーク・`?kasc=` 直読み） |
| `vector-load.js` / `vector-decode.js` | ベクター系行タイプ → GeoJSON 正規化ローダー／WKB・プロパティ変換ユーティリティ |
| `gpkg-worker.js` | GeoPackage 読み込み Worker（sql.js で別スレッド処理） |
| `qml-style.js` / `qml-2d.js` | QGIS .qml スタイルのコンパイルと 2D エンジンへの適用アダプタ |
| `attr-widget.js` | 画面下部ドッキングの属性テーブル |
| `player-api.js` | 2D プレイヤー向け `window.kasugaiApi` アダプタ（AI ツール公開の土台） |
| `ai-chat.js` / `mcp.js` / `box.js` | エンジン横断 AI チャット基盤（プロバイダ接続・ツール実行・MCP・Box OAuth） |
| `engine-switch.js` | エンジン切替 UI とレイヤ状態引継ぎ |
| `print.js` | 印刷・帳票出力 |
| `i18n.js` / `i18n/` | 翻訳辞書と適用機構 |
| `deck-drape.js` / `deck-ground.js` | 2D エンジン上の deck.gl 3D Tiles 表示（ドレープ・自動接地） |
| `localfs.js` | `?kasc=local` のローカルフォルダ直読み（File System Access API） |
| `kasc_loader.js` | geo_webview 生成ビューア HTML へのインライン埋め込み用ローダー |

※エンジン固有の描画コードは各エンジンフォルダに置き、本ディレクトリから参照する。
