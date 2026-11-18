from qgis.core import QgsProject, QgsReadWriteContext
from qgis.PyQt.QtXml import QDomDocument
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="行政区域"][0]
doc = QDomDocument("s")
lyr.exportNamedStyle(doc, QgsReadWriteContext())
x = doc.toString()
import re
out = {}
for pat in ['size_f', 'font_f', 'Spectral', 'data-defined']:
    i = x.find(pat)
    out[pat] = x[max(0,i-200):i+300] if i>=0 else "NOTFOUND"
result = out
