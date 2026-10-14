// KASUGAI Canvas AIチャット → Devin CLI (devin acp) ブリッジ。
//
// アプリの「外部エージェント」プロトコル
//   POST /agent  {message, project, camera, layers, history, tools}
//   →            {reply, actions:[{name, args}]}
// を、Devin CLI の ACP (Agent Client Protocol / stdio JSON-RPC) セッションへ翻訳する。
//
// 地図操作ツールは MCP (streamable HTTP) で Devin に注入する:
// ブリッジ自身が /mcp/<project> で MCP サーバーを兼ね、session/new の
// mcpServers にそのURLを登録する。Devin がツールを呼ぶと呼び出しを
// actions として収集してスタブ結果を返す（実実行はブラウザ側）。
// listLayers / getCamera はリクエストに同梱された現在状態から実値を返す。
//
// 認証: ACP モードの devin CLI はローカルの devin auth login 資格を使わない
// ポリシーのため、ブリッジが ACP authenticate を行う。
//   - DEVIN_API_KEY があれば authenticate の meta.api_key に渡す
//   - なければ authenticate(methodId:"devin-browser") でブラウザ PKCE フロー
// 権限: session/request_permission は kasugai ツール以外を拒否する
// （ファイル・シェル等の内蔵ツール実行を抑止）。
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = Number(process.env.DEVIN_BRIDGE_PORT || 8789);
const MODEL = process.env.DEVIN_BRIDGE_MODEL || ""; // 空 = Devin 既定モデル
const BRIDGE_TOKEN = process.env.DEVIN_BRIDGE_TOKEN || "";
const SEND_TIMEOUT_MS = Number(process.env.DEVIN_BRIDGE_TIMEOUT_MS || 110000);
// Devin APIキー。環境変数のほか、ブラウザ設定画面から X-Devin-Api-Key
// ヘッダで届いた値も使う（後者はリクエストごとに更新・キー変化で acp を再認証）
let configuredApiKey = process.env.DEVIN_API_KEY || "";
const DEBUG = !!process.env.DEVIN_BRIDGE_DEBUG;
// Devin CLI のビルトインツール（ファイル・シェル）が触れる作業ディレクトリを
// 空の専用ディレクトリに限定する
const WORKDIR = path.join(os.tmpdir(), "kasugai-devin-bridge");
fs.mkdirSync(WORKDIR, { recursive: true });

// 前回起動に成功した devin バイナリのパスをキャッシュする。
// 次回以降はこれを最優先で試し、PATH 上に存在しない候補への spawn を省略する
const BIN_CACHE = path.join(WORKDIR, "acp-bin.txt");
function cachedBin() {
  try {
    const p = fs.readFileSync(BIN_CACHE, "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  return "";
}
function rememberBin(bin) {
  try { fs.writeFileSync(BIN_CACHE, bin); } catch (e) {}
}

const SYSTEM_PROMPT = `あなたは3D地図アプリ「KASUGAI Canvas」の操作アシスタントです。
ユーザーの指示に応じて、登録された地図操作ツールで地図を操作してください。

重要な前提:
- このブリッジではツール呼び出しは実行されず「キュー」に積まれ、あなたの応答後にブラウザアプリ側でまとめて実行されます。ツール結果はプレースホルダなので、結果を待たず必要なツール呼び出しをまとめて出してください。
- ただし listLayers / getCamera は現在の実値を返します。レイヤ名が曖昧な場合は listLayers、ベースマップ名が曖昧な場合は listBasemaps で確認し、最も近いものを使ってください（listLayers/getCamera 以外の一覧系ツール結果はプレースホルダです）。
- switchProject・applyInspector・shutdownApp・installUpdate・exportInspector・publishPlugin など影響の大きい操作は、ユーザーが明示的に指示した場合のみ実行してください（ブラウザ側に確認ダイアログも出ます）。
- データの作成・追加を求められたら、確認を求めず GeoJSON を生成して addDataLayer で表示してください。架空・サンプルデータの場合は各 feature の properties に dataSource・generatedAt(ISO8601)・aiGenerated:true を入れてください。
- 資料作成を求められたら Markdown でまとめて showReport で表示してください。
- ファイル操作・シェル・検索などのビルトインツールは使わないでください。地図操作は登録ツール（kasugai の MCP ツール）のみで行います。
- 回答は日本語で簡潔に。`;

// リクエストの state（camera/layers）から実値を返せる参照系ツール。
// これらがプレースホルダだと、レイヤ名を確認してから操作する流れが破綻するため実値を返す
const LOCAL_STATE_TOOLS = {
  listLayers: (state) => ({ layers: state.layers ?? [] }),
  getCamera: (state) => state.camera ?? null,
};

// Devin CLI の探索順。DEVIN_CLI_PATH > 前回成功パス > PATH 上の devin > 代表的なインストール先
// 重複と「存在しない絶対パス」の候補は除外する（spawn 失敗を待つ時間を省く）
function devinBinCandidates() {
  const list = [];
  if (process.env.DEVIN_CLI_PATH) list.push(process.env.DEVIN_CLI_PATH);
  const cached = cachedBin();
  if (cached) list.push(cached);
  list.push(process.platform === "win32" ? "devin.exe" : "devin", "devin");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (local) {
      list.push(path.join(local, "Programs", "Devin", "resources", "app", "extensions", "windsurf", "devin", "bin", "devin.exe"));
    }
  } else {
    const home = os.homedir();
    list.push(path.join(home, ".local", "bin", "devin"), "/usr/local/bin/devin", "/opt/homebrew/bin/devin");
  }
  const seen = new Set();
  return list.filter(b => !seen.has(b) && seen.add(b) && (!path.isAbsolute(b) || fs.existsSync(b)));
}

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

// ---- ACP クライアント（devin acp 子プロセスを NDJSON で駆動） ----
class AcpClient {
  constructor(bin) {
    this.bin = bin;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.buf = "";
    this.ready = false;
    this.authMethods = [];
    this.modelOptions = [];     // session/new の configOptions から拾う
    this.turnText = new Map();  // sessionId -> [text parts]
    this.sessionModel = new Map();   // sessionId -> 選択中モデル id
    this.contextByModel = new Map(); // modelId -> usage_update の実測コンテキストサイズ
    this.lastUsage = null;           // 直近の usage_update {used,size,cost}
  }

  start() {
    if (this.child) return;
    const args = ["acp"];
    if (MODEL) args.push("--model", MODEL);
    try {
      this.child = spawn(this.bin, args, {
        cwd: WORKDIR,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (e) {
      // spawn が同期例外を投げた場合も即失敗させて次候補へ進める
      console.error(`[bridge] devin acp spawn error (${this.bin}): ${e.message}`);
      return;
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk;
      const lines = this.buf.split("\n");
      this.buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (s) this.onMessage(s);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => {
      // Devin 側のエラー等を拾う。INFO 系の定常ログは DEBUG 時のみ出力
      const text = d.toString();
      if (DEBUG || /error|warn|mcp/i.test(text)) {
        for (const line of text.split("\n")) {
          if (line.trim()) console.error(`[acp] ${line.slice(0, 400)}`);
        }
      }
    });
    this.child.on("exit", (code) => {
      console.error(`[bridge] devin acp exited (code ${code}); 次の要求で再起動します`);
      this.child = null;
      this.ready = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("devin acp process exited"));
      }
      this.pending.clear();
      sessions.clear();
    });
    this.child.on("error", (e) => {
      // spawn 失敗（ENOENT 等）では 'exit' が発火しないことがあるため、
      // ここでも保留中の RPC を失敗させて次候補へ即座に進める
      console.error(`[bridge] devin acp spawn error (${this.bin}): ${e.message}`);
      this.child = null;
      this.ready = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`devin acp spawn failed: ${e.message}`));
      }
      this.pending.clear();
    });
  }

  onMessage(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // サーバ→クライアントの要求（id + method）: 権限確認など
    if (msg.id !== undefined && typeof msg.method === "string") {
      this.handleServerRequest(msg);
      return;
    }
    // 要求への応答
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    // 通知
    if (typeof msg.method === "string") this.handleNotify(msg);
  }

  handleServerRequest(msg) {
    const reply = (result) => this.send({ jsonrpc: "2.0", id: msg.id, result });
    const replyError = (code, message) => this.send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    if (msg.method === "session/request_permission") {
      const params = msg.params || {};
      const options = Array.isArray(params.options) ? params.options : [];
      const toolName = this.permissionToolName(params.toolCall);
      const isMapTool = toolName && (toolName.startsWith("kasugai") || toolNameSet.has(toolName) || toolName.includes("kasugai"));
      const pick = (kinds) => options.find(o => kinds.includes(o?.kind))?.optionId || options.find(o => kinds.includes(String(o?.kind)))?.optionId;
      if (isMapTool) {
        // 地図操作のみ許可。allow_always があれば以降の往復を減らせる
        const id = pick(["allow_always", "allow_once"]) || options[0]?.optionId;
        return id ? reply({ outcome: { outcome: "selected", optionId: id } }) : reply({ outcome: { outcome: "cancelled" } });
      }
      // kasugai 以外（ファイル・シェル等の内蔵ツール）は拒否する
      const id = pick(["reject_once", "reject_always"]);
      return id ? reply({ outcome: { outcome: "selected", optionId: id } }) : reply({ outcome: { outcome: "cancelled" } });
    }
    // fs/terminal 等のクライアント側要求は未対応として拒否
    replyError(-32601, `unsupported client method: ${msg.method}`);
  }

  // 権限要求が kasugai MCP ツールかを判定する
  permissionToolName(toolCall) {
    if (!toolCall || typeof toolCall !== "object") return "";
    const cand = [toolCall.title, toolCall.kind, toolCall.toolCallId];
    for (const c of cand) {
      if (typeof c === "string" && /kasugai/i.test(c)) return c;
    }
    // タイトル等が "kasugai/flyTo"・"flyTo"・"mcp__kasugai__flyTo" 等で来る想定
    for (const c of cand) {
      if (typeof c !== "string") continue;
      const tail = c.split(/[\/_:.]/).pop();
      if (toolNameSet.has(c) || toolNameSet.has(tail)) return c;
    }
    return "";
  }

  handleNotify(msg) {
    if (msg.method !== "session/update") return;
    const p = msg.params || {};
    const u = p.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      const arr = this.turnText.get(p.sessionId);
      if (arr) arr.push(u.content.text || "");
      return;
    }
    // usage_update: {size: コンテキスト総量, used: 使用量, cost?}
    // 実測値をモデルに紐付けて /models の context 表示に使う
    if (u.sessionUpdate === "usage_update") {
      const usage = { used: u.used ?? null, size: u.size ?? null, cost: u.cost ?? null };
      this.lastUsage = usage;
      const model = this.sessionModel.get(p.sessionId);
      if (model && usage.size) this.contextByModel.set(model, usage.size);
    }
  }

  send(obj) {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  rpc(method, params, timeoutMs = SEND_TIMEOUT_MS) {
    if (!this.child) throw new Error("devin acp is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  // initialize + 必要なら authenticate（api_key 優先・なければブラウザ PKCE）
  async ensureReady() {
    this.start();
    if (this.ready) return;
    const init = await this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "kasugai-devin-bridge", version: "1.0.0" },
    }, 30000);
    this.authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    if (this.authMethods.length) {
      try {
        if (configuredApiKey) {
          await this.rpc("authenticate", {
            methodId: this.authMethods[0].id,
            _meta: { api_key: configuredApiKey },
          }, 30000);
        } else {
          // ブラウザ PKCE フロー（利用者のマシンでブラウザが開く）。
          // フロー完了まで時間がかかることがあるため長めに待つ
          await this.rpc("authenticate", { methodId: this.authMethods[0].id }, 180000);
        }
      } catch (e) {
        // authenticate は資格の受理後の後段処理（team settings 取得等）でも
        // 失敗し得る（個人プランのアカウントで Permission denied になる等）。
        // 資格自体が生きている可能性があるため session/new まで進めてみる。
        // 失敗時に根本原因を報告できるようエラーを保持しておく
        this.authError = e;
        console.warn(`[bridge] authenticate に失敗しましたが継続します: ${e.message}`);
      }
    }
    this.ready = true;
  }
}

// 登録済みツール名の集合（権限要求の判定用。リクエストごとに更新）
const toolNameSet = new Set();
// プロジェクトごとの MCP 公開ツール宣言・保留アクション・現在の地図状態
const declsByProject = new Map();    // project -> normalized decls
const pendingByProject = new Map();  // project -> [{name,args}]
const stateByProject = new Map();    // project -> {layers, camera}
// プロジェクトごとの ACP セッション
const sessions = new Map();          // project -> {sessionId, toolsSig, seeded, model}
let acp = null;
let acpBinUsed = "";
// ACP セッション作成は acp プロセス全体で直列化する（JSON-RPC 行の応答対応はあるが
// セッションの初期化・再作成の競合を避けるため簡易ロックをかける）
let acpQueue = Promise.resolve();
const enqueue = (fn) => { acpQueue = acpQueue.then(fn, fn); return acpQueue; };
// /models 用の acp 起動・モデル一覧取得の多重実行防止
let modelsWarmup = null;
// 直近の起動・認証失敗理由（アプリ側の「未接続」表示の詳細に使う）
let lastWarmupError = "";

async function getAcp() {
  if (acp && acp.ready) return acp;
  let lastErr = null;
  // バイナリ未検出（spawn ENOENT 等）は探索ノイズなので、実際に起動できた
  // 候補の失敗（認証エラー等）があればそちらを優先して報告する
  let realErr = null;
  const isSpawnErr = (e) => /spawn failed|is not running/.test(e?.message || "");
  for (const bin of devinBinCandidates()) {
    let c = null;
    try {
      c = new AcpClient(bin);
      await c.ensureReady();
      acp = c;
      acpBinUsed = bin;
      rememberBin(bin);
      console.log(`[bridge] devin acp connected: ${bin}`);
      return c;
    } catch (e) {
      lastErr = e;
      if (!isSpawnErr(e)) realErr = realErr || e;
      try { c?.child?.kill(); } catch (_) {}
    }
  }
  const err = realErr || lastErr;
  const hint = realErr
    ? ""
    : "devin CLI が見つかりません（DEVIN_CLI_PATH でインストール先を指定してください）";
  throw new Error(`devin acp への接続に失敗しました: ${err?.message || "unknown"}${hint ? `。${hint}` : ""}`);
}

async function getSession(project, decls, model) {
  const c = await getAcp();
  const sig = JSON.stringify(decls.map(d => d.name));
  let entry = sessions.get(project);
  const wantModel = model || MODEL;
  if (entry && entry.toolsSig === sig && (!wantModel || entry.model === wantModel)) return entry;
  if (entry) sessions.delete(project);
  const params = {
    cwd: WORKDIR,
    mcpServers: [{
      type: "http",
      name: "kasugai",
      url: `http://127.0.0.1:${PORT}/mcp/${encodeURIComponent(project)}`,
      headers: [],
    }],
  };
  let res;
  try {
    res = await c.rpc("session/new", params, 60000);
  } catch (e) {
    // authenticate 失敗を継続した経路でここが失敗した場合、根本原因
    // （認証エラー）を優先して報告する（"not authenticated" だけでは
    // 個人プラン拒否等の実原因が見えないため）
    if (c.authError) throw new Error(`${e.message}（認証時エラー: ${c.authError.message}）`);
    throw e;
  }
  const sessionId = res?.sessionId;
  if (!sessionId) throw new Error("session/new returned no sessionId");
  entry = { sessionId, toolsSig: sig, seeded: false, model: wantModel || "" };
  sessions.set(project, entry);
  c.turnText.set(sessionId, []);
  // モデル一覧を /models 応答用に拾う。ACP の configOptions（新形式）と
  // session/new の models.availableModels（標準形式）の両方を見る
  const opts = Array.isArray(res?.configOptions) ? res.configOptions : [];
  const modelOpt = opts.find(o => o?.id === "model" || o?.category === "model");
  const fromOptions = (Array.isArray(modelOpt?.options) ? modelOpt.options : [])
    .map(o => ({ id: o?.value ?? o?.id, name: o?.name || o?.value || o?.id }));
  const fromModels = (Array.isArray(res?.models?.availableModels) ? res.models.availableModels : [])
    .map(m => ({ id: m?.modelId ?? m?.id, name: m?.name || m?.modelId || m?.id }));
  const seenIds = new Set();
  const merged = [...fromOptions, ...fromModels].filter(m => m.id && !seenIds.has(m.id) && seenIds.add(m.id));
  if (merged.length) {
    c.modelOptions = merged;
    if (!wantModel) entry.model = modelOpt?.currentValue || res?.models?.currentModelId || entry.model;
  }
  // 要求モデルがあれば切替を試みる（set_config_option → 未対応なら握りつぶす）
  if (wantModel && wantModel !== entry.model) {
    try {
      await c.rpc("session/set_config_option", { sessionId, configId: "model", value: wantModel }, 15000);
      entry.model = wantModel;
    } catch (e) {
      try {
        await c.rpc("session/set_model", { sessionId, modelId: wantModel }, 15000);
        entry.model = wantModel;
      } catch (e2) {
        console.warn("[bridge] モデル切替に失敗（このビルドでは未対応の可能性）:", e2.message);
      }
    }
  }
  // usage_update をモデルへ紐付けるため sessionId → model を記録する
  if (entry.model) c.sessionModel.set(sessionId, entry.model);
  return entry;
}

function buildPrompt(body, entry) {
  const stateJson = (v) => {
    try { return JSON.stringify(v ?? null).slice(0, 8000); } catch (e) { return "null"; }
  };
  const state = `[State] camera=${stateJson(body.camera)} layers=${stateJson(body.layers)}`;
  let prompt = "";
  if (!entry.seeded) {
    prompt += SYSTEM_PROMPT + "\n\n";
    if (Array.isArray(body.history) && body.history.length) {
      const lines = body.history.slice(-20).map(h => `${h.role}: ${String(h.text ?? "").slice(0, 2000)}`).join("\n");
      prompt += `[Prior chat log]\n${lines}\n\n`;
    }
  }
  // 末尾に明示的なタスク枠を置く。システム指示＋状態だけだと
  // モデルが「準備完了」のみ返して実指示を実行しないことがあるため
  return `${prompt}${state}\n\n[ユーザーの指示]\n${body.message}\n\nこの指示に今すぐ従ってください。地図操作が必要なら登録ツール（kasugai の MCP ツール）を呼び出し、終わったら結果を日本語で簡潔に報告してください。`;
}

// アプリが指定するモデル。要求の model フィールド優先、なければ既定
function requestModel(body) {
  const m = typeof body?.model === "string" ? body.model.trim() : "";
  return m || MODEL;
}

async function handleAgent(body) {
  const decls = normalizeToolDecls(body?.tools);
  const project = typeof body?.project === "string" && body.project ? body.project : "default";
  decls.forEach(d => toolNameSet.add(d.name));
  declsByProject.set(project, decls);
  pendingByProject.set(project, []);
  stateByProject.set(project, { layers: body?.layers, camera: body?.camera });
  const entry = await getSession(project, decls, requestModel(body));
  const c = await getAcp();
  c.turnText.set(entry.sessionId, []);
  const res = await c.rpc("session/prompt", {
    sessionId: entry.sessionId,
    prompt: [{ type: "text", text: buildPrompt(body, entry) }],
  }, SEND_TIMEOUT_MS);
  entry.seeded = true;
  const reply = (c.turnText.get(entry.sessionId) || []).join("").trim();
  return { reply, actions: (pendingByProject.get(project) || []).slice() };
}

// ---- MCP (streamable HTTP 簡易実装): Devin へ地図ツールを公開する側 ----
function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function mcpToolText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

async function handleMcp(req, res, project) {
  let msg;
  try { msg = JSON.parse(await readBody(req) || "{}"); }
  catch (e) { return sendJson(res, 400, mcpError(null, -32700, "parse error")); }
  const id = msg.id;
  if (msg.method && msg.method !== "ping") {
    console.log(`[mcp] ${project}: ${msg.method}${msg.params?.name ? ` ${msg.params.name}` : ""}`);
  }
  // 通知（id なし）は受理のみ
  if (id === undefined) {
    res.writeHead(202);
    return res.end();
  }
  switch (msg.method) {
    case "initialize": {
      const sessionId = crypto.randomUUID();
      res.setHeader("Mcp-Session-Id", sessionId);
      return sendJson(res, 200, mcpResult(id, {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "kasugai-map-tools", version: "1.0.0" },
      }));
    }
    case "ping":
      return sendJson(res, 200, mcpResult(id, {}));
    case "tools/list": {
      const decls = declsByProject.get(project) || [];
      return sendJson(res, 200, mcpResult(id, {
        tools: decls.map(d => ({ name: d.name, description: d.description, inputSchema: d.parameters })),
      }));
    }
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const decls = declsByProject.get(project) || [];
      if (!decls.some(d => d.name === name)) {
        return sendJson(res, 200, mcpResult(id, { ...mcpToolText({ error: `unknown tool: ${name}` }), isError: true }));
      }
      if (LOCAL_STATE_TOOLS[name]) {
        return sendJson(res, 200, mcpResult(id, mcpToolText(LOCAL_STATE_TOOLS[name](stateByProject.get(project) || {}))));
      }
      if (!pendingByProject.has(project)) pendingByProject.set(project, []);
      pendingByProject.get(project).push({ name, args });
      return sendJson(res, 200, mcpResult(id, mcpToolText({
        queued: true,
        note: "Action queued; it runs in the browser after your reply. Do not wait for a real result.",
      })));
    }
    default:
      return sendJson(res, 200, mcpError(id, -32601, `method not found: ${msg.method}`));
  }
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
  console.warn("[bridge] DEVIN_BRIDGE_TOKEN が未設定です。このポートへのアクセスは無認証になります（ローカル専用で使う場合は問題ありませんが、共有端末ではトークン設定を推奨）。");
}

// ブラウザ設定画面から届いた APIキー（X-Devin-Api-Key ヘッダ）を取り込む。
// キーが変化した場合は devin acp 子プロセスを再起動して新しいキーで
// 認証し直す（ACP の資格はプロセス存続中のみ有効なため）
function captureApiKey(req) {
  const h = req.headers["x-devin-api-key"];
  if (typeof h !== "string") return;
  const key = h.trim();
  if (key === configuredApiKey) return;
  configuredApiKey = key;
  console.log(`[bridge] Devin APIキーを${key ? "更新" : "クリア"}しました。次の要求で devin acp を再認証します`);
  if (acp?.child) { try { acp.child.kill(); } catch (e) {} }
  acp = null;
}

// acp 子プロセスの切断等で未処理の拒否/例外が上がると node が終了してしまう。
// ブリッジは常駐プロセスなのでログだけ残して生かし続ける
process.on("unhandledRejection", (e) => {
  console.error("[bridge] unhandledRejection:", e?.message || e);
});
process.on("uncaughtException", (e) => {
  console.error("[bridge] uncaughtException:", e?.message || e);
});

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-Devin-Api-Key");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  // HTTPS の公開デプロイから localhost ブリッジを呼ぶ
  // public→private の Private Network Access プリフライトに応答する
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, model: MODEL || null, sessions: sessions.size, bridge: "devin" });
  }
  // Devin 側が利用できるモデル一覧。モデル情報は devin acp との
  // セッション（configOptions / models.availableModels）からしか取れず、
  // acp 未起動時の起動・認証には数十秒〜ブラウザログイン要で数分かかる
  // ことがある。待たずに {pending:true} を即返し、起動は裏で進める
  if (req.method === "GET" && url.pathname === "/models") {
    captureApiKey(req);
    if (!acp?.modelOptions?.length && !modelsWarmup) {
      modelsWarmup = enqueue(async () => {
        const c = await getAcp();
        if (!c.modelOptions.length) {
          await getSession("__models__", declsByProject.get("__models__") || [], MODEL);
        }
        lastWarmupError = "";
      }).catch(e => {
        lastWarmupError = String(e?.message || e);
        console.error("[bridge] models warmup failed:", lastWarmupError);
      }).finally(() => { modelsWarmup = null; });
    }
    return sendJson(res, 200, {
      // 各モデルに実測コンテキストサイズ（usage_update 由来・未測定は省略）を添える
      models: (acp?.modelOptions || []).map(m => ({
        ...m,
        ...(acp.contextByModel.get(m.id) ? { context: acp.contextByModel.get(m.id) } : {}),
      })),
      pending: !(acp?.modelOptions?.length),
      // 現在の実モデル（未選択時の既定値。アプリ側の表示用）
      model: MODEL || [...sessions.values()].map(s => s.model).find(Boolean) || null,
      // 直近ターンの usage_update（{used,size,cost}・未受信なら null）
      usage: acp?.lastUsage || null,
      // 起動・認証の失敗理由（APIキー拒否等。成功時は空）
      error: lastWarmupError || null,
    });
  }
  // MCP エンドポイント（Devin の MCP クライアントから呼ばれる）
  const mcpMatch = url.pathname.match(/^\/mcp\/(.+)$/);
  if (mcpMatch) {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    return handleMcp(req, res, decodeURIComponent(mcpMatch[1]));
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
  captureApiKey(req);
  try {
    // ACP セッションの作成・プロンプトは直列化（同一セッションへの同時 prompt 防止）
    const result = await enqueue(() => handleAgent(body));
    sendJson(res, 200, result);
  } catch (e) {
    console.error("[bridge] agent error:", e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] listening: http://127.0.0.1:${PORT}/agent (model=${MODEL || "devin default"})`);
  console.log(`[bridge] アプリ側設定: 管理 → AI → チャット → プロバイダ「Devin」、または外部エージェントのエンドポイントに上記URLを入力`);
});
