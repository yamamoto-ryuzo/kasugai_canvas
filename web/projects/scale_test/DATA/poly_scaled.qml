<qgis version="3.28" styleCategories="Symbology|Labeling">
 <renderer-v2 type="RuleRenderer" symbollevels="0" referencescale="-1" enableorderby="0" forceraster="0">
  <rules key="k">
   <rule key="a" scalemaxdenom="8000" label="詳細側(緑)" symbol="g"/>
   <rule key="b" scalemindenom="8000" label="広域側(青)" symbol="b"/>
  </rules>
  <symbols>
   <symbol alpha="1" name="g" type="fill" clip_to_extent="1">
    <layer class="SimpleFill" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="color" type="QString" value="40,180,60,255"/>
      <Option name="border_color" type="QString" value="20,120,40,255"/>
      <Option name="border_width" type="QString" value="0.6"/>
      <Option name="border_width_unit" type="QString" value="MM"/>
     </Option>
    </layer>
   </symbol>
   <symbol alpha="1" name="b" type="fill" clip_to_extent="1">
    <layer class="SimpleFill" enabled="1" locked="0" pass="0">
     <Option type="Map">
      <Option name="color" type="QString" value="60,100,220,255"/>
      <Option name="border_color" type="QString" value="30,60,160,255"/>
      <Option name="border_width" type="QString" value="0.6"/>
      <Option name="border_width_unit" type="QString" value="MM"/>
     </Option>
    </layer>
   </symbol>
  </symbols>
 </renderer-v2>
</qgis>
