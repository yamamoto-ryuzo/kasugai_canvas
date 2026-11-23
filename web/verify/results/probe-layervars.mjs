// レイヤー変数(variableNames/variableValues)の @x/var() 解決 + 25d 実値 検証
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const PORT = process.env.PORT || "8520";
const browser = await chromium.launch();
const pg = await browser.newPage();
const errs = [];
pg.on("pageerror", e => errs.push(e.message));
await pg.goto(`http://localhost:${PORT}/cesium/?kasc=_ren_verify&kasc_noload=1`, { waitUntil: "domcontentloaded" });
const r = await pg.evaluate(async () => {
  const qs = await import("/shared/qml-style.js");
  const out = {};
  // 1) 実機 fixture: variableNames/variableValues パース + d25 変数適用
  const xml = await (await fetch("/projects/_ren_verify/canvas_data/qmltest_ren_25d.qml")).text();
  const st = qs.compileQmlStyle(xml);
  out.vars = st.vars;
  out.d25 = st.d25;
  // 2) 変数参照の DD/ルール評価: @x と var('x') の両形態
  const varQml = `<?xml version="1.0"?><qgis version="3.40"><renderer-v2 type="singleSymbol">
    <symbols><symbol type="marker" name="s"><layer class="SimpleMarker" enabled="1">
      <Option type="Map"><Option name="size" value="2"/>
      <Option name="color" value="255,0,0,255"/>
      <Option name="size_unit" value="MM"/></Option>
      <data_defined_properties><Option type="Map">
        <Option name="size" type="Map">
          <Option name="active" value="1"/><Option name="type" value="1"/>
          <Option name="expression" value="var('marker_sz')"/>
        </Option>
        <Option name="fillColor" type="Map">
          <Option name="active" value="1"/><Option name="type" value="1"/>
          <Option name="expression" value="if(@marker_sz > 5, '0,255,0,255', '0,0,255,255')"/>
        </Option>
      </Option></data_defined_properties>
    </layer></symbol></symbols></renderer-v2>
    <customproperties><Option type="Map">
      <Option name="variableNames" type="StringList"><Option value="marker_sz"/></Option>
      <Option name="variableValues" type="StringList"><Option value="8"/></Option>
    </Option></customproperties></qgis>`;
  const st2 = qs.compileQmlStyle(varQml);
  out.vars2 = st2.vars;
  const spec = st2.evaluate({});
  out.markerSize = spec?.markers?.[0]?.sizePx;
  out.markerFill = spec?.markers?.[0]?.fill;
  // 3) @feature/@id 最小供給
  const fidQml = varQml.replace("var('marker_sz')", "@id + 1").replace("8", "4");
  const st3 = qs.compileQmlStyle(fidQml);
  out.idEval = st3.evaluate({ id: 41 })?.markers?.[0]?.sizePx;
  return out;
}).catch(e => ({ fatal: String(e) }));
console.log(JSON.stringify(r, null, 1));
console.log("pageerrors:", errs.length, errs.slice(0, 3));
let pass = 0, fail = 0;
const ck = (n, ok, info="") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${info}`); };
ck("vars parsed", r.vars?.qgis_25d_height === 0.01 && r.vars?.qgis_25d_angle === 70, JSON.stringify(r.vars));
ck("d25 height", r.d25?.height === 0.01, `h=${r.d25?.height}`);
ck("d25 angle", r.d25?.angle === 70, `a=${r.d25?.angle}`);
ck("d25 heightM(deg→m)", r.d25?.heightM > 1000 && r.d25?.heightM < 1200, `m=${r.d25?.heightM}`);
ck("var() DD size", r.markerSize > 0, `px=${r.markerSize}`);
ck("@x DD color", JSON.stringify(r.markerFill || "").includes("0"), `fill=${JSON.stringify(r.markerFill)}`);
ck("@id", r.idEval > 0, `px=${r.idEval}`);
ck("no pageerror", errs.length === 0, errs[0] || "");
console.log(`${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail ? 1 : 0);
