from qgis.core import QgsProject, QgsReadWriteContext, QgsProperty, QgsSymbolLayer
from qgis.PyQt.QtXml import QDomDocument
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="行政区域"][0]
doc = QDomDocument("s")
lyr.exportNamedStyle(doc, QgsReadWriteContext())
x = doc.toString()
import re
out = {}
m = re.search(r'<dd_properties>.*?</dd_properties>', x, re.S)
out["dd_properties_label"] = m.group(0)[:2000] if m else None
i = x.find('<dd_properties')
out["ctx"] = x[max(0,i-300):i+50]
# シンボルレイヤのDD実例を作る
sym = lyr.renderer().symbol()
sl = sym.symbolLayer(0)
sl.dataDefinedProperties().setProperty(QgsSymbolLayer.PropertyFillColor, QgsProperty.fromExpression('"col_f"'))
sl.dataDefinedProperties().setProperty(QgsSymbolLayer.PropertyStrokeWidth, QgsProperty.fromField('w_f'))
doc2 = QDomDocument("s2")
lyr.exportNamedStyle(doc2, QgsReadWriteContext())
x2 = doc2.toString()
m2 = re.search(r'<layer class="SimpleFill".*?</layer>', x2, re.S)
seg = m2.group(0) if m2 else ""
m3 = re.search(r'<data_defined_properties>.*?</data_defined_properties>', seg, re.S)
out["symbol_dd"] = (m3.group(0)[:2500] if m3 else seg[-2500:])
result = out
