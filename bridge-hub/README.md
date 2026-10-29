# bridge-hub — KASUGAI Canvas ブリッジハブ

ローカルアプリが常駐させるブリッジを **1本（127.0.0.1:8511）に集約**するハブです。
Copilot / Devin / Antigravity 各ブリッジはこのハブの子プロセスとして、
プロバイダが実際に使われた時点で**遅延起動**され、常時起動するのは1プロセスだけです。

## エージェント連携は双方向

このハブは「ブラウザ → エージェント」方向だけを担います。逆方向は別経路です:

- **ブラウザ → エージェント**（チャットから AI を使う）… 本ハブ（`127.0.0.1:8511` の `/agent`・`/models`）
- **エージェント → ブラウザ**（外から地図を操る）… アプリ本体（`127.0.0.1:8510`）の `/api/command`。Devin Desktop・Copilot CLI・任意スクリプトが `{"name":"flyTo","args":{...}}` を投入すると、ブラウザがロングポーリングで受信して `executeChatTool` で実行します

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

## スタンドアロン利用（アプリ版なし・静的配信から使う）

アプリ版（kasugai_canvas.exe）を持たない環境でも、本ハブを手動/自動起動しておけば
CDN ホスト版・静的配信の Canvas から同じようにブリッジ系プロバイダが使えます。
フロントは 127.0.0.1 のハブ `/health`（8512 → 8511 の順）を疎通し、`hub:true`
が返れば capabilities 通知が無くても「【ブリッジ】GitHub Copilot」等の
選択肢を出します（接続は全てローカルへ。公開デプロイからも localhost への
http は許可）。

前提: Node.js 20.19+（`node`/`npm` が PATH 上にあること）と、同階層に
`copilot-bridge/` 等の子ブリッジ一式（初回利用時にハブが `npm install` を実行）。

```
# 手動起動（コンソール非表示・ダブルクリックでも可。スタンドアロン既定ポート 8512）
run-hidden.vbs

# ログイン時自動起動の登録 / 解除（常駐させたい場合・ポート 8512）
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

# 手動起動（コンソール表示あり・既定 8511。環境変数で変更可）
node server.mjs
```

**アプリ版との併用**: アプリのハブは 8511 を占有し、起動時に占有者が
ブリッジなら強制停止して置き換えます。スタンドアロン常駐の既定ポートは
**8512**（`run-hidden.vbs`/`install-autostart.ps1` が `BRIDGE_HUB_PORT=8512`
を設定）で、新版アプリは旧ブリッジ掃除（8512/8513）の際に `hub:true` の
ハブを潰さないよう除外するため**同時稼働できます**。
**注意**: この除外は新版アプリの動作のため、旧版アプリ（リリース済み）は
8512 のハブを旧ブリッジとして落とします。`node server.mjs` で素のまま
起動すると既定 8511 なので、併用時は `BRIDGE_HUB_PORT=8512` を指定してください。

停止だけしたい場合は、このフォルダの `server.mjs` を実行中の node プロセスを
終了してください（`uninstall-autostart.ps1` は自動起動解除＋停止を行います）。

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `BRIDGE_HUB_PORT` | `8511` | ハブの待受ポート（127.0.0.1 のみバインド）。アプリ本体（kasugai_canvas.exe）起動時にも同じ環境変数が読まれ、待受ポート・占有チェック・`/api/capabilities` の通知エンドポイントがすべてこのポートに揃う。スタンドアロン同梱スクリプトは `8512` を設定する |
| `BRIDGE_HUB_CHILD_BASE` | `8520` | 子ブリッジ待受ポートの基準（copilot=base+1/devin=base+2/antigravity=base+3）。複数ハブの同時稼働で子ポートが衝突する場合のみずらす |
| `KASUGAI_NO_COPILOT_BRIDGE` | なし | copilot ブリッジを無効化 |
| `KASUGAI_NO_DEVIN_BRIDGE` | なし | devin ブリッジを無効化 |
| `KASUGAI_NO_ANTIGRAVITY_BRIDGE` | なし | antigravity ブリッジを無効化 |

各子ブリッジ固有の環境変数（`DEVIN_BRIDGE_*`・`ANTIGRAVITY_BRIDGE_*` 等）は
そのまま子プロセスへ引き継がれます。

