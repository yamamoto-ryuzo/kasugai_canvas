<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">
 <NamedLayer><Name>ln</Name><UserStyle><Title>ln-sld</Title><FeatureTypeStyle>
  <Rule><Name>ln-default</Name><Title>線(既定)</Title>
   <LineSymbolizer><Stroke>
    <CssParameter name="stroke">#1f78b4</CssParameter>
    <CssParameter name="stroke-width">3</CssParameter>
    <CssParameter name="stroke-dasharray">6 3</CssParameter>
   </Stroke></LineSymbolizer>
   <TextSymbolizer>
    <Label><ogc:PropertyName>name</ogc:PropertyName></Label>
    <Font>
     <CssParameter name="font-family">Arial</CssParameter>
     <CssParameter name="font-size">12</CssParameter>
     <CssParameter name="font-weight">bold</CssParameter>
    </Font>
    <LabelPlacement><LinePlacement><PerpendicularOffset>4</PerpendicularOffset></LinePlacement></LabelPlacement>
    <Halo><Radius>1.5</Radius><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></Halo>
    <Fill><CssParameter name="fill">#1f78b4</CssParameter></Fill>
   </TextSymbolizer></Rule>
 </FeatureTypeStyle></UserStyle></NamedLayer>
</StyledLayerDescriptor>