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
SAMPLE_CONFIG = ROOT / "installer" / "kasugai_canvas.kasc"
SAMPLE_PROJECTS = ROOT / "installer" / "projects"
INSTALLER_SCRIPT = ROOT / "installer" / "kasugai_canvas.nsi"


def _get_cargo_version() -> str:
    """server/Cargo.toml からバージョンを取得する。"""
    cargo_toml = (SERVER_DIR / "Cargo.toml").read_text(encoding="utf-8")
    cargo_match = re.search(r'^\s*version\s*=\s*"([^"]+)"', cargo_toml, re.M)
    if not cargo_match:
        raise SystemExit("server/Cargo.toml からバージョンを取得できません。")
    return cargo_match.group(1)


def check_versions(check_latest: bool = True) -> None:
    """各設定ファイルのバージョンが server/Cargo.toml と一致するか確認する。"""
    cargo_version = _get_cargo_version()

    nsi = INSTALLER_SCRIPT.read_text(encoding="utf-8")
    product_match = re.search(r'VIProductVersion "([^"]+)"', nsi)
    file_match = re.search(r'VIAddVersionKey "FileVersion" "([^"]+)"', nsi)
    nsi_product = product_match.group(1).rsplit(".", 1)[0] if product_match else None
    nsi_file = file_match.group(1) if file_match else None

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    readme_match = re.search(r"現在のバージョンは \*\*([^*]+)\*\* です。", readme)
    readme_version = readme_match.group(1) if readme_match else None

    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    changelog_match = re.search(r"^## \[(\d+\.\d+\.\d+)\] -", changelog, re.M)
    changelog_version = changelog_match.group(1) if changelog_match else None

    files = {
        "installer/kasugai_canvas.nsi (VIProductVersion)": nsi_product,
        "installer/kasugai_canvas.nsi (FileVersion)": nsi_file,
        "README.md": readme_version,
        "CHANGELOG.md": changelog_version,
    }

    if check_latest:
        latest_json_path = DOWNLOAD_DIR / "latest.json"
        if latest_json_path.exists():
            latest_content = latest_json_path.read_text(encoding="utf-8")
            latest_match = re.search(r'"version"\s*:\s*"([^"]+)"', latest_content)
            files["download/latest.json"] = latest_match.group(1) if latest_match else None
        else:
            files["download/latest.json"] = None

    mismatches = []
    for name, version in files.items():
        if version != cargo_version:
            mismatches.append(f"  {name}: {version} (server/Cargo.toml: {cargo_version})")

    if mismatches:
        print("エラー: 以下のファイルのバージョンが server/Cargo.toml と一致していません。", file=sys.stderr, flush=True)
        for line in mismatches:
            print(line, file=sys.stderr, flush=True)
        raise SystemExit(1)

    print(f"バージョン整合性チェック完了: {cargo_version}", file=sys.stderr, flush=True)


def sync_versions(write_latest: bool = True) -> None:
    """server/Cargo.toml のバージョンを他の公開ファイルへ同期する。

    write_latest=False の場合、latest.json には書き込まず、README と NSIS メタデータのみ同期する。
    リリースビルドの途中で latest.json を更新しないようにするためのオプション。
    """
    cargo_version = _get_cargo_version()

    if write_latest:
        latest_json = {
            "version": cargo_version,
            "notes": f"KASUGAI Canvas {cargo_version}",
            "pub_date": datetime.date.today().isoformat(),
            "platforms": {
                "windows-x86_64": {
                    "url": f"https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/kasugai_canvas.zip?v={cargo_version}"
                }
            }
        }
        (DOWNLOAD_DIR / "latest.json").write_text(json.dumps(latest_json, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    readme = re.sub(r"(現在のバージョンは \*\*)[^*]+(\*\* です。)", lambda m: f"{m.group(1)}{cargo_version}{m.group(2)}", readme)
    (ROOT / "README.md").write_text(readme, encoding="utf-8")

    nsi = INSTALLER_SCRIPT.read_text(encoding="utf-8")
    nsi = re.sub(r'VIProductVersion "[^"]+"', lambda m: f'VIProductVersion "{cargo_version}.0"', nsi)
    nsi = re.sub(r'VIAddVersionKey "FileVersion" "[^"]+"', lambda m: f'VIAddVersionKey "FileVersion" "{cargo_version}"', nsi)
    INSTALLER_SCRIPT.write_text(nsi, encoding="utf-8")

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
        except (urllib.error.URLError, json.JSONDecodeError, ConnectionRefusedError):
            time.sleep(0.5)
    raise SystemExit(f"起動確認が {timeout} 秒以内に完了しませんでした: {url}")


def _start_exe_and_verify(exe_path: Path, expected_version: str) -> None:
    """EXE を一時ポートで起動し、/health の version を検証する。"""
    port = _find_free_port()
    env = {**os.environ, "KASUGAI_CANVAS_PORT": str(port)}
    process = subprocess.Popen([str(exe_path)], env=env)
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
    dev_config = debug_dir / "kasugai_canvas.kasc"
    if not dev_config.exists() and SAMPLE_CONFIG.exists():
        shutil.copy(SAMPLE_CONFIG, dev_config)
    if SAMPLE_PROJECTS.exists():
        dev_projects = debug_dir / "projects"
        dev_projects.mkdir(parents=True, exist_ok=True)
        for project in SAMPLE_PROJECTS.iterdir():
            if project.is_dir() and not (dev_projects / project.name).exists():
                shutil.copytree(project, dev_projects / project.name)
    subprocess.run(["cargo", "run"], cwd=SERVER_DIR, check=True)


def build_installer() -> None:
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
            f"/DSAMPLE_CONFIG={SAMPLE_CONFIG}",
            f"/DSAMPLE_PROJECTS={SAMPLE_PROJECTS}",
            str(INSTALLER_SCRIPT),
        ],
        cwd=ROOT,
        check=True,
    )
    print(f"インストーラーを作成しました: {DOWNLOAD_INSTALLER}")

    with zipfile.ZipFile(DOWNLOAD_INSTALLER_ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(DOWNLOAD_INSTALLER, arcname=DOWNLOAD_INSTALLER.name)
    print(f"インストーラーZIPを作成しました: {DOWNLOAD_INSTALLER_ZIP}")


def build_release() -> None:
    """リリースビルド、配布 ZIP、NSIS インストーラーを作成する。"""
    cargo_version = _get_cargo_version()
    sync_versions(write_latest=False)
    check_versions(check_latest=False)
    subprocess.run(["cargo", "build", "--release"], cwd=SERVER_DIR, check=True)
    if not TARGET_EXE.exists():
        raise FileNotFoundError(f"ビルド済み実行ファイルがみつかりません: {TARGET_EXE}")

    print("ビルド済み EXE のバージョンを確認します...")
    _start_exe_and_verify(TARGET_EXE, cargo_version)

    if not SAMPLE_CONFIG.exists():
        raise FileNotFoundError(f"初期サンプル設定がみつかりません: {SAMPLE_CONFIG}")
    if not SAMPLE_PROJECTS.exists():
        raise FileNotFoundError(f"初期サンプルプロジェクトがみつかりません: {SAMPLE_PROJECTS}")

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(DOWNLOAD_ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(TARGET_EXE, arcname=TARGET_EXE.name)
        archive.write(SAMPLE_CONFIG, arcname=SAMPLE_CONFIG.name)
        for project_file in SAMPLE_PROJECTS.rglob("*"):
            if project_file.is_file():
                archive.write(project_file, arcname=(Path("projects") / project_file.relative_to(SAMPLE_PROJECTS)).as_posix())
    print(f"ZIP を作成しました: {DOWNLOAD_ZIP}")

    print("ZIP 内 EXE のバージョンを確認します...")
    _verify_zip_version(DOWNLOAD_ZIP, cargo_version)

    build_installer()
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
    subprocess.run([str(TARGET_EXE)], cwd=ROOT, check=True)


def publish_release() -> None:
    """リリースビルド、コミット、プッシュまで行う。

    自動更新は main ブランチの latest.json / kasugai_canvas.zip のみを参照するため、
    タグは作成しない。
    """
    build_release()
    cargo_version = _get_cargo_version()
    subprocess.run(["git", "add", "-A"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-m", f"{cargo_version} リリース"], cwd=ROOT, check=True)
    subprocess.run(["git", "push"], cwd=ROOT, check=True)
    print(f"バージョン {cargo_version} をリモートへプッシュしました。")


def main() -> None:
    parser = argparse.ArgumentParser(description="KASUGAI Canvas ランチャー")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "-b",
        "-B",
        "--build",
        action="store_true",
        help="リリースビルドを行い download\\kasugai_canvas.zip を作成",
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
        sync_versions()
    elif args.build:
        build_release()
    elif args.release:
        run_release()
    elif args.publish:
        publish_release()
    else:
        run_dev()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
