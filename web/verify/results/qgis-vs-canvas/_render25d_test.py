import json,urllib.request,urllib.error
info=json.load(open('C:/Users/ryu.RYU-NOTE/.qgis-live/24068-geo_driver.json'))
CODE='''
from qgis.core import (QgsVectorLayer,QgsGeometry,QgsPointXY,QgsFeature,Qgs25DRenderer,
    QgsMapSettings,QgsMapRendererCustomPainterJob,QgsRectangle,QgsCoordinateReferenceSystem)
from qgis.PyQt.QtGui import QColor,QImage,QPainter
from qgis.PyQt.QtCore import QSize
from qgis.core import QgsExpressionContextUtils

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

def render(path):
    ms=QgsMapSettings()
    ms.setLayers([lyr])
    ms.setDestinationCrs(QgsCoordinateReferenceSystem('EPSG:4326'))
    ms.setExtent(QgsRectangle(139.70,35.68,139.99,35.73))
    ms.setOutputSize(QSize(790,840))
    ms.setBackgroundColor(QColor(255,255,255))
    img=QImage(QSize(790,840),QImage.Format.Format_ARGB32)
    img.fill(QColor(255,255,255))
    p=QPainter(img)
    job=QgsMapRendererCustomPainterJob(ms,p)
    job.start(); job.waitForFinished()
    p.end()
    img.save(path)

render('C:/devin/kasugai_canvas/web/verify/results/qgis-vs-canvas/_qgis_25d_novar.png')
result='stageA done'
'''
req=urllib.request.Request(f"http://127.0.0.1:{info['http_port']}/api/pyeval",
  data=json.dumps({'code':CODE}).encode(),
  headers={'Authorization':'Bearer '+info['token'],'Content-Type':'application/json'})
try:
    print(json.load(urllib.request.urlopen(req,timeout=120)))
except urllib.error.HTTPError as e:
    print('ERR', e.code, e.read().decode('utf-8','replace')[:2500])
