# 実機QGISからQML定義を網羅ダンプ。pyeval経由で実行し dump.json を出力する。
import json, os
from qgis.PyQt.QtXml import QDomDocument
from qgis.PyQt.QtCore import QMetaEnum
from qgis.core import (
    QgsProject, QgsApplication, QgsSymbolLayerRegistry,
    QgsSymbolLayer, QgsPalLayerSettings, QgsUnitTypes,
    QgsSymbol, QgsMarkerSymbol, QgsLineSymbol, QgsFillSymbol,
    QgsVectorLayer, QgsWkbTypes, QgsFeatureRenderer,
)

OUT = "C:/devin/kasugai_canvas/test-results/qml-spec"
os.makedirs(OUT + "/layers", exist_ok=True)
res = {"qgis_version": None}
try:
    from qgis.core import Qgis
    res["qgis_version"] = Qgis.QGIS_VERSION
except Exception:
    pass

def enum_members(cls):
    """enumクラスのメンバ名->値"""
    out = {}
    for n in dir(cls):
        if n.startswith("_"):
            continue
        try:
            v = getattr(cls, n)
        except Exception:
            continue
        if isinstance(v, int):
            out[n] = v
    return out

# 1) RenderUnit / WkbTypes 等の enum
res["RenderUnit"] = enum_members(QgsUnitTypes.RenderUnit)
res["SymbolType"] = enum_members(Qgis.SymbolType) if hasattr(Qgis, "SymbolType") else enum_members(QgsSymbol.SymbolType)

# 2) シンボルレイヤ全クラス: 既定プロパティキー + DD property名
reg = QgsApplication.instance().symbolLayerRegistry() if QgsApplication.instance() else QgsSymbolLayerRegistry()
slyr = {}
for cls in sorted(reg.symbolLayersForType(Qgis.SymbolType.Marker) + reg.symbolLayersForType(Qgis.SymbolType.Line) + reg.symbolLayersForType(Qgis.SymbolType.Fill) + reg.symbolLayersForType(Qgis.SymbolType.Hybrid)):
    meta = reg.symbolLayerMetadata(cls)
    if not meta:
        continue
    try:
        lyr = meta.createSymbolLayer({})
    except Exception as e:
        slyr[cls] = {"error": str(e)}
        continue
    entry = {"type": meta.type() if hasattr(meta, "type") else None,
             "visibleName": meta.visibleName() if hasattr(meta, "visibleName") else None,
             "props": sorted(lyr.properties().keys())}
    # DD property definitions (int -> QgsPropertyDefinition)
    try:
        defs = lyr.propertyDefinitions()
        entry["dd"] = {str(k): {"name": d.name(), "description": d.description()}
                       for k, d in sorted(defs.items())}
    except Exception as e:
        entry["dd_error"] = str(e)
    slyr[cls] = entry
res["symbol_layers"] = slyr

# 3) QgsSymbolLayer.Property enum + 共通 propertyDefinitions
res["QgsSymbolLayer_Property_enum"] = enum_members(QgsSymbolLayer.Property)
try:
    base = QgsMarkerSymbol.createSimple({}).symbolLayer(0)
    res["symbol_layer_base_dd"] = {str(k): d.name() for k, d in sorted(base.propertyDefinitions().items())}
except Exception as e:
    res["symbol_layer_base_dd_error"] = str(e)

# 4) QgsPalLayerSettings: Property enum + 既定settings/text-style XML属性名
res["QgsPalLayerSettings_Property_enum"] = enum_members(QgsPalLayerSettings.Property)
try:
    res["QgsPalLayerSettings_Property_names"] = {str(int(getattr(QgsPalLayerSettings.Property, n))): n
        for n in dir(QgsPalLayerSettings.Property) if not n.startswith("_") and isinstance(getattr(QgsPalLayerSettings.Property, n), QgsPalLayerSettings.Property)}
except Exception:
    pass

# 既定QgsPalLayerSettingsをwriteXmlして属性名を全列挙
doc = QDomDocument("x")
pal = QgsPalLayerSettings()
el = pal.writeXml(doc, QgsReadWriteContext()) if False else None
try:
    from qgis.core import QgsReadWriteContext
    el = pal.writeXml(doc, QgsReadWriteContext())
    doc.appendChild(el)
    xml = doc.toString()
    res["default_pal_xml"] = xml
    import re
    res["pal_settings_attrs"] = sorted(set(re.findall(r'(\w+)="', xml.split("<settings")[1].split("/>")[0])) ) if "<settings" in xml else []
    m = re.search(r'<text-style ([^>]+)', xml)
    res["pal_textstyle_attrs"] = sorted(set(re.findall(r'(\w+)=', m.group(1)))) if m else []
    m = re.search(r'<data-defined>(.*?)</data-defined>', xml, re.S)
    res["pal_dd_tags"] = sorted(set(re.findall(r'<(\w+)', m.group(1)))) if m else []
    m = re.search(r'<callout ([^>]*)>', xml)
    res["pal_callout_attrs"] = sorted(set(re.findall(r'(\w+)=', m.group(1)))) if m else []
except Exception as e:
    res["pal_xml_error"] = str(e)

# DD設定済みのpalをwriteXmlして <data-defined> のXML形式を取得
try:
    from qgis.core import QgsReadWriteContext, QgsProperty
    pal2 = QgsPalLayerSettings()
    pal2.fieldName = "name"
    pal2.enabled = True
    dp = pal2.dataDefinedProperties()
    dp.setProperty(QgsPalLayerSettings.Size, QgsProperty.fromExpression('"size_f" * 2'))
    dp.setProperty(QgsPalLayerSettings.Family, QgsProperty.fromField('font_f'))
    dp.setProperty(QgsPalLayerSettings.Color, QgsProperty.fromExpression('ramp_color(\'Spectral\',$scale)'))
    pal2.setDataDefinedProperties(dp)
    doc3 = QDomDocument("x2")
    el3 = pal2.writeXml(doc3, QgsReadWriteContext())
    doc3.appendChild(el3)
    xml3 = doc3.toString()
    res["pal_dd_xml_sample"] = xml3
    m = re.search(r'<data-defined>(.*?)</data-defined>', xml3, re.S)
    res["pal_dd_tags"] = sorted(set(re.findall(r'<(\w+)', m.group(1)))) if m else []
except Exception as e:
    res["pal_dd_error"] = str(e)

# 5) レンダラクラス一覧
try:
    reg2 = QgsApplication.instance().rendererRegistry()
    res["renderers"] = sorted(reg2.renderersList())
except Exception as e:
    res["renderers_error"] = str(e)

# 6) QgsProperty の dd Map 内で使われる Option 名(static部分)
res["QgsProperty_field_names"] = ["active", "expression", "field", "type", "useExpr"]

# 7) 実プロジェクト内ベクタレイヤの完全QML XMLを保存
layer_list = []
for lyr in QgsProject.instance().mapLayers().values():
    info = {"name": lyr.name(), "id": lyr.id(), "type": int(lyr.type()),
            "provider": lyr.dataProvider().name() if lyr.dataProvider() else None}
    if isinstance(lyr, QgsVectorLayer):
        info["wkb"] = QgsWkbTypes.displayString(lyr.wkbType())
        info["renderer_type"] = lyr.renderer().type() if lyr.renderer() else None
        info["labeling_type"] = lyr.labeling().type() if lyr.labeling() else None
        try:
            from qgis.core import QgsReadWriteContext as _ctx
            doc2 = QDomDocument("style")
            r = lyr.exportNamedStyle(doc2, _ctx())
            fname = os.path.join(OUT, "layers", lyr.name().replace("/", "_").replace("\\", "_") + ".qml")
            with open(fname, "w", encoding="utf-8") as f:
                f.write(doc2.toString())
            info["qml_file"] = fname
            info["qml_result"] = str(r)
        except Exception as e:
            info["qml_error"] = str(e)
    layer_list.append(info)
res["project_layers"] = layer_list

with open(os.path.join(OUT, "dump.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)

result = {"version": res["qgis_version"],
          "symbol_layers": len(slyr),
          "layers_saved": sum(1 for x in layer_list if x.get("qml_file")),
          "out": OUT}
