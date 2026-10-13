# KASUGAI Antigravity Bridge

KASUGAI Canvas の AI チャットを **Google Antigravity（Antigravity CLI / `agy`）** で動かすためのローカルブリッジです。
アプリの「外部エージェント」接続口と `agy` の headless 実行（`--input-format stream-json` / `--output-format stream-json`）の間を翻訳します。

```
ブラウザ (KASUGAI Canvas)                    ローカル
  チャット入力 ──POST /agent──→  antigravity-bridge ──stream-json(stdio)──→ agy -p ──→ Antigravity
  ←── {reply, actions} ──          │                                  （利用者自身の Google アカウントの quota を消費）
  actions をチャットツールとして実行   └─ /mcp で MCP サーバーを兼ね、地図ツールを agy へ注入
```

## 動作の仕組み

- アプリはチャット入力を `POST /agent` に `{message, project, camera, layers, history, tools, model?}` で送ります（`tools` は現在ユーザーに公開されている地図操作ツールの宣言）。
- ブリッジは起動時に `agy mcp add kasugai http://127.0.0.1:<port>/mcp` でブリッジ自身の MCP エンドポイントを agy のグローバル設定へ登録し、`~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に `mcp(kasugai/*)` を追加します（headless モードは確認プロンプトを出せないため、未許可のツール呼び出しは自動拒否されます）。
- MCP 登録はグローバル設定1本のため、別ポートのブリッジ（別インスタンスの単体起動等）が上書きし得ます。`/agent` ごとに `~/.gemini/config/mcp_config.json` の登録URLを検査し、自分のポートと違えばその場で再登録します。また agy は会話開始時の URL に紐付き続けるため、古い登録URLで作られた会話の再開は接続拒否になり得ます — ターン中に `/mcp` へ一切届かずツール失敗・接続エラー系の応答が見えた場合は、その会話を破棄して新規会話で一度だけ再試行します（自己修復）。
- メッセージごとに `agy` を子プロセスとして起動し、プロンプトを stdin（`{"event":"user",...}` 形式の NDJSON）で渡します。会話の継続は `--conversation <id>` で agy 側の会話ストアを使い、プロジェクトごとに会話 ID を保持します。再開に失敗した場合は新規会話で一度だけ再試行します。
- agy が `call_mcp_tool` で地図ツールを呼ぶと MCP の `tools/call` が届き、呼び出しを `actions` として収集してスタブ結果を返します。`result` イベントが返った時点で `{reply, actions}` をアプリへ返し、ブラウザ側が actions を順次実行します。破壊的操作（`savePlugin`・`publishPlugin`・`deleteDataFile` 等）はアプリ側の既存確認ダイアログで保護されます。
- `listLayers` / `getCamera` だけはリクエスト同梱の現在状態から実値を返します。
- 権限は「`mcp(kasugai/*)` だけを許可ルールへ追加・それ以外は追加しない」で制御します。ファイル書き込み・シェル実行等の内蔵ツールは、利用者が自分で `permissions.allow` に許可ルールを足さない限り headless で自動拒否されます。作業ディレクトリも空の `%TEMP%/kasugai-antigravity-bridge` に限定しています。

## 利用条件（必読）

このブリッジは Google 公式の連携ではなく、公開インターフェース（agy CLI の headless モード・MCP 設定）を使ったサードパーティ製クライアントです。Google の利用規約に沿うため、以下の条件でのみ利用してください。

1. **ローカル・本人利用限定** — 127.0.0.1 にのみバインドします。ブリッジを公開サーバーへ置いたり、**自分のアカウントで他者のチャットを処理する形態は禁止**です（アカウント共有・サービスの第三者提供・再販に該当し得ます）。
2. **利用者本人の Antigravity ログインが必要** — ブリッジ自体は認証情報を持たず、起動したマシン上の `agy` ログイン（`agy` を一度対話起動して Google アカウントでサインイン）を各ユーザー自身で行います。消費されるのは利用者自身の quota です。
3. **Antigravity CLI（`agy`）が必要** — Antigravity のインストールに含まれる `agy.exe` または単体インストールの `agy` が見つかること。見つからない場合は `AGY_CLI_PATH` で指定してください。

## アプリ版との連携（ブリッジハブ経由・ポート 8511）

アプリ版（kasugai_canvas.exe）は起動時に**ブリッジハブ**（`bridge-hub/`）を `127.0.0.1:8511` で起動し、ハブがプロバイダ「Antigravity」が選択されたときだけ本ブリッジを内部ポートで**子プロセスとして遅延起動**します。プロバイダ切替時は前のブリッジが停止され、常時最大1本だけが動きます。アプリ終了時にはハブごと停止します。

- `GET /api/capabilities` が `antigravity.endpoint`（ハブの `http://127.0.0.1:8511/agent`）と features `antigravityBridge` を通知します。フロントの AI プロバイダ選択肢「Antigravity」は**この feature 通知がある環境（=アプリ版）でのみ表示**されます
- `agy mcp add` で登録する `kasugai` MCP サーバーの URL は本ブリッジの待受ポートを指すため、ハブの子プロセスとして内部ポートで動いている場合も agy はブリッジへ直接接続します
- 無効化: 環境変数 `KASUGAI_NO_ANTIGRAVITY_BRIDGE` を設定してアプリを起動
- `ANTIGRAVITY_BRIDGE_TOKEN`・`ANTIGRAVITY_BRIDGE_MODEL` 等はアプリ起動環境から子プロセスへ継承されます

## 使い方（単体起動・開発/デバッグ用）

通常はアプリ版のブリッジハブ経由で自動起動されるため手動起動は不要です。開発・デバッグ用に単体で起動する場合:

```bash
cd antigravity-bridge
npm start
# → [bridge] listening: http://127.0.0.1:8791/agent
```

依存パッケージはありません（Node.js 標準ライブラリのみ。`npm install` 不要）。

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `ANTIGRAVITY_BRIDGE_PORT` | `8791` | 待受ポート（127.0.0.1 のみバインド） |
| `ANTIGRAVITY_BRIDGE_MODEL` | なし | agy の既定モデル（アプリ側のモデル選択で上書き。`agy models` の slug を指定） |
| `ANTIGRAVITY_BRIDGE_EFFORT` | なし | agy `--effort`（`low`/`medium`/`high`） |
| `ANTIGRAVITY_BRIDGE_TOKEN` | なし | 設定すると `Authorization: Bearer <token>` を必須化（アプリ側「トークン」欄と合わせる） |
| `ANTIGRAVITY_BRIDGE_TIMEOUT_MS` | `110000` | agy 応答の待機上限（アプリ側の中断は120秒） |
| `ANTIGRAVITY_BRIDGE_MCP_NAME` | `kasugai` | agy に登録する MCP サーバー名（権限ルール `mcp(<name>/*)` と対応） |
| `ANTIGRAVITY_BRIDGE_NO_MCP_REGISTER` | なし | 設定すると `agy mcp add` による自動登録を行わない |
| `ANTIGRAVITY_BRIDGE_NO_SETTINGS_PATCH` | なし | 設定すると `permissions.allow` への `mcp(kasugai/*)` 追加を行わない |
| `ANTIGRAVITY_BRIDGE_DEBUG` | なし | 設定すると agy のツール呼び出し等を詳細ログ出力 |
| `AGY_CLI_PATH` | 自動探索 | `agy` バイナリのパス（PATH・`%LOCALAPPDATA%\agy\bin\agy.exe` 等を順に探索） |

## 注意・制限

- **ローカル専用の機能**です（上記「利用条件」参照）。公開デプロイで全ユーザーに提供するものではありません。
- Copilot/Devin ブリッジと同じく、ツール呼び出しは「キュー→一括実行」方式のため、参照系ツール（`listLayers`/`getCamera` 以外）の実結果を見て次の操作を決める往復はできません。
- agy はコーディングエージェントです。headless モードでは許可ルールが無いツールは自動拒否されますが、自分で `permissions.allow` にルールを足せば内蔵ツール（シェル・ファイル等）も動くため、信頼する自分の環境でのみ起動してください。
- `agy` のグローバル MCP 設定に `kasugai` サーバーを登録するため、**ブリッジを使わない対話 `agy` セッションでも `kasugai` のツールが見えます**。ブリッジ停止中に呼ぶと接続エラーになり、呼び出しても地図には反映されません（実行は常にブラウザ側）。不要なら `agy mcp remove kasugai` で解除できます。
- チャットの「モデル」選択は `agy models` の一覧から供給します（`gemini-3.8-flash-high` 等の slug）。モデルはリクエストごとの `agy --model` に反映されます。
- `POST /agent` 以外に `GET /health`（`{ok, model, sessions, bridge:"antigravity", agy}`）と `GET /models`（`{models:[{id,name}], model, usage}`）があります。
