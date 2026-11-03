# bridge-hub — KASUGAI Canvas ブリッジハブ

ローカルに常駐するブリッジを **1本（127.0.0.1:8511）に集約**するハブです。
**Rust 製の単一 exe で、Node.js は不要**。アプリ版（kasugai_canvas.exe）と
同じ `server/src/bridge/` 実装を使い、Copilot / Devin / Antigravity の
各プロバイダは実際に使われた時点で外部 CLI を子プロセスとして遅延起動します。

- **ブラウザ → エージェント**（チャットから AI を使う）… 本ハブ（`/agent`・`/models`）
- **エージェント → ブラウザ**（外から地図を操る）… アプリ本体（`127.0.0.1:8510`）の `/api/command`
- **ベクトルサービス**（ローカル永続 DuckDB → GeoJSON 配信）… 本ハブ（`/vector/*`）

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

## /vector — ローカルベクトルサービス

ネイティブ DuckDB CLI をバックエンドに、parquet / gpkg / fgb / geojson / csv / shp を
永続 `.duckdb`（`%LOCALAPPDATA%\kasugai\vector\`）へ取り込み、GeoJSON として
HTTP 配信します。ブラウザ側は `geojson: http://127.0.0.1:8511/vector/geojson/<name>`
の1行でレイヤー化でき、KASUGAI Canvas・Re:Earth geo_suite 等から共用できます
（CORS・PNA 対応済みのため公開 HTTPS ページからも fetch 可能）。

```
GET    /vector/status            duckdb 検出・ストア・登録ソース
GET    /vector/sources           登録ソース一覧
POST   /vector/sources           {name, src, kind?, layer?, lon?, lat?,
                                  geom_col?, where?, limit?, materialize?}
DELETE /vector/sources/{name}    登録解除
GET    /vector/geojson/{name}    GeoJSON 配信（gzip 対応）
                                 ?where=&bbox=w,s,e,n&limit=&simplify=&columns=
POST   /vector/query             {sql:"SELECT ..."} → GeoJSON（geom 列を含むSELECT）
```

duckdb CLI は `bridge-hub.exe --setup duckdb` または
`POST /setup {"provider":"duckdb","action":"install","confirm":true}` で
GitHub Releases から自動導入されます（`%LOCALAPPDATA%\kasugai\bridge-cli\duckdb\`）。
`DUCKDB_CLI_PATH` 環境変数で任意パスも指定可能です。

なお、直前の duckdb プロセスが残っている間（クライアント側が先に切断
した場合やハブ異常終了後）は永続 DB のロックにより 502「File is already
open in duckdb.exe」が返ります。サーバー側のタイムアウトでは子プロセスを
kill するため孤児は残りませんが、クライアント側の切断でハブの処理は止まり
ません。処理完了を待つか、残った `duckdb.exe` を終了して再試行してください。

## 詳細

HTTP API 一覧・`/setup` による CLI 自動導入・プロバイダ別の前提と
利用条件・環境変数などの詳細仕様は、ドキュメントサイトの
**ブリッジハブ（bridge-hub.exe）** ページを参照してください:

- 公開版: https://yamamoto-ryuzo.github.io/kasugai_canvas/bridge-hub.html
- リポジトリ内: `docs/bridge-hub.html`
