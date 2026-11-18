from qgis.core import QgsPalLayerSettings, QgsProperty
from qgis.PyQt.QtXml import QDomDocument
from qgis.core import QgsReadWriteContext
pal2 = QgsPalLayerSettings()
pal2.fieldName = "name"; pal2.enabled = True
pal2.dataDefinedProperties().setProperty(QgsPalLayerSettings.Size, QgsProperty.fromExpression('"size_f" * 2'))
pal2.dataDefinedProperties().setProperty(QgsPalLayerSettings.Family, QgsProperty.fromField('font_f'))
doc3 = QDomDocument("x2")
el3 = pal2.writeXml(doc3, QgsReadWriteContext())
doc3.appendChild(el3)
x = doc3.toString()
import re
# data-defined 以外の可能性: Option/Map形式で書かれる?
idx = [m.start() for m in re.finditer(r'data', x)]
segs = [x[max(0,i-30):i+80] for i in idx]
result = {"n": len(x), "hits": segs[:10], "tail": x[-800:]}
