import json,urllib.request,urllib.error,time,sys
info=json.load(open('C:/Users/ryu.RYU-NOTE/.qgis-live/20980-geo_driver.json'))
def call(path, body, timeout=60):
    req=urllib.request.Request(f"http://127.0.0.1:{info['http_port']}{path}",
      data=json.dumps(body).encode(),
      headers={'Authorization':'Bearer '+info['token'],'Content-Type':'application/json'})
    try:
        return json.load(urllib.request.urlopen(req,timeout=timeout))
    except urllib.error.HTTPError as e:
        return {'error':e.read().decode('utf-8','replace')[:800]}
    except Exception as e:
        return {'error':str(e)}

# 1) 25dレイヤ作成(変数あり)+プロジェクト追加+範囲設定+非同期refresh のみ
r=call('/api/pyeval',{'code':'''
from qgis.core import (QgsProject,QgsVectorLayer,QgsGeometry,QgsPointXY,QgsFeature,
    Qgs25DRenderer,QgsRectangle,QgsCoordinateReferenceSystem,QgsExpressionContextUtils)
from qgis.PyQt.QtGui import QColor
from qgis.utils import iface
proj=QgsProject.instance()
lyr=QgsVectorLayer('Polygon?crs=epsg:4326','t25d','memory')
pr=lyr.dataProvider()
for i in range(4):
    x=139.70+i*0.08
    g=QgsGeometry.fromPolygonXY([[QgsPointXY(x,35.68),QgsPointXY(x+0.05,35.68),QgsPointXY(x+0.05,35.73),QgsPointXY(x,35.73)]])
    ft=QgsFeature(lyr.fields(),i+1); ft.setGeometry(g); pr.addFeature(ft)
lyr.updateExtents()
r25=Qgs25DRenderer()
try:
    r25.setRoofColor(QColor(200,120,60,255)); r25.setWallColor(QColor(120,80,40,255))
except Exception: pass
lyr.setRenderer(r25)
QgsExpressionContextUtils.setLayerVariable(lyr,'qgis_25d_height',0.01)
QgsExpressionContextUtils.setLayerVariable(lyr,'qgis_25d_angle',70)
proj.addMapLayer(lyr)
mc=iface.mapCanvas()
mc.setDestinationCrs(QgsCoordinateReferenceSystem('EPSG:4326'))
mc.setExtent(QgsRectangle(139.70,35.68,139.99,35.73))
mc.refresh()
result='created+refresh issued'
'''},timeout=90)
print('create:',r)
