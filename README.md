# KASUGAI Canvas

ローカルPC・ブラウザ完結で動作する 2D/3D データ可視化システム「KASUGAI Canvas」です。Re:Earth GeoSuite と上位互換の GIS 基本機能に加え、KASUGAI 独自の FLY 機能・AIチャット（Gemini連携）を備えています。

フロントエンドは **純粋な CesiumJS** に整理されており、`web/` ディレクトリを任意の HTTP サーバーに置くだけで動作します。最小限の Rust（Axum）サーバーは `web/` および `projects/` を静的に配信するためのオプションです。

## ドキュメント

使い方・設定方法・AIチャット・インスペクター仕様などのドキュメントは `docs/` に集約しています。GitHub Pages は `main` ブランチのルートを公開元にしてください。ルートの `index.html` から `/docs/` へ転送し、アプリの `/web/` も同じサイトで配信します。

- [KASUGAI Canvas ドキュメント（使い方・設定の正本）](https://yamamoto-ryuzo.github.io/kasugai_canvas/)
- [変更履歴](CHANGELOG.md)

## リポジトリ構成

```text
kasugai_canvas/
├─ docs/                 # GitHub Pages ドキュメントサイト（公開元: /docs）
│  ├─ features/          # V0〜V5 の機能ページ
│  ├─ auth/              # 認証方式ごとの手順
│  └─ images/            # ドキュメント画像
├─ server/               # Rust(Axum) 静的配信サーバー（オプション）
├─ web/                  # フロントエンド資産（index.html / app.js / styles.css）
│  └─ projects/          # プロジェクト（projects.json / <id>/kasugai_canvas.kasc / DATA/）
├─ functions/            # Cloudflare Pages Functions（認証 API / KV・R2 ゲート）
├─ workers/              # Cloudflare Workers 版デプロイ設定（worker.js / wrangler.toml）
├─ agent/                # Cloud Run エージェントサービス（FastAPI・認証 5/6/7・GCS ストレージ）
├─ installer/            # NSIS インストーラー定義
├─ download/             # 配布 ZIP・インストーラー・latest.json
├─ run.py                # 起動・ビルドスクリプト
├─ run-pages.py          # Cloudflare Pages へのデプロイ自動化
└─ run-workers.py        # Cloudflare Workers へのデプロイ自動化
```

## リリースビルド

```powershell
python run.py -B
```

`download/` に `kasugai_canvas.zip` と（NSIS があれば）`kasugai_canvas_setup.exe` を作成します。

## Cloudflare へのデプロイ

Cloudflare Pages / Workers へのデプロイは以下のスクリプトで自動化できます（要 `npx wrangler login`）。

```powershell
python run-pages.py      # Pages（control: 3）へデプロイ
python run-workers.py    # Workers（control: 4・全ファイル認証ゲート）へデプロイ
```

Cloud Run へのデプロイ（control: 5/6/7）は `agent/Dockerfile` と `agent/README.md` を参照してください。

設定手順の詳細は [認証とプラグイン](docs/auth/index.html) を参照してください。

## ローカルサーバー API（オプション）

Rust サーバーは静的配信に加えて、ローカル開発向けの高権限 API を提供します（公開環境の Pages/Workers では提供しません）。フロントエンドは `/api/capabilities` で能力を検出し、ツール・UI を出し分けます。

| エンドポイント | 内容 |
|---|---|
| `GET /health` | 起動確認 |
| `GET /api/capabilities` | ティア（`local`）と利用可能機能（features）を返す |
| `GET /api/fetch?url=` | CORS 回避の GET プロキシ（http/https のみ・30秒・20MB 上限） |
| `POST /api/plugins` | ストレージプラグインを `PLUGIN/<id>/` + `plugins.json` に書き込み公開 |
| `DELETE /api/plugins/{id}` | 公開プラグインを削除 |
| `GET/PUT /api/update/settings`・`GET /api/update/latest`・`POST /api/update/install` | 自動更新 |
| `POST /api/shutdown` | アプリ終了 |

ポートは環境変数 `KASUGAI_CANVAS_PORT`（既定 `8510`）で変更可能。`PORT` が設定されたコンテナ環境では `0.0.0.0` にバインドします。

## バージョン管理

現在のバージョンは **6.5.1** です。バージョン番号の正本は `server\Cargo.toml` の `package.version` とし、変更履歴は [CHANGELOG.md](CHANGELOG.md) で管理します。

公開・リリース管理は次の場所で行います。

- **ソースコード・リリースタグ**: [GitHub リポジトリ](https://github.com/yamamoto-ryuzo/kasugai_canvas)
- **公開ドキュメント**: [GitHub Pages](https://yamamoto-ryuzo.github.io/kasugai_canvas/)（`main` ブランチのルートが公開元）
- **変更履歴**: [CHANGELOG.md](CHANGELOG.md)

### ブランチと自動更新チャンネル

- **`main` のみで運用**（develop ブランチは廃止済み）。GitHub Pages の公開元であり、自動更新は `main/download/latest.json`・`main/download/kasugai_canvas.zip` を参照する

自動更新は単一チャンネルです。`X.Y.Z-dev` のような開発版バージョンの exe も同じ `latest.json` を参照するため、最新リリースより古い dev ビルドは起動時の自動更新でリリース版へ差し替えられます。開発中は `Cargo.toml` を `latest.json` 以上に保つか、設定の自動更新をオフにしてください。

### リリース手順

1. `main` で開発する。開発中は `server\Cargo.toml` の `package.version` を `X.Y.Z-dev[.N]` にしておくとリリース版と区別できる（採番は `-dev` → `-dev.1` → `-dev.2` のドット区切りで）
2. リリース時は `package.version` から `-dev` 接尾辞を除去し、`CHANGELOG.md` の `Unreleased` を日付付きのバージョン欄へ移動する
3. `python run.py -B` で配布 ZIP・インストーラー・`latest.json` を作成し、コミットする（`-dev` 付きバージョンでは配布ビルドは拒否される）
4. `main` をプッシュする（`latest.json` と ZIP は必ず同じコミットで更新する — 先に `latest.json` だけ上げると自動更新が無限ループする）
5. GitHub Pages の公開内容を確認する

バージョン番号を複数のファイルへ重複して記載せず、アプリのビルド時には `server\Cargo.toml` の値を使用してください。自動更新用のメタデータは `download\latest.json` で管理し、`server\Cargo.toml` と同じバージョン番号に更新してください。

## 拡張機能（Plugin）と認証

認証方式は `web/auth-methods.json` の `control` で 0〜7 の番号で 1 つだけ選択されます。選択された方式のみが `web/auth-selector.js` により起動時に実行され、認証成功後に `app.js` と `plugin-loader.js` が読み込まれます。ユーザー向けの詳細な設定手順は [認証とプラグイン](docs/auth/index.html) を参照してください。

### 起動後通常プラグイン
`web/plugins.json` は利用可能な同梱プラグインの**カタログ**です。既定では自動ロードせず、プロジェクトの `.kasc`（インスペクタ）に `plugin:` 行で宣言したものだけを `web/plugin-loader.js` が `import()` します。`"auto": true` を付けたエントリのみ全プロジェクトで常駐ロードします。

```kasc
plugin: reinfolib | datasets=price,shelter
```

`key=value` は `plugins.json` 各エントリの `options`（既定値）にマージして `manifest.options` として渡され、真偽値・数値・カンマ区切り（配列）を解釈します。`plugin:` 行で起動したプラグインはプロジェクトスコープとして扱われ、作ったレイヤーはプロジェクト切替・行削除で除去され、`registerPlugin` の `dispose()` が呼ばれて停止します。`plugin: <id> | off` は宣言の明示解除（auto エントリ・有効なストレージプラグインの抑制にも使えます）。

```json
{
  "plugins": [
    { "id": "sample-hello", "url": "./PLUGIN/sample-hello/plugin.js" },
    { "id": "always-on", "url": "./PLUGIN/always-on/plugin.js", "auto": true }
  ]
}
```

```js
// PLUGIN/my-plugin/plugin.js
export async function init(api, manifest) {
  const viewer = api.getViewer();
  const Cesium = api.getCesium();
  // Cesium への機能追加
}
```

#### プラグイン宣言レイヤー（manifest.layer）

`plugins.json` に `layer` を宣言すると、本体がプラグイン専用レイヤーを自動登録します。レイヤ一覧・表示切替・属性検索（ベクター検索）・属性パネルの対象になり、内蔵レイヤーと同じ扱いになります。

```json
{
  "id": "my-plugin",
  "url": "./PLUGIN/my-plugin/plugin.js",
  "layer": {
    "title": "マイプラグイン",
    "group": "プラグイン",
    "format": "entities",
    "visible": true,
    "scope": "app"
  }
}
```

- `format: "entities"`：本体が `Cesium.CustomDataSource` を生成して貸し出します。`api.getPluginDataSource(manifest.id)` で取得し `ds.entities.add(...)` するだけで、動的な entity が管理対象になります
- `format: "geojson"`：`api.setPluginLayerData(manifest.id, geojson)` で GeoJSON オブジェクトを渡すと、`geojson:` レイヤーと同じ描画経路（クランプ・ドレープ設定を含む）で表示されます。更新は再度呼び出すだけです
- `style`：省略可。`"QMLファイルのURL"` を指定すると geojson 形式レイヤーに QGIS スタイル（単一・分類・ルールベース・ラベル）を適用します（`api.registerPluginLayer` の `style` オプションと同じ）
- `scope`：`"app"`（既定）はプロジェクト切替をまたいで存続、`"project"` はプロジェクト切替時にレイヤーごと削除されます。`plugin:` 行で起動したプラグインのレイヤーは宣言値に関わらず `"project"` として扱われます
- `manifest.layer` を省略した場合は従来通りで、`viewer.entities.add` 等による直接描画も可能です（非管理・揮発データ）

プラグインから任意のタイミングで追加する場合は `api.registerPluginLayer(config, pluginId)`、削除は `api.removePluginLayer(idOrPluginId)` も使えます。

### 認証用ログインUIの共通化

ID/パスワードを入力する認証プラグインでは、`web/auth-login-form.js` の `showLoginForm` を使って UI を共通化します。各プラグインは独自の認証処理だけを `onSubmit` コールバックに記述します。

```js
// web/PLUGIN/auth-example/auth.js
import { showLoginForm } from "../../auth-login-form.js";

export async function authenticate() {
  return showLoginForm({
    onSubmit: async ({ user, pass }) => {
      // ここに独自の認証処理を実装する
      // 成功時は認証結果オブジェクトを返す
      // 失敗時は Error を throw すると UI 側にエラー表示される
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, pass })
      });
      if (!res.ok) {
        throw new Error("認証に失敗しました");
      }
      return { token: "example", user: { name: user, role: "example" } };
    }
  });
}
```

## 免責事項

本システムは個人のPCで作成・テストされたものです。  
ご利用によるいかなる損害も責任を負いません。

<p align="center">
  <a href="https://giphy.com/explore/free-gif" target="_blank">
    <img src="https://github.com/yamamoto-ryuzo/QGIS_portable_3x/raw/master/imgs/giphy.gif" width="500" title="avvio QGIS">
  </a>
</p>
