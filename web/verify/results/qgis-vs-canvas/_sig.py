from qgis.core import QgsRuleBasedRenderer
R = QgsRuleBasedRenderer.Rule
out = []
try:
    r = R(None, "\"cat\"='A'")
    out.append('str-ok')
except Exception as e: out.append('str:'+str(e)[:80])
try:
    r = R(None)
    r.setFilterExpression("\"cat\"='A'")
    out.append('setFilterExpression-ok')
except Exception as e: out.append('sfe:'+str(e)[:80])
try:
    r = R(None)
    out.append([m for m in dir(r) if 'ilter' in m or 'cale' in m].__repr__())
except Exception as e: out.append(str(e))
result = ' | '.join(out)
