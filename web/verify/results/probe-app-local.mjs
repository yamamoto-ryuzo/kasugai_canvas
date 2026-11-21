// V5 アプリ化（ローカル連携）検証プローブ (skill: verify-app-local)
//  実行: node web/verify/results/probe-app-local.mjs
//  HTTP のみで検証(Playwright 不要):
//   A1 /api/capabilities ローカル判定(tier=local + fileWrite/cloudRclone/mcpProxy)
//   A2 /api/files PUT→GET→DELETE 往復
//   A4 /api/cloud/status で rclone 検出(version/remotes)
//   A4b 未接続時 /api/cloud/list が 409 でゲートされる
//   A7 納品用ローカル化: 登録→/api/cloud/localize→<dir>_local/ 生成→複製参照確認
//   A3/A5/A6/A8 はブラウザ picker/実リモート/静的配信が必要なため SKIP
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "http://127.0.0.1:8510";
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`); };
const skip = (id, detail) => { results.push({ id, ok: null });
  console.log(`SKIP ${id} :: ${detail}`); };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

// ---------- A1: capabilities ----------
try {
  const c = await j(await fetch(`${API}/api/capabilities`));
  const f = new Set(c.features || []);
  rec("A1", c.tier === "local" && f.has("fileWrite") && f.has("cloudRclone") && f.has("mcpProxy"),
    `tier=${c.tier} features=${(c.features || []).join(",")}`);
} catch (e) { rec("A1", false, `capabilities 失敗: ${e}`); }

// ---------- A2: /api/files 往復 ----------
const probeName = "__probe_app_local__.txt";
try {
  const put = await fetch(`${API}/api/files/default/${probeName}`,
    { method: "PUT", body: "probe-app-local" });
  const list1 = await j(await fetch(`${API}/api/files?project=default`));
  const found = (list1.files || []).some(f => f.name === probeName);
  const del = await fetch(`${API}/api/files/default/${probeName}`, { method: "DELETE" });
  const list2 = await j(await fetch(`${API}/api/files?project=default`));
  const gone = !(list2.files || []).some(f => f.name === probeName);
  rec("A2", put.ok && found && del.ok && gone,
    `PUT=${put.status} list含む=${found} DELETE=${del.status} 削除後=${gone}`);
} catch (e) { rec("A2", false, `/api/files 失敗: ${e}`); }

// ---------- A4: rclone status ----------
try {
  const s = await j(await fetch(`${API}/api/cloud/status`));
  rec("A4", s.installed === true && !!s.version,
    `installed=${s.installed} version=${s.version || "-"} remotes=${(s.remotes || []).join(",") || "none"}`);
} catch (e) { rec("A4", false, `cloud/status 失敗: ${e}`); }

// ---------- A4b: 未接続ゲート ----------
try {
  const r = await fetch(`${API}/api/cloud/list?path=`);
  rec("A4b", r.status === 409, `未接続時 /api/cloud/list → ${r.status}(期待409)`);
} catch (e) { rec("A4b", false, `cloud/list 失敗: ${e}`); }

// ---------- A7: 納品用ローカル化(end-to-end) ----------
const tmp = mkdtempSync(join(tmpdir(), "kasc_localize_"));
const projDir = join(tmp, "probeproj");
let regId = null;
try {
  mkdirSync(join(projDir, "canvas_data"), { recursive: true });
  writeFileSync(join(projDir, "canvas_data", "pts.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature",
      geometry: { type: "Point", coordinates: [139.75, 35.68] }, properties: { n: 1 } }] }));
  const kascText = [
    "title:localize probe",
    "base: ベースマップなし | none",
    "geojson:テスト点 | canvas_data/pts.geojson",
    "",
  ].join("\n");
  writeFileSync(join(projDir, "probe.kasc"), kascText);

  // 登録 → id 取得
  const reg = await j(await fetch(`${API}/api/projects/register`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: join(projDir, "probe.kasc").replace(/\\/g, "/") }) }));
  regId = reg.id;
  if (!regId) throw new Error(`register 失敗: ${JSON.stringify(reg).slice(0, 160)}`);

  // localize 実行(scope=project で出力をプロジェクト内へ限定)
  const loc = await j(await fetch(`${API}/api/cloud/localize`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: regId, scope: "project" }) }));

  const localDir = join(projDir, "probeproj_local");
  const altDir = join(tmp, "probeproj_local");
  const outDir = existsSync(localDir) ? localDir : altDir;
  const made = existsSync(outDir);
  let kascLocal = null, dataCopied = false, relRef = false;
  if (made) {
    const { readdirSync } = await import("node:fs");
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    const files = walk(outDir);
    const kascFile = files.find(f => f.endsWith(".kasc"));
    if (kascFile) {
      kascLocal = readFileSync(kascFile, "utf8");
      relRef = /canvas_data[\\/]/.test(kascLocal) || /["'](\.\/)?canvas_data\//.test(kascLocal);
    }
    dataCopied = files.some(f => f.endsWith("pts.geojson"));
  }
  const origIntact = readFileSync(join(projDir, "probe.kasc"), "utf8") === kascText;
  rec("A7", made && dataCopied && origIntact && loc?.ok !== false,
    `_local作成=${made} data同梱=${dataCopied} 元無変更=${origIntact} resp=${JSON.stringify(loc).slice(0, 140)}`);
} catch (e) { rec("A7", false, `localize 失敗: ${String(e).slice(0, 200)}`); }
finally {
  if (regId) await fetch(`${API}/api/projects/${regId}`, { method: "DELETE" }).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- SKIP 項目 ----------
skip("A3", "File System Access API は headless で picker 不可 → 手動/実機確認");
skip("A5", "cloud: スキーム読込は rclone serve 接続中の実リモートが必要(要実機)");
skip("A6", "Windows ドライブ割当(K:)は実リモート接続が必要(要実機)");
skip("A8", "静的配信での capability 非公開は CDN/コンテナ実環境が必要(要実機)");

const fails = results.filter(r => r.ok === false).length;
const skips = results.filter(r => r.ok === null).length;
console.log(`\n==== ${results.filter(r => r.ok === true).length}/${results.length - skips} PASS (${skips} skip) ====`);
process.exit(fails ? 1 : 0);
