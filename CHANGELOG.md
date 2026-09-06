# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

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
