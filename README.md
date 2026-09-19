# KASUGAI Canvas

ローカルPC・ブラウザ完結で動作する 2D/3D データ可視化システム「KASUGAI Canvas」です。Re:Earth GeoSuite との互換性を意識した GIS 基本機能に加え、KASUGAI 独自の FLY 機能・AIチャット（Gemini連携）を備えています。

フロントエンドは **純粋な CesiumJS** に整理されており、`web/` ディレクトリを任意の HTTP サーバーに置くだけで動作します。最小限の Rust（Axum）サーバーは `web/` および `projects/` を静的に配信するためのオプションです。

## ドキュメント

使い方・設定方法・AIチャット・インスペクター仕様などのドキュメントは公開サイトに集約しています。

- [KASUGAI Canvas ドキュメント（使い方・設定の正本）](https://yamamoto-ryuzo.github.io/kasugai_canvas/)
- [変更履歴](CHANGELOG.md)

## リポジトリ構成

```text
kasugai_canvas/
├─ server/               # Rust(Axum) 静的配信サーバー（オプション）
├─ web/                  # フロントエンド資産（index.html / app.js / styles.css）
│  └─ projects/          # プロジェクト（projects.json / <id>/kasugai_canvas.kasc / DATA/）
├─ functions/            # Cloudflare Pages Functions（認証 API / KV・R2 ゲート）
├─ workers/              # Cloudflare Workers 版デプロイ設定（worker.js / wrangler.toml）
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

設定手順の詳細は [home.html の V4 セクション](home.html#v4-auth) を参照してください。

## バージョン管理

現在のバージョンは **4.4.0** です。バージョン番号の正本は `server\Cargo.toml` の `package.version` とし、変更履歴は [CHANGELOG.md](CHANGELOG.md) で管理します。

公開・リリース管理は次の場所で行います。

- **ソースコード・リリースタグ**: [GitHub リポジトリ](https://github.com/yamamoto-ryuzo/kasugai_canvas)
- **公開ドキュメント**: [GitHub Pages](https://yamamoto-ryuzo.github.io/kasugai_canvas/)
- **変更履歴**: [CHANGELOG.md](CHANGELOG.md)

新しいリリースでは、次の順序で更新してください。

1. `server\Cargo.toml` の `package.version` を更新する
2. `CHANGELOG.md` の `Unreleased` の内容を日付付きのバージョン欄へ移動する
3. 変更を GitHub の `main` ブランチへ反映する
4. 同じバージョンの Git タグ（例: `v2.0.6`）を作成して GitHub に公開する
5. `python run.py -B` で配布 ZIP と NSIS インストーラーを作成し、GitHub のリリースへ添付する
6. GitHub Pages の公開内容を確認する

バージョン番号を複数のファイルへ重複して記載せず、アプリのビルド時には `server\Cargo.toml` の値を使用してください。自動更新用の公開メタデータは `download\latest.json` で管理し、`server\Cargo.toml` と同じバージョン番号に更新してください。

## 拡張機能（Plugin）と認証

認証方式は `web/auth-methods.json` の `control` で 0〜4 の番号で 1 つだけ選択されます。選択された方式のみが `web/auth-selector.js` により起動時に実行され、認証成功後に `app.js` と `plugin-loader.js` が読み込まれます。ユーザー向けの詳細な設定手順は [home.html の V4 セクション](home.html#v4-auth) を参照してください。

### 起動後通常プラグイン
`web/plugin-loader.js` が `web/plugins.json` を読み込み、各プラグインを `import()` します。

```json
{
  "plugins": [
    { "id": "sample-hello", "url": "./PLUGIN/sample-hello/plugin.js" }
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
- `scope`：`"app"`（既定）はプロジェクト切替をまたいで存続、`"project"` はプロジェクト切替時にレイヤーごと削除されます
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
