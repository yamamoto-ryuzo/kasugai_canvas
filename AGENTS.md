# KASUGAI Canvas — 開発ルール

## バージョン採番方針

- **メジャーバージョンの機能テーマ**（採番の区切りが実装に後追いした箇所があるため、機能面での位置づけは以下を正とする）:
  - **V1**: GIS 基本機能
  - **V2**: プレゼンテーション機能（Fly モード・描画ルート等）
  - **V3**: AI 連携
  - **V4**: プラグイン（認証機構）
  - **V5**: アプリ化（ローカル連携）— ローカル Rust サーバーと一体で動く「アプリ」だから実現できる機能群（rclone クラウドストレージ連携・ドライブ割当・ローカルファイル保存・納品用ローカル化など）。ブラウザのみ・コンテナ実行では提供されない
  - **V6**: マルチエンジン — `web/` をエンジン別フロント（Cesium・MapLibre・OpenLayers・Leaflet・GSI Maps※調整中）に分割し、`.kasc` をエンジン非依存のプロジェクト形式として各エンジンで再生する構成。`?engine=` 選択・エンジン切替 UI・状態引継ぎ・`web/shared/` へのエンジン非依存コアの集約・CDN ホスト版（`kasugai-canvas-web` でエンジン一式を静的配信）を含む。メインエンジンは CesiumJS で、他エンジンは `.kasc` プレイヤーとしての互換実装
- ドキュメント（`features/` 配下）はこのテーマごとにページを分ける。バージョン横断の実装詳細は **V0: システム基本構成**（`features/v0.html`）に集約する
- リリースは 4.x〜5.x 系（4.0.0, 4.1.0, ...）で進める
- ハッカソン提出は「**V3（AI 連携）の強化**」として位置づける（詳細は `hackathon.html`）。提出可能状態の条件:
  - Cloud Run 上に KASUGAI Canvas（静的配信）＋GIS 保存 API＋`/api/gemini`（内蔵AI向けキー隠蔽プロキシ）が稼働し、`GEMINI_API_KEY` で審査員キーレスの AI 利用ができる
  - ブラウザ内蔵AI（Gemini function calling・55ツール）によるサンプルデータ生成・資料生成＋パーマリンク（`showReport`/`buildShareUrl`）が動作する
  - 審査用公開URLが維持され、「○○の資料を作って」→ レイヤー自動構成 → FlyTo → 資料出力のデモが通しで動く

## バージョン管理手順

- バージョン番号の正本: `server\Cargo.toml` の `package.version`
- リリース時は以下を同じ番号に更新: `download/latest.json`、ドキュメント各ページ（`index.html` 等）のバージョンバッジ、`README.md` のバージョン表記、`installer/kasugai_canvas.nsi`（`python run.py -B` が自動更新する場合あり）
- `CHANGELOG.md` に日付付きセクションを追加（Keep a Changelog 形式）
- **リリース時は必ずマニュアル（ドキュメントサイトの HTML ページ）を整備する**。そのリリースで追加・変更された機能・設定・UI が `guide.html`・`features.html` 等の該当ページに反映されていることを、バージョンアップの完了条件に含める。新機能がドキュメントに載っていない状態でリリースしない
- 配布物は `python run.py -B` で `download/` に作成し、コミットしてプッシュ
- **重要（無限ループ事故の再発防止）**: `download/latest*.json` のバージョン更新と配布 ZIP の再ビルドは**必ず同じコミットで行う**。`latest.json` だけを先に上げると、全ユーザーの自動更新が「適用 → 再起動 → 依然古い → 再適用」の**無限ループ**に陥る（4.20.0 リリースで実際に発生し 4.20.1 で修正）。`latest.json`/`latest-dev.json` を手編集でだけ更新するリリースは禁止。必ず `python run.py -B`（または `--publish`）を通し、スクリプトによる ZIP 内 exe の `/health` バージョン検証を通過させること（`--sync` 実行時も同検証を行い、ズレた ZIP はブロックされる）。フロント側にも試行済みバージョンの記録によるループガードはあるが、配布物の整合はリリース手順で担保する

## ブランチと自動更新チャンネル

- **`main` のみで運用**（develop ブランチは廃止）。日常の開発も main で行い、GitHub Pages（`main` ルートが公開元）と自動更新（`main/download/latest.json`・`main/download/kasugai_canvas.zip`）も同じブランチを参照する
- **自動更新は単一チャンネル**: `server/src/main.rs` は全バージョンが `main/download/latest.json` を参照する。**最新リリースより古い実行バージョンは起動時の自動更新でリリース版へ差し替えられる**ため、開発中は `Cargo.toml` を `latest.json` より先の番号に保つか、設定の自動更新をオフにする
- **採番ルール（-dev 廃止）**: `Cargo.toml` は常に**次のリリース予定番号（`download/latest.json` より先）を名乗る**。開発中から `X.(Y+1).0` 等の接尾辞なし番号で進め、リリース時に番号を変えない（`-dev` 接尾辞の運用は廃止）
- **同一番号・降格では配布物を作れない**: `python run.py -B`（および `--publish`）は `Cargo.toml` が `download/latest.json` より**大きい**場合のみ実行可能（同一番号の再配布・過去番号への降格を禁止）。接尾辞付きバージョンも拒否される。`--sync` は `Cargo.toml` と `latest.json` の番号が一致する場合のみ実行可能（リリース直後の整合確認専用・開発中は拒否）。`CHANGELOG.md` はリリースのみ記録する
- **リリースの流れ**: `main` で `Cargo.toml` を次のリリース番号へ更新 → `python run.py -B` → コミット＆プッシュ
- **更新時のポート奪取(重要・再発防止)**: 「更新が適用されず旧版が残る」問題は過去に繰り返し発生しており、原因は `--finish-update` 後続プロセスが 8510 の解放を**待つだけ**で、旧プロセスが終了しないと 60 秒で bind 失敗し「ファイルは新しいがサーバー未起動」状態に陥る設計にあった。現行の `bind_for_update` は次の順でポートを奪取する:
  1. **フェーズ1(5秒)**: 旧プロセスの自主終了を待つ通常経路(`/api/update/install` の応答完了・子プロセス停止の猶予)
  2. **フェーズ2**: 占有者を `/health` で確認し `name=="kasugai_canvas"` の場合のみ `port_owner_pids()` で PID 特定 → `taskkill /T /F`(**/T で rclone serve・ブリッジハブ等の子プロセスごと落とし孤児化を防ぐ**)→ 10 秒待機して bind。**ただし占有者が `--finish-update` を起動した旧プロセス(=後続プロセス自身の祖先)の場合は `/T` を使うと子孫の自分も道連れで強制終了され「ファイルは適用済みだがサーバー未起動」になる**(6.1.1 で実際に発生)。この場合は祖先を `/T` なしの `/F` で単独終了し、祖先の他の子プロセス(=自分の兄弟: rclone serve・ブリッジ CLI 等)だけを個別に `/T /F` で落とす(`kill_process_forced` + `child_pids`)。ブリッジハブの占有者 kill(`kill_bridge_on_port`)も同じ祖先回避を行う——終了中の旧プロセスが 8511 を握ったままだと、ブリッジ起動時にも同じ自殺が起き得るため
  - **最初から kill しない理由**: 応答を返す前に親を殺すとブラウザ側が更新失敗表示になるため。Windows では子プロセス停止がどの経路でも強制 kill 相当のため、待機が長いことの利点はほぼ無い
  - **kasugai_canvas 以外の占有者は絶対に kill しない**(無関係プロセスの巻き添え防止)。占有者が kasugai_canvas でない・PID 特定に失敗した場合は従来通り AddrInUse で終了(ファイルは適用済みなので次回起動で新版になる)
  - **残骸掃除のタイミング(重要)**: 旧 exe の退避 `*.update-old` や旧 web 退避 `web.update-old` は旧プロセスが握っているため起動直後の掃除では消せず、かつては残骸が残った。`bind_for_update` はポート確保(=旧プロセス終了)後の `apply_update_files` 直後に `cleanup_update_leftovers` を必ず実行し、**更新直後に残骸を残さない**。通常起動時にも同じ掃除を行い前回分の保険とする
  - この占有者 kill と同じ考えで、通常起動時は `is_existing_instance` で既存インスタンスのブラウザを開き二重起動しない、ブリッジハブ(8511)はブリッジと確認できた場合のみ `kill_bridge_on_port` で強制停止する設計になっている

## CDN ホスト版（kasugai-canvas-web）の同期

- **配信先**: `yamamoto-ryuzo/kasugai-canvas-web`（GitHub Pages）。`stable/`（既定・リリース版）/ `unstable/`（main の最新 `web/` 追従）/ `channels.json`（各ステージのバージョン表）
- **正本は本リポジトリの `web/`**。CDN リポジトリ側は発行物のみで直接編集しない。`web/` は相対パス構成済みのため同期は単純コピーでよい
- **同期は `python tools/publish_cdn.py` で行う**（手コピー・CDN 側の手編集はしない）。`--channel` はコピー先ステージを選ぶだけで、どちらも `web/` を直接同期する（stable への格上げに unstable 同期は不要）:
  - `python tools/publish_cdn.py --channel unstable` — `web/` → `unstable/` へ同期し `version.json`・`channels.json` を更新。`--commit` / `--push` でコミット・push まで実行
  - `python tools/publish_cdn.py --channel stable` — `web/` → `stable/` へ直接同期（unstable を経由しない）
  - CDN リポジトリのパスは省略時 `<kasugai_canvas>/../kasugai-canvas-web`（`C:\devin` ワークスペースなら省略可）
- **運用**: `web/` に配信したい変更が入ったら unstable 同期、リリース時（`-B` で配布物を作るタイミング）に stable 同期。ルート `index.html` はリダイレクト固定で触らない

## 動作テストの2系統（CDN を忘れない）

今後の動作確認は以下の2系統を対象に行う:

1. **ブラウザ WebGIS（CDN × 外部データホスト）— メインの利用形態**
   - エンジン: `kasugai-canvas-web`（GitHub Pages CDN。エンジン本体のみ配信し `projects/` は同梱しない）。`stable/`=リリース版・`unstable/`=最新 `web/` 追従。`web/` の変更は `python tools/publish_cdn.py --channel unstable --commit --push` で同期してから検証する
   - テストデータホスト: `yamamoto-ryuzo/kasugai_canvas_webGIS`（GitHub Pages。`.kasc + DATA/` + 群マニフェスト `projects.json`）— エンジン以外のテストデータの置き場
   - 再生: `…/kasugai-canvas-web/<stage>/<engine>/?kasc=<.kasc URL>`。開いた .kasc の祖先 `projects.json`（群マニフェスト）をエンジンが読み、同一ホストの他プロジェクトをドロップボックスに並べる（cesium 実装済み）
   - 検証例: `https://yamamoto-ryuzo.github.io/kasugai-canvas-web/unstable/cesium/?kasc=https%3A%2F%2Fyamamoto-ryuzo.github.io%2Fkasugai_canvas_webGIS%2Fdefault%2Fkasugai_canvas.kasc`
   - ドキュメント正本: `docs/datahost.html`（ブラウザ WebGIS）。`weGIS/index.html` はホスト固有の運用ページ
2. **ローカルアプリ（kasugai_canvas.exe :8510）— フル機能**
   - 従来通り開発ビルドまたは配布 ZIP で 8510 起動 → 以降の検証ルールに準拠

## 動作確認（Playwrigh：必須）

- **コードを修正したら必ず動作確認を行う**。構文チェック（`node --check web/cesium/app.js`・`cargo check`）だけで完了とみなさない
- フロントエンドの挙動変更はブラウザで実際に検証する（Playwright + インストール済みブラウザによる自動化を推奨。`applyInspector`・`kasugaiApi`・`vectorAttrWidget.open()` 等を `page.evaluate` で直接叩けば UI 操作なしで検証できる）
- **ブラウザ検証を始める前に、まず Chrome がインストール済みか確認する**。Playwright 管理ブラウザ（`ms-playwright/` キャッシュ）が空でも、`chromium.launch({ channel: 'chrome' })`・`channel: 'msedge'` で OS インストール済みブラウザをそのまま headless 起動できる。Chrome → Edge の順で探し、両方無い場合だけ `npx playwright install` で取得する（重いダウンロードを避け、まず既存ブラウザを使う）
- 検証は「変更した機能が実際に動くこと」に加え、既存機能への影響（回帰）も対象とする
- サーバー側の変更は起動して実リクエスト（curl 等）で確認する
- 検証用の一時ファイル・スクリプトはシステムの temp ディレクトリ（Windows: `%TEMP%`）に置く。`.testtmp/` は gitignore 対象パスのためエージェントのファイル作成ツールで書き込めず、使わないこと（シェルのリダイレクトで生成する分には可）
- **注意**: Git Bash で `>nul` と書くとカレントに `nul` という実ファイルが作られる。これが `web/` 内に残ると Cloud Build の `COPY web` が "operation not permitted" で失敗する（実際に発生）。リダイレクトは `> /dev/null` か `> /tmp/xxx.log` を使う
- **注意**: サーバーは exe と同じディレクトリに `web/`・`projects/` があると `--dir` 指定より優先してそちらを配信する（`resolve_dir`）。`server/target/debug/` 配下に古いコピーが残っていると検証時に編集前の `app.js` が配信されるので、検証前に `curl` 等で配信内容が最新か確認する。また検証前に既存の `kasugai_canvas.exe` プロセスがポートを占有していないかも確認する（占有時は新プロセスが起動失敗し、古いプロセスが応答し続ける）
  - **この古いコピーは自動更新で自動生成される**: 開発ビルドのバージョンが `download/latest.json` より古いと、ブラウザでページを開いた時点の自動更新チェックが exe ごと配布 ZIP に差し替え、`target/debug/web/` にリリース版の古い `web/` を展開する（2026-10-12 に debug 5.12.0 → リリース 5.15.0 で実際に発生）。`target/debug/web` があれば削除してから起動するか、`Cargo.toml` のバージョンを最新化してビルドする（実行バージョン ≥ latest.json なら更新は発火しない）
- **開発モードでの起動ポートは 8510 を優先して使用する**。開発ビルドの `kasugai_canvas.exe`・検証用サーバーは既定の 8510 で起動し、他ポートへは移さない（複数インスタンスの並行確認など特別な理由がある場合のみ例外的に他ポートを使う）。QGIS geo_webview の「KASUGAI」連携や `.kasc` ランチャーのローカル検出も 127.0.0.1:8510 固定で探すため、8510 以外で起動すると連携系の検証が成立しない
- **ポート8510・8511は本プロジェクトの検証用に自由に使ってよい**。これらのポートを占有しているプロセスは、`kasugai_canvas.exe`（ブリッジハブは本体のアプリ内モジュールとして8511を待受）・それ以外の**無関係な別システムを問わず**、明示的な確認なしに強制停止してポートを開放してよい（`taskkill /F`・プロセス kill 等。`/api/shutdown` 等の正常終了を待つ必要はない）。8510 の占有者が旧ビルドの `kasugai_canvas.exe` の場合は新しいビルドで起動し直しておくこと。8511 のブリッジハブはアプリ起動時に自動で立ち上がるため、アプリを再起動すれば復旧する。ユーザーがアプリを操作中でも検証優先でよい

## ドキュメント方針

- 使い方・設定仕様・AI/セキュリティ等のドキュメントはドキュメントサイト（`index.html` 以下の各ページ・GitHub Pages）に集約する
- `README.md` は概要＋開発者向け情報のみ。ユーザー向け情報を二重管理しない

## 言語方針

- **リポジトリの基本言語は日本語**とする。ドキュメント・コードコメント・`web/index.html` のリテラルテキスト（`data-i18n` 適用前の初期表示）は日本語で記述する
- **アプリの翻訳（i18n）の基準言語は英語**とする。`web/cesium/i18n/en.json` がフォールバック辞書であり、`t()` はキー未登録時に en の値を返す
- 新しい翻訳キーを追加するときは `en.json` を正本として先に追加し、全言語の辞書（`web/cesium/i18n/*.json`）でキー数を一致させる
- 対応言語は `web/cesium/i18n.js` の `SUPPORTED_LANGUAGES` で管理。言語追加は同配列と辞書ファイルの追加のみで行う

## UI方針

- **ホバー説明ポップアップ（ツールチップ）のルール**:
  - 表示位置は**対象項目の上**。下に出すと次の項目を覆い隠し、UIが壊れて見える
  - アンカーは各項目を `position:relative` のラッパー（例: `.opt-item`）で包み `bottom:100%` で配置する。**flexコンテナ直下の絶対配置は使わない** — flex子要素の静的位置はDOM位置に関わらずコンテナ先頭に揃うため、全ポップアップが最上部に積み重なる
  - ポップアップには必ず `pointer-events:none` を付ける。ポップアップ越しに上の項目をホバー・クリック・入力できなければならない（表示専用）
  - 実装例: `#display-tiles-panel .opt-item > .hint`（`styles.css`）

### AI 制御可能な UI（必須）

アプリの全 UI 項目は AI（内蔵AIチャット・外部エージェント・`/api/command`。実行は `executeChatTool` に一本化）から操作できることを必須とする。**今後 UI を追加・変更するときもこの条件を満たすこと**。

- **汎用ブリッジが既定経路**: `listUiControls`（操作要素を target/kind/label/value/checked/options/disabled/hidden 付きで列挙）と `controlUi`（target に対し click=押下/トグル・set=値設定・get=現在値取得）が、`button`・`input`・`select`・`textarea`・`a[href]` とタブ属性（`data-panel`/`data-settings-panel`/`data-manage-pane`/`data-manage-sub`/`data-tab`）を持つ要素を自動列挙する。**新しい UI は「安定した `id` またはタブ用 `data-*` 属性を持ち、click/change/input ハンドラで動作する」実装にすれば、ツール追加なしで自動的に AI 制御可能になる**。これが新規 UI の標準形
- **汎用ブリッジが届かないものは専用 API を必ず併設する**。kasugaiApi メソッド追加 + CHAT_TOOLS 宣言 + `executeChatTool` 配線（+ `activeChatTools` のティア絞り込み）をセットで行い、`ai-tools.html` の仕様ミラーも更新すること:
  - `window.prompt` / `prompt()` で値を受け取る操作（DOM から値を入れられないため。**prompt を新たに使う UI は禁止**。プロンプトが必要なら専用 API を用意するかモーダル化する。例: レイヤー行の ⏷ フィルター → `setLayerFilter` で API 化済み）
  - レイヤー行・検索結果・プラグイン一覧など動的生成コンテンツ（行番号が不安定なため列挙対象外。`setLayerVisible`/`focusLayer` のように名前・ID 解決を持つセマンティック API で操作する）
  - 地図キャンバス上のクリック・ドラッグ等の座標操作（`flyTo`/`addFlyPath` 等のセマンティック API で代替する）
  - ドラッグ操作（リサイズ・並べ替え等）。意味のある並べ替え・リサイズは専用 API で状態を変更できるようにする
- **GSI Maps エンジン（`web/gsimaps/`）は本要件の適用を調整中**: vendored 地理院地図を iframe で組み込み `GSI.GLOBALS` 内部 API へ依存する構造のため AI 制御の安定化が難しく、専用17ツール・`data-ui-bridge` 経由の汎用ブリッジは現状ベストエフォート扱いとする
- **ブラウザ仕様上の例外**（AI から完了させられないもの。これらを必須経路にしないこと。例: ファイル選択に代わる DATA/ パス指定や URL 指定の入力経路を併設する）:
  - ファイル/フォルダピッカー（`input[type=file]`・File System Access API）のファイル選択自体 — ピッカーを開く click までは可能
  - OAuth 等の別タブ認証フロー（Box 接続・rclone リモート追加など）
  - ネイティブ `confirm`（安全性のためユーザーの最終判断を残す設計。迂回させない）
- **セキュリティ**: パスワード欄（API キー等）の値は `listUiControls`/`controlUi` get の結果に含めない（AI コンテキストにキーを持ち出さない）。`controlUi`/`setLayerFilter` は runCode サンドボックスからはブロック済み（`CHAT_SANDBOX_BLOCKED_API`）— ツール経由でのみ使え、生成コードからの確認ダイアログ迂回を防ぐ

## サーバー方針

- フロントエンドは静的配信のみで動作させる（`web/` を任意のHTTPサーバーに置くだけ）
- Rust サーバーは静的配信のオプション。独自APIは原則追加しない（例外は「API 方針」参照）
- AI連携はブラウザから外部API（Gemini等）を直接呼ぶ構成とする

## web/ レイアウト（マルチエンジン構成）

`web/` はエンジン別フロントを並べるマルチエンジン構成。geo_webview との役割分担（geo_webview が `.kasc`+`DATA/` を出力し、再生プレイヤーは本アプリが担う）に基づく。

**メインエンジンは CesiumJS（`web/cesium/`）** — これは開発の基本方針。マルチエンジン構成ではあるが、新機能の実装・UI 整備・AI 制御対応はまず Cesium フロントを対象とし、`web/index.html` の既定エンジンも cesium。MapLibre/OpenLayers/Leaflet は `.kasc` プレイヤーとしての互換実装であり、Cesium 側の機能追従は必須ではない。

```
web/
  index.html      エンジン選択リダイレクト（?engine=cesium|maplibre|openlayers|leaflet|gsimaps、
                  既定 cesium。engine 以外のクエリとハッシュは対象へ引継ぎ）
  cesium/         Cesium フロント（現行アプリ一式:
                  index.html/app.js/styles.css/PLUGIN/plugins.json/i18n 等）
  maplibre/       MapLibre フロント（.kasc プレイヤー実装済み: 全ベクター行・QML・duckdb/sql・属性UI・6タブパネル）
  openlayers/     OpenLayers フロント（.kasc プレイヤー実装済み: 同上）
  leaflet/        Leaflet フロント（.kasc プレイヤー実装済み: 同上。専用 pane で
                  .kasc 積み順を再現、回転系設定なし）
  gsimaps/        GSI Maps フロント（中間エンジン: vendored 地理院地図
                  gsi-cyberjapan/gsimaps を同一オリジン iframe(index_pm.html)で
                  組み込み、.kasc を GSI/Leaflet API 経由で再生。上流コードは
                  無改変で維持。vendor 実体(web/vendor/gsimaps/)はリポジトリ・
                  配布物に同梱せず kasugai-canvas-web 側提供へ移行:
                  ローカルに vendor が無い環境では index.html 先頭の検出
                  スクリプトがホスト版 gsimaps(?kasc=<ローカル絶対URL>)へ転送
                  する。vendor の更新は手動運用: vendor.json の sha を上げて
                  publish_cdn.py --vendor で CDN へ反映する(通常発行では
                  sha 差分の警告のみ。ローカルの web/vendor/ は gitignore
                  済みで、手元で動かす場合は tools/fetch_vendor.py で取得)。
                  ※現在調整中: vendored iframe を GSI.GLOBALS 内部 API 経由で
                  操作する構造のため AI 制御の安定化が難しい）
  shared/         エンジン非依存コア置き場（.kasc ローダー・デコーダー・
                  i18n・QMLスタイルコンパイラを段階的に切出し。web/shared/README.md 参照）
  projects/       同梱プロジェクトデータ（静的配信用。エンジン非依存）
    projects.json          プロジェクト一覧マニフェスト（外部登録分はサーバーがマージ）
    DATA/                  （任意）全プロジェクト共有のデータ。`../DATA/x` 参照がここに解決
    <id>/                  プロジェクト（id 単位で複数管理。各プロジェクトは `.kasc`+`DATA/` の組）
      kasugai_canvas.kasc  プロジェクト設定（外部登録は実ファイル名を登録名で保持）
      DATA/                プロジェクト専用データ（.kasc 行の相対参照はこの dir 基準）
```

- **エンジン横断コードは `shared/`、エンジン固有コードは各エンジンフォルダに置く**。新規ファイルの置き場はこの基準で判断する
- 認証・公開パスの許可リストは `/cesium/` 起点（`agent/app/main.py` の `_PUBLIC_PATHS`/`_PUBLIC_PREFIXES`・`workers/worker.js` の `PUBLIC_PATHS`/`PUBLIC_PREFIXES`）。新エンジン公開時は同様に更新する
- `/api/plugins`（プラグイン保存/削除）の対象は `web/cesium/plugins.json`・`web/cesium/PLUGIN/`（プラグイン仕様は当面 Cesium 固有。エンジン横断プラグインは別途設計）
- `sw-duckdb.js` の Service Worker スコープは登録元ディレクトリ（現状 `/cesium/`）。エンジンごとに登録する
- API・データパスは `/api/*`・`/projects/*`・`/health` のルート起点で書く（`./api/` 等のページ相対はエンジン配下で壊れるため禁止）

## web/vendor/（上流スナップショット）の改変禁止

- **`web/vendor/` 配下のファイルは一切改変しない**。上流リポジトリのスナップショットであり、正本は常に上流。`web/vendor/` は **git 管理・配布物（run.py の ZIP・NSIS インストーラー）の対象外**（`.gitignore` 済み）で、`tools/fetch_vendor.py` が `web/<engine>/vendor.json` の sha でピン取得したローカル実体と、kasugai-canvas-web 発行時に `publish_cdn.py` が CDN 側へ配置する発行物のみが存在する
- 挙動を変えたい場合は vendor 側を直さず、組み込み側（中間層 `web/<engine>/` 等）でフック・差し替え・ラップする（例: gsimaps の Globe 起動は iframe の `window.open` を親側でフックして差し替え）
- 上流側の修正・更新が必要なら上流へ PR するか、`vendor.json` の sha を上げて `python tools/fetch_vendor.py` で再取得する。vendor 実体の手編集・部分的差し替えは禁止
- 例外は fetch_vendor が整合記録用に書き込む `VENDOR.json` のみ（上流ファイルではなく自動生成物）

## AI機能のティア分け（実行環境ごとの能力）

AI機能は「操作の影響範囲」でティアを分ける。**誰でも使える公開環境には、その人のセッション内に閉じる安全な機能だけを提供し、永続化・共有・システムへの影響がある機能はローカル環境に限定する**。

用語: **BYO（Bring Your Own）APIキー** = 各ユーザーが自分で発行した Gemini API キーを使う方式。対義はサーバーキー運用（サーバー側 secret の `GEMINI_API_KEY` を使い訪問者はキー不要）。

キーの保管場所とセキュリティレベル:
- BYO キー → ブラウザ `localStorage`（`googleApiKey`）。平文だが localStorage は「ブラウザプロファイル × オリジン」で分離されるため、**同一デプロイにアクセスする他のユーザーからは読み取れず、サーバーにも送信されない**（`agent.sendKeyLabel` opt-in 時のみ例外）。見えるのは同一 OS アカウント＋同一ブラウザプロファイルの操作者と、ブラウザ拡張・XSS 等の同一 JS 空間のみ — 端末・プロファイルを他者と共有しない運用が前提。キー自体を共有 .kasc やコードに書き込むことは禁止
- Devin APIキー → 同じく `localStorage`（`devinApiKey`）。Devin プロバイダの `/agent`・`/models` リクエストに `X-Devin-Api-Key` ヘッダで同梱され、devin-bridge が `devin acp` の `authenticate`（`meta.api_key`）に使う（https/localhost 宛のみ付与・キー変化で acp 再認証）。環境変数 `DEVIN_API_KEY` 経由でも供給可
- サーバーキー → Cloudflare: `wrangler secret put`（暗号化・読み出し不可）/ Cloud Run: Secret Manager 推奨（環境変数でも可）
- ローカル開発の `.dev.vars` → 平文ファイル（gitignore 済み・開発機内限定）

- `static`（静的配信のみ / Cloudflare Pages単体）
  - BYO APIキーでAIチャット・地図操作・`runCode`・`fetchData`(CORS前提)・IndexedDBプラグイン生成が使える
  - ブラウザストレージに閉じるため、訪問者がAIに機能を作らせても他人に影響しない
- `workers`（Cloudflare Pages/Workers 公開環境）
  - `static` に加え、Workers プロキシ経由のAI/fetch（キー隠蔽・レート制限付き）や KV/R2 の共有リソース**読み取り**を許可してよい
  - 共有リソースへの**書き込み**（共有 .kasc・プラグインカタログ等）は認証・承認フローの内側に置く
- `local`（ローカル Rust サーバー）
  - 開発・自己拡張の主戦場。`PLUGIN/` へのプラグイン書き込み・`plugins.json` 更新・ファイル保存・CORS無制限のfetchプロキシ・重い変換処理・QGIS/GDAL連携など高権限機能を許可する
  - 高権限操作（プラグイン公開等）はフロント側で必ず確認ダイアログを挟む

フロントエンドは `GET /api/capabilities`（応答例: `{tier:"local", features:[...]}`）でバックエンドの能力を取得し、ツール定義・UI を出し分ける。バックエンドが無い環境では静的安全機能のみで動作すること。

実装状況: 現在 `local` ティアの `/api/capabilities`・`/api/fetch`・`/api/plugins`・`/api/files`（`projects/<id>/DATA/` への書き込み・一覧・削除）・`/api/mcp`（リモート MCP サーバーへの薄い中継プロキシ。BYO トークン転送のみ・`/api/fetch` と同じ SSRF ポリシー）を実装済み。ブラウザ側は File System Access API による DATA/ 保存も併存（Chromium系のみ・選択フォルダへ直接書込み）。`workers` ティアは `/api/capabilities`（`{tier:"workers"}`）・`/health`・`/api/gemini`・`/api/mcp`（`functions/api/mcp.js`。リモート MCP 中継・BYO トークン転送のみ・https 限定・`MCP_ALLOWED_HOSTS` で接続先制限可）を実装済み（`functions/api/gemini.js`。内蔵AI向けの薄いキー隠蔽プロキシ — ブラウザの generateContent リクエストに `GEMINI_API_KEY` secret を注入して転送するだけで、推論ループ・地図操作はブラウザ側に留まる。`GEMINI_MODELS` で許可モデル制限・`ANTIGRAVITY_RATE_LIMIT`（KV バインド時）対応。Pages Functions でも同パスで動く）。サーバーサイドエージェントは廃止 — 内蔵AI（ブラウザ）が本体であり、外部エージェントを繋ぐ場合はフロントのエージェント窓口から外部実装のURLを接続する構成（本リポジトリにサーバー側実装は同梱しない）。汎用 fetch プロキシ・共有書き込み、QGIS/GDAL 連携は設計方針のみで未実装。Cloud Run 側は `agent/` の FastAPI サービス1つで `web/` 静的配信・認証・GCS 保存・`POST /api/gemini`（Cloudflare 側と同一の内蔵AI向けキー隠蔽プロキシ・`GEMINI_API_KEY` 設定時）・`POST /api/mcp`（同型のリモート MCP 中継・private/loopback への接続は拒否）を提供する（`GET /api/capabilities` は `{tier:"cloudrun", features:["auth","kascWrite","dataStore","aiProxy"?]}` を返す。Cloud Run デプロイは `agent/Dockerfile`・コンテキストはリポジトリ直下・手順は `agent/README.md`。起動制御は `KASUGAI_AUTH_MODE` で `5`（認証のみ・トークン保護の `/api/auth`・`/api/kasc`・`/api/data`＋GCS/`gs://`）・`6`（全ゲート・Cookie）・`7`（IAP）を実装済みで `web/auth-methods.json` の control 値と対応（設計は `agent/AUTH_MODES.md`、フロントは `serverKasc` フラグで保存可否判定）。長時間ループ・SSE は未実装）。外部エージェント呼び出し（管理 → AI → チャット でプロバイダ「外部エージェント」を選びブリッジ欄にエンドポイントURLを設定し、チャット入力を POST `{message,project,camera,layers,history,tools,apiKey?}` → 応答 `{reply,actions:[{name,args}]}` の actions をチャットツールとして実行）はブラウザ側で実装済み — 外部実装の差込口として残置。`tools` は公開中ツールの functionDeclarations 宣言で、エージェント側がツール登録に使う（同梱の `copilot-bridge/` が参照実装 — GitHub Copilot SDK で Copilot を接続。Copilot に直接呼べる公開APIは無いためローカルブリッジ経由が正規ルート）。アプリ版（local ティア）は起動時にアプリ内モジュールの AI ブリッジハブ（`server/src/bridge/`）を 127.0.0.1:8511 に待受けさせる（`BRIDGE_HUB_PORT` で待受ポート変更可・capabilities が実ポートを通知するためブラウザ設定は不要・8511 の占有者がブリッジ（/health で確認）なら強制停止して新版へ差し替え・旧版の常駐ブリッジ残骸（8512/8513）も起動時に掃除）。ハブは `/agent`・`/models` のリクエストを `provider` フィールド／クエリで振り分け、**各プロバイダは必要時に外部 CLI を子プロセス起動するアプリ内実装**（copilot=`copilot --server --stdio`＋github-copilot-sdk 外部ストリーム接続・devin=`devin acp` ACP・antigravity=`agy` headless。Node.js 不要・旧 `bridge-hub/`・`*-bridge/` は手動起動用の参照実装として残置し配布物には含めない）。capabilities は `copilot.endpoint`・`devin.endpoint`・`antigravity.endpoint` をすべてハブの 8511 で通知し、フロントは選択時に「通知エンドポイント → 8511」の順で疎通するブリッジを自動検出する（`KASUGAI_NO_COPILOT_BRIDGE`・`KASUGAI_NO_DEVIN_BRIDGE`・`KASUGAI_NO_ANTIGRAVITY_BRIDGE` でプロバイダごとに無効化可能）。各プロバイダ選択肢は対応する feature 通知がある環境（=アプリ版）でのみ表示し、通常版では選択肢自体を出さない。`bridge/copilot.rs` は GitHub Copilot CLI の stdio サーバーを SDK 経由で駆動（要 Copilot 契約・CLI インストール済み or `COPILOT_CLI_PATH`）、`bridge/devin.rs` は Devin CLI の ACP（`devin acp`、stdio NDJSON-RPC。認証は各ユーザー自身の Devin アカウント — ブラウザ PKCE または `DEVIN_API_KEY`）、`bridge/antigravity.rs` は Antigravity CLI（`agy`）の headless 実行（`--output-format stream-json`・stdin へ `{"event":"user"}` 形式で送信）を駆動する。devin/antigravity の地図ツールはハブの HTTP Streamable MCP エンドポイント（`/mcp`・`/mcp/<project>`）経由でエージェントに公開し（antigravity は `agy mcp add` で `kasugai` サーバーをグローバル登録・`permissions.allow` に `mcp(kasugai/*)` を追加）、ツール呼び出しはキューイングして actions として返す（実行はブラウザ側）。antigravity の会話はプロジェクト単位で `--conversation` により継続される。認証は各ユーザー自身の Google アカウントでの agy ログイン。内蔵AIはプロバイダ切替式で、Gemini（BYO/`/api/gemini`）に加え OpenAI互換（`openaiApiKey`/`openaiBaseUrl`/`openaiModel`。GitHub Models・OpenAI・Ollama等の chat/completions 互換）を選択可能。外部エージェントが返す actions も同じ実行経路のため、破壊的ツール（`savePlugin`/`publishPlugin`/`deleteDataFile` 等）はフロント側の既存確認ダイアログで保護される。さらに `local` ティアではリモートコマンド中継 `/api/command` を実装済み — 外部プロセス（Devin Desktop 等のローカルエージェント）が `POST /api/command` で `{name,args}`（または `{commands:[...]}`）を投入すると、ブラウザが `GET /api/command?since=<id>&wait=<秒>` のロングポーリングで受信して `executeChatTool` と同じ経路で実行し、結果を `POST /api/command/results` で返す。外部は `GET /api/command/results?since=<id>&wait=<秒>` で回収する。capabilities は feature `remoteCommand` を通知し、ブラウザは起動時の初回ポーリングで `latest` に同期するためページ読込前の滞留コマンドは実行されない。確認ダイアログ付きの破壊的ツールも同様に保護される。**ツールの整備は双方で行うこと**: 利用可能なコマンド名・引数の正本はチャットツール宣言（`activeChatTools` の functionDeclarations）と実行実装（`executeChatTool`）の両方であり、Gemini function calling・外部エージェント actions・リモートコマンド経路はいずれもこの同一実装を共有する。ツールを追加・変更する際は必ず宣言と実行実装をセットで更新し、どの経路から呼ばれても同じ動作になるよう保つこと（経路ごとの個別対応表は持たない）。

### エージェント連携経路（2方向）

```
【エージェント → ブラウザ】（外から操る）…… 共通・1本（アプリ本体 :8510）
  Devin Desktop ─┐
  Copilot CLI  ──┼─ POST /api/command ─→ ブラウザが long-poll 受信
  任意のcurl  ───┘      ↓ executeChatTool（確認ダイアログ保護も共通）
                   POST /api/command/results ← 実行結果を回収

【ブラウザ → エージェント】（チャットから使う）…… I/F共通・ハブが1本だけ遅延起動
  Canvas チャット ─POST /agent {provider,message,tools,...}→ bridge-hub (8511)
       ├─(内部8521) copilot-bridge     → @github/copilot-sdk    → Copilot
       ├─(内部8522) devin-bridge       → devin acp (ACP)        → Devin
       └─(内部8523) antigravity-bridge → agy (stream-json +MCP) → Antigravity
```

- **外向き（エージェント→ブラウザ）**: `/api/command`（local ティアのみ・capabilities feature `remoteCommand`）はエージェント中立の中継キュー。エージェント識別フィールドは持たず、Devin・Copilot・任意スクリプトが同一エンドポイント・同一形式 `{name,args}`・同一実行経路（`executeChatTool`）・同一結果回収（`/api/command/results`）を使う。新たなエージェントの接続に追加実装は不要
- **内向き（ブラウザ→エージェント）**: プロトコルは共通（POST /agent → `{reply,actions:[{name,args}]}`）だが、エージェント固有の呼び出し部はブリッジ別実装（`copilot-bridge/`・`devin-bridge/`・`antigravity-bridge/`）。アプリ版ではアプリ内モジュール `server/src/bridge/`（8511）がプロバイダを振り分ける。新規エージェントはこのプロトコルに合うプロバイダ実装を `bridge/` に1本追加し、mod.rs の `PROVIDERS` に登録する形で接続する
- 両方向ともブラウザ側の実行は `executeChatTool` 一本に集約され、ツール正本は `activeChatTools`（宣言）+ `executeChatTool`（実装）。Gemini function calling・外部エージェント actions・リモートコマンドは全て同じツール群を共有する（**ツール追加・変更時は宣言と実装をセットで更新すること**）

プラグインの昇格ルート: AI生成プラグインはまず IndexedDB（ブラウザローカル草稿）に保存 → `.kasp` でエクスポート可 → レビュー後にローカル版で `PLUGIN/` へ公開。これにより開発と公開、公開と非公開を分離する。

## API 方針

- フロントエンドは静的ファイル（`web/`）のみで動作する前提で実装する
- Rust サーバーは原則として静的ファイル配信のみとし、独自 API は追加しない
- ただし以下はこの制限から除く:
  - バージョンアップ関連の API (`/api/update/*`)、アプリ終了用の `/api/shutdown`、起動確認用の `/health`
  - **ローカル開発向けの高権限 API**: `/api/capabilities`（能力通知）、`/api/fetch`（CORSプロキシ）、`/api/mcp`（リモート MCP 中継。`/api/fetch` と同じ SSRF ポリシー）、`/api/reinfolib`（不動産情報ライブラリ API 中継。`https://www.reinfolib.mlit.go.jp/ex-api/external/` 配下限定・`Ocp-Apim-Subscription-Key` はクライアント BYO ヘッダまたは環境変数 `REINFOLIB_API_KEY` を注入）、`/api/plugins`（PLUGIN/ へのプラグイン書き込み・削除）、`/api/files`（`projects/<id>/DATA/` へのファイル書き込み・一覧・削除）。これらはローカルサーバー（127.0.0.1）前提の機能であり、公開環境（Pages/Workers）では無制限の書き込み・fetchを無認証で提供してはならない
  - `/api/fetch` は SSRF 対策としてプライベート/ループバック/リンクローカル等への接続を既定で拒否する（ホスト名は名前解決してIPで判定）。LAN内データソースは exe 隣の `kasugai_canvas.fetch.json` に `{"allow":["192.168.0.0/16","my.server.local","127.0.0.1"]}` のように許可リスト（ホスト名・個別IP・IPv4 CIDR）を書いて有効化する。`/api/mcp` も同じ判定を使う
- 地図タイル・検索等の外部 API へのアクセスは、ブラウザから直接呼ぶか、CORS 対応を前提とする

## プロジェクト構造（標準・外部・共有データ）

- **システム本体**は `kasugai_canvas.exe` + `web/` の2つ。プロジェクトは `projects/<id>/`（`kasugai_canvas.kasc` + `project.json` + `DATA/`）で複数管理。プロジェクト一覧は `projects/projects.json`、フロントは `./projects/<id>/kasugai_canvas.kasc` を読む
- **`?kasc=<url>` 直読みモード（単独WEB配信）**: 全エンジンは `/<engine>/?kasc=<.kascのURL>` で任意 URL の .kasc を直接読める。`DATA/` 等の相対参照は .kasc のある URL 基準で解決され `projects/` 構造は不要 — `.kasc`+`DATA/`+起動 HTML のフォルダと `web/` の中身を同じ静的サーバーへ置くだけでサーバレス配信になる（登録 API 不要）。geo_webview のエクスポートは `<engine>.html`（自動探索 + `CANVAS_BASE` 上書き可）と `index.html`（リンク一覧）を .kasc と同じ場所に出力する。`?kasc` と `?project` は排他（実プロジェクト選択で kasc モード解除）。共有 `..` 参照はブラウザの URL 正規化で祖先へそのまま解決（`@parent` 非対応の静的経路のため）。ランチャーを `file://` で開いた場合は起動中のローカルサーバーへ `POST /api/projects/register` で登録して `?project=` 起動する（`local_api_cors` が `/api/*`・`/health` にのみ `ACAO:*` を付与 — 外部オリジンから localhost API が読める点は留意）。別経路として **`?kasc=local`**（leaflet/maplibre/openlayers のみ）は File System Access API で選択したローカルフォルダの `.kasc`+`DATA/` を `localfs:///` 疑似URL + fetch シム（`shared/localfs.js`）で読む — ホスト版エンジンがローカルフォルダを直接開ける（CDN ライブラリと同じ「アプリはホスト・データはローカル」の構造）。フォルダハンドルは IndexedDB 永続化。Chromium 限定・フォルダ外参照不可・ローカルXYZタイルは未対応。cesium は Resource/XHR 層のため対象外
- **外部プロジェクト**（ローカルサーバー版のみ）: `.kasc` ファイルの関連付け起動・`POST /api/projects/register` で、インストール外の任意フォルダをプロジェクト化する。登録は exe 隣の `kasugai_canvas.projects.json` に永続化され、`GET /projects/projects.json` で静的定義にマージ（`external:true` 付き）して返す。`GET /projects/<id>/*` は登録フォルダから配信し、`kasugai_canvas.kasc` 要求は登録した実ファイル名にマップ（ファイル名は自由）。納品フォルダ（`.kasc` + `DATA/`）をそのまま開ける設計。`DELETE /api/projects/{id}` で登録解除
- **共有データ（`..` 参照・階層スコープ）**: 相対URLの `..` はプロジェクトフォルダの1階層上を指し、祖先に `projects.json`（プロジェクト群マニフェスト）を持つフォルダが連続する限り追加で1階層ずつ上に出られる（群 → ワークスペースルート）。通常プロジェクトは `../DATA/x` がブラウザのURL正規化で `projects/DATA/`（全プロジェクト共有）に解決される。外部プロジェクトは `..` をマーカー `@parent` に置き換えて送信し、サーバーが登録フォルダの祖先基準で解決する（WHATWG のURL正規化は `%2E%2E` も畳むため、`..` をそのまま送る方法は存在しない点に注意）。マニフェストが無い構造では1階層上まで。納品推奨構造: `納品/{DATA, ProjectsA/{projects.json, P1,P2}, ProjectsB/{projects.json, P3}}`（`DATA/`=プロジェクト専用、`../`=群内共有、`../../`=全群共有）。通常プロジェクトへの `..` 到達・`/api/files` の DATA/ 書き込みでの `..` は従来通り拒否
- **群マニフェストによる一括登録**: `.kasc` 登録時に親フォルダの `projects.json` を検出した場合、マニフェストのエントリ `{id,title,dir?,kasc?}`（dir 省略=id 名のサブフォルダ、kasc 省略=フォルダ内の最初の .kasc）に従い群内の全プロジェクトをまとめて登録する。`/api/projects/register` の応答 `registered` に全 id が返る。冪等（同じ dir+kasc は既存ID再利用）。群メンバー側からの再帰的な群展開はしない（ネストした群はその .kasc を直接開いた時のみ展開）
- `/api/files`・`/api/cloud/localize` 等のプロジェクト系 API は `resolve_project_dir` で標準・外部を透過的に解決する
- **納品用ローカル化の出力**: `POST /api/cloud/localize {project,scope}` は元プロジェクトを変更せず、兄弟に `<dir名>_local/` ワークスペース（群マニフェスト `projects.json` + プロジェクト複製 + `DATA/`）を毎回作り直す。`scope` は `shared`（既定、`_local/DATA/`・`../DATA` 参照）または `project`（`_local/<dir>/DATA/`・`DATA` 参照）。複製元のローカル DATA/・親の共有 DATA/ は `DATA/local/` に集約し、既存参照は `DATA/local/x`・`../DATA/local/x` に書き換える（生成物 http/・cloud/ と混在させない）。HTTP(S)の保存先は `http/` に統一し、クラウドは `cloud/<取得元ハッシュ>/`。`3dtiles:` 行のリモート URL は `tileset.json` から `content.uri`/`contents[].uri` を辿りツリーごと `http/3dtiles/<name>/` に取得する（対応は `http/_sources.json`）。`xyz:` 行のリモート `{z}/{x}/{y}` テンプレートはタイル本体を取得せず受け皿 `http/xyz/<name>/` のみ生成して参照をローカルテンプレートに書き換え（タイルはユーザーが配置。`base:` は対象外）（ルート外参照は `_ext/` に集めて参照元 JSON を書き換え。ベースマップ相当のサービス= `tile.googleapis.com`・`assets.cesium.com`・`api.cesium.com`、および implicit tiling は対象外で URL を残す。上限は1タイルセット 10,000 ファイル）。出典一覧・既存ファイルを照合して同名衝突を回避し、処理を直列化する。通常の `/api/files` 保存は従来通り専用DATA内のみ。
- **納品データと内部IDの分離**: SQLを含むローカル化参照は `../DATA/http/...` または `DATA/http/...` の相対パスで保存。SQLのファイル参照は描画・属性検索時に `resolveProjectSql` で解決する。画面・API用内部IDは維持するが納品ファイルへ埋め込まない。群マニフェストは `dir` 指定時に `id` 省略可能。群を先に登録して起動対象にもマニフェストの表示名を適用する。
- ローカル化の回帰テストは `cargo test --bin kasugai_canvas localize_tests`。保存先・再実行時衝突・SQL相対出力・群登録を含む。

## データ形式方針

CesiumJS ネイティブ非対応の形式は、**「ブラウザ側でデコード → GeoJSON へ正規化 → 既存のベクター描画経路（`GeoJsonDataSource`）に流す」**を基本ルールとする。これによりレイヤ一覧・表示切替・フォーカス・ベクトル検索・属性パネルが新形式でも自動的に機能する。

### 経路の分類

- **ネイティブ経路**: `3dtiles:` / `geojson:` / `xyz:` など CesiumJS が直接読める形式
- **GeoJSON 正規化経路**: 非対応形式をデコーダーで GeoJSON 化して同じ DataSource 経路に乗せる。デコーダーは `web/cesium/app.js` の **`vectorDecoders` レジストリ**（type→`async (item) => GeoJSON` の Map）に登録する
  - 実装済み: `geoparquet:`（`loadGeoParquetAsGeoJson()`。hyparquet を CDN から遅延ロード、WKB/ネイティブ GEOMETRY 型の両方を GeoJSON ジオメトリに変換。**常に全件読み込み**で絞り込みは持たない。「Parquet をそのまま置くだけで表示」の利便性重視の経路で、中規模までが目安）
  - 実装済み: `flatgeobuf:`（`loadFlatGeobufAsGeoJson()`。flatgeobuf 公式 JS リーダーの geojson サブモジュールを CDN から遅延ロードし、レスポンスボディを ReadableStream のまま `deserialize` で逐次 GeoJSON Feature 化。空間インデックスによる範囲読みは持たず**全件読み込み**だが、全件バッファリングはしない）
  - 実装済み: `gpkg:` / `geopackage:`（`loadGeoPackageAsGeoJson()` → **`web/cesium/gpkg-worker.js`** の module Worker に委譲。sql.js(SQLite WASM)を Worker 内で CDN から遅延ロードし、GPKG を SQLite として直接開く。fetch・DB 展開・WKB デコードが別スレッドで走るため大量地物でも地図操作をブロックしない。開いた DB は Worker が url キーで保持し、再クエリは再ダウンロード無しで走る。GPkgBinary ヘッダを剥がして WKB→GeoJSON ジオメトリに変換。`table=` で複数地物テーブルから対象を選択可。**絞り込みオプション**: `where=`（SQLite 式）/`limit=`/`columns=`（属性列プルーニング）/`bbox=auto`（**sql.js のビルドには rtree モジュールが無い**ため、各行の GPkgBinary ヘッダ内エンベロープを読んで JS で表示範囲判定し、範囲外地物の WKB デコードをスキップ。`camera.moveEnd`/`camera.changed` で再クエリ）。**`bbox=auto` は既定 ON**（`bbox=off` で明示解除すると全件読み込み系に戻る）。クエリ系扱い（`query` が item 判定関数。`isQueryDecoder()` が全使用箇所で評価）となり、⏷フィルター編集・検索索引からの除外・属性一覧の全件クエリ（`queryGpkgAttributeRows()`。行位置は GPkgBinary エンベロープの中心。エンベロープ非保持の地物は WKB デコードした座標範囲の中心にフォールバック）が有効になる。QGIS が「データベースに保存」する `layer_styles` テーブルの QML を読み取り `useAsDefault` を優先して `item.qmlStyle` に適用（`style=` 明示指定が優先）。**DuckDB spatial の `ST_Read` は非COI環境でスレッド生成に失敗しリモート URL も読めないため GPKG には使わない**。`duckdb:` で `.gpkg` 拡張子または `format=gpkg` を指定した場合も同関数へ振り分け（`isGpkgBackedItem()` で判定し属性一覧も同経路）。ファイル全体を初回ダウンロードするため超大規模 GPKG は不向き）
  - 実装済み: `duckdb:` / `sql:`（`loadDuckDbLayerAsGeoJson()` / `loadDuckDbQueryAsGeoJson()`。DuckDB-WASM を CDN から遅延ロードし、SQL で絞り込んでから GeoJSON 化。`duckdb:` はファイル+`where=`/`limit=`/`geom=`/`lon=`・`lat=`/`format=`/`columns=`（属性列プルーニング）/`covering=`（xmin,xmax,ymin,ymax 列名）/`bbox=auto`（**既定 ON**。`bbox=off` で常時全件描画に解除）/`render=`/`proxy=on`（ローカルサーバーの `/api/fetch` 経由取得。Range/HEAD 転送対応・`fetchRange` 能力があるバックエンドでのみ有効。CORS 回避用の opt-in）の宣言的指定。ジオメトリは WKB バイナリで受領し、`bbox=auto` 時は GeoParquet 1.1 `covering` bbox 列への範囲述語を優先して row group 統計スキップを効かせる。`sql:` は任意の SELECT 文（`:bbox` プレースホルダで表示範囲連動・末尾 `| off` / `| render=entity` / `| render=primitive` / `| attr=出典` をオプションとして末尾から順に解釈。`attr=` の値に `|` は含められない）。spatial 拡張があれば WKT・ST_Read・空間述語も利用可、無くても WKB/GeoJSON テキストと lon/lat ポイント化は動作する）
    - **設計方針: 「検索は常に全件検索・表示はバッファの表示範囲のみ」**。クエリ系レイヤーはベクター検索パネル（読み込み済み GeoJSON/entity の索引）の対象外で、検索はファイル全件を対象とする SQL フィルター(⏷)に一本化する。属性値一覧ウィジェットにもクエリ系レイヤーは選択肢として出る（選択肢は索引ではなくレイヤー一覧から直接構築）し、一覧内容は `queryDuckDbAttributeRows()` が DuckDB に直接クエリして全件対象（bbox 非適用・`where=` 適用・位置は `ST_Centroid` または lon/lat 列）で取得する。`bbox=auto`+`where=` 併用時は `where=` のみの `COUNT(*)` を併走し「検索ヒット全 N 件 / 表示範囲内 M 件」をコンソールに出す。描画は既定で entity（`GeoJsonDataSource`・地形ドレープ可）で、`render=primitive` で `GeoJsonPrimitive` バッチ描画（entity 非経由・大量地物向け）に opt-in 可能。**注意**: `GeoJsonPrimitive` は `CLAMP_TO_*` 時に `scene.vectorProvider`（地形タイル焼き込み）へ回され `scene.pick` で拾えなくなるため、primitive 描画は常に `HeightReference.NONE`（ドレープ非対応。地形ありで埋まるため既定は entity としている）
  - **スタイル `style=` は全ベクター系行タイプで共通**: `style=QMLファイルURL` で QGIS レイヤースタイル(.qml・QGIS4以降対象)を適用する。パース・式評価・シンボル/ラベル/パターン生成は `web/cesium/qml-style.js` に集約し、`loadQmlStyle`(URL) / `compileQmlStyle`(テキスト) → `applyQmlStyleToDataSource`(entity) / `applyQmlStyleToPrimitive`(primitive・BufferMaterial を featureId 単位で適用) で両描画経路に乗せる。スタイルは共有 GeoJSON キャッシュを汚さないよう entity/primitive に直接適用する。QML 取得・コンパイルは `ensureQmlStyle()` が `qmlStyleCache`(URL キー・applyInspector で破棄)で遅延実行し、非表示レイヤーは読まない。レンダラがシンボルを返さない feature は非表示(QGIS 準拠)
  - クエリ系形式（`query` フラグ）は再クエリ対応: レイヤー一覧の ⏷ ボタンで WHERE 式/クエリを対話的に変更（`editLayerQueryFilter` → `reloadVectorLayer` で DataSource 差替え・`.kasc` 行にも反映）、`bbox=auto`/`:bbox` は `camera.moveEnd`/`camera.changed` デバウンスで表示範囲を再クエリする（`refreshViewportLayers`）。`query` は真値（常にクエリ系）または item 判定関数（条件付きクエリ系）を取り、判定は `isQueryDecoder()` に集約。gpkg:/duckdb: は `bbox=auto` が既定 ON のため通常クエリ系になる（`bbox=off` 明示の gpkg: のみ全件読み込み系としてキャッシュ・検索索引の対象のまま）
  - **描画方式 `render=` は全ベクター系行タイプで共通**: `geojson:`/`layer:`/`geoparquet:`/`flatgeobuf:`/`duckdb:`/`sql:` すべてで `render=primitive|entity` を指定できる（既定 entity。primitive は `GeoJsonPrimitive.fromGeoJson`+`HeightReference.NONE` のピック可能なバッチ描画）。レイヤー行の明示指定は設定タブの「ベクター高速ドレープ」グローバル設定より優先され、`render=entity` で個別に entity へ逃がせる。高速ドレープ ON 時は全件読み込み系が `GeoJsonPrimitive`+`CLAMP_*` で描画される（ピック対象外だがベクター検索は保持した GeoJSON から索引されるため利用可。クエリ系は `render=` で個別管理するため対象外）
  - **ベクター描画件数上限（`#vector-entity-limit`・既定 20000・0/空欄/不正値=無制限）**: entity 描画ベクターの**合計**件数バジェット（フリーズ防止の安全弁）。`refreshLayers` で描画順に残枠を減算し、entity 構築前に `features` を切り捨てる（`limitGeoJsonFeatures`。`vectorSourceCache` の共有ソースは浅いコピーで非破壊のため上限解除で全件復帰）。primitive 経路は entity コストを支払わないため対象外。`reloadVectorLayer`（⏷フィルター・`bbox=auto` 再クエリ）にも同じ上限を適用。切り捨てたレイヤーは `item.entityLimited` に `{shown,total}` を保持し一覧に `shown/total` バッジを出す。**切り捨ては描画のみ**: フルソースを `item.geojsonSource` に保持するため、ベクター検索索引・`getLayerGeoJson`・属性一覧は常に全件対象（「検索は常に全件検索」の設計方針と一致）
  - **非クエリ系の表示範囲連動スライス（`item.viewportSliced`）**: バジェットを超える非クエリ系レイヤー（`geojson:`/`geoparquet:`/`flatgeobuf:` 等）は、切り捨てを「ファイル先頭N件」ではなく**表示範囲内の地物優先**にする（`sliceSourceToView`。地物ごとの外接矩形は `item._envCache` に Float64Array でキャッシュし、判定は矩形比較のみ）。さらに `camera.moveEnd`/`camera.changed`（デバウンス・実行中イベントはキューで取りこぼさない）の `refreshViewportLayers` で `resliceViewportLayer` がメモリ上のフルソースから再スライスして DataSource を差し替える（再取得・再デコード無し・新 ds を追加してから旧 ds を除去して空白を最小化）。描画地物集合が前回と同一なら再構築をスキップする（ピッチ矯正 setView の追発火や moveEnd/changed 二重起動の吸収）。これにより「広域=切り捨て・拡大/移動先=範囲内全表示」が非クエリ系でも成立する。バッジの total は**フルソース全件数**基準（表示範囲外で0件描画でも `0/N` でデータ残存を示す）。クエリ系はクエリ側の `bbox=auto` が担うため対象外。プラグインの `entities` レイヤーはバジェット対象外（`refreshLayersImpl` と同じ基準）
  - **非表示ベクターレイヤーはロードしない・初回のみ取得**: `geojson:`/`geoparquet:`/`flatgeobuf:`/`duckdb:`/`sql:` とも `visible=false` なら `refreshLayers` でロード（ダウンロード・デコード）をスキップし、表示ON・属性値一覧やベクター検索パネルからの選択・⏷フィルター変更のタイミングで初めて取得する（クエリ系は起動時に重い WASM 初期化で他ベクターのロードをブロックしないためでもある）。全件読み込み系のダウンロード＋デコード結果は `vectorSourceCache`（id|url キー、`loadVectorSourceCached()`）にメモリ保持し、2回目以降の `refreshLayers`（表示切替・ドレープ変更等）や属性値一覧では再取得しない。キャッシュは `applyInspector`（インスペクター/プロジェクト変更）で破棄。クエリ系は条件ごとに結果が変わるためキャッシュ対象外。WASM 初期化の先行開始は `refreshLayers` 先頭でバックグラウンドに行うが、**表示対象のクエリ系があるとき、または SW キャッシュに資産が揃っているとき**（`duckDbAssetsCached()` で判定。キャッシュ済みならディスク読み込みのみで安いため非表示分も温めて選択を即応答にする）。全て非表示かつ未キャッシュ（実質初回）なら初期化自体を行わない。属性値一覧のレイヤー選択肢は検索索引ではなくレイヤー一覧（`getOrderedLayerItems()` ベースのベクター系レイヤー全件）から即時構築するため、ロード完了を待たずに全レイヤーが選択肢に出る。非クエリ系で未ロードのレイヤーを選択した場合は `vectorAttrLoadCache` 経由でオンデマンドにファイルを読み、索引更新（`updateVectorSearchUI` → `uiHooks.refreshVectorAttrWidget`）で行も追従する。ベクター検索パネルのレイヤー選択肢も同じ方式で、索引済みレイヤーに加えて未ロードの非クエリ系レイヤーを「(未読込)」付きで列挙し（`getVectorSearchPendingLayers()`）、選択された時点で `loadVectorSourceCached()` で読み込み→`vectorSearchLoadedSources` に保持→再索引する（クエリ系は選択肢にも出さない）。「全選択」の文字検索は実行時に未ロード分を `ensureAllVectorSourcesIndexed()` でまとめて読み込むため非表示レイヤーも対象。表示中レイヤーのみを対象にする「表示レイヤ」（`__visible__`・`getVisibleIndexedLayerIds()`+`aggregateVectorSources()`）も選択肢に出す
  - `duckdb:`/`sql:` 経路で既に扱えるもの: Parquet/GeoParquet（`format=parquet`・本来の対象）・CSV/TSV（`format=csv`・lon/lat ポイント化）・JSON/GeoJSON テキスト（`format=json`）・GeoPackage（`.gpkg`/`format=gpkg` は `loadGeoPackageAsGeoJson` の sql.js 経路へ自動振り分け。`ST_Read` は非COI環境でスレッド生成に失敗するため使わない）・Shapefile/FlatGeobuf 等（`format=read` の `ST_Read`。`.fgb` は spatial 拡張の置換スキャンが拡張子から自動判別するため `format=` 省略でも読める）。`format=` 省略時は拡張子から自動判別。非 parquet 形式は全件読み込みだが「絞り込み分だけ描画オブジェクト生成」「SQL 加工」「変換不要」の利点は共通
  - 将来候補: KML 等（FlatGeobuf は `flatgeobuf:` として実装済み。Range Request 範囲読みの活用は将来の拡張ポイント）
- **タイル/大規模経路**: MVT・PMTiles・ラスタタイル等。全件描画や LOD が必要な大規模データ向けで、GeoJSON 正規化とは別経路を検討する

### 属性パネル（地物クリック）

- 左クリックは `scene.drillPick`（上限16件・手前から順）で重なった地物を全件拾い、`describePicked()` が3経路（`Cesium3DTileFeature` / `GeoJsonPrimitive` の pick オブジェクト / entity）を `{item,entries}` に正規化する
- 複数件時はヘッダー一覧（`番号. グループ / レイヤー名`）のみ表示し、行クリックで属性テーブルを開閉するアコーディオン。展開した地物のレイヤーが `#attr-content` の `dataset.layerId`（「選択中のレイヤ属性一覧」対象）になる。1件のみなら最初から展開
- 同一地物の重複ヒットは `pickedDedupKey()` で除外（entity は id、GeoJsonPrimitive は共有 properties 参照、3D Tiles feature は content+featureId）
- **注意**: `Cesium3DTileFeature` のプロパティ列挙は `getPropertyIds()`（構造化メタデータ系には `getPropertyNames()` が無い）

### 新形式を追加する手順

1. `applyInspector` のパースに行タイプを追加する
2. デコーダー関数を1本に閉じ込める（`loadXxxAsGeoJson(item)` の形。返り値は GeoJSON FeatureCollection）
3. `vectorDecoders` Map に `{ load: item => loadXxxAsGeoJson(item) }` を登録する（`refreshLayers` の geojson 分岐・`orderedOtherLayers` フィルタ・`updateInspectorFromLayerOrder` の種類一覧はレジストリ参照のため変更不要。条件変更・再クエリに対応する形式は `query: true`（常時）または `query: item => 条件`（条件付き）を付けるとフィルター UI の対象になる）
4. `inspector.html` のインスペクター設定仕様に書式を追記する

### 形式の使い分け

ベクター系の行タイプは大きく2系統に分かれる（コード上は `vectorDecoders` の `query` フラグがこの区別）:

- **全件読み込み系**（`geojson:`・`geoparquet:`・`flatgeobuf:`）: ファイル全件を読み込んで描画。ベクター検索パネルの対象（読み込み済み GeoJSON/entity の索引。未ロードは選択時にオンデマンド読み込み）
- **クエリ系**（`duckdb:`・`sql:`）: SQL で絞り込み、表示は見えている範囲のみ・検索は常にファイル全件対象。ベクター検索パネル対象外で、検索は SQL フィルター・属性値一覧の全件クエリに一本化

Parquet の利点（圧縮・述語プッシュダウン・row group スキップ・列プルーニング・Range Request）は「読まない部分を作れる」ときにだけ効く。全件読み込みでは Parquet は「もう1ステップある GeoJSON」に過ぎないため、条件・規模に応じて経路を選ぶ:

| 条件・規模 | 推奨経路 | 理由 |
|---|---|---|
| 小〜中規模・全件表示 | `geojson:`（事前変換） | 最速・最単純。ブラウザは `JSON.parse`+entity 化のみ |
| 中規模・Parquet をそのまま | `geoparquet:` | 変換不要で置くだけの利便性重視 |
| 中規模・FlatGeobuf をそのまま | `flatgeobuf:` | 変換不要・ストリームで逐次デコード |
| 大規模・広範囲・絞り込み | `duckdb:`/`sql:` | Parquet の利点が発揮される（`bbox=auto`・`where=`・`columns=`） |
| 超大規模・全件表示 | タイル化（MVT/PMTiles 等） | GeoJSON 正規化とは別経路 |

### 方針上の注意

- **デコーダーは軽量ライブラリ優先**（CDN の ESM を動的 import）。DuckDB-WASM のような重いエンジンは本体に置くが**遅延ロード必須**とし、使用時までコストを発生させない。DuckDB-WASM の CDN 資産（~60MB）は `web/sw-duckdb.js`（Service Worker + CacheStorage）で永続キャッシュするため、実際のダウンロードはバージョンごとに初回のみ。SW は DuckDB CDN URL のみを対象とし、バージョンは `sw-duckdb.js` の `CURRENT_ASSET_MARKERS` と `app.js` の `DUCKDB_WASM_VERSION` で同期管理するプラグインではなく本体に置く理由: `.kasc` の行タイプはプロジェクトファイルの可搬性のため本体実装が必須であり、現プラグイン機構は `applyInspector` の行タイプを拡張できないため。プラグインからの decoder 登録（manifest での形式宣言＋遅延リフレッシュ）は将来の拡張ポイントとする
- **全件読み込みが前提**のため、デコードは数万〜10万地物規模を目安とする。それを超える大規模データはタイル経路（別形式への事前変換）か、`duckdb:`/`sql:` で事前に絞り込んで扱う
- **プロパティの型変換**はデコーダー側で行う（BigInt→Number/String 等。共通ヘルパー `sanitizeVectorPropertyValue` を使う）。GeoJSON 側に渡す properties は検索・一覧がそのまま動く形に整形する
