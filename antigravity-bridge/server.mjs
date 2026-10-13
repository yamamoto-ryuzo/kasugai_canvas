// KASUGAI Canvas AIチャット → Antigravity CLI (agy) ブリッジ。
//
// アプリの「外部エージェント」プロトコル
//   POST /agent  {message, project, camera, layers, history, tools}
//   →            {reply, actions:[{name, args}]}
// を、Antigravity CLI (agy) の headless 実行へ翻訳する。
//
// 地図操作ツールは MCP (streamable HTTP) で agy に注入する:
// ブリッジ自身が /mcp で MCP サーバーを兼ね、起動時に
// `agy mcp add kasugai http://127.0.0.1:<port>/mcp` で登録する。
// agy がツールを呼ぶと呼び出しを actions として収集してスタブ結果を返す
// （実実行はブラウザ側）。listLayers / getCamera はリクエストに同梱された
// 現在状態から実値を返す。
//
// agy はメッセージ毎に子プロセスとして起動する（--input-format stream-json で
// プロンプトを stdin へ渡し、--output-format stream-json の NDJSON を読む）。
// 会話の継続は --conversation <id> で agy 側の会話ストアを再利用する。
//
// 権限: headless モードは確認プロンプトを出せないため、許可ルールが無い
// ツール呼び出しは自動拒否される。kasugai MCP ツールのみを許可するよう、
// 起動時に ~/.gemini/antigravity-cli/settings.json の permissions.allow へ
// `mcp(kasugai/*)` を追加する（ANTIGRAVITY_BRIDGE_NO_SETTINGS_PATCH で無効化）。
// ファイル・シェル等の内蔵ツールは許可ルールを足さない限り自動拒否され、
// 作業ディレクトリも空の専用ディレクトリに限定する。
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.ANTIGRAVITY_BRIDGE_PORT || 8791);
const MODEL = process.env.ANTIGRAVITY_BRIDGE_MODEL || ""; // 空 = agy 既定モデル
const EFFORT = process.env.ANTIGRAVITY_BRIDGE_EFFORT || ""; // low|medium|high
const BRIDGE_TOKEN = process.env.ANTIGRAVITY_BRIDGE_TOKEN || "";
const SEND_TIMEOUT_MS = Number(process.env.ANTIGRAVITY_BRIDGE_TIMEOUT_MS || 110000);
const DEBUG = !!process.env.ANTIGRAVITY_BRIDGE_DEBUG;
const NO_MCP_REGISTER = !!process.env.ANTIGRAVITY_BRIDGE_NO_MCP_REGISTER;
const NO_SETTINGS_PATCH = !!process.env.ANTIGRAVITY_BRIDGE_NO_SETTINGS_PATCH;
// agy に登録する MCP サーバー名（permissions ルール mcp(<name>/*) と対になる）
const MCP_SERVER_NAME = process.env.ANTIGRAVITY_BRIDGE_MCP_NAME || "kasugai";
// agy のビルトインツール（ファイル・シェル）が触れる作業ディレクトリを
// 空の専用ディレクトリに限定する
const WORKDIR = path.join(os.tmpdir(), "kasugai-antigravity-bridge");
fs.mkdirSync(WORKDIR, { recursive: true });
// 本ブリッジが agy に登録する MCP URL と、agy のグローバル MCP 設定ファイル。
// 登録はプロセス間で共有されるため、別ポートのブリッジ（手動起動等）が
// 上書きすることがある。/agent 毎に registeredMcpUrl() で検査して修復する
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
const MCP_CONFIG_FILE = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");

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

// agy CLI の探索順。AGY_CLI_PATH > PATH 上の agy > 代表的なインストール先
function agyBinCandidates() {
  const list = [];
  if (process.env.AGY_CLI_PATH) list.push(process.env.AGY_CLI_PATH);
  list.push(process.platform === "win32" ? "agy.exe" : "agy", "agy");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (local) list.push(path.join(local, "agy", "bin", "agy.exe"));
  } else {
    const home = os.homedir();
    list.push(path.join(home, ".local", "bin", "agy"), "/usr/local/bin/agy", "/opt/homebrew/bin/agy");
  }
  return list;
}

let agyBin = "";
function resolveAgyBin() {
  if (agyBin) return agyBin;
  for (const bin of agyBinCandidates()) {
    try {
      const r = spawnSync(bin, ["--version"], { timeout: 10000, encoding: "utf8" });
      if (!r.error && (r.status === 0 || r.stdout || r.stderr)) { agyBin = bin; break; }
    } catch (e) {}
  }
  return agyBin;
}

// agy コマンドを実行して stdout/stderr を取る（mcp add / models 用）
function runAgy(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const bin = resolveAgyBin();
    if (!bin) return reject(new Error("agy CLI が見つかりません（AGY_CLI_PATH を確認）"));
    const child = spawn(bin, args, { cwd: WORKDIR, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; if (out.length > 256 * 1024) out = out.slice(-256 * 1024); });
    child.stderr.on("data", d => { err += d; if (err.length > 64 * 1024) err = err.slice(-64 * 1024); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`agy ${args[0]} timed out`)); }, timeoutMs);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", code => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

// ~/.gemini/antigravity-cli/settings.json の permissions.allow に
// `mcp(<name>/*)` を追加する（headless で kasugai MCP 呼び出しが自動拒否
// されないよう事前許可する。他ツールの権限は変更しない）
function ensurePermissionRule() {
  if (NO_SETTINGS_PATCH) return;
  try {
    const file = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
    const rule = `mcp(${MCP_SERVER_NAME}/*)`;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") { console.warn(`[bridge] settings.json の解析に失敗（権限ルール未追加）: ${e.message}`); return; } }
    const perms = data.permissions && typeof data.permissions === "object" ? data.permissions : {};
    const allow = Array.isArray(perms.allow) ? perms.allow : [];
    if (allow.includes(rule) || allow.includes("mcp(*)")) return;
    perms.allow = [...allow, rule];
    data.permissions = perms;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log(`[bridge] settings.json の permissions.allow に ${rule} を追加しました`);
  } catch (e) {
    console.warn(`[bridge] 権限ルールの追加に失敗: ${e.message}`);
  }
}

// agy のグローバル MCP 設定に登録されている kasugai の URL を読む。
// 未登録は ""、ファイルが読めない環境では null を返す
function registeredMcpUrl() {
  try {
    const data = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, "utf8"));
    const s = data?.mcpServers?.[MCP_SERVER_NAME];
    return (s && (s.serverUrl || s.url)) || "";
  } catch {
    return null;
  }
}

// ブリッジの /mcp エンドポイントを agy の MCP サーバーとして登録する
// （add は add-or-update のため冪等。既存の kasugai エントリは上書きされる）
let lastMcpAddAt = 0;
async function ensureMcpRegistration() {
  if (NO_MCP_REGISTER) return;
  lastMcpAddAt = Date.now();
  const r = await runAgy(["mcp", "add", MCP_SERVER_NAME, MCP_URL]).catch(e => ({ code: -1, stderr: e.message }));
  if (r.code === 0) {
    console.log(`[bridge] agy MCP サーバー "${MCP_SERVER_NAME}" を登録: ${MCP_URL}`);
  } else {
    console.warn(`[bridge] agy mcp add に失敗（地図ツールは使えません）: ${(r.stderr || "").trim()}`);
  }
}

// 登録URLがこのブリッジのポートと違う場合だけ修復する。
// 手動起動ブリッジ（既定 8791）等の別インスタンスがグローバル登録を
// 上書きしたケースへの追従。設定ファイルが読めない場合は定期再登録に倒す
async function ensureMcpUrlCurrent() {
  if (NO_MCP_REGISTER) return;
  const cur = registeredMcpUrl();
  if (cur === MCP_URL) return;
  if (cur !== null) {
    // 登録はあるが URL が違う（別インスタンスが上書き）→ 即座に修復
    console.warn(`[bridge] MCP 登録URLが不一致です（${cur || "未登録"} → ${MCP_URL}）。再登録します`);
    await ensureMcpRegistration();
    return;
  }
  // 設定ファイルが読めない環境では定期再登録に倒す
  if (Date.now() - lastMcpAddAt < 30000) return;
  await ensureMcpRegistration();
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

// ---- agy headless 実行（stream-json stdin → stream-json stdout） ----
// 1メッセージ = 1プロセス。プロンプトは stdin の NDJSON（{"event":"user",...}）
// で渡すためコマンドライン長制限を受けない。会話継続は --conversation <id>。
const conversations = new Map();   // project -> conversationId
let lastModel = "";
let lastUsage = null;              // result.usage（{input_tokens,...}）

function runAgyTurn(prompt, opts = {}) {
  const { conversationId = "", model = "", timeoutMs = SEND_TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    const bin = resolveAgyBin();
    if (!bin) return reject(new Error(
      "agy CLI が見つかりません。Antigravity CLI をインストールしてログインするか、AGY_CLI_PATH で場所を指定してください"));
    const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
    if (conversationId) args.push("--conversation", conversationId);
    if (model) args.push("--model", model);
    else if (MODEL) args.push("--model", MODEL);
    if (EFFORT) args.push("--effort", EFFORT);
    // ブリッジ側タイムアウトの少し手前で agy 自身にも打ち切らせる
    const printTimeoutSec = Math.max(10, Math.round((timeoutMs - 10000) / 1000));
    args.push("--print-timeout", `${printTimeoutSec}s`);
    const child = spawn(bin, args, { cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "";
    let result = null;
    let newConversationId = "";
    const chunks = [];
    const toolSteps = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let msg;
        try { msg = JSON.parse(s); } catch { continue; }
        if (msg.event === "init" && msg.conversation_id) {
          newConversationId = msg.conversation_id;
        } else if (msg.event === "step_update") {
          const u = msg.step_update || {};
          if (u.step_type === "agent_response" && typeof u.text_delta === "string") chunks.push(u.text_delta);
          if (u.step_type === "tool" && u.tool_name) {
            toolSteps.push({ name: u.tool_name, state: u.state || "" });
            if (DEBUG) console.log(`[agy] tool ${u.tool_name} ${u.state || ""}`.trim());
          }
        } else if (msg.event === "result") {
          result = msg.result || {};
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > 64 * 1024) err = err.slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agy が ${timeoutMs}ms でタイムアウトしました`));
    }, timeoutMs);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        result,
        conversationId: newConversationId || conversationId,
        text: chunks.join(""),
        stderr: err.trim(),
        toolSteps,
      });
    });
    // プロンプトは stdin NDJSON で渡す（event:"user" が必須形式）
    child.stdin.write(JSON.stringify({
      event: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n");
    child.stdin.end();
  });
}

// プロジェクトごとの MCP 公開ツール宣言・保留アクション・現在の地図状態
const declsByProject = new Map();    // project -> normalized decls
const pendingByProject = new Map();  // project -> [{name,args}]
const stateByProject = new Map();    // project -> {layers, camera}
// project -> 会話作成時に agy へ登録されていた MCP URL。
// agy は会話開始時の URL にバインドし続けるため、登録URLが変わると
// 再開した会話だけが古いポートへ繋ぎに行き Connection refused になる
const convUrlByProject = new Map();
// 本ブリッジの /mcp に届いたリクエストの累計。
// agy のターン中に 0 なら agy 側が別（古い）URL を見ている兆候
let mcpHits = 0;
// agy の MCP 設定はグローバル（/mcp 単一エンドポイント）のため、
// /agent は直列化して現在処理中のプロジェクトを共有する
let currentProject = "default";
// /agent 処理の直列化（MCP の tools/list・tools/call を現在プロジェクトに紐付けるため）
let agyQueue = Promise.resolve();
const enqueue = (fn) => { agyQueue = agyQueue.then(fn, fn); return agyQueue; };

function buildPrompt(body, isFirst) {
  const stateJson = (v) => {
    try { return JSON.stringify(v ?? null).slice(0, 8000); } catch (e) { return "null"; }
  };
  const state = `[State] camera=${stateJson(body.camera)} layers=${stateJson(body.layers)}`;
  let prompt = "";
  if (isFirst) {
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

async function agyTurn(body, conversationId) {
  const prompt = buildPrompt(body, !conversationId);
  return runAgyTurn(prompt, { conversationId, model: requestModel(body) });
}

async function handleAgent(body) {
  const decls = normalizeToolDecls(body?.tools);
  const project = typeof body?.project === "string" && body.project ? body.project : "default";
  currentProject = project;
  declsByProject.set(project, decls);
  pendingByProject.set(project, []);
  stateByProject.set(project, { layers: body?.layers, camera: body?.camera });
  // 別インスタンスがグローバル MCP 登録を上書きしていたら先に修復する
  await ensureMcpUrlCurrent();
  let conversationId = conversations.get(project) || "";
  // 会話作成時の登録URLと現在のブリッジが違う会話は MCP バインドが古い
  // （agy は会話開始時の URL を使い続ける）ため破棄して新規にする
  const boundUrl = convUrlByProject.get(project);
  if (conversationId && boundUrl && boundUrl !== MCP_URL) {
    console.warn(`[bridge] 会話 ${conversationId} は旧 MCP URL（${boundUrl}）に紐付いています。新規会話に切り替えます`);
    conversations.delete(project);
    convUrlByProject.delete(project);
    conversationId = "";
  }
  // この後に会話が新規作成される場合の想定バインドURL
  const regNow = registeredMcpUrl() || MCP_URL;
  const mcpBefore = mcpHits;
  // agy 側が別（古い）MCP URL を見ている兆候: ターン中にこのブリッジの
  // /mcp へ一度も届かず、kasugai ツール呼出・ツール失敗・接続エラー系の
  // 応答が見える（古いポートが死んでいるか、別インスタンスへ誤配送）
  const isKasugaiStep = (t) => {
    const n = String(t?.name || "");
    return n.includes(MCP_SERVER_NAME) || decls.some(d => d.name === n);
  };
  const staleMcp = (r) => {
    if (mcpHits !== mcpBefore) return false;
    const steps = r.toolSteps || [];
    if (steps.some(t => isKasugaiStep(t))) return true;
    if (steps.some(t => /fail|error|denied/i.test(String(t.state || "")))) return true;
    const blob = `${r.text || ""}\n${r.result?.response || ""}\n${r.stderr || ""}`;
    return /mcp/i.test(blob) &&
      /refus|econnrefused|error|fail|エラー|接続|失敗|拒否|unreachable|timed?\s*out/i.test(blob);
  };
  let run = await agyTurn(body, conversationId);
  const failed = !run.result || run.result.status !== "SUCCESS";
  // 会話再開に失敗した（会話が消えた・ID不正等）、または古い MCP URL に
  // 紐付いたままの会話は、破棄して新規会話で一度だけ再試行する
  if (failed || staleMcp(run)) {
    if (conversationId) {
      console.warn(`[bridge] 会話 ${conversationId} を破棄して新規会話で再試行します（${failed ? "再開失敗" : "MCP エンドポイント不一致"}）: ${run.stderr.slice(0, 200)}`);
      conversations.delete(project);
      convUrlByProject.delete(project);
    } else {
      console.warn(`[bridge] agy がこのブリッジの /mcp に到達していません。MCP 登録を修復して再試行します`);
      await ensureMcpRegistration();
    }
    pendingByProject.set(project, []);
    conversationId = "";
    run = await agyTurn(body, "");
  }
  if (run.conversationId) {
    conversations.set(project, run.conversationId);
    // 会話のバインドURLを記録する: ターン中にこのブリッジへ MCP リクエストが
    // 届いた会話は現行 URL 確定、それ以外は作成時の登録URLを残す
    convUrlByProject.set(project, mcpHits > mcpBefore ? MCP_URL : regNow);
  }
  const result = run.result || {};
  if (result.status !== "SUCCESS") {
    const detail = result.error || run.stderr.slice(-500) || `exit code ${run.code}`;
    throw new Error(`agy の実行に失敗しました: ${detail}`);
  }
  if (result.usage) lastUsage = result.usage;
  if (requestModel(body)) lastModel = requestModel(body);
  let reply = (result.response || run.text || "").trim();
  // 応答もアクションも無い空の SUCCESS はモデル側の取りこぼしのことがある。
  // 表示できるものが一切無いため、同一会話でもう一度だけ促す
  if (!reply && !(pendingByProject.get(project) || []).length &&
      !(Array.isArray(result.denied_actions) && result.denied_actions.length)) {
    console.warn("[bridge] 応答が空でした。再試行します");
    run = await agyTurn(body, conversations.get(project) || "");
    if (run.conversationId) conversations.set(project, run.conversationId);
    const retry = run.result || {};
    if (retry.status !== "SUCCESS") {
      const detail = retry.error || run.stderr.slice(-500) || `exit code ${run.code}`;
      throw new Error(`agy の実行に失敗しました: ${detail}`);
    }
    if (retry.usage) lastUsage = retry.usage;
    reply = (retry.response || run.text || "").trim();
  }
  // 権限拒否で応答が空のケース（mcp(kasugai/*) ルール未適用等）を明示する
  const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
  if (!reply && denied.length) {
    reply = `ツール呼び出しが権限により拒否されました（${denied.map(d => d.action || d.display_name || "?").join(", ")}）。` +
      `~/.gemini/antigravity-cli/settings.json の permissions.allow に mcp(${MCP_SERVER_NAME}/*) があるか確認してください。`;
  }
  return { reply, actions: (pendingByProject.get(project) || []).slice() };
}

// ---- MCP (streamable HTTP 簡易実装): agy へ地図ツールを公開する側 ----
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

// `agy models` の出力（"id\t表示名" 行）を /models 応答用にパースする。
// 短時間キャッシュして設定画面の表示を軽くする
let modelsCache = { at: 0, models: [] };
async function listAgyModels() {
  if (Date.now() - modelsCache.at < 60000) return modelsCache.models;
  const r = await runAgy(["models"], 20000);
  if (r.code !== 0) throw new Error((r.stderr || `agy models failed (${r.code})`).trim());
  const models = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(/^([^\s\t]+)\t(.+)$/);
    if (m) models.push({ id: m[1], name: m[2].trim() });
  }
  modelsCache = { at: Date.now(), models };
  return models;
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
  console.warn("[bridge] ANTIGRAVITY_BRIDGE_TOKEN が未設定です。このポートへのアクセスは無認証になります（ローカル専用で使う場合は問題ありませんが、共有端末ではトークン設定を推奨）。");
}

// agy 子プロセスの切断等で未処理の拒否/例外が上がると node が終了してしまう。
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  // HTTPS の公開デプロイから localhost ブリッジを呼ぶ
  // public→private の Private Network Access プリフライトに応答する
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      model: MODEL || lastModel || null,
      sessions: conversations.size,
      bridge: "antigravity",
      agy: !!resolveAgyBin(),
    });
  }
  // agy が利用できるモデル一覧（agy models）。CLI 未導入/失敗時は空配列を返す
  if (req.method === "GET" && url.pathname === "/models") {
    let models = [];
    let error = "";
    try { models = await listAgyModels(); }
    catch (e) { error = e.message; }
    return sendJson(res, 200, {
      models,
      model: MODEL || lastModel || null,
      usage: lastUsage,
      ...(error ? { error } : {}),
    });
  }
  // MCP エンドポイント（agy の MCP クライアントから呼ばれる）。
  // /mcp は現在処理中のプロジェクト、/mcp/<project> は明示指定として扱う
  const mcpMatch = url.pathname.match(/^\/mcp(?:\/(.+))?$/);
  if (mcpMatch) {
    mcpHits++;
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    const project = mcpMatch[1] ? decodeURIComponent(mcpMatch[1]) : currentProject;
    return handleMcp(req, res, project);
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
    // agy 起動は直列化（MCP エンドポイントが現在プロジェクト基準のため）
    const result = await enqueue(() => handleAgent(body));
    sendJson(res, 200, result);
  } catch (e) {
    console.error("[bridge] agent error:", e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] listening: http://127.0.0.1:${PORT}/agent (model=${MODEL || "agy default"})`);
  console.log(`[bridge] アプリ側設定: 管理 → AI → チャット → プロバイダ「Antigravity」、または外部エージェントのエンドポイントに上記URLを入力`);
  const bin = resolveAgyBin();
  if (bin) {
    console.log(`[bridge] agy: ${bin}`);
    void ensureMcpRegistration();
    ensurePermissionRule();
  } else {
    console.warn("[bridge] agy CLI が見つかりません。Antigravity CLI のインストール・ログイン後にブリッジを再起動してください");
  }
});
