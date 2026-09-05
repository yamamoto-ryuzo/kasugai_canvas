# KASUGAI Canvas

ローカルPC・ブラウザ完結で動作する 2D/3D データ可視化システム「KASUGAI Canvas」です。Re:Earth GeoSuite との互換性を意識した GIS 基本機能に加え、KASUGAI 独自の FLY 機能を備えています。

フロントエンドは **純粋な CesiumJS** に整理されており、`web/` ディレクトリを任意の HTTP サーバーに置くだけで動作します。最小限の Rust（Axum）サーバーは `web/` および `projects/` を静的に配信するためのオプションです。

## ドキュメント

詳細は GitHub Pages をご覧ください。

- [KASUGAI Canvas 技術選定](https://yamamoto-ryuzo.github.io/kasugai_canvas/)
- [変更履歴](CHANGELOG.md)

## 主な機能

### GIS 基本機能（Re:Earth GeoSuite コンパチブル）

- インスペクター一括設定（`xyz:`, `3dtiles:`, `geojson:`, `base:`, `info:`, `cam:`, `legend:`）
- ベースマップ、システムレイヤー制御、レイヤー追加・管理、レイヤー一覧 UI
- レイヤーグループ化（`/` 通常、`//` 排他）
- 凡例表示、住所・ベクトル検索、属性・値一覧、カメラプリセット
- Info 表示、Share（URL 共有）、GeoJSON 3D ドレープ制御、Terrain/Shadow、ナビゲーション

### プレゼンテーション機能（追加機能）

- Fly モード（ルート自動追従・手動操縦）
- ルート描画、Google Earth 風アニメーション FlyTo

## 動作構成

- **フロントエンド**: `web/` 内の HTML/CSS/JS。CesiumJS や Three.js は CDN から読み込みます。
- **設定**: `projects/<project_id>/kasugai_canvas.kasc` にプロジェクト単位で保持します。デフォルトは `projects/default/` です。
- **プロジェクト一覧**: `projects/projects.json` で管理します。
- **ローカルデータ**: プロジェクト内の `DATA/` フォルダなどを、設定ファイル内の相対パスで指定できます。
- **Rust サーバー**: オプション。`web/` と `projects/` を静的に配信します。

## 起動方法

### 通常の HTTP サーバーでホスティングする

`web/` ディレクトリをドキュメントルートに置くだけです。

```powershell
cd web
python -m http.server 8520
```

ブラウザで `http://127.0.0.1:8520/` を開いてください。

### Rust サーバーで起動する

```powershell
cd server
cargo run --release
```

ブラウザで `http://127.0.0.1:8510/` を開いてください。ポートは `KASUGAI_CANVAS_PORT` 環境変数で変更できます。

`run.py` からも起動・ビルドできます。

```powershell
python run.py             # 開発起動
python run.py -B          # リリースビルド + download\kasugai_canvas.zip
python run.py --release   # リリース版を起動
```

## プロジェクト構成

```text
kasugai_canvas/
├─ kasugai_canvas.exe      # Rust サーバー（オプション）
├─ web/                    # フロントエンド資産
│  ├─ index.html
│  ├─ app.js
│  ├─ styles.css
│  └─ projects/
│     ├─ projects.json
│     └─ default/
│        ├─ project.json
│        ├─ kasugai_canvas.kasc
│        └─ DATA/
│           └─ sample.geojson
└─ projects/               # Rust サーバー使用時のプロジェクト配置
   ├─ projects.json
   └─ default/
      ├─ project.json
      ├─ kasugai_canvas.kasc
      └─ DATA/
         └─ sample.geojson
```

- `projects/projects.json`: プロジェクト一覧 (`{ "id": "...", "title": "..." }` の配列)。
- `projects/<project_id>/project.json`: プロジェクトの表示名など。
- `projects/<project_id>/kasugai_canvas.kasc`: インスペクター設定。
- `projects/<project_id>/DATA/`: ローカル GeoJSON、3D Tiles、画像タイル等を配置できます。

設定ファイル内で相対パス（例: `DATA/sample.geojson`）を指定すると、`projects/<project_id>/DATA/` 配下に自動的に解決されます。`http://` や `https://` で始まる URL はそのまま使用されます。

## 設定の保存

静的サーバーでは設定をサーバーに保存しません。インスペクターの **「エクスポート(.kasc)」** ボタンで `.kasc` ファイルをローカルにダウンロードし、対象プロジェクトの `kasugai_canvas.kasc` と差し替えてください。

## リリースビルド

```powershell
python run.py -B
```

以下が作成されます。

```text
download/
├─ kasugai_canvas.zip          # 配布用 ZIP
├─ kasugai_canvas_setup.exe    # Windows インストーラー
└─ kasugai_canvas_setup.zip    # インストーラー ZIP
```

`kasugai_canvas.zip` には `kasugai_canvas.exe`、`web/`、`projects/` が含まれます。

## Windows インストーラー

`python run.py -B` は、NSIS の `makensis` が利用可能な場合に `download\kasugai_canvas_setup.exe` を作成します。

既定のインストール先は次のとおりです。

```text
C:\kasugai\kasugai_canvas
```

インストール内容:

- `kasugai_canvas.exe`
- `web/`
- `projects/`

インストール完了画面では、デスクトップショートカットの作成を選択できます。スタートメニューのショートカットは常に作成されます。ショートカットおよびインストール完了時の起動では、ブラウザで KASUGAI Canvas を開きます。

NSIS が未インストールの場合は ZIP の作成まで実行し、インストーラー作成をスキップします。

## 自動更新

現在のバージョンでは、静的サーバー構成のため自動更新機能は無効になっています。新しいリリースがあっても手動で ZIP を差し替えてください。

## バージョン管理

現在のバージョンは **3.0.0** です。バージョン番号の正本は `server\Cargo.toml` の `package.version` とし、変更履歴は [CHANGELOG.md](CHANGELOG.md) で管理します。

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
