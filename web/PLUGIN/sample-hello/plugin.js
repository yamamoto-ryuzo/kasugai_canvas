export async function init(api, manifest) {
  const Cesium = api.getCesium();
  // plugins.json の layer 宣言(format:"entities")で本体が生成した DataSource を取得する。
  // この DataSource に追加した entity はレイヤ一覧・表示切替・属性検索の対象になる
  const ds = api.getPluginDataSource(manifest.id);
  if (!Cesium || !ds) {
    console.warn("[sample-hello] Cesium またはプラグイン用 DataSource が見つかりません");
    return;
  }

  const marker = ds.entities.add({
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
    properties: { source: "sample-hello", description: "プラグインが追加したサンプルマーカー" },
  });

  api.registerPlugin({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    marker,
  });
}
