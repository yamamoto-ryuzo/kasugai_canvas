// ギャップ検証用フィクスチャ生成(QML gaps): markerline/rasterline/mapunit/inverted/heat/cluster/25d
import fs from "node:fs";

const D = "C:/devin/kasugai_canvas/test-results/qml-verify/DATA";
const OUT = "C:/devin/kasugai_canvas/test-results/qml-verify";

const hdr = `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.40" styleCategories="AllStyleCategories" labelsEnabled="0">`;
const ftr = `</qgis>`;
const symOpen = t => `    <symbols><symbol alpha="1" clip_to_extent="1" force_rhr="0" name="0" type="${t}">`;
const symClose = `</symbol></symbols>`;

// --- geojson ---
const pts = { type: "FeatureCollection", features: [] };
for (let i = 0; i < 40; i++) {
  const dx = (i % 8) * 0.004 - 0.014, dy = Math.floor(i / 8) * 0.004 - 0.008;
  pts.features.push({
    type: "Feature", properties: { w: 1 + (i % 5) },
    geometry: { type: "Point", coordinates: [139.60 + dx + (i * 37 % 10) * 0.0001, 35.60 + dy + (i * 13 % 10) * 0.0001] },
  });
}
fs.writeFileSync(`${D}/gaps_points.geojson`, JSON.stringify(pts));
fs.writeFileSync(`${D}/gaps_line.geojson`, JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { name: "l" }, geometry: { type: "LineString",
    coordinates: [[139.53, 35.56], [139.60, 35.58], [139.66, 35.56], [139.72, 35.59]] } },
] }));
fs.writeFileSync(`${D}/gaps_poly.geojson`, JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { name: "p" }, geometry: { type: "Polygon",
    coordinates: [[[139.55, 35.60], [139.68, 35.60], [139.68, 35.66], [139.55, 35.66], [139.55, 35.60]]] } },
] }));

// --- raster tile image for RasterLine (8x8 checker) ---
fs.writeFileSync(`${D}/tick.png`, Buffer.from(
  "iVBORw0KGgoAAAAGUAAABLbSncAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAeSURBVBhXY3z//z8DKhhGhogxQIX/MDAwMEAAowEACv4BH7H9r8gAAAAASUVORK5CYII=",
  "base64"));

// --- MarkerLine ---
fs.writeFileSync(`${D}/gaps_markerline.qml`, `${hdr}
  <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="singleSymbol">
${symOpen("line")}
        <layer class="SimpleLine" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="line_color" type="QString" value="70,70,70,255"/>
            <Option name="line_style" type="QString" value="solid"/>
            <Option name="line_width" type="QString" value="0.5"/>
            <Option name="line_width_unit" type="QString" value="MM"/>
          </Option>
        </layer>
        <layer class="MarkerLine" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="interval" type="QString" value="6"/>
            <Option name="interval_unit" type="QString" value="MM"/>
            <Option name="placement" type="QString" value="interval"/>
            <Option name="rotate_marker" type="QString" value="1"/>
          </Option>
          <symbol alpha="1" name="@0@1" type="marker">
            <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
              <Option type="Map">
                <Option name="color" type="QString" value="200,30,40,255"/>
                <Option name="name" type="QString" value="triangle"/>
                <Option name="size" type="QString" value="3"/>
                <Option name="size_unit" type="QString" value="MM"/>
              </Option>
            </layer>
          </symbol>
        </layer>
${symClose}
  </renderer-v2>
${ftr}`);

// --- RasterLine ---
fs.writeFileSync(`${D}/gaps_rasterline.qml`, `${hdr}
  <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="singleSymbol">
${symOpen("line")}
        <layer class="RasterLine" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="imageFile" type="QString" value="tick.png"/>
            <Option name="line_width" type="QString" value="4"/>
            <Option name="line_width_unit" type="QString" value="MM"/>
            <Option name="offset" type="QString" value="0"/>
            <Option name="offset_unit" type="QString" value="MM"/>
          </Option>
        </layer>
${symClose}
  </renderer-v2>
${ftr}`);

// --- MapUnit marker ---
fs.writeFileSync(`${D}/gaps_mapunit.qml`, `${hdr}
  <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="singleSymbol">
${symOpen("marker")}
        <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="color" type="QString" value="30,120,200,200"/>
            <Option name="name" type="QString" value="circle"/>
            <Option name="outline_color" type="QString" value="10,60,140,255"/>
            <Option name="outline_width" type="QString" value="0.4"/>
            <Option name="outline_width_unit" type="QString" value="MM"/>
            <Option name="size" type="QString" value="80"/>
            <Option name="size_unit" type="QString" value="MapUnit"/>
          </Option>
        </layer>
${symClose}
  </renderer-v2>
${ftr}`);

// --- inverted polygon ---
const fillLayers = `        <layer class="SimpleFill" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="color" type="QString" value="50,50,50,120"/>
            <Option name="outline_color" type="QString" value="200,30,30,255"/>
            <Option name="outline_style" type="QString" value="solid"/>
            <Option name="outline_width" type="QString" value="0.5"/>
            <Option name="outline_width_unit" type="QString" value="MM"/>
            <Option name="style" type="QString" value="solid"/>
          </Option>
        </layer>`;
fs.writeFileSync(`${D}/gaps_inverted.qml`, `${hdr}
  <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="invertedPolygonRenderer">
${symOpen("fill")}
${fillLayers}
${symClose}
    <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="singleSymbol">
${symOpen("fill")}
${fillLayers}
${symClose}
    </renderer-v2>
  </renderer-v2>
${ftr}`);

// --- heatmap ---
fs.writeFileSync(`${D}/gaps_heat.qml`, `${hdr}
  <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="heatmapRenderer" radius="14" radius_unit="MM" maximum_value="6" quality="3" weight_expression="">
    <colorramp type="gradient" name="r1">
      <Option type="Map">
        <Option name="color1" type="QString" value="0,0,255,64"/>
        <Option name="color2" type="QString" value="255,0,0,255"/>
        <Option name="discrete" type="QString" value="0"/>
      </Option>
    </colorramp>
  </renderer-v2>
${ftr}`);

// --- cluster ---
const ptMarker = `        <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="color" type="QString" value="20,160,90,255"/>
            <Option name="name" type="QString" value="circle"/>
            <Option name="outline_color" type="QString" value="255,255,255,255"/>
            <Option name="size" type="QString" value="2.5"/>
            <Option name="size_unit" type="QString" value="MM"/>
          </Option>
        </layer>`;
fs.writeFileSync(`${D}/gaps_cluster.qml`, `${hdr}
  <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="pointCluster" tolerance="8" tolerance_unit="MM" distance_unit="MM">
${symOpen("marker")}
${ptMarker}
${symClose}
    <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="singleSymbol">
${symOpen("marker")}
${ptMarker}
${symClose}
    </renderer-v2>
  </renderer-v2>
${ftr}`);

// --- 25d ---
fs.writeFileSync(`${D}/gaps_25d.qml`, `${hdr}
  <renderer-v2 enableorderby="0" forceraster="0" referencescale="-1" symbollevels="0" type="25d">
${symOpen("fill")}
        <layer class="SimpleFill" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="color" type="QString" value="160,100,60,230"/>
            <Option name="style" type="QString" value="solid"/>
          </Option>
        </layer>
${symClose}
  </renderer-v2>
${ftr}`);

// --- kasc ---
fs.writeFileSync(`${OUT}/gaps.kasc`, `title: QML gap verify
base: 地理院タイル 淡色地図 | https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png | maxZoom=18 | minZoom=5
geojson: markerline | DATA/gaps_line.geojson | on | style=DATA/gaps_markerline.qml
geojson: rasterline | DATA/gaps_line.geojson | on | style=DATA/gaps_rasterline.qml
geojson: mapunit | DATA/gaps_points.geojson | on | style=DATA/gaps_mapunit.qml
geojson: inverted | DATA/gaps_poly.geojson | on | style=DATA/gaps_inverted.qml
geojson: heat | DATA/gaps_points.geojson | on | style=DATA/gaps_heat.qml
geojson: cluster | DATA/gaps_points.geojson | on | style=DATA/gaps_cluster.qml
geojson: d25 | DATA/gaps_poly.geojson | on | style=DATA/gaps_25d.qml
cam: 東京 | 35.605 | 139.61 | h=20000 | p=-90
`);

console.log("fixtures written");
