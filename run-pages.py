#!/usr/bin/env python3
"""KASUGAI Canvas — Cloudflare Pages へのデプロイ自動化。

実行内容:
  1. wrangler のログイン確認
  2. Pages プロジェクトの解決（--project-name 指定 > 既存プロジェクト > 新規作成）
  3. web/auth-methods.json の control を 3 に設定
  4. wrangler pages deploy（web/ + functions/ をまとめてデプロイ）
  5. 簡易動作確認（トップページ 200 / 静的ファイル公開 / 認証 API）

注意: Pages の環境変数・KV/R2 バインドはプロジェクトの設定として
ダッシュボードで管理され、デプロイをまたいで引き継がれます。
未設定の場合はデプロイ後に案内が表示されます。

使い方:
  python run-pages.py [--project-name <プロジェクト名>]
"""

import argparse
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
AUTH_METHODS = ROOT / "web" / "auth-methods.json"

DEFAULT_PROJECT = "kasugai-canvas"
SECRET_PASS = "KASUGAI_AUTH_PASS"


def _wrangler(*args):
    """リポジトリルートで npx wrangler を実行する（functions/ 自動検出のため）。"""
    cmd = "npx wrangler " + " ".join(args)
    return subprocess.run(
        cmd, cwd=ROOT, shell=True,
        capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )


def check_login() -> None:
    if not shutil.which("npx"):
        raise SystemExit("npx が見つかりません。Node.js をインストールしてください。")
    r = _wrangler("whoami")
    if r.returncode != 0 or "Account ID" not in (r.stdout + r.stderr):
        raise SystemExit(
            "wrangler にログインしていません。先に以下を実行してください:\n"
            "  npx wrangler login"
        )
    print("[1/5] wrangler ログイン確認 OK", flush=True)


def _list_projects() -> list[str]:
    r = _wrangler("pages", "project", "list")
    if r.returncode != 0:
        raise SystemExit(f"Pages プロジェクトの一覧取得に失敗しました:\n{r.stderr or r.stdout}")
    # 表形式の出力からプロジェクト名列を拾う
    names = []
    for line in r.stdout.splitlines():
        m = re.match(r"\s*│\s*(\S+)\s*│", line)
        if m and m.group(1) not in ("Project",) and "─" not in line:
            names.append(m.group(1))
    return names


def resolve_project(requested: str | None) -> str:
    if requested:
        print(f"[2/5] プロジェクト: {requested}（--project-name 指定）", flush=True)
        return requested
    existing = _list_projects()
    if len(existing) == 1:
        print(f"[2/5] 既存プロジェクトを使用: {existing[0]}", flush=True)
        return existing[0]
    if len(existing) > 1:
        raise SystemExit(
            "複数の Pages プロジェクトがあります。--project-name で指定してください:\n  "
            + ", ".join(existing)
        )
    print(f"[2/5] プロジェクト {DEFAULT_PROJECT} を作成します...", flush=True)
    r = _wrangler("pages", "project", "create", DEFAULT_PROJECT, "--production-branch", "main")
    if r.returncode != 0:
        raise SystemExit(f"プロジェクトの作成に失敗しました:\n{r.stderr or r.stdout}")
    return DEFAULT_PROJECT


def set_control() -> None:
    text = AUTH_METHODS.read_text(encoding="utf-8")
    new = re.sub(r'("control"\s*:\s*)\d+', r"\g<1>3", text, count=1)
    if new != text:
        AUTH_METHODS.write_text(new, encoding="utf-8")
    print("[3/5] web/auth-methods.json の control = 3", flush=True)


def deploy(project: str) -> str:
    print(f"[4/5] wrangler pages deploy を実行します（project: {project}）...", flush=True)
    r = _wrangler("pages", "deploy", "web", "--project-name", project)
    sys.stdout.write(r.stdout or "")
    sys.stderr.write(r.stderr or "")
    if r.returncode != 0:
        raise SystemExit("デプロイに失敗しました。")
    m = re.search(r"https://[\w.-]+\.pages\.dev", r.stdout + r.stderr)
    return m.group(0) if m else ""


def verify(base: str) -> None:
    if not base:
        print("[5/5] デプロイは完了しましたが URL を取得できませんでした。", flush=True)
        return
    print(f"[5/5] 動作確認: {base}", flush=True)

    # workers.dev と同じく pages.dev も簡易ボット判定があるためブラウザ UA を付ける
    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KASUGAI-Canvas-deploy-check"}

    try:
        with urllib.request.urlopen(urllib.request.Request(base + "/", headers=ua), timeout=10) as res:
            print(f"トップページ: {res.status}", flush=True)
        with urllib.request.urlopen(urllib.request.Request(base + "/app.js", headers=ua), timeout=10) as res:
            print(f"/app.js: {res.status}（Pages では静的ファイルは公開 — 仕様どおり）", flush=True)
    except urllib.error.HTTPError as e:
        print(f"警告: {e.code} が返りました。", flush=True)
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
        print("警告: /api/auth が誤った認証情報で成功しました。", flush=True)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if "Not configured" in body:
            print(
                "警告: 環境変数が未設定です（/api/auth が Not configured）。\n"
                "Pages プロジェクト → Settings → Environment variables で\n"
                "  KASUGAI_AUTH_USER / KASUGAI_AUTH_PASS\n"
                "を Production 環境に設定し、Deployments → Retry deployment で再適用してください。\n"
                "KV/R2 のバインドも同じく Settings → Bindings → Functions で設定します。",
                flush=True,
            )
        elif e.code == 401:
            print("認証 API 確認 OK（誤パスワード → 401 Unauthorized）", flush=True)
        else:
            print(f"警告: /api/auth がステータス {e.code} を返しました: {body}", flush=True)
    except urllib.error.URLError as e:
        print(f"警告: /api/auth にアクセスできません: {e}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="KASUGAI Canvas — Cloudflare Pages デプロイ")
    parser.add_argument("--project-name", help="デプロイ先の Pages プロジェクト名")
    args = parser.parse_args()

    check_login()
    project = resolve_project(args.project_name)
    set_control()
    base = deploy(project)
    verify(base)
    print("完了しました。", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
