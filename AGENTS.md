# KASUGAI Canvas — 開発ルール

## バージョン採番方針

- **v5.0 は全機能が完成した後に採番する**。それまでのリリースは 4.x 系（4.0.0, 4.1.0, ...）で進める
- v5.0 への到達条件: AIチャット・エージェント連携・Google Maps Platform 連携・ローカルファイル保存など、計画中の機能がすべて完成した時点

## バージョン管理手順

- バージョン番号の正本: `server\Cargo.toml` の `package.version`
- リリース時は以下を同じ番号に更新: `download/latest.json`、`home.html` のバージョンバッジ、`README.md` のバージョン表記、`installer/kasugai_canvas.nsi`（`python run.py -B` が自動更新する場合あり）
- `CHANGELOG.md` に日付付きセクションを追加（Keep a Changelog 形式）
- 配布物は `python run.py -B` で `download/` に作成し、コミットしてプッシュ

## ドキュメント方針

- 使い方・設定仕様・AI/セキュリティ等のドキュメントは `home.html`（GitHub Pages）に集約する
- `README.md` は概要＋開発者向け情報のみ。ユーザー向け情報を二重管理しない

## 言語方針

- **リポジトリの基本言語は日本語**とする。ドキュメント・コードコメント・`web/index.html` のリテラルテキスト（`data-i18n` 適用前の初期表示）は日本語で記述する
- **アプリの翻訳（i18n）の基準言語は英語**とする。`web/i18n/en.json` がフォールバック辞書であり、`t()` はキー未登録時に en の値を返す
- 新しい翻訳キーを追加するときは `en.json` を正本として先に追加し、全言語の辞書（`web/i18n/*.json`）でキー数を一致させる
- 対応言語は `web/i18n.js` の `SUPPORTED_LANGUAGES` で管理。言語追加は同配列と辞書ファイルの追加のみで行う

## サーバー方針

- フロントエンドは静的配信のみで動作させる（`web/` を任意のHTTPサーバーに置くだけ）
- Rust サーバーは静的配信のオプション。独自APIは原則追加しない（例外は「API 方針」参照）
- AI連携はブラウザから外部API（Gemini等）を直接呼ぶ構成とする

## AI機能のティア分け（実行環境ごとの能力）

AI機能は「操作の影響範囲」でティアを分ける。**誰でも使える公開環境には、その人のセッション内に閉じる安全な機能だけを提供し、永続化・共有・システムへの影響がある機能はローカル環境に限定する**。

- `static`（静的配信のみ / Cloudflare Pages単体）
  - BYO APIキーでAIチャット・地図操作・`runCode`・`fetchData`(CORS前提)・IndexedDBプラグイン生成が使える
  - ブラウザストレージに閉じるため、訪問者がAIに機能を作らせても他人に影響しない
- `workers`（Cloudflare Pages/Workers 公開環境）
  - `static` に加え、Workers プロキシ経由のAI/fetch（キー隠蔽・レート制限付き）や KV/R2 の共有リソース**読み取り**を許可してよい
  - 共有リソースへの**書き込み**（共有 .kasc・プラグインカタログ等）は認証・承認フローの内側に置く
- `local`（ローカル Rust サーバー）
  - 開発・自己拡張の主戦場。`PLUGIN/` へのプラグイン書き込み・`plugins.json` 更新・ファイル保存・CORS無制限のfetchプロキシ・重い変換処理・QGIS/GDAL連携など高権限機能を許可する
  - 高権限操作（プラグイン公開等）はフロント側で必ず確認ダイアログを挟む

フロントエンドは `GET /api/capabilities`（応答例: `{tier:"local", features:[...]}`）でバックエンドの能力を取得し、ツール定義・UI を出し分ける。バックエンドが無い環境では静的安全機能のみで動作すること。

実装状況: 現在 `local` ティアの `/api/capabilities`・`/api/fetch`・`/api/plugins` のみ実装済み。`workers` ティアのプロキシ・共有書き込み、サーバーサイドエージェント、ローカルファイル連携（DATA/・QGIS等）は設計方針のみで未実装。

プラグインの昇格ルート: AI生成プラグインはまず IndexedDB（ブラウザローカル草稿）に保存 → `.kasp` でエクスポート可 → レビュー後にローカル版で `PLUGIN/` へ公開。これにより開発と公開、公開と非公開を分離する。

## API 方針

- フロントエンドは静的ファイル（`web/`）のみで動作する前提で実装する
- Rust サーバーは原則として静的ファイル配信のみとし、独自 API は追加しない
- ただし以下はこの制限から除く:
  - バージョンアップ関連の API (`/api/update/*`)、アプリ終了用の `/api/shutdown`、起動確認用の `/health`
  - **ローカル開発向けの高権限 API**: `/api/capabilities`（能力通知）、`/api/fetch`（CORSプロキシ）、`/api/plugins`（PLUGIN/ へのプラグイン書き込み・削除）。これらはローカルサーバー（127.0.0.1）前提の機能であり、公開環境（Pages/Workers）では無制限の書き込み・fetchを無認証で提供してはならない
- 地図タイル・検索等の外部 API へのアクセスは、ブラウザから直接呼ぶか、CORS 対応を前提とする

## データ形式方針

CesiumJS ネイティブ非対応の形式は、**「ブラウザ側でデコード → GeoJSON へ正規化 → 既存のベクター描画経路（`GeoJsonDataSource`）に流す」**を基本ルールとする。これによりレイヤ一覧・表示切替・フォーカス・ベクトル検索・属性パネルが新形式でも自動的に機能する。

### 経路の分類

- **ネイティブ経路**: `3dtiles:` / `geojson:` / `xyz:` など CesiumJS が直接読める形式
- **GeoJSON 正規化経路**: 非対応形式をデコーダーで GeoJSON 化して同じ DataSource 経路に乗せる。デコーダーは `web/app.js` の **`vectorDecoders` レジストリ**（type→`async (item) => GeoJSON` の Map）に登録する
  - 実装済み: `geoparquet:`（`loadGeoParquetAsGeoJson()`。hyparquet を CDN から遅延ロード、WKB/ネイティブ GEOMETRY 型の両方を GeoJSON ジオメトリに変換）
  - 実装済み: `duckdb:` / `sql:`（`loadDuckDbLayerAsGeoJson()` / `loadDuckDbQueryAsGeoJson()`。DuckDB-WASM を CDN から遅延ロードし、SQL で絞り込んでから GeoJSON 化。`duckdb:` はファイル+`where=`/`limit=`/`geom=`/`lon=`・`lat=`/`format=`/`columns=`（属性列プルーニング）/`covering=`（xmin,xmax,ymin,ymax 列名）/`bbox=auto`/`render=primitive`（entity を介さない `GeoJsonPrimitive` バッチ描画。大量地物向け・ベクター検索対象外）の宣言的指定。ジオメトリは WKB バイナリで受領し、`bbox=auto` 時は GeoParquet 1.1 `covering` bbox 列への範囲述語を優先して row group 統計スキップを効かせる。`sql:` は任意の SELECT 文（`:bbox` プレースホルダで表示範囲連動）。spatial 拡張があれば WKT・ST_Read・空間述語も利用可、無くても WKB/GeoJSON テキストと lon/lat ポイント化は動作する）
  - クエリ系形式（`query:true` フラグ）は再クエリ対応: レイヤー一覧の ⏷ ボタンで WHERE 式/クエリを対話的に変更（`editLayerQueryFilter` → `reloadVectorLayer` で DataSource 差替え・`.kasc` 行にも反映）、`bbox=auto`/`:bbox` は `camera.moveEnd` デバウンスで表示範囲 `ST_MakeEnvelope` を再クエリする（`refreshViewportLayers`）
  - `duckdb:`/`sql:` 経路で既に扱えるもの: CSV/TSV（lon/lat ポイント化）・Shapefile/GeoPackage 等（`format=read` の `ST_Read`）
  - 将来候補: FlatGeobuf・KML 等
- **タイル/大規模経路**: MVT・PMTiles・ラスタタイル等。全件描画や LOD が必要な大規模データ向けで、GeoJSON 正規化とは別経路を検討する

### 新形式を追加する手順

1. `applyInspector` のパースに行タイプを追加する
2. デコーダー関数を1本に閉じ込める（`loadXxxAsGeoJson(item)` の形。返り値は GeoJSON FeatureCollection）
3. `vectorDecoders` Map に `{ load: item => loadXxxAsGeoJson(item) }` を登録する（`refreshLayers` の geojson 分岐・`orderedOtherLayers` フィルタ・`updateInspectorFromLayerOrder` の種類一覧はレジストリ参照のため変更不要。条件変更・再クエリに対応する形式は `query: true` を付けるとフィルター UI の対象になる）
4. `home.html` のインスペクター設定仕様に書式を追記する

### 方針上の注意

- **デコーダーは軽量ライブラリ優先**（CDN の ESM を動的 import）。DuckDB-WASM のような重いエンジンは本体に置くが**遅延ロード必須**とし、使用時までコストを発生させない。プラグインではなく本体に置く理由: `.kasc` の行タイプはプロジェクトファイルの可搬性のため本体実装が必須であり、現プラグイン機構は `applyInspector` の行タイプを拡張できないため。プラグインからの decoder 登録（manifest での形式宣言＋遅延リフレッシュ）は将来の拡張ポイントとする
- **全件読み込みが前提**のため、デコードは数万〜10万地物規模を目安とする。それを超える大規模データはタイル経路（別形式への事前変換）か、`duckdb:`/`sql:` で事前に絞り込んで扱う
- **プロパティの型変換**はデコーダー側で行う（BigInt→Number/String 等。共通ヘルパー `sanitizeVectorPropertyValue` を使う）。GeoJSON 側に渡す properties は検索・一覧がそのまま動く形に整形する
