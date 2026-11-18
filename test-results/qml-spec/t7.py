from qgis.core import QgsProject, QgsReadWriteContext
from qgis.PyQt.QtXml import QDomDocument
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="行政区域"][0]
doc = QDomDocument("s")
lyr.exportNamedStyle(doc, QgsReadWriteContext())
x = doc.toString()
import re
out = []
for m in re.finditer(r'<dd_properties>.*?</dd_properties>', x, re.S):
    out.append(m.group(0))
result = {"count": len(out), "nonempty": [b for b in out if '"properties"/>' not in b]}
