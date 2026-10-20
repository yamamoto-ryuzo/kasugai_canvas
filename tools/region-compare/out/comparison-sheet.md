# 地域比較シート（初版）— 住まい候補地域の比較支援

生成日: 2026-10-20（`tools/region-compare/compare.mjs` による自動生成）
比較条件: 各候補駅から半径 1000m / 取引価格は 2025Q4 / 所要時間は 2026-10-21（水）08:00出発・経路検索の最速便
記号: ◯確認済み（実データ取得・属性確認済み） / △データなし（API応答は正常・圏内データなし） / ✗未確認（取得失敗・未接続・一次情報未確認）

## 候補地域

| 候補 | 駅 | 自治体 | 座標 | 地図 |
|---|---|---|---|---|
| A | 中野駅 | 中野区（東京都） | 35.7058, 139.6655 | [地図で見る](http://localhost:8510/?longitude=139.665500&latitude=35.705800&height=2000.0&pitch=-60.00&heading=0.00&project=reinfolib) |
| B | 川口駅 | 川口市（埼玉県） | 35.8019, 139.7175 | [地図で見る](http://localhost:8510/?longitude=139.717500&latitude=35.801900&height=2000.0&pitch=-60.00&heading=0.00&project=reinfolib) |
| C | 市川駅 | 市川市（千葉県） | 35.7287, 139.9076 | [地図で見る](http://localhost:8510/?longitude=139.907600&latitude=35.728700&height=2000.0&pitch=-60.00&heading=0.00&project=reinfolib) |

## 比較表

| 区分 | 確認項目 | A 中野駅 | B 川口駅 | C 市川駅 | 出典・基準日 |
|---|---|---|---|---|---|
| API内 | 不動産取引価格ポイント | ◯確認済み 2件 例:4,200万円 | ◯確認済み 1件 例:5,300万円 | ◯確認済み 3件 例:4,300万円 | 不動産情報ライブラリ（国土交通省） XPT001・2025Q4 |
| API内 | 指定緊急避難場所 | ◯確認済み 5件 対象災害:洪水・内水・地震・土砂・大規模火災 | ◯確認済み 8件 対象災害:洪水・内水・地震・大規模火災 | ◯確認済み 9件 対象災害:洪水・内水・高潮・津波・地震・土砂 | 不動産情報ライブラリ（国土交通省） XGT001 |
| API内 | 駅別乗降客数 | ◯確認済み 5件 候補駅あり（東京地下鉄・5号線東西線） | ◯確認済み 1件 候補駅あり（東日本旅客鉄道・東北線） | ◯確認済み 3件 候補駅あり（東日本旅客鉄道・総武線） | 不動産情報ライブラリ（国土交通省） XKT015（令和5年度） |
| API内 | 用途地域 | ◯確認済み 駅地点が区域内（圏内67件・商業地域） | ◯確認済み 駅地点が区域内（圏内12件・準工業地域） | ◯確認済み 駅地点が区域内（圏内25件・商業地域） | 不動産情報ライブラリ（国土交通省） XKT002（令和7年度） |
| API内 | 防災情報（浸水想定・警戒区域） | ◯確認済み 洪水:区域外・高潮:なし・津波:なし・土砂:なし | ◯確認済み 洪水:区域内・高潮:なし・津波:なし・土砂:なし | ◯確認済み 洪水:区域内・高潮:区域内・津波:区域外・土砂:なし | 不動産情報ライブラリ（国土交通省） XKT026/027/028/029（令和6年度） |
| API内 | 小学校区 | ◯確認済み 駅地点が区域内（圏内11件・桃園第二小学校） | ◯確認済み 駅地点が区域内（圏内9件・幸町小学校） | ◯確認済み 駅地点が区域内（圏内12件・市川小学校） | 不動産情報ライブラリ（国土交通省） XKT004（令和5年度） |
| API外 | 東京駅までの所要時間 | ◯確認済み 24分・乗換0回 | ◯確認済み 27分・乗換1回 | ◯確認済み 23分・乗換0回 | Transitous（GTFS非公式）・2026-10-21（水）08:00出発 |
| API外 | 動物病院（半径内） | ◯確認済み 6件（例: もみじ山通りペットクリニック、アイルペットクリニック） | ◯確認済み 1件（例: ピジョン動物愛護病院） | ◯確認済み 1件（例: 苅谷動物病院） | © OpenStreetMap contributors（Overpass）・DB時点 2026-10-20 |
| API外 | 公園・緑地・ドッグラン（半径内） | ◯確認済み 43件（例: 丘の上のひろば、城山公園） | ◯確認済み 19件（例: 飯塚一丁目公園、仙太郎第１公園） | ◯確認済み 6件（例: 菅野西公園、大洲公園） | © OpenStreetMap contributors（Overpass）・DB時点 2026-10-20 |
| 一次情報 | 避難所のペット受入条件 | ✗未確認 自治体の防災計画・避難所案内を確認 | ✗未確認 自治体の防災計画・避難所案内を確認 | ✗未確認 自治体の防災計画・避難所案内を確認 | 各自治体 |
| 一次情報 | 公園のペット同伴ルール | ✗未確認 自治体の施設案内を確認 | ✗未確認 自治体の施設案内を確認 | ✗未確認 自治体の施設案内を確認 | 各自治体 |

## 属性の有無（圏内データで確認できた属性キー）

- 不動産取引価格ポイント（XPT001）: 属性 29種（building_structure_name_ja, building_use_name_ja, city_code, city_name_ja, district_code, district_name_ja, floor_plan_name_ja, front_road_azimuth_name_ja, front_road_type_name_ja, future_use_purpose_name_ja, land_shape_name_ja, land_type_name_ja, land_use_name_ja, point_in_time_name_ja, prefecture_name_ja 他）
- 指定緊急避難場所（XGT001）: 属性 16種（_id, _index, address_ja, common_id, earthquake_flag, facility_name_ja, flood_flag, high_tide_flag, inland_flooding_flag, landslide_flag, large_fire_flag, prefecture_and_city, remarks, same_address_flag, tsunami_flag 他）
- 駅別乗降客数（XKT015）: 属性 61種（S12_001_ja, S12_001c, S12_001g, S12_002_ja, S12_003_ja, S12_004, S12_005, S12_006, S12_007, S12_008, S12_009, S12_010, S12_011, S12_012, S12_013 他）
- 用途地域（XKT002）: 属性 15種（_id, _index, city_code, city_name, decision_classification, decision_date, decision_maker, first_decision_date, notice_number, notice_number_s, prefecture, u_building_coverage_ratio_ja, u_floor_area_ratio_ja, use_area_ja, youto_id）
- 洪水浸水想定区域（想定最大規模）（XKT026）: 属性 7種（A31a_201, A31a_202, A31a_203, A31a_204, A31a_205, _id, _index）
- 高潮浸水想定区域（XKT027）: 属性 6種（A49_001, A49_002, A49_003, _id, _index, target_year）
- 津波浸水想定（XKT028）: 属性 6種（A40_001, A40_002, A40_003, _id, _index, target_year）
- 土砂災害警戒区域（XKT029）: 圏内データなしのため属性未確認
- 小学校区（XKT004）: 属性 7種（A27_001, A27_002, A27_003, A27_004_ja, A27_005, _id, _index）

## 未確認事項

- 全候補: 避難所のペット受入条件・公園のペット同伴ルール（自治体一次情報。候補確定後に各自治体 中野区（東京都）・川口市（埼玉県）・市川市（千葉県） で確認）
- 全候補: Transitous の所要時間は非公式 GTFS ベース。確定候補は公式時刻表で目視確認
- 全候補: OSM の動物病院・公園は網羅性が地域差あり。一次情報（自治体・獣医師会）での補完確認

## 操作手順（本シートの再現方法）

1. APIキーを用意する（環境変数 `REINFOLIB_API_KEY` または `workers/.dev.vars`。ローカルサーバー起動中は `--relay http://localhost:8510` でも可）
2. `node tools/region-compare/compare.mjs` を実行する（候補変更は `--areas "名前:緯度:経度,…"`）
3. 出力された `out/comparison-sheet.md`（本表）・`out/areas.geojson`（候補地点＋半径円）・`out/region-compare.kasc`（各地域のカメラプリセット行）を確認する
4. 「地図で見る」リンクまたは .kasc の cam: 行で各地域へ移動し、reinfolib プラグインのレイヤー表示と本表の値を目視で照合する
5. 未確認項目は出典を確認してから「確認済み」に更新する（一次情報は自治体の案内を参照）

## 出典一覧

- 不動産情報ライブラリ（国土交通省） — XPT001・XGT001・XKT015・XKT002・XKT026/027/028/029・XKT004（2026-10-20 取得・API直接接続）
- Transitous（api.transitous.org・コミュニティ GTFS ベース。2026-10-20 取得）— https://transitous.org/sources ・© OpenStreetMap contributors
- OpenStreetMap（Overpass API・DB時点 2026-10-20）— © OpenStreetMap contributors（ODbL）
- 自治体一次情報 — 中野区（東京都）・川口市（埼玉県）・市川市（千葉県）（未確認。各自治体の防災計画・施設案内）
