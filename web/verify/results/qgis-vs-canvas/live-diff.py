#!/usr/bin/env python
# live-diff.py — live-qgis-<eng>-<layer>.png と live-canvas-<eng>-<layer>.png の
# ペアを機械比較する。白背景(NOBASE=1)前提で非白率を算出し、
# QGIS 有・Canvas 無 = 未対応 / Canvas 過剰 = 誤描画 の機械判定を補助する。
# usage: python live-diff.py <engine> [engine2 ...]
import sys, glob, os
from PIL import Image, ImageChops

OUT = os.path.dirname(os.path.abspath(__file__))
WHITE = 245  # RGB各チャネルがこれ未満なら非白

def nonwhite(path):
    im = Image.open(path).convert("RGB")
    px = im.getdata()
    n = sum(1 for p in px if p[0] < WHITE or p[1] < WHITE or p[2] < WHITE)
    return n / (im.width * im.height)

def diff_ratio(a, b):
    ia = Image.open(a).convert("L")
    ib = Image.open(b).convert("L").resize(ia.size)
    d = ImageChops.difference(ia, ib)
    px = d.getdata()
    return sum(1 for p in px if p > 40) / (ia.width * ia.height)

def main(engines):
    rows = []
    for eng in engines:
        for cp in sorted(glob.glob(os.path.join(OUT, f"live-canvas-{eng}-*.png"))):
            leaf = os.path.basename(cp)[len(f"live-canvas-{eng}-"):-4]
            qp = os.path.join(OUT, f"live-qgis-{eng}-{leaf}.png")
            if not os.path.exists(qp):
                rows.append((eng, leaf, None, None, None, "no-qgis-pair"))
                continue
            q = nonwhite(qp); c = nonwhite(cp)
            dr = diff_ratio(qp, cp)
            # 判定
            if q < 0.0005 and c < 0.0005:
                verdict = "BOTH-BLANK(一致)"      # QGIS も無描画(nullSymbol/マスク系)
            elif q < 0.0005 <= c:
                verdict = "CANVAS-OVERDRAW?"      # QGIS 無描画だが Canvas が描画
            elif c < 0.0005 <= q:
                verdict = "CANVAS-BLANK(未対応?)" # QGIS 描画あるのに Canvas 白
            elif c < q * 0.35:
                verdict = "THIN(描画不足?)"
            elif c > q * 2.5:
                verdict = "HEAVY(過剰?)"
            else:
                verdict = "DRAWN"
            rows.append((eng, leaf, q, c, dr, verdict))
    print(f"{'engine':10} {'layer':38} {'qgis%':>7} {'canvas%':>7} {'diff%':>7}  verdict")
    for eng, leaf, q, c, dr, v in rows:
        qs = f"{q*100:6.2f}" if q is not None else "  ----"
        cs = f"{c*100:6.2f}" if c is not None else "  ----"
        ds = f"{dr*100:6.2f}" if dr is not None else "  ----"
        print(f"{eng:10} {leaf:38} {qs} {cs} {ds}  {v}")
    bad = [r for r in rows if r[5] not in ("DRAWN", "BOTH-BLANK(一致)", "no-qgis-pair")]
    print(f"==== {len(rows)-len(bad)}/{len(rows)} machine-OK ====")

if __name__ == "__main__":
    main(sys.argv[1:] or ["cesium"])
