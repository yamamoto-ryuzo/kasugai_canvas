# bridge-hub — KASUGAI Canvas ブリッジハブ

ローカルアプリが常駐させるブリッジを **1本（127.0.0.1:8511）に集約**するハブです。
Copilot / Devin / Antigravity 各ブリッジはこのハブの子プロセスとして、
プロバイダが実際に使われた時点で**遅延起動**され、常時起動するのは1プロセスだけです。

## 動作

- `GET /health` — ハブ自身の状態（`providers.<名>.available/running`・`active`）
- `GET /models?provider=<copilot|devin|antigravity>` — 対象ブリッジを起動して `/models` を中継
- `POST /agent` — ボディの `provider` フィールドで対象ブリッジを選択し起動・中継
- プロバイダが切り替わると、前の子ブリッジは停止してから次を起動します

子ブリッジは内部ポートで待受けます（copilot:8521 / devin:8522 / antigravity:8523）。
これらはハブ内部用で、ブラウザから直接設定するエンドポイントは常に `http://127.0.0.1:8511/agent` です。

## ブリッジの検索場所

`bridge-hub/` と同階層の `copilot-bridge/`・`devin-bridge/`・`antigravity-bridge/` を
それぞれ探します（配布 ZIP では同梱構成）。依存のあるブリッジ（copilot）は
`node_modules` が無ければ初回起動時に `npm install --omit=dev` を実行します。

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `BRIDGE_HUB_PORT` | `8511` | ハブの待受ポート（127.0.0.1 のみバインド） |
| `KASUGAI_NO_COPILOT_BRIDGE` | なし | copilot ブリッジを無効化 |
| `KASUGAI_NO_DEVIN_BRIDGE` | なし | devin ブリッジを無効化 |
| `KASUGAI_NO_ANTIGRAVITY_BRIDGE` | なし | antigravity ブリッジを無効化 |

各子ブリッジ固有の環境変数（`DEVIN_BRIDGE_*`・`ANTIGRAVITY_BRIDGE_*` 等）は
そのまま子プロセスへ引き継がれます。

## 手動起動のブリッジとの併用

従来どおり `copilot-bridge/`（8788）・`devin-bridge/`（8789）・`antigravity-bridge/`（8791）
を単体で起動して「外部エージェント」プロバイダから接続することも可能です。
手動ブリッジのポートとハブの内部ポート（8521-8523）は衝突しません。
