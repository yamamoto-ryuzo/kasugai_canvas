from qgis.core import (QgsApplication, QgsRuleBasedRenderer, QgsFillSymbol,
    QgsPalLayerSettings, QgsVectorLayer)
from qgis.PyQt.QtXml import QDomDocument
from qgis.PyQt.QtCore import Qt
from qgis.core import QgsReadWriteContext
out = {}
reg = QgsApplication.instance().symbolLayerRegistry()
ml = reg.symbolLayerMetadata("MarkerLine").createSymbolLayer({})
out["markerline_props"] = dict(ml.properties())
hl = reg.symbolLayerMetadata("HashLine").createSymbolLayer({})
out["hashline_sel"] = {k: v for k, v in hl.properties().items() if "rotate" in k or "placement" in k or "hash" in k}
gg = reg.symbolLayerMetadata("GeometryGenerator").createSymbolLayer({})
out["gg_props"] = dict(gg.properties())
# 実レイヤ(DM_3はRuleRenderer)のXMLからrule属性を拾う方が確実
from qgis.core import QgsProject
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="DM_3"][0]
doc = QDomDocument("s")
lyr.exportNamedStyle(doc, QgsReadWriteContext())
x = doc.toString()
import re
out["rule_attrs"] = sorted(set(re.findall(r'<rule ([^>]+)', x)))[:3]
# checkstate を持つルールを生成: Rule のチェック状態APIを探す
ren = lyr.renderer()
root = ren.rootRule()
r0 = root.children()[0] if root.children() else None
out["rule_methods"] = [m for m in dir(r0) if "check" in m.lower() or "state" in m.lower()]
if r0:
    r0.setCheckState(Qt.Unchecked if hasattr(Qt,'Unchecked') else 0)
    doc2 = QDomDocument("s2")
    lyr.exportNamedStyle(doc2, QgsReadWriteContext())
    x2 = doc2.toString()
    m = re.search(r'<rule [^>]*check[^>]*>', x2)
    out["rule_checkstate_xml"] = m.group(0) if m else "NONE"
    # ラベルルールも同様(labeling rules)
pal = QgsPalLayerSettings()
pal.fieldName="x"; pal.enabled=True
doc3 = QDomDocument("s")
e3 = pal.writeXml(doc3, QgsReadWriteContext())
doc3.appendChild(e3)
x3 = doc3.toString()
m = re.search(r'<substitutions.*?(?:/>|</substitutions>)', x3, re.S)
out["substitutions_xml"] = m.group(0)[:800] if m else "NONE"
result = out
