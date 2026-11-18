<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="4.0.1" styleCategories="Symbology|Labeling">
 <renderer-v2 type="categorizedSymbol" symbollevels="1" attr="cat" forceraster="0" referencescale="-1" enableorderby="0">
  <categories>
   <category label="low" value="low" render="true" symbol="0" type="string"/>
   <category label="high" value="high" render="true" symbol="1" type="string"/>
  </categories>
  <symbols>
   <symbol type="marker" name="0" clip_to_extent="1" alpha="1" force_rhr="0" is_animated="0" frame_rate="10">
    <data_defined_properties>
     <Option type="Map">
      <Option type="QString" value="" name="name"/>
     </Option>
    </data_defined_properties>
    <layer class="SimpleMarker" enabled="1" pass="0" id="{aaaa-0001}" locked="0">
     <Option type="Map">
      <Option type="QString" value="circle" name="name"/>
      <Option type="QString" value="0,0" name="offset"/>
      <Option type="QString" value="3x:0,0,0,0,0,0" name="offset_map_unit_scale"/>
      <Option type="QString" value="MM" name="offset_unit"/>
      <Option type="QString" value="35,35,35,255,rgb:0.1372549,0.1372549,0.1372549,1" name="outline_color"/>
      <Option type="QString" value="solid" name="outline_style"/>
      <Option type="QString" value="0" name="outline_width"/>
      <Option type="QString" value="MM" name="outline_width_unit"/>
      <Option type="QString" value="diameter" name="scale_method"/>
      <Option type="QString" value="5" name="size"/>
      <Option type="QString" value="MM" name="size_unit"/>
      <Option type="QString" value="0" name="angle"/>
      <Option type="QString" value="220,50,50,255,rgb:0.86,0.19,0.19,1" name="color"/>
     </Option>
    </layer>
   </symbol>
   <symbol type="marker" name="1" clip_to_extent="1" alpha="1" force_rhr="0" is_animated="0" frame_rate="10">
    <data_defined_properties>
     <Option type="Map">
      <Option type="QString" value="" name="name"/>
     </Option>
    </data_defined_properties>
    <layer class="SimpleMarker" enabled="1" pass="1" id="{aaaa-0002}" locked="0">
     <Option type="Map">
      <Option type="QString" value="square" name="name"/>
      <Option type="QString" value="0,0" name="offset"/>
      <Option type="QString" value="3x:0,0,0,0,0,0" name="offset_map_unit_scale"/>
      <Option type="QString" value="MM" name="offset_unit"/>
      <Option type="QString" value="35,35,35,255,rgb:0.1372549,0.1372549,0.1372549,1" name="outline_color"/>
      <Option type="QString" value="solid" name="outline_style"/>
      <Option type="QString" value="0" name="outline_width"/>
      <Option type="QString" value="MM" name="outline_width_unit"/>
      <Option type="QString" value="diameter" name="scale_method"/>
      <Option type="QString" value="6" name="size"/>
      <Option type="QString" value="MM" name="size_unit"/>
      <Option type="QString" value="0" name="angle"/>
      <Option type="QString" value="50,80,220,255,rgb:0.19,0.31,0.86,1" name="color"/>
     </Option>
    </layer>
   </symbol>
  </symbols>
  <source-symbol>
   <symbol type="marker" name="0" clip_to_extent="1" alpha="1" force_rhr="0" is_animated="0" frame_rate="10">
    <layer class="SimpleMarker" enabled="1" pass="0" id="{aaaa-0003}" locked="0">
     <Option type="Map">
      <Option type="QString" value="circle" name="name"/>
      <Option type="QString" value="0,0" name="offset"/>
      <Option type="QString" value="MM" name="offset_unit"/>
      <Option type="QString" value="5" name="size"/>
      <Option type="QString" value="MM" name="size_unit"/>
      <Option type="QString" value="0" name="angle"/>
      <Option type="QString" value="128,128,128,255,rgb:0.5,0.5,0.5,1" name="color"/>
     </Option>
    </layer>
   </symbol>
  </source-symbol>
 </renderer-v2>
 <labeling type="simple">
  <settings calloutType="simple">
   <text-style isExpression="0" fieldName="name" capitalization="0" fontSize="10" fontSizeUnits="pt" textColor="30,30,30,255,rgb:0.1176471,0.1176471,0.1176471,1" namedStyle="Regular" fontFamily="MS UI Gothic"/>
   <placement placement="1" dist="1.5" distUnits="MM" predefinedPositionOrder="TR,BR,T,B" yOffset="0" xOffset="0"/>
   <rendering scaleVisibility="0" drawLabels="1" obstacle="1" zIndex="0" displayAll="0"/>
  </settings>
 </labeling>
</qgis>
