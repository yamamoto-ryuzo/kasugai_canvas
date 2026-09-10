# KASUGAI Canvas — 開発ルール

## バージョン採番方針

- **v5.0 は全機能が完成した後に採番する**。それまでのリリースは 4.x 系（4.0.0, 4.1.0, ...）で進める
- v5.0 への到達条件: AIチャット・エージェント連携・Google Maps Platform 連携・ローカルファイル保存など、計画中の機能がすべて完成した時点

## バージョン管理手順

- バージョン番号の正本: `server\Cargo.toml` の `package.version`
- リリース時は以下を同じ番号に更新: `download/latest.json`、`home.html` のバージョンバッジ、`README.md` のバージョン表記、`installer/kasugai_canvas.nsi`（`python run.py -B` が自動更新する場合あり）
- `CHANGELOG.md` に日付付きセクションを追加（Keep a Changelog 形式）
- 配布物は `python run.py -B` で `download/` に作成し、コミットしてプッシュ

## ドキュメント方針

- 使い方・設定仕様・AI/セキュリティ等のドキュメントは `home.html`（GitHub Pages）に集約する
- `README.md` は概要＋開発者向け情報のみ。ユーザー向け情報を二重管理しない

## サーバー方針

- フロントエンドは静的配信のみで動作させる（`web/` を任意のHTTPサーバーに置くだけ）
- Rust サーバーは静的配信のオプション。独自APIは原則追加しない
- AI連携はブラウザから外部API（Gemini等）を直接呼ぶ構成とする

## API 方針

- フロントエンドは静的ファイル（`web/`）のみで動作する前提で実装する
- Rust サーバーは原則として静的ファイル配信のみとし、独自 API は追加しない
- ただし、**バージョンアップ関連の API (`/api/update/*`) とアプリ終了用の `/api/shutdown`、起動確認用の `/health` はこの制限から除く**
- 地図タイル・検索等の外部 API へのアクセスは、ブラウザから直接呼ぶか、CORS 対応を前提とする
