# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

## [Unreleased]

今後の変更をここに記録します。

## [0.4.2] - 2026-08-03

### Changed

- 3D TilesのLODとメモリ使用量を制限し、メモリ逼迫時に詳細度を自動調整することで描画負荷を軽減

## [0.4.1] - 2026-08-02

### Added

- GitHub Pages の最新バージョン情報を使った起動時の自動更新確認・確認付きインストール
- 設定パネルからの自動更新 ON/OFF と手動更新確認
- `kasugai_canvas.config` の初期サンプル設定を配布 ZIP と Windows インストーラーへ同梱

### Changed

- BASEMAPの標準表示をDEMテクスチャーとして維持しつつ、表示中の3D Tilesへドレープする専用設定を追加
- Axumサーバーが起動済みの状態でショートカットを起動した場合、既存サーバーを再利用してデフォルトブラウザを開くよう変更
- インストーラー起動時に既存のアプリケーションプロセスを停止し、ショートカット名を `kasugai_canvas` に統一

## [0.4.0] - 2026-08-02

### Fixed

- 高ズームでカメラが標高0m基準のDEMより下へ入り、地形が見えなくなる問題を修正し、DEM標高への追従を追加
- Z30付近でTerrainLayerのタイル・メッシュ負荷が過大になりブラウザが停止する問題を修正し、カメラ上限をZ25へ設定
- 「表示中の3D Tiles」をドレープ対象に選択するとTerrain表示まで解除される問題を修正
- GeoJSONのドレープを解除してもドレープ表示が残る問題を修正
- DEM選択と、DEM・3D Tilesを個別に選択するドレープ対象地形を追加
- DEM選択にRe:Earth Terrainを追加し、表示中にクレジットを表示
- Re:Earth Terrainの標高版とWGS84楕円体高版をDEM選択で区別
- Re:Earth配信のPLATEAU 3D Tilesに対応するWGS84楕円体高のTerrainを明記
- デフォルトDEMをRe:Earth TerrainのWGS84楕円体高版へ変更
- カメラのズーム範囲を-20〜25へ拡大し、DEMタイル取得は-20〜20に制限
- DEM・3D Tilesのドレープ対象とXYZ・GeoJSONへのドレープ適用を初期状態でONに変更
- Base mapをドレープ適用先から除外し、Terrain表示中は常にDEMのテクスチャとして表示するよう変更
- `@deck.gl/geo-layers`の読み込みでdeck.gl本体のグローバルAPIが上書きされ、`Tile3DLayer`が利用できなくなる問題を修正
- XYZタイルの`BitmapLayer`で画像が描画データとして解釈される問題を修正
- パネル上のクリック、ホイール、マウス・タッチ操作、ドラッグ操作が地図へ伝播する問題を修正
- 地物選択時にAttrタブへ自動で切り替わり、操作中のタブを失う問題を修正
- ベースマップ切替時にdeck.glのタイル・テクスチャキャッシュが以前の地図を保持する問題を修正

### Changed

- deck.gl、`@deck.gl/geo-layers`、`@deck.gl/extensions`を9.3.7へ更新
- PLATEAU千代田区LOD1の3D Tilesで`ScenegraphLayer: Error: size: 1`が再現しないことを確認
- 地形ソースとドレープを適用するレイヤーを分離して設定可能に変更
- Shadow設定をドレープ設定から分離し、Terrainと同じ行へ配置
- 地形ソースのUI表記を「ドレープ対象地形ソース」へ変更
- インスペクターに定義されないGeoJSON、3D Tiles、XYZレイヤーを設定適用時に削除
- ベースマップ定義と重複していた初期OpenStreetMap XYZレイヤーを削除
- 初期インスペクター、レイヤー、ベースマップ、カメラプリセット、Info、凡例を削除し、空の設定から開始するよう変更
- インスペクターの`/`または`\`区切りのレイヤー名をグループとしてレイヤーパネルへ表示
- インスペクター設定を実行ファイルと同じフォルダの`kasugai_canvas.config`へ保存・起動時復元する機能を追加
- ベースマップを含むXYZタイルにも`TerrainExtension`を適用し、選択したドレープ対象へ追従可能に変更
- ドレープを適用するレイヤーとしてXYZ、Base map、GeoJSONを個別に選択可能に変更
- Base mapへのドレープをデフォルトでOFFに変更
- ベースマップ選択欄に「ベースマップなし」を追加

## [0.3.0] - 2026-08-01

### Added

- レイヤーパネルでレイヤーをドラッグ＆ドロップして表示順を変更する機能
- GeoJSONをTerrainへドレープ表示する`TerrainExtension`を追加
- 3D Tilesを`terrain+draw`の地形ソースとして扱い、GeoJSONを3D Tiles表面へドレープ可能に変更
- Terrain sourceで国土地理院DEM、表示中の3D Tiles、なしを選択可能に変更
- TerrainLayerの地形ソース登録とdeck.glバンドルのグローバルAPI統合を修正し、GeoJSONドレープが機能しない問題を修正
- Terrain source切替時に古いドレープキャッシュが残る問題を修正
- Terrain sourceで国土地理院DEMと表示中の3D Tilesの両方を選択可能に変更
- Re:Earth設定のベースマップ一覧を追加
- 行政区域GeoJSONとPLATEAU千代田区LOD1 3D Tilesを追加
- 東京駅、富士山、大阪城のカメラプリセットを追加
- レイヤー管理、タイル追加、カメラ、設定、Info、凡例をタブ化
- Info HTMLと凡例画像のタブ内表示
- インスペクター形式の設定入力とレイヤー・ベースマップ・カメラ設定の登録
- `xyz:`タイル、ON/OFF指定、グループ排他、Yahoo AppID設定に対応
- Search、Share、Shadow、Attrタブを追加
- 設定タブへインスペクター入力を集約し、Tileタブを削除
- 3つのプラグインに最小化・展開ボタンを追加
- 3つのプラグインに名称を付与
  - **KASUGAI Layer & Tiles**：レイヤー・タイル・カメラ・設定管理
  - **KASUGAI Navigation Toolbar**：方位リセット・2D表示
  - **KASUGAI Basemap Selector**：ベースマップ切替

### Changed

- ベースマップ選択を左下の独立コントロールへ移動
- レイヤー管理UIとナビゲーションUIをコンパクト化・半透明化
- Layer & Tiles、Navigation、Basemapの最小化サイズを統一
- レイヤーパネルのタブ順と最小化時の余白を調整
- レイヤータブを複数段表示に変更
- 背景色を白に変更

## [0.2.0] - 2026-08-01

### Added

- URLパラメータによるdeck.glカメラ状態の保存・復元
- 緯度、経度、ズーム、傾き、方位の常時表示
- レイヤー一覧と表示切替
- ベースマップ選択とXYZタイルレイヤー追加
- Terrain表示の切替
- カメラプリセットとナビゲーションツールバー
- 方位リセットと2Dトップダウン表示

### Changed

- レイヤー管理パネルとナビゲーションツールバーを半透明UIに変更
- TerrainLayerの陰影を抑制し、ベースマップの視認性を改善

## [0.1.0] - 2026-08-01

### Added

- Rust/AxumによるローカルWebサーバー
- deck.gl TerrainLayerによる東京駅周辺の地形表示
- Three.jsオブジェクトとの共有WebGLコンテキスト描画
- 水平視点から地表下まで対応したカメラ操作
- ブラウザ全体を使用するフルスクリーン表示
- 開発起動、リリースビルド、ZIP作成用の`run.py`

### Changed

- 明るい配色のUIを採用
- 地形タイルの読み込み負荷を軽減

[Unreleased]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/releases/tag/v0.1.0
