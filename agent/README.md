# agent/ — ANTIGRAVITY エージェント API（Cloud Run）

ハッカソン出展用のエージェントサービス。FastAPI + Gemini API（google-genai）で、
フロントエンド実装済みの**外部エージェントプロトコル**をそのまま実装する。

- `POST /agent/chat` : `{message, project, camera, layers, history}` → `{reply, actions:[{name,args}], report?, serverTools?}`
- `GET /api/capabilities` : `{tier:"cloudrun", features:["agent"]}`（フロントの能力通知用）
- `GET /health` : 起動確認
- `/` : `web/` の静的配信（同一オリジン運用・提出URL 1本・CORS 不要）

## 動作構成

1. function calling ループでサーバーツール（`fetch_url` / `generate_sample_geojson`）を自律実行
2. `response_schema` 構造化出力で `{reply, actions, report}` を生成
   - `actions` は `addDataLayer`/`flyTo`/`showReport` 等の既存フロントツール名（公開環境向けにホワイトリスト制）
   - `report` は「平面・内容・解決案」構成の Markdown/HTML 資料（視点パーマリンク埋め込み）

## ローカル実行

```bash
pip install -r agent/requirements.txt

# モックモード（APIキー不要・フロント開発用）
set ANTIGRAVITY_MOCK=1
uvicorn agent.app.main:app --port 8080

# Gemini API キー（AI Studio）
set GEMINI_API_KEY=...
uvicorn agent.app.main:app --port 8080
```

`http://localhost:8080` で KASUGAI Canvas 本体が開き、`/agent/chat` にエージェントが同居する。

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini API キー（AI Studio） |
| `GOOGLE_GENAI_USE_VERTEXAI=1` | Vertex AI 経由に切替（Cloud Run のサービスアカウントで認証） |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex AI のプロジェクト・リージョン |
| `ANTIGRAVITY_MODEL` | モデル名（既定 `gemini-2.5-flash`） |
| `ANTIGRAVITY_MOCK=1` | モック応答モード（Gemini 未接続で動作確認） |
| `ANTIGRAVITY_TOKEN` | 設定時 `Authorization: Bearer` を必須化 |
| `ANTIGRAVITY_RATE_LIMIT` | IPあたり時間当たりリクエスト上限（既定30・0で無効） |
| `ALLOW_ORIGINS` | 別オリジン配信時の CORS 許可（カンマ区切り） |
| `STATIC_DIR` | 静的配信する web/ の場所（省略時: リポジトリ直下 web/） |

## Cloud Run デプロイ

```bash
# Artifact Registry（初回のみ）
gcloud artifacts repositories create kasugai --repository-format=docker --location=asia-northeast1

# ビルド＆プッシュ（コンテキストはリポジトリ直下）
docker build -f agent/Dockerfile -t asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas .
docker push asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas

# デプロイ（Vertex AI で Gemini を呼ぶ構成・キー管理不要）
gcloud run deploy kasugai-canvas \
  --image asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas \
  --region asia-northeast1 --allow-unauthenticated \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=1,GOOGLE_CLOUD_PROJECT=PROJECT,GOOGLE_CLOUD_LOCATION=us-central1
```

Vertex AI を使う場合は Cloud Run のサービスアカウントに `roles/aiplatform.user` を付与し、
プロジェクトで Vertex AI API を有効化すること。APIキー方式なら `GEMINI_API_KEY` を
Secret Manager 経由で `--set-secrets` に渡す。
