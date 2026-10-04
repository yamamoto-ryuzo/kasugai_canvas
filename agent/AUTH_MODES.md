# Cloud Run 起動制御設計（control=5〜）

Cloud Run への認証・保護機構の設計。**control=5/6/7 は実装済み**
（`agent/app/auth.py`・`storage.py`・`main.py` の各エンドポイント、
`web/PLUGIN/auth-cloudrun`・`auth-iap`）。Cloudflare 契約の機械的な移植はせず、
Cloud Run の作法を優先しつつ、実装・運用負荷の軽い順にモードを並べる。

## 設計方針（Cloud Run らしさ）

- **保護対象は API とデータ**。`web/` の静的ファイルは公開リポジトリのコードであり
  秘匿しても意味が薄い。本当に守るべきは `/agent/chat`（Gemini 課金）と
  `.kasc`/`gs://` データ
- **ゲートは必要な範囲だけに**。API 単位のトークン検証で足りるなら
  全リクエストのミドルウェアゲートは後回し
- **データはコンテナを通さない**: GCS の V4 署名付き URL でブラウザ⇄GCS 直接転送
  （署名が使えない環境はプロキシにフォールバック）
- **秘匿情報は Secret Manager、権限はサービスアカウントの IAM**
- **セッションはステートレス**: HMAC 署名付き自己完結型。アフィニティ不要

## モード一覧

| control | モード | 保護範囲 | 実装負荷 | 用途 |
| --- | --- | --- | --- | --- |
| 5 | `cloudrun`（認証のみ） | `/api/*` とデータのみ | **最小** | 公開アプリ＋秘匿データ・設定 |
| 6 | `cloudrun-gate`（全ゲート） | 全リクエスト | 5 + ミドルウェア分 | デプロイ自体を到達不可にしたい場合 |
| 7 | `cloudrun-iap` | 全リクエスト（IAP） | 認証コードほぼゼロ | Google アカウント運用できる組織内 |
| 0（既存） | none | なし（公開＋rate limit） | — | 審査用公開デモ・現行構成 |

### 認証のみ（5）を残す理由

「静的をゲートできない Cloudflare の制約の産物」と一度は廃番にしたが、
ユーザー視点では有用:

- アプリのURLは広く共有できる（コードは公開済み）が、設定・データは
  ログイン者だけ。`web/` が公開リポジトリである以上、静的ファイルを秘匿する
  全保護の付加価値はこのプロジェクトでは小さい
- **実装負荷は全保護より軽い**: 3エンドポイントのトークン検証だけでよく、
  ミドルウェア・公開ホワイトリスト・Cookie 発行が不要
- 運用も軽い: ログイン失敗時に 401 の素画面ではなく、ちゃんとした
  ログイン画面が出る（全保護と同じ UX が公開アセットから実現できる）

全保護（6）が意味を持つのは「改造版 `web/` を秘匿したい」「デプロイ自体の
存在を隠したい」等の特殊ケース。

## モード5 = cloudrun（認証のみ）

`/api/*` 系エンドポイントが各自で HMAC トークンを検証する最小構成。
ミドルウェア不要。

- `POST /api/auth` `{user, pass}` → `{ok, token, kasc:{ID:本文}}`
  - `KASUGAI_AUTH_USER`/`KASUGAI_AUTH_PASS` 照合
  - `.kasc` は GCS の `kasc/<ID>` から収集して返却
  - トークンは `expiry.HMAC-SHA256(expiry)`（`functions/_lib/token.js` と同型。
    Python `hmac` で完全互換生成・`compare_digest` で検証）
- `POST /api/kasc` `{token, project, text}` → `kasc/<project>` を GCS 書き込み
- `GET /api/data/<key>?token=` → トークン検証 → **V4 署名付き URL へ 302（既定）**
  - 検証後の署名 URL 自体がベアラ資格情報になり、連鎖は健全
  - `KASUGAI_DATA_REDIRECT=0` でプロキシ配信（Range パススルー・ローカル開発用）
- `PUT /api/data/<key>?token=` → プロキシ書き込み（GCS put）
  - フロントが直接 PUT する既存経路（`app.js:4192`・ルート高度保存）を維持
  - Cloud Run リクエスト上限 32MiB（現用途は小さい JSON）
- `/agent/chat` は `ANTIGRAVITY_TOKEN` Bearer or kasugai トークン併用

フロント: `PLUGIN/auth-cloudrun/auth.js`（`auth-cloudflare` とほぼ同型）。
`gs://<キー>` → `/api/data/<キー>?token=` の rewrite/restore を持ち、
`serverKasc: true` を返す。

### `gs://` 記法

`.kasc` 内で `gs://<キー>` と書いたレイヤーが `/api/data/<キー>` 経由で配信される。
`r2://` の GCP 版（`r2://` も読み替え対象にしておくと移行が楽）。

## モード6 = cloudrun-gate（全ゲート）

5 の構成に加え、ミドルウェアで `kasugai_session` Cookie
（`HttpOnly; Secure; SameSite=Strict`・12h・内容はモード5と同じ HMAC トークン）を
全パスに要求する。

- `/api/auth` 成功時に `Set-Cookie` も発行（レスポンスの token も返す）
- **ゲート対象外**: ログイン描画に必要な静的ファイル
  （`/`・`/index.html`・`/styles.css`・`/favicon.ico`・`/auth-selector.js`・
  `/auth-login-form.js`・`/auth-methods.json`・`/i18n.js`・`/i18n/`・`/PLUGIN/auth-*`）
  と、自身でトークン検証する `/api/auth`・`/api/kasc`・`/api/data/*`・`/health`
- `/api/*` はトークン検証を残したまま Cookie も受け付ける
  （`verify_request()` を Cookie or token 両対応にすれば1コードパスで済む）
- `/agent/chat` も同じ認可で統一

## モード7 = cloudrun-iap

`gcloud run deploy --iap` で直接有効化（LB 不要・`run.app` も保護・追加料金なし）。
認証を Google インフラに完全委譲。

- 未認証は Google ログインへリダイレクト。認証済みには
  `x-goog-iap-jwt-assertion`（署名 JWT）が付く。アプリは JWT を検証して識別
- 許可ユーザーは `roles/iap.httpsResourceAccessor` で管理
- `.kasc`・静的ファイルは IAP 内側にあるだけで秘匿済み（GCS 機構は編集保存したい場合のみ）
- `/api/*` の認可は IAP JWT を検証（モード5/6 の HMAC と併用可）
- フロント: `PLUGIN/auth-iap/auth.js`（サイレント。ログイン画面を出さず
  auth オブジェクトを即返す）

## サービス間呼び出し（番号外）

`POST /agent/chat` をブラウザ以外から叩く場合は
`--no-allow-unauthenticated` + 呼び出し側 ID トークン（`roles/run.invoker`）が
Cloud Run の作法。control 番号とは別軸のデプロイオプション。

## ストレージ・環境変数・権限

```
gs://<KASUGAI_GCS_BUCKET>/
  kasc/<projectId>   # .kasc 本文
  data/<key>         # gs:// で参照される秘匿データ
```

| 変数・設定 | 用途 |
| --- | --- |
| `KASUGAI_AUTH_MODE` | control 値を環境変数で指定（`/auth-methods.json` を動的応答・再ビルド不要） |
| `KASUGAI_AUTH_USER` / `KASUGAI_AUTH_PASS` | モード5/6 の ID/PASS（Secret Manager） |
| `KASUGAI_TOKEN_SECRET` | トークン署名鍵（未設定時 `KASUGAI_AUTH_PASS`） |
| `KASUGAI_GCS_BUCKET` | kasc/data バケット |
| `KASUGAI_DATA_REDIRECT` | `0` でプロキシ配信（既定 `1`=署名 URL） |
| `KASUGAI_SIGNED_URL_TTL` | 署名 URL 有効期限（既定 15分） |
| `KASUGAI_IAP_AUDIENCE` | モード7 の IAP JWT audience（設定時は署名検証） |
| `KASUGAI_SEED_KASC` | `0` で起動時の `.kasc` 冪等シードを無効化 |
| `KASUGAI_LOCAL_STORE` | GCS 未設定時のローカルストア（省略時 `.datastore/`） |

実行サービスアカウント権限: `roles/storage.objectAdmin`（対象バケット）・
`roles/iam.serviceAccountTokenCreator`（自身に付与・signBlob 用）・
`iamcredentials.googleapis.com` API 有効化。

バケット CORS（302 後はクロスオリジンになるため必須）:

```bash
gcloud storage buckets update gs://BUCKET --cors-file=cors.json
# cors.json: [{"origin":["https://<app>"], "method":["GET","PUT"],
#              "responseHeader":["Content-Type","Content-Range","ETag"], "maxAgeSeconds":3600}]
```

`.kasc` のシードは `gcloud storage cp web/projects/*/*.kasc gs://BUCKET/kasc/` を
デプロイ手順に組み込むか、起動時に同梱ファイルから冪等シード。

## フロント変更点

1. **`method === "cloudflare"` ハードコード3箇所の解消**
   （`app.js:518`・`:540`・`:6524`）→ `window.kasugaiAuth?.serverKasc` 判定。
   `auth-cloudflare` にも同フラグを追加
2. **`controlMap` 追加**（`auth-selector.js`）: 5/6 → `auth-cloudrun`、7 → `auth-iap`
3. **`gs://` rewrite/restore** は `auth-cloudrun`/`auth-iap` プラグイン内に実装
   （`auth-cloudflare` の `r2://` と同じ構造。`?token=` はモード5で必要・6/7 では不要）
4. PUT は当面 `/api/data?token=` 直接のまま（モード5/6 共通で動く）。
   署名 URL 直 PUT 化は必要になった段階で `auth.saveData()` フックとして追加

## Cloud Run 制約の検証結果

- **IAP**: `--iap` で直接有効化可・LB 不要。モード7のハードルは低い
- **Cloud Armor**: 外部 HTTPS LB + サーバーレス NEG 必須で run.app 直では不可。
  レート制限はアプリ内ベストエフォート＋`--max-instances` でコスト抑制
- **署名付き URL**: signBlob 権限（上記 SA 設定）＋バケット CORS が前提。
  未整備環境は `KASUGAI_DATA_REDIRECT=0` でプロキシに逃げられる
- **リクエスト上限 32MiB**: proxy PUT の上限。現用途は問題なし
- **コールドスタート**: `/health` 検出は1秒タイムアウト。公開環境は `--min-instances 1` 推奨
- **ローカル開発**: `KASUGAI_GCS_BUCKET` 未設定時はローカルディレクトリへ
  フォールバック、または `fake-gcs-server`

## `/api/capabilities` 拡張

```json
{"tier":"cloudrun","features":["agent","auth","kascWrite","dataStore"],
 "auth":{"mode":"token|cookie|iap"},"agent":{"endpoint":"/agent/chat"}}
```

## 実装状況

- 実装済み: `serverKasc` フラグ化（app.js 3箇所＋auth-cloudflare）・モード5/6/7
  （`/api/auth`・`/api/kasc`・`/api/data`・Cookie ゲート・IAP JWT・起動シード・
  `KASUGAI_AUTH_MODE` による `/auth-methods.json` 動的化）・`auth-cloudrun`/`auth-iap` プラグイン
- 検証済み（ローカル・LocalStore）: トークン発行・kasc 往復・data PUT/GET・Range(206)・
  未認証 401・モード6 Cookie ゲート・モード7 IAP ヘッダ・`/agent/chat` 認可統合・
  Playwright でのログイン→起動→/api/kasc 保存
- 未検証（要 GCP 環境）: GCS 本番接続・署名付き URL（signBlob 権限）・実 IAP
- 後回し: 署名 URL 直 PUT（`saveData` フック）・SSE エージェント・Cloud Armor（LB 要）
