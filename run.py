#!/usr/bin/env python3
"""KASUGAI Canvas の開発起動・ビルドラッパー。"""

import argparse
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
INSTALLER_SCRIPT = ROOT / "installer" / "kasugai_canvas.nsi"


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
            str(INSTALLER_SCRIPT),
        ],
        cwd=ROOT,
        check=True,
    )
    print(f"インストーラーを作成しました: {DOWNLOAD_INSTALLER}")


def build_release() -> None:
    """リリースビルド、配布 ZIP、NSIS インストーラーを作成する。"""
    subprocess.run(["cargo", "build", "--release"], cwd=SERVER_DIR, check=True)
    if not TARGET_EXE.exists():
        raise FileNotFoundError(f"ビルド済み実行ファイルが見つかりません: {TARGET_EXE}")

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(DOWNLOAD_ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(TARGET_EXE, arcname=TARGET_EXE.name)
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

