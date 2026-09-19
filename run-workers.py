#!/usr/bin/env python3
"""KASUGAI Canvas — Cloudflare Workers へのデプロイ自動化。

実行内容:
  1. wrangler のログイン確認
  2. KV 名前空間 (KASUGAI_KV) の確認・作成と wrangler.toml へのバインド記入
  3. R2 バケット (kasugai-data) の確認・作成とバインド記入（R2 未有効化時はスキップ）
  4. KASUGAI_AUTH_PASS シークレットの確認（未登録なら対話プロンプトで登録）
  5. web/auth-methods.json の control を 4 に設定してデプロイ（終了後は 0 に戻す）
  6. wrangler deploy と簡易動作確認（認証ゲート 401 / トップページ 200）

使い方:
  python run-workers.py
"""

import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


# wrangler の出力に絵文字が含まれるため、コンソールが cp932 でも落ちないようにする
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ROOT = Path(__file__).resolve().parent
WORKERS_DIR = ROOT / "workers"
WRANGLER_TOML = WORKERS_DIR / "wrangler.toml"
AUTH_METHODS = ROOT / "web" / "auth-methods.json"

KV_NAMESPACE = "KASUGAI_KV"
R2_BINDING = "KASUGAI_DATA"
R2_BUCKET = "kasugai-data"
SECRET_PASS = "KASUGAI_AUTH_PASS"


def _wrangler(*args, capture=True):
    """workers/ で npx wrangler を実行する。"""
    cmd = "npx wrangler " + " ".join(args)
    return subprocess.run(
        cmd, cwd=WORKERS_DIR, shell=True,
        capture_output=capture, text=True,
        encoding="utf-8", errors="replace",
    )


def _wrangler_live(*args):
    """対話が必要な wrangler コマンドを標準入出力を引き継いで実行する。"""
    cmd = "npx wrangler " + " ".join(args)
    return subprocess.run(cmd, cwd=WORKERS_DIR, shell=True)


def check_login() -> None:
    if not shutil.which("npx"):
        raise SystemExit("npx が見つかりません。Node.js をインストールしてください。")
    r = _wrangler("whoami")
    if r.returncode != 0 or "Account ID" not in (r.stdout + r.stderr):
        raise SystemExit(
            "wrangler にログインしていません。先に以下を実行してください:\n"
            "  cd workers && npx wrangler login"
        )
    print("[1/6] wrangler ログイン確認 OK", flush=True)


def _kv_namespace_id() -> str | None:
    r = _wrangler("kv", "namespace", "list")
    if r.returncode != 0:
        raise SystemExit(f"KV 名前空間の一覧取得に失敗しました:\n{r.stderr or r.stdout}")
    for ns in json.loads(r.stdout):
        if ns.get("title") == KV_NAMESPACE:
            return ns.get("id")
    return None


def _kv_bound() -> bool:
    text = WRANGLER_TOML.read_text(encoding="utf-8")
    pattern = r'^\[\[kv_namespaces\]\]\s*\n(?:[^#\n][^\n]*\n)*?binding\s*=\s*"' + KV_NAMESPACE + '"'
    return re.search(pattern, text, re.M) is not None


def ensure_kv_binding() -> None:
    if _kv_bound():
        print(f"[2/6] KV バインド済み: {KV_NAMESPACE}", flush=True)
        return

    ns_id = _kv_namespace_id()
    if not ns_id:
        print(f"KV 名前空間 {KV_NAMESPACE} を作成します...", flush=True)
        r = _wrangler("kv", "namespace", "create", KV_NAMESPACE)
        if r.returncode != 0:
            raise SystemExit(f"KV 名前空間の作成に失敗しました:\n{r.stderr or r.stdout}")
        ns_id = _kv_namespace_id()
        if not ns_id:
            raise SystemExit("KV 名前空間を作成しましたが ID を取得できませんでした。")

    text = WRANGLER_TOML.read_text(encoding="utf-8")
    block = f'[[kv_namespaces]]\nbinding = "{KV_NAMESPACE}"\nid = "{ns_id}"'
    commented = re.search(
        r'^#\s*\[\[kv_namespaces\]\]\s*\n(?:#\s*[^\n]*\n)*', text, re.M
    )
    if commented:
        text = text[: commented.start()] + block + "\n" + text[commented.end() :]
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    WRANGLER_TOML.write_text(text, encoding="utf-8")
    print(f"[2/6] KV バインドを wrangler.toml に記入: {KV_NAMESPACE} (id: {ns_id})", flush=True)


def _r2_bound() -> bool:
    text = WRANGLER_TOML.read_text(encoding="utf-8")
    pattern = r'^\[\[r2_buckets\]\]\s*\n(?:[^#\n][^\n]*\n)*?binding\s*=\s*"' + R2_BINDING + '"'
    return re.search(pattern, text, re.M) is not None


def ensure_r2_binding() -> None:
    if _r2_bound():
        print(f"[3/6] R2 バインド済み: {R2_BINDING}", flush=True)
        return

    r = _wrangler("r2", "bucket", "list")
    if r.returncode != 0:
        if "enable R2" in (r.stdout + r.stderr):
            print(
                f"[3/6] R2 がアカウントで有効化されていません。r2:// を使う場合は"
                "ダッシュボードで有効化してから再実行してください。スキップします。",
                flush=True,
            )
            return
        raise SystemExit(f"R2 バケットの一覧取得に失敗しました:\n{r.stderr or r.stdout}")

    if R2_BUCKET not in r.stdout:
        print(f"R2 バケット {R2_BUCKET} を作成します...", flush=True)
        r = _wrangler("r2", "bucket", "create", R2_BUCKET)
        if r.returncode != 0:
            print(f"[3/6] R2 バケット作成に失敗しました。スキップします:\n{r.stderr or r.stdout}", flush=True)
            return

    text = WRANGLER_TOML.read_text(encoding="utf-8")
    block = f'[[r2_buckets]]\nbinding = "{R2_BINDING}"\nbucket_name = "{R2_BUCKET}"'
    commented = re.search(
        r'^#\s*\[\[r2_buckets\]\]\s*\n(?:#\s*[^\n]*\n)*', text, re.M
    )
    if commented:
        text = text[: commented.start()] + block + "\n" + text[commented.end() :]
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    WRANGLER_TOML.write_text(text, encoding="utf-8")
    print(f"[3/6] R2 バインドを wrangler.toml に記入: {R2_BINDING} ({R2_BUCKET})", flush=True)


def ensure_secret() -> None:
    r = _wrangler("secret", "list")
    if r.returncode != 0:
        raise SystemExit(f"シークレット一覧の取得に失敗しました:\n{r.stderr or r.stdout}")
    names = {entry.get("name") for entry in json.loads(r.stdout)}
    if SECRET_PASS in names:
        print(f"[4/6] シークレット登録済み: {SECRET_PASS}", flush=True)
        return
    print(
        f"[4/6] {SECRET_PASS} が未登録です。対話プロンプトが出るのでパスワードを入力してください。",
        flush=True,
    )
    r = _wrangler_live("secret", "put", SECRET_PASS)
    if r.returncode != 0:
        raise SystemExit("シークレットの登録に失敗しました。")


def set_control(value: int) -> None:
    text = AUTH_METHODS.read_text(encoding="utf-8")
    new = re.sub(r'("control"\s*:\s*)\d+', rf"\g<1>{value}", text, count=1)
    if new != text:
        AUTH_METHODS.write_text(new, encoding="utf-8")


def deploy_and_verify() -> None:
    print("[6/6] wrangler deploy を実行します...", flush=True)
    r = _wrangler("deploy")
    sys.stdout.write(r.stdout or "")
    sys.stderr.write(r.stderr or "")
    if r.returncode != 0:
        raise SystemExit("デプロイに失敗しました。")

    url_match = re.search(r"https://[\w.-]+\.workers\.dev", r.stdout + r.stderr)
    if not url_match:
        print("デプロイは完了しましたが URL を取得できませんでした。", flush=True)
        return
    base = url_match.group(0)
    print(f"デプロイ先: {base}", flush=True)

    # workers.dev は簡易ボット判定があり Python 既定 UA は 403 になるためブラウザ UA を付ける
    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KASUGAI-Canvas-deploy-check"}

    try:
        urllib.request.urlopen(urllib.request.Request(base + "/app.js", headers=ua), timeout=10)
        print("警告: /app.js が未認証で取得できてしまいます。認証ゲートを確認してください。", flush=True)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("認証ゲート確認 OK（未ログインの /app.js → 401）", flush=True)
        else:
            print(f"警告: /app.js が想定外のステータス {e.code} を返しました。", flush=True)
    except urllib.error.URLError as e:
        print(f"警告: デプロイ先にアクセスできません: {e}", flush=True)
        return

    req = urllib.request.Request(
        base + "/api/auth",
        method="POST",
        data=b'{"user":"x","pass":"x"}',
        headers={**ua, "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if "Not configured" in body:
            print(
                f"警告: {SECRET_PASS} が未設定のようです（/api/auth が Not configured）。"
                "以下を実行してください:\n"
                f"  cd workers && npx wrangler secret put {SECRET_PASS}",
                flush=True,
            )
        elif e.code == 401:
            print("認証 API 確認 OK（誤パスワード → 401 Unauthorized）", flush=True)
        else:
            print(f"警告: /api/auth がステータス {e.code} を返しました: {body}", flush=True)
    except urllib.error.URLError as e:
        print(f"警告: /api/auth にアクセスできません: {e}", flush=True)


def main() -> None:
    if not WRANGLER_TOML.exists():
        raise SystemExit(f"{WRANGLER_TOML} が見つかりません。")
    check_login()
    ensure_kv_binding()
    ensure_r2_binding()
    ensure_secret()
    print("[5/6] web/auth-methods.json の control = 4", flush=True)
    set_control(4)
    try:
        deploy_and_verify()
    finally:
        # デプロイ対象の web/ には 4 が残るが、リポジトリのファイルは認証なしに戻す
        set_control(0)
        print("web/auth-methods.json の control を 0 に戻しました", flush=True)
    print("完了しました。", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
