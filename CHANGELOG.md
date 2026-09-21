# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

## [4.9.0] - 2026-09-22

### Changed

- 属性値一覧の entity 経路は `GeoJsonDataSource` が MultiPolygon をパート毎に分割するため、同一 properties の entity を1行にまとめて地物単位で表示（例: 5行の国データが45行に見えていた問題を解消）
- ドキュメント：home.html の対応データ形式を「ネイティブ・タイル系」「ベクター:全件読み込み系」「ベクター:クエリ系(DuckDB SQL)」の3グループに再編。`duckdb:`/`sql:` の `format=` 対応形式一覧（parquet/csv・tsv/json・geojson/read）と「全件読み込み系 / クエリ系」の使い分け表を追加。AGENTS.md にも同分類を明記

## [4.8.0] - 2026-09-21

### Added

- DuckDB-WASM レイヤー：インスペクターの `.kasc` 設定で `duckdb: タイトル | URL | on/off | where= | limit= | geom= | lon=・lat= | format=` および `sql: タイトル | SELECT文` 行を新規追加。CDN 配信の DuckDB-WASM（遅延ロード・Worker 実行）で Parquet/CSV/JSON 等を SQL で絞り込んでから GeoJSON へ正規化し、既存のベクター描画経路に流す。ジオメトリ列は GEOMETRY 型→慣用名→BLOB 列の順に自動検出（`geom=` で明示可）、WKB/WKT/GeoJSON テキストを受理し、緯度経度列のみのデータは `lon=`/`lat=` でポイント化。spatial 拡張ロード時は空間述語・`ST_Read`（`format=read` で Shapefile/GeoPackage 等）も利用可能で、拡張ロード失敗時も WKB/GeoJSON テキストのパススルーで縮退動作する
- 対話的フィルター・表示範囲連動：レイヤー一覧の ⏷ ボタンで `duckdb:` は WHERE 条件式、`sql:` はクエリ全文を変更して即時再クエリ（変更は inspector の `.kasc` 行にも反映）。`duckdb:` の `bbox=auto`・`sql:` の `:bbox` プレースホルダ指定時はカメラ停止ごとに表示範囲を `ST_MakeEnvelope`/`ST_Intersects` で絞り込み再クエリし、巨大データを「見ている範囲だけ読む」運用が可能（spatial 拡張が必要）
- バッファ描画を既定化：`duckdb:`/`sql:` は既定で entity を介さず `GeoJsonPrimitive`（バッファプリミティブ）でバッチ描画し、大量地物で軽量に動作。`render=entity`（`sql:` は末尾 `| render=entity`）で従来の entity 描画に戻せる。クリック属性表示は両方式で利用可能
- 「検索は常に全件検索」方針の徹底：`duckdb:`/`sql:` は読み込み済み行のみを対象とするベクター検索パネルに登録せず、検索・絞り込みはファイル全件を対象に評価する SQL フィルター（⏷）に一本化。`bbox=auto`+`where=` 併用時は表示が「検索 ∩ 表示範囲」になる一方、`where=` のみの `COUNT(*)` を併走して「検索ヒット全 N 件 / 表示範囲内 M 件」をコンソールに出力。クリック属性は `scene.pick` の `picked.properties` から表示（バッファ描画は地形ドレープ非対応のため、ドレープが必要な場合は `render=entity` を指定）。属性値一覧ウィジェットのレイヤー選択にも `duckdb:`/`sql:` を追加し、一覧は DuckDB に直接クエリして LIMIT 無しの全件対象（bbox・`limit=` 非適用・位置は `ST_Centroid` または lon/lat 列）で取得。ウィジェット内の検索文字は全属性列への `ILIKE` 述語として SQL に変換され、常にファイル全件が検索対象になる（表への描画は先頭1000行まで）
- Parquet 最適化：クエリ結果のジオメトリを WKB バイナリで受け取りテキスト変換・`JSON.parse` を削減（転送量・ロード時間・ピークメモリを改善）。`columns=` で読み込む属性列を絞る列プルーニングに対応。`bbox=auto` 時は GeoParquet 1.1 `covering` bbox 列（慣用名 xmin/xmax/ymin/ymax または `covering=` 指定）への範囲述語を優先し、row group 統計スキップで表示範囲外を読み込まない
- ベクターデコーダーのレジストリ化：`vectorDecoders` Map（type→`{load, query}`）に集約し、`refreshLayers` ディスパッチ・`orderedOtherLayers` フィルタ・`updateInspectorFromLayerOrder` の種類一覧をレジストリ参照に統一。今後の形式追加は「パース + デコーダー1本 + Map 登録」で完結する
- サンプル：`web/projects/default` と `installer/projects/default` の `kasugai_canvas.kasc` に `duckdb:` サンプル（NaturalEarth・`bbox=auto` 表示範囲連動・`render=entity` 描画・`off` で任意ロード）を追加
- ドキュメント：home.html の対応形式一覧に DuckDB SQL カードを追加し、CSV/TSV・Shapefile/GeoPackage を `duckdb:`/`sql:` 経路の対応済みに更新。インスペクター設定仕様に `duckdb:`/`sql:` の書式・注意事項を追記

## [4.7.0] - 2026-09-21

### Added

- GeoParquetレイヤー：インスペクターの `.kasc` 設定で `geoparquet: タイトル | URL | on/off` 行を新規追加。CDN配信の hyparquet（遅延ロード）で Parquet をデコードし、WKB（ISO/EWKB・Z/M対応）および Parquet ネイティブ `GEOMETRY` 論理型のジオメトリを GeoJSON へ変換して既存のベクター描画経路に流す。レイヤ一覧・表示切替・フォーカス・ベクトル検索・属性パネルがそのまま利用可能。Range Request 対応の `asyncBufferFromUrl` を優先し、非対応環境は全件取得へフォールバック
- サンプル：`web/projects/default` と `installer/projects/default` の `kasugai_canvas.kasc` に GeoParquet 公式サンプル（NaturalEarth国ポリゴン）を `on` で追加
- ドキュメント：home.html のインスペクター設定仕様に `geoparquet:` を追記

## [4.6.0] - 2026-09-20

### Added

- AIプラグイン生成（自己拡張）：チャットからの指示で Gemini がプラグインコード（ESモジュール）を生成し、IndexedDB のストレージプラグインとして保存・即時有効化する `savePlugin` ツールを追加。適用前にコード全文を表示する確認ダイアログを挟み、読み込みエラーは `lastError` として保存・AIへ返却するため getPluginCode→修正→再保存の自律ループが可能
- ストレージプラグイン管理：Google → エージェント タブに管理画面を追加（一覧・有効/無効・コード確認・`.kasp` 出力/取込・削除）。`.kasp` は manifest+code を1ファイルにまとめたJSON形式で、公開せず特定ユーザーへの配布にも使える
- プラグインライフサイクル：plugin-loader.js が起動時に有効なストレージプラグインを Blob URL 経由で読み込み、更新・無効化時はプラグイン宣言レイヤーを除去して再 init する再読み込みを実装
- データ取得・加工・表示ツール：`fetchData`（外部URL取得・CORS前提・約400KB打切り）、`getLayerGeoJson`（読込済みレイヤーの entity→GeoJSON 逆変換）、`addDataLayer`/`removeDataLayer`（インラインGeoJSONの一時レイヤー。simplestyle 属性で色分け・ポップアップ制御可。.kasc エクスポート対象外で applyInspector 後も存続）
- `listPlugins` / `getPluginCode` / `removePlugin` / `setPluginEnabled` ツールを追加し、チャットの systemInstruction に自己拡張とデータ加工の手順を追記（全8言語）
- IndexedDB "kasugai-canvas" を v3 にバージョンアップし `plugins` ストアを追加
- セキュリティ：サンドボックス（runCode）からのプラグイン書き込み系 API をブロック対象に追加
- 能力ティア構造：AI機能を static（静的配信のみ）/ workers（Cloudflare公開）/ local（ローカルRust）の3ティアに分け、影響範囲がセッション内に閉じる機能のみ公開環境に提供する方針を `AGENTS.md` に明文化。フロントは `GET /api/capabilities` でバックエンド能力を検出しツール・UI を出し分ける
- ローカルサーバー API：`/api/capabilities`（tier/features 通知）、`/api/fetch`（CORS回避のGETプロキシ・30秒タイムアウト・20MB上限）、`POST /api/plugins`・`DELETE /api/plugins/{id}`（PLUGIN/ 書込み・plugins.json 更新。ID検証でパストラバーサル防止）
- `publishPlugin` ツールとエージェントパネルの「公開」ボタン：IndexedDB のストレージプラグインを配布用 `PLUGIN/` へ昇格（ローカル版のみ表示・確認ダイアログ必須）
- `fetchData` はローカル版で `/api/fetch` プロキシを優先利用し CORS 制約を回避
- Rust サーバー：環境変数 `PORT` 指定時は `0.0.0.0` にバインド（Cloud Run 等のコンテナ環境対応）、未設定時は従来通り `127.0.0.1`+`KASUGAI_CANVAS_PORT`（既定8510）

## [4.5.0] - 2026-09-20

### Changed

- ナビゲーションパネルの 2D/3D 切替を、カメラ真下ではなく画面中央に表示中の地点を基点にflyするよう変更。fly先計算はレイヤパネル側で使用している `flyToFeature` に一本化し、カメラから対象地点までの距離を高さに使うことで切替前後の見え方のスケールを維持する。画面中央が地球を捉えない場合はカメラ真下の地点を基点にフォールバック

## [4.4.0] - 2026-09-19

### Added

- `run-workers.py`：Cloudflare Workers（方式4・全ファイル認証ゲート）へのデプロイ自動化スクリプト。wrangler ログイン確認・KV/R2 バインドの wrangler.toml 自動記入・シークレット登録確認・`control=4` 設定・デプロイ・認証ゲートの簡易検証まで一括実行
- `run-pages.py`：Cloudflare Pages（方式3）へのデプロイ自動化スクリプト。プロジェクト解決（`--project-name` 指定／既存プロジェクト検出／新規作成）・`control=3` 設定・`wrangler pages deploy`・動作確認を一括実行
- Fly パネルに「ルート座標の基準」セレクトを追加。「カメラ位置」（従来どおりカメラがルート上を飛行）と「画面中心」（ルート点が画面中心に来るよう進行方向の後方・上空から追従）を切替可能。画面中心時の後方距離は `height / tan(|pitch|)` で自動計算（pitch は -85〜-1° にクランプ）
- `fly_geojson:` に `view=`（エイリアス `v=`）オプションを追加。`camera`（既定）/`center` でルートごとの基準を指定可能（`center` `chase` `follow` `3rd` `third` も `center` 扱い）

### Changed

- `workers/wrangler.toml` に KV 名前空間のバインドを実設定（`KASUGAI_KV`）
- `04-auth-4-cloudflare-workers.html` を大幅拡充：Pages との設定の違いの対照表・Pages からの移行手順・`wrangler secret put` の対話入力の説明・`wrangler deploy` に引数が不要な理由（wrangler.toml 宣言式設定）・段階的なデプロイ手順と再デプロイの目安を追加

### Fixed

- Workers 認証ゲートの公開許可リストに `i18n.js`・`i18n/` を追加。未ログイン時に i18n リソースが 401 となりログイン画面自体が描画されない問題を修正

## [4.3.0] - 2026-09-19

### Added

- レイヤー一覧の各行に📍フォーカスボタンを追加。クリックするとレイヤー全体が画面に収まるようカメラが移動する（Re:Earth GeoSuite の move-btn 相当）。非表示レイヤーは自動で表示してからフォーカスする。XYZタイルなど範囲情報を持たないレイヤーは全世界表示にフォールバック
- AIチャットのツール / `kasugaiApi` に `focusLayer` を追加。レイヤー名またはIDを指定してレイヤー全体にフォーカスできる

### Changed

- レイヤー一覧の行からデータ形式（type）表示を削除し、行末を📍ボタンのみに整理

## [4.2.0] - 2026-09-19

### Added

- プラグイン宣言レイヤー：`plugins.json` の `layer` 設定を宣言すると、本体がプラグイン専用レイヤーを自動登録し、レイヤ一覧・表示切替・属性検索（ベクター検索）・属性パネルの対象になる
  - `format: "entities"`：本体生成の `Cesium.CustomDataSource` を `api.getPluginDataSource(manifest.id)` で取得し `ds.entities.add(...)` で動的 entity を管理対象化
  - `format: "geojson"`：`api.setPluginLayerData(manifest.id, geojson)` で GeoJSON オブジェクトを `geojson:` レイヤーと同じ描画経路（クランプ・ドレープ含む）で表示・更新
  - `scope`：`"app"`（既定・プロジェクト切替をまたいで存続）/ `"project"`（切替時に削除）
  - `api.registerPluginLayer(config, pluginId)` / `api.removePluginLayer(idOrPluginId)` で任意のタイミングでの追加・削除も可能
  - `plugin-layer-registered` / `plugin-layer-removed` イベントを追加
- `sample-hello` プラグインを宣言レイヤー方式の実装例として更新

## [4.1.0] - 2026-09-19

### Added

- UI 多言語対応（i18n）：英語・日本語・中国語・韓国語・スペイン語・フランス語・ドイツ語・ポルトガル語の 8 言語。`web/i18n.js` + `web/i18n/*.json` 辞書方式で、設定 → その他の言語セレクタからリロード不要で切替。選択は `localStorage` に保存し、初回はブラウザ言語から自動判定（未対応時は英語）
- AIチャットのシステムプロンプトも辞書化し、Gemini の回答言語が UI 言語に追随
- 認証方式 4（cloudflare-workers）：静的ファイル含む全リクエストを Worker で認証ゲート（`workers/`・`run_worker_first`・HttpOnly Cookie セッション）
- R2 秘匿データ配信：`.kasc` で `r2://<キー>` と記述したデータを `/api/data/*` 認証ゲート経由で配信（`KASUGAI_DATA` バケットバインド）
- FLY パネルのルート選択横に「取込」（.geojson をファイル選択で IndexedDB へインポート・常時表示）と「出力」「削除」（描画ルート選択時のみ表示）ボタンを追加
- `fly_geojson:` の URL に `route:<ルート名>` スキームを追加し、IndexedDB の描画ルートをインスペクタから参照可能に

### Fixed

- FLY パネルの「保存」（点高書き戻し）が旧 `/api/file` 専用で動作していなかった問題を修正。保存先を IndexedDB・保存先フォルダ・`/api/data/*`（R2）に対応させた
- 飛行プリセット（徒歩/車載/ドローン/広域）適用時・Q/E・+/- キー・「補正」「速度」入力欄での高さ・速度変更が `flyPath` へ反映されず、ルート再開始で元の `h=`/`speed=` に戻る不整合を修正（ピッチと同様にルート設定へ書き戻すよう統一）

### Changed

- モード3・4（cloudflare 系）で `.kasc` は KV からのみ読み込み。KV に無いプロジェクトは静的ファイルも内蔵デフォルトも使わず空で起動
- 描画ルートの保存先を保存先フォルダ（File System Access API）から IndexedDB に変更。保存時のフォルダ選択ダイアログは不要になり、静的ホスティングでも保存可能。保存先フォルダ内の `.geojson` は読み取り専用で引き続き読み込み
- `ensureDrawnRouteFlyPath` は許可済みフォルダのみ静かに読み込み、未設定時にピッカーを出さないよう変更
- Pages デプロイ・KV バインド手順ドキュメントを実際のダッシュボード導線に修正（`04-auth-3-cloudflare-pages.html`）

## [4.0.2] - 2026-09-13

### Fixed

- `web/PLUGIN/auth-local/auth.js` が ID/PASS 認証を行わずに通過していた不具合を修正
- `web/auth-selector.js` の `control` 2/3 のマッピングを `auth-methods.json` の説明と一致させ修正

### Changed

- `web/PLUGIN/auth-local/auth.js` を `auth-login-form.js` を使った ID/PASS 平文照合に変更
- ローカル認証（local）のドキュメントを修正（`home.html`、`04-auth-1-local.html`）

## [4.0.1] - 2026-09-12

### Added

- home.html V4 セクションに認証方式 0〜3 のカードと、各方式の詳細ページを追加
- 認証方式の詳細ページを HTML 形式で作成（`04-auth-0-none.html` 〜 `04-auth-3-cloudflare.html`）

### Changed

- README.md の「拡張機能（Plugin）と認証」セクションを home.html へ集約し、概要とリンクに簡素化
- `web/auth-methods.json` のデフォルト `control` を `2` から `0` に変更

## [4.0.0] - 2026-09-11

### Added

- 基本システムを拡張可能な Plugin 機構を追加
- 起動前認証プラグイン（auth-selector）と起動後通常プラグイン（plugin-loader）を分離
- `window.kasugaiApi` に viewer / Cesium / イベント / プラグイン登録 API を追加
- 認証なし（none）とローカル認証（local）を同梱
- サンプル拡張機能（sample-hello）と認証プラグイン（auth-local）を追加
- 予定していた v4.0 到達条件を v5.0 に変更

## [3.4.15] - 2026-09-08

### Added

- BASEMAP パネルの 🌐 アイコンをクリックすると、現在の視点（位置・高度・方位・傾き）を Google Earth 形式に変換して `https://earth.google.com/web/` を新しいウィンドウで開く機能を追加

## [3.4.14] - 2026-09-07

### Changed

- 「テレイン非表示」を「ベースマップ透明」に刷新。globe の描画を消す代わりに、地表色と背景を透明にして XYZ タイルのドレープだけを地形起伏の上に残す。`contextOptions.webgl.alpha`、HDR 無効化、大気ハロー非表示、`orderIndependentTranslucency` 無効化を伴う

## [3.4.13] - 2026-09-07

### Added

- トップレベルに「Google」タブを追加（設定タブの右）。サブタブ構成: Gemini / Map
- Google → Map タブに Google Maps Platform の API キー入力欄を追加（localStorage 保存、`window.kasugaiApi.getGoogleMapsApiKey()` で参照可能）
- Photorealistic 3D Tiles 表示トグルを追加。ON で Google のフォトリアル3Dタイルをレイヤ一覧へ自動追加（inspector テキストには書き込まないため .kasc エクスポートに API キーは含まれない）
- BASEMAP セレクタに「テレイン非表示」を追加。地表（globe）の描画を消しつつ地形プロバイダ（高さ）は維持

### Changed

- Gemini 設定を 設定 → Google から Google → Gemini タブへ移動
- 設定内サブタブの切替をパネル単位にスコープ化し、設定・Google で独立して動作するように修正
- Photorealistic 3D Tiles トグル ON 時に未保存の入力キーを自動保存するように変更

## [3.4.12] - 2026-09-07

### Added

- ルート描画時の地上高（AGL）を入力可能にし、デフォルトを 0m に変更
- ルートの各点を `地形高 + 地上高` で設定

### Changed

- 描画終了後、描画中のラインを自動削除

### Fixed

- 点高さ保存時のデフォルト `heightOffset` を 20 から 0 に修正

## [3.4.11] - 2026-09-06

### Fixed

- 自動更新が EXE のみを差し替え、インストール先の `web/`（フロントエンド）が古いまま残る問題を修正。更新時に ZIP 内の `web/` でインストール先を置き換えるように変更
  - 注意: この修正は次回以降の自動更新から有効。今回はインストーラーでの上書きインストールが必要

## [3.4.10] - 2026-09-06

### Changed

- 配布物を再ビルドし、最新の `web/` フロントエンド（表示/非表示ボタン・DATAフォルダ読み込み等）が含まれることを確認

## [3.4.9] - 2026-09-06

### Added

- FLYルート選択の右（ヘッダー内）にルートラインの表示/非表示ボタンを追加
- DATAフォルダ内の `.geojson` ルートを FLY パス一覧へ自動読み込み（起動時・Editタブ表示時・インスペクター登録時・フォルダ選択時）

### Changed

- Draw ボタンのラベルを「ルート描画開始」に変更し、Edit タブへ統合
- ルートラインを GeoJSON 本来の高さ（標高 + ルート高度）で常時表示（FLY 中の進捗表示を廃止）
- ルートラインの幅を 8px に拡大して視認性を向上

### Removed

- Edit タブの「Open」ボタンと drawn route ファイル一覧表示（FLY ドロップダウンに一本化）

### Fixed

- 描画ルート保存時にインメモリキャッシュではなく DATA フォルダから読み込むように修正
- `getDataDirHandle` のスコープ問題によるルート読み込みエラーを修正
- ルートエンティティの `show` が未初期化で表示切り替えが効かない問題を修正

## [3.4.8] - 2026-09-06

### Added

- FLYパネルの Draw で作図したルートを、インスペクターの「保存先フォルダ」へ `drawn_route_YYYYMMDD_HHMMSS.geojson` として保存（File System Access API、Chromium系のみ）
- 保存したルートをFLYパス一覧へ自動登録し、その場で再生可能に
- 編集タブの「Open」ボタンで保存先フォルダを開いたファイルダイアログを表示
- 保存結果・エラーを画面右下のトースト通知で表示（インスペクターを閉じていても確認可能）

### Changed

- Flyパネルの Draw タブ名を「Edit」に変更（ボタン名との重複を解消）
- 保存先フォルダ未設定時はダミーパス表示をやめ「未設定」と表示

## [3.4.7] - 2026-09-06

### Fixed

- WebView2 環境で Gemini API キー入力欄が入力欄が極端に狭くなる問題を対策（size 属性と min-width !important）

## [3.4.6] - 2026-09-06

### Fixed

- WebView2 環境で Gemini API キー入力欄が最小幅に縮まる問題を修正

## [3.4.5] - 2026-09-06

### Fixed

- インストーラー/ショートカットからのブラウザ起動が `cmd /C start` では信頼性が低いため、`opener` クレートの `ShellExecuteW` 経由に変更

## [3.4.4] - 2026-09-06

### Fixed

- `Orbit` / `Fly` 切り替えボタンクリック時に `drawTabActive` がリセットされず、`Orbit` モードでも Fly パネルが残る問題を修正

## [3.4.3] - 2026-09-06

### Docs

- `home.html` に API 構成の簡潔な説明を追加

## [3.4.2] - 2026-09-06

### Removed

- バージョン管理 API (`/api/update/*`、`/api/shutdown`、`/health`) 以外の Rust サーバー API 呼び出しを `web/app.js` から削除
  - `/api/projects` 系、 `/api/tile` 系、 `/api/info` 系
  - `/api/search` 代替として地理院住所検索をブラウザから直接呼び出し
  - 描画ルートの `/api/files`・`/api/file` 系取得・保存

## [3.4.1] - 2026-09-06

### Fixed

- CesiumJS タイル/3D Tiles/情報パネルが `/api/tile` や `/api/info` 等の存在しない API 経由で取得されて地図が表示されない問題を修正
- プロジェクト一覧も静的 `projects/projects.json` から直接読み込むように変更

## [3.4.0] - 2026-09-06

### Added

- Rust サーバーに自動更新機能を復元
  - `GET /api/update/settings` / `PUT /api/update/settings` による自動更新設定
  - `GET /api/update/latest` による最新版情報取得
  - `POST /api/update/install` による ZIP ダウンロード・EXE 差し替え・自動再起動
  - `POST /api/shutdown` によるサーバー停止
- `GET /health` に `name`・`port` を含め、フロントエンドの `backendEnabled` 判定に対応

## [3.3.0] - 2026-09-06

### Fixed

- APIキー未設定時のチャット応答に、設定手順・取得URL・使えるコマンドを含めるよう改善
- チャットパネルの初回チュートリアルメッセージを省略（API未設定時の不要な表示を減らす）

## [3.2.0] - 2026-09-06

### Added

- AIチャットパネルを右下に新設。Gemini API（function calling）で地図操作が可能（flyTo・レイヤ/ベースマップ切替・検索・プリセット・地形/効果・地下・断面・Flyパス・プロジェクト切替等）
- AI操作API `window.kasugaiApi` を公開。地図移動はドローン視点（対象地上+200m・-30°）を既定適用
- ブラウザ内コード実行サンドボックス（`runCode` ツール、opaque origin iframe + postMessage ブリッジ）
- 設定タブに「Google」を追加（Gemini APIキー・モデル選択、localStorage保存）
- チャット履歴をプロジェクト単位で localStorage に永続化（クリアボタン付き）
- APIキー未設定時のローカルコマンド（/fly /layers /layer /basemaps /basemap /search /camera）
- Inspector にローカルファイル追加機能（File System Access API で DATA/ へ直接保存→設定追記→登録、保存先フォルダ選択可）
- `addGeoJsonLayer` によるAIからのレイヤ追加
- ドキュメントを home.html に集約（インスペクター完全仕様・AI/セキュリティ・使い方）、README は最小化

## [3.1.0] - 2026-09-06

### Added

- 地形(DEM)ソース選択を追加: Re:Earth Terrain(楕円体高 / 標高)と国土地理院 DEM(5m+10m メッシュ、1m メッシュ)を選択可能に
- 地理院 5m+10m メッシュ: ズームレベルに応じて z14 以下は DEM10B(10m)、z15 以上は DEM5系(5m)を自動選択

### Changed

- 地理院標高タイル用の独自 TerrainProvider を実装(Geographic タイルをメルカトル XYZ 標高 PNG から生成)
- 高さ基準の表記を「TP基準(東京湾平均海面)」に変更し、WGS84 楕円体高との差(約30〜40m)をヘルプに明記
- GSI ベースマップ・空中写真に `maxZoom` を設定し、未提供ズームへの不要なリクエストを抑制

### Fixed

- Re:Earth terrain の `msl` エンドポイント 404 を `elevation` へ修正
- カスタム TerrainProvider の `getTileDataAvailable` 未実装による Cesium クラッシュを修正
- GSI DEM の負のタイル番号(y=-1)リクエストを修正
- GSI DEM の多段フォールバックを廃止し、要求ズームのみの並列取得+キャッシュで大幅に高速化

## [3.0.0] - 2026-09-06

### Added

- ヘルプサイトにデモサイト（`/web/`）へのリンクを追加

### Changed

- Rust サーバーを静的ファイル配信のみの最小構成に再構築し、これまでのファイル保存 API 等を廃止
- ヘルプドキュメントを `docs/` からリポジトリルートへ移動し、GitHub Pages 用 `.nojekyll` を追加
- README・インストーラー・サンプルプロジェクトを新しい静的構成に合わせて更新

## [2.0.5] - 2026-09-03

### Added

- GeoJSON 高速ドレープ (実験的): CesiumJS 1.145 の `GeoJsonPrimitive` を使い、GeoJSON を高品質・高速に地形や 3D Tiles にドレープする設定を追加
- 高速ドレープ有効時の地物クリックによる属性表示に対応

### Changed

- CesiumJS を 1.144 から 1.145 に更新(dompurify 脆弱性 CVE-2026-49458 の修正を含む)
- フロントエンドを純粋な CesiumJS 化し、`web/` を任意の HTTP サーバーに置くだけで動作するよう変更
- 設定をプロジェクト単位 (`projects/<project_id>/kasugai_canvas.kasc`) に移行し、ルートの `kasugai_canvas.kasc` を廃止
- Rust サーバーを `web/` および `projects/` を配信する最小静的サーバーに変更
- 設定ファイル内の相対パスを `projects/<project_id>/` から解決するよう変更
- インスペクターを Layer タブから独立した Inspector タブに移動
- Help リンクを設定パネル内の Help タブに集約
- OpenStreetMap の `tileSize=512` を削除

### Fixed

- 属性一覧で座標を持たない行をクリックした際に緯度経度 (0, 0) へ飛んでしまう不具合を修正

## [2.0.4] - 2026-08-31

### Added

- インスペクター設定を `.kasc` ファイルとしてエクスポート
- `.kasc` ファイルを Windows の関連ファイルとして開けるようレジストリ登録

### Changed

- プロジェクト・ルート設定ファイルを `kasugai_canvas.config` から `kasugai_canvas.kasc` に統一
- 古い `.config` ファイルは `.kasc` 優先で読み込むようフォールバック対応

## [2.0.3] - 2026-08-30

### Added

- レイヤーパネル設定タブの「レイヤ」と「その他」に HELP リンクを追加

## [2.0.2] - 2026-08-30

### Fixed

- 更新用 PowerShell スクリプトで EXE 差し替え失敗時に無限ループしないように `try/catch` を追加
- 更新 ZIP のダウンロード URL にバージョンクエリを付与し、GitHub raw コンテンツのキャッシュによる不整合を回避
- `latest.json` 取得時にタイムスタンプクエリを付与
- 更新 ZIP URL のホワイトリストをホスト・パスで判定し、クエリパラメータを許可

## [2.0.1] - 2026-08-30

### Fixed

- 自動更新時に `autoUpdate` 有効でも確認ダイアログが表示されていた問題を修正
- 多重起動時に既存インスタンスを停止してポートを確保する処理を実装
- `run.py` のリリースビルドで EXE / ZIP のバージョンを検証するよう強化

## [2.0.0] - 2026-08-30

### Changed

- 技術選定ドキュメントを整理し、home.html との体裁を統一
- CHANGELOG を主要なバージョンのみに整理
- バージョン表記を 2.0.0 に更新

## [1.3.0] - 2026-08-30

### Added

- Fly パネルにプリセット選択、ピッチ入力、起終点逆転ボタンを追加
- Fly パネルのヘルプテキストをコンパクト化

### Changed

- 実装システムのドキュメントを更新

## [1.2.0] - 2026-08-29

### Added

- 描画ルートの番号付き保存
  - `drawn_route_1.geojson`、`drawn_route_2.geojson` ... として自動連番でキャッシュ
  - 既存ファイルは上書きせず、新規ファイルとして追加
  - プロジェクト内の描画ルート一覧を取得する `GET /api/files`
- ルート飛行時の旋回補正
  - 折れ点手前で次の線分方向へ滑らかに方位を補間
  - 最後の 100m（または線分の 30% 以内）で旋回を開始

### Changed

- `fly_geojson:` ルートは折れ点どおりのオリジナル頂点を使用
- 手動 / 自動ルートで速度・高さを共有

## [1.1.0] - 2026-08-24

### Added

- Fly モードの経路追従機能
- 描画ルート機能
- 速度・高さの一元制御
- ローカルファイルの PUT 保存 API (`PUT /api/file`)

## [1.0.0] - 2026-08-08

### Added

- CesiumJS への描画エンジン移行。3D 地球・DEM・3D Tiles・XYZ の統合表示
- Rust/Axum によるローカルサーバーとタイルプロキシ・キャッシュ機能
- Layers パネル、ナビゲーションパネル、URL パーマリンク、カメラプリセット
- 検索タブ、属性パネル、プロジェクト切替、Windows インストーラー

### Changed

- 描画エンジンを deck.gl から CesiumJS へ全面移行
- ドレープ対象を DEM / 3D Tiles から個別に選択可能に
