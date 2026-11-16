// スケールバーの全長(ラベル値)の選択。各エンジンで共通利用する。
// 全長は従来の 1,2,5 系のキリの良い値のうち、4分割メモリの各区間が
// 2の倍数(偶数)になるもの、すなわち 8の倍数だけを使う:
//   200, 1000, 2000, 5000, 10000, 20000, 50000, …
//   (各区間 = 50m, 250m, 500m, 1250m, 2500m, …)
// 200m 未満には条件を満たす 1,2,5 系の値が存在しないため、
// target < 200 では従来の 1,2,5 丸めにフォールバックする。

const TOTALS = [200];
for (let p = 1000; p <= 1e11; p *= 10) {
  for (const d of [1, 2, 5]) TOTALS.push(d * p);
}

// 従来の 1,2,5 系丸め (フォールバック用)
const stdCeil = v => {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const d of [1, 2, 5, 10]) if (d * p >= v) return d * p;
};
const stdFloor = v => {
  const p = 10 ** Math.floor(Math.log10(v));
  let m = 1;
  for (const d of [1, 2, 5, 10]) if (d * p <= v) m = d;
  return m * p;
};

/** target 以上で最小の許容全長 (minWidth 方式: OL / Cesium 向け) */
export function scaleNiceCeil(target) {
  if (!(target >= TOTALS[0])) return stdCeil(target);
  for (const c of TOTALS) if (c >= target) return c;
  return TOTALS[TOTALS.length - 1];
}

/** max 以下で最大の許容全長 (maxWidth 方式: Leaflet / MapLibre 向け) */
export function scaleNiceFloor(max) {
  let r;
  for (const c of TOTALS) {
    if (c > max) break;
    r = c;
  }
  return r ?? stdFloor(max);
}
