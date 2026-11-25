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
| AnimatedMarker | 許容近似 | 画像が一時パスで読めず円フォールバック(青)。位置・形状一致(アンカー修正後) |
| ArrowLine | **未対応近似** | QGIS=弧状+矢羽根+太線、Canvas=細ジグザグのみ |
| CentroidFill | 一致 | 重心マーカー位置・色一致 |
| FilledLine | 一致 | |
| FilledMarker | 一致 | 橙菱形×6 位置一致(anchor_point enum 修正で正規化) |
| GeomGen_fill | 一致 | 生成塗り矩形一致 |
| GeomGen_line | 一致 | `reverse($geometry)` 対応後、ジグザグ位置一致(線幅はやや太め近似) |
| GeomGen_line_xyz | — | QGIS プロジェクトに無し(xyz タイル経路) |
| GeomGen_marker | 一致 | 緑三角×6 位置一致(anchor 修正で正規化) |
| GradientFill | 一致 | imagery 経路で青グラデ矩形一致 |
| GradientFill_xyz | — | 同上 |
| InterpolatedLine | 許容近似 | 線形・色・太さ一致、補間段差がやや粗い |
| LinearReferencing | **一致** | ソース単位 interval 修正済。「0.02…0.12」ラベル分散配置が QGIS と一致 |
| Lineburst | 許容近似 | w1/w2 未設定(NaN幅)を修正し青→黄グラデ線描画。QGIS は 1.2mm 細線で2色が混色しグレーに見える |
| LinePatternFill | 一致 | |
| MarkerLine | 一致 | 紫線+頂点マーカー一致 |
| MaskMarker | 一致 | 両者無描画(マスク専用シンボルのため可視出力無しが正しい) |
| PointPatternFill | 一致 | imagery 経路で紫ドットパターン一致 |
| PointPatternFill_xyz | — | 同上 |
| RandomMarkerFill | 一致 | ランダム緑マーカー(seed 決定論) |
| RasterFill | 一致 | |
| RasterLine | 一致 | |
| RasterMarker | 許容近似 | 画像読めず円フォールバック(QGIS 側も「?」グリフ)。位置一致 |
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

## 追加修正(2回目検証ラウンド: anchor/reverse/Lineburst 幅)

1. **マーカーアンカー点の enum 解釈バグ**(`shared/qml-style.js` `markerOffsetPx`)
   - `horizontal_anchor_point`/`vertical_anchor_point` は QML で enum 整数
     (0=Left/Top, 1=Center, 2=Right/Bottom)だが、0..1 小数として解釈され
     `"1"`(中央)に `(1-0.5)*sizePx` の誤オフセットが付いていた
   - 結果、**全マーカーが右下へ sizePx/2 ずれ**、canvas 上では菱形・円の
     右下1/4のみ描画(扇形に見えた)。整数 0..2 → frac=n/2 で正規化し、
     `(0.5-frac)*sizePx` でオフセット適用に修正(符号もコメントと整合)
   - 影響: FilledMarker/AnimatedMarker/GeomGen_marker 等、全マーカー層の
     位置ずれと部分欠落が解消。2D エンジンも共通コードのため同様に改善

2. **`reverse($geometry)` 未対応**(同上 `evalGeomExpr`、GeomGen_line が無描画)
   - `reverse` case 追加(リング/パート毎に座標順反転)。本体線を隠す
     GeometryGenerator で生成ジオメトリが null になり全面空白だったのを修正

3. **Lineburst NaN 幅**(同上 `buildLineDecor`、全エンジン無描画)
   - `{kind:"interpolated"}` に w1/w2 が無くポリライン幅 NaN→不可視。
     `line_width` から w1=w2 を計算して返すように修正
   - 防御: `renderInterpolatedLine`(cesium)と `interpolatedToOlStyles`(OL)で
     w1 非有限時に 1 へフォールバック

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
- **LinearReferencing**: **修正・検証済み**。`interval` は**ソース座標系の
  map units**（`visitPointsByRegularDistance` が未変換座標で計測）で、
  EPSG:4326 では度。旧実装はメートル換算で interval=0.02 を 0.02m と
  解釈しており、ラベル値（「2,900」「599」等のメートル値）・配置ともに
  QGIS と相違していた。**`decor.interval` をソース単位でサンプルするよう
  全経路を修正**（`linRefSamplesGeojson` は度空間でサンプル→オフセットのみ
  メルカトル m 空間で適用、OL は 3857→4326 逆変換してサンプル、Cesium は
  cartographic 度空間の `linRefSamples3D` を新設）。検証画像:
  `canvas-{cesium,maplibre,openlayers,leaflet,navara}-qmltest_LinearReferencing.png`
  — 5エンジンとも QGIS と同じ「0.02,0.04,…,0.12」の度単位ラベルを線に沿って
  分散配置（navara はマーカー無し・ラベルのみ）。**gsimaps は linref 未実装で
  基線のみ描画**（QGIS は基線を描かないため差異として残る）
- 小地物層（VectorField/CentroidFill の maplibre・OL 等）は非白率が UI ベースライン
  以下で機械判定不可 → 個別目視が必要

### 未検証として残る項目

- **AnimatedMarker**: **宣言済み未対応**（qml-style.js が「先頭フレームのみ
  静止表示です(アニメーション未対応)」を warning 出力）。時系列比較の
  実施価値は実装追加後
- **ズーム依存挙動**: cesium pointdisp を全範囲/4倍ズームで撮影済み
  （`canvas-cesium-qmltest_ren_pointdisp_zoom{1,4}.png`）。グルーピング/
  リング半径はロード時縮尺で固定の既知近似を実測で確認（ズーム後も
  リング構成は変わらない）。QGIS は縮尺毎にリグループするため差異は
  既知近似として継続
- **VectorField**: 2Dエンジンでの描画有無がベースライン以下で未確定
- **ren_25d 単独動作**: 本プロジェクトは 3D Tiles ドレープ併用。ドレープ無し
  プロジェクトでの 2.5D 押出挙動は未検証
- **ren_25d QGIS 側スクリーンショット**: 高さ/角度はレンダラ属性でなく
  **レイヤ変数** `qgis_25d_height`/`qgis_25d_angle` に保持される
  （`Qgs25DRenderer::save` はシンボルのみ出力）。変数未設定では
  `extrude()`/`translate()` が NULL を返し床の SimpleFill のみ描画
  = 以前観測した「グレーボックス×4」の正体。`saveNamedStyle` は変数を
  `<customproperties>` の `variableNames`/`variableValues` として出力するため
  **Canvas 側も消費可能**。変数を設定して描画トリガーしたところ
  **QGIS セッションが3連続で死亡**（15212=GUIスレッドdeadlock後kill、
  15996/13656=25dレンダー直後にプロセス消失）→ **QGIS 4.0.1 の 2.5D
  レンダー自体が不安定**と疑われ、実表示ペアの取得は次セッションで再試行
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
- leaflet NOBASE: `.leaflet-tile-pane` 隠しでは効かない（ベースマップは
  deck ドレープキャンバスに描画される）。`setBasemap("none")` +
  `#drape-tiles3d-basemap` チェック OFF の併用で白背景化
- **pyeval 内で `mapCanvas().grab()`/`waitWhileRendering()` を呼ばない**
  （pyeval は GUI スレッドで実行され、レンダリング完了待ちが自分自身を
  ブロックしてデッドロック=セッション破壊）。撮影はドライバの
  `screenshot` コマンド経路を使う
- ドライバ選別: 複数 live dir がある場合 `status` 応答+レイヤ数スコアで
  目的プロジェクトのセッションを選択（死 dir・無関係プロジェクトを回避）
- **Canvas ポート区別**: `8510` はインストール版 `C:\kasugai\kasugai_canvas`
  のスナップショット配信（同期しないとコード変更が反映されない）、
  `8520` は dev 版 `server/target/debug` で `C:\devin\kasugai_canvas\web`
  をライブ配信。開発中コードの検証は 8520 を使い、確定後に
  `C:\kasugai` 側へファイル同期する（Canvas 専用撮影は
  `_canvas_only.mjs` で `CANVAS_PORT`/`NOBASE`/`kasc:` プロジェクト指定可）
- 旧 interval メートル解釈時、Cesium は `samplePolylinePositions` の無上限
  ループで 1m 間隔×全線分の標点を生成しページが永久ブロック→クラッシュ
  していた。`linRefSamples3D` は max=500 上限付きで解消

## 残課題（未対応・近似として明記）

| 項目 | 状態 |
|---|---|
| `ren_inverted` 反転マスク | **maplibre/openlayers/leaflet は一致**。Cesium 無描画・navara/gsimaps マスク無し |
| `ren_25d` | 3D Tiles ドレープ併用時は押出無効(既知)。2Dエンジンは平坦近似。`variableNames`/`variableValues` で高さ/角度を QML から取得可能 → extrude/translate の実装余地あり |
| `LinearReferencing` | **修正済み**: interval をソース座標単位(4326=度)でサンプル。cesium/maplibre/OL/leaflet/navara は QGIS と一致。gsimaps は linref 未実装で基線のみ描画(残課題) |
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

## SimpleLine プロパティ単位検証（2026-11-23・qgis_export プロジェクト）

- 対象: `qmltest_SimpleLine`（全27プロパティ非既定）＋ `qmltest_SimpleLineDD`
  （DD `outlineColor`/`outlineWidth` をフィールド `val` 式で設定）
- 経路: 実機 QGIS 4.0.1（PID 5052・geo_webview :8090）→ `GET /kasugai` →
  `C:\kasugai\kasugai_canvas\QGIS_projects\qgis_export`（13層・実エクスポート）
- 結果: **cesium / maplibre / openlayers / leaflet / navara 全5エンジン一致**
  - 破線（customdash 6;3;1.5;3 + use_custom_dash）・赤色・round cap/join・
    offset・trim・dash_pattern_offset が QGIS と同じ見た目で再現
  - DD: 青→赤の地物別グラデーション色＋太さ変化が QGIS と一致（全エンジン）
  - `qmlStyle.warnings` は2層とも全エンジンで空（未知プロパティ警告なし）
- 今回の修正: `EXPR_FUNCS` に `color_rgb`/`color_rgba` を追加
  （DD 色式の評価不能でベース色にフォールバックしていた問題を解消）
- 注意: DD 式の `$id` は geojson エクスポートに fid が載らないため null になる。
  検証用 DD 式はフィールド参照で書くこと（今回 `val` フィールドを追加して対処）
- 画像: `qgis-*-qmltest_SimpleLine[DD].png` / `canvas-*-qmltest_SimpleLine[DD].png`
  （NOBASE=1・QGIS 実解像度 1514×913・範囲 139.68,35.68,140.00,35.90）

## LIVE 検証: 実稼働 QGIS ↔ live Canvas 全エンジン（2026-XX-XX・ProjectFile.qgs）

- 経路: 起動中 QGIS 4.2.3（PID 7652・geo_webview :8089）→ `GET /live/kasc` →
  dev Canvas :8520 `?kasc=<live URL>`。**ファイルエクスポートを介さない完全 live 経路**
- フィクスチャ: `web/projects/_qml_verify/` の geojson+qml ペア 31層を
  `__qmltest_verify` グループとして起動中プロジェクトへ一時追加＋
  QGIS API 生成の追加9層（`__qmltest_extra`: rule/null/singleDD/ellipse/font/
  hashline/symlevel/scalevis/label）。検証後に両グループ除去・プロジェクト非保存
- QGIS 側基準画像: `QgsMapRendererSequentialJob` による同期オフスクリーンレンダ
  （非同期 `setItemVisibilityChecked` は再描画混在で不可）。白背景・範囲・
  ビューポート（1514×912）を QGIS 実表示と一致させたペア比較
- Canvas 側: NOBASE=1、solo は `item.visible`+ds/imagery 直接切替
  （`setLayerVisible` は rebuild 誘発で不使用）・`/api/command` ブロック
- 結果サマリ: **6エンジン × 31層、全層 solo 描画・PAGEERR 0**
  （navara のみ googlefonts へのアクセス CORS 警告2件・描画への影響なし）

### ペア画像・差分

- 画像: `live-{qgis,canvas}-<engine>-<layer>.png`（cesium 41組・他5エンジン各31組）
- コンタクトシート: `live-sheet-<engine>-{0..2}.png`
- 機械差分: `_diff-<engine>.txt`（白率ベース。UIベースライン ~3.3%/cesium 他）
  machine-OK: cesium 11/41, maplibre 5/31, openlayers 11/31, leaflet 12/31,
  navara 2/31, gsimaps 13/31 — 機械値は粗いため最終判定は目視

### 実 finding（今回修正）

- **`invertedPolygonRenderer` が Cesium で非描画 → 修正済**
  (`web/cesium/qml-render.js`)
  1. マスクポリゴンを `height=0` で通常 Primitive 化していたが、
     `scene.globe.depthTestAgainstTerrain = true`（app.js:92 常時ON）下で
     楕円体表面と同面になり深度競合で全体が非表示だった
     → `height` をカメラ高度比例の `CallbackProperty`（camH×0.01, 下限1m）へ
  2. 地物ごとに「外枠−自地物の穴」を作っていたため外枠が重なり半透明色が
     積算されていた（QGIS はレイヤ全体に1枚の補集合マスク）
     → ループ中はリング集約のみ行い、代表1エンティティへ
     「外枠−全地物リングの穴」の1枚マスクをループ後に設定
     （再適用時は `_qmlInvHier` で元ジオメトリ復元）
  - 修正後: QGIS と同等の「外側塗り＋地物だけ抜き」描画を確認
    （`_chk_inverted4.png`）

### エンジン別の不一致・近似（目視判定）

- **ren_25d**: QGIS 橙色系 vs Canvas 青系グラデの押出し表現（全エンジン近似・色不一致）
- **ArrowLine**: cesium/openlayers は太め弧状近似、maplibre/leaflet は単色線近似
  （宣言済み警告あり）/ gsimaps・navara は細い線
- **GeomGen_fill**: buffer 範囲が QGIS より小さく出る傾向（cesium/OL）。
  maplibre/leaflet は塗り抜けてアウトラインのみ描画
- **GradientFill**: 2D 系エンジンはグラデが細帯タイリング風に出る
  （QGIS は面内連続グラデ）。cesium は近い見た目
- **CentroidFill**: maplibre はポリゴンアウトラインのみ、leaflet は未描画、
  cesium/OL は点描画
- **ren_inverted (2D)**: 2D 系は `applyInvertedMaskGeojson` で正しく
  1枚マスク（maplibre/OL 確認）。色味はやや濃い差あり
- **ren_heatmap**: 非対応エンジンは点シンボル近似（宣言済み）。色味差あり
- **ren_merged**: maplibre でアウトライン矩形が残る（QGIS は統合表示）
- **LinearReferencing**: 距離標ラベルが 2D 系では疎な点表示のみ
- **MarkerLine**: maplibre/leaflet はマーカー間隔が疎・色付き線になる差
- **RasterLine**: fallback 色が leaflet/cesium で黒（QGIS 赤）—
  画像未ロード時の代替色差
- **navara**: ライン系は描画されるがポリゴン塗り系が描画されない
  （FilledLine は表示、GradientFill は空白）。白背景化も非対応
- **gsimaps**: ライン系は描画。複数の塗り系（GeomGen_fill/GradientFill/
  PointPatternFill/ShapeburstFill）が未描画
- **画像フォールバック系**（AnimatedMarker/RasterMarker/RasterFill/SVGFill/
  RasterLine）: フィクスチャの参照画像（Temp パス等）が存在しないため
  円/単色フォールバック — 意図通りの警告・挙動

### QML 警告カタログ（宣言済み近似・障害なし）

- ArrowLine/InterpolatedLine/LinearReferencing/Lineburst/MarkerLine/HashLine
  のエンジン別単色近似
- VectorField 矢印画像近似・MaskMarker 非描画（QGIS 準拠）
- embeddedSymbol 地物別上書き未再現・heatmapRenderer 点近似
- mergedFeatureRenderer 個別描画・pointDisplacement 距離近似
- GeometryGenerator 常用関数近似・25dRenderer 固定高さ近似
- ラベル obstacle 画面投影近似・縦書き水平代替・offsetType 点近似
- bufferNoFill 非対応エンジン警告・EllipseMarker symbol_name=rectangle 近似

### メモ

- `/live/style` 発行 QML は QGIS 4.2.3 自身のシリアライズ
  （QGIS4 新形式 prop 名もそのまま到達する経路を確認）
- `/live/file/` 配信 SVG/画像はブラウザ直接 fetch/Image で取得可
  （CORS 応答正常）。style-audit の `compileQmlStyle` 直接呼出しは
  画像未ロードなためフォールバック警告が出るが、実描画経路
  `loadQmlStyle`（プリロード付き）では DM_1 で警告0を確認
- `qmltest2_*`（追加9層）は rule/null/DD/ellipse/font/hashline/symlevel/
  scalevis/label を網羅し全エンジンで概ね整合（scalevis/null は正しく非表示）
- QGIS プロジェクトは非保存（dirty のみ残存＝復帰済状態）

## エンジン能力分類と未対応処理の整備（2025-XX-XX 追検証）

「未対応」項目を各エンジンの実 API/消費経路で照合し、**エンジン非対応
(ネイティブ API 不存在)** と **アダプタ実装ギャップ(エンジンは可能だが
配線不足)** を分類した。エンジン非対応は `QML_ENGINE_CAPS` テーブルで
能力宣言し、`compileQmlStyle(engine)` に対して「このエンジンでは未対応
です」形式の警告を出す。実装ギャップは共有展開ヘルパーで解消した。

### エンジン能力マトリクス（実コード調査結果）

| 機能 | cesium | maplibre | openlayers | leaflet | navara | gsimaps |
|---|---|---|---|---|---|---|
| 25d 押出し | ○ entity | ○ fill-extrusion | ✗ エンジン非対応 | ✗ 同 | ○ extrudedHeight | ✗ 同 |
| heatmap | ○ heatmap.js 矩形 | ○ heatmap 層 | ○ HeatmapLayer | ○ leaflet.heat | ✗ 点近似 | ✗ 点近似 |
| pointCluster | ○ EntityCluster | ○ cluster | ○ ClusterSource | ○ markercluster | ✗ | ✗ |
| pointDisplacement | ○ リング移植 | ○ 座標変位(今回実装) | ○ 同 | ○ 同 | ○ 同 | ○ 同 |
| mergedFeature | ✗ 全エンジン(宣言済み近似・地物跨ぎ dissolve なし) | | | | | |
| invertedPolygon | ○ 1枚マスク | ○ | ○ geometry差替 | ○ | ○ | ○ |
| GeometryGenerator | ○ | ○ | ○ | ○ | ○ | ○ |
| CentroidFill | ○ | ○ __kasc_cicon | ○ interiorPoint | ○ | ○ | ○ |
| ArrowLine | ○ 矢印ポリゴン | ○ 生成ポリゴン | ○ arrow rings | ○ 生成ポリゴン | ○ 生成ポリゴン | ○ 生成ポリゴン |
| MarkerLine/HashLine | ○ | ○ icon-image | ○ | ○ 生成点/刻み(今回実装) | ○ 同 | ○ 同 |
| RasterLine | ✗ | ○ line-pattern | ✗ | ✗ | ✗ | ✗ |
| LinearReferencing | ○ | ○ | ○ | ○ | ○ | ○ 生成点+tooltip |
| InterpolatedLine | ○ | ○ line-gradient | ○ | ○ 分割 | ○ 分割 | ○ 生成分割(今回実装) |
| パターン塗り(tile) | ○ ImageMaterial | ○ fill-pattern | ○ CanvasPattern | ○ SVG pattern | ✗ 単色 | ✗ 単色 |

✗ のうち **エンジン非対応**（ネイティブ能力なし）として警告処理したもの:
- 25dRenderer 押出し: openlayers / leaflet / gsimaps
- heatmapRenderer: navara / gsimaps（cesium は heatmap.js 画像矩形で実装済・警告解除）
- pointCluster: navara / gsimaps
- パターン塗り: navara / gsimaps（単色代替）
- RasterLine: cesium / openlayers / leaflet / navara / gsimaps
  （基線を fallback として残す。OL の decorOnly から rasterline を
  除外して不可視を解消）

### 追加実装（生成地物展開の拡張・第2弾）

`qmlExpandGeneratedFeatures` に `decor`/`displacement` オプションを追加し、
スクリーン px 基準装飾を TRIM_PX_TO_M(2.8m/px=縮尺1:1万換算)の固定サイズ
生成地物として展開（linref/trim と同規約の近似。ズームには追従しない
宣言済み近似）。

- **MarkerLine**: サンプル点へ回転付きマーカー点生成 → leaflet/navara/gsimaps
- **HashLine**: サンプル点へ tick 短線生成 → 同上
- **ArrowLine**: `arrowLinePolygonRings`（C++ straightArrow/curved 移植）で
  矢印ポリゴン生成 → maplibre/leaflet/navara/gsimaps
- **LinearReferencing**: 標点生成+`__kasc_lrt` ラベル → gsimaps
  （tooltip で里程表示。他エンジンは既存ネイティブ経路）
- **InterpolatedLine**: `splitInterpolatedGeojson` 24分割+補間色・幅 → gsimaps
- **pointDisplacement**: 近接点を重心基準リング/同心円/グリッドへ座標変位
  （`__qmlOrigGeom` 退避で再適用時も冪等）→ maplibre/OL/leaflet/navara/gsimaps
- **基線抑制**: 装飾レイヤ(MarkerLine/HashLine/ArrowLine/RasterLine/linref/
  interpolated/lineburst)は QGIS 同様実線を引かないため、
  leaflet/navara/gsimaps の spec 解決で「下位の実線レイヤがあればその
  スタイル、無ければストローク無し」に統一。maplibre の装飾抑制正規表現に
  arrowline/interpolated を追加
- **警告整理**: cesium heatmap を実装済みとみなし caps 修正。
  「ラインシンボル X は一部エンジンで単色近似です」汎用警告は、
  エンジンが該当装飾を実描画できる場合のみ除去（capabilities ゲート）

実測値（?project=_qml_verify・`_genfeat_probe.mjs`）:
- leaflet: MarkerLine +15 生成点 / ArrowLine +5 生成ポリゴン
- navara: 同上（useIds 経路）/ maplibre: ArrowLine +5 生成ポリゴン
- 全6エンジン page errors = 0

### 実装ギャップとして修正したもの（エンジン能力は存在）

- **GeometryGenerator(spec.gg) の 2D 全エンジン未消費**:
  共有 `qmlExpandGeneratedFeatures()`(qml-2d.js) を新設し、
  `evalGeomExpr` で生成ジオメトリを生成地物として展開。
  合成 spec を `feature.__qmlSpec` / `properties.__kasc_gspec`
  (navara は tiled geojson のため id 参照 `item._qmlGenSpecs`) に埋込み、
  各エンジンの per-feature spec 解決で優先参照させる。
  - maplibre: maplibreApplyQml 冒頭で展開→既存 `__kasc_*` 焼込み経路
  - openlayers: compiled 確定後に生成地物を vectorSource.addFeatures
  - leaflet/navara/gsimaps: 既存の地物展開ブロックへ追加
  - 実測: GeomGen_fill=+4 ポリゴン / GeomGen_marker=+6 点 /
    CentroidFill=+4 点（leaflet/navara/gsimaps/maplibre/OL で確認）
- **CentroidFill の leaflet/navara/gsimaps 未描画**:
  同ヘルパーで interior 点（外周重心→内部走査）生成地物に展開
  （maplibre/OL/cesium は既存ネイティブ経路を維持）
- **invertedPolygon の gsimaps 未適用**:
  `applyInvertedMaskGeojson` を描画コピーへ適用（元 _geojson 不変）
- **`evalGeomExpr` centroid 系の座標バグ**:
  `{type:"Point", coordinates:{lng,lat}}` を返していた
  （geomCentroid はオブジェクト返却）→ `[c.lng, c.lat]` に修正。
  cesium 側でも centroid() 式の GG が無描画だった潜在バグ

### エンジン別警告の発火確認（実パス loadQmlStyle）

- navara heatmap: `heatmapRenderer はこのエンジンでは未対応です(点シンボルで近似)`
  （汎用文は自動除去）
- leaflet/OL/gsimaps 25d: `25dRenderer の押出しはこのエンジンでは未対応です(平面に描画)`
- page errors: 全エンジン 0

### 残存する宣言済み近似（エンジン非対応）

- mergedFeatureRenderer の地物統合（全 Web エンジンで dissolve 不可）
- AnimatedMarker のアニメーション（静止先頭フレーム）
- RasterLine の画像繰り返し（maplibre 以外。基線 fallback で可視を維持）
- GradientFill 等の連続グラデ（タイルタイリング近似）
- 生成装飾の固定サイズ性: MarkerLine/HashLine/ArrowLine の生成地物は
  縮尺1:1万換算の固定サイズ近似で、ズームに追従しない
  （QGIS のスクリーン px 指定を地図単位へ換算したもの）

## Cesium 再比較（2026-11-24・軽量プロジェクト版・全層 others=0）

プロジェクトを軽量化(90MB gpkg 除去→読込 17s)後に全31層を再撮影。
各層 `target ents=N shown=N others=0` でクリーン取得(初層のみ一過性 LEAK→自己解消)。
bbox は従来値 `139.70,35.68,139.99,35.73` のまま。

### 範囲差の解明(「QGIS 4点 vs Canvas 6点」)

点系層の QML geojson と QGIS 側 featureCount はともに **6 件**
(extent 139.72–139.97, 35.72–35.82)。比較 bbox は y<35.73 のため
QGIS 側で上位2点が範囲外にクリップされ 4 点のみ描画される。
Canvas は同 bbox を幅基準でフィットするため鉛直方向を広く表示し
6 点描画される。**点数差はハーネスの範囲差であり Canvas 側の
バグではない**。厳密比較には層 extent 全体を含む bbox が望ましい。

### 全層目視判定（修正適用後のコードで再評価したものを含む）

| レイヤー | 判定 | 備考 |
|---|---|---|
| AnimatedMarker | 差異(フォールバック) | 画像アセット欠損で双方 fallback。QGIS=赤丸、Canvas=青扇形 |
| ArrowLine | 許容近似 | 弧+矢羽根を描画(改善済)。矢頭が大きめ |
| CentroidFill | 一致 | 4点・位置一致 |
| FilledLine | 未対応近似 | QGIS=緑太バッファ、Canvas=緑細線(帯塗り無し) |
| FilledMarker | 許容近似 | 橙ダイヤ→橙ウェッジ状(色一致・形状近似) |
| GeomGen_fill | 一致 | 黄矩形一致(角丸未再現) |
| GeomGen_line | **修正後一致** | `reverse($geometry)` 対応追加で生成線描画(修正前は無描画) |
| GeomGen_line_xyz | — | 両者無描画 |
| GeomGen_marker | 一致 | 緑三角一致(前回「未対応」から改善) |
| GradientFill | 許容近似 | 青グラデ再現だが方向が異なる |
| GradientFill_xyz | — | 両者無描画 |
| InterpolatedLine | 許容近似 | 赤線+幅変化を再現 |
| LinearReferencing | 一致 | 標点ラベル分散配置が一致 |
| Lineburst | **修正後一致** | 補間セグメント描画(修正前は NaN 幅で無描画) |
| LinePatternFill | 未対応近似 | 疎な斜線片のみ(密ハッチ非再現) |
| MarkerLine | 一致 | 頂点マーカー配置一致 |
| MaskMarker | 一致 | 両者無描画(前回は赤点を描画してしまっていた→改善) |
| PointPatternFill | 未対応近似 | 疎なドット片のみ(密ドット非再現) |
| PointPatternFill_xyz | — | 両者無描画 |
| RandomMarkerFill | 差異 | ランダム配置せず規則グリッド+大きめ四角 |
| RasterFill | 差異(フォールバック) | 画像欠損→橙ドット(スケール・色差) |
| RasterLine | 差異(フォールバック) | 画像欠損→太い黒線(QGIS は '?' プレースホルダ列) |
| RasterMarker | 差異(フォールバック) | 画像欠損→橙ウェッジ |
| ren_25d | 未対応 | QGIS=橙立体、Canvas=青フラット(押出無効+色違い) |
| ren_embedded | 一致 | 両者無描画 |
| ren_graduated | 一致 | 段階色・サイズ一致(形状はウェッジ近似) |
| ren_heatmap | 許容近似(品質) | 画像矩形 ents=1 で実装済だが小さな点状にしか見えない |
| ren_inverted | **一致(改善)** | 緑マスク+白抜きを正確再現(前回「未対応」) |
| ren_merged | 一致 | 両者無描画 |
| ren_pointcluster | 一致 | クラスタバッジ「6」+分散一致 |
| ren_pointdisp | 一致 | 変位リング再現 |
| ShapeburstFill | 許容近似 | 中心放射でなく一方向グラデ |
| SimpleLine | 一致 | 破線一致 |
| SimpleLineDD | 一致 | DD 幅・色グラデ一致 |
| SVGFill | 未対応近似 | 1枚ストレッチ円(タイル反復無し) |
| VectorField | 許容近似 | 矢印方向一致・大きめ |

### 今回のランで発見・修正した実バグ

- **Lineburst 無描画(全エンジン共通)**:
  `buildLineDecor` の Lineburst 戻り値に `w1`/`w2` が無く、
  補間描画経路で `width=NaN` となり全セグメントが非描画だった。
  `p.line_width`(+DD)から `w1=w2` を設定(qml-style.js)。
  あわせて cesium `renderInterpolatedLine` と OL
  `interpolatedToOlStyles` に `Number.isFinite` フォールバックを追加。
- **GeomGen_line 無描画(全エンジン共通)**:
  `evalGeomExpr` が `reverse()` 未対応のため生成ジオメトリ null→
  aux 無し+本体 polyline.show=false で完全空白だった。
  `evalGeomExpr` に `reverse` ケース(パート構造維持の頂点反転)を追加。
- **maplibre pen=none ポリゴンの青フォールバック線**(前段):
  `__kasc_stroke` が未設定時に線レイヤへ `["has",...]` ゲート無しで
  `#2c5ea8` フォールバック色が出ていた(qml-2d.js)。
- **navara 不透明度**(前段): `qmlNoFill`/`qmlNoStroke` 時の
  polyFillO/polyLineO 取り扱いを修正(navara/app.js)。
- `_nofill_verify` プローブ(3 geojson×noFill/noStroke/neither)は
  全6エンジン **18/18 PASS**(フォールバック青塗りなし・緑枠/赤塗り正解)。

### 観察された系統差(要次回調査)

- **マーカーの「扇形/ウェッジ」近似**: FilledMarker/ren_graduated/
  ren_pointcluster/ren_pointdisp/RasterMarker fallback の丸・ダイヤ系
  マーカーが扇形(部分円)に見える。正方・三角は正常なため、
  billboard 画像の一部だけが表示されている可能性(テクスチャ領域/
  原点ずれ)を疑う。GeomGen_marker の三角・MarkerLine の四角/ダイヤは
  全体が描けている。
- **AnimatedMarker フォールバック色**: QGIS=赤丸/Canvas=青扇形。
  双方アセット欠損時の fallback だが色・形状が揃っていない。
