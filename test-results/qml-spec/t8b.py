from qgis.core import QgsApplication, QgsProject, QgsPalLayerSettings
from qgis.PyQt.QtXml import QDomDocument
from qgis.core import QgsReadWriteContext
out = {}
reg = QgsApplication.instance().symbolLayerRegistry()
ml = reg.symbolLayerMetadata("MarkerLine").createSymbolLayer({})
out["markerline_props"] = dict(ml.properties())
hl = reg.symbolLayerMetadata("HashLine").createSymbolLayer({})
out["hashline_sel"] = {k: v for k, v in hl.properties().items() if "rotate" in k or "placement" in k or "hash" in k}
gg = reg.symbolLayerMetadata("GeometryGenerator").createSymbolLayer({})
out["gg_props"] = dict(gg.properties())
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="DM_3"][0]
ren = lyr.renderer()
r0 = ren.rootRule().children()[0]
out["rule_methods"] = [m for m in dir(r0) if not m.startswith("_")]
pal = QgsPalLayerSettings()
pal.fieldName="x"; pal.enabled=True
doc3 = QDomDocument("s")
e3 = pal.writeXml(doc3, QgsReadWriteContext())
doc3.appendChild(e3)
x3 = doc3.toString()
import re
m = re.search(r'<substitutions.*?(?:/>|</substitutions>)', x3, re.S)
out["substitutions_xml"] = m.group(0)[:800] if m else "NONE"
result = out
