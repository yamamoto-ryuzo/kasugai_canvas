# shared — エンジン非依存コア

KASUGAI Canvas のマルチエンジン化に伴う、エンジン非依存モジュールの置き場。

## レイアウト方針

- `web/cesium/` … Cesium フロント（現行アプリ。ルート `index.html` は `?engine=` に応じて各エンジンへリダイレクト）
- `web/maplibre/` … MapLibre フロント（実装済み）
- `web/openlayers/` … OpenLayers フロント（実装済み）
- `web/leaflet/` … Leaflet フロント（実装済み）
- `web/shared/` … 本ディレクトリ。エンジン横断で使うコードをここへ段階的に切り出す
- `web/projects/` … 静的配信用の同梱プロジェクトデータ（エンジン非依存）

## ここに置くもの（予定）

- `.kasc` 行パーサー・ローダー（geo_webview 側 `kasc_loader.js` の還流）
- `vector-decode.js`・`gpkg-worker.js`・`sw-duckdb.js` 等のデコード/Worker 層
- `i18n.js`・`i18n/`（翻訳辞書）
- QML→スタイルコンパイラ（`qml/cesium.js`・`qml/maplibre.js`・`qml/openlayers.js`）

※エンジン固有の描画コードは各エンジンフォルダに置き、本ディレクトリから参照する。
