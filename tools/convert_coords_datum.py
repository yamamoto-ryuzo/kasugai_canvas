#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""国土地理院の座標変換パラメータ・ファイル（.par）を
KASUGAI Canvas web/shared/ 用のバイナリ (coords-datum-*.bin) に変換する。

用途:
  - TKY2JGD.par Ver.2.1.2 (日本測地系 <-> 世界測地系)
      https://www.gsi.go.jp/sokuchikijun/tky2jgd_download.html から取得
  - touhokutaiheiyouoki2011.par Ver.4.0.0 (PatchJGD: 測地成果2000 <-> 測地成果2011)
      https://www.gsi.go.jp/sokuchikijun/sokuchikijun41012.html から取得

出力バイナリ形式:
  ヘッダ: magic "KCDP" (4B) + version u32le(=1) + count u32le
  本体  : meshcode u32le[count] (昇順) + dB f32le[count] + dL f32le[count]
  meshcode は TKY2JGD/PatchJGD の8桁メッシュコード、dB/dL は秒単位の補正量。

使い方:
  python tools/convert_coords_datum.py <in.par> <out.bin>

データは国土地理院コンテンツ利用規約に基づき利用。
"""
import struct
import sys


def convert(par_path: str, bin_path: str) -> None:
    rows = []
    with open(par_path, "rb") as f:
        for raw in f:
            # データ行は先頭8桁が数字
            if len(raw) < 9 or not raw[:8].isdigit():
                continue
            parts = raw.split()
            if len(parts) < 3:
                continue
            try:
                code = int(parts[0])
                db = float(parts[1])
                dl = float(parts[2])
            except ValueError:
                continue
            rows.append((code, db, dl))
    rows.sort(key=lambda r: r[0])
    n = len(rows)
    if n == 0:
        raise SystemExit(f"no data rows parsed from {par_path}")
    with open(bin_path, "wb") as f:
        f.write(b"KCDP")
        f.write(struct.pack("<II", 1, n))
        f.write(struct.pack(f"<{n}I", *[r[0] for r in rows]))
        f.write(struct.pack(f"<{n}f", *[r[1] for r in rows]))
        f.write(struct.pack(f"<{n}f", *[r[2] for r in rows]))
    print(f"{par_path} -> {bin_path}: {n} nodes")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    convert(sys.argv[1], sys.argv[2])
