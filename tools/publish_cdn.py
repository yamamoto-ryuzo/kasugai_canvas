#!/usr/bin/env python3
"""KASUGAI Canvas CDN publisher.

web/ の中身を CDN リポジトリ(kasugai-canvas-web)へバージョン付きで公開する。
エンジンはルート絶対参照(/shared/ 等)を使うため、サブパス配信
(<repo>/v<version>/leaflet/ 等)では壊れる。本スクリプトはコピー時に
既知のトップレベル参照を相対パスへ書き換え、各バージョンを自己完結にする。

出力レイアウト:
    <cdn>/v<YYYYMMDD[-N]>/   web/ の中身(書換済み)
        version.txt          semver(Cargo.toml) + 公開日時
    <cdn>/index.html         バージョン一覧(最新が先頭)
    <cdn>/latest.txt         最新バージョンのディレクトリ名

usage:
    python tools/publish_cdn.py <cdn_repo_dir> [--date YYYYMMDD]
"""

import datetime
import os
import re
import shutil
import sys

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(REPO_DIR, 'web')
CARGO_TOML = os.path.join(REPO_DIR, 'server', 'Cargo.toml')

# 書き換え対象 = web/ のトップレベル実在エントリ(/api/, /health は残す)
def _tops(web_dir):
    return [n for n in os.listdir(web_dir)
            if n not in ('api', 'health') and not n.startswith('.')]


def _cargo_version():
    try:
        for line in open(CARGO_TOML, encoding='utf-8'):
            m = re.match(r'\s*version\s*=\s*"([^"]+)"', line)
            if m:
                return m.group(1)
    except OSError:
        pass
    return 'unknown'


def _rewrite_file(path, ver_root, tops_re, is_html):
    """ファイル内の "/<top>/..." を、そのファイル位置からの相対パスに直す。

    文字列リテラルのみ対象(" ' ` の直後)。正規表現リテラル(/"/g 等)や
    url(...) は触らない — 開き括弧は正規表現リテラルと区別不能のため除外。
    """
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except (UnicodeDecodeError, OSError):
        return 0
    fdir = os.path.dirname(path)
    count = 0

    def repl(m):
        nonlocal count
        quote, relp = m.group(1), m.group(2)
        target = os.path.join(ver_root, relp.lstrip('/'))
        rel = os.path.relpath(target, fdir).replace(os.sep, '/')
        count += 1
        return quote + rel

    out = tops_re.sub(repl, text)
    if is_html:
        # ルート参照("/?engine=" や "/")をバージョンルートへ。
        # 属性コンテキスト(href= src= 等)のみ対象として
        # インラインJS内の正規表現リテラル誤爆を防ぐ
        root_rel = os.path.relpath(ver_root, fdir).replace(os.sep, '/')
        out2 = re.sub(
            r'(href|src|action|poster)=(["\'])/(?=[?\'"])',
            lambda m: m.group(1) + '=' + m.group(2) + root_rel + '/', out)
        if out2 != out:
            count += 1
        out = out2
    if count:
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(out)
    return count


def publish(cdn_dir, date_str=None):
    today = date_str or datetime.date.today().strftime('%Y%m%d')
    ver_name = 'v' + today
    n = 2
    while os.path.isdir(os.path.join(cdn_dir, ver_name)):
        ver_name = 'v{0}-{1}'.format(today, n)
        n += 1
    ver_dir = os.path.join(cdn_dir, ver_name)

    tops = _tops(WEB_DIR)
    shutil.copytree(WEB_DIR, ver_dir)

    # "/<top>/" または "/<top>" 自体を相対へ。文字列開始(" ' `)の直後のみ。
    # 対象トップ名の後は / ・終端・区切りのみ許可
    tops_re = re.compile(
        r'(["\'`])/(' + '|'.join(re.escape(t) for t in tops) +
        r')((?:/[^"\'`\)\s]*)?)')

    n_files = n_refs = 0
    for root, _dirs, files in os.walk(ver_dir):
        for name in files:
            if name.lower().endswith(('.js', '.html', '.css')):
                p = os.path.join(root, name)
                c = _rewrite_file(p, ver_dir, tops_re,
                                  name.lower().endswith('.html'))
                if c:
                    n_files += 1
                    n_refs += c

    semver = _cargo_version()
    with open(os.path.join(ver_dir, 'version.txt'), 'w',
              encoding='utf-8') as f:
        f.write('app_version={0}\npublished={1}\n'.format(
            semver, datetime.datetime.now().isoformat(timespec='seconds')))

    # バージョン一覧(ルート index.html + latest.txt)
    versions = sorted(
        (d for d in os.listdir(cdn_dir)
         if d.startswith('v') and os.path.isdir(os.path.join(cdn_dir, d))),
        reverse=True)
    meta = {}
    for d in versions:
        try:
            for line in open(os.path.join(cdn_dir, d, 'version.txt'),
                             encoding='utf-8'):
                if line.startswith('app_version='):
                    meta[d] = line.split('=', 1)[1].strip()
        except OSError:
            pass
    rows = ''.join(
        '<li><a href="{0}/">{0}</a> <small>(app {1})</small></li>'.format(
            d, meta.get(d, ''))
        for d in versions)
    with open(os.path.join(cdn_dir, 'index.html'), 'w',
              encoding='utf-8') as f:
        f.write('<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">'
                '<title>KASUGAI Canvas CDN</title></head><body>'
                '<h1>KASUGAI Canvas CDN</h1>'
                '<p>各バージョンは <code>v&lt;date&gt;/&lt;engine&gt;/</code>'
                ' 形式で配信(自己完結・相対参照済み)。'
                '<code>&lt;engine&gt;/?kasc=&lt;url&gt;</code> で任意 .kasc、'
                '<code>&lt;engine&gt;/?kasc=local</code> でローカルフォルダ。</p>'
                '<ul>' + rows + '</ul></body></html>')
    if versions:
        with open(os.path.join(cdn_dir, 'latest.txt'), 'w',
                  encoding='utf-8') as f:
            f.write(versions[0] + '\n')
        # 安定URL用 latest/ 複製(ピン留めしたくない向け。
        # 納品は不変の v<date>/ を指すのが本来の使い方)
        latest_dir = os.path.join(cdn_dir, 'latest')
        shutil.rmtree(latest_dir, ignore_errors=True)
        shutil.copytree(ver_dir, latest_dir)
    return ver_name, n_files, n_refs


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cdn_dir = sys.argv[1]
    date_str = None
    if '--date' in sys.argv:
        date_str = sys.argv[sys.argv.index('--date') + 1]
    os.makedirs(cdn_dir, exist_ok=True)
    name, nf, nr = publish(cdn_dir, date_str)
    print('published {0} ({1} files, {2} refs rewritten)'.format(name, nf, nr))
    return 0


if __name__ == '__main__':
    sys.exit(main())
