#!/usr/bin/env python3
"""KASUGAI Canvas vendor fetcher.

web/ 配下の各エンジンが持つ vendor.json を読み、上流スナップショットを
web/vendor/ へ配置する。kasugai-canvas-web への publish 時にも
publish_cdn.py から呼ばれ、発行物へ実ファイルとして含まれる
(GitHub Pages は submodule を解決しないため実ファイル必須)。

レイアウト:
    web/gsimaps/vendor.json   上流ピン情報(repo/ref/sha)
    web/vendor/gsimaps/       スナップショット実体(gitignore・正本は上流)
    web/vendor/gsimaps/VENDOR.json  取得済み sha の記録(整合確認用)

usage:
    python tools/fetch_vendor.py            # 全 vendor.json を処理
    python tools/fetch_vendor.py --force    # sha が一致していても取り直す
"""

import argparse
import io
import json
import os
import shutil
import sys
import tarfile
import urllib.request

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(REPO_DIR, 'web')
VENDOR_ROOT = os.path.join(WEB_DIR, 'vendor')


def _find_vendor_specs(web_dir):
    """web/ 配下の vendor.json を列挙する。"""
    specs = []
    for entry in sorted(os.listdir(web_dir)):
        path = os.path.join(web_dir, entry, 'vendor.json')
        if os.path.isfile(path):
            specs.append(path)
    return specs


def _read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def _current_sha(vendor_dir):
    marker = os.path.join(vendor_dir, 'VENDOR.json')
    try:
        return _read_json(marker).get('sha')
    except (OSError, ValueError):
        return None


def fetch_vendor(spec_path, force=False):
    """vendor.json 1件分のスナップショットを取得・配置する。"""
    spec = _read_json(spec_path)
    name = spec.get('name') or os.path.basename(os.path.dirname(spec_path))
    repo = spec['repo']
    ref = spec.get('ref') or 'HEAD'
    sha = spec.get('sha') or ref
    vendor_dir = os.path.normpath(
        os.path.join(os.path.dirname(spec_path),
                     spec.get('vendorDir', os.path.join('..', 'vendor', name))))

    if not force and _current_sha(vendor_dir) == sha and os.path.isdir(vendor_dir):
        print('{0}: already at {1} (skip)'.format(name, sha[:8]))
        return vendor_dir

    url = 'https://github.com/{0}/archive/{1}.tar.gz'.format(repo, sha)
    print('{0}: fetching {1}'.format(name, url))
    req = urllib.request.Request(url, headers={'User-Agent': 'kasugai-canvas'})
    with urllib.request.urlopen(req, timeout=300) as res:
        payload = res.read()

    tmp = vendor_dir + '.tmp'
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    os.makedirs(tmp)
    # tarball の先頭階層(<repo>-<sha>/)を剥がして展開
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as tf:
        members = tf.getmembers()
        for m in members:
            parts = m.name.split('/', 1)
            if len(parts) < 2 or not parts[1]:
                continue
            m.name = parts[1]
            tf.extract(m, tmp)
    if os.path.isdir(vendor_dir):
        shutil.rmtree(vendor_dir)
    os.replace(tmp, vendor_dir)

    with open(os.path.join(vendor_dir, 'VENDOR.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': name, 'repo': repo, 'ref': ref, 'sha': sha},
                  f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('{0}: installed {1} -> {2}'.format(name, sha[:8], vendor_dir))
    return vendor_dir


def ensure_vendors(web_dir=WEB_DIR, force=False):
    """全 vendor.json を処理する。publish 前の整合保証にも使う。"""
    dirs = []
    for spec in _find_vendor_specs(web_dir):
        dirs.append(fetch_vendor(spec, force=force))
    return dirs


def main():
    ap = argparse.ArgumentParser(description='fetch vendored upstream snapshots')
    ap.add_argument('--force', action='store_true',
                    help='sha 一致でも取り直す')
    args = ap.parse_args()
    specs = _find_vendor_specs(WEB_DIR)
    if not specs:
        print('no vendor.json found under web/')
        return 0
    try:
        ensure_vendors(force=args.force)
    except Exception as e:
        print('fetch_vendor failed: {0}'.format(e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
