from qgis.core import QgsProject
from qgis.PyQt.QtXml import QDomDocument
from qgis.core import QgsReadWriteContext
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="DM_3"][0]
ren = lyr.renderer()
r0 = ren.rootRule().children()[0]
r0.setActive(False)
doc2 = QDomDocument("s2")
lyr.exportNamedStyle(doc2, QgsReadWriteContext())
x2 = doc2.toString()
import re
m = re.search(r'<rule [^>]*>', x2)
result = {"first_rule": m.group(0) if m else "NONE", "active": r0.active()}
