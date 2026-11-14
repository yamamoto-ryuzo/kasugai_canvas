# kasugai_canvas — コンポーネント間連携 ロジックシート

生成: 2026-11-14

## トポロジ（全体）
```mermaid
flowchart TB
  qgis[QGIS geo_webview] -->|.kasc+DATA/ register /live/*| web[web/ 6エンジン]
  web --> srv[server :8510]
  srv --> hub[bridge-hub :8511]
  srv --> rcl[rclone cloud]
  hub --> cli[copilot/devin/antigravity CLI]
  web -->|CDN配信| cdn[kasugai-canvas-web]
  tools[publish_cdn.py] --> cdn
  cdn -->|kasc=| data[kasugai_canvas_webGIS データホスト]
  agent[Cloud Run agent] --> gcs[GCS]
  workers[CF Workers] --> kv[KV/R2]
  box[kasugai_box] --> web
```

## コンポーネント

- **server** — Rust Axum サーバ(kasugai_canvas.exe :8510 + bridge-hub :8511): pass=42 fail=0 skip=20 (62機能)
- **web** — 静的Webフロント(6エンジン + shared + AI制御面): pass=220 fail=0 skip=12 (232機能)
- **workers** — Cloudflare Workers(認証ゲート+API): pass=10 fail=0 skip=0 (10機能)
- **functions** — Cloudflare Pages Functions(APIハンドラ群): pass=9 fail=0 skip=0 (9機能)
- **agent** — Cloud Run 用 FastAPI エージェント: pass=15 fail=0 skip=0 (15機能)
- **tools** — Python CLI ツール群: pass=7 fail=0 skip=1 (8機能)