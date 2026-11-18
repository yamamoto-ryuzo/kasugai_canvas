<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml" xmlns:test="http://example.com/test">
 <gml:featureMember>
  <test:area fid="area.1">
   <test:name>gml-area</test:name>
   <test:the_geom>
    <gml:Polygon srsName="EPSG:4326">
     <gml:exterior><gml:LinearRing>
      <gml:posList>35.68 139.75 35.68 139.79 35.70 139.79 35.70 139.75 35.68 139.75</gml:posList>
     </gml:LinearRing></gml:exterior>
    </gml:Polygon>
   </test:the_geom>
  </test:area>
 </gml:featureMember>
 <gml:featureMember>
  <test:area fid="area.2">
   <test:name>gml-point</test:name>
   <test:the_geom><gml:Point srsName="EPSG:4326"><gml:pos>35.69 139.77</gml:pos></gml:Point></test:the_geom>
  </test:area>
 </gml:featureMember>
</wfs:FeatureCollection>
