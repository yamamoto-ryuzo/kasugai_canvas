#!/usr/bin/env python3
"""KASUGAI Canvas CDN publisher (kasugai-canvas-web).

kasugai_canvas の web/ を CDN リポジトリ(kasugai-canvas-web)の
ステージへ同期する。web/ は相対パス構成済みのため単純コピーでよい
(旧来のルート絶対参照書き換えは不要になった)。

レイアウト:
    <cdn>/unstable/     develop の web/ 同期先(version.json を付与)
    <cdn>/stable/       検証済み unstable/ の格上げ先(再ビルドしない)
    <cdn>/latest/       stable/ へのリダイレクト(静的・更新不要)
    <cdn>/index.html    stable/ へのリダイレクト(静的・更新不要)
    <cdn>/channels.json 各ステージの現在バージョン

usage:
    python tools/publish_cdn.py [cdn_repo_dir] --channel unstable
    python tools/publish_cdn.py [cdn_repo_dir] --channel stable
    python tools/publish_cdn.py [cdn_repo_dir] --channel unstable --commit --push

    cdn_repo_dir 省略時は <kasugai_canvas>/../kasugai-canvas-web
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(REPO_DIR, 'web')
CARGO_TOML = os.path.join(REPO_DIR, 'server', 'Cargo.toml')
DEFAULT_CDN_DIR = os.path.join(os.path.dirname(REPO_DIR),
                               'kasugai-canvas-web')
SOURCE_REPO = 'yamamoto-ryuzo/kasugai_canvas'

CHANNELS = ('unstable', 'stable')


def _cargo_version():
    try:
        for line in open(CARGO_TOML, encoding='utf-8'):
            m = re.match(r'\s*version\s*=\s*"([^"]+)"', line)
            if m:
                return m.group(1)
    except OSError:
        pass
    return 'unknown'


def _read_version_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_version_json(stage_dir, data):
    path = os.path.join(stage_dir, 'version.json')
    with open(path, 'w', encoding='utf-8', newline='') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def _replace_dir(src, dst):
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def _update_channels(cdn_dir, channel, version):
    path = os.path.join(cdn_dir, 'channels.json')
    data = _read_version_json(path)  # 同じJSON読み出しで流用
    data[channel] = version
    data.setdefault('default', 'stable')
    with open(path, 'w', encoding='utf-8', newline='') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def _git(cdn_dir, *args, check=True):
    return subprocess.run(['git', '-C', cdn_dir] + list(args),
                          check=check, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


def _commit_and_push(cdn_dir, message, push):
    _git(cdn_dir, 'add', '-A')
    diff = _git(cdn_dir, 'diff', '--cached', '--quiet', check=False)
    if diff.returncode == 0:
        print('no changes to commit')
        return
    _git(cdn_dir, 'commit', '-m', message)
    print('committed: {0}'.format(message))
    if push:
        _git(cdn_dir, 'push')
        print('pushed')


def sync_unstable(cdn_dir):
    stage = os.path.join(cdn_dir, 'unstable')
    _replace_dir(WEB_DIR, stage)
    version = _cargo_version()
    _write_version_json(stage, {
        'version': version,
        'channel': 'unstable',
        'source_repo': SOURCE_REPO,
        'source_branch': 'develop',
    })
    _update_channels(cdn_dir, 'unstable', version)
    return version, 'Sync web/ from kasugai_canvas develop (v{0})'.format(version)


def sync_stable(cdn_dir):
    unstable = os.path.join(cdn_dir, 'unstable')
    if not os.path.isdir(unstable):
        raise SystemExit('error: <cdn>/unstable が無いため格上げできません。'
                         '先に --channel unstable を実行してください')
    stage = os.path.join(cdn_dir, 'stable')
    _replace_dir(unstable, stage)
    info = _read_version_json(os.path.join(stage, 'version.json'))
    info.pop('note', None)
    info['channel'] = 'stable'
    version = info.get('version', _cargo_version())
    info['version'] = version
    _write_version_json(stage, info)
    _update_channels(cdn_dir, 'stable', version)
    return version, 'Promote unstable -> stable (v{0})'.format(version)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('cdn_dir', nargs='?', default=DEFAULT_CDN_DIR,
                   help='kasugai-canvas-web リポジトリのパス'
                        ' (default: %(default)s)')
    p.add_argument('--channel', required=True, choices=CHANNELS,
                   help='unstable=develop web/ を同期 / '
                        'stable=検証済み unstable/ を格上げ')
    p.add_argument('--commit', action='store_true',
                   help='CDN リポジトリで変更をコミットする')
    p.add_argument('--push', action='store_true',
                   help='コミット後に push する(--commit 必須)')
    args = p.parse_args()

    cdn_dir = os.path.abspath(args.cdn_dir)
    if not os.path.isdir(cdn_dir):
        p.error('cdn_dir が存在しません: {0}'.format(cdn_dir))
    if args.push and not args.commit:
        p.error('--push は --commit と併用してください')

    if args.channel == 'unstable':
        version, message = sync_unstable(cdn_dir)
    else:
        version, message = sync_stable(cdn_dir)
    print('{0}: v{1} -> {2}'.format(args.channel, version, cdn_dir))

    if args.commit:
        _commit_and_push(cdn_dir, message, args.push)
    return 0


if __name__ == '__main__':
    sys.exit(main())
