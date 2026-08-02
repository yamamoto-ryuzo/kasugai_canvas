# KASUGAI Canvas

ローカルPC・ブラウザ完結で動作する 2D/3D データ可視化システム「KASUGAI Canvas」の技術選定ドキュメントです。

## バージョン管理

現在のバージョンは **0.4.0** です。バージョン番号の正本は`server\Cargo.toml`の`package.version`とし、変更履歴は[CHANGELOG.md](CHANGELOG.md)で管理します。

公開・リリース管理は次の場所で行います。

- **ソースコード・リリースタグ**: [GitHub リポジトリ](https://github.com/yamamoto-ryuzo/kasugai_canvas)
- **公開ドキュメント**: [GitHub Pages](https://yamamoto-ryuzo.github.io/kasugai_canvas/)
- **変更履歴**: [CHANGELOG.md](CHANGELOG.md)

新しいリリースでは、次の順序で更新してください。

1. `server\Cargo.toml` の `package.version` を更新する
2. `CHANGELOG.md` の `Unreleased` の内容を日付付きのバージョン欄へ移動する
3. 変更を GitHub の `main` ブランチへ反映する
4. 同じバージョンの Git タグ（例: `v0.5.0`）を作成して GitHub に公開する
5. `python run.py -B` で配布 ZIP と NSIS インストーラーを作成し、GitHub のリリースへ添付する
6. GitHub Pages の公開内容を確認する

バージョン番号を複数のファイルへ重複して記載せず、アプリのビルド時には `server\Cargo.toml` の値を使用してください。自動更新用の公開メタデータは `download\latest.json` で管理し、`server\Cargo.toml` と同じバージョン番号に更新してください。

## 自動更新

アプリ起動時に GitHub Pages の `latest.json` を確認し、新しいバージョンがある場合は更新を提案します。自動更新設定は設定パネルから変更できます。更新を開始する前には必ず確認ダイアログを表示します。

更新処理は GitHub Releases の `kasugai_canvas.zip` をダウンロードし、アプリ終了後に実行ファイルを置き換えて再起動します。したがって、更新を公開する際は GitHub Release に次の名前で ZIP を添付してください。

```text
kasugai_canvas.zip
```

## Windows インストーラー

`python run.py -B` は、NSIS の `makensis` が利用可能な場合に次のインストーラーも作成します。

```text
download\kasugai_canvas_setup.exe
```

既定のインストール先は次のとおりです。

```text
C:\kasugai\kasugai_canvas
```

インストール完了画面では、次のチェックボックスからデスクトップショートカットの作成を選択できます。スタートメニューのショートカットは常に作成されます。

```text
Create desktop shortcut
```

NSIS が未インストールの場合は ZIP の作成まで実行し、インストーラー作成をスキップします。

## ベース表示の起動

Rust/Axum サーバーが deck.gl の2D表示と Three.js の3Dプレビューを配信します。

```powershell
cargo run --manifest-path server\Cargo.toml
```

ブラウザで `http://127.0.0.1:8510` を開いてください。ポートは `KASUGAI_CANVAS_PORT` 環境変数で変更できます。

`run.py` からも起動・ビルドできます。

```powershell
python run.py             # 開発起動
python run.py -B          # リリースビルド + download\kasugai_canvas.zip
python run.py --release   # リリース版を起動
```

インスペクターで「登録」した設定は、実行ファイルと同じフォルダの`kasugai_canvas.config`へ保存され、次回起動時に自動で復元されます。

## ドキュメント

詳細は GitHub Pages をご覧ください。

- [KASUGAI Canvas 技術選定](https://yamamoto-ryuzo.github.io/kasugai_canvas/)
- [変更履歴](CHANGELOG.md)
