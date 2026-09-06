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
├─ installer/            # NSIS インストーラー定義
├─ download/             # 配布 ZIP・インストーラー・latest.json
└─ run.py                # 起動・ビルドスクリプト
```

## リリースビルド

```powershell
python run.py -B
```

`download/` に `kasugai_canvas.zip` と（NSIS があれば）`kasugai_canvas_setup.exe` を作成します。

## バージョン管理

現在のバージョンは **3.4.2** です。バージョン番号の正本は `server\Cargo.toml` の `package.version` とし、変更履歴は [CHANGELOG.md](CHANGELOG.md) で管理します。

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
