# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

## [Unreleased]

今後の変更をここに記録します。

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

[Unreleased]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yamamoto-ryuzo/kasugai_canvas/releases/tag/v0.1.0
