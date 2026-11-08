// bridge-hub 依存パスの回帰検証（Playwright + page.route スタブ + 実ページ/実モジュール）
// web/ を静的配信して /cesium/ を headless ブラウザで開き、127.0.0.1:8511 宛の
// 実 fetch を page.route でパラメータ化して4ケースを検証する。
//   1. 正常ハブ検出        … {hub:true,version,vector,providers} → チップ「導入済み」
//   2. 旧ハブ              … version/vector 無し → hubOld 診断 + DL 導線（note 表示/自動DL）
//   3. ハブ未起動          … route.abort（接続拒否）→ 「未導入」
//   4. 非ハブ占有          … {hub:false} → 「未導入」
// スクリーンショットは %TEMP% へ出力（AGENTS.md 準拠）。
// 実行: node verify.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { chromium } from "playwright-core";

const WEB = fileURLToPath(new URL("../../web", import.meta.url));
const TMP = os.tmpdir();
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".map": "application/json", ".txt": "text/plain",
};
const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const data = await readFile(join(WEB, p));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

let failed = false;
const check = (name, cond, detail = "") => {
  if (!cond) failed = true;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}  ${detail}`);
};

// detectLocalBackend（backend.js）はローカルバックエンド検出時に
// window.location.reload() を1回だけ行う。evaluate 中の実行コンテキスト
// 破棄に備えて、遷移後に1回だけリトライする
async function evalRetry(page, fn, mkDom = "") {
  for (let i = 0; i < 2; i++) {
    try {
      return await page.evaluate(fn, mkDom);
    } catch (e) {
      if (i === 1 || !/Execution context was destroyed/.test(String(e))) throw e;
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(500);
    }
  }
}

const browser = await chromium
  .launch({ channel: "msedge", headless: true })
  .catch(() => chromium.launch({ channel: "chrome", headless: true }));

// healthJson=null → 接続拒否。8511 以外のリクエストは素通し
async function runCase(name, healthJson, shot, fn, lna = null) {
  // detectLocalBackend の検出成功 → 1回限りの reload がナビゲーションと
  // 競合して落ちることがあるため、ケースごと1回だけ作り直してリトライする
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctx = await browser.newContext();
    // detectLocalBackend の検出成功 → reload 経路は sessionStorage フラグで
    // 1回限り。初回からフラグを立てて reload 自体を抑止する（疎通は 8510
    // 遮断で既に失敗するが、念のため二重に防ぐ）
    await ctx.addInitScript(() => {
      try { sessionStorage.setItem("kasugai_backend_reloaded", "1"); } catch {}
    });
    // LNA 権限状態を固定する。prompt の環境では未許可起因の「不明」になる
    // ため、疎通結果（未検出=未導入）を検証するケースでは granted にする
    if (lna) {
      await ctx.addInitScript((st) => {
        navigator.permissions.query = async () => ({ state: st, addEventListener() {} });
      }, lna);
    }
    const page = await ctx.newPage();
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) console.log(`  [nav:${name}] ${f.url()}`);
    });
    // 8510（ローカルアプリ検出）も遮断し、detectLocalBackend の検出成功→
    // 1回限りの reload がテスト中に起きないようにする
    await page.route(/127\.0\.0\.1:85(10|11)\//, (route) => {
      const url = new URL(route.request().url());
      if (url.port === "8510" || healthJson === null) return route.abort();
      const path = url.pathname;
      if (path === "/health") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(healthJson),
        });
      }
      return route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ providers: {} }),
      });
    });
    try {
      await page.goto(`${base}/cesium/`, { waitUntil: "domcontentloaded", timeout: 30000 });
      // アプリが初期プロジェクト読込で ?project=...#hash へ一度だけ遷移する。
      // その遷移中にコンテキストを閉じると内部ナビゲーション待機が
      // unhandled rejection になるため、遷移が確定するまで待つ
      await page.waitForURL(/(\?|#)/, { timeout: 8000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(500);
      await fn(page, ctx);
      await page.screenshot({ path: join(TMP, shot) });
      await ctx.close();
      return;
    } catch (e) {
      await ctx.close().catch(() => {});
      if (attempt === 1 || !/TargetClosed|context was destroyed|has been closed/i.test(String(e))) throw e;
      console.log(`  [retry:${name}] ${String(e).split("\n")[0]}`);
    }
  }
}

// ---- Case 1: 正常ハブ検出 → チップ「導入済み」 ----
await runCase("normal-hub",
  { hub: true, version: "9.9.9", vector: {}, providers: { copilot: { available: true } } },
  "hubtest-normal.png", async (page) => {
    const r = await evalRetry(page, async () => {
      document.body.insertAdjacentHTML("beforeend",
        '<span class="cli-state" data-provider="hub"></span><span id="bridge-hub-status"></span>');
      const ja = await (await fetch("/shared/i18n/ja.json")).json();
      const m = await import("/shared/ai-chat.js");
      await m.refreshCliSetupStates();
      return {
        chip: document.querySelector('.cli-state[data-provider="hub"]').textContent,
        expected: ja["chat.bridge.cliInstalled"],
      };
    });
    check("正常ハブ→チップ「導入済み」", r.chip === r.expected, `chip=${r.chip}`);
  });

// ---- Case 2: 旧ハブ → hubOld 診断 + DL 導線 ----
await runCase("old-hub",
  { hub: true, providers: { copilot: { available: true }, devin: { available: true } } },
  "hubtest-old.png", async (page) => {
    const dl = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
    const r = await evalRetry(page, async () => {
      const ja = await (await fetch("/shared/i18n/ja.json")).json();
      const m = await import("/shared/ai-chat.js");
      // ハブ検出 → プロバイダ選択 → 接続検証（detectBridge→旧ハブ判定→hubOld）まで実経路で駆動
      await m.updateBridgeProviderOptions();
      m.selectChatProvider("copilot");
      await new Promise((r2) => setTimeout(r2, 6000));
      const note = document.querySelector("#bridge-hub-note");
      const status = document.querySelector("#bridge-hub-status");
      return {
        hubOld: ja["chat.bridge.hubOld"] || "旧",
        bodyHit: document.body.innerText.includes("旧"),
        noteHidden: note ? note.hidden : "no-el",
        status: status?.textContent || "",
      };
    });
    const dlEv = await dl;
    check("旧ハブ→hubOld 診断または DL 導線表示",
      r.bodyHit === true || r.noteHidden === false || !!dlEv,
      JSON.stringify({ bodyHit: r.bodyHit, noteHidden: r.noteHidden, status: r.status, dl: dlEv?.suggestedFilename() || null }));
  });

// ---- Case 3: ハブ未起動（接続拒否）→ 「未導入」 ----
await runCase("hub-down", null, "hubtest-down.png", async (page) => {
  const r = await evalRetry(page, async () => {
    document.body.insertAdjacentHTML("beforeend",
      '<span class="cli-state" data-provider="hub"></span><span id="bridge-hub-status"></span>');
    const ja = await (await fetch("/shared/i18n/ja.json")).json();
    const m = await import("/shared/ai-chat.js");
    await m.refreshCliSetupStates();
    return {
      chip: document.querySelector('.cli-state[data-provider="hub"]').textContent,
      expected: ja["chat.bridge.cliMissing"],
    };
  });
  check("ハブ未起動→チップ「未導入」", r.chip === r.expected, `chip=${r.chip}`);
}, "granted");

// ---- Case 4: 非ハブ占有（hub:false）→ 「未導入」 ----
await runCase("not-hub", { hub: false }, "hubtest-nothub.png", async (page) => {
  const r = await evalRetry(page, async () => {
    document.body.insertAdjacentHTML("beforeend",
      '<span class="cli-state" data-provider="hub"></span><span id="bridge-hub-status"></span>');
    const ja = await (await fetch("/shared/i18n/ja.json")).json();
    const m = await import("/shared/ai-chat.js");
    await m.refreshCliSetupStates();
    return {
      chip: document.querySelector('.cli-state[data-provider="hub"]').textContent,
      expected: ja["chat.bridge.cliMissing"],
    };
  });
  check("非ハブ占有→チップ「未導入」", r.chip === r.expected, `chip=${r.chip}`);
}, "granted");

await browser.close();
srv.close();
console.log(failed ? "RESULT: FAIL" : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
