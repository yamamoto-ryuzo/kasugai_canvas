#!/usr/bin/env python3
"""KASUGAI Canvas CDN publisher (kasugai-canvas-web).

kasugai_canvas の web/ を CDN リポジトリ(kasugai-canvas-web)の
ステージへ同期する。web/ は相対パス構成済みのため単純コピーでよい
(旧来のルート絶対参照書き換えは不要になった)。

レイアウト:
    <cdn>/unstable/     web/ の同期先(開発版。version.json を付与)
    <cdn>/stable/       web/ の同期先(安定版。version.json を付与)
    <cdn>/index.html    stable/ へのリダイレクト(静的・更新不要)
    <cdn>/channels.json 各ステージの現在バージョン

    --channel はコピー先のステージを選ぶだけで、どちらも web/ を直接同期する
    (stable への格上げに unstable 同期を先行させる必要はない)

usage:
    python tools/publish_cdn.py [cdn_repo_dir] --channel unstable
    python tools/publish_cdn.py [cdn_repo_dir] --channel stable
    python tools/publish_cdn.py [cdn_repo_dir] --channel unstable --commit --push
    python tools/publish_cdn.py [cdn_repo_dir] --channel stable --vendor
        # vendor/ も同期(vendor.json の sha 更新時など。既定は web/ 本体のみ)

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


def _replace_dir(src, dst, exclude=()):
    # exclude のエントリは dst 側に残したまま、それ以外を src と一致させる
    # (mirror 同期。vendor のような別管理ディレクトリを温存するため)
    os.makedirs(dst, exist_ok=True)
    for entry in os.listdir(dst):
        if entry in exclude:
            continue
        p = os.path.join(dst, entry)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.remove(p)
    for entry in sorted(os.listdir(src)):
        if entry in exclude:
            continue
        s = os.path.join(src, entry)
        d = os.path.join(dst, entry)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)


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


def _sync_vendors(stage, apply=False):
    """vendor の CDN ステージとの sha 差分を報告し、apply 時のみ同期する。

    vendor(約75MB)の更新は手動運用が基本。発行のたび自動取得はせず、
    ステージ側の VENDOR.json sha と vendor.json の pin を比較して
    差異・欠落があれば警告するだけにし、--vendor 指定時だけ
    fetch_vendor で取得して反映する
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import fetch_vendor
    for spec_path in fetch_vendor._find_vendor_specs(WEB_DIR):
        spec = fetch_vendor._read_json(spec_path)
        name = spec.get('name') or os.path.basename(os.path.dirname(spec_path))
        sha = spec.get('sha') or spec.get('ref') or 'HEAD'
        dst = os.path.join(stage, 'vendor', name)
        cur = fetch_vendor._current_sha(dst) if os.path.isdir(dst) else None
        if cur == sha:
            print('vendor {0}: channel already at {1} (skip)'.format(
                name, sha[:8]))
            continue
        if not apply:
            print('vendor {0}: pin {1} != channel {2}'
                  ' (--vendor で同期)'.format(
                      name, sha[:8], (cur[:8] if cur else 'missing')))
            continue
        src = fetch_vendor.fetch_vendor(spec_path)
        _replace_dir(src, dst)


def sync_channel(cdn_dir, channel, vendor=False):
    """web/ を指定ステージへ直接同期する。"""
    stage = os.path.join(cdn_dir, channel)
    # ブリッジハブ配布 ZIP を生成して web/download/ に入れておく
    # (CDN 配信版の AI 設定から単品ダウンロードできるようにするため)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_bridge_zip
    build_bridge_zip.build()
    # vendor は別管理(手動・--vendor 指定時のみ同期)のため
    # web/ 全量コピーから除外
    _replace_dir(WEB_DIR, stage, exclude=('vendor', 'projects'))
    _sync_vendors(stage, apply=vendor)
    version = _cargo_version()
    _write_version_json(stage, {
        'version': version,
        'channel': channel,
        'source_repo': SOURCE_REPO,
        'source_branch': 'main',
    })
    _update_channels(cdn_dir, channel, version)
    return version, 'Sync web/ to {0} (v{1})'.format(channel, version)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('cdn_dir', nargs='?', default=DEFAULT_CDN_DIR,
                   help='kasugai-canvas-web リポジトリのパス'
                        ' (default: %(default)s)')
    p.add_argument('--channel', required=True, choices=CHANNELS,
                   help='同期先ステージ(unstable=開発版 / stable=安定版)。'
                        'どちらも web/ を直接コピーする')
    p.add_argument('--commit', action='store_true',
                   help='CDN リポジトリで変更をコミットする')
    p.add_argument('--push', action='store_true',
                   help='コミット後に push する(--commit 必須)')
    p.add_argument('--vendor', action='store_true',
                   help='vendor/ も sha 差分時に fetch_vendor で取得して'
                        '同期する(既定は web/ 本体のみ。vendor 更新は手動)')
    args = p.parse_args()

    cdn_dir = os.path.abspath(args.cdn_dir)
    if not os.path.isdir(cdn_dir):
        p.error('cdn_dir が存在しません: {0}'.format(cdn_dir))
    if args.push and not args.commit:
        p.error('--push は --commit と併用してください')

    version, message = sync_channel(cdn_dir, args.channel,
                                    vendor=args.vendor)
    print('{0}: v{1} -> {2}'.format(args.channel, version, cdn_dir))

    if args.commit:
        _commit_and_push(cdn_dir, message, args.push)
    return 0


if __name__ == '__main__':
    sys.exit(main())
