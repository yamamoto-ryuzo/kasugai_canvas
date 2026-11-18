from qgis.core import (QgsProject, QgsPalLayerSettings, QgsProperty, QgsReadWriteContext)
from qgis.PyQt.QtXml import QDomDocument
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="行政区域"][0]
lab = lyr.labeling()
pal = QgsPalLayerSettings(lab.settings()) if hasattr(lab,'settings') else QgsPalLayerSettings()
pal.dataDefinedProperties().setProperty(QgsPalLayerSettings.Size, QgsProperty.fromExpression('"size_f" * 2'))
pal.dataDefinedProperties().setProperty(QgsPalLayerSettings.Family, QgsProperty.fromField('font_f'))
pal.dataDefinedProperties().setProperty(QgsPalLayerSettings.Color, QgsProperty.fromExpression('ramp_color(\'Spectral\',$scale)'))
if hasattr(lab, 'setSettings'):
    lab.setSettings(pal)
doc = QDomDocument("s")
lyr.exportNamedStyle(doc, QgsReadWriteContext())
x = doc.toString()
import re
m = re.search(r'<data-defined>.*?</data-defined>', x, re.S)
result = {"dd": m.group(0)[:2500] if m else "NONE", "has_setsettings": hasattr(lab,'setSettings')}
