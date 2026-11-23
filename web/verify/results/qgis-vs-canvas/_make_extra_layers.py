from qgis.core import *
from qgis.PyQt.QtGui import QColor, QFont
from qgis.PyQt.QtCore import Qt, QVariant
proj = QgsProject.instance()
root = proj.layerTreeRoot()
old = root.findGroup('__qmltest_extra')
if old:
    root.removeChildNode(old)
grp = root.insertGroup(1, '__qmltest_extra')
log = []

def mkgeom(wkb, name):
    return QgsVectorLayer(wkb + '?crs=EPSG:4326&field=val:double&field=name:string&field=cat:string', name, 'memory')

def add(l):
    proj.addMapLayer(l, False)
    grp.addLayer(l)

def pts(l, coords_vals):
    pr = l.dataProvider()
    for i, (x, y, v) in enumerate(coords_vals):
        f = QgsFeature(l.fields())
        f.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(x, y)))
        f.setAttribute('val', v)
        f.setAttribute('name', 'P%d' % (i + 1))
        f.setAttribute('cat', 'A' if i % 2 == 0 else 'B')
        pr.addFeature(f)
    l.updateExtents()

def lines(l, rows):
    pr = l.dataProvider()
    for i, row in enumerate(rows):
        f = QgsFeature(l.fields())
        f.setGeometry(QgsGeometry.fromPolylineXY([QgsPointXY(*p) for p in row]))
        f.setAttribute('val', i)
        f.setAttribute('name', 'L%d' % i)
        pr.addFeature(f)
    l.updateExtents()

# 1) RuleRenderer + ルール別縮尺
l = mkgeom('Point', 'qmltest2_rule')
pts(l, [(139.72 + i * 0.03, 35.70, 5 + i) for i in range(9)])
symA = QgsMarkerSymbol.createSimple({'name': 'circle', 'color': '#e41a1c', 'size': '3'})
symB = QgsMarkerSymbol.createSimple({'name': 'square', 'color': '#377eb8', 'size': '3'})
rootr = QgsRuleBasedRenderer.Rule(None)
rA = QgsRuleBasedRenderer.Rule(symA)
rA.setFilterExpression("\"cat\" = 'A'")
rA.setLabel('catA')
rB = QgsRuleBasedRenderer.Rule(symB)
rB.setFilterExpression("\"cat\" = 'B'")
rB.setLabel('catB-s20k')
rB.setMaximumScale(20000)
rootr.appendChild(rA)
rootr.appendChild(rB)
l.setRenderer(QgsRuleBasedRenderer(rootr))
add(l); log.append('rule')

# 2) nullSymbol
l = mkgeom('Point', 'qmltest2_null')
pts(l, [(139.73, 35.71 + i * 0.01, 1) for i in range(4)])
l.setRenderer(QgsNullSymbolRenderer())
add(l); log.append('null')

# 3) singleSymbol + DD(size=val式, fillColor=cat式) + レイヤ変数
l = mkgeom('Point', 'qmltest2_singleDD')
pts(l, [(139.76 + i * 0.02, 35.72, (i % 5) + 1) for i in range(8)])
sym = QgsMarkerSymbol.createSimple({'name': 'circle', 'color': '#0000ff', 'size': '2'})
sl = sym.symbolLayer(0)
try:
    PS = QgsSymbolLayer.Property
    sl.dataDefinedProperties().setProperty(PS.PropertySize, QgsProperty.fromExpression('val * 1.5'))
    sl.dataDefinedProperties().setProperty(PS.PropertyFillColor, QgsProperty.fromExpression("if(\"cat\"='A','255,0,0,255','0,200,0,255')"))
except Exception as e:
    log.append('dd-enum:' + str(e))
l.setRenderer(QgsSingleSymbolRenderer(sym))
try:
    QgsExpressionContextUtils.setLayerVariable(l, 'marker_sz', 4)
except Exception as e:
    log.append('var:' + str(e))
add(l); log.append('singleDD')

# 4) EllipseMarker
l = mkgeom('Point', 'qmltest2_ellipse')
pts(l, [(139.78 + i * 0.03, 35.70, i + 1) for i in range(5)])
el = QgsEllipseSymbolLayer()
el.setSymbolName('rectangle')
el.setSymbolWidth(4); el.setSymbolHeight(7)
el.setFillColor(QColor('#ff7f00')); el.setStrokeColor(QColor('#000000'))
el.setStrokeWidth(0.4)
sym = QgsMarkerSymbol(); sym.changeSymbolLayer(0, el)
l.setRenderer(QgsSingleSymbolRenderer(sym))
add(l); log.append('ellipse')

# 5) FontMarker
l = mkgeom('Point', 'qmltest2_font')
pts(l, [(139.80 + i * 0.03, 35.73, i + 1) for i in range(5)])
try:
    fm = QgsFontMarkerSymbolLayer('MS Gothic', 'A', 6, QColor('#984ea3'))
except Exception:
    fm = QgsFontMarkerSymbolLayer()
    fm.setFontFamily('MS Gothic'); fm.setCharacter('A'); fm.setSize(6); fm.setColor(QColor('#984ea3'))
sym = QgsMarkerSymbol(); sym.changeSymbolLayer(0, fm)
l.setRenderer(QgsSingleSymbolRenderer(sym))
add(l); log.append('font')

# 6) HashLine
l = mkgeom('LineString', 'qmltest2_hashline')
lines(l, [[(139.72, 35.70 + i * 0.02), (139.95, 35.70 + i * 0.02)] for i in range(3)])
hl = QgsHashedLineSymbolLayer()
hl.setColor(QColor('#1b9e77'))
ls = QgsLineSymbol(); ls.changeSymbolLayer(0, hl)
l.setRenderer(QgsSingleSymbolRenderer(ls))
add(l); log.append('hashline')

# 7) symbolLevels (2レイヤ線シンボル + usingSymbolLevels)
l = mkgeom('LineString', 'qmltest2_symlevel')
lines(l, [[(139.72, 35.75 + i * 0.008), (139.95, 35.75 + i * 0.008)] for i in range(3)])
ls = QgsLineSymbol()
sl0 = ls.symbolLayer(0)
sl0.setColor(QColor('#000000')); sl0.setWidth(1.6)
sl1 = QgsSimpleLineSymbolLayer(QColor('#ffff00'), 0.6)
ls.appendSymbolLayer(sl1)
l.setRenderer(QgsSingleSymbolRenderer(ls))
l.renderer().setUsingSymbolLevels(True)
add(l); log.append('symlevel')

# 8) レイヤ縮尺可視性
l = mkgeom('Point', 'qmltest2_scalevis')
pts(l, [(139.85 + i * 0.01, 35.75, i + 1) for i in range(4)])
sym = QgsMarkerSymbol.createSimple({'name': 'diamond', 'color': '#d95f02', 'size': '4'})
l.setRenderer(QgsSingleSymbolRenderer(sym))
l.setScaleBasedVisibility(True)
l.setMinimumScale(25000)
l.setMaximumScale(0)
add(l); log.append('scalevis')

# 9) ラベル付きポイント(qml-text経路)
l = mkgeom('Point', 'qmltest2_label')
pts(l, [(139.74 + i * 0.03, 35.74, i + 1) for i in range(6)])
sym = QgsMarkerSymbol.createSimple({'name': 'circle', 'color': '#e7298a', 'size': '2'})
l.setRenderer(QgsSingleSymbolRenderer(sym))
pal = QgsPalLayerSettings()
pal.fieldName = 'name'
pal.enabled = True
tf = QgsTextFormat()
tf.setSize(10)
bf = QgsTextBufferSettings(); bf.setEnabled(True); bf.setSize(1); bf.setColor(QColor('#ffffff'))
tf.setBuffer(bf)
tf.setColor(QColor('#000000'))
pal.setFormat(tf)
l.setLabeling(QgsVectorLayerSimpleLabeling(pal))
l.setLabelsEnabled(True)
add(l); log.append('label')

result = 'created=' + ','.join(log)
