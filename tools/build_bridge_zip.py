#!/usr/bin/env python3
"""Build web/download/bridge-hub.zip — スタンドアロン ブリッジハブ配布 ZIP。

CDN/静的配信版の AI 設定画面からダウンロードさせるための単品配布物。
bridge-hub/ と各 *-bridge/ を node_modules 抜きで ZIP 化する。
web/ 直下に置くため、CDN 同期（publish_cdn.py）にそのまま含まれる。

usage:
    python tools/build_bridge_zip.py [出力zipパス]
"""

import os
import sys
import zipfile

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO_DIR, 'web', 'download', 'bridge-hub.zip')
BUNDLES = ('bridge-hub', 'copilot-bridge', 'devin-bridge', 'antigravity-bridge')
EXCLUDE_DIRS = {'node_modules', '__pycache__'}
EXCLUDE_FILES = {'.DS_Store'}


def build(out=DEFAULT_OUT):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in BUNDLES:
            root = os.path.join(REPO_DIR, name)
            if not os.path.isdir(root):
                print('warning: missing bundle dir: {0}'.format(root))
                continue
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
                for fn in filenames:
                    if fn in EXCLUDE_FILES:
                        continue
                    p = os.path.join(dirpath, fn)
                    # ZIP 内はリポジトリルート相対（bridge-hub/... 等）
                    z.write(p, os.path.relpath(p, REPO_DIR))
                    count += 1
    print('built: {0} ({1} files)'.format(out, count))
    return out


if __name__ == '__main__':
    build(os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT)
