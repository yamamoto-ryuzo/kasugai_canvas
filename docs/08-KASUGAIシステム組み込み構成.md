---
layout: "default"
title: "8. KASUGAI システム組み込み構成"
nav_order: "8"
---



## 8. KASUGAI システム組み込み構成

### コアエンジン

- **deck.gl + loaders.gl**
  - `@deck.gl/core`, `@deck.gl/geo-layers`, `@deck.gl/layers`
  - `@loaders.gl/arrow`, `@loaders.gl/3d-tiles`

### 組み込むべき3つの拡張

1. **TerrainExtension**：2D図面の3D地形ドレープ
2. **MaskExtension**：敷地ポリゴンでの DEM/3D Tiles くり抜き
3. **ClipExtension**：3D Tiles・点群の断面カット

### データパイプライン

```text
ローカルファイル (GPKG / GeoJSON / GLB)
    ↓
Web Worker (sql.js / Arrow-JS)
    ↓
FlatBuffers / GeoArrow / TypedArray (VRAM)
    ↓
deck.gl GPU Direct Render
```

### ロードマップ案

| Phase | 内容 | 効果 |
|-------|------|------|
| 1 | deck.gl + GeoArrow ローダー追加 | 大容量2Dデータの即時表示 |
| 2 | TerrainExtension & MaskExtension | ドレープ・くり抜き実現 |
| 3 | 3D Tiles (1.1) + ClipExtension | 点群・広域モデルの断面表示 |

---
