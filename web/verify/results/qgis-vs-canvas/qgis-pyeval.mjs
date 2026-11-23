// qgis-pyeval.mjs — 起動中 QGIS の geo_driver REST へ任意 Python を投げる
// usage: node qgis-pyeval.mjs <script.py>
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const file = process.argv[2];
if (!file) { console.log("usage: node qgis-pyeval.mjs <script.py>"); process.exit(2); }
const regDir = join(homedir(), ".qgis-live");
const reg = readdirSync(regDir).filter(f => f.endsWith("-geo_driver.json"))
  .map(f => { try { return JSON.parse(readFileSync(join(regDir, f), "utf8")); } catch { return null; } })
  .filter(r => r && r.http_port && existsSync(r.live_dir))
  .sort((a, b) => (b.started || 0) - (a.started || 0))[0];
if (!reg) { console.log("FATAL: no geo_driver registry"); process.exit(2); }
const code = readFileSync(file, "utf8");
const res = await fetch(`http://127.0.0.1:${reg.http_port}/api/pyeval`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
  body: JSON.stringify({ code }),
});
const j = await res.json();
if (j.error) { console.log("PYERROR:", j.error); process.exit(1); }
console.log(j.result ?? JSON.stringify(j));
