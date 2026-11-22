# QGIS ↔ Canvas スクリーンショット比較 検証結果

実施: qgis-spec スキル「QGIS↔Canvas スクリーンショット比較」手順（`compare.mjs`）
対象プロジェクト: `ProjectFiles`（QGIS 4.0.1 実エクスポート、qmltest_* 34層・再エクスポート済）
範囲: `139.70,35.68,139.99,35.73`（EPSG:4326、QGIS setExtent 後の実キャンバス範囲
`139.70,35.6340,139.99,35.7759` を正として取得）
Canvas ビューポート: QGIS キャンバス実解像度 1514×913 / カメラ高度 35,592m
（実ピッチ -84° で4隅投影が画面内に収まるまで反復フィット）
背景条件: `NOBASE=1` でベースマップを隠し、QGIS と同じ白背景で比較
（gsimaps は iframe 内 tilePane を非表示化して同等条件にする）
対象エンジン: cesium / maplibre / openlayers / leaflet / navara / gsimaps（全6）

## 判定ルール

- **一致**: 形状・色・配置が目視で同じ（微差は許容）
- **許容近似**: 表現意図は再現されるが手法が異なる（近似であることを警告・文書化済）
- **未対応**: QGIS では描画されるのに Canvas で無描画/別物
- **回帰**: 以前動いていたものが壊れた

## Cesium 全34層ペア判定（2025-XX 再撮影・全層 `others=0` でクリーン）

| レイヤー | 判定 | 備考 |
|---|---|---|
| AnimatedMarker | 一致 | 静止フレームで形状・色一致 |
| ArrowLine | **未対応近似** | QGIS=弧状+矢羽根+太線、Canvas=細ジグザグのみ |
| CentroidFill | 一致 | 重心マーカー位置・色一致 |
| FilledLine | 一致 | |
| FilledMarker | 一致 | |
| GeomGen_fill | 一致 | 生成塗り矩形一致 |
| GeomGen_line | 一致 | imagery 経路でジグザグ形状一致 |
| GeomGen_line_xyz | — | QGIS プロジェクトに無し(xyz タイル経路) |
| GeomGen_marker | **未対応** | QGIS=緑三角×4、Canvas=無描画(ents=6 存在も非描画) |
| GradientFill | 一致 | imagery 経路で青グラデ矩形一致 |
| GradientFill_xyz | — | 同上 |
| InterpolatedLine | 許容近似 | 線形・色・太さ一致、補間段差がやや粗い |
| LinearReferencing | 一致候補 | ents=33255 描画、要詳細比較 |
| Lineburst | 一致 | |
| LinePatternFill | 一致 | |
| MarkerLine | 一致 | 紫線+頂点マーカー一致 |
| MaskMarker | **差異** | QGIS=無描画(マスク専用)、Canvas=赤点×5 で可視化してしまう |
| PointPatternFill | 一致 | imagery 経路で紫ドットパターン一致 |
| PointPatternFill_xyz | — | 同上 |
| RandomMarkerFill | 一致 | ランダム緑マーカー(seed 決定論) |
| RasterFill | 一致 | |
| RasterLine | 一致 | |
| RasterMarker | 一致 | |
| ren_25d | **未対応近似** | QGIS=グレー建物×4、Canvas=無描画(3D Tiles ドレープ併用で押出無効) |
| ren_embedded | 一致 | 両者無描画(QGIS 4.0.1: polygon+line 既定シンボル→無描画、実機確認済) |
| ren_graduated | 一致 | 段階サイズ・色一致 |
| ren_heatmap | **許容近似** | 6ブロブ全出・QML ramp/radius/max_value 適用済。カーネル形状は h337 近似 |
| ren_inverted | **未対応** | QGIS=緑マスク+白抜き×4、Canvas=無描画(反転マスク未実装) |
| ren_merged | 一致 | 両者無描画(merged+categorized 内側シンボルが非描画型) |
| ren_pointcluster | 一致 | centerSymbol バッジ(赤丸+件数)実装済・件数/配置一致 |
| ren_pointdisp | 一致 | Ring placement 実装済(QGIS C++ 式: r=max(d/2,n·d/2π)+add)。リング・中心・色一致 |
| ShapeburstFill | 一致候補 | 要詳細比較 |
| SVGFill | **未対応近似** | QGIS=SVG円タイル反復、Canvas=1枚ストレッチ(OL では一致) |
| VectorField | 一致 | 矢印ベクトル一致 |

## 今回実装した QML 準拠改善（web/cesium・shared）

1. **pointCluster centerSymbol**（`qml-style.js`+`app.js`）
   - `<symbol name="centerSymbol">` を cluster spec にパース保持
   - `style.badgeCanvas(count)`: `@cluster_size`/`@cluster_color` 変数を一時
     リゾルバで供給し centerSymbol を canvas 化（`markerLayersToCanvas`）
   - EntityCluster のバッジを QML シンボル化。無指定時は従来ピンへフォールバック
   - 検証: 赤丸「7」バッジが QGIS と一致

2. **pointDisplacement**（`app.js` `applyPointDisplacement`、新規）
   - QGIS C++ `QgsPointDisplacementRenderer::calculateSymbolAndLabelPositions` を移植:
     - Ring: `r = max(diag/2, n·diag/2π) + circleRadiusAddition`、第1点は下端(角度0)
     - ConcentricRings: 初環 `centerDiag/2+diag/2`、k環目 `+(k-1)·diag+k·add`、
       各環 `floor(2πr/diag)` 点
     - Grid: `gridSize=⌈√n⌉`+調整、間隔 `((centerDiag+diag)/2+diag)/2+add`、中央揃え
   - `circleColor`/`circleWidth`/`circleRadiusAddition` を spec パース追加し
     輪郭円・グリッド線をポリラインで描画（`drawCircle`/`drawGrid` 相当）
   - centerSymbol を重心に描画。グルーピングは tolerance をロード時カメラ縮尺の
     m/px で度換算（QGIS はズーム毎再計算→ここだけ固定値の近似、要ドキュメント）
   - 検証: 7点リング+赤中心+薄グレー円が QGIS と一致

3. **heatmapRenderer**（`app.js` `buildHeatmapDataSource`）
   - `style.heatmap` から `radiusPx`/`maxValue`/`weightFn`/`ramp` を適用
     （従来は固定 radius=24・固定 gradient）
   - 検証: 6ブロブ全て QGIS と同位置・同色調（残差: h337 カーネルと
     地理矩形画像のズームスケール差→QGIS はスクリーン固定カーネル）

4. **比較ハーネス**（`compare.mjs`）
   - QGIS 実キャンバス範囲を逆変換取得→実ピッチでの4隅投影フィットで
     カメラ高を反復決定（従来は pitch=-90 前提で外周フィーチャが画面外に漏れた）
   - `NOBASE=1`: solo 撮影時にベースマップ+タグ無し imagery を隠し白背景化
   - solo を `ds.show` ではなく `item.visible` 切替で実施（rebuild/reslice 耐性）
   - imagery 経路レイヤーを `_kasugaiLayerId` タグ付け+solo/diag 対象化
   - ターゲット判定を ds+primitive+imagery の全描画経路で行い
     `setLayerVisible` フォールバック誤爆（全 rebuild 誘発）を解消

## 他5エンジン ペア判定（NOBASE=1 白背景・fitBounds 補正後に全31層撮影）

### エンジン別・重点層マトリクス

同一 spec でもエンジンで再現度が異なるためエンジン別に記録。
未記載の標準層（FilledMarker/CentroidFill/MarkerLine/各 Fill 等）は全エンジンで
ジオメトリ・基本色が描画されることを確認（Cesium 判定表と同傾向）。

| レイヤー | MapLibre | OpenLayers | Leaflet | Navara | GSI Maps |
|---|---|---|---|---|---|
| ren_inverted | **一致**(緑マスク+穴) | **一致**(緑マスク+穴) | **一致**(緑マスク+穴) | 差異(淡矩形のみ・マスク無し) | 差異(淡緑矩形・マスク無し) |
| ren_25d | 未対応近似(輪郭のみ) | 未対応(無描画) | 近似(平坦青矩形) | 未対応(無描画) | 近似(平坦青矩形) |
| ren_embedded | 差異(赤縁を描画) | 差異(赤縁を描画) | 差異(塗り+赤縁) | 差異(微少描画) | 差異(塗り+赤縁) |
| ren_graduated | 一致 | 一致 | 一致 | 差異(微小1点のみ) | 一致 |
| ren_heatmap | 未対応(無描画) | 差異(既定ramp強すぎ・QML ramp未適用) | 一致(薄紫ブロブ6個) | 未対応(微小点) | 差異(青点として描画) |
| ren_pointcluster | 近似(青丸バッジ「7」+単点・centerSymbol非適用) | 差異(左上に巨大赤バッジ・位置不良) | 近似(青丸バッジ「7」+単点5) | 差異(微小点のみ) | 差異(クラスタ無し・単点6) |
| ren_pointdisp | 近似(クラスタ近似・青バッジ「6」) | 差異(単点のみ) | 近似(クラスタ近似・橙バッジ「6」) | 差異(微小点) | 差異(単点6・displacement無し) |
| GeomGen_marker | 近似(青点4・生成位置一致) | 未対応(無描画) | 差異(6点=元地物描画・位置不一致) | 未対応(無描画) | 差異(6点=元地物描画) |
| MaskMarker | 差異(赤点5を可視描画) | ほぼ一致(微小残存点のみ) | 差異(赤点6) | 差異(微小赤点) | 差異(赤点6) |
| SVGFill | **一致**(橙円タイル反復) | **一致**(橙円タイル反復) | 差異(縦縞パターン) | 未対応(無描画) | 差異(単色塗り) |
| ArrowLine | 未対応近似(直線のみ) | 未対応近似(直線のみ) | 未対応近似(直線のみ) | 未対応(無描画) | 未対応近似(直線のみ) |

### エンジン別まとめ

- **MapLibre**: 2Dエンジン中最も再現度高い。inverted/SVGFill 完全一致、
  cluster/displacement はクラスタ近似（centerSymbol 未適用・リング無し）
- **OpenLayers**: inverted/SVGFill 一致。pointcluster のバッジ位置・サイズが
  破綻（左上に巨大バッジ）、displacement は単点化、heatmap は OL 既定 ramp で
  QML ramp 未適用、GeomGen_marker/ren_25d 無描画
- **Leaflet**: inverted/heatmap/graduated 一致。GeomGen_marker は生成せず元地物を
  描画（6点）、SVGFill が縦縞、displacement はクラスタ近似
- **Navara**: 3D 地球エンジンのため2D QML 再現度が最も低い。点は微小化・大半が
  表示されず、線・パターン塗りは無描画。ren_inverted は淡矩形として部分的に
  表示されるのみ。`setCamera`+`distance` 指定でカメラ配置は正確（修正済）
- **GSI Maps**: sakuzu(作図)注入で全ジオメトリは描画されるが QML スタイルは
  simplestyle 近似に留まる。cluster/heatmap/displacement/inverted 未対応、
  GeomGen_marker は元地物描画、SVGFill 単色塗り

### 白率解析で追加検出した差異（全ペア機械走査＋目視確認）

全186ペアを非白率で機械走査し、面積差が大きい層を目視確認した結果:

- **PointPatternFill**: maplibre/openlayers/leaflet/gsimaps **無描画**（cesium のみ imagery 経路で一致）
- **GradientFill**: maplibre/openlayers/leaflet **無描画**（cesium は一致・gsimaps 単色塗り）
- **GeomGen_line**: 2D 全エンジン**無描画**（cesium のみ imagery 経路で描画）
- **CentroidFill**: leaflet/gsimaps は重心マーカーでなく**ポリゴン塗りを誤描画**
- **ren_merged**: leaflet/gsimaps **過剰描画**（QGIS は無描画＝merged+非描画系内側シンボル）
- **LinearReferencing**: `qgis-cesium` 側が全白（cesium は ents=33k を描画）。
  QGIS 側が実際に無描画かキャプチャ不良か**要再確認**（一致候補のまま未確定）
- 小地物層（VectorField/CentroidFill の maplibre・OL 等）は非白率が UI ベースライン
  以下で機械判定不可 → 個別目視が必要

### 未検証として残る項目

- **AnimatedMarker**: 静止フレームのみ比較。アニメーション時系列は未検証
- **ズーム依存挙動**: cluster/displacement のリグループ・LinRef/マーカー間隔の
  縮尺連動はロード時1縮尺のみ検証（既知近似として文書化済）
- **VectorField**: 2Dエンジンでの描画有無がベースライン以下で未確定
- **ren_25d 単独動作**: 本プロジェクトは 3D Tiles ドレープ併用。ドレープ無し
  プロジェクトでの 2.5D 押出挙動は未検証
- **CDN ホスト版**: kasugai-canvas-web への同期・ホスト側実表示は未実施
- QML warnings 出力確認（未対応項目が console warning されるかの監査）

### ハーネス側の修正（本サイクルで追加）

- 非cesium `fitBounds(w,s,e,n)` 4引数シグネチャに統一（gsimaps 公開 API を変更済）
- navara: `flyTo` のドリフトを `setCamera`+`distance` 即時配置に変更
- gsimaps NOBASE: GSI タイルは `setBasemap("none")` 対象外のため iframe 内
  `.leaflet-tile-pane` を style 注入で非表示化。iframe 再読込で document が
  差し替わると注入 style が detached になるため `ownerDocument===d` を毎回確認
  （pointcluster 以降でスタイルが外れていた問題を修正）
- gsimaps: ベクタは `G.SakuzuListItem` 経由で描画。`setVisible(false→true)` の
  地図復帰は正常動作を確認（probe-gsimaps3）

## 残課題（未対応・近似として明記）

| 項目 | 状態 |
|---|---|
| `ren_inverted` 反転マスク | **maplibre/openlayers/leaflet は一致**。Cesium 無描画・navara/gsimaps マスク無し |
| `ren_25d` | 3D Tiles ドレープ併用時は押出無効(既知)。2Dエンジンは平坦近似 |
| `GeomGen_marker` | maplibre のみ生成位置描画。leaflet/gsimaps は元地物を描画、他は無描画 |
| `MaskMarker` | Canvas が可視描画。QGIS はマスク専用で無描画 → **全エンジンで描画抑制が必要** |
| `ArrowLine` | 矢羽根・曲線化なし（既知近似）。navara は線自体が無描画 |
| `SVGFill` | maplibre/openlayers はタイル反復で一致。Cesium ストレッチ・leaflet 縦縞・gsimaps 単色 |
| `ren_embedded` | QGIS は polygon+line で無描画。Cesium のみ一致、他エンジンは縁/塗りを誤描画 |
| pointDisplacement ズーム連動 | グルーピング/リング半径がロード時固定(Cesium)。2Dエンジンはクラスタ近似 |
| pointCluster centerSymbol | Cesium のみ QML シンボルバッジ。2Dエンジンは既定色バッジ、gsimaps/OL は不良 |
| *_xyz 3層 | QGIS 側に対応レイヤが無いためペア対象外 |

## 方法上の確認事項（今回の実行で確立・追加）

- `#load-progress` は複数バッチで再表示される → 連続 hidden の確認が必須
- `camera.setView` は進行中の `flyTo` をキャンセルしない →
  `getCamera().height` が目標±2%で2連続安定するまで再適用するループが必要
- QGIS キャンバス実サイズ（`iface.mapCanvas().size()`）を Playwright viewport に適用
- `ds.show` 直接操作は `item.visible` 復元で巻き戻る → solo は `item.visible` 切替
- rebuild 発火源の特定手順: `kasugaiApi` 全メソッドと `imageryLayers.removeAll` を
  ラップして呼出元スタックを記録する計装が有効（本件で API フォールバック誤爆を特定）
- エンジン差: 他エンジンは `kasugaiApi.fitBounds`＋`setLayerVisible`/checkbox で代替
- **同一 spec でもエンジンで再現度が異なる**。ペア比較は原則全エンジンで行い、
  判定はエンジン別に記録する
