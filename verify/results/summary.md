# feature-verify 実施証跡 2026-11-14 (v6.24.0)

## 静的検証
- `node --check` 全 web/*.js → エラー0
- `cargo check --all-targets` (server) → Finished 23.3s
- `python -m compileall` agent/tools/run*.py → エラー0

## server (実サーバ :8510 稼働中)
- GET系13ルート全て正常応答(200/適切な4xx)。SSRF防御: /api/fetch プライベート→403
- mutating実施: plugins save+delete往復, files PUT+DELETE往復, projects register+unregister, command push→poll, update/settings PUT
- bridge-hub :8511 — status/health/models/vector全系 live。vector/query→FeatureCollection, geojson実取得1.1MB。providers copilot/devin/antigravity全running
- qgis-live/discover → 200 no_live_session(QGIS未起動)

## web (Playwright chrome channel)
- cesium: kasugaiApi 96メソッド面・CHAT_TOOLS実呼出(安全な全ツール)・listUiControls 367件・session-state実書込み・plugin登録/解除・datafile保存/削除・プロジェクト切替往復
- 全6エンジン起動+レイヤ10件+getCamera実応答(gsimapsはvendor SW経由~15s)
- engineリダイレクト /?engine=leaflet → /leaflet/ +クエリ引継ぎ
- i18n: en=932キー・全8言語一致

## 自己修復
- web/cesium/geo-tools.js toCartesians: 非配列引数undefinedでTypeError → nullガード追加。
  修復後 lineOfSight{}/viewshed{} → {ok:false,reason} / 実引数で正常計算
- tools/publish_cdn.py: web/verify がCDNへ流出しないよう exclude に 'verify' 追加

## workers/functions/agent
- node mock-context: 23ケース PASS(token HMAC往復・認証・kasc KV・data R2・ゲート)
- agent FastAPI TestClient: mode6認証→token→kasc/data/Range206 全PASS

## 環境起因(非不具合)
- projects登録の import-test は死に登録 → unregister で掃除
- focusLayer「見つかりません」= レイヤーロード未完時のfalse(30s待機で全成功)
- switchProject の {name} 未展開 = args.projectId 未定義時の仕様(設計通り)
