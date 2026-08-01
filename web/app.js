import * as THREE from "three";

const { Deck, MapView, TerrainLayer } = window.deck;
const deckContainer = document.querySelector("#deck-container");

const origin = [139.7671, 35.6812];
let threeRenderer;
let threeScene;
let threeCamera;
let threeModel;

const deck = new Deck({
  parent: deckContainer,
  views: new MapView({ repeat: false }),
  initialViewState: { longitude: origin[0], latitude: origin[1], zoom: 14, pitch: 45, bearing: 0 },
  controller: {
    dragRotate: true,
    touchRotate: true,
    scrollZoom: true,
    doubleClickZoom: true,
    minPitch: 0,
    maxPitch: 179,
  },
  onWebGLInitialized: gl => {
    threeRenderer = new THREE.WebGLRenderer({
      canvas: gl.canvas,
      context: gl,
      alpha: true,
    });
    threeRenderer.autoClear = false;
    threeRenderer.setPixelRatio(1);

    threeScene = new THREE.Scene();
    threeScene.add(new THREE.HemisphereLight(0xffffff, 0x668080, 2.2));
    threeModel = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x168f84, roughness: 0.6, metalness: 0.1 }),
    );
    threeScene.add(threeModel);
    threeCamera = new THREE.Camera();
    threeCamera.matrixAutoUpdate = false;
  },
  onAfterRender: () => {
    if (!threeRenderer || !threeScene || !threeCamera || !threeModel) return;
    const viewport = deck.getViewports()[0];
    if (!viewport) return;

    threeRenderer.setViewport(0, 0, viewport.width, viewport.height);
    threeRenderer.resetState();
    threeCamera.matrixWorldInverse.fromArray(viewport.viewMatrix);
    threeCamera.matrixWorld.copy(threeCamera.matrixWorldInverse).invert();
    threeCamera.projectionMatrix.fromArray(viewport.projectionMatrix);
    threeCamera.projectionMatrixInverse.copy(threeCamera.projectionMatrix).invert();

    threeModel.position.fromArray(viewport.projectPosition([origin[0], origin[1], 18]));
    threeModel.scale.setScalar(0.00035);
    threeModel.rotation.y = 0.6;
    threeRenderer.render(threeScene, threeCamera);
  },
  layers: [
    new TerrainLayer({
      id: "tokyo-terrain",
      elevationData: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      texture: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      elevationDecoder: {
        rScaler: 256,
        gScaler: 1,
        bScaler: 1 / 256,
        offset: -32768,
      },
      minZoom: 0,
      maxZoom: 14,
      tileSize: 256,
      meshMaxError: 10,
      color: [220, 220, 220],
    }),
  ],
});
