#!/usr/bin/env python3
"""KASUGAI Canvas の開発起動・ビルドラッパー。"""

import argparse
import datetime
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SERVER_DIR = ROOT / "server"
TARGET_EXE = SERVER_DIR / "target" / "release" / "kasugai_canvas.exe"
DOWNLOAD_DIR = ROOT / "download"
DOWNLOAD_ZIP = DOWNLOAD_DIR / "kasugai_canvas.zip"
DOWNLOAD_INSTALLER = DOWNLOAD_DIR / "kasugai_canvas_setup.exe"
DOWNLOAD_INSTALLER_ZIP = DOWNLOAD_DIR / "kasugai_canvas_setup.zip"
SAMPLE_PROJECTS = ROOT / "installer" / "projects"
WEB_DIR = ROOT / "web"
INSTALLER_SCRIPT = ROOT / "installer" / "kasugai_canvas.nsi"
# 公開ドキュメントは docs/ 配下（GitHub Pages ソース）。バージョン同期の対象
DOCS_DIR = ROOT / "docs"


def _get_cargo_version() -> str:
    """server/Cargo.toml からバージョンを取得する。"""
    cargo_toml = (SERVER_DIR / "Cargo.toml").read_text(encoding="utf-8")
    cargo_match = re.search(r'^\s*version\s*=\s*"([^"]+)"', cargo_toml, re.M)
    if not cargo_match:
        raise SystemExit("server/Cargo.toml からバージョンを取得できません。")
    return cargo_match.group(1)


def _version_key(version: str) -> tuple:
    """"5.29.0" 形式のバージョンを比較用タプルへ（欠けた要素は 0 扱い）。"""
    parts = []
    for part in version.split("."):
        m = re.match(r"\d+", part)
        parts.append(int(m.group(0)) if m else 0)
    return tuple(parts)


def _latest_json_version() -> str | None:
    """download/latest.json に記録されている現行リリース番号を返す。"""
    latest_json_path = DOWNLOAD_DIR / "latest.json"
    if not latest_json_path.exists():
        return None
    latest_match = re.search(
        r'"version"\s*:\s*"([^"]+)"', latest_json_path.read_text(encoding="utf-8")
    )
    return latest_match.group(1) if latest_match else None


def _channel_info(cargo_version: str | None = None) -> dict:
    """バージョンから配布物のファイル名等を決定する。

    自動更新は単一チャンネル(main ブランチの download/latest.json・kasugai_canvas.zip)。
    リリース番号は接尾辞なしの X.Y.Z で、Cargo.toml は常に latest.json より
    先の番号に保つ運用。dev フラグは「接尾辞付き=配布不可・CHANGELOG照合スキップ」
    の判定にのみ使う。
    """
    version = cargo_version or _get_cargo_version()
    dev = "-" in version
    return {
        "version": version,
        "dev": dev,
        "branch": "main",
        "latest_name": "latest.json",
        "zip_name": "kasugai_canvas.zip",
        "installer_name": "kasugai_canvas_setup.exe",
        "installer_zip_name": "kasugai_canvas_setup.zip",
    }


def check_versions(check_latest: bool = True) -> None:
    """各設定ファイルのバージョンが server/Cargo.toml と一致するか確認する。"""
    cargo_version = _get_cargo_version()
    channel = _channel_info(cargo_version)
    # VIProductVersion は数値のみ(X.Y.Z.W)なので接尾辞を除いた部分と比較する
    numeric_version = cargo_version.split("-")[0]

    nsi = INSTALLER_SCRIPT.read_text(encoding="utf-8")
    product_match = re.search(r'VIProductVersion "([^"]+)"', nsi)
    file_match = re.search(r'VIAddVersionKey "FileVersion" "([^"]+)"', nsi)
    nsi_product = product_match.group(1).rsplit(".", 1)[0] if product_match else None
    nsi_file = file_match.group(1) if file_match else None

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    readme_match = re.search(r"現在のバージョンは \*\*([^*]+)\*\* です。", readme)
    readme_version = readme_match.group(1) if readme_match else None

    files = {
        "installer/kasugai_canvas.nsi (VIProductVersion)": nsi_product,
        "installer/kasugai_canvas.nsi (FileVersion)": nsi_file,
        "README.md": readme_version,
    }
    # 各ファイルが期待するバージョン。VIProductVersion は数値部分とのみ一致を要求する
    expected = {name: cargo_version for name in files}
    expected["installer/kasugai_canvas.nsi (VIProductVersion)"] = numeric_version

    # CHANGELOG はリリースのみ記録する。接尾辞付きバージョンは対象外
    if not channel["dev"]:
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        changelog_match = re.search(r"^## \[(\d+\.\d+\.\d+)\] -", changelog, re.M)
        files["CHANGELOG.md"] = changelog_match.group(1) if changelog_match else None
        expected["CHANGELOG.md"] = cargo_version

    nav = (DOCS_DIR / "nav.js").read_text(encoding="utf-8")
    nav_match = re.search(r"const VERSION = 'v([^']+)'", nav)
    files["docs/nav.js"] = nav_match.group(1) if nav_match else None
    expected["docs/nav.js"] = cargo_version

    # ドキュメントのバージョンバッジも Cargo.toml と同期・検査する。
    documentation_pages = [
        *(page for page in DOCS_DIR.glob("*.html") if page.name != "home.html"),
        *DOCS_DIR.glob("auth/*.html"),
        *DOCS_DIR.glob("features/*.html"),
    ]
    for page in documentation_pages:
        page_content = page.read_text(encoding="utf-8")
        badge_match = re.search(r'class="version-badge">v([^<]+)</span>', page_content)
        files[str(page.relative_to(ROOT))] = badge_match.group(1) if badge_match else None
        expected[str(page.relative_to(ROOT))] = cargo_version

    # 接尾辞付きバージョンでは latest.json は書き換えない(配布不可)ため照合もスキップする
    if check_latest and not channel["dev"]:
        latest_json_path = DOWNLOAD_DIR / channel["latest_name"]
        if latest_json_path.exists():
            latest_content = latest_json_path.read_text(encoding="utf-8")
            latest_match = re.search(r'"version"\s*:\s*"([^"]+)"', latest_content)
            files[f"download/{channel['latest_name']}"] = latest_match.group(1) if latest_match else None
        else:
            files[f"download/{channel['latest_name']}"] = None
        expected[f"download/{channel['latest_name']}"] = cargo_version

    mismatches = []
    for name, version in files.items():
        if version != expected[name]:
            mismatches.append(f"  {name}: {version} (server/Cargo.toml: {expected[name]})")

    if mismatches:
        print("エラー: 以下のファイルのバージョンが server/Cargo.toml と一致していません。", file=sys.stderr, flush=True)
        for line in mismatches:
            print(line, file=sys.stderr, flush=True)
        raise SystemExit(1)

    print(f"バージョン整合性チェック完了: {cargo_version}", file=sys.stderr, flush=True)


def sync_versions(write_latest: bool = True) -> None:
    """server/Cargo.toml のバージョンを他の公開ファイルへ同期する。

    write_latest=False の場合、latest.json には書き込まず、ドキュメント・ナビゲーション・README・NSIS を同期する。
    リリースビルドの途中で latest.json を更新しないようにするためのオプション。
    """
    cargo_version = _get_cargo_version()
    channel = _channel_info(cargo_version)
    numeric_version = cargo_version.split("-")[0]

    if write_latest and channel["dev"]:
        raise SystemExit(
            f"接尾辞付きバージョン {cargo_version} では latest.json を更新できません。"
            "Cargo.toml のバージョンを接尾辞なしのリリース番号にしてください。"
        )

    if write_latest:
        latest_json = {
            "version": cargo_version,
            "notes": f"KASUGAI Canvas {cargo_version}",
            "pub_date": datetime.date.today().isoformat(),
            "platforms": {
                "windows-x86_64": {
                    "url": f"https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/{channel['branch']}/download/{channel['zip_name']}?v={cargo_version}"
                }
            }
        }
        (DOWNLOAD_DIR / channel["latest_name"]).write_text(json.dumps(latest_json, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    readme = re.sub(r"(現在のバージョンは \*\*)[^*]+(\*\* です。)", lambda m: f"{m.group(1)}{cargo_version}{m.group(2)}", readme)
    (ROOT / "README.md").write_text(readme, encoding="utf-8")

    nsi = INSTALLER_SCRIPT.read_text(encoding="utf-8")
    nsi = re.sub(r'VIProductVersion "[^"]+"', lambda m: f'VIProductVersion "{numeric_version}.0"', nsi)
    nsi = re.sub(r'VIAddVersionKey "FileVersion" "[^"]+"', lambda m: f'VIAddVersionKey "FileVersion" "{cargo_version}"', nsi)
    INSTALLER_SCRIPT.write_text(nsi, encoding="utf-8")

    nav_path = DOCS_DIR / "nav.js"
    nav = nav_path.read_text(encoding="utf-8")
    nav = re.sub(r"const VERSION = 'v[^']+'", f"const VERSION = 'v{cargo_version}'", nav)
    nav_path.write_text(nav, encoding="utf-8")

    for page in [*DOCS_DIR.glob("*.html"), *DOCS_DIR.glob("auth/*.html"), *DOCS_DIR.glob("features/*.html")]:
        page_content = page.read_text(encoding="utf-8")
        page_content = re.sub(
            r'(class="version-badge">)v[^<]+(</span>)',
            lambda m: f"{m.group(1)}v{cargo_version}{m.group(2)}",
            page_content,
        )
        page.write_text(page_content, encoding="utf-8")

    print(f"バージョンを {cargo_version} へ同期しました。", file=sys.stderr, flush=True)


def _get_port() -> int:
    """使用するポート番号を取得する。"""
    port_env = os.environ.get("KASUGAI_CANVAS_PORT")
    if port_env:
        try:
            return int(port_env)
        except ValueError:
            pass
    return 8510


def _print_access_url() -> None:
    """アクセス先URLをターミナルに表示する。"""
    print(f"ブラウザで以下のURLにアクセスしてください: http://127.0.0.1:{_get_port()}/", flush=True)


def _kill_existing_kasugai() -> None:
    """既存の kasugai_canvas.exe を停止する。"""
    try:
        subprocess.run(
            ["taskkill", "/F", "/IM", "kasugai_canvas.exe"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        pass


def _find_free_port() -> int:
    """空いている TCP ポートを 1 つ見つける。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def _kill_process(process: subprocess.Popen) -> None:
    """起動したサブプロセスを終了する。"""
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            subprocess.run(
                ["taskkill", "/F", "/PID", str(process.pid)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            pass
        process.wait()


def _wait_for_health(port: int, expected_version: str, timeout: float = 30.0) -> None:
    """指定ポートでサーバーの /health が返却する version を確認する。"""
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                data = json.loads(response.read().decode("utf-8"))
            actual = data.get("version")
            if actual != expected_version:
                raise SystemExit(
                    f"EXE バージョンが一致しません: 期待 {expected_version}, 実際 {actual}"
                )
            return
        except (urllib.error.URLError, json.JSONDecodeError, ConnectionRefusedError, TimeoutError):
            time.sleep(0.5)
    raise SystemExit(f"起動確認が {timeout} 秒以内に完了しませんでした: {url}")


def _start_exe_and_verify(exe_path: Path, expected_version: str) -> None:
    """EXE を一時ポートで起動し、/health の version を検証する。"""
    port = _find_free_port()
    env = {**os.environ, "KASUGAI_CANVAS_PORT": str(port)}
    process = subprocess.Popen([str(exe_path), "--no-browser"], env=env)
    try:
        _wait_for_health(port, expected_version)
    finally:
        _kill_process(process)


def _verify_zip_version(zip_path: Path, expected_version: str) -> None:
    """ZIP を一時展開し、同梱 EXE の /health version を検証する。"""
    with tempfile.TemporaryDirectory() as tmp:
        extract_dir = Path(tmp) / "extracted"
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as archive:
            archive.extractall(extract_dir)
        exe = extract_dir / TARGET_EXE.name
        if not exe.exists():
            raise FileNotFoundError(f"ZIP内に実行ファイルが見つかりません: {zip_path}")
        _start_exe_and_verify(exe, expected_version)


def run_dev() -> None:
    """開発モードで起動する。"""
    _kill_existing_kasugai()
    _print_access_url()
    debug_dir = SERVER_DIR / "target" / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    if SAMPLE_PROJECTS.exists():
        dev_projects = debug_dir / "projects"
        dev_projects.mkdir(parents=True, exist_ok=True)
        for project in SAMPLE_PROJECTS.iterdir():
            if project.is_dir() and not (dev_projects / project.name).exists():
                shutil.copytree(project, dev_projects / project.name)
    subprocess.run(["cargo", "run", "--", "--no-browser"], cwd=SERVER_DIR, check=True)


def build_installer(channel: dict) -> None:
    """NSIS インストーラーを作成する。"""
    makensis = shutil.which("makensis") or shutil.which("makensis.exe")
    if not makensis:
        for candidate in (
            Path(r"C:\Program Files\NSIS\makensis.exe"),
            Path(r"C:\Program Files (x86)\NSIS\makensis.exe"),
        ):
            if candidate.exists():
                makensis = str(candidate)
                break
    if not makensis:
        print("makensis が見つからないため、インストーラー作成をスキップします。")
        print("NSIS をインストールしてから再実行してください。")
        return
    subprocess.run(
        [
            makensis,
            f"/DBUILD_EXE={TARGET_EXE}",
            f"/DSAMPLE_PROJECTS={SAMPLE_PROJECTS}",
            f"/DWEB_DIR={WEB_DIR}",
            f"/DSETUP_OUT={channel['installer_name']}",
            str(INSTALLER_SCRIPT),
        ],
        cwd=ROOT,
        check=True,
    )
    installer = DOWNLOAD_DIR / channel["installer_name"]
    installer_zip = DOWNLOAD_DIR / channel["installer_zip_name"]
    print(f"インストーラーを作成しました: {installer}")

    with zipfile.ZipFile(installer_zip, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(installer, arcname=installer.name)
    print(f"インストーラーZIPを作成しました: {installer_zip}")


def build_release() -> None:
    """リリースビルド、配布 ZIP、NSIS インストーラーを作成する。

    配布は単一チャンネル(kasugai_canvas.zip / latest.json)。開発版バージョン
    ("X.Y.Z-*")では実行不可。
    """
    cargo_version = _get_cargo_version()
    channel = _channel_info(cargo_version)
    if channel["dev"]:
        raise SystemExit(
            f"接尾辞付きバージョン {cargo_version} では配布ビルドできません。"
            "Cargo.toml のバージョンを接尾辞なしのリリース番号にしてください。"
        )
    # リリース番号は必ず繰り上げる（同一番号・降格の再配布を禁止）
    latest_version = _latest_json_version()
    if latest_version and _version_key(cargo_version) <= _version_key(latest_version):
        raise SystemExit(
            f"バージョン {cargo_version} は最新リリース {latest_version} 以下のため"
            "配布ビルドできません。Cargo.toml を次の番号へ上げてください。"
        )
    _kill_existing_kasugai()
    print("更新チャンネル: 公開(main)", flush=True)
    sync_versions(write_latest=False)
    check_versions(check_latest=False)
    subprocess.run(["cargo", "build", "--release"], cwd=SERVER_DIR, check=True)
    if not TARGET_EXE.exists():
        raise FileNotFoundError(f"ビルド済み実行ファイルがみつかりません: {TARGET_EXE}")

    print("ビルド済み EXE のバージョンを確認します...")
    _start_exe_and_verify(TARGET_EXE, cargo_version)

    if not SAMPLE_PROJECTS.exists():
        raise FileNotFoundError(f"初期サンプルプロジェクトがみつかりません: {SAMPLE_PROJECTS}")

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    download_zip = DOWNLOAD_DIR / channel["zip_name"]
    web_dir = ROOT / "web"
    with zipfile.ZipFile(download_zip, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(TARGET_EXE, arcname=TARGET_EXE.name)
        for project_file in SAMPLE_PROJECTS.rglob("*"):
            if project_file.is_file():
                archive.write(project_file, arcname=(Path("projects") / project_file.relative_to(SAMPLE_PROJECTS)).as_posix())
        if web_dir.exists():
            for web_file in web_dir.rglob("*"):
                # vendor/(vendored 地理院地図)は CDN 配信へ移行したため配布物へ含めない
                if "vendor" in web_file.relative_to(web_dir).parts:
                    continue
                if web_file.is_file():
                    archive.write(web_file, arcname=(Path("web") / web_file.relative_to(web_dir)).as_posix())
        # AI ブリッジハブは Rust 製アプリ内モジュールに統合済み（server/src/bridge/）。
        # 旧 Node 製ブリッジは撤去済み。ブラウザ WebGIS 向け配布 bridge-hub.zip は
        # Rust 製 bridge-hub.exe（web/download/ 経由で配信・tools/build_bridge_zip.py）
    print(f"ZIP を作成しました: {download_zip}")

    print("ZIP 内 EXE のバージョンを確認します...")
    _verify_zip_version(download_zip, cargo_version)

    build_installer(channel)
    sync_versions(write_latest=True)
    check_versions(check_latest=True)


def run_release() -> None:
    """リリースビルド済みの実行ファイルを起動する。"""
    if not TARGET_EXE.exists():
        print(
            "実行ファイルが見つかりません。先に 'python run.py -B' を実行してください。",
            file=sys.stderr,
        )
        raise SystemExit(1)
    _kill_existing_kasugai()
    _print_access_url()
    subprocess.run([str(TARGET_EXE), "--no-browser"], cwd=ROOT, check=True)


def publish_release() -> None:
    """リリースビルド、コミット、プッシュまで行う。

    自動更新は main ブランチの latest.json / ZIP を参照するため、タグは作成しない。
    """
    build_release()
    cargo_version = _get_cargo_version()
    message = f"{cargo_version} リリース"
    subprocess.run(["git", "add", "-A"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-m", message], cwd=ROOT, check=True)
    subprocess.run(["git", "push"], cwd=ROOT, check=True)
    print(f"バージョン {cargo_version} をリモートへプッシュしました。")


def deploy_cloudrun() -> None:
    """run-cloudrun.py で Cloud Run へデプロイする。

    設定は kasugai_canvas.cloudrun.json（初回の run-cloudrun.py 実行で作成）を
    引き継ぐ。gcloud CLI のインストールと認証（gcloud auth login）が前提。
    """
    script = ROOT / "run-cloudrun.py"
    if not script.exists():
        raise SystemExit("run-cloudrun.py が見つかりません。")
    if not (ROOT / "kasugai_canvas.cloudrun.json").exists():
        raise SystemExit(
            "kasugai_canvas.cloudrun.json がありません。初回は引数付きで実行してください:\n"
            "  python run-cloudrun.py --gemini-api-key KEY --auth-mode 5 \\\n"
            "    --auth-user ID --auth-pass PASS --bucket BUCKET"
        )
    print("Cloud Run へデプロイします...", flush=True)
    subprocess.run([sys.executable, str(script)], cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="KASUGAI Canvas ランチャー")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "-b",
        "-B",
        "--build",
        action="store_true",
        help="リリースビルドを行い配布 ZIP を作成（kasugai_canvas.zip。latest.json 以下または接尾辞付きバージョンでは実行不可）",
    )
    group.add_argument(
        "--release",
        action="store_true",
        help="リリースビルド済みの実行ファイルを起動",
    )
    group.add_argument(
        "--publish",
        action="store_true",
        help="リリースビルド、コミット、リモートプッシュまで一括実行",
    )
    parser.add_argument(
        "--sync",
        action="store_true",
        help="server/Cargo.toml のバージョンを他の公開ファイルへ同期",
    )
    parser.add_argument(
        "--cloudrun",
        action="store_true",
        help="Cloud Run へデプロイ（kasugai_canvas.cloudrun.json の設定を使用。--publish と併用可）",
    )
    parser.add_argument(
        "build_short",
        nargs="?",
        choices=["b", "B"],
        metavar="b",
        help="ビルドの短縮指定（b または B）",
    )
    args = parser.parse_args()

    if args.build_short in ("b", "B"):
        if args.release:
            parser.error("b/B と --release は同時に指定できません")
        args.build = True

    if args.sync:
        # --sync はリリース済み番号との整合確認専用。Cargo.toml が
        # latest.json と異なる(開発中・古いブランチ)ときに実行すると
        # 公開ファイルを未リリース番号へ書き換えてしまうため拒否する
        latest_version = _latest_json_version()
        cargo_version = _get_cargo_version()
        if latest_version and _version_key(cargo_version) != _version_key(latest_version):
            raise SystemExit(
                f"Cargo.toml のバージョン {cargo_version} と最新リリース"
                f" {latest_version} が一致しません。--sync はリリース直後の"
                "整合確認用です。配布は python run.py -B を実行してください。"
            )
        sync_versions(write_latest=False)
        # latest.json だけを新バージョンへ更新して配布 ZIP が古いままだと、
        # 公開時に全ユーザーの自動更新が無限ループする（4.20.0 で発生）。
        # --sync でも ZIP 内 exe の /health バージョンを検証してズレを止める
        channel = _channel_info()
        download_zip = DOWNLOAD_DIR / channel["zip_name"]
        if download_zip.exists():
            print("ZIP 内 EXE のバージョンを確認します...", file=sys.stderr, flush=True)
            _verify_zip_version(download_zip, _get_cargo_version())
        else:
            print(
                f"警告: download/{channel['zip_name']} がありません。公開前に 'python run.py -B' で作成してください。",
                file=sys.stderr,
                flush=True,
            )
    elif args.build:
        build_release()
        if args.cloudrun:
            deploy_cloudrun()
    elif args.release:
        run_release()
    elif args.publish:
        publish_release()
        if args.cloudrun:
            deploy_cloudrun()
    elif args.cloudrun:
        deploy_cloudrun()
    else:
        run_dev()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
