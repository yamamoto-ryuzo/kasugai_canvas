from qgis.core import QgsProject
lyr = [l for l in QgsProject.instance().mapLayers().values() if l.name()=="DM_1"][0]
lab = lyr.labeling()
root = lab.rootRule() if hasattr(lab,'rootRule') else None
out = {"type": lab.type(), "has_root": root is not None}
if root:
    ch = root.children()
    r0 = ch[0] if ch else None
    out["rule_methods"] = [m for m in dir(r0) if "activ" in m.lower() or "check" in m.lower() or "state" in m.lower() or "enabled" in m.lower()]
    if r0:
        try:
            r0.setActive(False)
            from qgis.PyQt.QtXml import QDomDocument
            from qgis.core import QgsReadWriteContext
            doc = QDomDocument("s")
            lyr.exportNamedStyle(doc, QgsReadWriteContext())
            import re
            m = re.search(r'<labeling.*?</settings', doc.toString(), re.S)
            out["labelrule"] = m.group(0)[:400] if m else doc.toString()[:400]
            r0.setActive(True)
        except Exception as e:
            out["err"] = str(e)
result = out
