# hub-test — bridge-hub 依存パスの回帰検証

ハブ依存パス（`/health` 検出・旧ハブ判定・DL 導線・ベクトルサービス）の自動検証。
検証用の一時ファイル・スクリーンショットは `%TEMP%` へ出力し、リポジトリに残さない（AGENTS.md 準拠）。

## 前提

```sh
cd tools/hub-test
npm install   # playwright-core（OS インストール済み Edge/Chrome を channel 経由で使う。ブラウザ DL 不要）
```

## 構成

- `mock-hub.mjs` — `/health` 等を模倣するモックサーバー。`MOCK_VERSION`・`MOCK_VECTOR`・`MOCK_PROVIDERS`・`MOCK_HUB` 環境変数で旧ハブ/非ハブ占有を切替え（既定ポート 8511、`MOCK_PORT` で変更可）
- `verify.mjs` — Playwright 自動検証。`web/` を静的配信し `/cesium/` を実ブラウザ（headless）で開き、8511 宛の実 fetch を `page.route` でパラメータ化して以下を検証:
  1. 正常ハブ検出（chip「導入済み」）
  2. 旧ハブ（version/vector 無し）→ 更新導線 + hubOld 診断
  3. ハブ未起動（接続拒否）→ 「未導入」
  4. 非ハブ占有（hub:false）→ 「未導入」
- `smoke.mjs` — `bridge-hub.exe --serve` の実起動スモーク。`web/download/bridge-hub.exe`（既定・引数で変更可）を一時ポートで起動し `/health`（hub:true・version）と `/vector/status` を実疎通

## 実行

```sh
node verify.mjs    # Playwright 4ケース
node smoke.mjs     # 実ハブスモーク（Windows）
MOCK_VERSION= MOCK_VECTOR=0 node mock-hub.mjs   # 旧ハブのモックを手動確認用に起動
```

実ハブ常駐環境で 8511 を使う検証（mock-hub.mjs 既定）は、AGENTS.md の
「8510/8511 は検証用に自由に使ってよい」に基づき既存ハブを止めてから行う。
verify.mjs は page.route スタブのため実ハブと共存できる。
