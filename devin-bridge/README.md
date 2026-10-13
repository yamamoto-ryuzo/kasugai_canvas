# KASUGAI Devin Bridge

KASUGAI Canvas の AI チャットを **Devin（Devin CLI）** で動かすためのローカルブリッジです。
アプリの「外部エージェント」接続口と `devin acp`（[Agent Client Protocol](https://agentclientprotocol.com/) サーバー・stdio JSON-RPC）の間を翻訳します。

```
ブラウザ (KASUGAI Canvas)                    ローカル
  チャット入力 ──POST /agent──→  devin-bridge ──JSON-RPC(stdio)──→ devin acp ──→ Devin API
  ←── {reply, actions} ──          │                                    （利用者自身の Devin プランの quota を消費）
  actions をチャットツールとして実行   └─ /mcp/<project> で MCP サーバーを兼ね、地図ツールを Devin へ注入
```

## 動作の仕組み

- アプリはチャット入力を `POST /agent` に `{message, project, camera, layers, history, tools, model?}` で送ります（`tools` は現在ユーザーに公開されている地図操作ツールの宣言）。
- ブリッジは `devin acp` を子プロセスとして起動し、プロジェクトごとに `session/new` で ACP セッションを作ります。セッションの `mcpServers` にブリッジ自身の `/mcp/<project>`（streamable HTTP）を登録し、`tools` 宣言をそのまま MCP ツールとして公開します。
- Devin がツールを呼ぶと MCP の `tools/call` が届き、呼び出しを `actions` として収集してスタブ結果を返します。`session/prompt` が返った時点で `{reply, actions}` をアプリへ返し、ブラウザ側が actions を順次実行します。破壊的操作（`savePlugin`・`publishPlugin`・`deleteDataFile` 等）はアプリ側の既存確認ダイアログで保護されます。
- `listLayers` / `getCamera` だけはリクエスト同梱の現在状態から実値を返します。
- 権限は `session/request_permission`（ACP のクライアント側責務）で制御し、**kasugai の MCP ツール呼び出しのみ許可・それ以外（ファイル・シェル等の内蔵ツール）は拒否**します。作業ディレクトリも空の `%TEMP%/kasugai-devin-bridge` に限定しています。

## 利用条件（必読）

このブリッジは Cognition 公式の連携ではなく、ドキュメント化された ACP インターフェースを使ったサードパーティ製クライアントです。Cognition の利用規約（Platform Terms of Service / Acceptable Use Policy）に沿うため、以下の条件でのみ利用してください。

1. **ローカル・本人利用限定** — 127.0.0.1 にのみバインドします。ブリッジを公開サーバーへ置いたり、**自分の Devin アカウントで他者のチャットを処理する形態は禁止**です（アカウント共有・サービスの第三者提供・再販に該当し得ます）。
2. **利用者本人の Devin プランが必要** — ブリッジ自体は認証情報を持たず、起動したマシン上の Devin 認証を各ユーザー自身で行います。消費されるのは利用者自身の quota です。
3. **Devin CLI（`devin`）が必要** — Devin Desktop 同梱の `devin.exe` または単体インストールの `devin` が見つかること。見つからない場合は `DEVIN_CLI_PATH` で指定してください。

## 認証

ACP モードの `devin` はローカルの `devin auth login` 資格を参照しないポリシーのため、ブリッジが ACP `authenticate` を行います。初回接続時に以下の順で試行されます。

- `DEVIN_API_KEY` が設定されていれば API キー認証（`authenticate` の `meta.api_key`）
- 未設定ならブラウザ PKCE フロー — **利用者のマシンでブラウザが開き**、Devin にログインすると以降のセッションが使えます（`devin acp` 子プロセスの存続中のみ有効）

## アプリ版との連携（ブリッジハブ経由・ポート 8511）

アプリ版（kasugai_canvas.exe）は起動時に**ブリッジハブ**（`bridge-hub/`）を `127.0.0.1:8511` で起動し、ハブがプロバイダ「Devin」が選択されたときだけ本ブリッジを内部ポートで**子プロセスとして遅延起動**します。プロバイダ切替時は前のブリッジが停止され、常時最大1本だけが動きます。アプリ終了時にはハブごと停止します。

- `GET /api/capabilities` が `devin.endpoint`（ハブの `http://127.0.0.1:8511/agent`）と features `devinBridge` を通知します。フロントの AI プロバイダ選択肢「Devin」は**この feature 通知がある環境（=アプリ版）でのみ表示**されます
- ハブ経由ではなく本ブリッジ単体で手動起動する場合の既定ポートは 8789 です
- 無効化: 環境変数 `KASUGAI_NO_DEVIN_BRIDGE` を設定してアプリを起動
- `DEVIN_API_KEY`・`DEVIN_BRIDGE_TOKEN`・`DEVIN_BRIDGE_MODEL` 等はアプリ起動環境から子プロセスへ継承されます

## 使い方（手動起動）

```bash
cd devin-bridge
npm start
# → [bridge] listening: http://127.0.0.1:8789/agent
```

依存パッケージはありません（Node.js 標準ライブラリのみ。`npm install` 不要）。

アプリ側: **管理 → AI → チャット** で「AI プロバイダ」を「Devin」（アプリ版のみ表示）にするか、「外部エージェント (ブリッジ)」にしてエンドポイントURLに `http://127.0.0.1:8789/agent` を入力して保存します。

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `DEVIN_BRIDGE_PORT` | `8789` | 待受ポート（127.0.0.1 のみバインド） |
| `DEVIN_BRIDGE_MODEL` | なし | `devin acp --model` に渡す既定モデル（アプリ側のモデル選択で上書きを試行） |
| `DEVIN_BRIDGE_TOKEN` | なし | 設定すると `Authorization: Bearer <token>` を必須化（アプリ側「トークン」欄と合わせる） |
| `DEVIN_BRIDGE_TIMEOUT_MS` | `110000` | Devin 応答の待機上限（アプリ側の中断は120秒） |
| `DEVIN_API_KEY` | なし | Devin API キー。設定時はブラウザ認証なしで接続 |
| `DEVIN_CLI_PATH` | 自動探索 | `devin` バイナリのパス（PATH・Devin Desktop 同梱を順に探索） |

## 注意・制限

- **ローカル専用の機能**です（上記「利用条件」参照）。公開デプロイで全ユーザーに提供するものではありません。
- Copilot ブリッジと同じく、ツール呼び出しは「キュー→一括実行」方式のため、参照系ツール（`listLayers`/`getCamera` 以外）の実結果を見て次の操作を決める往復はできません。
- Devin はコーディングエージェントです。ブリッジは kasugai ツール以外の実行を権限レイヤで拒否しますが、信頼する自分の環境でのみ起動してください。
- モデルの実行時切替は Devin 側の ACP 実装依存です（`session/set_config_option`/`session/set_model` を試行し、未対応なら起動時の `DEVIN_BRIDGE_MODEL`/既定に留まります）。
- `POST /agent` 以外に `GET /health`（`{ok, model, sessions, bridge:"devin"}`）と `GET /models`（セッションが通知するモデル一覧 `{models:[{id,name}]}`）があります。`devin acp` 未起動時の `/models` は起動・認証をバックグラウンドで始めつつ `{models:[], pending:true}` を即座に返します（起動完了後の再取得で一覧が返ります）。
