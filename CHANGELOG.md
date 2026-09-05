# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

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
