export async function init(api, manifest) {
  const Cesium = api.getCesium();
  const viewer = api.getViewer();
  if (!Cesium || !viewer) {
    console.warn("[sample-hello] Cesium または viewer が見つかりません");
    return;
  }

  const marker = viewer.entities.add({
    name: manifest.name,
    position: Cesium.Cartesian3.fromDegrees(139.7528, 35.6852, 1000),
    point: { pixelSize: 20, color: Cesium.Color.fromCssColorString("#ff6b6b") },
    label: {
      text: "Hello from PLUGIN!",
      font: "14px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -12),
    },
  });

  api.registerPlugin({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    marker,
  });

  console.log(`[sample-hello] 読み込み完了: ${manifest.name}`);
}
