# KASUGAI Copilot Bridge

KASUGAI Canvas の AI チャットを **GitHub Copilot** で動かすためのローカルブリッジです。
アプリの「外部エージェント」接続口と [GitHub Copilot SDK](https://github.com/github/copilot-sdk)（Copilot CLI ランタイム）の間を翻訳します。

```
ブラウザ (KASUGAI Canvas)                ローカル
  チャット入力 ──POST /agent──→  copilot-bridge ──JSON-RPC──→ Copilot CLI ──→ GitHub Copilot API
  ←── {reply, actions} ──                                            （Copilot 契約の quota を消費）
  actions をチャットツールとして実行
```

## 動作の仕組み

- アプリはチャット入力を `POST /agent` に `{message, project, camera, layers, history, tools, model?}` で送ります（`tools` は現在ユーザーに公開されている地図操作ツールの宣言。`model` は任意で、指定時はセッションの Copilot モデルを切り替えます）。
- ブリッジはツール宣言を Copilot セッションのカスタムツールとして登録します。Copilot がツールを呼ぶとハンドラが呼び出しを `actions` として収集し、スタブ結果を返します。
- `sendAndWait` が返った時点で `{reply, actions}` をアプリへ返し、ブラウザ側が actions を順次実行します。破壊的操作（`savePlugin`・`publishPlugin`・`deleteDataFile` 等）はアプリ側の既存確認ダイアログで保護されます。
- `listLayers` / `getCamera` だけはリクエスト同梱の現在状態から実値を返します（レイヤ名を確認してから操作する流れが成立するように）。
- セッションはプロジェクト ID ごとに保持されるため、会話コンテキストが継続します。ツール構成が変わった場合のみセッションを再作成します。

## 前提

- Node.js 20.19+ / 22.12+
- **GitHub Copilot サブスクリプション** — Free / Pro / Pro+ / Max / Business / Enterprise の**いずれのプランでも動作**します（Copilot CLI は全プランに同梱のコア機能）。プレミアムリクエストの quota（AI クレジット）を消費します。
  - Free プラン: AI クレジットの無料枠あり・モデルは自動選択のみ（モデル指定は有料プラン向け）
  - Business / Enterprise: 組織管理者が Copilot CLI をポリシーで有効化している必要があります
  - 参考: SDK は BYOK（独自 LLM プロバイダのキー）でも動作可能ですが、本ブリッジは未対応です
- 認証は以下のいずれか:
  - `copilot` CLI でログイン済み（推奨・`copilot` をインストールして対話ログイン）
  - 環境変数 `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`（GitHub の OAuth トークン）

## アプリ版との連携（ブリッジハブ経由・ポート 8511）

アプリ版（kasugai_canvas.exe）の機能の1つとして組み込まれています。アプリは起動時に**ブリッジハブ**（`bridge-hub/`）を `127.0.0.1:8511` で起動し、ハブがプロバイダ「GitHub Copilot」が選択されたときだけ本ブリッジを内部ポートで**子プロセスとして遅延起動**します（`node_modules` が無い初回は先に `npm install --omit=dev` を実行）。プロバイダ切替時は前のブリッジが停止され、常時最大1本だけが動きます。アプリ終了時にはハブごと停止します。

- 前提: 利用者のマシンに **Node.js** と **Copilot CLI のログイン済み環境**があること（`node`/`npm` が PATH 上で見つかること）
- `GET /api/capabilities` が `copilot.endpoint`（ハブの `http://127.0.0.1:8511/agent`）と features `copilotBridge` を通知します。フロントの AI プロバイダ選択肢「GitHub Copilot」は**この feature 通知がある環境（=アプリ版）でのみ表示**され、選択時にこのエンドポイントを優先検出します
- ポート 8511 が使用中でも、占有者がブリッジ（`/health` で確認・前回起動の残骸や旧バージョン等）なら強制停止して新版へ差し替えます。ブリッジ以外のプロセスが占有している場合のみ起動をスキップします。旧版の常駐ブリッジが 8512/8513 に残っていれば起動時に掃除します
- 無効化: 環境変数 `KASUGAI_NO_COPILOT_BRIDGE` を設定してアプリを起動
- `COPILOT_BRIDGE_TOKEN` をアプリ起動環境で設定すると子プロセスにも継承されます。その場合はアプリ側のブリッジ設定欄「トークン（任意）」にも同じ値を入れてください

## 使い方（単体起動・開発/デバッグ用）

通常はアプリ版のブリッジハブ経由で自動起動されるため手動起動は不要です。開発・デバッグ用に単体で起動する場合:

```bash
cd copilot-bridge
npm install
npm start
# → [bridge] listening: http://127.0.0.1:8788/agent
```

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `COPILOT_BRIDGE_PORT` | `8788` | 待受ポート（127.0.0.1 のみバインド） |
| `COPILOT_BRIDGE_MODEL` | `gpt-5` | Copilot セッションの既定モデル（アプリ側のモデル選択で上書き可） |
| `COPILOT_BRIDGE_TOKEN` | なし | 設定すると `Authorization: Bearer <token>` を必須化（アプリ側「トークン」欄と合わせる） |
| `COPILOT_BRIDGE_TIMEOUT_MS` | `110000` | Copilot 応答の待機上限（アプリ側の中断は120秒） |
| `COPILOT_CLI_PATH` | SDK同梱 | 既存の `copilot` CLI を使う場合に指定 |

## 注意・制限

- **ローカル専用の機能**です（127.0.0.1 バインド）。公開デプロイで全ユーザーに提供するものではありません。
- ただし**アプリ版は必須ではありません** — エージェント接続は純粋なフロント機能なので、静的配信・Cloudflare・Cloud Run など HTTPS の公開デプロイからも、ブラウザと同じマシンで動くブリッジへ接続できます（localhost への http は混在コンテンツブロックの例外。Private Network Access プリフライトにも応答済み）。リモートから使いたい場合はブリッジを HTTPS 公開サーバーへ置き `COPILOT_BRIDGE_TOKEN` で認証してください（quota はブリッジの Copilot アカウントから消費されるため、公開する場合はアクセス制御が必須）。
- Copilot の内蔵ファイル/シェルツールへのアクセスは、カスタムエージェントで地図ツールのみに制限し、作業ディレクトリも `%TEMP%/kasugai-copilot-bridge`（空）に限定しています。それでも `approveAll` で権限承認を自動化しているため、信頼する自分の環境でのみ起動してください。
- ツール呼び出しは「キュー→一括実行」方式のため、参照系ツール（`listLayers`/`getCamera` 以外）の実結果を見て次の操作を決める往復はできません。内蔵AI（ブラウザ側ループ）の方が精度が高い場面があります。
- `POST /agent` 以外に `GET /health`（`{ok, model, sessions}`）と `GET /models`（利用可能モデル一覧 `{models:[{id,name}]}`。ランタイムが列挙できない場合は既知モデルのフォールバック一覧を返します）があります。

## BYOK（Copilot 契約なしで使う場合）

Copilot SDK は `provider` 設定で BYOK（OpenAI・Azure・Anthropic 等の自前キー）にも対応しますが、本ブリッジは標準の Copilot 認証向けです。OpenAI 互換 API を直接使いたい場合はブリッジ不要 — アプリの **管理 → AI → チャット** で AI プロバイダを「OpenAI互換」に切り替えてください。
