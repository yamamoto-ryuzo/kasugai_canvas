---
layout: "default"
title: "5. deck.gl の強力機能"
nav_order: "5"
---

## 5. deck.gl の強力機能

| 拡張 | 機能 | 用途例 |
|------|------|--------|
| **TerrainExtension** | 2D図面・境界を3D地形にドレープ | 施工区画線、道路中心線の地形吸着表示 |
| **MaskExtension** | 2Dポリゴンで DEM / 3D Tiles をくり抜き | 敷地枠内のみ3D地形を表示 |
| **ClipExtension** | 3D Tiles ・点群の断面カット | 建物内部、トンネル断面、点群高さスライス |

- いずれも **GPU シェーダー / ステンシル** で処理するため、大容量データでも重くならない