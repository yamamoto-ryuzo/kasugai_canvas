# -*- coding: utf-8 -*-
"""QGIS 実機でテスト GeoJSON+QML を描画してキャンバスをスクリーンショット。
KASUGAI Canvas 各エンジンの shots/*.png と見比べるための正解画像を作る。
実行: python verify_qgis.py
"""
import json
import os
import sys

sys.path.insert(0, r"C:\devin\qgis_live_harness\test-results\ai-chat")
from run_tool import submit, pyeval  # noqa: E402

D = r"C:\devin\kasugai_canvas\test-results\qml-verify"
SHOTS = os.path.join(D, "shots")

LAYERS = [
    ("trim_line",   "trim_line.geojson",   "trim_line.qml"),
    ("notrim_ref",  "trim_line.geojson",   "notrim_line.qml"),
    ("dash_line",   "dash_line.geojson",   "dash_line.qml"),
    ("glow_line",   "glow_line.geojson",   "glow_line.qml"),
    ("width_test",  "width_test.geojson",  "width_test.qml"),
    ("style_test",  "style_test.geojson",  "style_test.qml"),
    ("fill_test",   "fill_test.geojson",   "fill_test.qml"),
    ("label_test",  "label_test.geojson",  "label_test.qml"),
]

# 1) 既存レイヤを全て非表示にして、テストレイヤを追加→範囲フィット
setup = r"""
import json as _j, os as _os, time as _t
from qgis.core import (QgsProject, QgsVectorLayer, QgsRectangle,
                       QgsCoordinateReferenceSystem, QgsCoordinateTransform)
from qgis.utils import iface
from qgis.PyQt.QtWidgets import QApplication

D = r'%D%'
LAYERS = %LAYERS%
proj = QgsProject.instance()
root = proj.layerTreeRoot()

_vis = {}
for tn in root.findLayers():
    _vis[tn.layerId()] = tn.itemVisibilityChecked()
    tn.setItemVisibilityChecked(False)
open(_os.path.join(D, 'shots', '_prev_vis.json'), 'w').write(
    _j.dumps(_vis))

created = []
results = {}
for name, gj, qml in LAYERS:
    ly = QgsVectorLayer(_os.path.join(D, 'DATA', gj), 'qv_' + name, 'ogr')
    ok = ly.isValid()
    if ok:
        try:
            msg = ly.loadNamedStyle(_os.path.join(D, 'DATA', qml))
        except Exception as e:
            msg = ('EXC:' + str(e), False)
        proj.addMapLayer(ly)
        created.append(ly.id())
        results[name] = list(msg)
        # レイヤ可視状態を明示
        root.findLayer(ly.id()).setItemVisibilityChecked(True)
open(_os.path.join(D, 'shots', '_created.json'), 'w').write(
    _j.dumps(created))

cv = iface.mapCanvas()
r4326 = QgsRectangle(139.42, 35.42, 139.90, 35.80)
crs_dest = cv.mapSettings().destinationCrs()
if crs_dest != QgsCoordinateReferenceSystem('EPSG:4326'):
    tr = QgsCoordinateTransform(
        QgsCoordinateReferenceSystem('EPSG:4326'), crs_dest, proj)
    r4326 = tr.transformBoundingBox(r4326)
cv.setExtent(r4326)
cv.refreshAllLayers()
cv.refresh()
for _ in range(50):
    QApplication.processEvents()
    _t.sleep(0.1)
result = {'created': len(created), 'styles': results,
          'extent': cv.extent().toString(),
          'crs': crs_dest.authid(),
          'size': [cv.width(), cv.height()]}
""".replace("%D%", D).replace("%LAYERS%", json.dumps(LAYERS))

rep = pyeval(setup, timeout=90)
print("setup:", json.dumps(rep.get("result") or rep, ensure_ascii=False)[:800])

# 2) スクリーンショット(レンダリング完了を待ってから)
rep = pyeval(r"""
from qgis.utils import iface
from qgis.PyQt.QtWidgets import QApplication
import time as _t
cv = iface.mapCanvas()
for _ in range(40):
    QApplication.processEvents()
    _t.sleep(0.1)
result = {'ok': True}
""", timeout=30)
print("wait:", rep.get("result") or rep)

p = os.path.join(SHOTS, "qgis_canvas.png")
rep = submit({"type": "screenshot", "path": p, "target": "canvas"}, timeout=30)
print("shot ->", rep.get("result") or rep)

# 3) 後片付け: テストレイヤ削除 + 可視性復元
cleanup = r"""
import json as _j, os as _os
from qgis.core import QgsProject
D = r'%D%'
proj = QgsProject.instance()
created = _j.loads(open(_os.path.join(D, 'shots', '_created.json')).read())
for lid in created:
    proj.removeMapLayer(lid)
vis = _j.loads(open(_os.path.join(D, 'shots', '_prev_vis.json')).read())
root = proj.layerTreeRoot()
for tn in root.findLayers():
    if tn.layerId() in vis:
        tn.setItemVisibilityChecked(bool(vis[tn.layerId()]))
result = {'removed': len(created), 'restored': len(vis)}
""".replace("%D%", D)
rep = pyeval(cleanup, timeout=60)
print("cleanup:", rep.get("result") or rep)
