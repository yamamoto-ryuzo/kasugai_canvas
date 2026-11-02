// ---- 座標表示形式（度 / 度分秒 / UTM / 平面直角座標系）全エンジン共通 ----
// カーソル座標・地点座標ポップアップで共用する。表示形式は #coords-format の値
export function dmsString(deg, posMark, negMark) {
  const mark = deg < 0 ? negMark : posMark;
  const v = Math.abs(deg);
  const d = Math.floor(v);
  const mFloat = (v - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(1)}"${mark}`;
}

// 横メルカトル(Gauss-Krüger 系)正規化変換。UTM(縮尺0.9996)・平面直角座標系(0.9999)で共用。
// 返り値 x=北方向(m)・y=東方向(m)（いずれも原点基準・縮尺補正込み）
export function gaussKruger(latDeg, lonDeg, lat0Deg, lon0Deg, k0) {
  const a = 6378137;
  const f = 1 / 298.257222101; // GRS80
  const n = f / (2 - f);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = k0 * a / (1 + n) * (1 + n2 / 4 + n4 / 64);
  const alpha = [
    n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288,
    13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630,
    61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880,
    49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
    34729 * n5 / 80640 - 3418889 * n6 / 1995840,
    212378941 * n6 / 319467840,
  ];
  const rad = d => d * Math.PI / 180;
  const nSqrt2 = 2 * Math.sqrt(n) / (1 + n);
  const confLat = phi => Math.atan2(
    Math.sinh(Math.atanh(Math.sin(phi)) - nSqrt2 * Math.atanh(nSqrt2 * Math.sin(phi))), 1);
  const phi = rad(latDeg);
  const lam = rad(lonDeg - lon0Deg);
  const lamCos = Math.cos(lam);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - nSqrt2 * Math.atanh(nSqrt2 * Math.sin(phi)));
  const xi = Math.atan2(t, lamCos);
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(t * t + lamCos * lamCos));
  const xi0 = confLat(rad(lat0Deg));
  let x = A * (xi - xi0);
  let y = A * eta;
  for (let j = 1; j <= 6; j++) {
    x += A * alpha[j - 1] * (Math.sin(2 * j * xi) * Math.cosh(2 * j * eta) - Math.sin(2 * j * xi0));
    y += A * alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { x, y };
}

export function utmString(latDeg, lonDeg) {
  const zone = Math.min(60, Math.max(1, Math.floor((lonDeg + 180) / 6) + 1));
  const { x, y } = gaussKruger(latDeg, lonDeg, 0, zone * 6 - 183, 0.9996);
  const northing = latDeg < 0 ? x + 10000000 : x;
  return `${zone}${latDeg < 0 ? "S" : "N"} E${(y + 500000).toFixed(1)} N${northing.toFixed(1)}`;
}

// 平面直角座標系(JGD2011) 系番号1-19の原点(緯度,経度 度)
const JPX_ZONES = [
  [33, 129.5], [33, 131], [36, 132.166667], [33, 133.5], [36, 134.333333],
  [36, 136], [36, 137.166667], [36, 138.5], [36, 139.833333], [40, 140.833333],
  [44, 140.25], [44, 142.25], [44, 144.25], [26, 142], [26, 127.5],
  [26, 124], [26, 131], [20, 136], [26, 154],
];
const JPX_ZONE_NAMES = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX"];

export function jpxString(latDeg, lonDeg) {
  // 最も近い原点の系を選ぶ（日本域外では単なる最近傍になる点に注意）
  let zone = 0;
  let best = Infinity;
  const cosLat = Math.cos(latDeg * Math.PI / 180);
  JPX_ZONES.forEach(([la, lo], i) => {
    const d = (latDeg - la) ** 2 + ((lonDeg - lo) * cosLat) ** 2;
    if (d < best) { best = d; zone = i; }
  });
  const [la, lo] = JPX_ZONES[zone];
  const { x, y } = gaussKruger(latDeg, lonDeg, la, lo, 0.9999);
  return `${JPX_ZONE_NAMES[zone]}系 X=${x.toFixed(3)} Y=${y.toFixed(3)}`;
}

// 緯度経度を #coords-format（deg/dms/utm/jpx）の設定形式で文字列化
export function formatLatLng(latDeg, lonDeg) {
  const format = document.querySelector("#coords-format")?.value || "deg";
  switch (format) {
    case "dms": return `${dmsString(latDeg, "N", "S")} ${dmsString(lonDeg, "E", "W")}`;
    case "utm": return `UTM ${utmString(latDeg, lonDeg)}`;
    case "jpx": return jpxString(latDeg, lonDeg);
    default: return `${latDeg.toFixed(5)}, ${lonDeg.toFixed(5)}`;
  }
}

// ---- 検索窓の座標直入力パーサ ----
// "35.6,139.7" / "139.7,35.6" / "N35°36'50" E139°43'0"" / "35度36分 139度43分" 等を
// {lat,lng} に正規化する。座標と解釈できなければ null
export function parseCoordinateQuery(text) {
  const s = String(text || "").trim()
    .replace(/[，、]/g, ",")
    .replace(/北緯/g, "N").replace(/南緯/g, "S").replace(/東経/g, "E").replace(/西経/g, "W")
    .replace(/度/g, "°").replace(/分/g, "'").replace(/秒/g, '"')
    .replace(/[′’`]/g, "'").replace(/[″”]/g, '"');
  if (!s || !/\d/.test(s)) return null;
  const orderLatLng = (va, vb) => {
    const aIsLon = va.hemi === "E" || va.hemi === "W" || (Math.abs(va.v) > 90 && Math.abs(vb.v) <= 90);
    const bIsLat = vb.hemi === "N" || vb.hemi === "S";
    const lat = (aIsLon && !bIsLat) || bIsLat ? vb.v : va.v;
    const lng = (aIsLon && !bIsLat) || bIsLat ? va.v : vb.v;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  };
  const parseComponent = str => {
    const m = String(str).trim().match(/^([NSEW])?\s*([+-]?\d+(?:\.\d+)?)(?:\s*°\s*(\d+(?:\.\d+)?))?(?:\s*'\s*(\d+(?:\.\d+)?))?(?:\s*")?\s*([NSEW])?$/i);
    if (!m) return null;
    let v = Math.abs(parseFloat(m[2])) + (Number(m[3]) || 0) / 60 + (Number(m[4]) || 0) / 3600;
    const hemi = (m[1] || m[5] || "").toUpperCase();
    if (hemi === "S" || hemi === "W" || m[2].startsWith("-")) v = -v;
    return { v, hemi };
  };
  // コンマ区切りを最優先で試し、駄目なら空白区切りの全分割点を試す
  const candidates = s.includes(",")
    ? s.split(",").map(p => p.trim()).filter(Boolean)
    : s.split(/\s+/).filter(Boolean);
  for (let i = 1; i < candidates.length; i++) {
    const a = parseComponent(candidates.slice(0, i).join(" "));
    const b = parseComponent(candidates.slice(i).join(" "));
    if (a && b) {
      const result = orderLatLng(a, b);
      if (result) return result;
    }
  }
  return null;
}
