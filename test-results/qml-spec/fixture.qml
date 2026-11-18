<qgis version="4.0.1" labelsEnabled="1">
 <renderer-v2 type="categorizedSymbol" attr="k">
  <symbols>
   <symbol alpha="1" name="0" type="fill">
    <layer class="SimpleFill" enabled="1">
     <Option type="Map">
      <Option name="style" type="QString" value="diagonal_x"/>
      <Option name="color" type="QString" value="10,20,30,255"/>
     </Option>
    </layer>
   </symbol>
   <symbol alpha="1" name="1" type="line">
    <layer class="MarkerLine" enabled="1">
     <Option type="Map">
      <Option name="interval" type="QString" value="5"/>
      <Option name="placements" type="QString" value="Vertex"/>
      <Option name="rotate" type="QString" value="0"/>
     </Option>
     <symbol type="marker" name="sub">
      <layer class="SimpleMarker" enabled="1">
       <Option type="Map"><Option name="name" type="QString" value="circle"/><Option name="size" type="QString" value="2"/><Option name="color" type="QString" value="255,0,0,255"/></Option>
      </layer>
     </symbol>
    </layer>
    <layer class="ArrowLine" enabled="1">
     <Option type="Map">
      <Option name="head_length" type="QString" value="4"/>
      <Option name="head_thickness" type="QString" value="3"/>
      <Option name="is_curved" type="QString" value="1"/>
     </Option>
    </layer>
   </symbol>
   <symbol alpha="1" name="2" type="line">
    <layer class="InterpolatedLine" enabled="1">
     <Option type="Map">
      <Option name="coloring_method" type="QString" value="singleColor"/>
      <Option name="single_color" type="QString" value="0,0,255,255"/>
      <Option name="line_width" type="QString" value="0.5"/>
      <Option name="width_varying_is_variable_width" type="QString" value="1"/>
      <Option name="width_varying_minimum_width" type="QString" value="0.2"/>
      <Option name="width_varying_maximum_width" type="QString" value="3"/>
      <Option name="line_width_unit" type="QString" value="MM"/>
     </Option>
    </layer>
   </symbol>
  </symbols>
  <categories>
   <category label="fill" render="true" symbol="0" value="1"/>
   <category label="line" render="true" symbol="1" value="2"/>
   <category label="interp" render="true" symbol="2" value="3"/>
  </categories>
 </renderer-v2>
 <labeling type="simple">
  <settings calloutType="simple">
   <text-style fieldName="name" fontFamily="Arial" fontSize="12" fontSizeUnit="Point" textColor="0,0,0,255" isExpression="0" fontItalic="0" fontWeight="400" multilineHeight="1" multilineHeightUnit="Percentage" textOpacity="1" textOrientation="horizontal">
    <text-buffer bufferDraw="1" bufferSize="2" bufferSizeUnits="Point" bufferColor="255,255,255,255" bufferOpacity="1"/>
   </text-style>
   <text-format wrapChar=";" autoWrapLength="10" formatNumbers="1" decimals="2" plussign="1" addDirectionSymbol="1" leftDirectionSymbol="&lt;" rightDirectionSymbol="&gt;" placeDirectionSymbol="0" multilineAlign="1"/>
   <placement placement="0" priority="9" dist="2" distUnits="MM" quadOffset="5" xOffset="1" yOffset="2" offsetUnits="MM" rotationAngle="15" layerType="PointGeometry" overlapHandling="PreventOverlap" multipartBehavior="LabelAllParts"/>
   <rendering drawLabels="1" scaleVisibility="0" obstacle="1" zIndex="3" upsidedownLabels="0"/>
   <dd_properties>
    <Option type="Map">
     <Option name="properties" type="Map">
      <Option name="Size" type="Map">
       <Option name="active" type="bool" value="true"/>
       <Option name="expression" type="QString" value="20"/>
       <Option name="type" type="int" value="3"/>
      </Option>
      <Option name="BufferSize" type="Map">
       <Option name="active" type="bool" value="true"/>
       <Option name="expression" type="QString" value="4"/>
       <Option name="type" type="int" value="3"/>
      </Option>
      <Option name="NumDecimals" type="Map">
       <Option name="active" type="bool" value="true"/>
       <Option name="expression" type="QString" value="1"/>
       <Option name="type" type="int" value="3"/>
      </Option>
     </Option>
    </Option>
   </dd_properties>
  </settings>
 </labeling>
</qgis>
