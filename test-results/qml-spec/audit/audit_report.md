# QML キー監査レポート — qml-style.js × dump.json(QGIS 4.0.1 実機)

実施: 2026-xx / 対象: `web/shared/qml-style.js`（`qml-2d.js` は QML を読まず compiled spec 消費のみのため対象外）
スクリプト: `audit_keys.py`（結果 `audit_keys.json`）

## 抽出量

- 属性読取キー 198 / Option プロパティ読取 136 / DD 名 111

## 総評

**実名優先＋旧名フォールバックの規約にほぼ完全適合**。監査で検出した不明キーは
ほぼ全て「実名の後に置かれた旧名フォールバック」または別名前空間
（ペイントエフェクト・callout・colorramp・diagram・内部 spec）のもので、
実害のある誤名は2件のみ → 修正済み。

## 修正（本監査で実施）

1. **pointCluster/pointDisplacement の属性名が全て推測名だった**（L1143-1145）
   - 実機 `renderer.save()` で採取した実属性: `tolerance`/`toleranceUnit`
     （クラスタ距離）、`placement`（0=Ring,1=ConcentricRings,2=Grid、
     pointDisplacement のみ）、子要素 `<renderer-v2>`(内側)・`<symbol>`(中心シンボル)
   - `distance`/`distance_unit`/`point_displacement_renderer`/`renderer`/`centerSymbol`
     は実出力に存在しない → `tolerance`/`toleranceUnit`/`placement` を先頭に置き、
     旧名はフォールバックとして残置。`distancePx` は maplibre `clusterRadius`・
     openlayers `distance` に接続されるため実害あり。
2. **ペイントエフェクトが実 QML で読めていなかった**（`parsePaintEffects`）
   - 実機 `saveSymbol` 出力で確認: エフェクトは `<layer>` の **子要素
     `<effect type="dropShadow">`**（type は属性・各プロパティは内側 Option Map）。
     Option マップ内の `name="effects"` キーは存在しない。
   - 旧実装は `props.effects ?? props.paintEffect` のみを見ていたため実 QML の
     エフェクトは常に null で読み落とし → `<effect>` 子要素を辿るよう修正。
     Option マップ埋込形式は旧/手書きフォールバックとして残置。
   - エフェクトプロパティ名（`blur_level`/`offset_distance`/`offset_angle`/`opacity`
     /`blend_mode`/`enabled` 等）は実機出力と一致していた。

## 判明したが修正不要の項目

- **旧名フォールバック（実名が先頭・規約適合）**: DD の `color`/`outline_color`/
  `lineColor`/`lineWidth`/`trimDistance*`/`width_start` 等、属性の `priorityLabel`/
  `allowDegradedPlacement`/`fitInsidePolygon`/`multipartMode`/`multiLineWrapChar`/
  `bufferSizeUnit`/`maskSizeUnit`/`multilineAlignment`、props の `geometry_modifier`/
  `rotate_marker`/`fill_style`/`arrow_head_*`/`curved_arrow`/`anchor_x/y`/
  `color_border`/`font_family`/`path`/`file`/`svgfile`/`two_color_second`/
  `symbolType`/`repeat_distance`/`length`/`pattern_width`/`svgFillColor`/`start_color`
- **意図的な追加名（truth 外・無害）**: `overlapMode`(QGIS3互換)/`namedColor`/
  `fontBold`/`maskColor`/`tabStops`(警告のみ)/`transparency`(DD後方互換)
- **別名前空間**: ペイントエフェクト props・callout(`enabled`/`lineSymbol`)・
  colorramp(`color1/color2/stops`)・DiagramCategory 系・`blendMode`(実Option名・実在)
- **非実クラス名の case ラベル**: `MdiFontMarker`/`HashedLine`/`ColorRampFill`/
  `RuleBased`/`25d` — 手書き・改名ファイルの後方互換用、無害
- **`data-defined-properties`（ハイフン版）**: `<elevation>`/`<renderer-v2>` 直下
  のみに出現。パーサが DD を読む `<symbol>`/`<layer>` 配下は `data_defined_properties`
  （アンダースコア版）なので読み落としなし
- **`line_width()` 未対応関数警告**: ユーザー定義 @qgsfunction で実機 QGIS でも
  未登録（"Function line_width is not known" で式自体が失敗）。warnOnce+フォール
  バックは実機と同等の挙動で正しい

## 実機経路検証（必須手順に準拠）

- `GET http://127.0.0.1:8089/kasugai` → `C:\kasugai\kasugai_qgis\ProjectFiles\`
  に `.kasc`+`canvas_data/*.qml`+`*.fgb` 出力・登録（11レイヤ）
- `http://127.0.0.1:8510/<engine>/?project=ProjectFiles` を Playwright で実描画:
  - **cesium**: 縮尺ゲート後の近距離で QML ラベル（背景色付きテキスト・回転・
    アイコン）実描画を確認
  - **maplibre**: 市町村名等の QML ラベル実描画
  - **openlayers**: レイヤ・凡例展開（遠距離は縮尺ゲートで正しく非表示）
  - **leaflet**: 行政区域ポリゴン塗り・境界描画
  - **navara**: レイヤ・凡例解決（THREE 重複警告は既知・QML 無関係）
- QML 404/パースエラーなし。`compiled.warnings` は近似実装の既知警告のみ
  （HashLine 単色近似・bufferNoFill・obstacleType 等）。`ui.config.json` の
  404 は任意設定ファイル未作成による正常動作
- スクリーンショット: `test-results/qml-spec/live-shots/*-verify.png`,
  `cesium-feature.png`, `cesium-close.png`
