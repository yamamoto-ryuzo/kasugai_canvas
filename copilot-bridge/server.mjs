// KASUGAI Canvas AIチャット → GitHub Copilot SDK ブリッジ。
//
// アプリの「外部エージェント」プロトコル
//   POST /agent  {message, project, camera, layers, history, tools}
//   →            {reply, actions:[{name, args}]}
// を、Copilot CLI ランタイム（@github/copilot-sdk）のカスタムツール呼び出しへ翻訳する。
//
// 地図操作の実実行はブラウザ側が行うため、ここでは Copilot のツール呼び出しを
// actions として収集して返すだけ（ハンドラはスタブ結果を返す）。
// listLayers / getCamera はリクエストに同梱された現在状態から実値を返す。
// 破壊的操作（savePlugin・deleteDataFile 等）はブラウザ側の既存確認ダイアログで保護される。
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";

const PORT = Number(process.env.COPILOT_BRIDGE_PORT || 8788);
const MODEL = process.env.COPILOT_BRIDGE_MODEL || "gpt-5";
// listModels() が空を返すランタイム/アカウント向けの既知モデル一覧。
// 存在しないモデルは Copilot 側がエラーを返すため、UI で選び直せばよい
const FALLBACK_MODELS = [
  "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o",
  "claude-sonnet-4.5", "claude-haiku-4.5", "claude-sonnet-4", "claude-opus-4.1",
  "gemini-2.5-pro",
];
const BRIDGE_TOKEN = process.env.COPILOT_BRIDGE_TOKEN || "";
const SEND_TIMEOUT_MS = Number(process.env.COPILOT_BRIDGE_TIMEOUT_MS || 110000);
// Copilot CLI のビルトインツール（ファイル・シェル）が触れる作業ディレクトリを
// 空の専用ディレクトリに限定する
const WORKDIR = path.join(os.tmpdir(), "kasugai-copilot-bridge");
fs.mkdirSync(WORKDIR, { recursive: true });

const SYSTEM_PROMPT = `あなたは3D地図アプリ「KASUGAI Canvas」の操作アシスタントです。
ユーザーの指示に応じて、登録された地図操作ツールで地図を操作してください。

重要な前提:
- このブリッジではツール呼び出しは実行されず「キュー」に積まれ、あなたの応答後にブラウザアプリ側でまとめて実行されます。ツール結果はプレースホルダなので、結果を待たず必要なツール呼び出しをまとめて出してください。
- ただし listLayers / getCamera は現在の実値を返します。レイヤ名が曖昧な場合は listLayers、ベースマップ名が曖昧な場合は listBasemaps で確認し、最も近いものを使ってください（listLayers/getCamera 以外の一覧系ツール結果はプレースホルダです）。
- switchProject・applyInspector・shutdownApp・installUpdate・exportInspector・publishPlugin など影響の大きい操作は、ユーザーが明示的に指示した場合のみ実行してください（ブラウザ側に確認ダイアログも出ます）。
- データの作成・追加を求められたら、確認を求めず GeoJSON を生成して addDataLayer で表示してください。架空・サンプルデータの場合は各 feature の properties に dataSource・generatedAt(ISO8601)・aiGenerated:true を入れてください。
- 資料作成を求められたら Markdown でまとめて showReport で表示してください。
- ファイル操作・シェルなどのビルトインツールは使わないでください。地図操作は登録ツールのみで行います。
- 回答は日本語で簡潔に。`;

// リクエストの state（camera/layers）から実値を返せる参照系ツール。
// これらがプレースホルダだと、Copilot がレイヤ名を確認してから操作する流れが破綻するため実値を返す
const LOCAL_STATE_TOOLS = {
  listLayers: (state) => ({ layers: state.layers ?? [] }),
  getCamera: (state) => state.camera ?? null,
};

// Gemini形式スキーマ（type が大文字）を JSON Schema（小文字）へ変換する
function toJsonSchema(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(toJsonSchema);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" && typeof value === "string") out[key] = value.toLowerCase();
    else if (value && typeof value === "object") out[key] = toJsonSchema(value);
    else out[key] = value;
  }
  return out;
}

// アプリが送る tools（functionDeclarations 形式）を正規化する。
// OpenAI tools 形式 [{type:"function",function:{...}}] も一応受け付ける
function normalizeToolDecls(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map(t => (t && typeof t === "object" && t.function && typeof t.function === "object") ? t.function : t)
    .filter(d => d && typeof d.name === "string" && d.name)
    .map(d => ({
      name: d.name,
      description: typeof d.description === "string" ? d.description : "",
      parameters: toJsonSchema(d.parameters || { type: "object", properties: {} }),
    }));
}

let client = null;
async function getClient() {
  if (!client) {
    client = new CopilotClient();
    await client.start();
  }
  return client;
}

// プロジェクトごとに Copilot セッションを保持する
const sessions = new Map(); // project -> { session, ctx: {pending, state}, toolsSig }

function buildToolDefs(decls, ctx) {
  return decls.map(d => defineTool(d.name, {
    description: d.description,
    parameters: d.parameters,
    // ハンドラはキューに積むだけ（実実行はブラウザ）。副作用がないため権限確認も不要
    skipPermission: true,
    handler: async (args) => {
      if (LOCAL_STATE_TOOLS[d.name]) return LOCAL_STATE_TOOLS[d.name](ctx.state || {});
      ctx.pending.push({ name: d.name, args: args ?? {} });
      return { queued: true, note: "Action queued; it runs in the browser after your reply. Do not wait for a real result." };
    },
  }));
}

async function createSessionWithFallback(c, toolDefs, model = MODEL) {
  const base = {
    model,
    onPermissionRequest: approveAll,
    tools: toolDefs,
    systemMessage: { mode: "append", content: SYSTEM_PROMPT },
    workingDirectory: WORKDIR,
  };
  // 利用可能ならカスタムエージェントでツールを地図操作のみに限定する
  // （ビルトインのファイル/シェルツールをモデルに見せない）。未対応ランタイムでは握りつぶす
  try {
    return await c.createSession({
      ...base,
      customAgents: [{
        name: "kasugai-map",
        displayName: "KASUGAI Map Operator",
        description: "Operates the KASUGAI Canvas map via registered tools",
        tools: toolDefs.map(t => t.name),
        prompt: SYSTEM_PROMPT,
      }],
      agent: "kasugai-map",
    });
  } catch (e) {
    console.warn("[bridge] customAgents unsupported, falling back to plain session:", e.message);
    return await c.createSession(base);
  }
}

async function getSession(project, decls, model) {
  const c = await getClient();
  const sig = JSON.stringify(decls.map(d => d.name));
  let entry = sessions.get(project);
  // 要求モデルがセッションと違えば切り替える（setTools 同様、
  // 未対応ランタイムや失敗時はセッションを作り直す）
  if (entry && entry.model !== model) {
    try {
      if (typeof entry.session.setModel === "function") {
        await entry.session.setModel(model);
        entry.model = model;
      } else {
        throw new Error("setModel unsupported");
      }
    } catch (e) {
      try { await entry.session.disconnect?.(); } catch (e2) {}
      sessions.delete(project);
      entry = null;
    }
  }
  if (entry && entry.toolsSig === sig) return entry;
  if (entry) {
    // ツール構成が変わった場合は差し替えを試み、ダメならセッションを作り直す
    const defs = buildToolDefs(decls, entry.ctx);
    try {
      if (typeof entry.session.setTools === "function") {
        await entry.session.setTools(defs);
        entry.toolsSig = sig;
        return entry;
      }
    } catch (e) { /* fallthrough: recreate */ }
    try { await entry.session.disconnect?.(); } catch (e) {}
    sessions.delete(project);
  }
  const ctx = { pending: [], state: {} };
  const session = await createSessionWithFallback(c, buildToolDefs(decls, ctx), model);
  entry = { session, ctx, toolsSig: sig, seeded: false, model };
  sessions.set(project, entry);
  return entry;
}

function buildPrompt(body, entry) {
  const stateJson = (v) => {
    try { return JSON.stringify(v ?? null).slice(0, 8000); } catch (e) { return "null"; }
  };
  const state = `[State] camera=${stateJson(body.camera)} layers=${stateJson(body.layers)}`;
  if (!entry.seeded && Array.isArray(body.history) && body.history.length) {
    const lines = body.history.slice(-20).map(h => `${h.role}: ${String(h.text ?? "").slice(0, 2000)}`).join("\n");
    return `[Prior chat log]\n${lines}\n\n${state}\n\n${body.message}`;
  }
  return `${state}\n\n${body.message}`;
}

// アプリが指定する Copilot モデル。要求の model フィールド優先、なければ既定
function requestModel(body) {
  const m = typeof body?.model === "string" ? body.model.trim() : "";
  return m || MODEL;
}

async function handleAgent(body) {
  const decls = normalizeToolDecls(body?.tools);
  const project = typeof body?.project === "string" && body.project ? body.project : "default";
  const entry = await getSession(project, decls, requestModel(body));
  entry.ctx.pending = [];
  entry.ctx.state = { layers: body?.layers, camera: body?.camera };
  const msg = await entry.session.sendAndWait({ prompt: buildPrompt(body, entry) }, SEND_TIMEOUT_MS);
  entry.seeded = true;
  const reply = typeof msg?.data?.content === "string" && msg.data.content ? msg.data.content : "";
  return { reply, actions: entry.ctx.pending.slice() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

if (!BRIDGE_TOKEN) {
  console.warn("[bridge] COPILOT_BRIDGE_TOKEN が未設定です。このポートへのアクセスは無認証になります（ローカル専用で使う場合は問題ありませんが、共有端末ではトークン設定を推奨）。");
}

// Copilot CLI ランタイムの切断等で SDK 内部から未処理の拒否/例外が
// 上がると node が終了してしまう。ブリッジは常駐プロセスなので
// ログだけ残して生かし続ける
process.on("unhandledRejection", (e) => {
  console.error("[bridge] unhandledRejection:", e?.message || e);
});
process.on("uncaughtException", (e) => {
  console.error("[bridge] uncaughtException:", e?.message || e);
});

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // HTTPS の公開デプロイ（Cloud Run/Pages等）から localhost ブリッジを呼ぶ
  // public→private の Private Network Access プリフライトに応答する
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, model: MODEL, sessions: sessions.size, bridge: "copilot" });
  }
  // 利用可能な Copilot モデル一覧（アプリ側のモデル選択ドロップダウン用）
  if (req.method === "GET" && url.pathname === "/models") {
    try {
      const c = await getClient();
      const list = await c.listModels();
      let models = (Array.isArray(list) ? list : [])
        .map(m => (typeof m === "string" ? { id: m, name: m } : { id: m?.id, name: m?.name || m?.id }))
        .filter(m => m.id);
      if (!models.length) models = FALLBACK_MODELS.map(id => ({ id, name: id }));
      return sendJson(res, 200, { models });
    } catch (e) {
      return sendJson(res, 500, { error: String(e?.message || e) });
    }
  }
  if (req.method !== "POST" || url.pathname !== "/agent") {
    return sendJson(res, 404, { error: "not found" });
  }
  if (BRIDGE_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${BRIDGE_TOKEN}`) return sendJson(res, 401, { error: "unauthorized" });
  }
  let body;
  try { body = JSON.parse(await readBody(req) || "{}"); }
  catch (e) { return sendJson(res, 400, { error: `invalid json: ${e.message}` }); }
  try {
    const result = await handleAgent(body);
    sendJson(res, 200, result);
  } catch (e) {
    console.error("[bridge] agent error:", e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] listening: http://127.0.0.1:${PORT}/agent (model=${MODEL})`);
  console.log(`[bridge] アプリ側設定: 管理 → AI → エージェント → エンドポイントに上記URLを入力し「チャットを外部エージェントへ送信」をON`);
});
