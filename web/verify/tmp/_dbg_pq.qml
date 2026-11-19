<?xml version="1.0"?>
<qgis version="3.34" styleCategories="Symbology|Labeling">
 <renderer-v2 type="categorizedSymbol" attr="continent" forceraster="0" enableorderby="0" symbollevels="0">
  <categories>
   <category symbol="0" value="Africa" label="Africa" render="true"/>
   <category symbol="1" value="Asia" label="Asia" render="true"/>
  </categories>
  <symbols>
   <symbol type="fill" name="0" alpha="1" clip_to_extent="1">
    <layer class="SimpleFill" enabled="1" pass="0"><Option type="Map"><Option name="color" type="QString" value="230,25,75,255"/><Option name="style" type="QString" value="solid"/><Option name="outline_style" type="QString" value="no"/></Option></layer>
   </symbol>
   <symbol type="fill" name="1" alpha="1" clip_to_extent="1">
    <layer class="SimpleFill" enabled="1" pass="0"><Option type="Map"><Option name="color" type="QString" value="60,180,75,255"/><Option name="style" type="QString" value="solid"/><Option name="outline_style" type="QString" value="no"/></Option></layer>
   </symbol>
  </symbols>
 </renderer-v2>
 <labeling type="simple">
  <settings calloutType="simple">
   <text-style fieldName="continent" isExpression="0" fontFamily="Arial" fontSize="12" fontSizeUnit="Point" fontWeight="50" textColor="0,0,0,255" textOpacity="1" previewBkgrdColor="255,255,255,255" legendString="Aa" useSubstitutions="0">
   </text-style>
   <placement placement="0" dist="0" offsetType="0" quadOffset="4" yOffset="0" xOffset="0" centroidWhole="0" centroidInside="0" predefinedPositionOrder="TR,TL,BR,BL,R,L,TSR,BSR" fitInPolygonOnly="0" distUnits="MM" layerType="PolygonGeometry" offsetUnits="MM" preserveRotation="1" priority="5" placementFlags="10"/>
   <rendering scaleVisibility="0" scaleMin="0" scaleMax="0" limitNumLabels="0" maxNumLabels="2000" obstacle="1" obstacleFactor="1" obstacleType="0" zIndex="0" upsidedownLabels="0" labelPerPart="0" mergeLines="0" minFeatureSize="0" displayAll="1" fontLimitPixelSize="0" drawLabels="1" unplacedVisibility="0"/>
  </settings>
 </labeling>
</qgis>
