# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

## [Unreleased]

### Changed

- ナビゲーションパネルのカメラ操作モード切り替えを Orbit/Fly 表記に整理
- 真上ボタンを 2D/3D 切り替えに変更
- 2D 切り替え時、カメラの視線と地上/terrain の交点を 2D 表示の中心に設定

## [1.0.2] - 2026-08-09

### Changed

- CesiumJS を 1.143.0 から 1.144.0 に更新

### Fixed

- 断面クリップ後の残影不具合、フレームバッファの 1 フレーム黒フラッシュ等、CesiumJS 1.144 の修正を反映

## [1.0.1] - 2026-08-08

### Changed

- Windows NSIS インストーラーを管理者権限不要（ユーザー権限実行）に変更
- インストール情報を HKCU レジストリに記録し、アンインストールもユーザー単位で動作

## [1.0.0] - 2026-08-08

### Added

- CesiumJS への描画エンジン移行。3D 地球・DEM・3D Tiles・XYZ の統合表示
- Rust/Axum によるローカルサーバーとタイルプロキシ・キャッシュ機能
- Layers パネル（XYZ / 3D Tiles / GeoJSON / グループ / 排他選択 / ドラッグ＆ドロップ並び替え）
- ナビゲーションパネル（Fly モード、2D トップダウン、コンパス）
- URL パーマリンクとカメラプリセット、IP ジオロケーションによる初期位置
- 設定パネル（DEM/3D Tiles ドレープ、地下移動、地表透過、背景色）
- 検索タブ（Yahoo 住所検索 / 国土地理院住所検索 / Nominatim フォールバック）
- 属性パネル（ハイパーリンク、JSON 表示）
- プロジェクト切り替えと `projects/default` サンプル
- Windows インストーラー（NSIS）と配布 ZIP / 自動更新メタデータ

### Changed

- 描画エンジンを deck.gl から CesiumJS へ全面移行
- Fly モードで地下移動を可能にし、速度・高さ調整を追加
- レイヤー表示順を登録順に反映するように整理
- ドレープ対象を DEM / 3D Tiles から個別に選択可能に

### Fixed

- レイヤー一覧のドラッグ＆ドロップ干渉
- DEM/3D Tiles ドレープ時の XYZ / GeoJSON 表示不具合
- コンパス針、2D ボタン、パネル最小化等の UI 不具合
- 自動更新時の無限ループ
- 検索タブの CORS 制限
