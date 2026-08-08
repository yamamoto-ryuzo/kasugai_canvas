# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

## [Unreleased]

## [0.8.3] - 2026-08-08

### Fixed

- DEM・3D Tiles 両方をドレープ対象にしたとき、XYZ が DEM 側に重ねられなくなる問題を修正
- ドレープを適用するレイヤーの ON/OFF が DEM ドレープにも反映されるように修正
- ドレープ対象が無効なときに GeoJSON が高さ 0 の平面として表示されるのを防ぐ
- GeoJSON を 3D Tiles 表面へドレープできるように対応

### Changed

- ドレープ対象地形のデフォルトを DEM ON / 3D Tiles OFF に変更
- ドレープを適用するレイヤーのデフォルトを XYZ ON / GeoJSON ON に変更

## [0.8.2] - 2026-08-08

### Fixed

- 2D ボタン（トップダウンビュー）で真上俯瞰を維持しつつ、現在の向きを保持するように修正

## [0.8.1] - 2026-08-08

### Changed

- 初期表示カメラの優先順位を整理（URL → カメラプリセット → IP 概算位置 → 皇居周辺）
- URL に位置情報がある場合、欠けた zoom / pitch / bearing はおおむねのデフォルト値で補完するように変更

## [0.8.0] - 2026-08-08

### Added

- Walk モードを Fly モードに刷新
- 左ダブルクリックで自動前進、右ダブルクリックで自動後退の ON/OFF を追加
- W / S キーのダブルタップでも自動前進・後退を切り替え可能に
- マウスホイールによる速度調整を追加（Fly モード中はホイールズームを無効化）
- Q / E キーによる高さ調整をマウス操作説明に追記
- 操作説明パネルをマウス / キーのタブ表示に分割し、+/− ボタンで最小化可能に

### Changed

- 3D と Fly の切り替え時に現在のカメラ高さを維持するように変更
- 速度の上限・下限を撤廃（マイナス速度で後退可能）
- Fly モード中は左クリックでの属性取得を無効化し、ダブルクリック操作を優先
- 地下への移動制限を撤廃し、地下でも自由に移動可能に

### Fixed

- 操作説明パネルの幅が高度・速度の数値変化で揺れる問題を修正

## [0.7.0] - 2026-08-06

### Added

- ナビゲーションパネルに Walk モードを追加
- Walk モードでのキーボード操作（W/A/S/D、矢印、Esc）を実装
- Walk モード時にキー操作説明をナビゲーションパネル左に表示

## [0.6.5] - 2026-08-06

### Changed

- 地下移動を標準で ON に設定

## [0.6.4] - 2026-08-06

### プロキシー

- 同一タイル重複取得防止（in-flight 共有）を実装
- 304 条件付きリクエスト（ETag / Last-Modified）に対応
- stale-while-revalidate キャッシュ戦略を導入

## [0.6.3] - 2026-08-06

### Changed

- 標準の 3D Tiles 描画設定を改善
- Cesium の効果設定を専用タブに分離

### Fixed

- クリアボタンの縦ずれを修正

## [0.6.2] - 2026-08-06

### Added

- 設定パネルの「その他」に「地下移動」切り替えを追加
- 地下表示と地下移動を独立した設定に分離
- 設定パネルの「その他」に「地表透過」スライダーを追加
- CONFIG の `background` 色を地球中心部（underground color）にも反映

### Changed

- 地下表示の ON/OFF スイッチを削除し、透過率スライダーに統合
- 地下表示中の星空（SkyBox）を非表示にし、背景色を統一
- 地表透過スライダーの値を不透明度から透過率に変更

### Fixed

- 地下表示時に地球中心部が CONFIG の背景色にならない問題を修正
- 地球中心部の色が距離によってブレンドされていた問題を修正

## [0.6.1] - 2026-08-06

### Changed

- カメラ移動に合わせてURLのクエリパラメーター（latitude / longitude / zoom / pitch / bearing / project）を自動更新し、パーマリンクとして利用可能に
- カメラ変更検出閾値を 0.3 から 0.05 に調整し、URL反映をスムーズに

## [0.6.0] - 2026-08-06

### プロキシー

- Rust/Axum サーバーにタイル/データのプロキシ＆キャッシュ機能を追加
- 外部 XYZ・標高タイル・3D Tiles をローカル `cache/` フォルダにキャッシュ
- ローカルファイル配信エンドポイント `/api/file` を追加

## [0.5.7] - 2026-08-05

### Fixed

- 自動更新時に最新版 ZIP が見つからず無限ループになる問題を修正

## [0.5.6] - 2026-08-05

### Fixed

- CONFIG の `background` 指定が Cesium 地形の背景色に反映されない問題を修正

## [0.5.5] - 2026-08-05

### Changed

- インストール時に `projects/default/kasugai_canvas.config` と `project.json` の既存ファイルを上書きしないよう変更
- バージョンを 0.5.5 に更新

## [0.5.4] - 2026-08-05

### Changed

- バージョンを 0.5.4 に更新

## [0.5.3] - 2026-08-05

### Changed

- バージョンを 0.5.3 に更新

## [0.5.2] - 2026-08-05

### Added

- 初期表示位置をプロジェクト設定の先頭 `cam:` を優先し、`cam:` がない場合は IP ジオロケーションを使用するよう変更
- IP ジオロケーション取得失敗時はデフォルトカメラ（東京駅）へフォールバック

## [0.5.1] - 2026-08-04

### Fixed

- コンパス針の回転をボタン全体に連携し、北方位を正しく表示
- 2D ボタンを真上俯瞰（pitch 90）に修正
- URL パラメータ（longitude / latitude / zoom / pitch / bearing / project）の読み込みと共有 URL への連携
- パネル最小化、GeoJSON アウトライン警告、Three.js オーバーレイ描画の不具合を修正

## [0.5.0] - 2026-08-04

### Added

- Terrarium DEM ソースの CesiumJS 移植
- XYZ / ベースマップの不透明度（opacity）設定
- Three.js オーバーレイ描画統合
- 地下表示切り替え機能

### Changed

- 描画エンジンを deck.gl から CesiumJS へ移行。3D Tiles・DEM 上への XYZ 重ね合わせの描画性能を向上
- 技術選定ドキュメント（docs/）を CesiumJS 中心の記述へ更新

## [0.4.9] - 2026-08-03

### Added

- 属性タブ内のURLをハイパーリンクとして表示

### Changed

- 属性JSONを見やすい形式で表示
- 属性タブのスクロール方式を統一

## [0.4.8] - 2026-08-03

### Added

- Yahoo AppID未設定時の検索先として国土地理院住所検索APIを追加
- Search見出しに使用中の検索サービス名を表示

### Changed

- 検索結果を選択したときの表示ズームをレベル19へ変更

## [0.4.7] - 2026-08-03

### Fixed

- SearchタブがブラウザのCORS制限で検索できない問題を修正
- Yahoo AppID未設定時にNominatimへフォールバックし、検索APIをサーバー経由に変更

## [0.4.6] - 2026-08-03

### Added

- Layersパネルでレイヤーグループの展開・折りたたみとグループ単位の表示切り替えに対応
- Exclusiveグループのレイヤーをラジオボタンで選択できるように変更

### Changed

- 通常グループとExclusiveグループを分けて表示し、親グループの選択状態を子レイヤーに反映するよう変更

## [0.4.5] - 2026-08-03

### Added

- インストール版とポータブル版で共通利用できるプロジェクトフォルダ構成を追加
- Layersパネルから複数プロジェクトを切り替える機能を追加
- 配布ZIPとインストーラーへ`projects/default`のサンプルプロジェクトを同梱

### Changed

- プロジェクトごとの設定を`projects/<project>/kasugai_canvas.config`へ保存するよう変更
- 既存のルート設定ファイルを初回起動時に`projects/default`へ移行するよう変更

## [0.4.4] - 2026-08-03

### Fixed

- XYZタイルの提供最大ズームを超えてリクエストし続け、BASEMAPの3D Tilesドレープが停止する問題を修正
- 一部のXYZサービスで404となるズーム上限を自動判定し、存在するタイルを継続表示するよう変更

## [0.4.3] - 2026-08-03

### Added

- 設定パネルからアプリを停止するボタンを追加
- 設定パネルに現在の接続ポート番号を表示

### Fixed

- ポート番号の表示欄がチェックボックスと同じサイズになる問題を修正

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

[Unreleased]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.6.5...HEAD
[0.6.5]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.5.7...v0.6.0
[0.5.3]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/releases/tag/v0.1.0
