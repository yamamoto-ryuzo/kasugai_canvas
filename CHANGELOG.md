# Changelog

このファイルでは、KASUGAI Canvasの変更履歴を管理します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を使用します。

## [6.5.4] - 2026-10-30

### Fixed

- **copilot CLI がモデル一覧を返さない（未ログイン等）環境で、固定フォールバック一覧が実在する一覧のように表示される問題を修正**（`server/src/bridge/copilot.rs`・`web/shared/ai-chat.js`）— ハブは fallback 使用時に `fallback:true` を返し、フロントは接続失敗としてステータス欄に「モデル一覧を取得できません（CLI ログイン確認）」と表示して選択肢を既定のみにする。`/models` の `error` 応答も全プロバイダで接続失敗（赤・NG）として扱うよう統一

## [6.5.3] - 2026-10-30

### Fixed

- **「ハブを自動インストール」ボタンが待機中に反応しない問題を修正**（`web/shared/ai-chat.js`）— 起動待機ポーリング中の再クリックがガードで握り潰され、再DLも再案内もできなかった。クリック毎に exe DL を発火し待機状態を更新するよう変更（ポーリングは1本に維持）
- ハブ案内の文言を「ハブ＋CLI（copilot/devin）も自動インストール」に修正（8言語）— exe 実行で CLI まで入ることが分かりにくかった

## [6.5.2] - 2026-10-30

### Fixed

- **ブリッジハブ未導入環境でブリッジ系プロバイダの選択肢が一切表示されない問題を修正**（`web/shared/ai-chat.js`）— Copilot/Devin/Antigravity はハブ検出時のみ選択肢に出す仕様だったため、ハブ未導入の PC では「選択 → 自動インストール」の導線に永遠に入れなかった。設定画面では常時表示とし、選択 → ハブ未検出で自己インストール exe の自動 DL＋起動待機が始まる流れに統一（利用可否の絞り込みはチャット側ドロップダウンが担う）

## [6.5.1] - 2026-10-30

### Changed

- **`bridge-hub.exe` の自己インストールにブリッジ用 CLI 自動導入を統合**（`server/src/bin/bridge-hub.rs`）— `--install`・裸実行時に、ハブ起動後そのまま `--setup all` 相当で copilot/devin の未導入分を自動インストールするよう変更。「exe 実行1回でハブ＋CLI まで」が既定動作になり、CLI 導入は `--no-cli-setup` で省略可能。併せて、起動前に 8512 を占有する旧ハブを `/health` の `hub:true` で確認して停止・置き換える処理を追加（無関係な占有者は kill せず警告のみ）

## [6.5.0] - 2026-10-30

### Added

- **ブリッジハブの自己インストール型 exe 化**（`server/src/bin/bridge-hub.rs`・`download/bridge-hub.exe`）— 単体 exe をダウンロードして実行するだけで `%LOCALAPPDATA%\kasugai\bridge-hub\` への自己コピー・ログイン時自動起動登録・`127.0.0.1:8512` での非表示起動まで完了（管理者権限不要）。`--install`/`--serve`/`--uninstall`/`--setup` の明示サブコマンドを持ち、タスク登録が拒否される環境ではスタートアップフォルダへフォールバック。ブラウザ WebGIS での導入が「DL→実行」の2操作に短縮
- **ハブの `/setup` API**（`server/src/bridge/setup.rs`）— `GET /setup`（各プロバイダ CLI の検出状況・自動化可否）・`POST /setup`（公式手順の自動インストールをジョブ実行）・`GET /setup/job/<id>`。copilot は winget→npm→GitHub Releases 直接DL の順にフォールバック、devin は公式インストーラで導入。POST は loopback＋既知デプロイホストの Origin のみ受理。`bridge-hub.exe --setup` で CLI からも同機能を実行可能
- **AI 設定画面の「CLI を自動インストール」ボタンと `bridgeSetup` チャットツール**（`web/shared/ai-chat.js`）— 各プロバイダ欄から CLI の自動導入を実行でき、Gemini 等の内蔵AIからも「copilot をインストールして」と指示可能
- **ブラウザ WebGIS でのブリッジハブ自動検出・自動導入フロー**（`web/shared/ai-chat.js`）— capabilities 通知が無くても同一 PC のハブ `/health`（8512→8511 の順）疎通で `hub:true` を検出してブリッジ系プロバイダを表示。プロバイダ選択時にハブ未検出なら `bridge-hub.exe` を自動ダウンロードし、`/health` ポーリングで起動検出→エンドポイント入力・接続まで自動完了
- **Devin ブリッジの認証経路**— サービスユーザー API キー（`DEVIN_API_KEY`・`cog_`・設定画面入力可）または初回接続時のブラウザ PKCE ログイン。ローカル CLI ログインに依存しない
- **【ブリッジ】ドキュメントページ新設**（`docs/ai-bridge.html`）— 導入手順（exe 自己インストール／自動機向け zip・PowerShell 無人導入）・接続方式ごとの規約判断（GitHub Copilot・Devin・Antigravity の採用根拠、M365/Microsoft Copilot を見送った理由）

### Changed

- **`bridge-hub.zip` を自動機・スクリプト向け配布物に再定義**（`bridge-hub/`・`tools/build_bridge_zip.py`）— exe＋起動スクリプト一式を同梱し、`setup.cmd --nopause` で無人実行可能。`install-autostart.ps1` もタスク登録失敗時はスタートアップフォルダへフォールバック。自己インストールと同一タスク名を使い経路間で互換
- Antigravity ブリッジは `agy mcp add` で地図ツールを MCP 登録し `permissions.allow` に `mcp(kasugai/*)` を自動付与（headless の未許可ツール自動拒否対策）

## [6.4.1] - 2026-10-30

### Changed

- **ドキュメント: 連携構成図へローカルアプリ→CDN の `/vendor/` プロキシ配線を追加し「実行時の供給元」節を新設**（`docs/index.html`）— ローカルアプリが vendored 地理院地図を CDN から同一オリジン供給される経路を図示。プレイヤーコード（`web/` 複写・同梱）／vendored vendor（CDN＋プロキシ）／描画ライブラリ（jsdelivr・unpkg）／タイル・データの4層で供給元を対照化し、用語・表記を統一

## [6.4.0] - 2026-10-30

### Added

- **`/vendor/` の CDN フォールバックプロキシ**（`server/src/main.rs`）— `web/vendor/`（vendored 地理院地図）実体が無い環境で `/vendor/*` への GET/HEAD がミスした場合、ローカルサーバーが `kasugai-canvas-web/stable/vendor/` へ中継して同一オリジン供給する（`KASUGAI_VENDOR_CDN_BASE` で転送先上書き可）。GSI Maps エンジンは iframe 内 vendor を `GSI.GLOBALS` で制御するため同一オリジンが必須であり、これにより**ローカルアプリでもホスト版へのページ転送なしに `gsimaps/` がそのまま起動する**。Range・`If-None-Match`/`If-Modified-Since` 転送で globe アセットの範囲読みと 304 再検証も成立。ローカルに vendor 実体があれば従来通りそれを優先し、CDN 不通時は非200を返して従来のホスト版転送へフォールバック

## [6.3.0] - 2026-10-29

### Changed

- **ブラウザ WebGIS 向けスタンドアロン ブリッジハブを Rust 製 `bridge-hub.exe` 化**（`server/src/bin/bridge-hub.rs`）— `server/src/bridge/` の本体共有モジュールを単独バイナリとして配布する構成に変更し、`bridge-hub.zip` の中身を Node スクリプトから exe＋起動スクリプト一式へ差し替え。**ブラウザ WebGIS でも Node.js 不要**になり、必要なのは各プロバイダの CLI と本人の認証のみ（Copilot を npm で導入する場合のみ例外的に Node.js が必要）
- AI プロバイダ設定の案内を形態別に整理 — 「アプリ版=ハブ内蔵」「ブラウザ WebGIS（CDN・静的配信）=bridge-hub.zip」に用語統一し、Node.js 言及を撤去。各プロバイダのヒントに CLI 導入要件（copilot / devin / agy）を明示、接続失敗時の案内も形態別の確認項目に修正

### Removed

- 旧 Node 製ブリッジを撤去 — `bridge-hub/server.mjs`・`package.json`、および `copilot-bridge/`・`devin-bridge/`・`antigravity-bridge/` 各ディレクトリ（参照実装として残置していた Node 実装）

## [6.2.0] - 2026-10-29

### Added

- **CDN ホスト版からローカルアプリをバックエンド検出**（`web/shared/backend.js` 新設）— 同一オリジンの `/health` が見つからない静的配信環境（kasugai-canvas-web・file://）で、起動中のローカルアプリ `127.0.0.1:8510` をバックエンドとして検出する。検出後は `/api/*`・`/projects/*`・`/health` の全呼出しがローカルアプリへ向き、**ホスト版でも AI ブリッジ（Copilot/Devin/Antigravity）・外部登録プロジェクト（QGIS 出力の .kasc+DATA/）・fileWrite/fetchProxy 等のアプリ機能がそのまま使える**。Chrome の Local Network Access 権限が `prompt` の場合は実リクエストでプロンプトを発火し、許可されてバックエンドが見つかったら自動リロードして有効化（`denied` は従来通り静的動作のみ）
- **`?project=<ファイル名>` の仮IDリンクを `?kasc=` へ復元** — `?kasc=` 読込プロジェクトはファイル名由来の仮IDが付くため、それを `project=` へ入れた共有URLが 404 になっていた。`buildShareUrl` は `?kasc=` 中 `kasc=<url>` を出すよう修正し、読込時に記憶した `.kasc` URL（localStorage）からの復元で既存の壊れたリンクも同一ブラウザでは開けるようにした

### Fixed

- **`/api/*`・`/health` の OPTIONS に Private Network Access 応答を追加** — `/projects/*` は対応済みだったが `/api/*` 側が未対応で、https 公開ページから localhost へのプリフライトが拒否され得た。`access-control-allow-private-network: true` と `allow-headers: *`（MCP プロキシの `Mcp-Session-Id`/`Authorization` 通過用）を付与

## [6.1.2] - 2026-10-29

### Fixed

- **自動更新の後続プロセスが自分自身を強制終了してサーバーが起動しない問題を修正** — `--finish-update` 側のポート奪取（フェーズ2）とブリッジハブの占有者 kill が、占有者（＝自分を起動した旧プロセス）へ `taskkill /T /F` を実行していた。`/T` はプロセスツリーごと落とすため、旧プロセスの子孫である後続プロセス自身も道連れで終了し「ファイルは適用済みだがサーバー未起動・更新待ちのまま固まる」状態になっていた（旧プロセスがポートを 5 秒以内に手放さない場合に発火）。祖先に対しては `/T` なしの単独 kill に切り替え、祖先の他の子プロセス（rclone serve・ブリッジ CLI 等の兄弟プロセス）は個別に `/T` で落として孤児化も防止する（`kill_process_forced` + `child_pids`）

## [6.1.1] - 2026-10-29

### Fixed

- **インストーラーが `projects/default/DATA/`・`default_local/default/` をインストールしない問題を修正** — `File /r /x "default"` の除外が項目名単位で効くため、意図したトップレベル `default/` に加え `default_local\default/` も抜け、かつ補充が `.kasc`・`project.json` の2ファイルだけだったため `default/DATA/sample.geojson` 等が同梱されず 404 になっていた。除外後の補充を `SetOverwrite off` + `File /r`（不足分のみ追加・ユーザー編集済みファイルは保持）へ変更し、両プロジェクトの全内容を配置するようにした
- **kasugai_canvas.nsi に UTF-8 BOM を付与** — BOM 無しでは makensis が ACP(CP932) 解釈し、コメントの UTF-8 バイト列が CP932 で解読不能な並びになると「Bad text encoding」でコンパイル失敗していた（従来のコメントは偶然解読可能な並びだった）

## [6.1.0] - 2026-10-29

### Changed

- **AI ブリッジハブを Node.js から Rust 製アプリ内モジュールへ移行**（`server/src/bridge/`）— 旧 `bridge-hub/server.mjs`（Node 子プロセス）と各 `*-bridge/server.mjs` を Rust に移植し本体へ統合。配布物・実行ともに **Node.js 不要**になった（旧 Node 実装は手動起動用の参照実装として残置し、配布 ZIP には含めない）。待受ポート・/agent・/models・/mcp の外部仕様は維持
- Copilot プロバイダはランタイムを内蔵せず、ユーザー導入済みの `copilot` CLI を `--server --stdio` で起動して `github-copilot-sdk` の外部ストリームで接続する方式へ変更（`COPILOT_CLI_PATH` でパス指定可・npm グローバルの cmd shim にも対応）。devin（`devin acp` ACP）・antigravity（`agy` headless）は従来通り外部 CLI を起動

## [6.0.0] - 2026-10-28

### Added

- **GSI Maps エンジン（`web/gsimaps/`）を追加** — vendored 地理院地図（gsi-cyberjapan/gsimaps）を同一オリジン iframe（index_pm.html）で組み込み、`.kasc` を GSI/Leaflet API 経由で再生する中間エンジン。ベクター行は作図リストへ、xyz/wms/wmts 行は外部タイルへ注入し、ベースマップ切替・GSI カタログ取込・作図取り込み・表示中レイヤの `.kasc` 反映も可能。地理院 Globe も iframe 内表示（2D復帰ボタン付き）で、Globe 上へ Canvas レイヤを Cesium 注入で表示できる。ベースマップ・カタログ・作図・一時非表示・標高取得などの専用 AI ツールも搭載（`GSI.GLOBALS` 内部 API 依存のため現在調整中）
- **`/projects/*` を許可オリジン限定で CORS+Private Network Access 対応** — ホスト版エンジン（kasugai-canvas-web の github.io）がローカルの `.kasc`+`DATA/` を読めるようになった。file:// 起動HTML・ループバックも許可する一方、許可リスト外のオリジンには ACAO を返さず、任意サイトからのローカルデータ読み取りは遮断する
- **印刷パネルの QGIS 検出ポートを 8089-8091 へ拡張**し、二重実行ガードを追加

### Changed

- **vendored 地理院地図を CDN 提供へ移行し配布物から除外** — `web/vendor/gsimaps/`（約75MB・約1600ファイル）はリポジトリ・配布ZIP・インストーラーに同梱しない。他4エンジンの jsdelivr 依存と同様、GSI Maps もオンライン前提へ揃え、ローカルに vendor が無い環境で `gsimaps/` を開くと `?project=`/`?kasc=` をローカルの絶対URLへ変換して CDN 版エンジン（kasugai-canvas-web）へ自動転送する。iframe 制御の同一オリジン要件を保つためページごと転送する設計で、`?hosted=<base>` で転送先を上書き可能。開発時にローカルで動かす場合は `tools/fetch_vendor.py` で取得すれば従来通り
- **publish_cdn の vendor 同期を手動運用化** — 発行のたび vendor を全量同期していたのをやめ、`--vendor` 指定時に sha 差分がある場合のみ取得・反映する方式へ変更。通常発行は差分警告のみ（web/ 本体は毎回同期）
- **gsimaps のレイヤ管理を Leaflet 版と同じ構成へ統一**
- **2Dエンジンのレイヤパネル初期状態をCesium同様に全折りたたみへ変更**
- **CORS 許可リストのループバック判定をホスト厳密比較へ**（偽サブドメイン経由の許可回避を防止）

### Fixed

- **gsimaps 凡例タブの URL 重複を除外**し、空時の表示を追加
- **gsimaps 地物クリック処理で全ベクター行が読込失敗する退行を修正**
- **gsimaps Globe 切替の遷移先を絶対URL化して 404 を修正**
- **更新後の `*.update-old` 残骸をポート確保後に必ず掃除**

## [5.30.0] - 2026-10-27

### Fixed

- **指定プロジェクト・`?kasc=` の .kasc が見つからないとき内蔵デフォルトへ逃げないよう統一** — `?project=`・`?kasc=` で明示指定した .kasc を読み込めない場合、cesium エンジンが内蔵デフォルトプロジェクト（別プロジェクトのサンプル）を表示して誤解を招いていた。明示指定時は空で起動して「見つからない」旨を表示するよう修正（プレイヤー系エンジンと同じ挙動。既定プロジェクトのみ従来通り内蔵デフォルトを使用）

### Changed

- **採番ルールを `-dev` 接尾辞方式から `latest.json` 先行番号方式へ変更（開発運用）** — `Cargo.toml` は常に次のリリース予定番号を名乗り、`python run.py -B`/`--publish` は `download/latest.json` より大きい接尾辞なし番号でのみ実行可能（同一番号の再配布・降格を禁止）。`--sync` はリリース直後の整合確認専用となり、番号不一致時は公開ファイルを一切書き換えない。配布物の機能変更はなし

## [5.29.0] - 2026-10-27

### Changed

- **自動更新を外部プロセス非依存の純粋 Rust 実装へ刷新** — 従来は ZIP 展開に `powershell Expand-Archive`、exe 差し替え・再起動に生成した `update.ps1` を使っていたため、実行環境の PATH に PowerShell が無いと `program not found` で更新が失敗していた。`zip` crate で展開し、実行中 exe はリネーム（`*.update-old` 退避）→新 exe コピー→`--finish-update <pid>` 付きで後続プロセスを起動する方式へ変更。後続プロセスはポートを bind リトライして旧プロセスの退出を待ち、`web/` 差し替えと残骸掃除を行って通常起動へ合流する。外部プロセス（PowerShell/cmd）は一切不要になった
- **rclone 自動インストールの ZIP 展開も同じ Rust 展開へ統一** — Windows の `powershell Expand-Archive`・Unix の `unzip` 呼び出しを廃止
- **`/api/fetch` プロキシ対象の判定を共通化** — 新設の `isFetchProxyTarget` で同一オリジン・ループバック（localhost/127.x/::1）をプロキシ対象外としブラウザから直接取得。`/api/fetch` が SSRF 対策でループバックを 403 にするため、これらへプロキシ経由で届いていたリクエストが必ず失敗していたのを解消（`fetchData`・スタイル取得・`verifyToolTargetUrl` 等）

### Fixed

- **更新後プロセスのポート奪取を強化** — `--finish-update` 後続プロセスは 5 秒の自主終了待機（フェーズ1）の後、占有者を `/health` で `kasugai_canvas` と確認できた場合のみ `taskkill /T /F` で子プロセスごと強制終了してポートを奪取（フェーズ2）。旧プロセスが終了しないと 60 秒で bind 失敗し「ファイルは新しいがサーバー未起動」になる設計だった問題を修正。無関係プロセスの巻き添え防止のため占有者が `kasugai_canvas` でない場合は従来通り AddrInUse で終了する

## [5.28.0] - 2026-10-27

### Added

- **3D Tiles へのレイヤードレープ（deck.gl TerrainExtension）** — MapLibre / OpenLayers / Leaflet の各2Dエンジンに、Cesium 版の「ドレープ対象地形=3D Tiles」相当の設定を追加。設定「表示」タブの「3D Tiles ドレープ（deck.gl）」で、対象レイヤー種別（ベースマップ / XYZ / ベクター）を選んで `3dtiles:` 表面へ貼り付けられる。有効時は表示中の Tile3DLayer を `operation:"terrain+draw"` で地形ソース化し、選択したレイヤーを `drape-raster-*`（TileLayer+BitmapLayer）・`drape-vector-*`（GeoJsonLayer）として terrain カバーへ描画する。WMS/WMTS 行は `{bbox-epsg-3857}`・`{z}/{x}/{y}` テンプレートへ正規化して対応。ベクターは QML スタイル（`__kasc_*` 焼き込み値または `item._qml.evaluate`）と凡例シンボル非表示をドレープコピーにも反映。既定は全項目 ON（可視の `3dtiles:` がある場合のみ発動）。deck.gl の TerrainCover はタイル範囲固定・初回ズームでしか生成されないため、ズーム確定ごとにカバー FBO を破棄して現在ズームで再生成し、ドレープ解像度がズームに追従するよう補正している。共有ヘルパー `web/shared/deck-drape.js` を新設

- **`?kasc=local` ローカルフォルダ直読み（leaflet/maplibre/openlayers）** — File System Access API で選択したローカルフォルダ内の `.kasc`+`DATA/` を、ホスト版エンジンが `localfs:///` 疑似URL + fetch シム経由で読む。サーバー・exe 不要で、フォルダハンドルは IndexedDB に保持（次回は「前回のフォルダで開く」1クリック）。Chromium 系のみ。選択フォルダ外の参照・ローカルXYZタイルツリー（`<img>` 経由）は未対応。cesium は Resource/XHR 層を使うため本機構の対象外
- **`?kasc=<url>` 直読みモード（単独WEB配信）** — 全エンジンが `/<engine>/?kasc=<.kascのURL>` で任意 URL の .kasc を直接読み込めるようになった。`DATA/` 等の相対参照は .kasc のある URL を基準に解決されるため `projects/` 構造は不要。geo_webview の KASUGAI エクスポートが出力する `<engine>.html`（cesium/maplibre/openlayers/leaflet）と `index.html` を .kasc と同じ場所に置き、フォルダとエンジン（`web/` の中身）を同じ静的サーバーへアップするだけでサーバレス公開できる。各 HTML は `./ ../ ../../ /` の順にエンジンを自動探索し、配置が特殊な場合は HTML 内の `CANVAS_BASE` で指定できる。共有 `..` 参照はブラウザの URL 正規化で祖先フォルダへ解決される

### Fixed

- **cesium エンジンで `.kasc` 内の相対参照（`DATA/` 等）が読めなくなっていた回帰を修正** — マルチエンジン再編（`web/cesium/` 移行）以降 `resolveProjectUrl` が `projects/<id>/` の相対パスを返し、`/cesium/` ページ基準で `/cesium/projects/...` へ解決されて全て 404 になっていた。ルート相対 `/projects/<id>/` を返すよう修正

- **`.kasc` の `wms:`/`wmts:` 行（OGCタイルレイヤー）** — WMS/WMTS をレイヤーとして直接読み込めるようになった。`wms:タイトル | エンドポイント | layers=, styles=, format=, transparent=, version=` は GetMap を 256px タイル（EPSG:3857）へ分解して描画（Cesium は `{westProjected}` テンプレート、MapLibre は `{bbox-epsg-3857}`、OpenLayers は `ol.source.TileWMS`）。`wmts:` は `{z}/{x}/{y}`・`{TileMatrix}/{TileRow}/{TileCol}` の RESTful テンプレートと KVP GetTile エンドポイント（`layer=`/`tilematrixset=`/`matrixprefix=`）の両方を受け付け、`{z}/{x}/{y}` テンプレートへ正規化する。`opacity=`・`bbox=`・`off`・出典などタイル系の既存オプションも使え、データ取り込みパネル（kasc_loader/kasc_panel）からも利用可能。geo_webview の `/wms`・`/wmts` エンドポイントを指せば、稼働中 QGIS の描画をライブレイヤーとして表示できる
- **インスペクタの `plugin:` 行によるプラグイン起動** — `.kasc` に `plugin: <id> | key=value ...` と書くと、そのプロジェクトでのみプラグインを起動できる。`plugins.json` は利用可能プラグインのカタログとなり既定では自動ロードしない（`"auto": true` で常駐化も可）。宣言できるのはカタログまたはストレージプラグインの ID（外部 URL 直指定は不可）。起動したプラグインのレイヤーはプロジェクトスコープになり、プロジェクト切替・行削除・`| off` 指定でレイヤー除去＋`registerPlugin` の `meta.dispose()` が呼ばれ停止する。オプションは `manifest.options` にマージして渡され、真偽値・数値・カンマ区切り（配列）を解釈する。`listPlugins` ツールの結果に起動可能なカタログ一覧（`catalog`）を追加
- **自動更新の開発チャンネル** — バージョンにプレリリース接尾辞（`X.Y.Z-dev[.N]`）が付いたビルドは、`main` ブランチの `latest.json` / `kasugai_canvas.zip` ではなく `develop` ブランチの `latest-dev.json` / `kasugai_canvas_dev.zip` を参照するようになった。開発版 exe が公開最新版へ誤更新される事故を構造的に防止し、開発機は開発チャンネルの最新開発ビルドへ自動追従できる。`python run.py -B` はバージョンに応じて公開用（`kasugai_canvas.zip`・`latest.json`）／開発用（`kasugai_canvas_dev.zip`・`kasugai_canvas_setup_dev.exe`・`latest-dev.json`）の配布物を自動で切り替えて生成する
- **MapLibre エンジンの 3D 地形（テレイン）** — 設定「表示」タブに「3D地形（テレイン）を表示」・DEM ソース選択・誇張スライダを追加。`raster-dem` ソース + `map.setTerrain` で全ラスタ/ベクターレイヤーを地形へドレープする。DEM は Re:Earth Terrain（既定・Cesium 版と同じ `terrain.reearth.land` の terrarium TileJSON で楕円体高/標高の2種）・Mapterhorn・AWS Terrain Tiles・MapLibre デモ地形タイルから選択可能（地理院 dem_png は独自 encoding のため非対応）。有効時は最大ピッチを 85° へ緩和し、無効化時は deck.gl overlay 未使用なら 60° へ戻す。テレインはビュー設定として扱い、プロジェクト切替でリセットしない。`3dtiles:` レイヤー（deck.gl）はテレインを知らないため、タイルセット中心の `queryTerrainElevation`（誇張込み標高）を接地高として `groundDeckTileset` に渡し、テレイン ON/OFF・ソース/誇張変更・DEM タイル読込時に再接地させる
- **`.kasc` の `bookmark:` 行（QGIS ブックマーク）** — `.kasc` に `bookmark: <XMLパス>` と書くと、QGIS のブックマークエクスポート XML（qgis_bookmarks 形式）を読み込み、各ブックマークをカメラプリセットへ展開する。extent は EPSG:4326 が前提（それ以外・EPSG:3857 は自動推定して度へ変換）、回転は方位 `d=` へ引き継ぎ、高さは範囲が画面に収まる近似値を採用。全エンジン（Cesium カメラプリセット / MapLibre・OpenLayers・Leaflet カメラタブ）で同一 UI に並ぶ。geo_webview の `/kasugai` エクスポートは `bookmarks.xml` を自動出力してこの行を書く（`emit_bookmarks=False` で抑制）

### Changed

- **reinfolib プロジェクトを `plugin:` 行方式へ移行** — `installer/projects/reinfolib` は固定タイル座標を `geojson:` 行で直書きする静的構成だったが、`plugin: reinfolib | datasets=price,shelter,station,zoning` に置き換え、プラグインの表示範囲連動の動的取得に戻した
- **同梱プラグインの既定を宣言ロードへ変更** — `plugins.json` のエントリは従来の全自動ロードからカタログ化し、`plugin:` 行または `"auto": true` で起動する。これにより reinfolib 等が無関係なプロジェクトでも API を叩き続ける動作を解消

### Fixed

- **Leaflet 版で 3D Tiles がズーム操作時にベースマップから浮いて見える問題を修正** — `zoomanim` 発火時に deck.gl へ最終ビューを即座に適用していたため、タイル側の 0.25s CSS アニメーションと deck の先行描画がズレて建物が一瞬地面から浮いて見えていた。アニメーション中は `GridLayer._setZoomTransform` と同じ translate+scale を deck キャンバスへ掛けてタイルと一体で変形させ、終了時に来る `move` で変形を解除して実ビューへ再同期する方式へ変更。ドラッグ・ピンチ・flyTo・慣性パンは従来どおり `move` の毎フレーム同期で密着する（接地高 0m への自動接地 `groundDeckTileset` は従来から共通処理として適用済み）

## [5.27.0] - 2026-10-21

### Added

- **QML スタイル式で `is_layer_visible('名前')` をサポート** — `style=` で読み込んだ QGIS レイヤースタイル（.qml）の式評価に `is_layer_visible` 関数を追加し、別レイヤーの表示状態を参照した条件付きスタイルが使えるようになった。QGIS のレイヤーツリー側のチェック状態に相当し、KASUGAI では該当レイヤーの表示（`item.visible`）を返す。レイヤー名はタイトル・ID・グループパスの各セグメントで照合し、見つからないレイヤーは非表示（false）として扱う（QGIS のレイヤー無しと同じ）
- **不動産情報ライブラリ（国土交通省）連携プラグイン** — `web/PLUGIN/reinfolib` を同梱。表示範囲連動で XYZ タイル形式の GeoJSON（取引価格ポイント・指定緊急避難場所・駅別乗降客数・用途地域）を取得し、本体の geojson レイヤー経路に流す。取得は `/api/reinfolib?url=<target>` 中継経由（ローカルサーバー／Cloudflare Workers 双方に実装）で、API キーはサーバー側の `REINFOLIB_API_KEY` から注入（BYO キーは `localStorage.reinfolibApiKey`）。中継の接続先は `www.reinfolib.mlit.go.jp/ex-api/external/` 配下のみに限定
- **プラグインレイヤーの `style` オプション** — `registerPluginLayer` / `plugins.json` の `layer` 宣言に `style: "QMLファイルURL"` を追加し、プラグインが流す geojson レイヤーにも QGIS スタイル（単一・分類・ルールベース・ラベル）を適用できる
- **reinfolib 用バンドル QML スタイル** — `web/PLUGIN/reinfolib/qml/` に取引価格（オレンジ丸）・避難場所（緑シールド）・駅別乗降客数（紫ライン＋駅名ラベル）・用途地域（13区分＋その他の分類色分け）のスタイルを同梱し、プロジェクトの `geojson:` 行の `style=` からも参照できる
- **地域比較シート試作ツール** — `tools/region-compare/compare.mjs`。2〜3候補地域を同一観点（取引価格・避難場所・乗降客数・用途地域・防災4種・小学校区・所要時間・動物病院・公園）で確認し、確認済み/データなし/未確認を分けた比較シート（Markdown）と候補円 GeoJSON・カメラプリセット `.kasc` 行を生成する

### Changed

- **ドキュメントを `docs/` ディレクトリへ集約** — サイトの HTML・画像・`nav.js` を `docs/` に移動し、ルートの `index.html` は `docs/` へのリダイレクトに変更（GitHub Pages ソースを一箇所に集約）
- **reinfolib プロジェクトをスタイル付きに更新** — `installer/projects/reinfolib` の各 `geojson:` 行に `style=` を適用し、用途地域を既定表示化、`legend:` 行（凡例 SVG）と比較候補地域レイヤー・カメラプリセットを追加

### Fixed

- **run.py のバージョン同期がドキュメント移動に追随していなかった問題を修正** — `docs/` 集約後もルートの `nav.js`・各 HTML を参照していたため `--sync`/`-B` の整合チェックが失敗していた。同期・検査対象を `docs/` 配下へ更新

## [5.26.0] - 2026-10-15

### Added

- **AI の追加指示を保存・共有** — 管理 → AI → チャットの「追加指示」タブでモデルに依存しない指示を保存できる。通常はブラウザに保存し、Cloud Run では `KASUGAI_AI_INSTRUCTIONS` のサーバー設定を優先して `/api/gemini` 経由で適用する
- **GIS 案内エージェントの標準指示** — 対象地域・目的の把握、実データと架空サンプルの区別、資料作成時の出典とパーマリンクなどの運用方針を追加

## [5.25.0] - 2026-10-15

### Added

- **AI が「ベースマップなし」「ベースマップ透明」を選択可能に** — `listBasemaps` が疑似項目（`none`／`transparent`）を一覧に含めるようになり、`setBasemap` が両モードを受け付ける。「ベースマップを透明にして」「ベースマップをなしにして」等の指示が正しく動作する。`setBasemap` は内部IDと表示名（日本語・英語）の両方を解釈する

### Fixed

- **飛行中のレイヤ設定変更（インスペクター「登録」）で飛行が死ぬ問題を修正** — `applyInspector` がルート・再生状態・カメラ駆動ループを無条件リセットし、`walkMode` のまま入力も受け付けないゾンビ状態になっていた。適用前にルートのタイトル・距離・再生状態を退避し、IndexedDB からの非同期再登録後に位置・再生を復帰する。ルートが削除済み・読込失敗の場合は手動ウォークへフォールバックし、復帰待ちの間もキー入力を即座に解放する
- **`/basemap` コマンド・`setBasemap` API で「ベースマップなし」「ベースマップ透明」を選べなかった問題を修正**（上記 Added と同実装）
- **AI ブリッジが `listBasemaps` に実値を返さなかった問題を修正** — Copilot/Devin/Antigravity ブリッジは `listLayers`/`getCamera` のみ実値応答で、一覧系はプレースホルダだったため、AI は「曖昧なら listBasemaps で確認」と指示されながら実際の選択肢を一度も見られなかった。3 ブリッジとも `listBasemaps` を実値応答（`LOCAL_STATE_TOOLS`）に追加し、リクエストの `[State]` にベースマップ一覧を同梱。システムプロンプトにも特殊モードを明記

## [5.24.0] - 2026-10-14

### Added

- **`flyRoute` AI ツール** — 「AからBまで飛んで」「Cを経由して」等の自然言語指示から飛行ルートを自動生成する。経由地は座標・地名（`query`: ジオコーディング）・読込済みベクトル地物（`feature`: vectorSearch）を混在指定でき、同名候補が複数ある場合は直前の経由地に最も近いものを選択する。経由地間は直線補間し、Cesium の地形サンプリングで沿線標高を取得して各点に「標高＋地上高」の絶対標高（MSL）を焼き込むため、未読み込みタイル領域や山岳部でも地形に埋まらない。生成物は手描きルートと同じ GeoJSON LineString として IndexedDB に保存され、Fly パネルのルート一覧・編集・出力・削除がそのまま使える
- **距離ベースの自動飛行プロファイル** — `speed`/`agl` 省略時はルート総距離から既定値を自動決定（<2km: 50m/80km/h、<20km: 300m/200km/h、<100km: 800m/400km/h、<500km: 3,000m/1,000km/h、500km〜: 10,000m/2,000km/h）。`addFlyPath` で速度省略時にも同プロファイルを適用
- **`setFlySettings` AI ツール** — 再生中・選択中または指定ルートの速度・地上高・ピッチ・ループ・視点を変更する。「もっと速く」「地上50mで飛んで」等に対応。`agl`（地上高目標値）は MSL ルートでは生成時地上高（`properties.agl`、旧形式は疎サンプリングで推定）との差分を高度オフセットへ自動変換し、地形に追従したまま実際の飛行高度を変えられる。変更は `properties.fly` として GeoJSON に書き戻されリロード後も維持される
- **ルート設定の永続化** — `addFlyPath` が飛行設定（speed/height/pitch/step/loop/view）を `properties.fly` として GeoJSON に埋め込み、描画ルート復元（IndexedDB・フォルダ・サーバー全経路）時に適用する。設定を持たない旧形式の生成ルート（`source:"flyRoute"` または `heightReference:"MSL"`）は復元時に距離ベースの自動プロファイルへ移行する
- `startFlyPath` が `properties.heightReference: "MSL"` を認識 — 絶対標高が焼き込まれたルートでは地形高の二重加算をしない

### Fixed

- `flyPathLoop` が rAF の timestamp 巻き戻し（`flyPathLastTime` より過去）で delta<0 → 飛行距離<0 となり即座に停止していた問題を修正。低fps環境や手動再生（ダブルクリック/Wキー）でも発生し得た既存バグ
- `playFlyPath` がルートの読み込みと先頭移動だけで前進を開始しなかった問題を修正 — 読み込み完了を待って自動前進を開始する `playFlyPathAt` を新設
- `playFlyPathAt` がルート選択セレクトの `<option>` 未描画タイミング（リロード直後の描画ルート復元中）に `select.value` 代入に失敗し手動モードに落ちる問題を修正 — 代入前にセレクトを再描画し、`setMode` が拾えなかった場合は `startFlyPath` を直接呼ぶフォールバックを追加
- 地形サンプル欠損の補完を隣接値コピーから両隣の線形補間へ変更 — 欠損区間直後に高度が階段状に変化していた問題を解消
- 地形サンプリングレベルを距離適応に変更（<20km: L13、<200km: L12、それ以上: L11）— 長距離ルート生成時の大量タイル取得による遅延を解消

## [5.23.0] - 2026-10-14

### Added

- ブリッジハブの待受ポートを `BRIDGE_HUB_PORT` 環境変数で変更可能に — アプリ本体・ハブ・capabilities 通知がすべてこの値に揃う（既定 8511。ブラウザ側の設定変更は不要で、capabilities が実ポートを通知する）
- チャットヘッダーに AI プロバイダのドロップダウンを追加 — 実際に使えるプロバイダ（Gemini はキー設定済みまたは aiProxy、OpenAI互換はキー設定済み、Copilot/Devin/Antigravity はブリッジ疎通可、外部エージェントはエンドポイント設定済み）のみが選択肢に出る。切替は設定画面のプロバイダ・エンドポイント・有効フラグと同期し、モデル名は従来どおりヘッダーに表示。ブリッジが使える環境では API キー未設定でもチャットパネルを開けるようにした
- プロバイダ選択時の接続確認表示 — 切替（および起動時の選択復元）後、実際に接続できるまでドロップダウンを赤背景＋ラベル「接続中…」で表示し、確認できたらモデル名表示に戻る。確認失敗時は赤のまま「未接続」を表示する。**チャット側の確認は `/health` の軽い疎通のみ** — `/models` による実接続テスト（Copilot は SDK 接続＋モデル一覧取得、Devin は `devin acp` 起動・認証、Antigravity は `agy models` 実行）は**設定画面での操作時にのみ**行う。チャットのドロップダウンで切り替えてもバックエンド CLI の起動・ブラウザ認証は発火しないため高速。外部エージェントは `/health`（ブリッジ型実装）または `/agent` への最小プローブ POST（`ping` フラグ＋空メッセージ、プロトコル応答が返れば接続済み）で確認し、設定画面でも同じ実疎通テストを実行してステータスに反映する
- AI 設定をプロバイダ別の専用画面に分離 — ブリッジ系プロバイダ選択時は従来、全プロバイダ（Copilot/Devin/Antigravity/外部エージェント）の案内文が同時に表示されていたが、選択中プロバイダの項目だけを表示するようにした（他プロバイダのヒント・モデル欄・トークン/BYOキー欄は非表示）
- Devin プロバイダの設定画面に「Devin APIキー」欄を追加 — `localStorage`（`devinApiKey`）に保存し、`X-Devin-Api-Key` ヘッダで `/agent`・`/models` リクエストに同梱（https/localhost 宛のみ）。devin-bridge は受け取ったキーで `devin acp` の `authenticate`（`meta.api_key`）を行い、キー変化時は acp を再起動して再認証する。環境変数 `DEVIN_API_KEY` に未設定でもブラウザ PKCE ログインを回避できる（**サービスユーザーキー**が必要 — PAT は `devin acp` の認証では拒否される）。ブリッジは起動・認証の失敗理由を `/models` の `error` フィールドで返し、設定画面のステータス欄とチャットヘッダー（「未接続」のホバー）に原因を表示する

### Fixed

- 保存済みブリッジエンドポイントが死んでいる場合の自己修復 — 旧バージョンのポート（8513 等）が localStorage に残っているとチャット送信が「Failed to fetch」で失敗していた。送信の接続失敗時にブリッジ系プロバイダの既知候補を疎通確認し、生存しているエンドポイントへ一度だけ自動で切り替えて再試行し、保存値と設定欄を更新するようにした

## [5.22.0] - 2026-10-13

### Changed

- ブリッジの手動起動ポート（8788/8789/8791）の自動検出・案内を廃止 — ブリッジハブ（8511）への集約に伴い、ユーザー向けの接続経路をハブ1本に単純化。エンドポイント欄に任意URLを入力すれば従来どおり接続は可能（同梱ブリッジの単体起動は開発・デバッグ用途として残置）
- ドキュメント整備 — エージェント連携が双方向（ブラウザ→エージェント: ハブ 8511、エージェント→ブラウザ: アプリ本体 8510 `/api/command`）である旨と、3ポート分離 vs 1ポート集約の設計判断を明記

## [5.21.0] - 2026-10-13

### Changed

- アプリ版のブリッジ構成を1本化（ブリッジハブ）— 従来は Copilot・Devin・Antigravity の3ブリッジを起動時にすべて常駐させていた（8511/8512/8513）が、常駐プロセスを `bridge-hub/`（127.0.0.1:8511）1本に集約。ハブは `/agent` の `provider` フィールドと `/models?provider=` でプロバイダを振り分け、選択されたブリッジだけを内部ポート（8521/8522/8523）で子プロセスとして遅延起動する。プロバイダ切替時は前の子を停止するため常時最大1プロセスのみ（`/agent` 処理中の切替は完了を待ってから実行）。起動時に旧版の常駐ブリッジ残骸（8512/8513）は掃除する。`/api/capabilities` は `copilot`・`devin`・`antigravity` 各 endpoint をすべてハブの 8511 で通知。フロントのエンドポイント自動検出・疎通ステータス・モデル一覧もハブ経由に統一
- ブリッジのモデル一覧取得をコールドスタート耐性のあるものに改善 — ハブが子ブリッジを起動している間は応答が遅れるため、タイムアウトを 30 秒に延長しネットワーク失敗時も一定回数再試行するようにした

## [5.20.1] - 2026-10-13

### Fixed

- Antigravity ブリッジの MCP 接続不整合を自己修復 — agy の MCP 登録はグローバル設定1本のため、別ポートのブリッジ（手動起動・既定8791等）が上書きすると agy 側が存在しないポートへ接続し「MCPサーバーへの接続エラー」（Connection refused）になっていた。`/agent` ごとに `~/.gemini/config/mcp_config.json` の登録URLを検査し、自分のポートと違えば agy 起動前に再登録するようにした。また agy は会話開始時の URL に紐付き続けるため、古い URL で作られた会話の再開は修復後も失敗し得る — ターン中にブリッジの `/mcp` へ一度もリクエストが届かず、ツール呼出の失敗または MCP 接続エラー系の応答が見えた場合はその会話を破棄して新規会話で一度だけ再試行する

## [5.20.0] - 2026-10-13

### Added

- `antigravity-bridge/` — Google Antigravity CLI（`agy`）によるローカルブリッジ。AI プロバイダの「Antigravity」選択肢はアプリ版のみ表示され、利用者自身の Google アカウントでログインした agy を AI チャットのエンジンとして利用できる。ブリッジは agy の headless 実行（`--output-format stream-json`・stdin へ `{"event":"user"}` 形式で送信）を駆動し、プロジェクト単位で `--conversation` による会話継続を行う。地図ツールはブリッジ内の HTTP Streamable MCP サーバー（`/mcp/<project>`）を `agy mcp add` で登録・`permissions.allow` に `mcp(kasugai/*)` を追加して agy に公開。ツール呼び出しはブリッジでキューイングして `actions` として返し、実行はブラウザ側の既存仕組み（確認ダイアログ含む）に委譲する
- アプリ版の Antigravity ブリッジ自動起動 — ローカルサーバー起動時に `antigravity-bridge/` を Node 子プロセスとして起動し `127.0.0.1:8513` で待受け（要 Node.js＋Antigravity CLI。`node_modules` 無しの初回は `npm install --omit=dev` を自動実行。`KASUGAI_NO_ANTIGRAVITY_BRIDGE` で無効化・8513 使用中はスキップ・アプリ終了時に道連れ停止・標準出力は `antigravity-bridge.log` に記録）。`/api/capabilities` が `antigravity.endpoint` と feature `antigravityBridge` を通知し、フロントは通知エンドポイント → 8513 → 8791（手動起動の既定）の順で疎通するブリッジを自動検出する。配布 ZIP に `antigravity-bridge/` を同梱
- Antigravity モデル選択 — Antigravity プロバイダの設定欄でブリッジの `GET /models`（`agy models` 由来）から取得した利用可能モデルを選択可能に。選択値は `/agent` 要求の `model` フィールドでブリッジへ送られ、agy の `--model` に適用される
- リモートコマンド経路（アプリ版・local ティア）— ローカルサーバーが `POST /api/command`（コマンド投入・採番 id 返却）・`GET /api/command?since=<id>&wait=<秒>`（ブラウザ側ロングポーリング受信）・`POST /api/command/results`・`GET /api/command/results`（外部プロセスの結果回収）を公開。Devin Desktop・Copilot CLI・任意スクリプトなど HTTP を話せるローカルプロセスが、チャットツールと同一のコマンド名・引数で開いている地図をリアルタイム操作できる（`{"name":"flyTo","args":{...}}` または `{"commands":[...]}`・最大50件/回）。実行結果は `{"id","ok","result"}` で返却され、破壊的操作はチャット同様確認ダイアログが出る。capabilities の `remoteCommand` feature で通知

## [5.19.0] - 2026-10-13

### Added

- データソース（MCP 接続）— 管理 → AI → データソース でリモート MCP サーバー（Model Context Protocol・Streamable HTTP）を登録し、そのツールを AI チャットの functionDeclarations へ `<サーバーキー>__<ツール名>` で合成（`web/mcp.js` 汎用クライアント＋localStorage `mcpServers` レジストリ。`initialize`→`tools/list`→`tools/call`、SSE 応答パース、`Mcp-Session-Id`/`MCP-Protocol-Version` ヘッダ、tools/list ページネーション対応）。読み取り系のみ既定公開で、書き込み系は「書き込み系ツールも AI に公開する」ON 時のみ合成＋実行ごとに確認ダイアログ。登録サーバーは起動時に自動接続され、`kasugaiApi.mcp` からも操作可能
- Box 接続 — 公式リモート MCP（`https://mcp.box.com`）専用の接続ボタン。OAuth 2.0 + PKCE をブラウザ内で完結（client secret 不要・`web/box.js`）、アクセストークンは BYO として localStorage にのみ保存し、期限切れは refresh_token で自動更新。Box Developer Console での Custom App 作成＋リダイレクト URI 登録（Enterprise は Admin Console での MCP 有効化）が事前準備として必要
- `POST /api/mcp?url=...` — CORS 非対応のリモート MCP サーバーへの薄い中継プロキシを3バックエンドに実装（ローカル Rust サーバー・`functions/api/mcp.js`・Cloud Run `agent/`）。Authorization・MCP セッションヘッダ・ボディをそのまま転送するのみ（BYO トークン転送・キー隠蔽ではない）。ブラウザは直叩きが TypeError（CORS）の場合に同パスへ自動フォールバック。capabilities の `mcpProxy` feature で通知。SSRF 対策: local は `/api/fetch` と同一ポリシー（`kasugai_canvas.fetch.json` で LAN 許可可）、workers は https 限定＋`MCP_ALLOWED_HOSTS` 環境変数で接続先制限可、cloudrun は private/loopback 解決結果を拒否

## [5.18.0] - 2026-10-13

### Added

- `devin-bridge/` — Devin CLI の ACP（Agent Client Protocol）によるローカルブリッジ。AI プロバイダの「Devin」選択肢はアプリ版のみ表示され、選んで保存すると疎通したブリッジへエージェント接続が自動設定され、利用者自身の Devin アカウント（ブラウザ認証または `DEVIN_API_KEY`）を AI チャットのエンジンとして利用できる。ブリッジは `devin acp` を stdio JSON-RPC で駆動し、地図ツールはブリッジ内の HTTP Streamable MCP サーバー経由で Devin に公開。ツール呼び出しはブリッジでキューイングして `actions` として返し、実行はブラウザ側の既存仕組み（確認ダイアログ含む）に委譲する
- アプリ版の Devin ブリッジ自動起動 — ローカルサーバー起動時に `devin-bridge/` を Node 子プロセスとして起動し `127.0.0.1:8512` で待受け（要 Node.js＋Devin CLI。`node_modules` 無しの初回は `npm install --omit=dev` を自動実行。`KASUGAI_NO_DEVIN_BRIDGE` で無効化・8512 使用中はスキップ・アプリ終了時に道連れ停止・標準出力は `devin-bridge.log` に記録）。`/api/capabilities` が `devin.endpoint` と feature `devinBridge` を通知し、フロントは通知エンドポイント → 8512 → 8789（手動起動の既定）の順で疎通するブリッジを自動検出する。配布 ZIP に `devin-bridge/` を同梱
- Devin モデル選択 — Devin プロバイダの設定欄でブリッジの `GET /models` から取得した利用可能モデルを選択可能に。選択値は `/agent` 要求の `model` フィールドでブリッジへ送られ、新しいセッションに適用される

### Changed

- ドキュメントの AI 連携方針を更新 — Copilot は公式 Copilot SDK、Devin は公式 Devin CLI/ACP を使ったローカルブリッジ連携であることを明記。消費者向け Copilot Web UI の自動操作は提供しない。Microsoft 365 Copilot は公式 API が存在するが、ライセンス・アプリ登録・テナント管理者同意・権限設定を要するため本ブリッジには含めない旨を出典リンク付きで説明

### Fixed

- `web/app.js` 起動処理で残っていた旧関数名 `updateCopilotProviderOption()` の参照を `updateBridgeProviderOptions()` に修正（ページ初期化時の JavaScript エラーを解消）

## [5.17.0] - 2026-10-13

### Added

- AI プロバイダに「外部エージェント」を追加 — Gemini / OpenAI互換（API系）と GitHub Copilot / 外部エージェント（ブリッジ系）を1つのプロバイダ選択に統一。プロバイダ名には【API】/【ブリッジ】のカテゴリ接頭辞を表示。ブリッジ系はエンドポイントURL・Bearerトークン・BYOキー送信を共通のブリッジ欄で設定し、Copilot 選択時のみモデル選択と疎通ステータスを追加表示
- Copilot ブリッジのポート奪還 — アプリ起動時に 8511 が占有されていても、占有者がブリッジ（`/health` で確認）なら強制停止して新版へ差し替える。前回起動の残骸や旧バージョンのブリッジが残っていても自動で置き換わる（ブリッジ以外のプロセス占有時は従来通りスキップ。Windows: netstat+taskkill / Unix: lsof+kill）

### Changed

- AI 設定画面の統合 — 「エージェント」タブを廃止し、管理 → AI → チャット のプロバイダ選択に一元化。旧「チャットを外部エージェントへ送信」チェックは廃止しプロバイダ選択が唯一の切替源（localStorage キーは後方互換を維持）。外部エージェント用の未接続メッセージを Copilot 用と分離
- ドキュメントに接続しない AI の方針を明記 — Microsoft 365 Copilot・消費者向け Copilot の UI 自動化は利用規約違反のため提供しない。ブリッジは公式 SDK/CLI 等の正規プログラム経路があるものに限定

## [5.16.0] - 2026-10-12

### Added

- AI チャットのプロバイダ切替 — 管理 → AI → チャット の「AI プロバイダ」で Gemini（既定）と OpenAI互換 を選択可能に。OpenAI互換はベースURL・APIキー・モデル名を指定し、GitHub Models（GitHub PAT）・OpenAI・Azure OpenAI・Ollama・LM Studio 等の chat/completions 互換エンドポイントへ接続（ツール宣言は OpenAI tools 形式へ変換して function calling ループを共有）
- `copilot-bridge/` — GitHub Copilot SDK によるローカルブリッジ。AI プロバイダの「GitHub Copilot」選択肢はアプリ版のみ表示され、選んで保存すると疎通したブリッジへエージェント接続が自動設定され Copilot 契約を AI チャットのエンジンとして利用できる（Copilot に直接呼べる公開APIは無いためブリッジ経由が正規ルート。要 Copilot サブスクリプション。通常版は選択肢非表示・手動ブリッジはエージェントタブから接続。ブリッジ疎通確認を設定画面に表示）
- アプリ版の Copilot ブリッジ自動起動 — ローカルサーバー起動時に `copilot-bridge/` を Node 子プロセスとして起動し `127.0.0.1:8511` で待受け（要 Node.js＋Copilot CLI。`node_modules` 無しの初回は `npm install --omit=dev` を自動実行。`KASUGAI_NO_COPILOT_BRIDGE` で無効化・8511 使用中はスキップ・アプリ終了時に道連れ停止・標準出力は `copilot-bridge.log` に記録）。`/api/capabilities` が `copilot.endpoint` と feature `copilotBridge` を通知し、フロントは通知エンドポイント → 8511 → 8788（手動起動の既定）の順で疎通するブリッジを自動検出する。配布 ZIP に `copilot-bridge/` を同梱
- Copilot モデル選択 — Copilot プロバイダの設定欄でブリッジの `GET /models` から取得した利用可能モデルを選択可能に（`gpt-5`・`claude-sonnet-4.5` 等）。選択値は `/agent` 要求の `model` フィールドでブリッジへ送られ、セッションのモデルが切り替わる。未選択時はブリッジ既定（`COPILOT_BRIDGE_MODEL`）

### Changed

- 外部エージェントへの要求 JSON に `tools` フィールドを追加 — 現在公開中のツール宣言（functionDeclarations 形式）を同梱。エージェント側がツール一覧を登録できる（copilot-bridge が使用。既存エージェントへの影響なし・追加フィールドのみ）

## [5.15.0] - 2026-10-12

### Added

- AI チャットのツール実行上限を設定化 — Gemini 設定パネルの「ツール実行の上限往復数」（既定 10・1〜20 でクランプ）で変更可能に。上限到達時は一度中断してユーザーに継続確認を出し、承認なら現行設定値ぶんを 1 枠追加して続行、拒否なら中断
- `setToolMaxSteps` ツール — AI への指示（「上限を 15 にして」等）でツール実行上限を変更（設定パネル・localStorage と同一の設定を更新）
- `addFlyPath` ツール — GeoJSON LineString / MultiLineString から飛行ルートを生成・登録。手描きルートと同じ IndexedDB ストアに保存されるためリロード後も復元。`listFlyPaths` → `playFlyPath` と連携し「地点を巡るルートを作って飛んで」が一連の指示で完結
- AI へのデータ作成指示で形式未指定の場合、GeoJSON を生成して `addDataLayer` で即表示する既定動作をシステム指示に明文化（全 8 言語）
- AI が URL 指定で追加するレイヤーの実在確認 — `addLayer` / `addGeoJsonLayer` は適用前に http(s) URL への到達確認を行い、存在しない・到達不能な URL は拒否して理由をモデルへ返す。`applyInspector` は設定内で新規追加されるデータレイヤー行の URL のみ一括確認（`proxy=on`・`DATA/` 相対パス・タイル系・既存行の URL は対象外。ローカル版は `/api/fetch` 経由で検証）
- チャットの AI 応答を Markdown 描画に対応
- AI の位置リンク案内に自オリジン URL をシステム指示へ追加

### Changed

- ドレープ設定を対象地形ごとの個別選択に変更 — 「ドレープを適用するレイヤー」の共通選択を廃止し、DEM／3D Tiles それぞれの直下に XYZ・ベクター・ベクター高速ドレープ（実験的）のチェックを配置。対象ごとに適用レイヤーを独立して選べる（例: XYZ は 3D Tiles のみ、ベクターは DEM のみ）
- `window._viewer` を開発者ツール・E2E 検証向けに公開（内部向けのデバッグ面）

### Fixed

- `.kasc` 宣言の Google 3D Tiles レイヤーと組み込みトグルの二重登録を解消
- `ensureDrawnRouteFlyPath` の並行実行で同一描画ルートが多重登録される競合を直列化で修正

## [5.14.0] - 2026-10-11

### Added

- `.kasc` の `base:` に特殊値 `transparent`（ベースマップ透明）・`none`（ベースマップなし）を追加 — 初期表示モードを設定ファイルで指定可能に（従来は UI 選択のみ・.kasc では表現不可）
- `3dtiles:` 行で `tile.googleapis.com` の URL に Maps API キー（BYO またはサーバー配布）を自動付与 — `key=` を .kasc に書かずに Google Photorealistic 3D Tiles をレイヤーとして宣言可能に
- Cloud Run 専用初期設定 `agent/cloudrun.kasc` — 存在すれば `run-cloudrun.py` がデプロイ時に `gs://<bucket>/kasc/default` へアップロードし、ローカルの `web/projects/` と別設定で動作（`--kasc FILE` / `PROJ:FILE` / `none` で制御可）
- `run-cloudrun.py`: 非秘密のデプロイ設定を `kasugai_canvas.cloudrun.json`（gitignore）に保存し引数なし再デプロイ対応。認証・Gemini・Maps のシークレットは Secret Manager 既存登録を再利用。`gcloud` が PATH に無い場合も既定インストール位置から探索
- `run.py --cloudrun`: 保存済み設定で Cloud Run へデプロイ。`--publish --cloudrun` でリリース→push→Cloud Run 反映まで一括化

## [5.13.0] - 2026-10-11

### Added

- Cloud Run デプロイ自動化スクリプト `run-cloudrun.py` — gcloud 認証確認・API 有効化・Artifact Registry・Cloud Build（ローカル Docker 不要）・Secret Manager 登録・GCS バケット作成・実行 SA 権限付与・`gcloud run deploy`・`/health`/`/api/capabilities` 検証まで一括。Cloud Shell でも実行可能
- Google Maps Platform キーのサーバー配布 — バックエンドに `GOOGLE_MAPS_API_KEY` を設定すると `/api/capabilities` が `google.mapsApiKey` を通知し、ブラウザは `googleMapsApiKey` 未保存時に自動登録（BYO キー優先。Cloud Run・Cloudflare 双方で同一契約）。キーは設計上ブラウザに露出するため GCP の HTTP リファラ制限で保護
- `.gcloudignore`（`.dockerignore`・`.gitignore` を再利用し Cloud Build のアップロードを軽量化）

### Fixed

- 認証モード時に `/api/gemini` 呼び出しへ kasugai トークンが付かず 401 になる問題を修正 — `callGemini` がプロキシ経由時に `Authorization: Bearer` を付与し、`functions/api/gemini.js` が Bearer の kasugai トークンを受理（Cloudflare Pages/Cloud Run モード5は Cookie を発行しないため必須）

## [5.12.0] - 2026-10-11

### Security

- `.kasc` エクスポート・クラウド保存時に `restoreKasc` を適用し、`/api/data/...?token=` のセッショントークンが .kasc に混入しないよう `gs://`/`r2://` に復元
- 資料モーダルの Markdown（`renderMarkdownLite`）で `javascript:`/`data:` 等のスキームをリンク化しないよう制限（http(s)/相対のみ）
- `/api/data` の配信 Content-Type を拡張子由来の固定マッピングに変更（Workers・Cloud Run 両方）。保存・リクエストされた `text/html` 等は `application/octet-stream` で返し stored XSS を遮断
- 外部エージェントへの BYO Gemini キー送信（sendKey）を `https:` または `localhost`/`127.0.0.1` のみに限定。他の `http:` 宛は送信前に中止
- `attr`（出典）フィールドの HTML を許可リスト型サニタイズ。`a`/`img`/装飾タグのみ・URL スキーム検証・イベント属性除去で、細工した .kasc によるページ内スクリプト実行を遮断（描画時のみ・ファイル非破壊）
- `/api/fetch`（ローカル版 CORS プロキシ）でプライベート/ループバック/リンクローカル等への接続を既定拒否（SSRF 対策）。`kasugai_canvas.fetch.json` の `allow`（ホスト名・個別IP・IPv4 CIDR）で社内 LAN 等を明示許可可能

### Added

- 管理ウィンドウ「その他」タブに「データ取得プロキシ」設定欄を追加（`/api/fetch` の許可リストを 1 行 1 エントリで編集・保存。`GET/PUT /api/fetch/settings`、ローカル実行のみ公開）
- ドキュメントページ `security.html` — 実装済みの保護機構と既知の制限を集約

## [5.11.0] - 2026-10-11

### Added

- 内蔵AI向けのサーバーキー隠蔽プロキシ `POST /api/gemini` を Cloudflare（Pages Functions / Workers）と Cloud Run の両基盤に実装。`GEMINI_API_KEY` をサーバー側シークレットに設定すると `/api/capabilities` が `aiProxy` を通知し、BYO（Bring Your Own）キー未設定の訪問者でも内蔵AI（48ツール・地図操作・資料生成）がそのまま使える。`model` 必須・`GEMINI_MODELS` 許可リスト・1MB 上限・レート制限・認証モード連携（トークン/Cookie/IAP）
- ドキュメントページ `ai-tools.html` — 内蔵AIが制御できる全48ツールの引数・提供条件・実行モデルの詳細仕様
- Gemini 設定タブにサーバーキー経由のAI利用可否表示（`aiProxy` 検出時）

### Changed

- Gemini 既定モデルを `gemini-3.1-flash-lite` に更新（`gemini-2.5-flash` が新規キーで使用不可になったため）
- Gemini 設定のセキュリティ注記を正確な脅威モデルに更新（localStorage はオリジン・プロファイル分離のため他ユーザーからは読み取れない旨を明記）
- ハッカソン提出を「V3（AI 連携）の強化」として再構成（`hackathon.html`・`features/v3.html`）

### Removed

- サーバーサイドエージェント実装を廃止（Cloud Run `POST /agent/chat`・Cloudflare 移植版・`agent/app/agent.py`・`tools.py`・`google-genai` 依存）。エージェントはブラウザ内蔵AIに集約し、外部エージェント窓口は任意URL接続の拡張点として残置
- V6（ANTIGRAVITY エージェント完成）のバージョン予約とドキュメントページ `features/v6.html` を撤去
- ドキュメントサイドバーのページ内目次（このページ）

### Fixed

- BYO キー未設定時に `noApiKey` で早期 return し `/api/gemini` プロキシへ到達しなかった問題

## [5.10.0] - 2026-10-11

### Changed

- 「共有」タブを廃止し、現在位置URLコピーをタブバー右端の 🔗 アイコンに集約（クリックでコピー、✓フィードバック付き）
- サイドパネルのタブ順を使用頻度・操作の流れに合わせて見直し（レイヤ → 凡例 → 検索 → 属性 → カメラ → 表示 → 情報）

## [5.9.0] - 2026-10-11

### Added

- サイドパネル右端に ⚙ ボタンを追加し、管理ウィンドウ（モードレス・ドラッグ移動・最小化可能）を新設。上部カテゴリタブ＋カテゴリ内サブタブの2階層で「プロジェクト / AI / Google Maps / アプリ（ローカルサーバー版のみ）/ その他」を整理
- サイドパネル右端に ? ボタンを追加し、オンラインヘルプを新規タブで直接開くようにした

### Changed

- サイドパネルを閲覧用（レイヤパネル）に再構成。「Google」「アプリ」「設定」のトップタブを撤去し、管理系機能は管理ウィンドウへ移設（Gemini・外部エージェント・生成プラグインは「AI」、Maps キー・3D Tiles は「Google Maps」、rclone・クラウド・ドライブ・保存は「アプリ」、言語・ポート・更新・停止は「その他」）
- 旧「設定」タブは表示系だけが残ったため「表示」タブに改名し、サブタブを 地形 / ドレープ / 3D Tiles / 効果 に整理
- 断面クリップを設定からカメラタブへ移設（カメラ位置依存の操作のため）
- 3D Tiles パネルの各項目の説明文をホバー時のみ対象項目の上に表示するツールチップ化（`pointer-events:none` で項目操作を妨げない）

### Fixed

- 表示タブ整理時のサブパネルIDリネームに追従できず「ベクター描画件数の上限」入力欄が潰れていた問題を修正

## [5.8.1] - 2026-10-10

### Changed

- CesiumJS を 1.145 から 1.146 に更新（implicit tiling の読み込み高速化・メモリ削減、ドレープされたポリラインの幅修正などを含む）

### Fixed

- レイヤータブの「ベクター描画件数の上限」入力欄が `.terrain-control input{width:15px}` の影響で 16px に潰れていた問題を修正
- アプリパネル移動に伴い `.terrain-control` の外に出た権限ラジオボタンが全幅に伸びていた問題を修正（チェックボックス・ラジオを小さい既定サイズに戻す）

## [5.8.0] - 2026-10-10

### Changed

- 「アプリ」パネルのサブタブを依存する外部システム・スコープごとに4分割。rclone（ツール導入・リモート追加/OAuth）・クラウド（接続・停止）・ドライブ（Windows の `net use` によるドライブ割当）・保存（プロジェクトへの書き込み: `.kasc` クラウド保存・起動時自動接続行の生成・`_local/` 納品パッケージ生成）に整理し、各タブに独立したステータス行を設置
- 「起動時の自動接続」（インスペクタへの `cloud:` 設定行生成）をクラウドタブから保存タブへ移動。プロジェクトに保存される設定としてスコープ基準で統一

## [5.7.0] - 2026-10-10

### Changed

- ローカルサーバー版のみの機能（rclone クラウド連携・プロジェクト保存/納品パッケージ生成）を設定パネルからトップ階層の新設「アプリ」パネル（クラウド・保存のサブタブ）へ移動。V5（アプリ化・ローカル連携）の機能群を1箇所に集約し、設定パネルは環境非依存の項目のみとなった
- 「アプリ」タブは capabilities の `cloudRclone`（127.0.0.1 ローカル実行）がある環境でのみ表示され、静的配信・コンテナ実行ではタブ自体が非表示になる

## [5.6.0] - 2026-10-10

### Added

- 納品用ローカル化で `3dtiles:` レイヤーのリモート参照に対応。`tileset.json` を起点に外部タイルセット（.json）とコンテンツ（`content.uri`/`contents[].uri`）を再帰的に辿り、`DATA/http/3dtiles/<name>/` へ一式取得して複製 .kasc の参照をローカルの tileset.json に書き換える（保存先は取得元別 `cloud/`・`http/`・`local/` の原則に従う）。ルートディレクトリ外・別オリジンへの参照は `_ext/` に集約し参照元 JSON の uri を相対パスへ書き換え。対応は `http/_sources.json` に記録。ベースマップ相当のサービス（`tile.googleapis.com` の Google Photorealistic 3D Tiles・`assets.cesium.com`/`api.cesium.com`）と implicit tiling は対象外。上限は 1タイルセット 10,000 ファイル・1ファイル 256MB。API 応答に `tilesets`・`tilesetSkipped` を追加
- 納品用ローカル化で `xyz:` 行のリモート `{z}/{x}/{y}` テンプレートに対応。タイル本体は取得せず（範囲が曖昧なため）、ユーザーがタイルを配置する受け皿 `DATA/http/xyz/<name>/` を生成し（配置手順の `_README.txt` を同梱）、複製 .kasc の参照をローカルテンプレートへ書き換える。元 URL は `http/_sources.json` に記録し API 応答に `xyzTiles` を追加。ローカルの `DATA/.../{z}/{x}/{y}.png` 参照は従来通り `DATA/local/` へディレクトリごと複製。`base:` のベースマップ相当は対象外
- `xyz:` 行に `minimumLevel=`（互換 alias `minZoom`）と `bbox=西経,南緯,東経,北緯` オプションを追加。Cesium の `minimumLevel`/`rectangle` に反映され、タイル未配置範囲へのリクエストを抑止。bbox 指定時は flyTo もその範囲を向く

## [5.5.0] - 2026-10-10

### Added

- 設定 > プロジェクトタブに「プロジェクトルート」欄を追加。現在のプロジェクトの実フォルダ（外部プロジェクトは .kasc のある登録フォルダ、通常プロジェクトは `projects/<id>/`）を表示し、相対パス解決の基点を画面上で確認できる。ローカルサーバーは `projects.json` の応答に `dir`（実パス）を付与し、外部プロジェクトは `kasc`（実ファイル名）も返す。静的配信・コンテナ実行ではパスを露出させず `projects/<id>/` 表示にフォールバック

## [5.4.0] - 2026-10-10

### Changed

- 納品用ローカル化の出力を `<プロジェクト名>_local/` ワークスペース生成に変更。元プロジェクトは変更せず、群マニフェスト `projects.json`・プロジェクト複製・`DATA/` を含む自己完結パッケージを生成する。フォルダごと ZIP にして渡せば受け取り側は複製内の .kasc を開くだけで群登録される
- 複製した既存ローカルデータは `DATA/local/` に集約し、取得したデータ（`http/`・`cloud/`）と混在しない。複製 .kasc の既存参照は `DATA/local/x`・`../DATA/local/x` に書き換える（`sql:` クエリ内リテラル・`style=`/`qml=`・タイル系行のローカル参照も対象）
- 共有スコープは `_local/DATA/`（`../DATA` 参照）、専用スコープは複製内 `DATA/`（`DATA` 参照）に取り込み、元のローカル `DATA/`・親の共有 `DATA/` も複製するため `_local/` 単体で全参照が解決する
- 再実行は `_local/` を毎回作り直すため、前回出力や別スコープの残りファイルが混ざらない
- UI は生成先パスを結果表示に含め、元プロジェクトが変わらないためリロードを廃止。API 応答に `outputPath`・`projectDir` を追加
- 同梱サンプルプロジェクト（default）の .kasc をリモート URL 版に戻した（ローカル化は `_local/` 側で行うため）

## [5.3.1] - 2026-10-10

### Changed

- インストーラー同梱のサンプルプロジェクト（default）をローカル化: 外部 HTTP(S) 参照（GeoParquet・FlatGeobuf・GeoJSON・info/legend）を共有 `DATA/http/` にダウンロードして `../DATA/http/` 相対参照へ書き換え、出典一覧を `DATA/http/_sources.json` に記録。オフライン環境でもサンプルがそのまま動作し、5.3.0 の共有データ参照（`../` スコープ）の実例にもなっている

## [5.3.0] - 2026-10-10

### Changed

- 納品用ローカル化に「共有（既定）」／「専用」の保存先選択を追加。共有はプロジェクトフォルダの1つ上の `DATA/`、専用はプロジェクト内の `DATA/`。API は `scope: "shared" | "project"` を受理し、省略時は共有。
- HTTP(S) の保存先を `http/` に統一し、旧保存先との互換維持は行わない。クラウド出力は `cloud/<取得元ハッシュ>/` に分離。
- SQL のローカル化結果も相対パスで保存し、描画・属性検索時に解決。納品先の登録IDに依存しない。

### Fixed

- 出典一覧と既存ファイルを考慮して同名衝突を回避（大文字小文字違い・出典一覧の予約名を含む）。ローカル化処理の同時実行を直列化。
- 群マニフェストを先に読み、起動対象にも指定の表示名・従来の指定IDを反映。`dir` を指定すればマニフェストの `id` は省略可能。内部IDは画面・API用に引き続き自動生成。

### Added

- **共有データ参照（`../`・階層スコープ）**: `.kasc` の相対URLで `..` がプロジェクトフォルダの1階層上を指すようになった。通常プロジェクトは `../DATA/x` が全プロジェクト共有の `projects/DATA/` に、外部プロジェクトは .kasc のあるフォルダと並列の `DATA/` に解決される。さらにプロジェクト群フォルダに `projects.json`（群マニフェスト）を置くと階層スコープが有効化され、`納品/{DATA, ProjectsA/{projects.json, P1, P2}, ProjectsB/{...}}` の構成で `../` = 群内共有、`../../DATA/` = 全プロジェクト群が共有するワークスペースルートの DATA/ になる。マニフェストの連続する分だけ上に出られ、無い構造では1階層上まで（それより上は拒否。外部プロジェクトでは `..` をブラウザのURL正規化で畳まれない `@parent` マーカーとして送信しサーバー側で解決）
- **プロジェクト群の一括登録**: 群の中の .kasc を1つ登録すると、親フォルダの `projects.json`（群マニフェスト、`{id,title,dir?,kasc?}` の配列）に列挙された全プロジェクトがまとめて登録される。`/api/projects/register` の応答 `registered` に全 id が返る。ZIP 納品では群内の .kasc を1つダブルクリックするだけで全プロジェクトが一覧に並ぶ

## [5.2.0] - 2026-10-10

### Added

- **.kasc ファイル関連付けによる起動（外部プロジェクト）**: インストーラー版で `.kasc` ファイルをダブルクリックすると、そのファイルをプロジェクトとして登録し `?project=<id>` で開く。`.kasc` のあるフォルダがそのままプロジェクトルート（`/projects/<id>/` の配信元）になり、`DATA/` 等の相対参照はそのフォルダ基準で解決されるため、`.kasc` + `DATA/` をまとめたフォルダをそのまま納品できる。ファイル名は `kasugai_canvas.kasc` 以外でも可（同一フォルダの複数 .kasc は別プロジェクトとして登録）
  - 登録は exe 隣の `kasugai_canvas.projects.json` に永続化され、プロジェクト一覧に残る。システム（インストール先）とプロジェクト（任意の場所）を分けて管理できる
  - 起動済みインスタンスがある場合は `POST /api/projects/register` で登録を引き継ぎ、そのプロジェクトをブラウザで開く
  - `DELETE /api/projects/{id}` で外部プロジェクトの登録解除（ファイルは削除しない）
  - `/api/files`・`/api/cloud/localize` 等のプロジェクト系 API も外部プロジェクトに対応（DATA/ の読み書き・ローカル化は登録フォルダに反映）
- **納品用ローカル化の拡張（`POST /api/cloud/localize`）**: クラウドルートの `DATA/cloud/` コピーに加え、`.kasc` 内の http(s) 参照（ベクターレイヤー URL・`style=`/`qml=`・`info:`/`legend:`・`sql:` クエリ内 URL）を `DATA/net/` へダウンロードして参照を書き換える。重複 URL は1ファイルに集約し、出所一覧を `DATA/net/_sources.json` に記録。タイル系は対象外。クラウドパネルのステータスに同期結果の内訳を表示するよう改善

## [5.1.0] - 2026-10-10

### Added

- **クラウド接続のインスペクタ行（`cloud:`）による起動時自動接続**: インスペクタに `cloud: リモート名 | ルートフォルダ | perm=write | drive=K` と書くと、`.kasc` の読み込み（起動時・プロジェクト切替・登録ボタン）のたびに `/api/cloud/serve` を自動実行する。`.kasc` に残せば起動時に接続済みの状態で始まり、レイヤーURLの `cloud:パス` もそのまま使える
  - ルートフォルダはパスに加えてフォルダURL（フォルダID起点接続）を指定可。`perm=write` で読み書き（省略時は読み取り専用）、`drive=K` で Windows ドライブ割当まで自動化
  - `cloud: stop`（または `disconnect`）で接続停止、行末の `| off` は「設定は残すが接続しない」
  - 既に同じ内容で接続済みなら再起動せず、指定が変わったときだけ再接続する
  - **rclone 未導入時の自動インストール**: 接続前に `installed:false` なら `POST /api/cloud/install` で公式配布物を既定配置（Windows は `C:\kasugai\rclone`）へ自動導入してから接続。`install=off` で無効化できる
  - クラウドタブに「起動時の自動接続」セクションと「現在の設定をインスペクタに追記して接続」ボタンを追加（既存の `cloud:` 行は置換・重複しない）
  - WEB版（静的配信・Cloud Run）では `/api/cloud/*` が存在しないため `cloud:` 行は無害にスキップされる。同一 `.kasc` をアプリ版とWEB版で環境非依存に使い回せる

## [5.0.0] - 2026-10-10

機能テーマ **V5「アプリ化（ローカル連携）」** の開始区切り。ローカル Rust サーバーと一体で動く「アプリ」だから実現できる機能群（クラウドストレージ連携・ドライブ割当・ローカルファイル保存・納品用ローカル化）を本テーマとして展開していく。ブラウザのみ・コンテナ実行では提供されない機能群であり、ブラウザ GIS との差別化要因となる。ANTIGRAVITY エージェント完成の採番予約は V6（v6.0）に繰り下げ。

### Added

- **納品用ローカル化**: `POST /api/cloud/localize` とクラウドパネルの「クラウドの内容をDATA/へ同期（納品用）」ボタンを追加。接続中のクラウドルートを `rclone copy` で `projects/<id>/DATA/` へ丸ごとコピーし、`.kasc` 内の `cloud:` 参照を `DATA/` に書き換える。納品先は rclone・OAuth 不要でファイル一式だけで動くローカル完結パッケージになる。`..` 等を含む `cloud:` 参照はプロジェクト外に出るため書き換え対象外

### Changed

- ドキュメントをバージョンテーマの流れに再構成: V1 GIS基本 / V2 プレゼンテーション / V3 AI連携 / V4 プラグイン（認証機構）・外部連携 / V5 アプリ化（ローカル連携） / V6（予約）ANTIGRAVITY。features.html の V5 節にクラウド・ローカル保存・納品用ローカル化を集約し、サイドバー子メニューも対応

## [4.21.0] - 2026-10-10

### Added

- **クラウドストレージ連携（rclone）**: レイヤーパネルの設定タブに「クラウド」パネルを追加し、Box / GoogleDrive / OneDrive / Dropbox / pCloud / MEGA / WebDAV / S3 を rclone 経由で接続できるようにした
  - rclone の自動検出（設定パス → PATH → `C:\kasugai\rclone`）と、未導入時に公式配布物を指定フォルダへダウンロード配置する機能
  - リモート一覧・追加（種別を選ぶとその名前で `rclone config create` を起動し、ブラウザで OAuth 認証）
  - 読み取り専用 / 読み書きの権限選択と接続開始・停止
  - Windows ドライブ割当（既定 K:）。`rclone serve webdav` + `net use` により、クラウドをエクスプローラーから操作できる仮想ドライブとして利用可能
  - アプリ内プロキシによる `cloud:` スキームで、レイヤーURLからクラウド上のファイルを直接参照。HTTP Range 転送に対応し DuckDB-WASM 等の範囲読み経路でも利用可。読み取り専用接続での書き込みは 403 で拒否
  - ルートフォルダはパスに加えてフォルダURLを受け付け、`root_folder_id` 起点で接続（Box の `/folder/<id>`・共有リンク `/s/`、Drive の `/folders/<id>`、OneDrive・pCloud の `?id=`）。権限や共有経路でリモート内の見える位置が異なっても、全員が同じフォルダをルートとして参照できる
  - 接続中のストレージへ `.kasc` プロジェクト設定を保存可能
  - ローカルサーバー（`local` ティア）のみ有効。`/api/capabilities` に `cloudRclone` を追加し、コンテナ実行時は `/api/cloud/*` を公開しない

### Changed

- `auth-selector.js`・`styles.css` をクエリ付き動的読み込みに変更し、ブラウザキャッシュによる旧フロントエンド資産の残留を防止
- `GET /api/cloud/status` などクラウド系API応答を `no-store` で取得するように変更

## [4.20.3] - 2026-10-05

### Changed

- **引数なし起動でもブラウザを開くのを既定に変更**: `--open-browser` を付けずに exe を起動（手動作成のショートカット・exe ダブルクリック等）するとサーバーだけが起動し、ウィンドウレスのため「何も起きない」ように見える問題への対策。サイレント起動用に `--no-browser` を追加し、自動更新後の再起動スクリプトと `run.py`（開発起動・リリース起動・ビルド時のバージョン検証）は `--no-browser` で起動する。`--open-browser` は後方互換のため引き続き受理（既定と同じ挙動）。コンテナ実行（`PORT` 設定時）ではブラウザを開かない

## [4.20.2] - 2026-10-05

### Fixed

- **ショートカットから起動しない問題を修正**: KASUGAI Canvas が既に起動済みでポートを占有している場合、ショートカットから起動した新プロセスがバインド失敗（AddrInUse）で無言終了し「起動しない」ように見えていた。ポート占有時は `/health` で占有者が KASUGAI Canvas 本体か確認し、本体であれば既存インスタンスのブラウザを開いて正常終了するようにした（別アプリが占有している場合は従来どおりエラー終了）

## [4.20.1] - 2026-10-01

### Fixed

- **自動更新の無限ループを修正**: `latest.json` が指すバージョンより配布 ZIP の exe が古い場合、自動更新が「適用→再起動→依然古い→再適用」を無限に繰り返す問題を修正。同一タブ内で同じ対象バージョンへの自動更新は一度きりとし（`sessionStorage` に試行済みバージョンを記録）、再起動後もバージョンが変わらなければ「自動更新を停止しました」と表示して手動更新に委ねる。手動の「最新版をインストール」ボタンは従来通り動作
- **`/api/update/install` にバージョン下限チェックを追加**: `latest.json` のバージョンが現行以下を指す場合は 409 で拒否し、古い配布物へのダウングレード・無用な再インストールを防止
- 4.20.0 リリース時に `download/kasugai_canvas.zip` が再ビルドされず中身が 4.19.0 のままだった問題を修正（今回 `run.py -B` で ZIP 内 exe の /health バージョン検証まで実施）

## [4.20.0] - 2026-09-28

### Added

- **外部エージェント呼び出し**: Google → エージェント タブにエンドポイントURL・Bearerトークン（任意）・有効化トグルを追加。有効時はチャット入力を Gemini より優先してエンドポイントへ POST（`{message, project, camera, layers, history}`）。応答JSONの `actions:[{name,args}]` はAIチャットと同名のツール（flyTo・setLayerVisible 等）として順次実行。外部で構築したエージェント（Antigravity等）を静的配信のまま接続できる。Gemini キー未設定でもエージェント設定のみでチャットパネルが有効化
- **ローカルファイル保存 API `/api/files`**（ローカルサーバー版のみ・`fileWrite` 能力）: `GET /api/files?project=` で `projects/<id>/DATA/` 内の再帰一覧、`PUT /api/files/{project}/{*path}` で書き込み（サブフォルダ可・64MB上限）、`DELETE` で削除。パスは `..`・`\`・`:` を拒否して DATA/ 内に限定
- インスペクタータブに「DATA/ に保存して追加」ボタンを追加。選択ファイルを DATA/ へ保存（ローカルサーバー版は `/api/files`、それ以外は File System Access の選択フォルダ）し、`.geojson`/`.json`/`.gpkg`/`.fgb`/`.parquet` は対応する `.kasc` 行を自動追記して即時適用
- 描画ルートの読み込み・保存でローカルサーバー版は DATA/ を `/api/files` 経由で列挙・保存（File System Access 不要・ブラウザ非依存）
- AI ツール `listDataFiles` / `saveDataFile` / `deleteDataFile` を追加（`fileWrite` 能力時のみ公開・上書き/削除は確認ダイアログ）
- **Google Maps Platform 拡充**: 検索タブのプロバイダに「Google」を追加（Maps API キー保存時のみ有効）。Geocoding API（住所向け）と Places API (New) テキスト検索（施設・キーワード向け）を並列で呼ぶハイブリッド検索で、片方が失敗しても他方の結果は返し、座標約11m単位で重複を除外する。AIツール・`searchLocation` の `provider` 引数では `places`（Placesのみ）も個別指定可能。AI ツールに `searchPlaces`・`openStreetView`（Street View メタデータ確認後に別タブでパノラマを開く。`source=outdoor` の公式屋外パノラマを優先し、確認した `pano_id` をURLに含めて最寄りの暗い/不良パノラマへの誤着地を防止）を追加（Maps API キー設定時のみ公開）。`searchLocation` ツール/API に `provider` 引数を追加し、検索タブの選択プロバイダを既定にした
- **Street View の UI 導線**: 検索結果各行に「SV」ボタンを追加（その地点の Street View を別タブで開く）。検索タブに「地図をクリック → Street View」ボタンを追加し、ワンショットの地点拾いモードでクリック位置の Street View を開ける。「Street View の候補ラインを表示」チェックで、撮影済み箇所の青いラインを地図上にオーバーレイ表示（Google マップ内部の `photometa/ac/v1` カバレッジデータを z17 タイル単位で取得し、パノラマ間リンクをポリラインとして描画。キー不要・非公式）
- **Maps Web サービス用キー（任意）**: Google → Map パネルに第2のキー入力欄を追加（`googleMapsWsApiKey`）。Geocoding/Places/Street View は Web サービス API で HTTP リファラー制限付きキーを拒否するため、リファラー制限付きのメインキー（Map Tiles/3D Tiles 用）とは別キーを設定できる。未設定時はメインキーにフォールバック。キー関連の案内文言を「リファラー制限推奨」から「API 制限＋Web サービス用別キー」方針に修正
- Yahoo 検索プロバイダの実処理を追加（`yahooappid:` が設定された `.kasc` で有効化。従来は選択肢のみで実際の呼び出しは未接続だった）

### Changed

- 検索タブのプロバイダ選択を実際の検索呼び出しに反映（従来は常に地理院検索だった）

## [4.19.0] - 2026-09-27

### Fixed

- GPKG レイヤーの属性値一覧で行をクリックしても地物へ Fly しない問題を修正。GPkgBinary ヘッダにエンベロープを持たない地物（作成ツールによって省略される）は行位置が `null` になりクリック不可になっていたため、エンベロープが無い行は WKB をデコードして座標範囲の中心を位置とするフォールバックを追加（`geoJsonGeometryEnvelope()`）
- GPKG Worker のコマンド処理を直列化。`reset`（プロジェクト/インスペクター変更）が `openDb` ペンディング中の DB を close し、同じ Promise を待つ `load`/`attrs` が `Database closed` で失敗し得る競合を解消

## [4.18.0] - 2026-09-27

### Fixed

- 3D Tiles 地物をクリックしても属性が空（レイヤー名ヘッダのみ）だった問題を修正。構造化メタデータ（EXT_structural_metadata）系の `Cesium3DTileFeature` には `getPropertyNames()` が存在しないため、`getPropertyIds()` を優先してプロパティを列挙するようにした

### Changed

- 地物クリック時の属性表示を `scene.pick` から `scene.drillPick`（上限16件）による複数件対応に変更。重なった地物（ポリゴン等）は先頭に件数を表示し、「番号. グループ / レイヤー名」のヘッダ一覧を手前から順に出す。ヘッダー行をクリックするとその地物の属性テーブルが開閉し（複数件時は既定で全件折りたたみ、1件のみなら展開表示）、展開した地物のレイヤーが「選択中のレイヤ属性一覧」の対象になる。同一地物の重複ピック（entity の複数描画・GeoJsonPrimitive のマルチジオメトリ分割・3D Tiles feature の別インスタンス化）は除外

## [4.17.0] - 2026-09-25

### Added

- **ベクター描画件数の上限**（設定タブ「ベクター描画件数の上限」・既定 20000・0/空欄/不正値=無制限）を追加。entity 描画ベクターの合計件数バジェットでブラウザフリーズを防止し、超過レイヤーはレイヤー一覧に `描画数/全件数` バッジを表示。切り捨ては描画のみで、フルソースを `item.geojsonSource` に保持するためベクター検索・属性一覧・`getLayerGeoJson` は常に全件対象
- **非クエリ系の表示範囲連動スライス**: 件数上限を超える `geojson:`/`geoparquet:`/`flatgeobuf:` 等のレイヤーは表示範囲内の地物を優先描画し、`camera.moveEnd`/`camera.changed` でメモリ上の全件データから再スライス（再ダウンロード無し）。検索・属性一覧から未描画地物へ飛んでも、その場所で描画が復活する
- `listLayers` API に `bboxAuto`/`entityLimited`/`viewportSliced` フィールドを追加
- QGIS レイヤースタイル（.qml・QGIS 4 以降対象）を全ベクター系行タイプで適用できる `style=QMLファイルURL` オプションを追加（`web/qml-style.js` 新設）。singleSymbol / categorizedSymbol / graduatedSymbol / RuleBased の各レンダラ、SimpleMarker（canvas 生成・SVG/フォントマーカー近似）・SimpleLine（破線対応）・SimpleFill（単色・ハッチ/ドット/画像パターン）、`<labeling>` のラベル（フォント・ハロー）、データ定義プロパティ・縮尺依存ルールをカバー。entity（GeoJsonDataSource）と primitive（GeoJsonPrimitive・BufferMaterial を featureId 単位で適用）の両描画経路に対応。未対応要素はフォールバックしコンソールに警告。取得は直接 fetch（CORS 前提）で、失敗時はローカルサーバーの `/api/fetch` へフォールバック。`.kasc` プロジェクトからの相対パスも解決
- `gpkg:` / `geopackage:` 行タイプを追加。GeoPackage を sql.js（SQLite WASM・CDN 遅延ロード）で直接開き、地物テーブルを GeoJSON 化して描画。読み込みは `web/gpkg-worker.js`（module Worker）内で実行するため、ダウンロード・SQLite 展開・WKB デコード中も地図操作をブロックしない。開いた DB は Worker が URL キーで保持し、再クエリは再ダウンロード不要。`table=地物テーブル名` で複数テーブルから選択可。絞り込みオプション `where=`（SQLite 式）/`limit=`/`columns=`（属性列プルーニング）/`bbox=auto`（各行の GPkgBinary エンベロープで表示範囲判定し範囲外の WKB デコードをスキップ。カメラ停止で再クエリ）を追加し、指定時はクエリ系レイヤーとして動作（⏷フィルター編集・属性一覧の全件クエリ・ベクター検索索引の対象外）。QGIS が「データベースに保存」する `layer_styles` テーブルの QML を `useAsDefault` 優先で読み取り自動適用（`style=` 明示指定が優先）。`duckdb:` で `.gpkg` 拡張子・`format=gpkg` を指定した場合も同経路へ振り分け（DuckDB spatial の `ST_Read` は非 COI 環境でスレッド生成に失敗するため不使用）
- AI ツール `addLayer` の `type` に `gpkg`/`geopackage` を追加

### Changed

- `duckdb:`/`gpkg:`/`geopackage:` の `bbox=auto`（表示範囲連動フィルター）を既定 ON に変更。明示的に全件描画したい場合は `bbox=off`/`none`/`false`/`static`/`manual` を指定
- 既定プロジェクト（`web/projects/default/kasugai_canvas.kasc`）に GeoPackage サンプル3件（`DATA/行政区域.gpkg`・Ian 洪水 GPKG の2テーブル）を `| off` で追加

## [4.16.0] - 2026-09-24

### Changed

- 静止時の再描画を抑制する `scene.requestRenderMode` を有効化。`clock.shouldAnimate=false` でシミュレーション時計も停止（時計が動いたままだと時刻変化で毎フレーム描画され効果が出ないため）。入力イベント捕捉による `requestRender` 要求と、`refreshLayers`/`reloadVectorLayer` 等の非同期ロード完了時の明示的な描画要求を追加。タイルロード完了後の静止時はほぼ描画が止まり（実測 5 秒で 1 フレーム）、カメラ操作・LOD 精緻化・flyTo 中は従来通り描画される
- 技術ドキュメント（01-データ/02-ライブラリ/05-QGIS連携）の deck.gl 前提の記述を現行の CesiumJS + Three.js 構成に更新し、全ドキュメントのバージョンバッジを統一

### Removed

- 未使用の `web/bootstrap.js`（deck.gl ローダー。描画エンジンの CesiumJS 移行後に残っていたデッドコード）を削除

## [4.15.0] - 2026-09-24

### Added

- ベクトル検索の対象範囲を選択可能に。レイヤー選択肢に「表示レイヤ」を追加し、表示中のレイヤーだけを対象にレイヤー単位で検索できる（結果行にレイヤー名を表示。属性・値ドロップダウンも表示中レイヤーの集約に絞られる）。翻訳キー `vector.visibleLayers` を8言語に追加

### Changed

- 「全選択」の文字検索を、非表示・未読み込みのレイヤーも含めた全レイヤー対象に変更。検索の実行時に未読込の非クエリ系レイヤーをまとめて読み込んで索引・検索する（選択しただけでは読まない・読み込んでも表示状態は変えない。従来は読み込み済みレイヤーのみが対象だった）

### Fixed

- AGENTS.md の動作確認手順に、サーバーが exe 隣接の `web/`/`projects/` を `--dir` 指定より優先配信する仕様（`resolve_dir`）と、検証前に配信内容・ポート占有を確認する注意を追記（`server/target/debug/` に残った古いコピーが配信され編集前のコードでテストしてしまう事故の再発防止）

## [4.14.0] - 2026-09-24

### Added

- 描画方式 `render=primitive|entity` を全ベクター系行タイプ（`geojson:`/`layer:`/`geoparquet:`/`flatgeobuf:`/`duckdb:`/`sql:`）で共通化。レイヤー行の明示指定は設定タブの「ベクター高速ドレープ」グローバル設定より優先され、`render=entity` で個別に entity 描画へ戻せる。高速ドレープの対象も GeoJSON 限定から全件読み込み系ベクター全形式（GeoParquet/FlatGeobuf/インラインデータ含む）に拡張し、設定ラベル・ヒント（8言語）を「ベクター高速ドレープ」に改称
- `render=primitive`（および高速ドレープ）で描画したレイヤーでも `getLayerGeoJson()` が GeoJSON を返すように、描画に使ったソースを `item.geojsonSource` に保持（参照のみ・追加取得なし）
- primitive 描画・高速ドレープのレイヤーをベクター検索の索引対象に追加（保持した GeoJSON から索引を構築。位置はジオメトリ頂点の平均）。高速ドレープの `fromUrl` 経路は廃止し、`loadVectorSourceCached` + `fromGeoJson` に統一（キャッシュ共有のため二重取得なし）
- ベクター検索パネルのレイヤー選択肢に未読み込みレイヤーを「(未読込)」付きで表示し、選択された時点でオンデマンド読み込み→索引→検索可能に（属性・値一覧と同じ「候補には出すが選択されるまで読まない」方式。読み込んでも表示状態は変えない。「全選択」は読み込み済みレイヤーのみ対象。翻訳キー `vector.unloadedSuffix` を8言語に追加）
- AI ツール：全ベクター形式対応の `addLayer(title, target, {type, options})` を新設（`geojson`/`layer`/`geoparquet`/`flatgeobuf`/`duckdb`/`sql`）。`addGeoJsonLayer` は互換エイリアスとして維持。8言語のシステムプロンプトに行タイプ一覧を追記
- `sql:` 行に出典指定 `| attr=出典`（`attribution=` 別名可）を追加。⏷フィルター編集での行書き戻しでも保持
- `duckdb:` に `proxy=on` を追加（opt-in）。ローカルサーバーの `/api/fetch` 経由で取得し、CORS 非対応の外部データを読める。`/api/fetch` は Range/HEAD リクエストを上流へ転送するようになり（`Content-Range` 等の応答ヘッダー伝播・capabilities に `fetchRange` 追加）、Parquet の部分読み（メタデータ・row group スキップ）がプロキシ経由でも有効
- URL 系ベクター行（`geojson:`/`geoparquet:`/`flatgeobuf:`/`duckdb:` 等）のオプション欄でも `attr=出典` を指定可能に
- AGENTS.md に「動作確認（必須）」節を追加（修正後は構文チェックだけでなくブラウザ実機・実リクエストでの検証を必須化）

### Fixed

- `geojson:`/`xyz:`/`duckdb:` の出典スロット（3番目の `|` フィールド）に `render=primitive` 等の `key=value` オプションを書くと出典として誤採用される問題を修正（`parseAttributionField` で除外）。`duckdb:` は出典スロット位置に書かれたオプションも解釈するよう緩和
- AI ツール `addLayer` が生成する行で、オプション指定時に出典スロットを空埋めせず `where=` 等が出典に誤配置される問題を修正

## [4.13.0] - 2026-09-22

### Changed

- `duckdb:`/`sql:` レイヤーの既定描画を GeoJsonPrimitive バッチから entity（`GeoJsonDataSource`）に変更。既定で地形・3D Tiles へのドレープ（クランプ）が効くようになり、起伏のある地形でジオメトリが地表に埋まる問題を解消。大量地物向けの軽量バッチ描画は `render=primitive`（`sql:` は末尾 `| render=primitive`）で opt-in 可能

### Added

- ドキュメント：`duckdb:`/`sql:` で FlatGeobuf（`.fgb`）が読めることを明記（spatial 拡張の `ST_Read`/`format=read`、拡張子からの自動判別も可）。home.html のクエリ系カードに FlatGeobuf を追加し、entity/primitive 描画方式の違いを一覧化

## [4.12.0] - 2026-09-22

### Added

- FlatGeobuf レイヤー：インスペクターの `.kasc` 設定で `flatgeobuf: タイトル | URL | on/off` 行を新規追加。CDN 配信の flatgeobuf 公式 JS リーダー（`geojson` サブモジュールのみ遅延ロード）でデコードし、レスポンスボディを ReadableStream のまま逐次 GeoJSON Feature 化して既存のベクター描画経路に流す。レイヤ一覧・表示切替・フォーカス・ベクトル検索・属性パネルがそのまま利用可能。空間インデックスによる範囲読みは持たない全件読み込み系だが、全件バッファリングせずストリームデコードする
- サンプル：`web/projects/default` と `installer/projects/default` の `kasugai_canvas.kasc` に FlatGeobuf 公式テストデータ（countries.fgb・国ポリゴン）を `off` で追加（geoparquet サンプルと同じ国データのため初期は非表示）
- ドキュメント：home.html のインスペクター設定仕様・対応形式一覧に `flatgeobuf:` を追記し、AGENTS.md のデータ形式方針を実装済みに更新

### Changed

- 全件読み込み系ベクターレイヤー（`geojson:`/`geoparquet:`/`flatgeobuf:`）を「必要となった初回に読み込み・2回目以降はメモリ再利用」に変更。非表示レイヤーは起動時・レイヤー更新時にロードせず（従来はドレープ有効時、`off` のレイヤーもファイル全件をダウンロード＋デコードしていた）、表示ONまたは属性値一覧での選択の時点で初めてダウンロード＋デコードする。結果は `vectorSourceCache`（id|url キー）に保持し、以降の表示切替・ドレープ変更等の `refreshLayers` や属性値一覧では再取得しない（表示経路と属性一覧経路でキャッシュ共有）。キャッシュはインスペクター/プロジェクト変更（`applyInspector`）で破棄。クエリ系（`duckdb:`/`sql:`）は条件ごとに結果が変わるため従来どおり毎回クエリ

### Fixed

- GeoParquet/FlatGeobuf の国ポリゴンなど広域ポリゴンで Cesium のレンダリングが `RangeError: Too many properties to enumerate`（`computeRhumbLineSubdivision`）で停止し、レイヤーが一切描画されなくなる問題を修正。CesiumJS の `GeoJsonDataSource` が polygon/polyline に既定で設定する `arcType=RHUMB` は、極域（南極）・日付変更線跨ぎ・重複点を含むジオメトリで rhumb 細分化が暴走する既知バグ（Cesium #7550/#7864/#8599）があるため、`buildStyledGeoJsonDataSource` で entity の `arcType` を `GEODESIC` に戻すよう変更

## [4.10.0] - 2026-09-22

### Added

- DuckDB-WASM の CDN 資産（本体 wasm・worker・拡張 wasm、計 ~60MB）を Service Worker + CacheStorage で永続キャッシュ（`web/sw-duckdb.js`、登録は `index.html` インラインスクリプト）。初回だけ CDN から取得し、以後の起動ではキャッシュから返すためダウンロード待ちが解消する。キャッシュキーは URL（`@1.32.0`/`v1.4.3` のバージョン入り）で、activate 時に現バージョンと一致しない古いエントリのみ削除する。ページ・Worker 内部のフェッチ（`importScripts`・拡張 INSTALL の内部取得含む）を透過的に扱い、DuckDB 以外の URL は一切横取りしない。キャッシュ済みの場合はクエリ系レイヤーが非表示でも起動時に WASM 初期化を先行する（`duckDbAssetsCached()` で判定し、未キャッシュ時は従来どおり表示対象のみ先行）

### Fixed

- 属性・値一覧/ベクター検索の選択肢が起動後長時間空になる問題を修正：`duckdb:`/`sql:` レイヤーが `.kasc` にあると、ベクター逐次ロードが DuckDB-WASM の CDN ダウンロード＋初期化（数十秒）でブロックされ、完了まで検索索引が構築されず選択肢が出なかった。以下を改善: 属性値一覧のレイヤー選択肢は検索索引ではなく**レイヤー一覧から即時構築**（ロード完了を待たず全ベクターレイヤーが選択可能）、**非表示のクエリ系レイヤーはロード自体を行わない**（`off` の `duckdb:`/`sql:` が起動時に WASM 初期化・ファイル取得・SQL 実行を走らせない。WASM 初期化の先行開始も表示対象のクエリ系があるときだけ。選択・表示ONの時点で必要になるまで使わないデータは読まない）、ベクターレイヤーはロードされるたびに検索索引・選択肢を逐次更新（重いデコーダー待機中でも先行レイヤーが即選択可能）、開いているウィジェットは索引更新・選択肢・行に追従。DuckDB 初期化失敗時は Promise を保持せず次回呼び出しでリトライ可能に変更
- 属性値一覧は選択時のオンデマンド読み込みに対応：未ロード（非表示・ロード待ち）の `geojson:`/`geoparquet:` 等を選択した場合、使うタイミングで実ファイルから直接行を構築する（`vectorAttrLoadCache` で重複読み込みを抑止し refreshLayers で破棄）。クエリ系・オンデマンド読み込み中は「読み込み中」、失敗時は「読み込み失敗」を表示（`vattr.loadFailed` 追加）。選択の世代番号で遅延解決した古いクエリが新しい選択を上書きしないようガード
- 属性値一覧の entity 経路で属性列が検索パネル側の選択レイヤー(`#vector-layer`)基準になっていたのを、ウィジェット側の選択レイヤー基準に修正（別レイヤーを選んだ際の列ズレを解消）

## [4.9.0] - 2026-09-22

### Changed

- 属性値一覧の entity 経路は `GeoJsonDataSource` が MultiPolygon をパート毎に分割するため、同一 properties の entity を1行にまとめて地物単位で表示（例: 5行の国データが45行に見えていた問題を解消）
- ドキュメント：home.html の対応データ形式を「ネイティブ・タイル系」「ベクター:全件読み込み系」「ベクター:クエリ系(DuckDB SQL)」の3グループに再編。`duckdb:`/`sql:` の `format=` 対応形式一覧（parquet/csv・tsv/json・geojson/read）と「全件読み込み系 / クエリ系」の使い分け表を追加。AGENTS.md にも同分類を明記

## [4.8.0] - 2026-09-21

### Added

- DuckDB-WASM レイヤー：インスペクターの `.kasc` 設定で `duckdb: タイトル | URL | on/off | where= | limit= | geom= | lon=・lat= | format=` および `sql: タイトル | SELECT文` 行を新規追加。CDN 配信の DuckDB-WASM（遅延ロード・Worker 実行）で Parquet/CSV/JSON 等を SQL で絞り込んでから GeoJSON へ正規化し、既存のベクター描画経路に流す。ジオメトリ列は GEOMETRY 型→慣用名→BLOB 列の順に自動検出（`geom=` で明示可）、WKB/WKT/GeoJSON テキストを受理し、緯度経度列のみのデータは `lon=`/`lat=` でポイント化。spatial 拡張ロード時は空間述語・`ST_Read`（`format=read` で Shapefile/GeoPackage 等）も利用可能で、拡張ロード失敗時も WKB/GeoJSON テキストのパススルーで縮退動作する
- 対話的フィルター・表示範囲連動：レイヤー一覧の ⏷ ボタンで `duckdb:` は WHERE 条件式、`sql:` はクエリ全文を変更して即時再クエリ（変更は inspector の `.kasc` 行にも反映）。`duckdb:` の `bbox=auto`・`sql:` の `:bbox` プレースホルダ指定時はカメラ停止ごとに表示範囲を `ST_MakeEnvelope`/`ST_Intersects` で絞り込み再クエリし、巨大データを「見ている範囲だけ読む」運用が可能（spatial 拡張が必要）
- バッファ描画を既定化：`duckdb:`/`sql:` は既定で entity を介さず `GeoJsonPrimitive`（バッファプリミティブ）でバッチ描画し、大量地物で軽量に動作。`render=entity`（`sql:` は末尾 `| render=entity`）で従来の entity 描画に戻せる。クリック属性表示は両方式で利用可能
- 「検索は常に全件検索」方針の徹底：`duckdb:`/`sql:` は読み込み済み行のみを対象とするベクター検索パネルに登録せず、検索・絞り込みはファイル全件を対象に評価する SQL フィルター（⏷）に一本化。`bbox=auto`+`where=` 併用時は表示が「検索 ∩ 表示範囲」になる一方、`where=` のみの `COUNT(*)` を併走して「検索ヒット全 N 件 / 表示範囲内 M 件」をコンソールに出力。クリック属性は `scene.pick` の `picked.properties` から表示（バッファ描画は地形ドレープ非対応のため、ドレープが必要な場合は `render=entity` を指定）。属性値一覧ウィジェットのレイヤー選択にも `duckdb:`/`sql:` を追加し、一覧は DuckDB に直接クエリして LIMIT 無しの全件対象（bbox・`limit=` 非適用・位置は `ST_Centroid` または lon/lat 列）で取得。ウィジェット内の検索文字は全属性列への `ILIKE` 述語として SQL に変換され、常にファイル全件が検索対象になる（表への描画は先頭1000行まで）
- Parquet 最適化：クエリ結果のジオメトリを WKB バイナリで受け取りテキスト変換・`JSON.parse` を削減（転送量・ロード時間・ピークメモリを改善）。`columns=` で読み込む属性列を絞る列プルーニングに対応。`bbox=auto` 時は GeoParquet 1.1 `covering` bbox 列（慣用名 xmin/xmax/ymin/ymax または `covering=` 指定）への範囲述語を優先し、row group 統計スキップで表示範囲外を読み込まない
- ベクターデコーダーのレジストリ化：`vectorDecoders` Map（type→`{load, query}`）に集約し、`refreshLayers` ディスパッチ・`orderedOtherLayers` フィルタ・`updateInspectorFromLayerOrder` の種類一覧をレジストリ参照に統一。今後の形式追加は「パース + デコーダー1本 + Map 登録」で完結する
- サンプル：`web/projects/default` と `installer/projects/default` の `kasugai_canvas.kasc` に `duckdb:` サンプル（NaturalEarth・`bbox=auto` 表示範囲連動・`render=entity` 描画・`off` で任意ロード）を追加
- ドキュメント：home.html の対応形式一覧に DuckDB SQL カードを追加し、CSV/TSV・Shapefile/GeoPackage を `duckdb:`/`sql:` 経路の対応済みに更新。インスペクター設定仕様に `duckdb:`/`sql:` の書式・注意事項を追記

## [4.7.0] - 2026-09-21

### Added

- GeoParquetレイヤー：インスペクターの `.kasc` 設定で `geoparquet: タイトル | URL | on/off` 行を新規追加。CDN配信の hyparquet（遅延ロード）で Parquet をデコードし、WKB（ISO/EWKB・Z/M対応）および Parquet ネイティブ `GEOMETRY` 論理型のジオメトリを GeoJSON へ変換して既存のベクター描画経路に流す。レイヤ一覧・表示切替・フォーカス・ベクトル検索・属性パネルがそのまま利用可能。Range Request 対応の `asyncBufferFromUrl` を優先し、非対応環境は全件取得へフォールバック
- サンプル：`web/projects/default` と `installer/projects/default` の `kasugai_canvas.kasc` に GeoParquet 公式サンプル（NaturalEarth国ポリゴン）を `on` で追加
- ドキュメント：home.html のインスペクター設定仕様に `geoparquet:` を追記

## [4.6.0] - 2026-09-20

### Added

- AIプラグイン生成（自己拡張）：チャットからの指示で Gemini がプラグインコード（ESモジュール）を生成し、IndexedDB のストレージプラグインとして保存・即時有効化する `savePlugin` ツールを追加。適用前にコード全文を表示する確認ダイアログを挟み、読み込みエラーは `lastError` として保存・AIへ返却するため getPluginCode→修正→再保存の自律ループが可能
- ストレージプラグイン管理：Google → エージェント タブに管理画面を追加（一覧・有効/無効・コード確認・`.kasp` 出力/取込・削除）。`.kasp` は manifest+code を1ファイルにまとめたJSON形式で、公開せず特定ユーザーへの配布にも使える
- プラグインライフサイクル：plugin-loader.js が起動時に有効なストレージプラグインを Blob URL 経由で読み込み、更新・無効化時はプラグイン宣言レイヤーを除去して再 init する再読み込みを実装
- データ取得・加工・表示ツール：`fetchData`（外部URL取得・CORS前提・約400KB打切り）、`getLayerGeoJson`（読込済みレイヤーの entity→GeoJSON 逆変換）、`addDataLayer`/`removeDataLayer`（インラインGeoJSONの一時レイヤー。simplestyle 属性で色分け・ポップアップ制御可。.kasc エクスポート対象外で applyInspector 後も存続）
- `listPlugins` / `getPluginCode` / `removePlugin` / `setPluginEnabled` ツールを追加し、チャットの systemInstruction に自己拡張とデータ加工の手順を追記（全8言語）
- IndexedDB "kasugai-canvas" を v3 にバージョンアップし `plugins` ストアを追加
- セキュリティ：サンドボックス（runCode）からのプラグイン書き込み系 API をブロック対象に追加
- 能力ティア構造：AI機能を static（静的配信のみ）/ workers（Cloudflare公開）/ local（ローカルRust）の3ティアに分け、影響範囲がセッション内に閉じる機能のみ公開環境に提供する方針を `AGENTS.md` に明文化。フロントは `GET /api/capabilities` でバックエンド能力を検出しツール・UI を出し分ける
- ローカルサーバー API：`/api/capabilities`（tier/features 通知）、`/api/fetch`（CORS回避のGETプロキシ・30秒タイムアウト・20MB上限）、`POST /api/plugins`・`DELETE /api/plugins/{id}`（PLUGIN/ 書込み・plugins.json 更新。ID検証でパストラバーサル防止）
- `publishPlugin` ツールとエージェントパネルの「公開」ボタン：IndexedDB のストレージプラグインを配布用 `PLUGIN/` へ昇格（ローカル版のみ表示・確認ダイアログ必須）
- `fetchData` はローカル版で `/api/fetch` プロキシを優先利用し CORS 制約を回避
- Rust サーバー：環境変数 `PORT` 指定時は `0.0.0.0` にバインド（Cloud Run 等のコンテナ環境対応）、未設定時は従来通り `127.0.0.1`+`KASUGAI_CANVAS_PORT`（既定8510）

## [4.5.0] - 2026-09-20

### Changed

- ナビゲーションパネルの 2D/3D 切替を、カメラ真下ではなく画面中央に表示中の地点を基点にflyするよう変更。fly先計算はレイヤパネル側で使用している `flyToFeature` に一本化し、カメラから対象地点までの距離を高さに使うことで切替前後の見え方のスケールを維持する。画面中央が地球を捉えない場合はカメラ真下の地点を基点にフォールバック

## [4.4.0] - 2026-09-19

### Added

- `run-workers.py`：Cloudflare Workers（方式4・全ファイル認証ゲート）へのデプロイ自動化スクリプト。wrangler ログイン確認・KV/R2 バインドの wrangler.toml 自動記入・シークレット登録確認・`control=4` 設定・デプロイ・認証ゲートの簡易検証まで一括実行
- `run-pages.py`：Cloudflare Pages（方式3）へのデプロイ自動化スクリプト。プロジェクト解決（`--project-name` 指定／既存プロジェクト検出／新規作成）・`control=3` 設定・`wrangler pages deploy`・動作確認を一括実行
- Fly パネルに「ルート座標の基準」セレクトを追加。「カメラ位置」（従来どおりカメラがルート上を飛行）と「画面中心」（ルート点が画面中心に来るよう進行方向の後方・上空から追従）を切替可能。画面中心時の後方距離は `height / tan(|pitch|)` で自動計算（pitch は -85〜-1° にクランプ）
- `fly_geojson:` に `view=`（エイリアス `v=`）オプションを追加。`camera`（既定）/`center` でルートごとの基準を指定可能（`center` `chase` `follow` `3rd` `third` も `center` 扱い）

### Changed

- `workers/wrangler.toml` に KV 名前空間のバインドを実設定（`KASUGAI_KV`）
- `04-auth-4-cloudflare-workers.html` を大幅拡充：Pages との設定の違いの対照表・Pages からの移行手順・`wrangler secret put` の対話入力の説明・`wrangler deploy` に引数が不要な理由（wrangler.toml 宣言式設定）・段階的なデプロイ手順と再デプロイの目安を追加

### Fixed

- Workers 認証ゲートの公開許可リストに `i18n.js`・`i18n/` を追加。未ログイン時に i18n リソースが 401 となりログイン画面自体が描画されない問題を修正

## [4.3.0] - 2026-09-19

### Added

- レイヤー一覧の各行に📍フォーカスボタンを追加。クリックするとレイヤー全体が画面に収まるようカメラが移動する（Re:Earth GeoSuite の move-btn 相当）。非表示レイヤーは自動で表示してからフォーカスする。XYZタイルなど範囲情報を持たないレイヤーは全世界表示にフォールバック
- AIチャットのツール / `kasugaiApi` に `focusLayer` を追加。レイヤー名またはIDを指定してレイヤー全体にフォーカスできる

### Changed

- レイヤー一覧の行からデータ形式（type）表示を削除し、行末を📍ボタンのみに整理

## [4.2.0] - 2026-09-19

### Added

- プラグイン宣言レイヤー：`plugins.json` の `layer` 設定を宣言すると、本体がプラグイン専用レイヤーを自動登録し、レイヤ一覧・表示切替・属性検索（ベクター検索）・属性パネルの対象になる
  - `format: "entities"`：本体生成の `Cesium.CustomDataSource` を `api.getPluginDataSource(manifest.id)` で取得し `ds.entities.add(...)` で動的 entity を管理対象化
  - `format: "geojson"`：`api.setPluginLayerData(manifest.id, geojson)` で GeoJSON オブジェクトを `geojson:` レイヤーと同じ描画経路（クランプ・ドレープ含む）で表示・更新
  - `scope`：`"app"`（既定・プロジェクト切替をまたいで存続）/ `"project"`（切替時に削除）
  - `api.registerPluginLayer(config, pluginId)` / `api.removePluginLayer(idOrPluginId)` で任意のタイミングでの追加・削除も可能
  - `plugin-layer-registered` / `plugin-layer-removed` イベントを追加
- `sample-hello` プラグインを宣言レイヤー方式の実装例として更新

## [4.1.0] - 2026-09-19

### Added

- UI 多言語対応（i18n）：英語・日本語・中国語・韓国語・スペイン語・フランス語・ドイツ語・ポルトガル語の 8 言語。`web/i18n.js` + `web/i18n/*.json` 辞書方式で、設定 → その他の言語セレクタからリロード不要で切替。選択は `localStorage` に保存し、初回はブラウザ言語から自動判定（未対応時は英語）
- AIチャットのシステムプロンプトも辞書化し、Gemini の回答言語が UI 言語に追随
- 認証方式 4（cloudflare-workers）：静的ファイル含む全リクエストを Worker で認証ゲート（`workers/`・`run_worker_first`・HttpOnly Cookie セッション）
- R2 秘匿データ配信：`.kasc` で `r2://<キー>` と記述したデータを `/api/data/*` 認証ゲート経由で配信（`KASUGAI_DATA` バケットバインド）
- FLY パネルのルート選択横に「取込」（.geojson をファイル選択で IndexedDB へインポート・常時表示）と「出力」「削除」（描画ルート選択時のみ表示）ボタンを追加
- `fly_geojson:` の URL に `route:<ルート名>` スキームを追加し、IndexedDB の描画ルートをインスペクタから参照可能に

### Fixed

- FLY パネルの「保存」（点高書き戻し）が旧 `/api/file` 専用で動作していなかった問題を修正。保存先を IndexedDB・保存先フォルダ・`/api/data/*`（R2）に対応させた
- 飛行プリセット（徒歩/車載/ドローン/広域）適用時・Q/E・+/- キー・「補正」「速度」入力欄での高さ・速度変更が `flyPath` へ反映されず、ルート再開始で元の `h=`/`speed=` に戻る不整合を修正（ピッチと同様にルート設定へ書き戻すよう統一）

### Changed

- モード3・4（cloudflare 系）で `.kasc` は KV からのみ読み込み。KV に無いプロジェクトは静的ファイルも内蔵デフォルトも使わず空で起動
- 描画ルートの保存先を保存先フォルダ（File System Access API）から IndexedDB に変更。保存時のフォルダ選択ダイアログは不要になり、静的ホスティングでも保存可能。保存先フォルダ内の `.geojson` は読み取り専用で引き続き読み込み
- `ensureDrawnRouteFlyPath` は許可済みフォルダのみ静かに読み込み、未設定時にピッカーを出さないよう変更
- Pages デプロイ・KV バインド手順ドキュメントを実際のダッシュボード導線に修正（`04-auth-3-cloudflare-pages.html`）

## [4.0.2] - 2026-09-13

### Fixed

- `web/PLUGIN/auth-local/auth.js` が ID/PASS 認証を行わずに通過していた不具合を修正
- `web/auth-selector.js` の `control` 2/3 のマッピングを `auth-methods.json` の説明と一致させ修正

### Changed

- `web/PLUGIN/auth-local/auth.js` を `auth-login-form.js` を使った ID/PASS 平文照合に変更
- ローカル認証（local）のドキュメントを修正（`home.html`、`04-auth-1-local.html`）

## [4.0.1] - 2026-09-12

### Added

- home.html V4 セクションに認証方式 0〜3 のカードと、各方式の詳細ページを追加
- 認証方式の詳細ページを HTML 形式で作成（`04-auth-0-none.html` 〜 `04-auth-3-cloudflare.html`）

### Changed

- README.md の「拡張機能（Plugin）と認証」セクションを home.html へ集約し、概要とリンクに簡素化
- `web/auth-methods.json` のデフォルト `control` を `2` から `0` に変更

## [4.0.0] - 2026-09-11

### Added

- 基本システムを拡張可能な Plugin 機構を追加
- 起動前認証プラグイン（auth-selector）と起動後通常プラグイン（plugin-loader）を分離
- `window.kasugaiApi` に viewer / Cesium / イベント / プラグイン登録 API を追加
- 認証なし（none）とローカル認証（local）を同梱
- サンプル拡張機能（sample-hello）と認証プラグイン（auth-local）を追加
- 予定していた v4.0 到達条件を v5.0 に変更

## [3.4.15] - 2026-09-08

### Added

- BASEMAP パネルの 🌐 アイコンをクリックすると、現在の視点（位置・高度・方位・傾き）を Google Earth 形式に変換して `https://earth.google.com/web/` を新しいウィンドウで開く機能を追加

## [3.4.14] - 2026-09-07

### Changed

- 「テレイン非表示」を「ベースマップ透明」に刷新。globe の描画を消す代わりに、地表色と背景を透明にして XYZ タイルのドレープだけを地形起伏の上に残す。`contextOptions.webgl.alpha`、HDR 無効化、大気ハロー非表示、`orderIndependentTranslucency` 無効化を伴う

## [3.4.13] - 2026-09-07

### Added

- トップレベルに「Google」タブを追加（設定タブの右）。サブタブ構成: Gemini / Map
- Google → Map タブに Google Maps Platform の API キー入力欄を追加（localStorage 保存、`window.kasugaiApi.getGoogleMapsApiKey()` で参照可能）
- Photorealistic 3D Tiles 表示トグルを追加。ON で Google のフォトリアル3Dタイルをレイヤ一覧へ自動追加（inspector テキストには書き込まないため .kasc エクスポートに API キーは含まれない）
- BASEMAP セレクタに「テレイン非表示」を追加。地表（globe）の描画を消しつつ地形プロバイダ（高さ）は維持

### Changed

- Gemini 設定を 設定 → Google から Google → Gemini タブへ移動
- 設定内サブタブの切替をパネル単位にスコープ化し、設定・Google で独立して動作するように修正
- Photorealistic 3D Tiles トグル ON 時に未保存の入力キーを自動保存するように変更

## [3.4.12] - 2026-09-07

### Added

- ルート描画時の地上高（AGL）を入力可能にし、デフォルトを 0m に変更
- ルートの各点を `地形高 + 地上高` で設定

### Changed

- 描画終了後、描画中のラインを自動削除

### Fixed

- 点高さ保存時のデフォルト `heightOffset` を 20 から 0 に修正

## [3.4.11] - 2026-09-06

### Fixed

- 自動更新が EXE のみを差し替え、インストール先の `web/`（フロントエンド）が古いまま残る問題を修正。更新時に ZIP 内の `web/` でインストール先を置き換えるように変更
  - 注意: この修正は次回以降の自動更新から有効。今回はインストーラーでの上書きインストールが必要

## [3.4.10] - 2026-09-06

### Changed

- 配布物を再ビルドし、最新の `web/` フロントエンド（表示/非表示ボタン・DATAフォルダ読み込み等）が含まれることを確認

## [3.4.9] - 2026-09-06

### Added

- FLYルート選択の右（ヘッダー内）にルートラインの表示/非表示ボタンを追加
- DATAフォルダ内の `.geojson` ルートを FLY パス一覧へ自動読み込み（起動時・Editタブ表示時・インスペクター登録時・フォルダ選択時）

### Changed

- Draw ボタンのラベルを「ルート描画開始」に変更し、Edit タブへ統合
- ルートラインを GeoJSON 本来の高さ（標高 + ルート高度）で常時表示（FLY 中の進捗表示を廃止）
- ルートラインの幅を 8px に拡大して視認性を向上

### Removed

- Edit タブの「Open」ボタンと drawn route ファイル一覧表示（FLY ドロップダウンに一本化）

### Fixed

- 描画ルート保存時にインメモリキャッシュではなく DATA フォルダから読み込むように修正
- `getDataDirHandle` のスコープ問題によるルート読み込みエラーを修正
- ルートエンティティの `show` が未初期化で表示切り替えが効かない問題を修正

## [3.4.8] - 2026-09-06

### Added

- FLYパネルの Draw で作図したルートを、インスペクターの「保存先フォルダ」へ `drawn_route_YYYYMMDD_HHMMSS.geojson` として保存（File System Access API、Chromium系のみ）
- 保存したルートをFLYパス一覧へ自動登録し、その場で再生可能に
- 編集タブの「Open」ボタンで保存先フォルダを開いたファイルダイアログを表示
- 保存結果・エラーを画面右下のトースト通知で表示（インスペクターを閉じていても確認可能）

### Changed

- Flyパネルの Draw タブ名を「Edit」に変更（ボタン名との重複を解消）
- 保存先フォルダ未設定時はダミーパス表示をやめ「未設定」と表示

## [3.4.7] - 2026-09-06

### Fixed

- WebView2 環境で Gemini API キー入力欄が入力欄が極端に狭くなる問題を対策（size 属性と min-width !important）

## [3.4.6] - 2026-09-06

### Fixed

- WebView2 環境で Gemini API キー入力欄が最小幅に縮まる問題を修正

## [3.4.5] - 2026-09-06

### Fixed

- インストーラー/ショートカットからのブラウザ起動が `cmd /C start` では信頼性が低いため、`opener` クレートの `ShellExecuteW` 経由に変更

## [3.4.4] - 2026-09-06

### Fixed

- `Orbit` / `Fly` 切り替えボタンクリック時に `drawTabActive` がリセットされず、`Orbit` モードでも Fly パネルが残る問題を修正

## [3.4.3] - 2026-09-06

### Docs

- `home.html` に API 構成の簡潔な説明を追加

## [3.4.2] - 2026-09-06

### Removed

- バージョン管理 API (`/api/update/*`、`/api/shutdown`、`/health`) 以外の Rust サーバー API 呼び出しを `web/app.js` から削除
  - `/api/projects` 系、 `/api/tile` 系、 `/api/info` 系
  - `/api/search` 代替として地理院住所検索をブラウザから直接呼び出し
  - 描画ルートの `/api/files`・`/api/file` 系取得・保存

## [3.4.1] - 2026-09-06

### Fixed

- CesiumJS タイル/3D Tiles/情報パネルが `/api/tile` や `/api/info` 等の存在しない API 経由で取得されて地図が表示されない問題を修正
- プロジェクト一覧も静的 `projects/projects.json` から直接読み込むように変更

## [3.4.0] - 2026-09-06

### Added

- Rust サーバーに自動更新機能を復元
  - `GET /api/update/settings` / `PUT /api/update/settings` による自動更新設定
  - `GET /api/update/latest` による最新版情報取得
  - `POST /api/update/install` による ZIP ダウンロード・EXE 差し替え・自動再起動
  - `POST /api/shutdown` によるサーバー停止
- `GET /health` に `name`・`port` を含め、フロントエンドの `backendEnabled` 判定に対応

## [3.3.0] - 2026-09-06

### Fixed

- APIキー未設定時のチャット応答に、設定手順・取得URL・使えるコマンドを含めるよう改善
- チャットパネルの初回チュートリアルメッセージを省略（API未設定時の不要な表示を減らす）

## [3.2.0] - 2026-09-06

### Added

- AIチャットパネルを右下に新設。Gemini API（function calling）で地図操作が可能（flyTo・レイヤ/ベースマップ切替・検索・プリセット・地形/効果・地下・断面・Flyパス・プロジェクト切替等）
- AI操作API `window.kasugaiApi` を公開。地図移動はドローン視点（対象地上+200m・-30°）を既定適用
- ブラウザ内コード実行サンドボックス（`runCode` ツール、opaque origin iframe + postMessage ブリッジ）
- 設定タブに「Google」を追加（Gemini APIキー・モデル選択、localStorage保存）
- チャット履歴をプロジェクト単位で localStorage に永続化（クリアボタン付き）
- APIキー未設定時のローカルコマンド（/fly /layers /layer /basemaps /basemap /search /camera）
- Inspector にローカルファイル追加機能（File System Access API で DATA/ へ直接保存→設定追記→登録、保存先フォルダ選択可）
- `addGeoJsonLayer` によるAIからのレイヤ追加
- ドキュメントを home.html に集約（インスペクター完全仕様・AI/セキュリティ・使い方）、README は最小化

## [3.1.0] - 2026-09-06

### Added

- 地形(DEM)ソース選択を追加: Re:Earth Terrain(楕円体高 / 標高)と国土地理院 DEM(5m+10m メッシュ、1m メッシュ)を選択可能に
- 地理院 5m+10m メッシュ: ズームレベルに応じて z14 以下は DEM10B(10m)、z15 以上は DEM5系(5m)を自動選択

### Changed

- 地理院標高タイル用の独自 TerrainProvider を実装(Geographic タイルをメルカトル XYZ 標高 PNG から生成)
- 高さ基準の表記を「TP基準(東京湾平均海面)」に変更し、WGS84 楕円体高との差(約30〜40m)をヘルプに明記
- GSI ベースマップ・空中写真に `maxZoom` を設定し、未提供ズームへの不要なリクエストを抑制

### Fixed

- Re:Earth terrain の `msl` エンドポイント 404 を `elevation` へ修正
- カスタム TerrainProvider の `getTileDataAvailable` 未実装による Cesium クラッシュを修正
- GSI DEM の負のタイル番号(y=-1)リクエストを修正
- GSI DEM の多段フォールバックを廃止し、要求ズームのみの並列取得+キャッシュで大幅に高速化

## [3.0.0] - 2026-09-06

### Added

- ヘルプサイトにデモサイト（`/web/`）へのリンクを追加

### Changed

- Rust サーバーを静的ファイル配信のみの最小構成に再構築し、これまでのファイル保存 API 等を廃止
- ヘルプドキュメントを `docs/` からリポジトリルートへ移動し、GitHub Pages 用 `.nojekyll` を追加
- README・インストーラー・サンプルプロジェクトを新しい静的構成に合わせて更新

## [2.0.5] - 2026-09-03

### Added

- GeoJSON 高速ドレープ (実験的): CesiumJS 1.145 の `GeoJsonPrimitive` を使い、GeoJSON を高品質・高速に地形や 3D Tiles にドレープする設定を追加
- 高速ドレープ有効時の地物クリックによる属性表示に対応

### Changed

- CesiumJS を 1.144 から 1.145 に更新(dompurify 脆弱性 CVE-2026-49458 の修正を含む)
- フロントエンドを純粋な CesiumJS 化し、`web/` を任意の HTTP サーバーに置くだけで動作するよう変更
- 設定をプロジェクト単位 (`projects/<project_id>/kasugai_canvas.kasc`) に移行し、ルートの `kasugai_canvas.kasc` を廃止
- Rust サーバーを `web/` および `projects/` を配信する最小静的サーバーに変更
- 設定ファイル内の相対パスを `projects/<project_id>/` から解決するよう変更
- インスペクターを Layer タブから独立した Inspector タブに移動
- Help リンクを設定パネル内の Help タブに集約
- OpenStreetMap の `tileSize=512` を削除

### Fixed

- 属性一覧で座標を持たない行をクリックした際に緯度経度 (0, 0) へ飛んでしまう不具合を修正

## [2.0.4] - 2026-08-31

### Added

- インスペクター設定を `.kasc` ファイルとしてエクスポート
- `.kasc` ファイルを Windows の関連ファイルとして開けるようレジストリ登録

### Changed

- プロジェクト・ルート設定ファイルを `kasugai_canvas.config` から `kasugai_canvas.kasc` に統一
- 古い `.config` ファイルは `.kasc` 優先で読み込むようフォールバック対応

## [2.0.3] - 2026-08-30

### Added

- レイヤーパネル設定タブの「レイヤ」と「その他」に HELP リンクを追加

## [2.0.2] - 2026-08-30

### Fixed

- 更新用 PowerShell スクリプトで EXE 差し替え失敗時に無限ループしないように `try/catch` を追加
- 更新 ZIP のダウンロード URL にバージョンクエリを付与し、GitHub raw コンテンツのキャッシュによる不整合を回避
- `latest.json` 取得時にタイムスタンプクエリを付与
- 更新 ZIP URL のホワイトリストをホスト・パスで判定し、クエリパラメータを許可

## [2.0.1] - 2026-08-30

### Fixed

- 自動更新時に `autoUpdate` 有効でも確認ダイアログが表示されていた問題を修正
- 多重起動時に既存インスタンスを停止してポートを確保する処理を実装
- `run.py` のリリースビルドで EXE / ZIP のバージョンを検証するよう強化

## [2.0.0] - 2026-08-30

### Changed

- 技術選定ドキュメントを整理し、home.html との体裁を統一
- CHANGELOG を主要なバージョンのみに整理
- バージョン表記を 2.0.0 に更新

## [1.3.0] - 2026-08-30

### Added

- Fly パネルにプリセット選択、ピッチ入力、起終点逆転ボタンを追加
- Fly パネルのヘルプテキストをコンパクト化

### Changed

- 実装システムのドキュメントを更新

## [1.2.0] - 2026-08-29

### Added

- 描画ルートの番号付き保存
  - `drawn_route_1.geojson`、`drawn_route_2.geojson` ... として自動連番でキャッシュ
  - 既存ファイルは上書きせず、新規ファイルとして追加
  - プロジェクト内の描画ルート一覧を取得する `GET /api/files`
- ルート飛行時の旋回補正
  - 折れ点手前で次の線分方向へ滑らかに方位を補間
  - 最後の 100m（または線分の 30% 以内）で旋回を開始

### Changed

- `fly_geojson:` ルートは折れ点どおりのオリジナル頂点を使用
- 手動 / 自動ルートで速度・高さを共有

## [1.1.0] - 2026-08-24

### Added

- Fly モードの経路追従機能
- 描画ルート機能
- 速度・高さの一元制御
- ローカルファイルの PUT 保存 API (`PUT /api/file`)

## [1.0.0] - 2026-08-08

### Added

- CesiumJS への描画エンジン移行。3D 地球・DEM・3D Tiles・XYZ の統合表示
- Rust/Axum によるローカルサーバーとタイルプロキシ・キャッシュ機能
- Layers パネル、ナビゲーションパネル、URL パーマリンク、カメラプリセット
- 検索タブ、属性パネル、プロジェクト切替、Windows インストーラー

### Changed

- 描画エンジンを deck.gl から CesiumJS へ全面移行
- ドレープ対象を DEM / 3D Tiles から個別に選択可能に
