from qgis.core import QgsPalLayerSettings, QgsProperty
from qgis.PyQt.QtXml import QDomDocument
from qgis.core import QgsReadWriteContext
pal2 = QgsPalLayerSettings()
pal2.fieldName = "name"; pal2.enabled = True
pal2.dataDefinedProperties().setProperty(QgsPalLayerSettings.Size, QgsProperty.fromExpression('"size_f" * 2'))
pal2.dataDefinedProperties().setProperty(QgsPalLayerSettings.Family, QgsProperty.fromField('font_f'))
coll = pal2.dataDefinedProperties()
info = {"active": coll.hasActiveProperties(), "size_active": coll.property(QgsPalLayerSettings.Size).isActive() if coll.property(QgsPalLayerSettings.Size) else None}
doc3 = QDomDocument("x2")
el3 = pal2.writeXml(doc3, QgsReadWriteContext())
doc3.appendChild(el3)
x = doc3.toString()
import re
m = re.search(r'<data-defined>.*?</data-defined>', x, re.S)
info["dd"] = m.group(0)[:1500] if m else "NONE"
result = info
