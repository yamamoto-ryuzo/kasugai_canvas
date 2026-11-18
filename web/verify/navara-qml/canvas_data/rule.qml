<qgis version="3.34" styleCategories="Symbology|Labeling">
 <renderer-v2 type="RuleRenderer" symbollevels="0" referencescale="-1" enableorderby="0" forceraster="0">
  <rules key="{00000000-0000-0000-0000-000000000000}">
   <rule key="{a1}" label="都市" filter="&quot;kind&quot; = 'city'" symbol="mcity"/>
   <rule key="{a2}" label="山" filter="&quot;kind&quot; = 'peak'" symbol="mpeak"/>
   <rule key="{a3}" label="実線" filter="&quot;kind&quot; = 'road'" symbol="lsolid"/>
   <rule key="{a4}" label="破線" filter="&quot;kind&quot; = 'road2'" symbol="ldash"/>
   <rule key="{a5}" label="区域" filter="&quot;kind&quot; = 'poly'" symbol="poly1"/>
  </rules>
  <symbols>
   <symbol alpha="1" name="mcity" type="marker" clip_to_extent="1">
    <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="color" type="QString" value="220,40,40,255"/>
      <Option name="name" type="QString" value="circle"/>
      <Option name="size" type="QString" value="4"/>
      <Option name="size_unit" type="QString" value="MM"/>
     </Option>
    </layer>
   </symbol>
   <symbol alpha="1" name="mpeak" type="marker" clip_to_extent="1">
    <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="color" type="QString" value="40,60,200,255"/>
      <Option name="name" type="QString" value="triangle"/>
      <Option name="size" type="QString" value="5"/>
      <Option name="size_unit" type="QString" value="MM"/>
     </Option>
    </layer>
   </symbol>
   <symbol alpha="1" name="lsolid" type="line" clip_to_extent="1">
    <layer class="SimpleLine" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="line_color" type="QString" value="0,0,255,255"/>
      <Option name="line_width" type="QString" value="1.6"/>
      <Option name="line_width_unit" type="QString" value="MM"/>
      <Option name="line_style" type="QString" value="solid"/>
     </Option>
    </layer>
   </symbol>
   <symbol alpha="1" name="ldash" type="line" clip_to_extent="1">
    <layer class="SimpleLine" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="line_color" type="QString" value="0,150,0,255"/>
      <Option name="line_width" type="QString" value="1.6"/>
      <Option name="line_width_unit" type="QString" value="MM"/>
      <Option name="line_style" type="QString" value="dash"/>
      <Option name="capstyle" type="QString" value="round"/>
     </Option>
    </layer>
   </symbol>
   <symbol alpha="1" name="poly1" type="fill" clip_to_extent="1">
    <layer class="SimpleFill" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="color" type="QString" value="200,160,40,180"/>
      <Option name="outline_color" type="QString" value="160,120,20,255"/>
      <Option name="outline_width" type="QString" value="0.5"/>
      <Option name="outline_width_unit" type="QString" value="MM"/>
      <Option name="outline_style" type="QString" value="solid"/>
     </Option>
    </layer>
   </symbol>
  </symbols>
 </renderer-v2>
 <labeling type="rule-based">
  <rules key="{00000000-0000-0000-0000-000000000000}">
   <rule key="{l1}" description="都市ラベル" filter="&quot;kind&quot; = 'city'">
    <settings>
     <text-style fieldName="name" isExpression="0" fontFamily="sans-serif" fontSize="14" fontSizeUnit="Point" fontWeight="700" textColor="200,0,0,255" textOpacity="1" namedStyle="Bold">
      <text-buffer bufferDraw="1" bufferSize="1.5" bufferSizeUnits="MM" bufferColor="255,255,255,255" bufferOpacity="1"/>
     </text-style>
     <placement placement="0" dist="1.5" distUnits="MM" quadOffset="2" layerType="PointGeometry" offsetUnits="MM" yOffset="0" xOffset="0"/>
     <rendering drawLabels="1" displayAll="1"/>
    </settings>
   </rule>
   <rule key="{l2}" description="山ラベル" filter="&quot;kind&quot; = 'peak'">
    <settings>
     <text-style fieldName="name" isExpression="0" fontFamily="sans-serif" fontSize="18" fontSizeUnit="Point" fontWeight="400" textColor="255,255,255,255" textOpacity="1" namedStyle="Regular">
      <text-buffer bufferDraw="1" bufferSize="2.5" bufferSizeUnits="MM" bufferColor="0,0,0,255" bufferOpacity="1"/>
     </text-style>
     <placement placement="0" dist="2.5" distUnits="MM" quadOffset="7" layerType="PointGeometry" offsetUnits="MM" yOffset="0" xOffset="0"/>
     <rendering drawLabels="1" displayAll="1"/>
    </settings>
   </rule>
  </rules>
 </labeling>
</qgis>
