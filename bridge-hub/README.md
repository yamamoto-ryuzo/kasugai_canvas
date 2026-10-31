# bridge-hub — KASUGAI Canvas ブリッジハブ

ローカルに常駐するブリッジを **1本（127.0.0.1:8511）に集約**するハブです。
**Rust 製の単一 exe で、Node.js は不要**。アプリ版（kasugai_canvas.exe）と
同じ `server/src/bridge/` 実装を使い、Copilot / Devin / Antigravity の
各プロバイダは実際に使われた時点で外部 CLI を子プロセスとして遅延起動します。

- **ブラウザ → エージェント**（チャットから AI を使う）… 本ハブ（`/agent`・`/models`）
- **エージェント → ブラウザ**（外から地図を操る）… アプリ本体（`127.0.0.1:8510`）の `/api/command`

## 使い方（概略）

`bridge-hub.exe` をダウンロードして実行するだけで、
`%LOCALAPPDATA%\kasugai\bridge-hub\` への自己インストール → ログイン時
自動起動登録 → `127.0.0.1:8511` での起動 → ブリッジ用 CLI（copilot/devin）
未導入分の自動インストールまで一括で行われます。管理者権限は不要です。

```
bridge-hub.exe              # 自己インストール
bridge-hub.exe --serve      # インストールせずその場でハブ起動（既定 8511）
bridge-hub.exe --uninstall  # 自動起動解除＋停止＋インストール先の削除
bridge-hub.exe --setup all  # copilot/devin CLI を自動導入
```

アプリ版・ブラウザ WebGIS 共通で 8511 に一本化されています。アプリはハブを
内蔵せず、起動時に 8511 のハブが未応答ならインストール済みの本 exe を
自動起動します。

## 前提（ローカル・本人利用限定）

いずれのブリッジも公式連携ではなく、公開インターフェースを使った
サードパーティ製クライアントです。各サービスの利用規約に沿うため、
127.0.0.1 バインドのローカル・本人利用限定で使ってください。

使うプロバイダの CLI と本人の認証が別途必要です
（Copilot なら `copilot` CLI＋Copilot 契約、Devin なら `devin` CLI、
Antigravity なら `agy` CLI＋Google ログイン）。

## 詳細

HTTP API 一覧・`/setup` による CLI 自動導入・プロバイダ別の前提と
利用条件・環境変数などの詳細仕様は、ドキュメントサイトの
**ブリッジハブ（bridge-hub.exe）** ページを参照してください:

- 公開版: https://yamamoto-ryuzo.github.io/kasugai_canvas/bridge-hub.html
- リポジトリ内: `docs/bridge-hub.html`
