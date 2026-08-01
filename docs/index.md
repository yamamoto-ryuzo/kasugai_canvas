---
layout: "default"
title: "はじめに"
nav_order: 0
---

# KASUGAI Canvas 技術選定

ローカルPC・ブラウザ完結で動作する 2D/3D データ可視化システム「KASUGAI Canvas」の技術選定ドキュメントです。

## KASUGAI Canvas の核

- **描画エンジン**：**deck.gl + Three.js**
  - `deck.gl`：2D/3D/Tiles/Buffers を同一 GPU コンテキストで一括描画
  - `Three.js`：点群、3DGS、GLB 等の高度な 3D 表現を補完
- **ロード・変換**：**loaders.gl + Web Worker**
- **目的**：同じ canvas（同一 GPU 空間）で 2D 図面、3D モデル、点群、3DGS、地形タイルを重ねて描画

## 章構成

| # | 章 | 内容 |
|---|----|------|
| 1 | [データ]({% link 01-データ.md %}) | KASUGAI Canvas 向け 2D/3D/点群/3DGS/FGDB の最適フォーマット |
| 2 | [ライブラリ]({% link 02-ライブラリ.md %}) | deck.gl + Three.js + 補完ライブラリの選定と役割 |
| 3 | [システム構成]({% link 03-システム構成.md %}) | ローカルPC、サーバーレス、KASUGAI 組み込み構成 |
