// Usage: node pyeval.mjs <file.py>  — QGIS内で実行し result を表示
import { readFileSync } from "node:fs";
const code = readFileSync(process.argv[2], "utf8");
const res = await fetch("http://127.0.0.1:58376/api/pyeval", {
  method: "POST",
  headers: {
    "Authorization": "Bearer 01bc0b414257d081ab34639f45110f51a97c8c64596d496b",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ code }),
});
const j = await res.json();
if (j.error) { console.error("ERROR:", j.error); process.exit(1); }
console.log(typeof j.result === "string" ? j.result : JSON.stringify(j.result, null, 1));
