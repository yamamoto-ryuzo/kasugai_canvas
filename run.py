#!/usr/bin/env python3
"""KASUGAI Canvas の開発起動・ビルドラッパー。"""

import argparse
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

    latest = (DOWNLOAD_DIR / "latest.json").read_text(encoding="utf-8")
    latest_match = re.search(r'"version"\s*:\s*"([^"]+)"', latest)
    latest_version = latest_match.group(1) if latest_match else None

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
        "download/latest.json": latest_version,
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


def run_dev() -> None:
    """開発モードで起動する。"""
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
    check_versions()
    subprocess.run(["cargo", "build", "--release"], cwd=SERVER_DIR, check=True)
    if not TARGET_EXE.exists():
        raise FileNotFoundError(f"ビルド済み実行ファイルが見つかりません: {TARGET_EXE}")

    if not SAMPLE_CONFIG.exists():
        raise FileNotFoundError(f"初期サンプル設定が見つかりません: {SAMPLE_CONFIG}")
    if not SAMPLE_PROJECTS.exists():
        raise FileNotFoundError(f"初期サンプルプロジェクトが見つかりません: {SAMPLE_PROJECTS}")

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(DOWNLOAD_ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(TARGET_EXE, arcname=TARGET_EXE.name)
        archive.write(SAMPLE_CONFIG, arcname=SAMPLE_CONFIG.name)
        for project_file in SAMPLE_PROJECTS.rglob("*"):
            if project_file.is_file():
                archive.write(project_file, arcname=(Path("projects") / project_file.relative_to(SAMPLE_PROJECTS)).as_posix())
    print(f"ZIP を作成しました: {DOWNLOAD_ZIP}")
    build_installer()


def run_release() -> None:
    """リリースビルド済みの実行ファイルを起動する。"""
    if not TARGET_EXE.exists():
        print(
            "実行ファイルが見つかりません。先に 'python run.py -B' を実行してください。",
            file=sys.stderr,
        )
        raise SystemExit(1)
    subprocess.run([str(TARGET_EXE)], cwd=ROOT, check=True)


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

    if args.build:
        build_release()
    elif args.release:
        run_release()
    else:
        run_dev()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error

