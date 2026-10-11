#!/usr/bin/env python3
"""KASUGAI Canvas — Cloud Run へのデプロイ自動化。

実行内容:
  1. gcloud CLI の存在・認証確認とプロジェクトの解決（--project > gcloud config）
  2. 必要な API の有効化（run / artifactregistry / cloudbuild / secretmanager / iamcredentials）
  3. Artifact Registry リポジトリ (kasugai) の確認・作成
  4. Cloud Build で agent/Dockerfile をビルド＆プッシュ（ローカルに Docker は不要）
  5. シークレット登録（--gemini-api-key / --auth-user・--auth-pass）と
     実行サービスアカウントへの権限付与
  6. GCS バケット（--bucket 指定時）の確認・作成と権限付与
  7. gcloud run deploy（--allow-unauthenticated --min-instances 1）
  8. 簡易動作確認（/health・/api/capabilities・トップページ）

Cloud Shell（ブラウザ）でもローカルの Google Cloud SDK でも実行できる。
ローカルの Docker は使わず、ビルドは Cloud Build に投げる。

使い方:
  python run-cloudrun.py [--project ID] [--region REGION] [--service NAME]
      [--gemini-api-key KEY] [--maps-api-key KEY]
      [--auth-mode {5,6} --auth-user U --auth-pass P]
      [--bucket BUCKET]

非秘密の設定（project/region/service/auth-mode/bucket）は
kasugai_canvas.cloudrun.json（gitignore 済み）に保存され、2回目以降は
引数なしの `python run-cloudrun.py` で再デプロイできる。
シークレットは Secret Manager の既存登録を再利用する。
`python run.py --cloudrun` からも呼べる。

最小構成（静的配信 + /api/gemini キー隠蔽プロキシのみ）:
  python run-cloudrun.py --gemini-api-key YOUR_KEY

ハッカソン提出構成（認証モード5 + GCS 保存 + キーレスAI）:
  python run-cloudrun.py --gemini-api-key YOUR_KEY \
      --auth-mode 5 --auth-user ID --auth-pass PASS --bucket kasugai-data
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


# gcloud の出力に絵文字が含まれることがあるため、コンソールが cp932 でも落ちないようにする
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ROOT = Path(__file__).resolve().parent
TMPDIR = ROOT / ".testtmp"  # gitignore 済み
# 環境ごとの非秘密デプロイ設定（gitignore 済み）。秘密値は絶対に書き込まない
DEPLOY_CONFIG = ROOT / "kasugai_canvas.cloudrun.json"

REGION_DEFAULT = "asia-northeast1"
SERVICE_DEFAULT = "kasugai-canvas"
AR_REPO = "kasugai"
SECRET_GEMINI = "gemini-api-key"
SECRET_MAPS = "google-maps-api-key"
SECRET_AUTH_USER = "kasugai-auth-user"
SECRET_AUTH_PASS = "kasugai-auth-pass"

APIS = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
    # /api/data の V4 署名付き URL（signBlob）に必要
    "iamcredentials.googleapis.com",
]


_GCLOUD_CANDIDATES = [
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd",
    Path("C:/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"),
    Path("C:/Program Files/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"),
]
_gcloud_path = None


def _gcloud_bin() -> str:
    """PATH 上になければ Windows の既定インストール位置も探す。"""
    global _gcloud_path
    if _gcloud_path is None:
        _gcloud_path = shutil.which("gcloud") or next(
            (str(p) for p in _GCLOUD_CANDIDATES if p.exists()), "gcloud"
        )
    return _gcloud_path


def _gcloud(*args, input_text=None, stream=False):
    """gcloud を実行する。stream=True で出力をそのまま表示（長いビルド用）。"""
    argv = [_gcloud_bin(), *args]
    # shell=True 経由のシェルが OS で異なる（Windows=cmd / POSIX=sh）ため、
    # --format=value(...) のような引数をそれぞれの文法で引用する
    cmd = subprocess.list2cmdline(argv) if os.name == "nt" else shlex.join(argv)
    if stream:
        return subprocess.run(
            cmd, cwd=ROOT, shell=True, input=input_text,
            text=True, encoding="utf-8", errors="replace",
        )
    return subprocess.run(
        cmd, cwd=ROOT, shell=True, input=input_text,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def load_config() -> dict:
    try:
        return json.loads(DEPLOY_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(config: dict) -> None:
    DEPLOY_CONFIG.write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"      設定を {DEPLOY_CONFIG.name} に保存（次回は引数なしで再デプロイ可）", flush=True)


def _secret_exists(name: str, project: str) -> bool:
    return _gcloud("secrets", "describe", name, f"--project={project}").returncode == 0


def check_auth(requested_project: str | None) -> str:
    r = _gcloud("--version")
    if r.returncode != 0:
        raise SystemExit(
            "gcloud CLI が見つかりません。Cloud Shell（console.cloud.google.com 右上の '>_'）\n"
            "で実行するか、Google Cloud SDK をインストールして `gcloud auth login` してください。"
        )
    r = _gcloud("auth", "print-access-token")
    if r.returncode != 0 or not r.stdout.strip():
        raise SystemExit(
            "gcloud にログインしていません。Cloud Shell では `gcloud auth login` を実行し、\n"
            "表示される URL をブラウザで開いて認証コードを貼り付けてください。"
        )
    account = _gcloud("config", "get-value", "account").stdout.strip().splitlines()
    print(f"[1/8] gcloud 認証確認 OK（{account[0] if account else '認証済み'}）", flush=True)

    project = requested_project
    if not project:
        r = _gcloud("config", "get-value", "project")
        out = (r.stdout or "").strip()
        if r.returncode == 0 and out and "unset" not in out.lower():
            project = out.splitlines()[0]
    if not project:
        raise SystemExit(
            "GCP プロジェクトが未設定です。--project で指定するか、\n"
            "  gcloud config set project PROJECT_ID\n"
            "を実行してください。プロジェクト ID は Cloud Console 上部のプロジェクト選択で確認できます。"
        )
    print(f"      プロジェクト: {project}", flush=True)
    return project


def enable_apis(project: str) -> None:
    print("[2/8] 必要な API を有効化します...", flush=True)
    r = _gcloud("services", "enable", *APIS, f"--project={project}")
    if r.returncode != 0:
        raise SystemExit(
            "API の有効化に失敗しました。プロジェクトの課金が有効か確認してください:\n"
            f"{r.stderr or r.stdout}"
        )


def ensure_registry(project: str, region: str) -> None:
    r = _gcloud(
        "artifacts", "repositories", "describe", AR_REPO,
        f"--location={region}", f"--project={project}",
    )
    if r.returncode == 0:
        print(f"[3/8] Artifact Registry {AR_REPO}（{region}）: 既存を使用", flush=True)
        return
    print(f"[3/8] Artifact Registry {AR_REPO}（{region}）を作成します...", flush=True)
    r = _gcloud(
        "artifacts", "repositories", "create", AR_REPO,
        "--repository-format=docker", f"--location={region}", f"--project={project}",
    )
    if r.returncode != 0:
        raise SystemExit(f"リポジトリの作成に失敗しました:\n{r.stderr or r.stdout}")


def compute_sa(project: str) -> str:
    """Cloud Run の既定実行サービスアカウント（Compute Engine 既定 SA）を返す。"""
    r = _gcloud("projects", "describe", project, "--format=value(projectNumber)")
    if r.returncode != 0 or not r.stdout.strip():
        raise SystemExit(f"プロジェクト番号の取得に失敗しました:\n{r.stderr or r.stdout}")
    return f"{r.stdout.strip()}-compute@developer.gserviceaccount.com"


def build_image(project: str, region: str, service: str) -> str:
    image = f"{region}-docker.pkg.dev/{project}/{AR_REPO}/{service}"
    print(f"[4/8] Cloud Build でビルドします: {image}", flush=True)
    TMPDIR.mkdir(exist_ok=True)
    config = TMPDIR / "cloudbuild.yaml"
    config.write_text(
        "steps:\n"
        "- name: gcr.io/cloud-builders/docker\n"
        f"  args: ['build', '-f', 'agent/Dockerfile', '-t', '{image}', '.']\n"
        f"images: ['{image}']\n",
        encoding="utf-8",
    )
    r = _gcloud(
        "builds", "submit", "--config", str(config.relative_to(ROOT)),
        f"--project={project}", ".", stream=True,
    )
    if r.returncode != 0:
        raise SystemExit("Cloud Build に失敗しました。")
    return image


def _ensure_secret(name: str, value: str, project: str) -> None:
    r = _gcloud("secrets", "describe", name, f"--project={project}")
    if r.returncode != 0:
        r = _gcloud(
            "secrets", "create", name,
            "--replication-policy=automatic", f"--project={project}",
        )
        if r.returncode != 0:
            raise SystemExit(f"シークレット {name} の作成に失敗しました:\n{r.stderr or r.stdout}")
    r = _gcloud(
        "secrets", "versions", "add", name,
        "--data-file=-", f"--project={project}", input_text=value,
    )
    if r.returncode != 0:
        raise SystemExit(f"シークレット {name} への値登録に失敗しました:\n{r.stderr or r.stdout}")


def _grant_secret(name: str, project: str, sa: str) -> None:
    r = _gcloud(
        "secrets", "add-iam-policy-binding", name,
        f"--member=serviceAccount:{sa}",
        "--role=roles/secretmanager.secretAccessor", f"--project={project}",
    )
    if r.returncode != 0:
        print(f"警告: {name} へのアクセス権付与に失敗: {r.stderr or r.stdout}", flush=True)


def setup_secrets(args, project: str, sa: str, auth_mode: str | None) -> list[str]:
    """--set-secrets に渡す ENV=secret:latest のリストを返す。"""
    print("[5/8] シークレットを設定します...", flush=True)
    bindings = []

    if args.gemini_api_key:
        _ensure_secret(SECRET_GEMINI, args.gemini_api_key, project)
    if _secret_exists(SECRET_GEMINI, project):
        _grant_secret(SECRET_GEMINI, project, sa)
        bindings.append(f"GEMINI_API_KEY={SECRET_GEMINI}:latest")
        print(f"      {SECRET_GEMINI}: 登録済み → GEMINI_API_KEY", flush=True)
    else:
        print(
            f"      警告: シークレット {SECRET_GEMINI} がありません。"
            "内蔵AIのキーレス利用（/api/gemini）は無効になります。\n"
            "      後から有効化: --gemini-api-key KEY を付けて再実行",
            flush=True,
        )

    if args.maps_api_key:
        _ensure_secret(SECRET_MAPS, args.maps_api_key, project)
    if _secret_exists(SECRET_MAPS, project):
        _grant_secret(SECRET_MAPS, project, sa)
        bindings.append(f"GOOGLE_MAPS_API_KEY={SECRET_MAPS}:latest")
        print(f"      {SECRET_MAPS}: 登録済み → GOOGLE_MAPS_API_KEY", flush=True)

    if auth_mode:
        if args.auth_user and args.auth_pass:
            _ensure_secret(SECRET_AUTH_USER, args.auth_user, project)
            _ensure_secret(SECRET_AUTH_PASS, args.auth_pass, project)
        missing = [
            n for n in (SECRET_AUTH_USER, SECRET_AUTH_PASS)
            if not _secret_exists(n, project)
        ]
        if missing:
            raise SystemExit(
                f"認証モード {auth_mode} には Secret Manager の "
                f"{' / '.join(missing)} が必要です。初回は --auth-user と --auth-pass を指定してください。"
            )
        _grant_secret(SECRET_AUTH_USER, project, sa)
        _grant_secret(SECRET_AUTH_PASS, project, sa)
        bindings.append(f"KASUGAI_AUTH_USER={SECRET_AUTH_USER}:latest")
        bindings.append(f"KASUGAI_AUTH_PASS={SECRET_AUTH_PASS}:latest")
        print("      認証用シークレット: 登録済み → KASUGAI_AUTH_USER / KASUGAI_AUTH_PASS", flush=True)
    elif args.auth_user or args.auth_pass:
        print("      注意: --auth-user/--auth-pass は --auth-mode 指定時のみ有効です", flush=True)

    return bindings


def setup_bucket(project: str, region: str, sa: str, bucket: str | None,
                 auth_mode: str | None) -> list[str]:
    """--set-env-vars に渡す KEY=VALUE のリストを返す。"""
    envs = []
    if not bucket:
        if auth_mode:
            print(
                "[6/8] 警告: --bucket 未指定のため .kasc/データはコンテナ内 .datastore/ に\n"
                "      保存され、インスタンス再作成で失われます（永続化には --bucket を指定）",
                flush=True,
            )
        else:
            print("[6/8] GCS バケット: 未指定（--bucket で .kasc/データを永続化できます）", flush=True)
        return envs

    print(f"[6/8] GCS バケット gs://{bucket} を設定します...", flush=True)
    r = _gcloud("storage", "buckets", "describe", f"gs://{bucket}", f"--project={project}")
    if r.returncode != 0:
        r = _gcloud(
            "storage", "buckets", "create", f"gs://{bucket}",
            f"--location={region}", f"--project={project}",
            "--uniform-bucket-level-access",
        )
        if r.returncode != 0:
            raise SystemExit(f"バケットの作成に失敗しました:\n{r.stderr or r.stdout}")
        print(f"      gs://{bucket} を作成しました", flush=True)
    # 読み書き権限
    r = _gcloud(
        "storage", "buckets", "add-iam-policy-binding", f"gs://{bucket}",
        f"--member=serviceAccount:{sa}", "--role=roles/storage.objectAdmin",
        f"--project={project}",
    )
    if r.returncode != 0:
        print(f"警告: バケット権限の付与に失敗: {r.stderr or r.stdout}", flush=True)
    # V4 署名付き URL のため、SA 自身に signBlob 権限（serviceAccountTokenCreator）
    r = _gcloud(
        "iam", "service-accounts", "add-iam-policy-binding", sa,
        f"--member=serviceAccount:{sa}",
        "--role=roles/iam.serviceAccountTokenCreator", f"--project={project}",
    )
    if r.returncode != 0:
        print(
            f"警告: signBlob 権限の付与に失敗（署名付き URL が使えません。"
            "KASUGAI_DATA_REDIRECT=0 でプロキシ配信に切替可）:\n"
            f"{r.stderr or r.stdout}",
            flush=True,
        )
    envs.append(f"KASUGAI_GCS_BUCKET={bucket}")
    return envs


def deploy(project: str, region: str, service: str, image: str,
           envs: list[str], secrets: list[str], auth_mode: str | None) -> None:
    print(f"[7/8] Cloud Run にデプロイします: {service}（{region}）", flush=True)
    if auth_mode:
        envs = envs + [f"KASUGAI_AUTH_MODE={auth_mode}"]
    args = [
        "run", "deploy", service,
        "--image", image,
        f"--region={region}", f"--project={project}",
        "--allow-unauthenticated", "--min-instances=1",
    ]
    if envs:
        args += ["--set-env-vars", ",".join(envs)]
    if secrets:
        args += ["--set-secrets", ",".join(secrets)]
    r = _gcloud(*args, stream=True)
    if r.returncode != 0:
        raise SystemExit("gcloud run deploy に失敗しました。")


def service_url(project: str, region: str, service: str) -> str:
    r = _gcloud(
        "run", "services", "describe", service,
        f"--region={region}", f"--project={project}",
        "--format=value(status.url)",
    )
    return r.stdout.strip() if r.returncode == 0 else ""


def verify(base: str) -> None:
    if not base:
        print("[8/8] デプロイは完了しましたが URL を取得できませんでした。", flush=True)
        return
    print(f"[8/8] 動作確認: {base}", flush=True)
    ua = {"User-Agent": "KASUGAI-Canvas-deploy-check"}

    try:
        with urllib.request.urlopen(urllib.request.Request(base + "/health", headers=ua), timeout=15) as res:
            print(f"/health: {res.status} {res.read().decode('utf-8', errors='replace').strip()}", flush=True)
        with urllib.request.urlopen(urllib.request.Request(base + "/", headers=ua), timeout=15) as res:
            print(f"トップページ: {res.status}", flush=True)
    except urllib.error.HTTPError as e:
        print(f"警告: {e.code} が返りました。", flush=True)
    except urllib.error.URLError as e:
        print(f"警告: デプロイ先にアクセスできません: {e}", flush=True)
        return

    try:
        with urllib.request.urlopen(urllib.request.Request(base + "/api/capabilities", headers=ua), timeout=15) as res:
            caps = json.loads(res.read().decode("utf-8", errors="replace"))
        print(f"/api/capabilities: {json.dumps(caps, ensure_ascii=False)}", flush=True)
        features = caps.get("features") or []
        if "aiProxy" not in features:
            print(
                "警告: aiProxy が無効です（GEMINI_API_KEY 未設定）。"
                "審査員のキーレスAI利用には --gemini-api-key で再デプロイしてください。",
                flush=True,
            )
        if "kascWrite" not in features:
            print(
                "情報: kascWrite 無効（認証モード未設定）。"
                ".kasc のサーバー保存を使うには --auth-mode + --bucket を指定してください。",
                flush=True,
            )
    except Exception as e:
        print(f"警告: /api/capabilities の確認に失敗しました: {e}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="KASUGAI Canvas — Cloud Run デプロイ")
    parser.add_argument("--project", help="GCP プロジェクト ID（省略時は gcloud config の値）")
    parser.add_argument("--region", help=f"リージョン（既定: {REGION_DEFAULT}＝東京）")
    parser.add_argument("--service", help=f"Cloud Run サービス名（既定: {SERVICE_DEFAULT}）")
    parser.add_argument("--gemini-api-key", help="Gemini API キー（Secret Manager の gemini-api-key に登録）")
    parser.add_argument("--maps-api-key", help="Google Maps Platform API キー（google-maps-api-key に登録。capabilities 経由でブラウザへ配布）")
    parser.add_argument("--auth-mode", choices=["5", "6"], help="起動制御モード（5=認証のみ / 6=全ゲート）")
    parser.add_argument("--auth-user", help="認証モードのユーザー ID（初回のみ必要）")
    parser.add_argument("--auth-pass", help="認証モードのパスワード（初回のみ必要）")
    parser.add_argument("--bucket", help=".kasc・秘匿データを保存する GCS バケット名（無ければ作成）")
    args = parser.parse_args()

    # 前回デプロイ時の非秘密設定を既定値として引き継ぐ（引数指定が優先）
    saved = load_config()
    project = args.project or saved.get("project")
    region = args.region or saved.get("region") or REGION_DEFAULT
    service = args.service or saved.get("service") or SERVICE_DEFAULT
    bucket = args.bucket if args.bucket is not None else saved.get("bucket")
    auth_mode = args.auth_mode if args.auth_mode is not None else saved.get("auth_mode")
    if saved:
        print(f"{DEPLOY_CONFIG.name} の設定を引き継ぎます（引数指定で上書き可）", flush=True)

    project = check_auth(project)
    enable_apis(project)
    ensure_registry(project, region)
    image = build_image(project, region, service)
    sa = compute_sa(project)
    secrets = setup_secrets(args, project, sa, auth_mode)
    envs = setup_bucket(project, region, sa, bucket, auth_mode)
    deploy(project, region, service, image, envs, secrets, auth_mode)
    verify(service_url(project, region, service))
    save_config({
        "project": project, "region": region, "service": service,
        "bucket": bucket, "auth_mode": auth_mode,
    })
    print("完了しました。", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
