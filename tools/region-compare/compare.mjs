#!/usr/bin/env node
// 地域比較シート生成スクリプト（イチBizアワード2026 試作）
//
// 2〜3の候補地域を同じ観点で確認し、属性・データの有無を
// 「確認済み / データなし / 未確認」に分けて記録した比較シート
// (Markdown) を生成する。併せて候補地点の GeoJSON と .kasc
// カメラプリセット行も出力する。
//
// 使い方:
//   node tools/region-compare/compare.mjs [options]
//
// options:
//   --radius <m>          比較範囲の半径（既定 1000）
//   --zoom <z>            不動産情報ライブラリのタイルズーム（既定 11）
//   --from <YYYYN>        XPT001 の対象期間 from（既定 20254）
//   --to <YYYYN>          XPT001 の対象期間 to（既定 = from）
//   --areas "名前:lat:lon,名前:lat:lon"  候補地域の上書き
//   --app-url <url>       パーマリンクの基になるアプリURL（既定 http://localhost:8510/）
//   --project <id>        パーマリンクの project 値（既定 reinfolib）
//   --transit-time <iso>  所要時間検索の出発時刻（既定: 直近の水曜 08:00 JST）
//   --relay <url>         /api/reinfolib 中継経由にする（例 http://localhost:8510）
//   --out <dir>           出力先（既定 tools/region-compare/out）
//
// APIキー: 環境変数 REINFOLIB_API_KEY。未設定時は workers/.dev.vars を参照する。
// --relay 指定時はキー不要（サーバー側が注入）。キーも中継も無い場合、
// API内項目は「未確認」として記録され、手順と外部APIの結果は出力される。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const UA = "KASUGAI-Canvas region-compare/0.1 (g-idea award prototype)";
const UPSTREAM_BASE = "https://www.reinfolib.mlit.go.jp/ex-api/external";
const MLIT_ATTR = "不動産情報ライブラリ（国土交通省）";

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    radius: 1000,
    zoom: 11,
    from: "20254",
    to: null,
    areas: null,
    appUrl: "http://localhost:8510/",
    project: "reinfolib",
    transitTime: null,
    relay: null,
    out: path.join(HERE, "out"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[++i];
    switch (a) {
      case "--radius": opts.radius = Number(v); break;
      case "--zoom": opts.zoom = Number(v); break;
      case "--from": opts.from = String(v); break;
      case "--to": opts.to = String(v); break;
      case "--areas": opts.areas = v; break;
      case "--app-url": opts.appUrl = v; break;
      case "--project": opts.project = v; break;
      case "--transit-time": opts.transitTime = v; break;
      case "--relay": opts.relay = v.replace(/\/$/, ""); break;
      case "--out": opts.out = v; break;
      default:
        if (a === "--help" || a === "-h") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 33).join("\n")); process.exit(0); }
        throw new Error(`不明なオプション: ${a}`);
    }
  }
  if (!opts.to) opts.to = opts.from;
  return opts;
}

// ---------- 候補地域（既定: 東京駅から概ね30分圏・3県にまたぐ3駅） ----------

const DEFAULT_AREAS = [
  { key: "A", name: "中野", station: "中野駅", municipality: "中野区（東京都）", lat: 35.7058, lon: 139.6655 },
  { key: "B", name: "川口", station: "川口駅", municipality: "川口市（埼玉県）", lat: 35.8019, lon: 139.7175 },
  { key: "C", name: "市川", station: "市川駅", municipality: "市川市（千葉県）", lat: 35.7287, lon: 139.9076 },
];
const TOKYO_STATION = { lat: 35.6812, lon: 139.7671 };

// ---------- 確認項目（不動産情報ライブラリ タイルAPI） ----------

// kind: point=圏内件数 / polygon=駅地点の区域内判定+圏内件数
// extra: セルに追記する補足（圏内地物の属性から抽出）
// nameOf: polygon 用。駅地点が区域内の地物の表示名を返す
const truthy = v => v === 1 || v === "1" || v === true || /^true$/i.test(String(v));
const SHELTER_FLAGS = [
  ["flood_flag", "洪水"], ["inland_flooding_flag", "内水"], ["high_tide_flag", "高潮"],
  ["tsunami_flag", "津波"], ["earthquake_flag", "地震"], ["landslide_flag", "土砂"], ["large_fire_flag", "大規模火災"],
];
const DATASETS = [
  { id: "price", api: "XPT001", label: "不動産取引価格ポイント", kind: "point",
    params: o => `from=${encodeURIComponent(o.from)}&to=${encodeURIComponent(o.to)}`,
    note: o => `対象期間 ${o.from.slice(0, 4)}Q${o.from.slice(4)}`,
    extra: near => {
      const v = near.map(f => f.properties?.u_transaction_price_unit_price_square_meter_ja || f.properties?.u_transaction_price_total_ja)
        .find(v => v && String(v).trim());
      return v ? `例:${v}` : "";
    } },
  { id: "shelter", api: "XGT001", label: "指定緊急避難場所", kind: "point", params: () => "",
    extra: near => {
      const flags = SHELTER_FLAGS.filter(([k]) => near.some(f => truthy(f.properties?.[k]))).map(([, l]) => l);
      return flags.length ? `対象災害:${flags.join("・")}` : "";
    } },
  { id: "station", api: "XKT015", label: "駅別乗降客数", kind: "point", params: () => "",
    extra: (near, area) => {
      const base = area.station.replace(/駅$/, "");
      const hit = near.find(f => f.properties?.S12_001_ja === base);
      if (!hit) return "候補駅の地物なし";
      const p = hit.properties;
      return `候補駅あり（${p.S12_002_ja || ""}・${p.S12_003_ja || ""}）`;
    } },
  { id: "zoning", api: "XKT002", label: "用途地域", kind: "polygon", params: () => "",
    nameOf: f => f.properties?.use_area_ja },
  // XKT026〜028 は z=14〜15 指定必須（z11 では HTTP 400）
  { id: "flood", api: "XKT026", label: "洪水浸水想定区域（想定最大規模）", kind: "polygon", zoom: 14, params: () => "", group: "hazard" },
  { id: "tide", api: "XKT027", label: "高潮浸水想定区域", kind: "polygon", zoom: 14, params: () => "", group: "hazard" },
  { id: "tsunami", api: "XKT028", label: "津波浸水想定", kind: "polygon", zoom: 14, params: () => "", group: "hazard" },
  { id: "landslide", api: "XKT029", label: "土砂災害警戒区域", kind: "polygon", params: () => "", group: "hazard" },
  { id: "school", api: "XKT004", label: "小学校区", kind: "polygon", params: () => "",
    nameOf: f => f.properties?.A27_004_ja },
];

// ---------- 地理計算 ----------

const EARTH_R = 6371000;
function haversineM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

function lonToX(lon, z) { const n = 2 ** z; return Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n))); }
function latToY(lat, z) {
  const n = 2 ** z;
  const r = Math.min(85, Math.max(-85, lat)) * Math.PI / 180;
  return Math.min(n - 1, Math.max(0, Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)));
}

// 円を覆う XYZ タイル列挙（円の外接矩形で近似）
function tilesForCircle(lat, lon, radiusM, z) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const tiles = [];
  for (let x = lonToX(lon - dLon, z); x <= lonToX(lon + dLon, z); x++) {
    for (let y = latToY(lat + dLat, z); y <= latToY(lat - dLat, z); y++) tiles.push({ z, x, y });
  }
  return tiles;
}

// 点がポリゴン（外環の内・内環の外）にあるか（レイキャスト）
function pointInPolygon(lon, lat, rings) {
  if (!rings?.length) return false;
  const inside = ring => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  if (!inside(rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inside(rings[k])) return false;
  return true;
}

// 地物の代表点距離（点=座標、線・面=頂点最小距離。駅地点が面内なら0）
function featureDistance(feature, lat, lon) {
  const g = feature?.geometry;
  if (!g) return Infinity;
  const pts = [];
  const walk = coords => {
    if (typeof coords?.[0] === "number") pts.push(coords);
    else if (Array.isArray(coords)) coords.forEach(walk);
  };
  walk(g.coordinates);
  if ((g.type === "Polygon" || g.type === "MultiPolygon")) {
    const rings = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    if (rings.some(r => pointInPolygon(lon, lat, r))) return 0;
  }
  let min = Infinity;
  for (const [x, y] of pts) {
    const d = haversineM(lat, lon, y, x);
    if (d < min) min = d;
  }
  return min;
}

// ---------- HTTP ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, { headers = {}, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(45000) });
      if (resp.ok) return await resp.json();
      last = new Error(`HTTP ${resp.status}`);
      last.status = resp.status;
      if (resp.status === 401 || resp.status === 403 || resp.status === 400 || resp.status === 404) break;
    } catch (e) { last = e; }
    await sleep(1000 * 2 ** i);
  }
  throw last;
}

// ---------- 不動産情報ライブラリ ----------

function loadApiKey() {
  if (process.env.REINFOLIB_API_KEY?.trim()) return { key: process.env.REINFOLIB_API_KEY.trim(), source: "env" };
  const devvars = path.join(REPO, "workers", ".dev.vars");
  try {
    for (const line of fs.readFileSync(devvars, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*REINFOLIB_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return { key: m[1], source: "workers/.dev.vars" };
    }
  } catch { /* 無ければ未設定 */ }
  return { key: null, source: null };
}

function reinfolibFetcher(opts, keyInfo) {
  const headers = keyInfo.key ? { "Ocp-Apim-Subscription-Key": keyInfo.key } : {};
  const wrap = url => opts.relay ? `${opts.relay}/api/reinfolib?url=${encodeURIComponent(url)}` : url;
  return async (dataset, tile) => {
    const params = dataset.params(opts);
    const upstream = `${UPSTREAM_BASE}/${dataset.api}?response_format=geojson&z=${tile.z}&x=${tile.x}&y=${tile.y}${params ? `&${params}` : ""}`;
    const json = await fetchJson(wrap(upstream), { headers });
    return Array.isArray(json?.features) ? json.features : [];
  };
}

function dedup(features) {
  const seen = new Set(), out = [];
  for (const f of features) {
    const k = `${JSON.stringify(f.geometry)}|${f.properties?._id ?? f.properties?.common_id ?? ""}`;
    if (!seen.has(k)) { seen.add(k); out.push(f); }
  }
  return out;
}

// ---------- 外部API ----------

async function fetchTransitTime(area, timeIso) {
  const url = `https://api.transitous.org/api/v1/plan?fromPlace=${area.lat},${area.lon}` +
    `&toPlace=${TOKYO_STATION.lat},${TOKYO_STATION.lon}` +
    `&time=${encodeURIComponent(timeIso)}&arriveBy=false`;
  const json = await fetchJson(url);
  const its = (json.itineraries || []).filter(i => i.duration > 0);
  if (!its.length) return { status: "データなし", detail: "経路が見つかりません" };
  its.sort((a, b) => a.duration - b.duration);
  const best = its[0];
  const legs = best.legs || [];
  return {
    status: "確認済み",
    minutes: Math.round(best.duration / 60),
    transfers: best.transfers ?? legs.filter(l => l.mode !== "WALK").length - 1,
    startTime: best.startTime,
  };
}

async function fetchOverpass(area, radiusM) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
  ];
  const query = `[out:json][timeout:25];
(
  nwr["amenity"="veterinary"](around:${radiusM},${area.lat},${area.lon})->.v;
);
.v out count;
.v out tags center 6;
nwr["leisure"~"^(park|dog_park|garden)$"](around:${radiusM},${area.lat},${area.lon})->.p;
.p out count;
.p out tags center 6;`;
  let last;
  // 公共インスタンスは混雑で 502/429 を返すことがある。429 時は30秒待機が推奨
  const waits = [2000, 8000, 20000, 30000];
  for (const ep of endpoints) {
    for (let i = 0; i < waits.length; i++) {
      try {
        const resp = await fetch(ep, {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(60000),
        });
        if (!resp.ok) { last = new Error(`HTTP ${resp.status} @ ${new URL(ep).host}`); await sleep(waits[i]); continue; }
        const json = await resp.json();
        const els = json.elements || [];
        const counts = els.filter(e => e.type === "count").map(e => Number(e.tags?.total ?? 0));
        const members = els.filter(e => e.type !== "count");
        const names = elsArr => [...new Set(elsArr.map(e => e.tags?.name).filter(Boolean))].slice(0, 5);
        // out count→要素 の順に返るため、前半6要素=動物病院・後半=公園とは限らない。
        // leisure タグで判別する
        const vets = members.filter(e => e.tags?.amenity === "veterinary");
        const parks = members.filter(e => e.tags?.leisure);
        return {
          status: "確認済み",
          osmBase: json.osm3s?.timestamp_osm_base || null,
          vet: { count: counts[0] ?? vets.length, names: names(vets) },
          park: { count: counts[1] ?? parks.length, names: names(parks) },
        };
      } catch (e) { last = e; await sleep(waits[i]); }
    }
  }
  throw last;
}

// ---------- 集計 ----------

function summarizeDataset(dataset, features, area, radiusM) {
  const tileCount = features.length;
  const near = features.filter(f => featureDistance(f, area.lat, area.lon) <= radiusM);
  const keys = [...new Set(near.flatMap(f => Object.keys(f.properties || {})))].sort();
  return { dataset, tileCount, near, keys };
}

function summarizeDatasetCell(dataset, summary, area) {
  const { near } = summary;
  if (dataset.kind === "polygon") {
    if (!near.length) return { status: "データなし", text: "圏内にデータなし" };
    const inside = near.filter(f => featureDistance(f, area.lat, area.lon) === 0);
    const names = dataset.nameOf
      ? [...new Set(inside.map(dataset.nameOf).filter(Boolean))].slice(0, 3)
      : [];
    return inside.length
      ? { status: "確認済み", text: `駅地点が区域内（圏内${near.length}件${names.length ? `・${names.join("/")}` : ""}）` }
      : { status: "確認済み", text: `駅地点は区域外（圏内${near.length}件）` };
  }
  if (!near.length) return { status: "データなし", text: "圏内にデータなし" };
  const extra = dataset.extra?.(near, area);
  return { status: "確認済み", text: `${near.length}件${extra ? ` ${extra}` : ""}` };
}

// ---------- 次の水曜 08:00 JST ----------

function nextTransitTime() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 3600 * 1000);
  for (let i = 0; i < 8; i++) {
    // JST で i 日後の 08:00 を表す Date（UTC内部表現は -9h）
    const j = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + i, 8, 0));
    if (j.getUTCDay() === 3 && j.getTime() - 9 * 3600 * 1000 > now.getTime()) {
      return `${j.toISOString().slice(0, 10)}T08:00+09:00`;
    }
  }
  return `${jstNow.toISOString().slice(0, 10)}T08:00+09:00`;
}

// ---------- メイン ----------

async function main() {
  const opts = parseArgs(process.argv);
  const areas = opts.areas
    ? opts.areas.split(",").map((s, i) => {
        const [name, lat, lon] = s.split(":");
        return { key: String.fromCharCode(65 + i), name, station: `${name}駅`, municipality: name, lat: Number(lat), lon: Number(lon) };
      })
    : DEFAULT_AREAS;
  const transitTime = opts.transitTime || nextTransitTime();
  const keyInfo = loadApiKey();
  const useMlit = !!(keyInfo.key || opts.relay);
  if (useMlit) {
    console.log(`不動産情報ライブラリ: ${opts.relay ? `中継 ${opts.relay}` : `直接接続（キー: ${keyInfo.source}）`}`);
  } else {
    console.log("不動産情報ライブラリ: APIキー未設定のため API内項目は「未確認」で記録します");
  }

  const results = areas.map(area => ({ area, datasets: {}, transit: null, overpass: null, errors: [] }));
  const fetchTile = useMlit ? reinfolibFetcher(opts, keyInfo) : null;

  for (const res of results) {
    const { area } = res;
    const tiles = tilesForCircle(area.lat, area.lon, opts.radius, opts.zoom);
    console.log(`\n[${area.key}] ${area.station}（タイル ${tiles.length}枚・半径 ${opts.radius}m）`);
    if (useMlit) {
      for (const ds of DATASETS) {
        try {
          const dsTiles = ds.zoom ? tilesForCircle(area.lat, area.lon, opts.radius, ds.zoom) : tiles;
          const perTile = [];
          for (const t of dsTiles) {
            perTile.push(...await fetchTile(ds, t));
            await sleep(300); // 公式案内の「連続実行しない」に合わせる
          }
          res.datasets[ds.id] = summarizeDataset(ds, dedup(perTile), area, opts.radius);
          const s = res.datasets[ds.id];
          console.log(`  ${ds.api} ${ds.label}: タイル内${s.tileCount}件・圏内${s.near.length}件`);
        } catch (e) {
          res.datasets[ds.id] = { dataset: ds, error: e.message, tileCount: null, near: [], keys: [] };
          res.errors.push(`${ds.api}: ${e.message}`);
          console.log(`  ${ds.api} ${ds.label}: 失敗 ${e.message}`);
        }
      }
    }
    try {
      res.transit = await fetchTransitTime(area, transitTime);
      console.log(`  所要時間: ${res.transit.status === "確認済み" ? `${res.transit.minutes}分（乗換${res.transit.transfers}）` : res.transit.detail}`);
    } catch (e) {
      res.transit = { status: "未確認", detail: e.message };
      res.errors.push(`transit: ${e.message}`);
      console.log(`  所要時間: 失敗 ${e.message}`);
    }
    try {
      res.overpass = await fetchOverpass(area, opts.radius);
      console.log(`  動物病院: ${res.overpass.vet.count}件 / 公園等: ${res.overpass.park.count}件`);
    } catch (e) {
      res.overpass = { status: "未確認", detail: e.message };
      res.errors.push(`overpass: ${e.message}`);
      console.log(`  Overpass: 失敗 ${e.message}`);
    }
  }

  const { md, geojson, kasc } = buildOutputs(opts, areas, results, { transitTime, useMlit, keySource: keyInfo.source });
  fs.mkdirSync(opts.out, { recursive: true });
  const sheetPath = path.join(opts.out, "comparison-sheet.md");
  fs.writeFileSync(sheetPath, md, "utf8");
  fs.writeFileSync(path.join(opts.out, "areas.geojson"), JSON.stringify(geojson, null, 2), "utf8");
  fs.writeFileSync(path.join(opts.out, "region-compare.kasc"), kasc, "utf8");
  console.log(`\n出力: ${sheetPath}`);
  console.log(`      ${path.join(opts.out, "areas.geojson")}`);
  console.log(`      ${path.join(opts.out, "region-compare.kasc")}`);
}

// ---------- 出力 ----------

function shareUrl(opts, area) {
  const base = opts.appUrl.endsWith("/") ? opts.appUrl : `${opts.appUrl}/`;
  const p = new URLSearchParams({ longitude: area.lon.toFixed(6), latitude: area.lat.toFixed(6), height: "2000.0", pitch: "-60.00", heading: "0.00", project: opts.project });
  return `${base}?${p}`;
}

function statusMark(status) {
  return { "確認済み": "◯", "データなし": "△", "未確認": "✗" }[status] || "？";
}

function buildOutputs(opts, areas, results, meta) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const cell = (status, text) => `${statusMark(status)}${status} ${text || ""}`.trim();

  // 候補一覧
  const areaRows = results.map(r =>
    `| ${r.area.key} | ${r.area.station} | ${r.area.municipality} | ${r.area.lat}, ${r.area.lon} | [地図で見る](${shareUrl(opts, r.area)}) |`);

  // 比較表（行=確認項目 / 列=候補）
  const header = `| 区分 | 確認項目 | ${results.map(r => `${r.area.key} ${r.area.station}`).join(" | ")} | 出典・基準日 |`;
  const sep = `|---|---|${results.map(() => "---").join("|")}|---|`;
  const rows = [];

  const dsCell = (r, ds) => {
    const s = r.datasets[ds.id];
    if (!meta.useMlit) return cell("未確認", "APIキー未設定");
    if (!s || s.error) return cell("未確認", s?.error || "");
    const c = summarizeDatasetCell(ds, s, r.area);
    return cell(c.status, c.text);
  };

  const rowFor = (kubun, label, ds, src) =>
    `| ${kubun} | ${label} | ${results.map(r => dsCell(r, ds)).join(" | ")} | ${src} |`;

  rows.push(rowFor("API内", "不動産取引価格ポイント", DATASETS.find(d => d.id === "price"), `${MLIT_ATTR} XPT001・${opts.from.slice(0, 4)}Q${opts.from.slice(4)}`));
  rows.push(rowFor("API内", "指定緊急避難場所", DATASETS.find(d => d.id === "shelter"), `${MLIT_ATTR} XGT001`));
  rows.push(rowFor("API内", "駅別乗降客数", DATASETS.find(d => d.id === "station"), `${MLIT_ATTR} XKT015（令和5年度）`));
  rows.push(rowFor("API内", "用途地域", DATASETS.find(d => d.id === "zoning"), `${MLIT_ATTR} XKT002（令和7年度）`));

  // 防災（4災害を1行に集約）
  const hazardDs = DATASETS.filter(d => d.group === "hazard");
  const hazardCells = results.map(r => {
    if (!meta.useMlit) return cell("未確認", "APIキー未設定");
    const parts = hazardDs.map(ds => {
      const s = r.datasets[ds.id];
      const short = { flood: "洪水", tide: "高潮", tsunami: "津波", landslide: "土砂" }[ds.id];
      if (!s) return `${short}:−`;
      if (s.error) return `${short}:未確認`;
      const inside = s.near.some(f => featureDistance(f, r.area.lat, r.area.lon) === 0);
      return `${short}:${inside ? "区域内" : s.near.length ? "区域外" : "なし"}`;
    });
    const anyErr = hazardDs.some(ds => r.datasets[ds.id]?.error);
    return cell(anyErr ? "未確認" : "確認済み", parts.join("・"));
  });
  rows.push(`| API内 | 防災情報（浸水想定・警戒区域） | ${hazardCells.join(" | ")} | ${MLIT_ATTR} XKT026/027/028/029（令和6年度） |`);

  rows.push(rowFor("API内", "小学校区", DATASETS.find(d => d.id === "school"), `${MLIT_ATTR} XKT004（令和5年度）`));

  // API外
  const transitCells = results.map(r => {
    const t = r.transit;
    if (!t) return cell("未確認", "");
    if (t.status === "確認済み") return cell("確認済み", `${t.minutes}分・乗換${t.transfers}回`);
    return cell(t.status, t.detail || "");
  });
  rows.push(`| API外 | 東京駅までの所要時間 | ${transitCells.join(" | ")} | Transitous（GTFS非公式）・${transitLabel(meta.transitTime)}出発 |`);

  const vetCells = results.map(r => {
    const o = r.overpass;
    if (!o || o.status !== "確認済み") return cell(o?.status || "未確認", o?.detail || "");
    const n = o.vet.names.length ? `（例: ${o.vet.names.slice(0, 2).join("、")}）` : "";
    return cell("確認済み", `${o.vet.count}件${n}`);
  });
  rows.push(`| API外 | 動物病院（半径内） | ${vetCells.join(" | ")} | © OpenStreetMap contributors（Overpass）・DB時点 ${osmBaseLabel(results)} |`);

  const parkCells = results.map(r => {
    const o = r.overpass;
    if (!o || o.status !== "確認済み") return cell(o?.status || "未確認", o?.detail || "");
    const n = o.park.names.length ? `（例: ${o.park.names.slice(0, 2).join("、")}）` : "";
    return cell("確認済み", `${o.park.count}件${n}`);
  });
  rows.push(`| API外 | 公園・緑地・ドッグラン（半径内） | ${parkCells.join(" | ")} | © OpenStreetMap contributors（Overpass）・DB時点 ${osmBaseLabel(results)} |`);

  // 一次情報（常に未確認から開始）
  const manualCells = label => results.map(() => cell("未確認", label));
  rows.push(`| 一次情報 | 避難所のペット受入条件 | ${manualCells("自治体の防災計画・避難所案内を確認").join(" | ")} | 各自治体 |`);
  rows.push(`| 一次情報 | 公園のペット同伴ルール | ${manualCells("自治体の施設案内を確認").join(" | ")} | 各自治体 |`);

  // 属性の有無（データセット別 属性キー一覧）
  const attrLines = DATASETS.map(ds => {
    const unions = new Set();
    let anyData = false;
    for (const r of results) {
      const s = r.datasets[ds.id];
      if (s?.near?.length) anyData = true;
      (s?.keys || []).forEach(k => unions.add(k));
    }
    if (!meta.useMlit) return `- ${ds.label}（${ds.api}）: 未確認（APIキー未設定）`;
    const list = [...unions].slice(0, 15).join(", ");
    return `- ${ds.label}（${ds.api}）: ${anyData ? `属性 ${unions.size}種（${list}${unions.size > 15 ? " 他" : ""}）` : "圏内データなしのため属性未確認"}`;
  });

  // 未確認事項の集約
  const pending = [];
  for (const r of results) {
    if (!meta.useMlit) { pending.push(`- ${r.area.station}: 不動産情報ライブラリ全項目（APIキー未設定。REINFOLIB_API_KEY を設定して再実行）`); break; }
    for (const ds of DATASETS) {
      const s = r.datasets[ds.id];
      if (s?.error) pending.push(`- ${r.area.station}: ${ds.label}（${ds.api}）取得失敗 — ${s.error}`);
    }
    if (r.transit?.status !== "確認済み") pending.push(`- ${r.area.station}: 所要時間 ${r.transit?.status || "未確認"}（${r.transit?.detail || ""}）`);
    if (r.overpass?.status !== "確認済み") pending.push(`- ${r.area.station}: Overpass ${r.overpass?.status || "未確認"}（${r.overpass?.detail || ""}）`);
  }
  pending.push(`- 全候補: 避難所のペット受入条件・公園のペット同伴ルール（自治体一次情報。候補確定後に各自治体 ${results.map(r => r.area.municipality).join("・")} で確認）`);
  pending.push(`- 全候補: Transitous の所要時間は非公式 GTFS ベース。確定候補は公式時刻表で目視確認`);
  pending.push(`- 全候補: OSM の動物病院・公園は網羅性が地域差あり。一次情報（自治体・獣医師会）での補完確認`);

  const md = `# 地域比較シート（初版）— 住まい候補地域の比較支援

生成日: ${today}（\`tools/region-compare/compare.mjs\` による自動生成）
比較条件: 各候補駅から半径 ${opts.radius}m / 取引価格は ${opts.from.slice(0, 4)}Q${opts.from.slice(4)} / 所要時間は ${transitLabel(meta.transitTime)}出発・経路検索の最速便
記号: ◯確認済み（実データ取得・属性確認済み） / △データなし（API応答は正常・圏内データなし） / ✗未確認（取得失敗・未接続・一次情報未確認）

## 候補地域

| 候補 | 駅 | 自治体 | 座標 | 地図 |
|---|---|---|---|---|
${areaRows.join("\n")}

## 比較表

${header}
${sep}
${rows.join("\n")}

## 属性の有無（圏内データで確認できた属性キー）

${attrLines.join("\n")}

## 未確認事項

${pending.join("\n")}

## 操作手順（本シートの再現方法）

1. APIキーを用意する（環境変数 \`REINFOLIB_API_KEY\` または \`workers/.dev.vars\`。ローカルサーバー起動中は \`--relay http://localhost:8510\` でも可）
2. \`node tools/region-compare/compare.mjs\` を実行する（候補変更は \`--areas "名前:緯度:経度,…"\`）
3. 出力された \`out/comparison-sheet.md\`（本表）・\`out/areas.geojson\`（候補地点＋半径円）・\`out/region-compare.kasc\`（各地域のカメラプリセット行）を確認する
4. 「地図で見る」リンクまたは .kasc の cam: 行で各地域へ移動し、reinfolib プラグインのレイヤー表示と本表の値を目視で照合する
5. 未確認項目は出典を確認してから「確認済み」に更新する（一次情報は自治体の案内を参照）

## 出典一覧

- ${MLIT_ATTR} — XPT001・XGT001・XKT015・XKT002・XKT026/027/028/029・XKT004（${today} 取得・${meta.useMlit ? (opts.relay ? `${opts.relay} 中継経由` : "API直接接続") : "未接続"}）
- Transitous（api.transitous.org・コミュニティ GTFS ベース。${today} 取得）— https://transitous.org/sources ・© OpenStreetMap contributors
- OpenStreetMap（Overpass API・DB時点 ${osmBaseLabel(results)}）— © OpenStreetMap contributors（ODbL）
- 自治体一次情報 — ${results.map(r => r.area.municipality).join("・")}（未確認。各自治体の防災計画・施設案内）
`;

  // 候補地点 GeoJSON（駅点＋半径円の近似ポリゴン）
  const circle = (lat, lon, rM, n = 48) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      pts.push([lon + (rM / (111320 * Math.cos(lat * Math.PI / 180))) * Math.cos(a), lat + (rM / 111320) * Math.sin(a)]);
    }
    return [pts];
  };
  // 候補ごとの識別色（QMLのルールベース描画・simplestyle双方で使う。A/B/Cで固定）
  const CANDIDATE_COLORS = ["#d81b60", "#00acc1", "#ffb300"];
  const geojson = {
    type: "FeatureCollection",
    features: results.flatMap((r, i) => {
      const id = "ABC"[i] || String(i + 1);
      const color = CANDIDATE_COLORS[i] || "#d81b60";
      return [
        { type: "Feature", geometry: { type: "Point", coordinates: [r.area.lon, r.area.lat] },
          properties: { name: r.area.station, municipality: r.area.municipality, kind: "候補駅", id, "marker-color": color, "marker-size": "large" } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: circle(r.area.lat, r.area.lon, opts.radius) },
          properties: { name: `${r.area.station} 半径${opts.radius}m`, kind: "比較範囲", id, stroke: color, "stroke-width": 2, "stroke-opacity": 0.85, fill: color, "fill-opacity": 0.07 } },
      ];
    }),
  };

  const kasc = results.map(r => `cam:${r.area.station}周辺|${r.area.lat}|${r.area.lon}|h=2000|p=-60|d=0`).join("\n") + "\n";

  return { md, geojson, kasc };
}

function transitLabel(iso) {
  const d = new Date(iso);
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const wd = "日月火水木金土"[jst.getUTCDay()];
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}（${wd}）${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

function osmBaseLabel(results) {
  const b = results.map(r => r.overpass?.osmBase).find(Boolean);
  return b ? b.slice(0, 10) : "未取得";
}

main().catch(e => { console.error(e); process.exit(1); });
