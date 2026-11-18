<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.40" styleCategories="AllStyleCategories" labelsEnabled="1">
  <renderer-v2 type="singleSymbol">
    <symbols>
      <symbol alpha="1" name="0" type="marker">
        <layer class="SimpleMarker" enabled="1" pass="0">
          <Option type="Map">
            <Option name="color" type="QString" value="31,119,180,255"/>
            <Option name="size" type="QString" value="2"/>
            <Option name="size_unit" type="QString" value="MM"/>
            <Option name="name" type="QString" value="circle"/>
            <Option name="outline_color" type="QString" value="35,35,35,255"/>
            <Option name="outline_width" type="QString" value="0.2"/>
            <Option name="outline_width_unit" type="QString" value="MM"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
  </renderer-v2>
  <labeling type="rule-based">
    <rules key="{r}">
      <rule filter="&quot;t&quot; = '1'" key="k1">
        <settings>
          <text-style fieldName="name" fontFamily="MS Gothic" fontSize="14" fontSizeUnit="Point"
            fontWeight="75" fontItalic="1" textColor="214,39,40,255" textOpacity="1"
            bufferDraw="0" namedSize=""/>
          <placement dist="0" placement="0" quadOffset="4"/>
        </settings>
      </rule>
      <rule filter="&quot;t&quot; = '2'" key="k2">
        <settings>
          <text-style fieldName="name" fontFamily="MS Gothic" fontSize="10" fontSizeUnit="Point"
            textColor="0,0,0,255" textOpacity="1" bufferDraw="0" namedSize=""/>
          <placement dist="0" placement="0" quadOffset="4"/>
        </settings>
      </rule>
      <rule filter="&quot;t&quot; = '3'" key="k3">
        <settings>
          <text-style fieldName="name" fontFamily="MS Gothic" fontSize="14" fontSizeUnit="Point"
            textColor="0,0,0,255" textOpacity="1" bufferDraw="0" namedSize=""/>
          <text-buffer bufferDraw="1" bufferSize="2" bufferSizeUnit="MM" bufferColor="255,255,0,255"/>
          <placement dist="0" placement="0" quadOffset="4"/>
        </settings>
      </rule>
    </rules>
  </labeling>
</qgis>
