#!/usr/bin/env python3
"""KASUGAI Canvas の開発起動・ビルドラッパー。"""

import argparse
import datetime
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SERVER_DIR = ROOT / "server"
TARGET_EXE = SERVER_DIR / "target" / "release" / "kasugai_canvas.exe"
DOWNLOAD_DIR = ROOT / "download"
DOWNLOAD_ZIP = DOWNLOAD_DIR / "kasugai_canvas.zip"
DOWNLOAD_INSTALLER = DOWNLOAD_DIR / "kasugai_canvas_setup.exe"
DOWNLOAD_INSTALLER_ZIP = DOWNLOAD_DIR / "kasugai_canvas_setup.zip"
SAMPLE_CONFIG = ROOT / "installer" / "kasugai_canvas.config"
SAMPLE_PROJECTS = ROOT / "installer" / "projects"
INSTALLER_SCRIPT = ROOT / "installer" / "kasugai_canvas.nsi"


def check_versions() -> None:
    """各設定ファイルのバージョンが server/Cargo.toml と一致するか確認する。"""
    cargo_toml = (SERVER_DIR / "Cargo.toml").read_text(encoding="utf-8")
    cargo_match = re.search(r'^\s*version\s*=\s*"([^"]+)"', cargo_toml, re.M)
    if not cargo_match:
        raise SystemExit("server/Cargo.toml からバージョンを取得できません。")
    cargo_version = cargo_match.group(1)

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

    mismatches = []
    files = {
        "installer/kasugai_canvas.nsi (VIProductVersion)": nsi_product,
        "installer/kasugai_canvas.nsi (FileVersion)": nsi_file,
        "README.md": readme_version,
        "CHANGELOG.md": changelog_version,
    }
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
    cargo_toml = (SERVER_DIR / "Cargo.toml").read_text(encoding="utf-8")
    cargo_match = re.search(r'^\s*version\s*=\s*"([^"]+)"', cargo_toml, re.M)
    if not cargo_match:
        raise SystemExit("server/Cargo.toml からバージョンを取得できません。")
    cargo_version = cargo_match.group(1)

    if write_latest:
        latest_json = {
            "version": cargo_version,
            "notes": f"KASUGAI Canvas {cargo_version}",
            "pub_date": datetime.date.today().isoformat(),
            "platforms": {
                "windows-x86_64": {
                    "url": "https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/kasugai_canvas.zip"
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


def run_dev() -> None:
    """開発モードで起動する。"""
    _kill_existing_kasugai()
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
    sync_versions(write_latest=False)
    check_versions()
    subprocess.run(["cargo", "build", "--release"], cwd=SERVER_DIR, check=True)
    if not TARGET_EXE.exists():
        raise FileNotFoundError(f"ビルド済み実行ファイルがみつかりません: {TARGET_EXE}")

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
    build_installer()
    sync_versions(write_latest=True)


def run_release() -> None:
    """リリースビルド済みの実行ファイルを起動する。"""
    if not TARGET_EXE.exists():
        print(
            "実行ファイルが見つかりません。先に 'python run.py -B' を実行してください。",
            file=sys.stderr,
        )
        raise SystemExit(1)
    _kill_existing_kasugai()
    subprocess.run([str(TARGET_EXE)], cwd=ROOT, check=True)


def publish_release() -> None:
    """リリースビルド、コミット、プッシュまで行う。

    自動更新は main ブランチの latest.json / kasugai_canvas.zip のみを参照するため、
    タグは作成しない。
    """
    build_release()
    cargo_toml = (SERVER_DIR / "Cargo.toml").read_text(encoding="utf-8")
    cargo_match = re.search(r'^\s*version\s*=\s*"([^"]+)"', cargo_toml, re.M)
    if not cargo_match:
        raise SystemExit("server/Cargo.toml からバージョンを取得できません。")
    version = cargo_match.group(1)
    subprocess.run(["git", "add", "-A"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-m", f"{version} リリース"], cwd=ROOT, check=True)
    subprocess.run(["git", "push"], cwd=ROOT, check=True)
    print(f"バージョン {version} をリモートへプッシュしました。")


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

