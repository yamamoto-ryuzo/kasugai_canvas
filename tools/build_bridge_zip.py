#!/usr/bin/env python3
"""Build web/download/bridge-hub.zip + bridge-hub.exe — ブリッジハブ配布物。

CDN/静的配信版の AI 設定画面からダウンロードさせるための単品配布物。
Rust 製 bridge-hub.exe（server/src/bin/bridge-hub.rs）は GUI subsystem
ビルドの単一 exe で、実行するだけで %LOCALAPPDATA% へ自己コピー＋
ログイン時自動起動登録＋8511 で起動する（スクリプト不要 — 旧同梱の
vbs/ps1/cmd は廃止し、AV 誤検知回避のため ZIP は exe+README のみ）。
・bridge-hub.exe 単品 … web/download/bridge-hub.exe
・exe + README の ZIP … web/download/bridge-hub.zip
として出力する。Node.js 不要（旧 server.mjs 版は廃止）。
web/ 直下に置くため、CDN 同期（publish_cdn.py）にそのまま含まれる。

usage:
    python tools/build_bridge_zip.py [出力zipパス] [--no-build]
"""

import os
import shutil
import subprocess
import sys
import zipfile

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(REPO_DIR, 'server')
EXE = os.path.join(SERVER_DIR, 'target', 'release', 'bridge-hub.exe')
DEFAULT_OUT = os.path.join(REPO_DIR, 'web', 'download', 'bridge-hub.zip')
BUNDLE_DIR = 'bridge-hub'
BUNDLE_FILES = (
    'README.md',
)


def build(out=DEFAULT_OUT, cargo=True):
    if cargo:
        subprocess.run(
            ['cargo', 'build', '--release', '--bin', 'bridge-hub'],
            cwd=SERVER_DIR, check=True)
    if not os.path.isfile(EXE):
        raise FileNotFoundError(
            'bridge-hub.exe not found: {0} '
            '(cargo build --release --bin bridge-hub)'.format(EXE))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(EXE, os.path.join(BUNDLE_DIR, 'bridge-hub.exe'))
        count += 1
        for fn in BUNDLE_FILES:
            p = os.path.join(REPO_DIR, BUNDLE_DIR, fn)
            if not os.path.isfile(p):
                print('warning: missing file: {0}'.format(p))
                continue
            z.write(p, os.path.join(BUNDLE_DIR, fn))
            count += 1
    print('built: {0} ({1} files)'.format(out, count))
    # 自己インストール型の単体 exe も同じ download/ に置く
    # （AI 設定の「ハブをインストール」ボタンが直接 DL する配布物）
    exe_out = os.path.join(os.path.dirname(out), 'bridge-hub.exe')
    shutil.copyfile(EXE, exe_out)
    print('built: {0}'.format(exe_out))
    return out


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    build(
        os.path.abspath(args[0]) if args else DEFAULT_OUT,
        cargo='--no-build' not in sys.argv,
    )
