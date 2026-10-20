<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.28" styleCategories="Symbology | Labeling">
 <renderer-v2 type="RuleBased" symbollevels="0">
  <rules>
   <rule filter="&quot;kind&quot;='候補駅' AND &quot;id&quot;='A'" symbol="stA" label="候補A（駅）"/>
   <rule filter="&quot;kind&quot;='候補駅' AND &quot;id&quot;='B'" symbol="stB" label="候補B（駅）"/>
   <rule filter="&quot;kind&quot;='候補駅' AND &quot;id&quot;='C'" symbol="stC" label="候補C（駅）"/>
   <rule filter="&quot;kind&quot;='比較範囲' AND &quot;id&quot;='A'" symbol="rgA" label="候補A 比較範囲"/>
   <rule filter="&quot;kind&quot;='比較範囲' AND &quot;id&quot;='B'" symbol="rgB" label="候補B 比較範囲"/>
   <rule filter="&quot;kind&quot;='比較範囲' AND &quot;id&quot;='C'" symbol="rgC" label="候補C 比較範囲"/>
   <rule filter="ELSE" symbol="oth" label="その他"/>
  </rules>
  <symbols>
   <symbol name="stA" type="marker" alpha="1"><layer class="SimpleMarker" enabled="1"><Option type="Map"><Option name="color" value="216,27,96,255"/><Option name="name" value="hexagon"/><Option name="size" value="4.2"/><Option name="size_unit" value="MM"/><Option name="outline_color" value="255,255,255,255"/><Option name="outline_width" value="0.6"/><Option name="outline_style" value="solid"/></Option></layer></symbol>
   <symbol name="stB" type="marker" alpha="1"><layer class="SimpleMarker" enabled="1"><Option type="Map"><Option name="color" value="0,172,193,255"/><Option name="name" value="hexagon"/><Option name="size" value="4.2"/><Option name="size_unit" value="MM"/><Option name="outline_color" value="255,255,255,255"/><Option name="outline_width" value="0.6"/><Option name="outline_style" value="solid"/></Option></layer></symbol>
   <symbol name="stC" type="marker" alpha="1"><layer class="SimpleMarker" enabled="1"><Option type="Map"><Option name="color" value="255,179,0,255"/><Option name="name" value="hexagon"/><Option name="size" value="4.2"/><Option name="size_unit" value="MM"/><Option name="outline_color" value="255,255,255,255"/><Option name="outline_width" value="0.6"/><Option name="outline_style" value="solid"/></Option></layer></symbol>
   <symbol name="rgA" type="fill" alpha="1"><layer class="SimpleFill" enabled="1"><Option type="Map"><Option name="color" value="216,27,96,28"/><Option name="fill_style" value="solid"/><Option name="outline_color" value="216,27,96,230"/><Option name="outline_width" value="0.8"/><Option name="outline_style" value="dash"/></Option></layer></symbol>
   <symbol name="rgB" type="fill" alpha="1"><layer class="SimpleFill" enabled="1"><Option type="Map"><Option name="color" value="0,172,193,28"/><Option name="fill_style" value="solid"/><Option name="outline_color" value="0,172,193,230"/><Option name="outline_width" value="0.8"/><Option name="outline_style" value="dash"/></Option></layer></symbol>
   <symbol name="rgC" type="fill" alpha="1"><layer class="SimpleFill" enabled="1"><Option type="Map"><Option name="color" value="255,179,0,28"/><Option name="fill_style" value="solid"/><Option name="outline_color" value="255,179,0,230"/><Option name="outline_width" value="0.8"/><Option name="outline_style" value="dash"/></Option></layer></symbol>
   <symbol name="oth" type="marker" alpha="0.8"><layer class="SimpleMarker" enabled="1"><Option type="Map"><Option name="color" value="120,120,120,255"/><Option name="name" value="circle"/><Option name="size" value="2.5"/><Option name="size_unit" value="MM"/><Option name="outline_style" value="no"/></Option></layer></symbol>
  </symbols>
 </renderer-v2>
 <labeling type="rule-based">
  <rules>
   <rule filter="&quot;kind&quot;='候補駅'">
    <settings>
     <text-style fieldName="name" fontSize="12" fontSizeUnit="Point" fontBold="1" fontFamily="sans-serif" textColor="38,50,56,255" bufferDraw="1" bufferColor="255,255,255,255" bufferSize="1.2"/>
    </settings>
   </rule>
  </rules>
 </labeling>
</qgis>
