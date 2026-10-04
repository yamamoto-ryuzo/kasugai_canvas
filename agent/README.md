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

## 起動制御モード（KASUGAI_AUTH_MODE）

`web/auth-methods.json` の `control` に対応する Cloud Run 側の認証方式。
設計の詳細は `agent/AUTH_MODES.md` を参照。

| 値 | モード | 内容 |
| --- | --- | --- |
| 未設定/0 | なし | 公開（現行動作）。`control` は web/ の静的ファイルのまま |
| `5` | 認証のみ | `/api/auth`・`/api/kasc`・`/api/data` をトークン保護。静的は公開 |
| `6` | 全ゲート | 5 + `kasugai_session` Cookie で全リクエストをゲート |
| `7` | IAP | `x-goog-iap-jwt-assertion` を検証（`gcloud run deploy --iap`） |

- `KASUGAI_AUTH_MODE` 設定時は `/auth-methods.json` を動的に返す
  （モード変更にイメージ再ビルドは不要）
- `.kasc`・`gs://` 秘匿データは GCS バケット（`kasc/<ID>`・`data/<key>`）に格納。
  バケット未設定時はローカルの `.datastore/` にフォールバック（開発用）
- 起動時に `web/projects/*/*.kasc` をストレージへ冪等シードする
  （`KASUGAI_SEED_KASC=0` で無効化。秘匿したい `.kasc` は静的配信から削除すること）
- 署名付き URL 方式（既定 `KASUGAI_DATA_REDIRECT=1`）を使うには、実行 SA に
  `roles/storage.objectAdmin`（バケット）と `roles/iam.serviceAccountTokenCreator`
  （自身・signBlob 用）を付与し `iamcredentials` API を有効化すること。
  またバケットに CORS 設定が必要（302 後はクロスオリジンになるため）。
  未整備の環境は `KASUGAI_DATA_REDIRECT=0` でコンテナ経由のプロキシ配信になる

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini API キー（AI Studio） |
| `GOOGLE_GENAI_USE_VERTEXAI=1` | Vertex AI 経由に切替（Cloud Run のサービスアカウントで認証） |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex AI のプロジェクト・リージョン |
| `ANTIGRAVITY_MODEL` | モデル名（既定 `gemini-2.5-flash`） |
| `ANTIGRAVITY_MOCK=1` | モック応答モード（Gemini 未接続で動作確認） |
| `ANTIGRAVITY_TOKEN` | 設定時 `Authorization: Bearer` を必須化（認証モード時は kasugai トークン/Cookie/IAP も有効） |
| `ANTIGRAVITY_RATE_LIMIT` | IPあたり時間当たりリクエスト上限（既定30・0で無効） |
| `ALLOW_ORIGINS` | 別オリジン配信時の CORS 許可（カンマ区切り） |
| `STATIC_DIR` | 静的配信する web/ の場所（省略時: リポジトリ直下 web/） |
| `KASUGAI_AUTH_MODE` | `5`/`6`/`7` で起動制御を有効化（上記） |
| `KASUGAI_AUTH_USER` / `KASUGAI_AUTH_PASS` | モード5/6 の ID/PASS（Secret Manager 推奨） |
| `KASUGAI_TOKEN_SECRET` | トークン署名鍵（未設定時は `KASUGAI_AUTH_PASS`） |
| `KASUGAI_GCS_BUCKET` | .kasc・秘匿データの格納バケット |
| `KASUGAI_LOCAL_STORE` | GCS 未設定時のローカルストア（省略時 `.datastore/`） |
| `KASUGAI_DATA_REDIRECT` | `0` で GET /api/data をプロキシ配信（既定 `1`=署名 URL へ 302） |
| `KASUGAI_SIGNED_URL_TTL` | 署名 URL 有効期限秒（既定 900） |
| `KASUGAI_IAP_AUDIENCE` | モード7 の IAP JWT audience。設定時は署名検証 |
| `KASUGAI_SEED_KASC` | `0` で起動時の .kasc シードを無効化 |

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
  --region asia-northeast1 --allow-unauthenticated --min-instances 1 \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=1,GOOGLE_CLOUD_PROJECT=PROJECT,GOOGLE_CLOUD_LOCATION=us-central1
```

`--min-instances 1` はフロントの `/health` 検出（1秒タイムアウト）がコールドスタートを
逃さないための推奨設定。

```bash
# 認証モード例（モード5 + GCS + Secret Manager のシークレット）
gcloud run deploy kasugai-canvas \
  --image asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas \
  --region asia-northeast1 --allow-unauthenticated --min-instances 1 \
  --set-env-vars KASUGAI_AUTH_MODE=5,KASUGAI_GCS_BUCKET=kasugai-data,GOOGLE_GENAI_USE_VERTEXAI=1,GOOGLE_CLOUD_PROJECT=PROJECT \
  --set-secrets KASUGAI_AUTH_USER=kasugai-auth-user:latest,KASUGAI_AUTH_PASS=kasugai-auth-pass:latest

# IAP モード（モード7。Google アカウントで全ゲート）
gcloud run deploy kasugai-canvas --image ... --iap
```

Vertex AI を使う場合は Cloud Run のサービスアカウントに `roles/aiplatform.user` を付与し、
プロジェクトで Vertex AI API を有効化すること。APIキー方式なら `GEMINI_API_KEY` を
Secret Manager 経由で `--set-secrets` に渡す。
