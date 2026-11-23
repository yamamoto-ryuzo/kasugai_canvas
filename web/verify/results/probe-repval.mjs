// represent_value + fieldConfiguration ValueMap + []添字 + interval リテラル 検証
import { chromium } from "file:///C:/devin/kasugai_canvas/.testtmp/node_modules/playwright/index.mjs";
const PORT = process.env.PORT || "8520";
const browser = await chromium.launch();
const pg = await browser.newPage();
const errs = [];
pg.on("pageerror", e => errs.push(e.message));
await pg.goto(`http://localhost:${PORT}/cesium/?kasc=_ren_verify&kasc_noload=1`, { waitUntil: "domcontentloaded" });
const r = await pg.evaluate(async () => {
  const qs = await import("/shared/qml-style.js");
  const qml = `<?xml version="1.0"?><qgis version="3.40"><renderer-v2 type="singleSymbol">
    <symbols><symbol type="marker" name="s"><layer class="SimpleMarker" enabled="1">
      <Option type="Map"><Option name="size" value="2"/><Option name="color" value="255,0,0,255"/>
      <Option name="size_unit" value="MM"/></Option>
    </layer></symbol></symbols></renderer-v2>
    <fieldConfiguration>
      <field name="usecode" configurationFlags="None">
        <editWidget type="ValueMap"><config><Option type="Map">
          <Option name="map" type="Map">
            <Option name="住宅" type="QString" value="1"/>
            <Option name="商業" type="QString" value="2"/>
          </Option>
        </Option></config></editWidget>
      </field>
    </fieldConfiguration>
    <previewExpression>represent_value('usecode')</previewExpression></qgis>`;
  const st = qs.compileQmlStyle(qml);
  return {
    valueMap: st.fields?.valueMap,
    disp1: st.displayFor({ usecode: "1" }),
    disp2: st.displayFor({ usecode: "2" }),
    dispX: st.displayFor({ usecode: "9" }),
  };
});
let pass = 0, fail = 0;
const ck = (n, ok, info="") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${info}`); };
console.log(JSON.stringify(r));
ck("valueMap parsed", r.valueMap?.usecode?.["1"] === "住宅");
ck("represent_value 1→住宅", r.disp1 === "住宅", String(r.disp1));
ck("represent_value 2→商業", r.disp2 === "商業", String(r.disp2));
ck("unknown value passthrough", r.dispX === "9", String(r.dispX));
ck("no pageerror", errs.length === 0, errs[0] || "");
console.log(`${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail ? 1 : 0);
