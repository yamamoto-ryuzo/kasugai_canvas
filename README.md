# KASUGAI Canvas

ローカルPC・ブラウザ完結で動作する 2D/3D データ可視化システム「KASUGAI Canvas」の技術選定ドキュメントです。

## バージョン

現在のバージョンは **0.1.0** です。バージョン番号の正本は`server\Cargo.toml`の`package.version`とし、変更履歴は[CHANGELOG.md](CHANGELOG.md)で管理します。

新しいリリースでは、`server\Cargo.toml`のバージョンを更新し、`CHANGELOG.md`の`Unreleased`の内容を日付付きのバージョン欄へ移動してください。

## ベース表示の起動

Rust/Axum サーバーが deck.gl の2D表示と Three.js の3Dプレビューを配信します。

```powershell
cargo run --manifest-path server\Cargo.toml
```

ブラウザで `http://127.0.0.1:3800` を開いてください。ポートは `KASUGAI_CANVAS_PORT` 環境変数で変更できます。

`run.py` からも起動・ビルドできます。

```powershell
python run.py             # 開発起動
python run.py -B          # リリースビルド + download\kasugai_canvas.zip
python run.py --release   # リリース版を起動
```

## ドキュメント

詳細は GitHub Pages をご覧ください。

- [KASUGAI Canvas 技術選定](https://yamamoto-ryuzo.github.io/kasugai_canvas/)
- [変更履歴](CHANGELOG.md)
