# bridge-hub — KASUGAI Canvas ブリッジハブ（ブラウザ WebGIS 用）

ローカルに常駐させるブリッジを **1本（127.0.0.1）に集約**するハブです。
**Rust 製の単一 exe（`bridge-hub.exe`）で、Node.js は不要**です。
アプリ版（kasugai_canvas.exe）と同じ `server/src/bridge/` 実装を使い、
Copilot / Devin / Antigravity の各プロバイダは実際に使われた時点で
外部 CLI を子プロセスとして遅延起動します。

## エージェント連携は双方向

このハブは「ブラウザ → エージェント」方向だけを担います。逆方向は別経路です:

- **ブラウザ → エージェント**（チャットから AI を使う）… 本ハブ（`/agent`・`/models`）
- **エージェント → ブラウザ**（外から地図を操る）… アプリ本体（`127.0.0.1:8510`）の `/api/command`。Devin Desktop・Copilot CLI・任意スクリプトが `{"name":"flyTo","args":{...}}` を投入すると、ブラウザがロングポーリングで受信して `executeChatTool` で実行します

## 動作

- `GET /health` — ハブ自身の状態（`providers.<名>.available/running`・`active`）
- `GET /models?provider=<copilot|devin|antigravity>` — 対象プロバイダの `/models`
- `POST /agent` — ボディの `provider` フィールドでプロバイダを選択・起動
- `POST /mcp[/<project>]` — 地図ツールの MCP 公開（devin/agy から呼ばれる）

ブラウザから設定するエンドポイントは `http://127.0.0.1:<port>/agent` です。

## ブラウザ WebGIS での利用（アプリ版なし）

アプリ版（kasugai_canvas.exe）を持たない環境でも、本ハブを起動しておけば
CDN ホスト版・静的配信の Canvas から同じようにブリッジ系プロバイダが使えます。
フロントは 127.0.0.1 のハブ `/health`（8512 → 8511 の順）を疎通し、`hub:true`
が返れば capabilities 通知が無くても「【ブリッジ】GitHub Copilot」等の
選択肢を出します（接続は全てローカルへ。公開デプロイからも localhost への
http は許可）。

前提: **実行環境は何も不要（単一 exe）**。ただし使うプロバイダの CLI と
本人の認証は別途必要です（例: Copilot なら `copilot` CLI＋Copilot 契約、
Devin なら `devin` CLI、Antigravity なら `agy` CLI＋Google ログイン）。

```
# 手動起動（コンソール非表示・ダブルクリックでも可。ブラウザ WebGIS 用既定ポート 8512）
run-hidden.vbs

# ログイン時自動起動の登録 / 解除（常駐させたい場合・ポート 8512）
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

# 手動起動（コンソール表示あり・既定 8511。環境変数で変更可）
bridge-hub.exe
```

**アプリ版との併用**: アプリのハブは 8511 を占有し、起動時に占有者が
ブリッジなら強制停止して置き換えます。ブラウザ WebGIS 用常駐の既定ポートは
**8512**（`run-hidden.vbs`/`install-autostart.ps1` が `BRIDGE_HUB_PORT=8512`
を設定）で、新版アプリは旧ブリッジ掃除（8512/8513）の際に `hub:true` の
ハブを潰さないよう除外するため**同時稼働できます**。
**注意**: この除外は新版アプリの動作のため、旧版アプリ（リリース済み）は
8512 のハブを旧ブリッジとして落とします。`bridge-hub.exe` を素のまま
起動すると既定 8511 なので、併用時は `BRIDGE_HUB_PORT=8512` を指定してください。

停止だけしたい場合は、このフォルダの `bridge-hub.exe` を実行中のプロセスを
終了してください（`uninstall-autostart.ps1` は自動起動解除＋停止を行います）。

## プロバイダ別の前提と利用条件（必読）

いずれのブリッジも公式連携ではなく、公開インターフェースを使った
サードパーティ製クライアントです。各サービスの利用規約に沿うため、
**ローカル・本人利用限定**で使ってください（127.0.0.1 にのみバインド。
自分のアカウントで他者のチャットを処理する形態は禁止）。

| プロバイダ | 必要なもの | 認証 |
|---|---|---|
| GitHub Copilot | `copilot` CLI（npm 版は Node.js も必要）＋Copilot 契約（Free〜Enterprise いずれのプランでも可） | `copilot` CLI で対話ログイン済み、または `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| Devin | `devin` CLI（Devin Desktop 同梱の `devin.exe` または単体インストール。`DEVIN_CLI_PATH` で指定可）＋本人の Devin プラン | サービスユーザー APIキー（`cog_`、app.devin.ai → Settings → Devin API → Service users・ロール Member。`DEVIN_API_KEY` またはアプリ設定画面。PAT は拒否）または初回接続時のブラウザ PKCE ログイン |
| Antigravity | `agy` CLI（Antigravity のインストールに含まれる `agy.exe`。`AGY_CLI_PATH` で指定可） | 利用者自身の Google アカウントでの `agy` ログイン（一度対話起動してサインイン） |

- Copilot: プレミアムリクエストの quota（AI クレジット）を消費。Free プランはモデル自動選択のみ
- Devin: 消費されるのは利用者自身の quota。ローカル CLI のログイン資格は ACP モードでは使われない
- Antigravity: ブリッジが `agy mcp add kasugai` で地図ツールを MCP 登録し、`~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に `mcp(kasugai/*)` を追加（headless では未許可ツールが自動拒否されるため必須）。ファイル書込み・シェル実行等の内蔵ツールは利用者が自分で許可ルールを足さない限り拒否され、作業ディレクトリも空の `%TEMP%/kasugai-antigravity-bridge` に限定される

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `BRIDGE_HUB_PORT` | `8511` | ハブの待受ポート（127.0.0.1 のみバインド）。アプリ本体（kasugai_canvas.exe）起動時にも同じ環境変数が読まれ、待受ポート・占有チェック・`/api/capabilities` の通知エンドポイントがすべてこのポートに揃う。ブラウザ WebGIS 用同梱スクリプトは `8512` を設定する |
| `KASUGAI_NO_COPILOT_BRIDGE` | なし | copilot プロバイダを無効化 |
| `KASUGAI_NO_DEVIN_BRIDGE` | なし | devin プロバイダを無効化 |
| `KASUGAI_NO_ANTIGRAVITY_BRIDGE` | なし | antigravity プロバイダを無効化 |

各プロバイダ固有の環境変数（`DEVIN_API_KEY`・`COPILOT_CLI_PATH`・
`*_BRIDGE_TOKEN` 等）はアプリ版と同じものがそのまま使えます。
