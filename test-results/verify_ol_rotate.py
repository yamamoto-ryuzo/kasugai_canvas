"""OL エンジンの回転ジェスチャ検証（nav-tools 矩形ズームとのmodifier競合修正）。

検証内容:
  1. Ctrl+Shift+ドラッグ → 回転が変わる（矩形ズームでなく）
  2. Alt+Shift+ドラッグ → 回転が変わる（OL 標準ジェスチャ）
  3. Shift単体ドラッグ → 矩形ズームが発動する（ズーム変化）
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8510/openlayers/"
CX, CY = 640, 400


def view_state(page):
    return page.evaluate(
        "() => { const v = kascMap.getView(); return { zoom: v.getZoom(), rot: v.getRotation() }; }"
    )


def drag(page, x0, y0, x1, y1, keys=()):
    for k in keys:
        page.keyboard.down(k)
    page.mouse.move(x0, y0)
    page.mouse.down()
    page.mouse.move(x1, y1, steps=10)
    page.mouse.up()
    for k in keys:
        page.keyboard.up(k)
    page.wait_for_timeout(400)


with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel="chrome")
    except Exception:
        browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_function("() => window.kascMap && kascMap.getView()", timeout=60000)
    page.wait_for_timeout(1500)

    s0 = view_state(page)
    print("initial:", s0)

    results = {}

    # 1. Ctrl+Shift+drag → 矩形ズームを奪わない（回転もしない＝無操作）
    drag(page, CX, CY, CX + 200, CY, keys=["Control", "Shift"])
    s1 = view_state(page)
    results["ctrl_shift_not_zoomed"] = abs(s1["zoom"] - s0["zoom"]) < 0.3
    print("after Ctrl+Shift+drag:", s1, results)

    # 2. Alt+Shift+drag → rotate（中心周りの円弧ドラッグ）
    drag(page, CX + 200, CY, CX, CY + 200, keys=["Alt", "Shift"])
    s2 = view_state(page)
    results["alt_shift_rotates"] = abs(s2["rot"] - s1["rot"]) > 0.05
    print("after Alt+Shift+drag:", s2)

    # 3. plain Shift+drag → rect zoom (zoom changes, box zoom)
    drag(page, CX - 100, CY - 60, CX + 100, CY + 60, keys=["Shift"])
    s3 = view_state(page)
    results["shift_rectzooms"] = s3["zoom"] > s2["zoom"] + 0.3
    print("after Shift+drag:", s3)

    ok = all(results.values())
    print("RESULT:", "PASS" if ok else "FAIL", results)
    browser.close()
    sys.exit(0 if ok else 1)
