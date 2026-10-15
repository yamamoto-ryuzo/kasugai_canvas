# agent/ — KASUGAI Canvas Cloud Run サービス（FastAPI）

Cloud Run への配布・公開用サービス。`web/` の静的配信・認証・GCS 永続化に加え、
内蔵AI（ブラウザ）向けの薄いキー隠蔽プロキシを提供する。
**エージェント実装は持たない** — 推論ループ・地図操作はすべてブラウザ側。
サーバー側エージェント（旧 `POST /agent/chat`）は廃止。外部エージェントを繋ぐ場合は
フロントの「エージェント」設定にエンドポイントURLを手動設定する。

- `POST /api/gemini` : 内蔵AI向けキー隠蔽プロキシ。ブラウザの generateContent リクエスト `{contents, systemInstruction?, tools?, generationConfig?, model?}` にサーバーキーを注入して Gemini へ転送するだけ（推論ループ・地図操作はブラウザ側）。`model` は必須（BYO キーが無いユーザーでも内蔵AIが使えるようになる）
- `POST /api/auth` / `POST /api/kasc` / `GET|PUT /api/data/*` : 起動制御・.kasc 保存・秘匿データ配信（Cloudflare `functions/` と同一契約）
- `GET /api/capabilities` : `{tier:"cloudrun", features:["aiProxy"...], ai:{endpoint:"/api/gemini"}}`（フロントの能力通知用。`aiProxy` は `GEMINI_API_KEY` 設定時のみ）
- `GET /health` : 起動確認
- `/` : `web/` の静的配信（同一オリジン運用・URL 1本・CORS 不要）

## キー方式

- **BYO（Bring Your Own）キー**: ユーザーがブラウザの `localStorage`（`googleApiKey`）に
  登録した自分のキーで、ブラウザから Gemini を直接呼ぶ。サーバーには送信されない。
  この場合 `/api/gemini` は使われない
- **サーバーキー**: `GEMINI_API_KEY` を環境変数/Secret Manager に設定すると
  capabilities が `aiProxy` を通知し、キー未設定の訪問者でも内蔵AIが使える。
  キーはブラウザに一切現れない

## ローカル実行

```bash
pip install -r agent/requirements.txt

# Gemini API キー（AI Studio）
set GEMINI_API_KEY=...
uvicorn agent.app.main:app --port 8080
```

`http://localhost:8080` で KASUGAI Canvas 本体が開く。

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
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini API キー（AI Studio）。`/api/gemini` で使用 |
| `KASUGAI_AI_INSTRUCTIONS` | Cloud Run 管理の内蔵AI追加指示。`GEMINI_API_KEY` と併せて設定すると、ブラウザ保存値やBYOキーより優先し、サーバープロキシ経由で適用 |
| `GOOGLE_MAPS_API_KEY` | Maps Platform キー（Map Tiles/Places/Geocoding/SV）。設定時 `/api/capabilities` がブラウザへ通知し未保存時に自動登録。秘匿情報ではないため保護は GCP のリファラ制限で行う |
| `GEMINI_MODELS` | `/api/gemini` で許可するモデル（カンマ区切り。未設定は全許可） |
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

リポジトリ直下の `run-cloudrun.py` で一連の手順を自動化できる（Cloud Shell・ローカル SDK のどちらでも可。ローカルの Docker は不要で、ビルドは Cloud Build に投げる）:

```bash
# 最小構成（静的配信 + /api/gemini キー隠蔽プロキシ）
python run-cloudrun.py --gemini-api-key YOUR_KEY

# サーバー側の追加指示を設定（--gemini-api-key と同時に使用）
python run-cloudrun.py --gemini-api-key YOUR_KEY --ai-instructions "指示文"

# 認証モード5 + GCS 保存 + キーレスAI
python run-cloudrun.py --gemini-api-key YOUR_KEY \
    --auth-mode 5 --auth-user ID --auth-pass PASS --bucket kasugai-data
```

初回デプロイで非秘密の設定が `kasugai_canvas.cloudrun.json`（gitignore）に保存されるため、2回目以降は引数なしの `python run-cloudrun.py`（または `python run.py --cloudrun`）で再デプロイできる。シークレットは Secret Manager の既存登録を再利用する。

`agent/cloudrun.kasc` があれば、デプロイ時に `gs://<bucket>/kasc/default` へアップロードされ、Cloud Run 版だけ `web/projects/` と別の初期 .kasc で動く（起動時シードは既存オブジェクトを上書きしないため維持される）。`--kasc FILE` で差し替え、`--kasc PROJ:FILE` でプロジェクト指定、`--kasc none` で無効化。

手動で行う場合の手順は以下。

```bash
# Artifact Registry（初回のみ）
gcloud artifacts repositories create kasugai --repository-format=docker --location=asia-northeast1

# ビルド＆プッシュ（コンテキストはリポジトリ直下）
docker build -f agent/Dockerfile -t asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas .
docker push asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas

# デプロイ（サーバーキーでキーレスAIを提供する例）
gcloud run deploy kasugai-canvas \
  --image asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas \
  --region asia-northeast1 --allow-unauthenticated --min-instances 0 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

`--min-instances 0`（スケールトゥゼロ）で非アクセス時の課金を止める（既定）。
コールドスタート後の初回ページ表示に数秒かかるが、フロントの `/health` 検出は
失敗時リトライするため検出漏れはしない。審査・公開期間中など常時即応答にしたい
期間だけ `python run-cloudrun.py --min-instances 1`（または
`gcloud run services update kasugai-canvas --min-instances=1`）で常駐化し、
終了後に 0 へ戻す（アイドル料金が継続発生）。
サーバーキーを置かない BYO 運用なら `GEMINI_API_KEY` は不要。
無認証で公開する場合は `ANTIGRAVITY_TOKEN`・`ANTIGRAVITY_RATE_LIMIT`・`GEMINI_MODELS`
での乱用対策を検討すること（`/api/gemini` は任意の generateContent を転送するため）。

```bash
# 認証モード例（モード5 + GCS + Secret Manager のシークレット）
gcloud run deploy kasugai-canvas \
  --image asia-northeast1-docker.pkg.dev/PROJECT/kasugai/kasugai-canvas \
  --region asia-northeast1 --allow-unauthenticated --min-instances 0 \
  --set-env-vars KASUGAI_AUTH_MODE=5,KASUGAI_GCS_BUCKET=kasugai-data \
  --set-secrets KASUGAI_AUTH_USER=kasugai-auth-user:latest,KASUGAI_AUTH_PASS=kasugai-auth-pass:latest,GEMINI_API_KEY=gemini-api-key:latest

# IAP モード（モード7。Google アカウントで全ゲート）
gcloud run deploy kasugai-canvas --image ... --iap
```
