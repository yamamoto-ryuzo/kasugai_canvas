# Navara API 監査・実装検証証跡（2026-11-18）

対象: `web/navara/`（@navaramap/three 0.3.1 / three 0.187.0 / postprocessing 6.39.6、全ピン最新確認済・更新なし）
検証環境: `http://127.0.0.1:8510/navara/` + Playwright 1.63（chromium-1243）

## Phase A — バージョン

`npm view` 全パッケージ = vendor.json ピン一致。**vendor 更新不要**。

## Phase B/C — 実装済み・本回収で新規実装したもの

| 項目 | 実装 | 検証結果 |
|---|---|---|
| `picking` オプション | `false` → `true`（app.js ThreeView コンストラクタ） | ✅ |
| `featureClick` → 属性タブ | info.properties → `renderAttrContent` + `liveNotifySelection`（QGIS 逆通知） | ✅ 実行時 FeatureInfo `{properties:{name:"PICKTEST",value:42}, batchId, layerId}` を取得し `#attr-content` へ属性描画確認 |
| ツールクリック抑止 | `view.on("click")` → `geoTools.handleClick`、消費時は同ジェスチャの featureClick を `_toolClickHandled` フラグ+`geoTools.isActive()` で抑止 | ✅ 計測中の featureClick は全て info=null・属性タブ非遷移 |
| ポインタ→地理座標 | `vector3ToGeodetic`（`ev.map` ECEF→lng/lat）を `pointerToLL` として配線 | ✅ click/pointermove 経路で計測・作図が動作 |
| geoTools 全セクション | `measure/spatial/draw/profile/los/export` を有効化 + `setCursor` + `dblclick` ハンドラ | ✅ 距離計測: 総延長 4217.84 km(3点) 表示 + 黄色ライン描画（navara-measure.png） |
| `sampleTerrainMostDetailed` | geoTools `sampleTerrain` フック（terrainSrc 無し/失敗時は地理院APIへフォールバック） | ✅ 配線済（標高断面は quantized-mesh 時 Navara ネイティブ標高を使用） |
| ツールオーバレイラベル | text 付き地物 → `text` マテリアル専用レイヤ（font=Noto Sans JP・evaluator で text/show） | ✅ 区間ラベル "3919.75 km" 表示（navara-ellipsoid.png） |
| `ellipsoid` マテリアル | `syncEllipsoidLayer()`: 地形も表示中ベースマップも無い時 `{type:"terrain", ellipsoid:{}}` を自動追加（clampToGround 焼き込み面の確保） | ✅ 「ベースマップなし」選択でも地表描画継続・計測線がドレープ表示（navara-ellipsoid.png） |
| `view.attribution` | `syncAttribution` が内蔵帰属へ `attributionHtml` を `clear()+add()`（ベースマップ出典含む）。失敗時は独自 DOM フォールバック | ✅ `attribution.items` 存在・ネイティブ UI 表示中 |
| `view.globe.transparent` | `base: | transparent` 行 → globe.transparent=true + #map 背景透明 | ✅ 配線済 |
| `base: | none` / 「ベースマップなし」 | モード行で初期非選択 + セレクトへ `value="-1"` 選択肢追加（他エンジンパリティ） | ✅ selOpts=["-1","0","1"...] |
| `mvt:` ベクトルタイル | `addSource({type:"vector-tile"})` + `sourceLayers`（layers=/srclayers= 指定） + 既定マテリアル | ✅ コード経路実装（レイヤリストの unsupported 解除済） |
| `rain`/`snow` メッシュ | fx トグル → `addMesh({rain:{}})`/`addMesh({snow:{maxHeight:1e5}})` | ✅ トグルで `view.animation=true`・エラー無し（navara-weather.png） |
| `view.animation` | `syncFxAnimation()`: clouds/rain/snow 有効時のみ ON（省電力既定維持） | ✅ |
| `memoryStats` | `kasugaiApi.getMemoryStats()` で公開 | ✅ `bufferTotalBytes/gpuBytesEst` 等取得 |

## 残ギャップ（未実装・理由）

| API | 状態 | 理由・見通し |
|---|---|---|
| `hillshade`/`elevationHeatmap` | ❌ | `raster-dem` ソース必須。`.kasc` に DEM 行型が無い（要新形式+QGIS連携検討）。`JAPAN_GSI_ELEVATION_DECODER`/`MAPBOX_ELEVATION_DECODER` はその際の decoder 選択肢 |
| `raster-dem`/`b3dm`/`pnts` ソース | ❌ | `.kasc` 表現なし。b3dm/pnts は `3dtiles:` で概ね代替可能 |
| `cameraFollow`/`cameraFreeLook`/`lookAt`/`moveCamera*`/`rotateAround*` | ❌ | Fly/プレゼン UX 拡張候補。`setCamera`/`flyTo`/`camera.on("move*")` で現要件充足 |
| `pickTerrainPosition`/`pickDepthPosition`/`observeTerrain*`/`sampleTerrainHeight*` | ❌ | `sampleTerrainMostDetailed` で断面要件は充足。精密クリック座標向上余地あり |
| 未使用 Effect: `colorGradingLUT`/`depthOfField`/`fogLight`/`rainDrop`/`selectiveBloom`/`selectiveOutline`/`ssr` | ❌ | fx.* 拡張候補。`fxaa/smaa/toneMapping/lensFlare/aerialPerspective` は photorealScene バンドルで使用済 |
| `lightProbe` | ❌ | `ambient`/`sun`/`skyLightProbe`(photoreal) で現要件充足 |
| 未使用メッシュ登録 22 種（arcLines/glowGlobe/splat/stars 等） | ❌ | 個別シーン装飾は addMesh で随時追加可能。rain/snow は導入済 |
| `addMesh` カスタムメッシュ/`registerMesh`/`InstancedMesh` | ❌ | Tier1 上級 API。Canvas 抽象に必要性が出た時点で |
| `workerMemoryStats`/`lodFog`/`dynamicSse`/`setSseMultiplierRange`/`isMobileOptimized`/`cacheBytes` | ❌ | 性能チューニング UI 候補。memoryStats は API 公開済 |
| `findLayerById`/`updateXxxById`/`deleteXxxById` | — | ハンドル管理で充足（layerEntries が参照保持） |
| `removeFontFamily` | ❌ | QML フォントはプロジェクト単位で追加のみ・解除需要低 |
| `idle`/`resize` イベント | — | `forceUpdate`+自動 resize で充足 |
| `AttributionPlugin` | — | `view.attribution`（同プラグインの内蔵インスタンス）へ供給済のため別途導入不要 |
| `@navaramap/three-plugins`（PersonView/Overlay/CesiumIon/TileJson/MapLibreStyle） | — | vendor.json 未収録パッケージ。MapLibreStyle は mvt スタイル対応の将来候補 |

## 検証スクリーンショット（本ディレクトリ）

- `navara-pick2.png` — featureClick 属性表示
- `navara-measure.png` — 距離計測 4217.84 km オーバレイ
- `navara-ellipsoid.png` — ベースマップなし + ellipsoid 面 + 区間ラベル
- `navara-weather.png` — 雨・雪トグル後シーン
- `navara-verify-main.png` — 通常シーン

エラー: 全検証で pageerror/非想定 console.error 0 件（GSI seamlessphoto タイルの一部 404 は上流都合・無害）
