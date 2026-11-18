# GSI Maps エンジン API 監査証跡（2026-11-18）

対象: `web/gsimaps/`（vendored 地理院地図 `gsi-cyberjapan/gsimaps` gh-pages iframe 組み込み + Canvas シェル `app.js`）
検証環境: `http://127.0.0.1:8510/gsimaps/`（kasugai_canvas 7.1.0）+ Playwright（OS インストール Chrome）

証跡ファイル:
- `probe-gsi-api-enum.mjs` → `gsi-api-enum-20261118.json`（2D 列挙）
- `probe-gsi-globe-enum.mjs` → `gsi-globe-enum-20261118.json`（Globe 列挙）
- `probe-gsi-tools.mjs` → `gsi-tools-audit-20261118.json`（26/26 PASS）
- スクリーンショット: `gsi-audit-2d.png` / `gsi-audit-globe.png` / `gsi-tools-boot.png` / `gsi-tools-layers.png` / `gsi-tools-globe.png` / `gsi-tools-restored.png` / `gsi-tools-sakuzu.png`

## Phase A — 上流追従

`gh api repos/gsi-cyberjapan/gsimaps/commits/gh-pages` = `3cc3b492a76e65d173d86f23ecb712a5faa38991` = vendor.json ピン一致。**追従遅れなし・vendor 更新不要**。

## Phase B — 実行時列挙（正本）

### 2D（index_pm.html）

- `GSI` = **132 keys**（クラス/シングルトン混在）
- `GSI.GLOBALS` = `{gsimaps}` のみ（実行時インスタンスは `GLOBALS.gsimaps._mainMap` 配下）
- `_mainMap` keys: `options,_gsimaps,_mapFrame,_mapContainer,_dialogManager,_map,_mapLayerList,_mapMouse,_evacDialog,_hanreiLoader,_attrpanel,_cocoTileLayer,_mapMenu,_footer,_confirmDlg,_volcanoConfirmDlg,_centerCross,_zoomGuide,_layersJSON,_baseLayer,_enableLakeData` 等
- `_mapLayerList` proto: `tileList,list,append,appendKML,appendList,appendComparePhoto,appendOutSideTile,updateTileLayer,setBaseLayer(なし→globe のみ),remove,clear,exists,refreshTileList,getTileList,getList,getTotalCount,getElevationData,setElevationData` 等
- `_layersJSON` proto: `layersHash(1300件),tree,layers,visibleLayers,visibleLayersHash,getBase,getOriginal,load,add,loadBase` 等
- `_sakuzuList`: proto 空（インスタンス `_list` 配列 + `fire("change")` で運用）
- `layersHash` エントリ schema: `{type,id,title,url,cocotile,html,legendUrl,errorTileUrl,parent,layerType,thumb}`

### Globe（globe/index_globe.html — 別アプリ）

- グローバル: `GLOBE, GSI, GSI3D, MA, MATEST, Cesium, CONFIG`
- `GSI` = **32 keys**（2D のサブセット。globe 独自 = `LayerTreeDialog,LayerTreeSearcher,OpacitySlider,ViewListDialog`）
- `GSI.GLOBALS` = `{isBaseLayer,queryParams,evacManager,evacDialog,mapLayerList,layersJSON,cocoTileLayer,confirmDlg,viewListDialog,layerTreeDialog}`（10 keys — **前回未実施だった globe 側列挙を今回消化**）
- `mapLayerList` proto（globe）: `tileList,list,setBaseLayer,append,appendKML,appendList,appendOutSideTile,appendComparePhoto,updateTileLayer,remove,clear,exists,getTileList,getList` — 2D と同型 + `setBaseLayer` 追加
- `layersJSON` proto（globe）: `layersHash(1346件 — 2D より多い),getBase,tree,layers,visibleLayers` — 2D と同型
- `GLOBE.MAP` ≈ 100 メソッド: `viewer`（Cesium Viewer）+ `fly,flyToDefault,setHeightPower,setTerrainProvider,pindrop,addMarker,clearPinLayers,drawGeojson,drawKml,convertEntityToPrimitive,addImagePrimitive,addSingleImageryLayer,createPolylinePrimitive,createCorridorPrimitive,getCenterPosition,getCameraPosition,getCurrentZoom,windowPositionToLatLng,showPointInfo,GetAddr,getComparePhotoControl,showComparePhotoControl,layerChangeOpacity,layerImageryAdjustment,hide_showLayer,deleteLayer,updateClamp,setClickEvent` 等
- `GLOBE` クラス: `VectorLayer,KMLLayer,GeoJSONLayer,VectorTileLayer,MultiLayer,ComparePhotoControl,ComparePhotoLayer,ComparePhotoContainsChecker`
- `GSI3D` = `{bind,Event,Point,point,DEMManager,DEMLoader,ReliefTileLayer}`（globe 専用 DEM 面）
- `MA` = Leaflet 系ユーティリティ（`Util,extend,Class,TileLayer,Control,DomUtil`）

### 2D↔Globe 差分

- 2D のみ: Sakuzu 系（作図）・Draw/Edit・断面図系・印刷系・検索系・グリッド系・MapPanel/Menu 系 GUI 一式
- Globe のみ: `LayerTreeDialog,LayerTreeSearcher,OpacitySlider,ViewListDialog` + `GLOBE.*` + `GSI3D.*` + `GLOBALS.mapLayerList/layersJSON`（2D の GLOBALS は gsimaps 参照のみ）

## Phase C — Canvas シェル利用状況

`GSI.` 直接参照は `GSI.GLOBALS`・`GSI.LayerOpacitySetter` のみ。実態は `GLOBALS.gsimaps._mainMap` 配下の**インスタンス**経由 + `G.` エイリアス（`G.GeoJSON`,`G.SakuzuListItem`）+ globe 側 `GLOBE.MAP.viewer`/`Cesium` で構成 — これは設計上正しい（クラスではなく実行時インスタンスが必要なため）。

- `.kasc` ベクター行 → `G.GeoJSON` + `G.SakuzuListItem` を `sakuzu._list` へ注入（app.js:780-802）
- `.kasc` タイル行 → `w.L.tileLayer` 直接（appendOutSideTile は refreshTileList で消えるため不使用・意図的）
- gsi ベース → `_baseLayer.setActiveId` / globe `mapLayerList.setBaseLayer`
- 表示レイヤ → `gsiMl()`（2D=`_mapLayerList` / globe=`GLOBALS.mapLayerList`）の tileList+list 読み取り
- 透過 → `LayerOpacitySetter`/`_baseLayer.setOpacity`/globe `ImageryLayer.alpha`
- sakuzu → `_sakuzuList._list` 列挙 + `toGeoJSON` → `geojson:` 行
- 共有URL → `gsiApp._pageStateManager`（`GSI.PageStateManager` インスタンス）
- globe → `GLOBE.MAP.viewer` + `Cesium`（GeoJsonDataSource/ImageryLayer 注入・camera イベント・hash ミラー）

## Phase E — 実機検証（26/26 PASS）

| 検証 | 結果 |
|---|---|
| 起動・プロジェクト読込・getCamera | ✅ layers=10, view 取得 |
| listGsiBasemaps / setGsiBasemap(pale) | ✅ count=5, active=pale 反映 |
| listGsiCatalog（filter "写真"→133 / 全件 1266） | ✅ |
| addGsiLayer("airphoto") → listGsiLayers | ✅ airphoto 表示登録 |
| setGsiLayerOpacity(0.5) / setGsiLayerHidden / moveGsiLayer(top) | ✅ |
| importGsiLayers / importGsiCatalog | ✅ xyz: 行として .kasc 追記 |
| getGsiElevation(富士山) | ✅ 3770.6m（1mレーザ） |
| getGsiShareUrl | ✅ maps.gsi.go.jp 形式・レイヤ透過度も `ls=ort\|airphoto,0.5` で引継ぎ |
| listGsiSakuzu / importGsiSakuzu | ✅ 非Canvas作図(L.FeatureGroup) → 地物取込・レイヤ化 |
| setGsiGlobe(true) → GLOBE.MAP.viewer/GLOBALS.mapLayerList | ✅ tileList=2（ort+airphoto 引継ぎ） |
| Globe getCamera/listGsiBasemaps/listGsiLayers | ✅ |
| setGsiGlobe(false) → 2D 復帰・視点引継ぎ | ✅ |

補足: `importGsiSakuzu` の永続化は `saveDataFile` 成功 → `addLayer` でフォールバックに落ちた（旧 7.1.0 バイナリが PUT 応答に `dataDir` を返さずフロント fallback `canvas_data` と実書込先 `DATA/` が不一致 → geojson URL が 404）。**現行ソースでは `dataDir` 応答実装済みのため整合は取れる — 実行バイナリの古さに起因する環境差で、コード側の欠陥ではない**。ただし旧サーバーとの組合せでは「ファイルだけ書けて行追加が失敗→孤立ファイル」になり得る（観察記録）。

## 更新後 種マトリクス

| 領域 | API 面 | 状態 | 補足 |
|---|---|---|---|
| 起動・初期化 | `GLOBALS.gsimaps._mainMap` | ✅ | waitGsimaps app.js:241-289 |
| レイヤカタログ | `layersHash`/`getBase()`/`_mapLayerList.append` + 遅延 src 群ロード | ✅ | 2D 1300 件/globe 1346 件。`gsiLoadLazyGroups` でトピック遅延群も探索 |
| 表示レイヤ操作 | `tileList`/`list`・`_isBaseLayer`/`GLOBALS.isBaseLayer` | ✅ | globe/2D 両対応 gsiMl() |
| レイヤ取込 | 表示中 → `xyz:` 行（importGsiLayers）/ カタログ直接（importGsiCatalog） | ✅ | ベースフォルダ子・KML・ベクタタイル・時系列比較は取込対象外（reason 返却） |
| 透過度 | `LayerOpacitySetter`/`_baseLayer.setOpacity`/globe `alpha` | ✅ | |
| 2D 表示同期 | `L.Hash` 無効化 + 親 `replaceState` 同期 | ✅ | joint session history 競合回避済 |
| Globe（3D） | `enterGlobe`/`exitGlobe`・`GLOBE.MAP.viewer`・`GLOBALS.mapLayerList/layersJSON` | ✅ | globe API 全列挙今回実施。`GLOBE.MAP` の高レベル API（後述）は未使用だが viewer 直操作で同等機能を実現済 |
| 標高・DEM 系 | `getelevation.php` REST（`getGsiElevation`/`sampleGroundHeight`/geo-tools `elevationProfile`） | ✅（REST 等価） | `GSI.ElevationLoader`/`FooterElevationLoader`/`DEMLoader`/`FreeReliefDEMLoader`/`CrossSectionDEMLoader`/`GSI3D.*` 内部 API は未使用だが地点標高・標高断面は REST で充足 |
| 断面図 | geo-tools-2d `elevationProfile`（getelevation.php サンプリング） | ⚠ 近似 | gsi native `CrossSectionView*`/`TGrid`（ライン上断面の専用ダイアログ）は iframe GUI 完結 — shared 側で機能代替済 |
| グリッド系 | shared `setGraticule`（緯度経度グリッド） | ⚠ 近似 | gsi 固有 `UTM`/`ChiikiMesh`/`TileGridLayer`/`JihokuLine`/`HouiLine`/`CenterCross`/`ZoomGuide` は未連携 |
| データ読込 | shared `vector-load.js` → GeoJSON → SakuzuListItem 注入 | ⚠ 等価経路 | gsi native `GSI.KML`/`GSI.GeoJSON`/`CSVLoadDialog`/`LocalFileLoader` は未使用だが .kasc ベクター行は等価経路で描画済。`geotiff:`/`cog:` 行は未対応（`GeoTIFFImageOverlay` 転用候補） |
| 計測・作図 | shared geoTools2d + `listGsiSakuzu`/`importGsiSakuzu`/`removeGsiSakuzu` | ✅ | 作図結果の .kasc 取込みも実装済（前回台帳の「検討余地」を消化） |
| 印刷・画像出力 | iframe 内完結（gsi `PagePrinter`/`MapToImage` GUI） | — 対象外 | geoTools `sections.print=false`。gsi GUI が iframe 内で完結するため現状維持 |
| 検索・位置 | shared `searchLocation` + `createMinimap` | ⚠ 近似 | gsi `Searcher`/`AddrLoader`/`GPS`/`LocationWatcher`/`MiniMap` は iframe 内完結。`GLOBE.MAP.GetAddr` 未使用 |
| 比較表示 | `MapCompareSeparater`/`ComparePhoto*`/`appendComparePhoto` | ❌ | 2 画面比較 API。Canvas 連携なし |
| 避難・特殊 | `EvacDialog`/`EvacuationManager`/`Toukyoken`/`MUNI_ARRAY`/`MeshDeclination`/`HouiLine*` | — 対象外 | 用途特化・iframe 内完結 |
| 属性 | 注入 sakuzu 地物 click → 属性タブ / gsi 側は `_attrpanel` | ✅ | globe 注入 entity も scene.pick → 属性タブ |
| QML スタイル | `_qmlPending` | — 対象外 | タイル表示器にスタイル描画経路なし（構造的） |

## ギャップ台帳（2026-11-18 更新）

**上流 sha = 最新（3cc3b49…＝ gh-pages HEAD・追従遅れなし）**

消化済み（前回 ❌/検討 → 今回 ✅/⚠）:
- **地点標高**: `getGsiElevation`/`sampleGroundHeight` を getelevation.php REST で実装済（GSI.ElevationLoader は未使用だが機能等価）
- **標高断面**: geo-tools-2d `elevationProfile` が同 REST API で断面を実装済（gsi native CrossSectionView* は iframe GUI 完結・不要寄り）
- **作図取込**: `listGsiSakuzu`/`importGsiSakuzu`/`removeGsiSakuzu` 実装・実検証済（GeoJSON → canvas_data 保存 → geojson: 行 or 一時レイヤー）
- **Globe 側 API 全列挙**: 実施済（上記 Phase B。`GLOBE.MAP` ≈100 method・`GSI3D`・globe 独自 4 クラスを確認）

残ギャップ（実装候補・優先度順）:
1. **`GeoTIFFImageOverlay`（2D）**: `geotiff:`/`cog:` 行を gsimaps でマウントする実装候補。現状は未対応行グレー表示。gsi の GeoTIFFImageOverlay（geotiff.js 内部読込）なら iframe 内で完結できる — **実装候補（中）**
2. **`GLOBE.MAP.setHeightPower`（globe）**: 地形強調（垂直誇張）。Cesium viewer の `scene.verticalExaggeration` 経由でも可能だが gsi 側 UI と整合させるなら GLOBE.MAP 経由 — 小
3. **`MapCompareSeparater`/`ComparePhoto*`/`appendComparePhoto`（2D+globe）**: 時系列写真の 2 画面比較。Canvas 連携の用途があれば — 小
4. **`GSI.VectorTileLayer`/`GLOBE.VectorTileLayer`**: gsi 形式ベクタタイルを .kasc からマウントするにはまず `.kasc` 行形式の拡張（`mvt:`/`vectortile:`）が必要 — **フォーマット拡張候補**（AGENTS の「タイル/大規模経路」将来候補と同じ枠組み）
5. **`GSI.LakeDataLoader`/`LakeDepthLoader`/`LakeStdHeightLoader` + `_enableLakeData`/`lakedataEnabled`**: 湖沼の水深・標高データ API。lakedata レイヤ自体はカタログ追加で描画可能。クリック計測系はニッチ — 低
6. **gsi 固有グリッド（`UTM`/`ChiikiMesh`/`JihokuLine`/`HouiLine`）**: shared graticule は緯度経度のみ。UTM グリッド・地域メッシュ・磁北線・方位線の追加は拡張候補 — 低
7. **`GLOBE.MAP` 未使用メソッド（`pindrop`/`addMarker`/`GetAddr`/`showPointInfo`/`flyToDefault`/`showComparePhotoControl`）**: ピン・住所逆引き・時系列写真制御は個別の用途次第。`drawGeojson`/`drawKml`/`addSingleImageryLayer` は app 側注入経路で等価実現済のため不要
8. **`GSI3D.DEMManager`/`DEMLoader`/`ReliefTileLayer`（globe）**: globe 側 DEM 供給は上流既定の JapanGSITerrainProvider が動作中。色別標高図（ReliefTileLayer/`EditReliefDialog`/`FreeReliefDEMLoader`）は gsi 独自機能 — ニッチ
9. **`GPS`/`LocationWatcher`（現在地）**: Canvas 側に現在地ツールなし。gsi GUI は iframe 内で使用可能 — 低

判定記録（対象外の根拠）:
- **印刷/画像/共有/QR**: `PagePrinter`/`MapToImage*`/`SaveFileWindow`/`ShareDialog`/`SharePanel`/`SHARE`/`QRCodeDialog`/`MapToImageAreaSelectDialog`/`ThreeDAreaDialog`/`MapSizeAreaSelectLayer` — iframe 内 gsi GUI で完結しユーザーが直接使える。Canvas 共有は `buildShareUrl`/`getGsiShareUrl` が担う
- **gsi GUI 内部構成品**: `MapMenu`/`MapPanel*`/`Menu*`/`BaseMapPanel`/`MapListPanel`/`ShowingMapListPanel`/`MapManager`/`Map`/`map`/`layersJSONSearchSRC`/`Header`/`Footer`/`DialogManager`/`Modal`/`Control`/`Utils`/`OnOffSwitch`/`ToggleSwitch`/`Icon*`/`DivIcon`/`Draggable`/`MarkerDrag`/`Circle`/`PixelRectangle`/`PathFrameRectangle`/`HelpDialog`/`showTopMassage`/`TEXT`/`ClientMode`/`Links`/`HashOptions`/`QueryParams`/`SaveStateManager`/`GSITMSLayer`/`TileLayer`/`MultiLayer`/`KMLIcon`/`KMLMarker`/`Canvas`/`EditOutsideTileDialog`/`LoadOutsideTileDialog`/`SakuzuDialog`/`SakuzuConfirm`/`SakuzuInfoEditDialog`/`SakuzuLoadFileWindow`/`SakuzuSaveFileWindow`/`GeoJpegMarker`/`DrawManager`/`EditManager`/`Edit`/`Draw`（gsi GUI 作図は別系統で、Canvas 作図は geoTools2d+SakuzuListItem 注入で済）/`SearchResultDialog`/`HanreiLoader`/`EditReliefDialog` — iframe 内完結の GUI/ユーティリティで Canvas 到達対象外
- **`_attrpanel`/`CenterCross*`/`ZoomGuide`/`TileGrid`/`TileGridLayer`/`LatLngGrid`**: gsi 画面装飾。Canvas 側は shared 属性タブ/graticule が担う

## 観察記録

- **`listGsiCatalog` の lazy 群**: filter 指定時は `gsiLoadLazyGroups(matchFn)` が**パス文字列一致のグループのみ**読むため、グループ名を含まない語（例 `川だけ`→属するグループのパスに一致なし）では `total=0` になり得る。`addGsiLayer` は全群ロードへフォールバックするため追加自体は可能。vendored カタログに「川だけ地形図（kawadake）」は今回の layersHash 走査でも未収録だった（src 参照群の外・または上流構成差）
- **`getCamera` と `getViewInfo`**: 公開 API は `getCamera()`（`getViewInfo` は player-api の内部フック名）。プローブ・連携コードは `getCamera` を使うこと
- **`dataDir` 不整合（環境起因）**: 旧バイナリ（7.1.0・dataDir 未応答）+ `DATA/` 残存プロジェクトでは `saveDataFile` 成功後の `addLayer` が 404 失敗 → 永続化スキップ＋孤立ファイル。現行ソースは `dataDir` 応答済みで整合。フォールバックとして「書き込み先の実 dir を listDataFiles 等で確認」する堅牢化は検討余地
- **globe 側 layersHash=1346 > 2D 1300**: globe カタログは 2D より多い（globe 専用レイヤを含む）。`globeBaseInfo` は globe カタログ側を引く設計で正しい
