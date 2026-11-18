# -*- coding: utf-8 -*-
"""qml-style.js が読む QML キーを機械抽出し、dump.json(実機 truth)と突合する監査。
出力: audit_report.md / audit_keys.json
"""
import json, re, glob, os, sys
from collections import defaultdict
import xml.etree.ElementTree as ET

BASE = r"C:\devin\kasugai_canvas"
DUMP = os.path.join(BASE, r"test-results\qml-spec\dump.json")
LAYERS_DIR = os.path.join(BASE, r"test-results\qml-spec\layers")
JS = os.path.join(BASE, r"web\shared\qml-style.js")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

d = json.load(open(DUMP, encoding="utf-8"))

# ---------- truth: symbol layer props ----------
sym_props = defaultdict(set)  # key -> classes
for cls, info in d["symbol_layers"].items():
    for k in info.get("props", []):
        sym_props[k].add(cls)
SYM_PROP_UNION = set(sym_props)

# ---------- truth: symbol DD names ----------
def dd_names(obj):
    """{int:{name,desc}} | {int:name} | [name] → set of names"""
    out = set()
    if isinstance(obj, dict):
        for v in obj.values():
            if isinstance(v, dict):
                out.add(v.get("name"))
            else:
                out.add(v)
    elif isinstance(obj, list):
        out.update(obj)
    return {x for x in out if x}

sym_dd = dd_names(d.get("symbol_layer_base_dd"))
for cls, info in d["symbol_layers"].items():
    sym_dd.update(dd_names(info.get("dd")))
enum_sym = d.get("QgsSymbolLayer_Property_enum") or {}
# {name:int} → keys が DD 名(Character は char のエイリアスとして別名)
sym_dd.update(k for k in enum_sym if isinstance(k, str))

# ---------- truth: label DD names ----------
label_dd = dd_names(d.get("QgsPalLayerSettings_Property_names"))
pal_enum = d.get("QgsPalLayerSettings_Property_enum") or {}
label_dd.update(k for k in pal_enum if isinstance(k, str))
label_dd.discard(None); label_dd.discard("")

# ---------- truth: element attributes ----------
elem_attrs = defaultdict(set)
def add_elem(tag, attrs):
    elem_attrs[tag].update(a for a in attrs if a)

# 実レイヤ QML
for f in glob.glob(os.path.join(LAYERS_DIR, "*.qml")):
    txt = open(f, encoding="utf-8").read()
    for m in re.finditer(r'<(\w[\w-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*/?>', txt):
        for a in re.finditer(r'([\w:.-]+)="', m.group(2)):
            elem_attrs[m.group(1)].add(a.group(1))

# default_pal_xml
try:
    pal_root = ET.fromstring(d["default_pal_xml"])
    for el in pal_root.iter():
        add_elem(el.tag, el.attrib.keys())
except Exception as e:
    print("pal xml parse warn:", e)

# スキル文書の属性表(実機記載だがサンプルに無いものを補完)
DOC_ATTRS = {
 "text-buffer": "bufferDraw bufferSize bufferSizeUnits bufferSizeMapUnitScale bufferColor bufferOpacity bufferBlendMode bufferJoinStyle bufferNoFill".split(),
 "text-mask": "maskEnabled maskType maskSize maskSize2 maskSizeUnits maskSizeMapUnitScale maskJoinStyle maskOpacity maskedSymbolLayers".split(),
 "background": "shapeDraw shapeType shapeSizeType shapeSizeX shapeSizeY shapeSizeUnit shapeSizeMapUnitScale shapeRotationType shapeRotation shapeSVGFile shapeFillColor shapeOpacity shapeBlendMode shapeBorderColor shapeBorderWidth shapeBorderWidthUnit shapeBorderWidthMapUnitScale shapeJoinStyle shapeOffsetX shapeOffsetY shapeOffsetUnit shapeOffsetMapUnitScale shapeRadiiX shapeRadiiY shapeRadiiUnit shapeRadiiMapUnitScale".split(),
 "shadow": "shadowDraw shadowUnder shadowOffsetAngle shadowOffsetDist shadowOffsetUnit shadowOffsetMapUnitScale shadowOffsetGlobal shadowRadius shadowRadiusUnit shadowRadiusMapUnitScale shadowRadiusAlphaOnly shadowTransparency shadowScale shadowColor shadowBlendMode".split(),
 "text-format": "wrapChar autoWrapLength useMaxLineLengthForAutoWrap multilineAlign formatNumbers decimals plussign addDirectionSymbol leftDirectionSymbol rightDirectionSymbol placeDirectionSymbol reverseDirectionSymbol".split(),
 "placement": "layerType placement placementFlags polygonPlacementFlags centroidWhole centroidInside dist distUnits distMapUnitScale offsetType xOffset yOffset offsetUnits labelOffsetMapUnitScale rotationAngle rotationUnit preserveRotation predefinedPositionOrder priority prioritization allowDegraded repeatDistance repeatDistanceUnits repeatDistanceMapUnitScale overrunDistance overrunDistanceUnit overrunDistanceMapUnitScale maxCurvedCharAngleIn maxCurvedCharAngleOut geometryGenerator geometryGeneratorEnabled geometryGeneratorType fitInPolygonOnly multipartBehavior lineAnchorType lineAnchorTextPoint lineAnchorPercent lineAnchorClipping maximumDistance maximumDistanceUnit maximumDistanceMapUnitScale overlapHandling quadOffset".split(),
 "rendering": "drawLabels fontLimitPixelSize fontMinPixelSize fontMaxPixelSize scaleVisibility scaleMin scaleMax limitNumLabels maxNumLabels minFeatureSize obstacle obstacleType obstacleFactor zIndex mergeLines upsidedownLabels unplacedVisibility labelPerPart displayAll".split(),
 # pointDisplacement/pointCluster/heatmapRenderer の実属性は実機 save() で採取済み
 "renderer-v2": ("type attr forceraster symbollevels enableorderby referencescale "
   "radius radius_unit radius_unit_scale weight_expression maximum_value quality "
   "tolerance toleranceUnit toleranceUnitScale placement circleWidth circleColor "
   "labelColor labelAttributeName labelDistanceFactor circleRadiusAddition "
   "maxLabelScaleDenominator pointDisplacementMethod").split(),
 "rule": "filter key label symbol scalemindenom scalemaxdenom checkstate active description else".split(),
 "category": "label render symbol type uuid value".split(),
 "range": "lower upper label symbol render uuid".split(),
 "symbol": "alpha clip_to_extent force_rhr frame_rate is_animated name type outputUnit mapUnitScale".split(),
 "layer": "class enabled id locked pass blend_mode".split(),
 "qgis": "version labelsEnabled minScale maxScale hasScaleBasedVisibilityFlag symbologyReferenceScale simplifyDrawingHints styleCategories readOnly layerType simplifyAlgorithm simplifyDrawingTol simplifyLocal simplifyMaxScale autoRefreshMode autoRefreshTime".split(),
 "labeling": "type".split(),
 "colorramp": "type".split(),
}
for t, aa in DOC_ATTRS.items():
    add_elem(t, aa)

ALL_ATTRS = set()
for s in elem_attrs.values():
    ALL_ATTRS.update(s)

# ラベル関連要素の属性ユニオン(g() 複合ゲッターが読む範囲)
LABEL_GROUP = set()
for t in ("rendering", "placement", "text-format", "settings", "text-style",
          "text-buffer", "background", "shadow", "text-mask"):
    LABEL_GROUP.update(elem_attrs.get(t, ()))

RENDERERS = set(d.get("renderers") or [])

# ---------- JS 抽出 ----------
src = open(JS, encoding="utf-8").read()
lines = src.splitlines()

def lineof(pos):
    return src.count("\n", 0, pos) + 1

finds = []  # (kind, key, line)

for m in re.finditer(r'getAttribute\(\s*"([^"]+)"', src):
    finds.append(("attr", m.group(1), lineof(m.start())))
for m in re.finditer(r"getAttribute\(\s*'([^']+)'", src):
    finds.append(("attr", m.group(1), lineof(m.start())))

# ヘルパ呼出し g("x") a("x") b("x") plA("x")
for m in re.finditer(r'\b(plA|[gab])\(\s*"([^"]+)"\s*\)', src):
    finds.append(("attr", m.group(2), lineof(m.start())))

# ddValue(dd, ["A","B"], ...) / get(["A","B"]) / num(["A"]) / bool(["A"])
for m in re.finditer(r'\bddValue\(\s*[\w?.!\[\]"\']+\s*,\s*\[([^\]]*)\]', src):
    for name in re.findall(r'"([^"]+)"', m.group(1)):
        finds.append(("dd", name, lineof(m.start())))
for m in re.finditer(r'\b(?:get|num|bool)\(\s*\[([^\]]*)\]\s*[,)]', src):
    for name in re.findall(r'"([^"]+)"', m.group(1)):
        finds.append(("dd", name, lineof(m.start())))
# dd.X / dd?.X / dd["X"]
for m in re.finditer(r'\bdd\??\.(\w+)', src):
    finds.append(("dd", m.group(1), lineof(m.start())))
for m in re.finditer(r'\bdd\["(\w+)"\]', src):
    finds.append(("dd", m.group(1), lineof(m.start())))
# ddValue 第1引数が spec.dd のものはラベルDD扱いの可能性 → 行範囲で後判定

# Option props: p.X / props.X / xxx.props.X / xxx.props?.X / o.X / fx.X / e.X
for m in re.finditer(r'\b(?:\w+\.)?props\??\.(\w+)', src):
    finds.append(("prop", m.group(1), lineof(m.start())))
for m in re.finditer(r'\bp\.(\w+)', src):
    finds.append(("prop?", m.group(1), lineof(m.start())))
for m in re.finditer(r'\bo\.(\w+)', src):
    finds.append(("prop?", m.group(1), lineof(m.start())))
for m in re.finditer(r'\bfx\.(\w+)', src):
    finds.append(("prop?", m.group(1), lineof(m.start())))

# DD の行範囲でシンボル/ラベルを分ける: applyLabelDD 定義域
lbl_start = src.find("function applyLabelDD")
lbl_end = src.find("export function formatLabelText")
lbl_lo, lbl_hi = lineof(lbl_start), lineof(lbl_end)

# ---------- 突合 ----------
def ctx_dd(line):
    return "label-dd" if lbl_lo <= line <= lbl_hi else "symbol-dd"

report = {"unknown_attr": [], "unknown_prop": [], "unknown_dd": [],
          "attr": defaultdict(list), "prop": defaultdict(list), "dd": defaultdict(list)}
for kind, key, ln in finds:
    if kind == "attr":
        report["attr"][key].append(ln)
        if key not in ALL_ATTRS:
            report["unknown_attr"].append((key, ln))
    elif kind == "dd":
        report["dd"][key].append(ln)
        c = ctx_dd(ln)
        ok = key in label_dd if c == "label-dd" else key in sym_dd
        # 片方が正しいなら文脈違いとして記録
        if not ok:
            other = "label-dd" if c == "label-dd" else "symbol-dd"
            otherok = key in (sym_dd if other == "symbol-dd" else label_dd)
            report["unknown_dd"].append((key, ln, c, otherok))
    else:
        report["prop"][key].append(ln)
        if key not in SYM_PROP_UNION:
            report["unknown_prop"].append((key, ln))

# ---------- 出力 ----------
out = {
    "counts": {"attr": len(report["attr"]), "prop": len(report["prop"]),
               "dd": len(report["dd"]),
               "unknown_attr": len(report["unknown_attr"]),
               "unknown_prop": len(report["unknown_prop"]),
               "unknown_dd": len(report["unknown_dd"])},
    "unknown_attr": sorted(report["unknown_attr"], key=lambda x: x[1]),
    "unknown_prop": sorted(report["unknown_prop"], key=lambda x: x[1]),
    "unknown_dd": sorted(report["unknown_dd"], key=lambda x: x[1]),
    "attr_keys": {k: sorted(v) for k, v in sorted(report["attr"].items())},
    "prop_keys": {k: sorted(v) for k, v in sorted(report["prop"].items())},
    "dd_keys": {k: sorted(v) for k, v in sorted(report["dd"].items())},
    "renderers_seen": sorted(RENDERERS),
}
json.dump(out, open(os.path.join(OUT_DIR, "audit_keys.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

print("attr keys:", out["counts"]["attr"], "prop keys:", out["counts"]["prop"], "dd keys:", out["counts"]["dd"])
print("\n== UNKNOWN ATTR (truth に無い) ==")
for k, ln in out["unknown_attr"]:
    print(f"  L{ln}: {k}")
print("\n== UNKNOWN PROP ==")
for k, ln in out["unknown_prop"]:
    print(f"  L{ln}: {k}")
print("\n== UNKNOWN DD ==")
for k, ln, c, otherok in out["unknown_dd"]:
    print(f"  L{ln}: {k}  (ctx={c}, other_ctx_has={otherok})")
