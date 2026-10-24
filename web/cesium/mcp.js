// MCP (Model Context Protocol) リモートサーバー接続基盤。
// 内蔵AIのチャットツールへ外部データソースのツールを合成するための汎用クライアント。
// Box (https://mcp.box.com) を第一接続先とし、任意のリモートMCPサーバーを
// レジストリへ追加できる（サーバー定義は localStorage "mcpServers"）。
//
// - トランスポート: Streamable HTTP（POST JSON-RPC。応答は application/json
//   または text/event-stream）。セッションは Mcp-Session-Id ヘッダで継続する
// - 認証: サーバー別の authProvider（box.js の OAuth）または定義内の固定 Bearer
//   トークン（BYO・localStorage 保存。共有 .kasc には書き込まない）
// - CORS: 直叩きで TypeError になった場合、同一オリジン /api/mcp プロキシへ
//   自動フォールバック（capabilities が mcpProxy を通知する環境のみ）

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_SERVERS_KEY = "mcpServers";
const MCP_ALLOW_WRITE_KEY = "mcpAllowWrite";
const MCP_PROXY_PATH = "/api/mcp";

// バックエンドの mcpProxy capability。app.js が initMcp() で注入する
let proxyAvailable = () => false;
// サーバーキー → { getToken(forceRefresh) → Promise<string|null> }
const authProviders = new Map();
// サーバーキー → 実行時状態（セッション・ツール一覧・接続状態）
const runtime = new Map();
let rpcId = 0;

export function initMcp({ hasProxy } = {}) {
  if (typeof hasProxy === "function") proxyAvailable = hasProxy;
}

export function registerMcpAuthProvider(key, provider) {
  if (provider && typeof provider.getToken === "function") authProviders.set(key, provider);
  else authProviders.delete(key);
}

function notifyMcpChanged() {
  document.dispatchEvent(new CustomEvent("mcp:changed"));
}

function serverRuntime(key) {
  let state = runtime.get(key);
  if (!state) {
    state = { sessionId: null, tools: [], connected: false, error: "", transport: null };
    runtime.set(key, state);
  }
  return state;
}

export function mcpRuntime(key) {
  return serverRuntime(key);
}

// ---- サーバーレジストリ（localStorage。トークンは BYO として同じ場所に保持） ----

export function listMcpServers() {
  try {
    const list = JSON.parse(localStorage.getItem(MCP_SERVERS_KEY) || "[]");
    return Array.isArray(list) ? list.filter(s => s && typeof s.key === "string" && typeof s.url === "string") : [];
  } catch (e) {
    return [];
  }
}

function saveMcpServers(list) {
  try { localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(list)); } catch (e) {}
}

export function getMcpServer(key) {
  return listMcpServers().find(s => s.key === key) || null;
}

export function upsertMcpServer(entry) {
  const list = listMcpServers();
  const index = list.findIndex(s => s.key === entry.key);
  if (index >= 0) list[index] = { ...list[index], ...entry };
  else list.push(entry);
  saveMcpServers(list);
  notifyMcpChanged();
}

export function removeMcpServer(key) {
  disconnectMcpServer(key);
  saveMcpServers(listMcpServers().filter(s => s.key !== key));
  notifyMcpChanged();
}

// ---- 書き込み系ツールの扱い（AI に公開するかの設定） ----

export function getMcpAllowWrite() {
  try { return localStorage.getItem(MCP_ALLOW_WRITE_KEY) === "1"; } catch (e) { return false; }
}

export function setMcpAllowWrite(value) {
  try { localStorage.setItem(MCP_ALLOW_WRITE_KEY, value ? "1" : "0"); } catch (e) {}
}

// ツール名から書き込み系を推定する（snake_case でも動くよう部分一致）
const WRITE_TOOL_RE = /(creat|upload|delet|remov|updat|edit|move|copy|renam|write|trash|shar|invit|modif)/i;
export function isMcpWriteTool(name) {
  return WRITE_TOOL_RE.test(String(name || ""));
}

// ---- 低レベル通信 ----

// direct 失敗（CORS 等の TypeError）時に同一オリジンプロキシへフォールバックする fetch。
// Box のトークンエンドポイント等、JSON-RPC 以外の POST にも使えるよう公開する
export async function mcpFetch(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!proxyAvailable() || !(error instanceof TypeError)) throw error;
    const proxied = `${MCP_PROXY_PATH}?url=${encodeURIComponent(url)}`;
    return await fetch(proxied, init);
  }
}

async function tokenFor(server, forceRefresh = false) {
  const provider = authProviders.get(server.key);
  if (provider) return await provider.getToken(forceRefresh);
  return server.token || null;
}

// JSON-RPC メッセージを送信する。id 無し = 通知（応答を待たない）
async function rpcSend(server, message, { timeout = 30000 } = {}) {
  const state = serverRuntime(server.key);
  const send = async (token) => {
    const headers = {
      "Accept": "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (state.sessionId) {
      headers["Mcp-Session-Id"] = state.sessionId;
      headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    }
    return await mcpFetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeout),
    });
  };

  let token = await tokenFor(server);
  let response = await send(token);
  // 401 → プロバイダ経由でトークンを更新して1回だけ再試行（BYO 固定トークンは再送のみ）
  if (response.status === 401 && authProviders.has(server.key)) {
    token = await tokenFor(server, true);
    if (token) response = await send(token);
  }
  const sessionHeader = response.headers.get("mcp-session-id");
  if (sessionHeader) state.sessionId = sessionHeader;
  if (response.status === 202 || response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  let payload;
  if (contentType.includes("text/event-stream")) {
    payload = await readSseMessages(response);
  } else {
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const messages = Array.isArray(payload) ? payload : (payload ? [payload] : []);
  if (message.id == null) return null;
  const reply = messages.find(m => m && m.id === message.id) || messages.find(m => m && m.id != null) || null;
  if (!reply) throw new Error("MCP 応答がありません");
  if (reply.error) throw new Error(reply.error.message || JSON.stringify(reply.error));
  return reply.result ?? null;
}

// text/event-stream 本体から JSON-RPC メッセージを取り出す（data: 行の結合）
async function readSseMessages(response) {
  const text = await response.text();
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch (e) {}
  }
  return messages;
}

// ---- 接続・ツール一覧 ----

// initialize → notifications/initialized → tools/list（ページネーション対応）
export async function connectMcpServer(key) {
  const server = getMcpServer(key);
  const state = serverRuntime(key);
  if (!server) {
    state.connected = false;
    state.error = "not registered";
    return { ok: false, error: state.error };
  }
  state.sessionId = null;
  state.connected = false;
  state.error = "";
  try {
    await rpcSend(server, {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "kasugai-canvas", version: "1.0" },
      },
    });
    await rpcSend(server, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    const tools = [];
    let cursor;
    do {
      const result = await rpcSend(server, {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      });
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
    } while (cursor);
    state.tools = tools;
    state.connected = true;
  } catch (error) {
    state.tools = [];
    state.error = error instanceof Error ? error.message : String(error);
  }
  notifyMcpChanged();
  return { ok: state.connected, tools: state.tools, error: state.error || undefined };
}

export function disconnectMcpServer(key) {
  const state = serverRuntime(key);
  state.sessionId = null;
  state.tools = [];
  state.connected = false;
  state.error = "";
  notifyMcpChanged();
}

export async function connectEnabledMcpServers() {
  const results = {};
  for (const server of listMcpServers()) {
    if (!server.enabled) continue;
    results[server.key] = await connectMcpServer(server.key);
  }
  return results;
}

// ---- チャットツールへの合成 ----

function sanitizeDeclName(key, toolName) {
  let name = `${key}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!/^[A-Za-z_]/.test(name)) name = `m_${name}`;
  return name.slice(0, 64);
}

// JSON Schema → Gemini parameters（type 大文字化・未知キーは送らない）
function toGeminiSchema(node) {
  if (!node || typeof node !== "object") return { type: "OBJECT", properties: {} };
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  let schema = node;
  // anyOf/oneOf は先頭の有効枝に畳む（["x","null"] 型は nullable 化）
  for (const unionKey of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[unionKey])) {
      const branches = schema[unionKey];
      const nonNull = branches.filter(b => b && b.type !== "null");
      const merged = { ...(nonNull[0] || branches[0] || {}) };
      delete merged[unionKey];
      if (nonNull.length !== branches.length) merged.nullable = true;
      schema = { ...schema, ...merged };
      delete schema[unionKey];
    }
  }
  const out = {};
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== "null") : schema.type;
  if (typeof type === "string") out.type = type.toUpperCase();
  if (Array.isArray(schema.type) && schema.type.includes("null")) out.nullable = true;
  if (schema.nullable === true) out.nullable = true;
  for (const key of ["description", "title", "format", "default", "enum", "required"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [prop, propSchema] of Object.entries(schema.properties)) {
      out.properties[prop] = toGeminiSchema(propSchema);
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (out.type === "OBJECT" && !out.properties) out.properties = {};
  return out;
}

// 有効＋接続済みサーバーのツールを Gemini functionDeclarations 形式で返す。
// 書き込み系ツールは mcpAllowWrite 設定が ON のときのみ公開する
export function mcpDeclarations() {
  const allowWrite = getMcpAllowWrite();
  const declarations = [];
  for (const server of listMcpServers()) {
    if (!server.enabled) continue;
    const state = serverRuntime(server.key);
    if (!state.connected) continue;
    for (const tool of state.tools) {
      if (!tool?.name) continue;
      const write = isMcpWriteTool(tool.name);
      if (write && !allowWrite) continue;
      declarations.push({
        name: sanitizeDeclName(server.key, tool.name),
        description: `[${server.name || server.key}] ${tool.description || tool.name}`.slice(0, 500),
        parameters: toGeminiSchema(tool.inputSchema),
      });
    }
  }
  return declarations;
}

// 宣言名 → 呼び出し対象の解決（executeChatTool の振り分け用）
export function mcpToolTarget(declName) {
  for (const server of listMcpServers()) {
    const state = serverRuntime(server.key);
    for (const tool of state.tools) {
      if (sanitizeDeclName(server.key, tool.name) === declName) {
        return { serverKey: server.key, serverName: server.name || server.key, toolName: tool.name, write: isMcpWriteTool(tool.name) };
      }
    }
  }
  return null;
}

// tools/call。結果は {ok, content, text} に正規化して返す
export async function callMcpTool(serverKey, toolName, args = {}) {
  const server = getMcpServer(serverKey);
  if (!server) throw new Error(`MCP サーバーが未登録です: ${serverKey}`);
  const result = await rpcSend(server, {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  }, { timeout: 120000 });
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
  const structured = result?.structuredContent;
  return {
    ok: !result?.isError,
    content,
    ...(structured !== undefined ? { structured } : {}),
    text: text || (structured !== undefined ? JSON.stringify(structured) : ""),
  };
}
