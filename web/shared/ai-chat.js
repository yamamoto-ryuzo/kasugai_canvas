// KASUGAI Canvas — 共有 AI チャット subsystem（エンジン横断）
// Cesium 版から切り出したチャットパネル・プロバイダ接続・ツール実行の中核。
// 実行面は window.kasugaiApi（各エンジンが提供するアダプタ）へ委譲するため、
// エンジン固有の操作はすべて api メソッドの有無で公開ツールを絞る。
import { initI18n, applyI18n, t } from "./i18n.js";
import {
  initMcp, listMcpServers, upsertMcpServer, removeMcpServer,
  connectMcpServer, disconnectMcpServer, connectEnabledMcpServers,
  mcpRuntime, mcpDeclarations, mcpToolTarget, callMcpTool,
  getMcpAllowWrite, setMcpAllowWrite,
} from "./mcp.js";
import {
  initBoxAuth, getBoxClientId, setBoxClientId, boxConnected,
  startBoxAuth, disconnectBox, handleBoxRedirect,
} from "./box.js";
import {
  backendUrl, detectBackend, getBackendCapabilities, hasBackendFeature,
  isBackendCapabilitiesResolved, setBackendCapabilities as setBackendCaps,
} from "./backend.js";

// ---- バックエンド capabilities（エンジン横断で共有する状態） ----
// 状態の正本は shared/backend.js。検出は detectBackend が同一オリジン優先・
// 静的配信はローカルアプリ(127.0.0.1:8510)へフォールバックして行い、
// cesium は app.js の detectBackend、プレイヤー系は initAiChat の
// loadBackendCapabilities が起動時に呼ぶ
export {
  backendUrl, getBackendCapabilities, hasBackendFeature,
  isBackendCapabilitiesResolved, LOCAL_BACKEND_ORIGIN, backendBaseUrl,
} from "./backend.js";
export function setBackendCapabilities(caps, resolved = true, base = "") {
  setBackendCaps(caps, resolved, base);
}
let aiEngine = "cesium";

// /api/fetch プロキシに渡せる取得先かを判定する。同一オリジンは直接取得できる
// ためプロキシ不要で、ループバック(localhost/127.x/::1)は SSRF 対策により
// /api/fetch が 403 を返すため対象外としブラウザから直接取得させる
export function isFetchProxyTarget(url) {
  try {
    const target = new URL(String(url || ""));
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    if (target.origin === location.origin) return false;
    const host = target.hostname.toLowerCase();
    return !(host === "localhost" || host.endsWith(".localhost")
      || host === "::1" || host === "[::1]" || /^127\./.test(host));
  } catch (e) {
    return false;
  }
}

// /health + /api/capabilities によるバックエンド検出。
// 検出本体は shared/backend.js（同一オリジン優先・静的配信ではローカル
// アプリ 127.0.0.1:8510 をバックエンドとして検出）。検出 Promise は
// モジュール内で共有されるため他モジュールの先行呼び出しと重複しない
export async function loadBackendCapabilities() {
  return detectBackend();
}

// LLM API 呼び出し（Gemini generateContent / OpenAI chat completions）の
// 1リクエストあたりのタイムアウト。応答しない接続が「…」のまま
// チャットキュー全体を塞ぐのを防ぐ
const CHAT_LLM_TIMEOUT_MS = 120000;

const chatProjectId = () => window.kasugaiApi?.getProjectId?.() || "default";
const chatGoogleApiKey = () => window.kasugaiApi?.getGoogleApiKey?.() || localStorage.getItem("googleApiKey") || "";
const chatGeminiModel = () => window.kasugaiApi?.getGeminiModel?.() || localStorage.getItem("googleGeminiModel") || "gemini-3.1-flash-lite";

// flyToFeature が無いエンジンでは flyTo ビュー指定へ落とす
function flyToFeatureOrView(lat, lng, opts = {}) {
  const api = window.kasugaiApi;
  if (api?.flyToFeature) return api.flyToFeature(lat, lng, opts);
  return api?.flyTo?.({ latitude: lat, longitude: lng, ...opts });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g,
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// ---- チャットツール名 → 必要な kasugaiApi メソッドの対応表 ----
// "local:" 始まりは api 不要のローカル実装ツール。エンジンが api メソッドを
// 実装していないツールは AI に公開しない（2D プレイヤーで 3D 操作を出さない等）
const CHAT_TOOL_API = {
  flyTo: "flyTo", flyToFeature: "flyToFeature",
  setLayerVisible: "setLayerVisible", setLayerLegendVisible: "setLayerLegendVisible",
  listLayers: "listLayers", focusLayer: "focusLayer", getCamera: "getCamera",
  listBasemaps: "listBasemaps", setBasemap: "setBasemap",
  searchLocation: "searchLocation", searchPlaces: "searchPlaces", openStreetView: "openStreetView",
  listDataFiles: "listDataFiles", saveDataFile: "saveDataFile", deleteDataFile: "deleteDataFile",
  listCameraPresets: "listCameraPresets", flyToPreset: "flyToPreset",
  setTerrain: "setTerrain", setEffect: "setEffect", setUnderground: "setUnderground", setClip: "setClip",
  listFlyPaths: "listFlyPaths", playFlyPath: "playFlyPath", stopFly: "stopFly",
  setFlySettings: "setFlySettings", addFlyPath: "addFlyPath", flyRoute: "flyRoute",
  vectorSearch: "vectorSearch", getShareUrl: "getShareUrl", buildShareUrl: "buildShareUrl",
  showReport: "showReport", listProjects: "listProjects", switchProject: "switchProject",
  toggleDrawMode: "toggleDrawMode", applyInspector: "applyInspector", exportInspector: "exportInspector",
  checkUpdate: "checkUpdate", installUpdate: "installUpdate",
  bridgeSetup: "local:bridgeSetup",
  runCode: "local:runCode",
  addLayer: "addLayer", addGeoJsonLayer: "addGeoJsonLayer",
  shutdownApp: "shutdownApp",
  savePlugin: "saveStoragePlugin", listPlugins: "listStoragePlugins",
  getPluginCode: "getStoragePlugin", removePlugin: "removeStoragePlugin",
  setPluginEnabled: "setStoragePluginEnabled", publishPlugin: "publishStoragePlugin",
  fetchData: "fetchData", getLayerGeoJson: "getLayerGeoJson",
  addDataLayer: "addDataLayer", removeDataLayer: "removeDataLayer",
  setToolMaxSteps: "local:setToolMaxSteps",
  setLayerFilter: "setLayerFilter", listUiControls: "listUiControls", controlUi: "controlUi",
  listGsiLayers: "listGsiLayers", importGsiLayers: "importGsiLayers",
  listGsiCatalog: "listGsiCatalog", addGsiLayer: "addGsiLayer",
  setGsiLayerOpacity: "setGsiLayerOpacity", moveGsiLayer: "moveGsiLayer", removeGsiLayer: "removeGsiLayer",
  listGsiSakuzu: "listGsiSakuzu", importGsiSakuzu: "importGsiSakuzu",
  listGsiBasemaps: "listGsiBasemaps", setGsiBasemap: "setGsiBasemap",
  importGsiCatalog: "importGsiCatalog",
  setGsiLayerHidden: "setGsiLayerHidden", removeGsiSakuzu: "removeGsiSakuzu",
  getGsiElevation: "getGsiElevation",
  getGsiShareUrl: "getGsiShareUrl", setGsiGlobe: "setGsiGlobe",
};

function chatToolAvailable(name) {
  const apiName = CHAT_TOOL_API[name] ?? name;
  if (apiName.startsWith("local:")) return true;
  return typeof window.kasugaiApi?.[apiName] === "function";
}

// ブリッジの /health・/models から検出した実際の既定モデル（プロバイダ別）。
// ユーザー未選択時にチャットヘッダーへ「実際に動くモデル」を表示するために使う
const detectedBridgeModels = {};
// チャットドロップダウンで選択中プロバイダの接続確認状態。
// "connecting"（確認待ち・赤表示）→ "ok"（確認済み）または "ng"（疎通失敗・赤のまま）
let providerConnState = null;
// プロバイダ別の接続失敗理由（ブリッジ /models が返した error 等）
const providerConnDetail = {};
// チャット側ドロップダウンからの切替時に、設定画面の実接続検証（/models 等の重い
// テスト＝devin acp 起動やブラウザ認証まで発火し得る）を抑制するフラグ。
// モデル確認・実接続テストは設定画面での操作時のみ行う
let suppressSettingsVerify = false;
// ブリッジハブの既定エンドポイント。アプリ版（local ティア）では bridge-hub/ が
// 8511 で待受け、選択されたプロバイダのブリッジを遅延起動して振り分ける
// （POST {message,...} → {reply,actions} のエージェント接続口経由）。
// ※ setupGoogleSettings() 等がモジュール評価中に実行されるため、
//   初期化で参照する定数は呼び出し位置より前に置く（TDZ 回避）
const BRIDGE_HUB_ENDPOINT_APP = "http://127.0.0.1:8511/agent";
// ブラウザ WebGIS 用 bridge-hub（bridge-hub.exe）の検出ポート。
// 8512 = ブラウザ WebGIS 用既定（run-hidden.vbs/install-autostart.ps1）。
// 8511 も探すのは、BRIDGE_HUB_PORT を変えずに手動起動したハブや
// capabilities が届かない経路でアプリ版ハブだけが居るケースのため
const WEBGIS_HUB_PORTS = [8512, 8511];
// ブリッジ経由のプロバイダ（capabilities の同名キーがエンドポイントを通知する）
const BRIDGE_PROVIDERS = ["copilot", "devin", "antigravity"];
// ブリッジ系プロバイダ（copilot/devin/antigravity/agent）のエンドポイント記憶キー。
// 入力欄は1つだが、切替時に前プロバイダの値を各キーへ退避し、
// 別ブリッジのURLを引き継いで送信先・モデル一覧が混線しないようにする
const PROVIDER_ENDPOINT_KEYS = {
  copilot: "agentEndpoint.copilot",
  devin: "agentEndpoint.devin",
  antigravity: "agentEndpoint.antigravity",
  agent: "agentEndpoint.agent",
};
const PROVIDER_ORDER = ["gemini", "openai", "copilot", "devin", "antigravity", "agent"];
// ---- ブラウザ WebGIS 用 bridge-hub 検出 ----
// アプリ版を持たない環境（CDN ホスト版・静的配信・他ポート起動など）でも、
// ユーザーが bridge-hub（bridge-hub.exe）を起動していれば /health が hub:true を返す。
// その場合は capabilities の feature 通知が無くてもブリッジ系プロバイダを
// 有効とみなす。8511 はアプリのハブ口なので、ブラウザ WebGIS 用の既定は 8512
// （run-hidden.vbs / install-autostart.ps1。新版アプリは 8512 のハブを
// 旧ブリッジ掃除の対象から外している）
let webgisHub = undefined; // {endpoint, providers:{...}} = 検出 / null = 未検出
let webgisHubAt = 0;
const WEBGIS_HUB_TTL_MS = 15000;
async function probeWebgisHub() {
  if (webgisHub !== undefined
    && Date.now() - webgisHubAt < WEBGIS_HUB_TTL_MS) return webgisHub;
  webgisHubAt = Date.now();
  for (const port of WEBGIS_HUB_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`,
        { signal: AbortSignal.timeout(2000), cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.hub) {
        webgisHub = {
          endpoint: `http://127.0.0.1:${port}/agent`,
          providers: d.providers || {},
        };
        return webgisHub;
      }
    } catch (e) { /* 次の候補へ */ }
  }
  webgisHub = null;
  return null;
}
// /health をポーリングしてハブの立ち上がりを待つ（自己インストール exe の
// 実行待ち用。TTL を無視して都度疎通する）
async function waitForWebgisHub(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    webgisHub = undefined;
    if (await probeWebgisHub()) return webgisHub;
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}
// ハブ未検出時の自動インストール誘導。
// フロー: bridge-hub.exe（自己インストール型）を DL → ユーザーが実行すると
// %LOCALAPPDATA%\kasugai\bridge-hub へコピー＋自動起動登録＋8512 で起動 →
// こちらは /health ポーリングで検出して接続まで自動完了する。
// ブラウザから exe を直接起動することはできないため、ユーザー操作は
// 「DL した exe を実行」の1回のみ（以後はログイン時自動起動）
let hubInstallWait = null; // 重複実行ガード
async function offerHubInstall(provider, auto) {
  const note = document.querySelector("#bridge-hub-note");
  const btn = document.querySelector("#bridge-hub-install");
  const status = document.querySelector("#bridge-hub-status");
  if (!note || !btn) return;
  note.hidden = false;
  const start = async () => {
    // exe のダウンロードは常に発火する（待機中の再クリック＝再DL・再案内
    // のリトライ導線。ポーリング自体は1本に保つ）
    const a = document.createElement("a");
    a.href = "../download/bridge-hub.exe";
    a.download = "bridge-hub.exe";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (status) status.textContent = t("chat.bridge.hubWaitExe");
    if (hubInstallWait) return hubInstallWait;
    hubInstallWait = (async () => {
      const hub = await waitForWebgisHub(180000);
      if (hub) {
        const input = document.querySelector("#agent-endpoint");
        if (input && !input.value.trim()) input.value = hub.endpoint;
        if (status) status.textContent = t("chat.bridge.hubDetected");
        void refreshBridgeStatus(provider);
      } else if (status) {
        status.textContent = t("chat.bridge.hubNotFound");
      }
    })().finally(() => { hubInstallWait = null; });
    return hubInstallWait;
  };
  btn.onclick = () => void start();
  // プロバイダ選択（ユーザーの明示操作）に続けて自動でも DL+待機を開始する
  if (auto) void start();
}
// ブリッジ系プロバイダの利用可否。アプリ版は capabilities の feature 通知、
// ブラウザ WebGIS 用はハブの providers.<名>.available で判定する
function bridgeFeatureAvailable(provider) {
  if (hasBackendFeature(provider + "Bridge")) return true;
  return webgisHub?.providers?.[provider]?.available === true;
}
// 管理 → AI → データソース: MCP サーバー接続（Box・任意のリモートMCP）の管理画面。
// サーバー定義は localStorage "mcpServers"、Box のトークンは BYO（OAuth+PKCE）
function setupDataSources() {
  const panel = document.querySelector("#datasource-panel");
  if (!panel) return;
  const status = document.querySelector("#mcp-status");
  const listEl = document.querySelector("#mcp-server-list");
  const boxClientInput = document.querySelector("#box-client-id");
  const boxStatus = document.querySelector("#box-status");
  const allowWriteInput = document.querySelector("#mcp-allow-write");
  const setStatus = message => { if (status) status.textContent = message || ""; };

  if (boxClientInput) boxClientInput.value = getBoxClientId();
  if (allowWriteInput) allowWriteInput.checked = getMcpAllowWrite();
  allowWriteInput?.addEventListener("change", () => setMcpAllowWrite(allowWriteInput.checked));

  const refreshBoxStatus = () => {
    if (!boxStatus) return;
    boxStatus.textContent = boxConnected()
      ? t("mcp.box.connected")
      : (getBoxClientId() ? t("mcp.box.ready") : t("mcp.box.notConfigured"));
  };

  const renderList = () => {
    if (!listEl) return;
    listEl.replaceChildren();
    const servers = listMcpServers();
    if (!servers.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = t("mcp.listEmpty");
      listEl.append(empty);
      return;
    }
    for (const server of servers) {
      const state = mcpRuntime(server.key);
      const row = document.createElement("div");
      row.className = "mcp-server-row";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = !!server.enabled;
      toggle.addEventListener("change", async () => {
        upsertMcpServer({ key: server.key, enabled: toggle.checked });
        if (toggle.checked) await connectMcpServer(server.key);
        else disconnectMcpServer(server.key);
      });
      const name = document.createElement("span");
      name.className = "mcp-server-name";
      name.textContent = server.name || server.key;
      name.title = server.url;
      const stateEl = document.createElement("span");
      stateEl.className = "hint";
      stateEl.textContent = state.connected
        ? t("mcp.serverTools", { count: state.tools.length })
        : (state.error ? t("mcp.serverError", { error: state.error }) : t("mcp.serverDisconnected"));
      const reconnect = document.createElement("button");
      reconnect.type = "button";
      reconnect.textContent = t("mcp.reconnect");
      reconnect.addEventListener("click", () => void connectMcpServer(server.key));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = t("mcp.remove");
      remove.addEventListener("click", () => {
        if (window.confirm(t("mcp.confirmRemove", { name: server.name || server.key }))) removeMcpServer(server.key);
      });
      row.append(toggle, name, stateEl, reconnect, remove);
      listEl.append(row);
    }
  };

  document.querySelector("#box-connect")?.addEventListener("click", () => {
    setBoxClientId(boxClientInput?.value || "");
    try {
      void startBoxAuth();
    } catch (error) {
      if (boxStatus) boxStatus.textContent = t("common.error", { error: error.message });
    }
  });
  document.querySelector("#box-disconnect")?.addEventListener("click", () => {
    disconnectBox();
    refreshBoxStatus();
  });

  document.querySelector("#mcp-add")?.addEventListener("click", async () => {
    const name = (document.querySelector("#mcp-add-name")?.value || "").trim();
    const url = (document.querySelector("#mcp-add-url")?.value || "").trim();
    const token = (document.querySelector("#mcp-add-token")?.value || "").trim();
    if (!name || !/^https?:\/\//i.test(url)) {
      setStatus(t("mcp.addInvalid"));
      return;
    }
    const key = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `srv${Date.now()}`;
    upsertMcpServer({ key, name, url, enabled: true, ...(token ? { token } : {}) });
    const result = await connectMcpServer(key);
    setStatus(result.ok ? t("mcp.addOk", { count: result.tools.length }) : t("mcp.addNg", { error: result.error }));
    const urlInput = document.querySelector("#mcp-add-url");
    const nameInput = document.querySelector("#mcp-add-name");
    const tokenInput = document.querySelector("#mcp-add-token");
    if (result.ok && urlInput) urlInput.value = "";
    if (result.ok && nameInput) nameInput.value = "";
    if (result.ok && tokenInput) tokenInput.value = "";
  });

  document.addEventListener("mcp:changed", () => { renderList(); refreshBoxStatus(); });
  renderList();
  refreshBoxStatus();
}

// Google → プラグインタブ: IndexedDB に保存した AI生成/取込プラグインの管理画面。
// 同梱 PLUGIN/ とは分離されたブラウザローカルの開発領域を一覧・有効化・削除・入出力する
function setupAgentPanel() {
  const list = document.querySelector("#agent-plugin-list");
  if (!list) return;
  const status = document.querySelector("#agent-status");
  const fileInput = document.querySelector("#agent-import-file");
  const setStatus = message => { if (status) status.textContent = message || ""; };

  function downloadPlugin(record) {
    const pkg = {
      format: "kasugai-plugin/1",
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      layer: record.layer,
      code: record.code,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${record.id}.kasp`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function render() {
    if (!window.kasugaiApi?.listStoragePlugins) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "\u3053\u306e\u30a8\u30f3\u30b8\u30f3\u3067\u306f\u30d7\u30e9\u30b0\u30a4\u30f3\u6a5f\u80fd\u306f\u672a\u5bfe\u5fdc"; list.append(empty); return; }
    const records = await window.kasugaiApi.listStoragePlugins();
    list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = t("agent.empty");
      list.append(empty);
      return;
    }
    for (const record of records) {
      const card = document.createElement("div");
      card.style.cssText = "border:1px solid #dbe4e8;border-radius:6px;padding:8px;margin-bottom:8px;font-size:0.9em;";

      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;gap:6px;";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = !!record.enabled;
      toggle.title = t("agent.enabledTitle");
      const title = document.createElement("strong");
      title.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      title.textContent = `${record.name || record.id} (${record.id})`;
      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.textContent = t("fly.export");
      exportBtn.title = t("agent.exportTitle");
      // PLUGIN/ への公開はローカルサーバー版のみ（静的/Workers環境では非表示）
      const publishBtn = hasBackendFeature("pluginWrite") ? document.createElement("button") : null;
      if (publishBtn) {
        publishBtn.type = "button";
        publishBtn.textContent = t("agent.publish");
        publishBtn.title = t("agent.publishTitle");
      }
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = t("fly.delete");
      deleteBtn.title = t("agent.deleteTitle");
      head.append(toggle, title, exportBtn);
      if (publishBtn) head.append(publishBtn);
      head.append(deleteBtn);
      card.append(head);

      const meta = document.createElement("div");
      meta.style.cssText = "font-size:0.8em;color:#71818d;margin-top:2px;";
      meta.textContent = t("agent.updated", { time: record.updatedAt ? new Date(record.updatedAt).toLocaleString() : "-" });
      card.append(meta);

      if (record.lastError) {
        const error = document.createElement("div");
        error.style.cssText = "font-size:0.8em;color:#a82020;margin-top:2px;white-space:pre-wrap;word-break:break-all;";
        error.textContent = t("agent.lastError", { error: record.lastError });
        card.append(error);
      }

      const details = document.createElement("details");
      details.style.marginTop = "4px";
      const summary = document.createElement("summary");
      summary.style.cssText = "cursor:pointer;font-size:0.85em;";
      summary.textContent = t("agent.code");
      const pre = document.createElement("pre");
      pre.style.cssText = "max-height:200px;overflow:auto;background:#f4f7f8;border:1px solid #dbe4e8;border-radius:4px;padding:6px;font-size:0.75em;white-space:pre-wrap;word-break:break-all;";
      details.append(summary, pre);
      card.append(details);

      toggle.addEventListener("change", async () => {
        await window.kasugaiApi.setStoragePluginEnabled(record.id, toggle.checked);
        await render();
      });
      exportBtn.addEventListener("click", async () => {
        const full = await window.kasugaiApi.getStoragePlugin(record.id);
        if (full) downloadPlugin(full);
      });
      publishBtn?.addEventListener("click", async () => {
        if (!window.confirm(t("agent.confirmPublish", { name: record.name || record.id }))) return;
        const result = await window.kasugaiApi.publishStoragePlugin(record.id);
        setStatus(result?.error
          ? t("agent.publishFailed", { error: result.error })
          : t("agent.published", { name: record.name || record.id }));
      });
      deleteBtn.addEventListener("click", async () => {
        if (!window.confirm(t("agent.confirmDelete", { name: record.name || record.id }))) return;
        await window.kasugaiApi.removeStoragePlugin(record.id);
        setStatus(t("agent.deleted", { name: record.name || record.id }));
      });
      // コードは一覧に含めないため、開いた時点で取得する
      details.addEventListener("toggle", async () => {
        if (details.open && !pre.textContent) {
          const full = await window.kasugaiApi.getStoragePlugin(record.id);
          pre.textContent = full?.code || "";
        }
      });

      list.append(card);
    }
  }

  document.querySelector("#agent-refresh")?.addEventListener("click", () => void render());
  document.querySelector("#agent-import")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = "";
    for (const file of files) {
      try {
        const text = await file.text();
        let record;
        if (/\.js$/i.test(file.name)) {
          const id = file.name.replace(/\.js$/i, "");
          record = { id, name: id, code: text, enabled: true };
        } else {
          const pkg = JSON.parse(text);
          record = { id: pkg.id, name: pkg.name, version: pkg.version, description: pkg.description, layer: pkg.layer, code: pkg.code, enabled: true };
        }
        if (!record.id || typeof record.code !== "string" || !record.code) throw new Error(t("agent.invalidFile"));
        // 取込コードも適用前に全文確認する
        if (!(await confirmPluginApply(record))) continue;
        const result = await window.kasugaiApi.saveStoragePlugin(record);
        setStatus(result?.loadError ? t("agent.savedWithError", { error: result.loadError }) : t("agent.imported", { name: record.name || record.id }));
      } catch (error) {
        setStatus(t("agent.importFailed", { error: error instanceof Error ? error.message : error }));
      }
    }
  });

  // kasugaiApi はこのモジュール評価中に定義されるため、購読登録は次のタスクへ遅延する
  setTimeout(() => {
    const start = () => {
      window.kasugaiApi.on("storage-plugins-changed", () => void render());
      void render();
    };
    if (window.kasugaiApi?.isReady) start();
    else window.kasugaiApi?.on("ready", start);
  });
}

// Google APIキー未設定時はチャットパネルを表示しない。設定保存時に再評価する
// 注意: setupChatPanel は window.kasugaiApi 定義前に呼ばれるため localStorage を直接参照する
// 外部エージェント連携の設定値。Geminiキー未設定でもチャットが使えるよう別経路として扱う
// バックエンドが agent 機能を通知していれば既定エンドポイントとして使う
// （Cloud Run 版など公開デプロイを審査員が無設定で使えるようにするため）
function defaultAgentEndpoint() {
  const endpoint = getBackendCapabilities()?.agent?.endpoint;
  if (!endpoint || !hasBackendFeature("agent")) return "";
  try {
    return new URL(endpoint, window.location.href).href;
  } catch (e) {
    return "";
  }
}

function getAgentConfig() {
  try {
    const savedEndpoint = (localStorage.getItem("agentEndpoint") || "").trim();
    const savedEnabled = localStorage.getItem("agentEnabled");
    return {
      // 手動設定が無ければバックエンド通知の既定エンドポイントを使う
      endpoint: savedEndpoint || defaultAgentEndpoint(),
      token: sanitizeHeaderToken(localStorage.getItem("agentToken")),
      // 「有効」の明示保存、または未保存＋既定エンドポイント存在で有効化。
      // "0" の明示保存（ユーザーが無効化して保存）は尊重する
      enabled: savedEnabled === "1" || (savedEnabled === null && !savedEndpoint && !!defaultAgentEndpoint()),
      // BYO キー同梱は明示的な有効化のみ（既定 OFF）
      sendKey: localStorage.getItem("agentSendKey") === "1",
    };
  } catch (e) {
    return { endpoint: "", token: "", enabled: false, sendKey: false };
  }
}
function isAgentEnabled() {
  const config = getAgentConfig();
  return config.enabled && !!config.endpoint;
}

// BYOキーの送信先は https または localhost(開発用) に限定する。
// 平文 http の外部エンドポイントへキーが流れないようにするガード
function isSecureAgentEndpoint(endpoint) {
  try {
    const url = new URL(endpoint, window.location.href);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch (e) {
    return false;
  }
}

// HTTP ヘッダ値は ISO-8859-1 のみ。トークンのコピー時に混入しやすい
// 空白系文字（改行・タブ・全角スペース・NBSP 等）を取り除く。
// 非Latin-1文字が残ると fetch が "non ISO-8859-1 code point" で落ちる
function sanitizeHeaderToken(s) {
  return String(s || "").replace(/[\s  -​　]+/g, "");
}
// 設定画面で保存した Devin APIキー。ブリッジへは X-Devin-Api-Key ヘッダで
// 渡し、Devin ブリッジが devin acp の authenticate（meta.api_key）に使う。
// 空値も送ってブリッジ側のキーをクリアできるようにする（再びブラウザ認証へ戻る）。
// BYO キーと同じポリシーで https / localhost 以外の宛先には付けない
function getDevinApiKey() {
  try { return sanitizeHeaderToken(localStorage.getItem("devinApiKey")); } catch (e) { return ""; }
}
function devinAuthHeaders(endpoint) {
  if (!isSecureAgentEndpoint(endpoint)) return {};
  const key = getDevinApiKey();
  // サニタイズ後も非Latin-1が残るなら fetch で落ちる前に分かりやすく弾く
  if (/[^\x00-\xff]/.test(key)) throw new Error(t("chat.devin.apiKeyInvalid"));
  return { "X-Devin-Api-Key": key };
}

// GitHub Copilot / Devin / Antigravity プロバイダの選択肢管理。
// ハブ未検出でも設定画面では常時表示する — 未導入環境では選択が
// 「ハブの自己インストール exe 自動DL＋起動待機」の導線になるため。
// 利用可否の絞り込みはチャット側ドロップダウン（usableChatProviders）が担う。
// （プロバイダ「外部エージェント」は自作エージェント等の汎用接続口）
const bridgeProviderOptionStash = {};
function updateBridgeProviderOption(value) {
  const select = document.querySelector("#chat-provider");
  if (!select) return;
  const option = select.querySelector(`option[value="${value}"]`);
  // 旧版で外された選択肢があれば【ブリッジ】系（agent の手前）に戻す
  if (!option && bridgeProviderOptionStash[value]) {
    const agentOpt = select.querySelector('option[value="agent"]');
    select.insertBefore(bridgeProviderOptionStash[value], agentOpt || null);
    // 隠れている間に保存プロバイダが他へ切り替わっていた場合に備え、
    // 記憶上のプロバイダがこの値なら表示を戻す
    if (getChatProvider() === value) select.value = value;
  }
}
export function updateBridgeProviderOptions() {
  // アプリ通知の capabilities とは別に、手動起動のブラウザ WebGIS 用
  // bridge-hub（8511）も疎通してから選択肢を更新する。プローブは非同期の
  // ため、戻ってきた選択肢に合わせて設定欄も再同期する
  void (async () => {
    await probeWebgisHub();
    for (const v of BRIDGE_PROVIDERS) updateBridgeProviderOption(v);
    resyncProviderSelect();
  })();
}

export function updateChatPanelVisibility() {
  const panel = document.querySelector("#chat-panel");
  if (panel) {
    let hasKey = false;
    try { hasKey = !!localStorage.getItem("googleApiKey") || !!localStorage.getItem("openaiApiKey"); } catch (e) {}
    // アプリ管理ブリッジが使える環境ではキー未設定でもチャットを開ける
    // （ヘッダーのドロップダウンに有効なプロバイダだけが出る）
    const hasBridge = BRIDGE_PROVIDERS.some(bridgeFeatureAvailable);
    panel.style.display = (hasKey || isAgentEnabled() || hasBackendFeature("aiProxy") || hasBridge) ? "" : "none";
  }
  // 既定エンドポイント（バックエンド通知）を設定欄のプレースホルダに表示する
  const endpointInput = document.querySelector("#agent-endpoint");
  if (endpointInput && !endpointInput.value) {
    const fallback = defaultAgentEndpoint();
    if (fallback) endpointInput.placeholder = fallback;
  }
  // サーバーキーによるキーレスAI（aiProxy）の利用可否を Gemini 設定欄に表示する
  const proxyStatus = document.querySelector("#google-proxy-status");
  if (proxyStatus) {
    proxyStatus.textContent = hasBackendFeature("aiProxy") ? t("google.gemini.proxyNote") : "";
  }
  // 検出バックエンド（workers/cloudrun/local 等）と自動解決エンドポイントを表示する。
  // 「外部エージェント」プロバイダ選択時の実疎通テストは設定画面側（setupGoogleSettings）で行う
  const backendStatus = document.querySelector("#agent-backend-status");
  if (backendStatus && !backendStatus.textContent) {
    const fallback = defaultAgentEndpoint();
    backendStatus.textContent = getBackendCapabilities()?.tier
      ? t("agent.backendDetected", { tier: getBackendCapabilities().tier, endpoint: fallback || "—" })
      : t("agent.backendNone");
  }
  updateChatProviderLabel();
  void refreshChatProviderSwitch();
}

export function setupAiSettings() {
  const keyInput = document.querySelector("#google-api-key");
  const modelSelect = document.querySelector("#google-gemini-model");
  const stepsInput = document.querySelector("#google-tool-max-steps");
  const customInstructionsInput = document.querySelector("#chat-custom-instructions");
  const customInstructionsSaveButton = document.querySelector("#chat-instructions-save");
  const customInstructionsStatus = document.querySelector("#chat-instructions-status");
  const saveButton = document.querySelector("#google-settings-save");
  const status = document.querySelector("#google-settings-status");
  const providerSelect = document.querySelector("#chat-provider");
  const geminiFields = document.querySelector("#gemini-fields");
  const openaiFields = document.querySelector("#openai-fields");
  const openaiBaseUrlInput = document.querySelector("#openai-base-url");
  const openaiKeyInput = document.querySelector("#openai-api-key");
  const openaiModelInput = document.querySelector("#openai-model");
  const bridgeFields = document.querySelector("#bridge-fields");
  const endpointInput = document.querySelector("#agent-endpoint");
  const tokenInput = document.querySelector("#agent-token");
  const sendKeyInput = document.querySelector("#agent-send-key");
  const copilotStatus = document.querySelector("#copilot-endpoint-status");
  const copilotModelSelect = document.querySelector("#copilot-model");
  const devinApiKeyInput = document.querySelector("#devin-api-key");
  const devinStatus = document.querySelector("#devin-endpoint-status");
  const devinModelSelect = document.querySelector("#devin-model");
  const antigravityStatus = document.querySelector("#antigravity-endpoint-status");
  const antigravityModelSelect = document.querySelector("#antigravity-model");
  if (!keyInput || !saveButton) return;
  // ブリッジ系プロバイダの UI 要素（ステータス行・モデル選択）を provider 名で引く
  const bridgeUi = {
    copilot: { status: copilotStatus, modelSelect: copilotModelSelect },
    devin: { status: devinStatus, modelSelect: devinModelSelect },
    antigravity: { status: antigravityStatus, modelSelect: antigravityModelSelect },
  };
  // ブリッジの /models から利用可能なモデル一覧を取り込む。
  // 保存済みの選択が一覧に無ければ先頭に残す。空値はブリッジ既定モデル。
  // ハブが子ブリッジを起動中（コールドスタート）や、Devin の acp が pending を
  // 返している間は応答が遅れる/失敗するため一定間隔で再取得する
  // ブリッジ系の接続状態表示。NG/エラー時はステータス文字とモデル選択を
  // 赤にして未接続が一目で分かるようにする（OK/中立時は元の色に戻す）
  const setBridgeStatus = (ui, text, ok) => {
    if (!ui) return;
    if (text !== undefined && ui.status) ui.status.textContent = text;
    const ng = ok === false;
    if (ui.status) ui.status.style.color = ng ? "#c0392b" : "";
    if (ui.modelSelect) ui.modelSelect.style.borderColor = ng ? "#c0392b" : "";
  };
  const refreshBridgeModels = async (provider, endpoint, retries = 4) => {
    const ui = bridgeUi[provider];
    if (!ui?.modelSelect) return;
    const saved = getBridgeModel(provider);
    let models = [];
    let retry = false;
    if (endpoint) {
      try {
        // ブリッジハブ（複数プロバイダを統合して 8511 で受ける）は ?provider= で振り分ける。
        // 単体ブリッジはクエリを無視してそのまま /models に応答する。
        // Devin だけは APIキーを X-Devin-Api-Key ヘッダで同梱する
        const u = new URL("/models", endpoint);
        u.searchParams.set("provider", provider);
        const r = await fetch(u.href, {
          signal: AbortSignal.timeout(30000),
          headers: provider === "devin" ? devinAuthHeaders(endpoint) : undefined,
        });
        const d = await r.json().catch(() => ({}));
        if (Array.isArray(d?.models)) models = d.models.filter(m => m?.id);
        if (d?.model) detectedBridgeModels[provider] = d.model;
        retry = !!(d?.pending || (d?.error && !models.length));
        // ブリッジが返す失敗理由（APIキー拒否・起動失敗等）を保持し、
        // 接続失敗としてステータス欄・接続状態へ反映する（全プロバイダ共通）
        if (d?.error) {
          providerConnDetail[provider] = String(d.error);
          providerConnState = { provider, state: "ng", detail: String(d.error).slice(0, 200) };
          setBridgeStatus(ui, t("chat.devin.statusError", { error: String(d.error).slice(0, 300) }), false);
        } else if (d?.fallback) {
          // モデル一覧を実取得できず固定一覧が返った = CLI 未ログイン等の
          // エラー状態。実在する一覧のふりをしないため選択肢は既定のみにし、
          // 接続失敗として明示する（再試行はしない — ログインしないと解消しない）
          providerConnDetail[provider] = t("chat.bridge.modelsFallback");
          providerConnState = { provider, state: "ng", detail: providerConnDetail[provider] };
          setBridgeStatus(ui, providerConnDetail[provider], false);
          models = [];
          retry = false;
        } else {
          setBridgeStatus(ui, undefined, true);
        }
      } catch (e) { retry = true; }
      if (retry && retries > 0) {
        setTimeout(() => {
          if (providerSelect?.value === provider) void refreshBridgeModels(provider, endpoint, retries - 1);
        }, 8000);
      }
    }
    updateChatProviderLabel();
    ui.modelSelect.textContent = "";
    const add = (value, label) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      ui.modelSelect.appendChild(o);
    };
    add("", t(`chat.${provider}.modelDefault`));
    const seen = new Set();
    if (saved && !models.some(m => m.id === saved)) { add(saved, saved); seen.add(saved); }
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      add(m.id, modelOptionLabel(m));
    }
    ui.modelSelect.value = saved;
    if (ui.modelSelect.value !== saved) ui.modelSelect.value = "";
  };
  // ブリッジの疎通確認。入力済みエンドポイントがあればそれを、
  // 未入力ならブリッジハブ(8511)の候補を試す
  const refreshBridgeStatus = async (provider) => {
    const ui = bridgeUi[provider];
    if (!ui?.status) return;
    const configured = (endpointInput?.value || "").trim();
    const fallback = configured || bridgeCandidates(provider)[0];
    setBridgeStatus(ui, t(`chat.${provider}.endpoint`, { endpoint: fallback }), true);
    const found = configured ? await pingBridge(configured, provider) : await detectBridge(provider);
    // /health に version が無いハブは旧版（fallback 判定等に非対応）なので
    // 接続OK扱いせず「要更新」として明示し接続状態も NG にする
    const outdatedHub = found && found.hub === true && typeof found.version !== "string";
    if (outdatedHub) {
      providerConnDetail[provider] = t("chat.bridge.hubOld", { endpoint: found.endpoint });
      providerConnState = { provider, state: "ng", detail: providerConnDetail[provider] };
      setBridgeStatus(ui, providerConnDetail[provider], false);
    } else {
      setBridgeStatus(ui,
        found
          ? t(`chat.${provider}.statusOk`, { endpoint: found.endpoint, model: found.model })
          : t(`chat.${provider}.statusNg`, { endpoint: fallback }),
        !!found);
    }
    detectedBridgeModels[provider] = found?.model || "";
    updateChatProviderLabel();
    void refreshChatProviderSwitch();
    void refreshBridgeModels(provider, found?.endpoint || "");
  };
  // 「外部エージェント」プロバイダの実疎通テスト。設定画面が動作確認の場 ——
  // エンドポイントへ実際に問い合わせて接続可否をステータス欄に表示する
  const agentBackendStatus = document.querySelector("#agent-backend-status");
  const refreshAgentStatus = async () => {
    if (!agentBackendStatus) return;
    const ep = (endpointInput?.value || "").trim() || defaultAgentEndpoint();
    if (!ep) {
      agentBackendStatus.textContent = t("agent.backendNone");
      return;
    }
    agentBackendStatus.textContent = t("chat.provider.connecting");
    const ok = await verifyAgentConnection(ep);
    // 確認中にプロバイダや入力値が変わっていたら結果を捨てる
    if (providerSelect?.value !== "agent") return;
    agentBackendStatus.textContent = ok
      ? t("agent.endpointOk", { endpoint: ep })
      : t("agent.endpointNg", { endpoint: ep });
  };
  // 入力欄の値がどのプロバイダのものか。初期値は読み込んだプロバイダ
  let endpointOwner = getChatProvider();
  const loadBridgeEndpoint = (v) => {
    if (!endpointInput) return;
    let ep = "";
    try { ep = localStorage.getItem(PROVIDER_ENDPOINT_KEYS[v]) || ""; } catch (e) {}
    // 「外部エージェント」は従来どおり共有 agentEndpoint を既定値にする。
    // copilot/devin は別ブリッジのURLが紛れ込むため共有値は引き継がない
    if (!ep && v === "agent") {
      try { ep = localStorage.getItem("agentEndpoint") || ""; } catch (e) {}
    }
    endpointInput.value = ep;
  };
  const syncProviderFields = (userAction) => {
    const v = providerSelect?.value || "gemini";
    if (geminiFields) geminiFields.hidden = v !== "gemini";
    if (openaiFields) openaiFields.hidden = v !== "openai";
    const isBridge = v === "copilot" || v === "devin" || v === "antigravity" || v === "agent";
    if (bridgeFields) {
      bridgeFields.hidden = !isBridge;
      // 選択中プロバイダ専用の項目だけを表示（他プロバイダの案内は出さない）
      bridgeFields.querySelectorAll(".provider-only").forEach(el => {
        el.hidden = el.dataset.for !== v;
      });
    }
    // ブリッジハブ導入の案内は専用プロバイダ（copilot/devin/antigravity）のみ。
    // 「外部エージェント」（自作実装の接続口）には出さない
    const hubNote = document.querySelector("#bridge-hub-note");
    if (hubNote) hubNote.hidden = !BRIDGE_PROVIDERS.includes(v);
    // プロバイダ切替時は前プロバイダの入力値を記憶へ退避し、新プロバイダの値を読み込む
    if (endpointOwner !== v) {
      const prevKey = PROVIDER_ENDPOINT_KEYS[endpointOwner];
      if (prevKey && endpointInput) {
        try { localStorage.setItem(prevKey, endpointInput.value.trim()); } catch (e) {}
      }
      if (PROVIDER_ENDPOINT_KEYS[v]) loadBridgeEndpoint(v);
      endpointOwner = v;
    }
    if (BRIDGE_PROVIDERS.includes(v)) {
      // 残っている値が別ブリッジ（旧仕様の共有エンドポイント由来）なら
      // 打ち消して自動検出に回す。手動URLは pingBridge の識別子チェックが担保する
      const other = BRIDGE_PROVIDERS.filter(p => p !== v).flatMap(bridgeCandidates);
      if (endpointInput && endpointInput.value.trim() && other.includes(endpointInput.value.trim())) {
        endpointInput.value = "";
      }
      // 実接続テスト（/models 取得・自動検出）は設定画面からの操作時のみ。
      // チャット側ドロップダウンからの切替では suppressSettingsVerify が立ち、
      // ここでの重い検証（Devin の acp 起動・ブラウザ認証を含み得る）はスキップする
      if (!suppressSettingsVerify) {
        // エンドポイント未入力なら疎通するブリッジを自動検出して入力する。
        // 見つからずユーザーが明示選択した場合はハブの自動インストールを開始する
        if (endpointInput && !endpointInput.value.trim()) {
          void detectBridge(v).then(found => {
            if (found && endpointInput && !endpointInput.value.trim()) endpointInput.value = found.endpoint;
            void refreshBridgeStatus(v);
            if (!found && userAction) void offerHubInstall(v, true);
          });
        } else {
          void refreshBridgeStatus(v);
        }
      }
    }
    // 「外部エージェント」選択時はエンドポイントへ実疎通テストを行う（設定画面操作時のみ）
    if (v === "agent" && !suppressSettingsVerify) void refreshAgentStatus();
    updateChatProviderLabel();
  };
  try {
    keyInput.value = localStorage.getItem("googleApiKey") || "";
    const savedModel = localStorage.getItem("googleGeminiModel");
    if (savedModel && modelSelect) modelSelect.value = savedModel;
    if (providerSelect) providerSelect.value = getChatProvider();
    // Copilot/Devin 選択肢はアプリ版のみ。非対応環境で保存値が該当プロバイダなら Gemini 表示に戻す
    updateBridgeProviderOptions();
    if (openaiBaseUrlInput) openaiBaseUrlInput.value = localStorage.getItem("openaiBaseUrl") || "";
    if (openaiKeyInput) openaiKeyInput.value = localStorage.getItem("openaiApiKey") || "";
    if (openaiModelInput) openaiModelInput.value = localStorage.getItem("openaiModel") || "";
    if (endpointInput) endpointInput.value = localStorage.getItem("agentEndpoint") || "";
    if (tokenInput) tokenInput.value = localStorage.getItem("agentToken") || "";
    if (sendKeyInput) sendKeyInput.checked = localStorage.getItem("agentSendKey") === "1";
    if (devinApiKeyInput) devinApiKeyInput.value = localStorage.getItem("devinApiKey") || "";
    if (stepsInput) stepsInput.value = String(getChatMaxToolSteps());
    if (customInstructionsInput) customInstructionsInput.value = localStorage.getItem("chatCustomInstructions") || "";
    // 保存値・既定オプションだけ先に埋めておく
    for (const p of BRIDGE_PROVIDERS) void refreshBridgeModels(p, "");
    syncProviderFields();
  } catch (e) {}
  providerSelect?.addEventListener("change", () => syncProviderFields(true));
  saveButton.addEventListener("click", () => {
    try {
      localStorage.setItem("googleApiKey", keyInput.value.trim());
      if (modelSelect) localStorage.setItem("googleGeminiModel", modelSelect.value);
      if (providerSelect) localStorage.setItem("chatProvider", providerSelect.value);
      if (openaiBaseUrlInput) localStorage.setItem("openaiBaseUrl", openaiBaseUrlInput.value.trim());
      if (openaiKeyInput) localStorage.setItem("openaiApiKey", openaiKeyInput.value.trim());
      if (openaiModelInput) localStorage.setItem("openaiModel", openaiModelInput.value.trim());
      if (copilotModelSelect) localStorage.setItem("copilotModel", copilotModelSelect.value);
      if (devinModelSelect) localStorage.setItem("devinModel", devinModelSelect.value);
      if (antigravityModelSelect) localStorage.setItem("antigravityModel", antigravityModelSelect.value);
      // ブリッジ系プロバイダ（copilot/devin/antigravity/agent）はエージェント接続を有効化し、
      // API系（gemini/openai）は無効化する。プロバイダ選択が唯一の切替源
      const pv = providerSelect?.value || "gemini";
      if (endpointInput) {
        let ep = endpointInput.value.trim();
        if (!ep && BRIDGE_PROVIDERS.includes(pv)) ep = bridgeCandidates(pv)[0] || "";
        if (!ep && pv === "agent") ep = defaultAgentEndpoint() || "";
        endpointInput.value = ep;
        // agentEndpoint は「現プロバイダの送信先」として使われるため
        // ブリッジ系保存時のみ更新し、プロバイダ別の記憶にも残す
        if (PROVIDER_ENDPOINT_KEYS[pv]) {
          localStorage.setItem("agentEndpoint", ep);
          localStorage.setItem(PROVIDER_ENDPOINT_KEYS[pv], ep);
          endpointOwner = pv;
        }
      }
      if (tokenInput) localStorage.setItem("agentToken", tokenInput.value.trim());
      if (sendKeyInput) localStorage.setItem("agentSendKey", sendKeyInput.checked ? "1" : "0");
      if (devinApiKeyInput) {
        const dk = sanitizeHeaderToken(devinApiKeyInput.value);
        // HTTP ヘッダで送るため非Latin-1文字は不可（コピー混入の全角文字等を弾く）
        if (/[^\x00-\xff]/.test(dk)) {
          if (status) status.textContent = t("chat.devin.apiKeyInvalid");
          return;
        }
        devinApiKeyInput.value = dk;
        localStorage.setItem("devinApiKey", dk);
      }
      localStorage.setItem("agentEnabled", (pv === "copilot" || pv === "devin" || pv === "antigravity" || pv === "agent") ? "1" : "0");
      // 旧自動設定マーカーは廃止（エンドポイント欄が明示されるため不要）
      localStorage.removeItem("agentAutoConfig");
      if (BRIDGE_PROVIDERS.includes(pv)) void refreshBridgeStatus(pv);
      if (pv === "agent") void refreshAgentStatus();
      if (stepsInput) {
        localStorage.setItem("geminiToolMaxSteps", String(clampToolSteps(stepsInput.value)));
        stepsInput.value = String(getChatMaxToolSteps());
      }
      updateChatPanelVisibility();
      updateChatProviderLabel();
      if (status) status.textContent = t("common.saved");
    } catch (e) {
      if (status) status.textContent = t("common.saveError", { error: e.message });
    }
  });

  customInstructionsSaveButton?.addEventListener("click", () => {
    try {
      localStorage.setItem("chatCustomInstructions", customInstructionsInput?.value.trim() || "");
      if (customInstructionsStatus) customInstructionsStatus.textContent = t("common.saved");
    } catch (e) {
      if (customInstructionsStatus) customInstructionsStatus.textContent = t("common.saveError", { error: e.message });
    }
  });

  // 「CLI を自動インストール」ボタン — ハブの /setup を呼び、
  // 検出状況 → 確認 → install ジョブの完了までを進行表示する
  document.querySelectorAll(".bridge-setup-install").forEach(btn => {
    btn.addEventListener("click", async () => {
      const holder = btn.closest(".provider-only");
      const provider = holder?.dataset.for || "";
      const note = holder?.querySelector(".bridge-setup-note");
      if (!BRIDGE_PROVIDERS.includes(provider)) return;
      btn.disabled = true;
      if (note) note.textContent = "";
      try {
        const st = await bridgeSetupRun(provider, "status");
        if (!st.ok) {
          if (note) note.textContent = st.message || "";
          return;
        }
        if (st.status?.cli_found) {
          if (note) note.textContent = t("chat.bridge.cliDetected", { path: st.status.cli_path || "" });
          void refreshBridgeStatus(provider);
          return;
        }
        if (!st.status?.auto_install) {
          if (note) note.textContent = st.status?.note || "";
          return;
        }
        if (!window.confirm(t("chat.bridge.installConfirm", { provider }))) return;
        if (note) note.textContent = t("chat.bridge.installing");
        const r = await bridgeSetupRun(provider, "install");
        if (r.ok) {
          if (note) note.textContent = t("chat.bridge.installDone", { path: r.result?.cli_path || "" });
          void refreshBridgeStatus(provider);
        } else if (note) {
          note.textContent = t("chat.bridge.installFailed",
            { error: r.result?.error || r.message || r.status || "" });
        }
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ---- 汎用 UI ブリッジ ----
// アプリ内の操作要素（id 付き button/input/select/textarea/a と data-* タブ）を列挙・操作する。
// AI ツール(listUiControls/controlUi)・E2E 検証・プラグイン共通の基盤。
// 新規 UI は「id またはタブ用 data-* 属性 + click/change/input ハンドラ」で実装すれば
// 自動的に一覧へ載り AI 制御可能になる（AGENTS.md「AI 制御可能な UI」参照）
const UI_TAB_TARGET_ATTRS = ["data-panel", "data-settings-panel", "data-manage-pane", "data-manage-sub", "data-tab"];
// 動的生成コンテンツ領域（レイヤー行・検索結果等）は行番号が不安定なため列挙しない。
// それらは setLayerVisible / focusLayer / setLayerFilter のような名前解決付き API で操作する
const UI_BRIDGE_SKIP_SELECTOR = "#layer-list, #camera-presets, #agent-plugin-list, #mcp-server-list, #search-results, #vector-search-results, #chat-messages, #info-content, #attr-content, #vector-attr-widget-list, #vector-attr-widget-head, .cesium-viewer";

// 要素を一意に指す controlUi 用セレクタを作る。id → タブ属性 → id祖先+クラス(+nth-of-type) の順
function uiBridgeTarget(el) {
  if (el.id) return `#${el.id}`;
  for (const attr of UI_TAB_TARGET_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return `[${attr}="${value}"]`;
  }
  const anchor = el.closest("[id]");
  if (!anchor) return null;
  const cls = [...el.classList].find(c => /^[a-zA-Z][\w-]*$/.test(c));
  let selector = `#${anchor.id} ${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  if (el.ownerDocument.querySelectorAll(selector).length > 1) {
    const index = [...el.parentElement.children].filter(c => c.tagName === el.tagName).indexOf(el) + 1;
    selector = `#${anchor.id} ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
  }
  return selector;
}

function uiBridgeKind(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") return ["checkbox", "radio", "file", "range", "password"].includes(el.type) ? el.type : "input";
  if (tag === "button" && UI_TAB_TARGET_ATTRS.some(attr => el.hasAttribute(attr))) return "tab";
  return tag;
}

function uiBridgeLabel(el) {
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const direct = clean(el.getAttribute("aria-label")) || clean(el.title) || clean(el.placeholder) || clean(el.dataset?.i18n ? t(el.dataset.i18n) : "");
  if (direct) return direct;
  if (el.id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (forLabel && clean(forLabel.textContent)) return clean(forLabel.textContent);
  }
  const wrap = el.closest("label");
  if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
  return clean(el.textContent).slice(0, 80);
}

// listUiControls / controlUi(get) 共通の状態スナップショット。
// パスワード欄は値そのものを返さない（AIコンテキストにキーを持ち出さない）
function uiBridgeEntry(el, { brief = true } = {}) {
  const kind = uiBridgeKind(el);
  const entry = { target: uiBridgeTarget(el), kind, label: uiBridgeLabel(el) };
  if (el.disabled) entry.disabled = true;
  if (el.readOnly) entry.readonly = true;
  if (el.closest("[hidden]") !== null || el.offsetParent === null) entry.hidden = true;
  if (kind === "checkbox" || kind === "radio") {
    entry.checked = !!el.checked;
  } else if (kind === "select") {
    entry.value = el.value;
    entry.options = [...el.options].slice(0, 60).map(o => ({ value: o.value, label: (o.textContent || "").trim() }));
  } else if (kind === "password") {
    entry.hasValue = !!el.value;
  } else if (kind === "textarea") {
    entry.value = brief && el.value.length > 500 ? `${el.value.slice(0, 500)}…(${el.value.length}chars)` : el.value;
  } else if (kind === "input" || kind === "range") {
    entry.value = el.value;
  }
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (text && (entry.label !== text)) entry.text = brief ? text.slice(0, 120) : text.slice(0, 2000);
  return entry;
}

// controlUi の target 解決。裸の id・"#id"・属性/子孫セレクタを受け付ける。
// "#<iframeId>/<セレクタ>" 形式は同一オリジン iframe の文書内を探す
function resolveUiControlTarget(target) {
  const raw = String(target || "").trim();
  if (!raw) return null;
  const fm = /^#([\w-]+)\/(.+)$/.exec(raw);
  let scope = document, body = raw;
  if (fm) {
    try { scope = document.getElementById(fm[1])?.contentDocument; } catch (_) { scope = null; }
    if (!scope) return null;
    body = fm[2].trim();
  }
  const id = body.replace(/^#/, "");
  if (/^[\w-]+$/.test(id)) {
    const byId = scope.getElementById(id);
    if (byId) return byId;
  }
  try { return scope.querySelector(body); } catch (e) { return null; }
}

// ローカルコマンド: AI接続前でも操作APIの動作確認ができる
async function handleLocalChatCommand(text) {
  const [command, ...args] = text.trim().split(/\s+/);
  if (command === "/fly") {
    const [lat, lng, height] = args.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return t("command.flyUsage");
    void window.kasugaiApi?.flyTo?.({ latitude: lat, longitude: lng, height: Number.isFinite(height) ? height : undefined });
    return t("command.flyMoved", { lat, lng });
  }
  if (command === "/layers") {
    const items = window.kasugaiApi.listLayers();
    if (!items.length) return t("command.noLayers");
    return items.map(layer => `${layer.visible ? "●" : "○"} ${layer.title}`).join("\n");
  }
  if (command === "/layer") {
    const onoff = args[0];
    const name = args.slice(1).join(" ");
    if (!/^(on|off)$/i.test(onoff) || !name) return t("command.layerUsage");
    const on = /^on$/i.test(onoff);
    const ok = window.kasugaiApi.setLayerVisible(name, on);
    return ok ? t(on ? "command.layerShown" : "command.layerHidden", { name }) : t("command.layerNotFound", { name });
  }
  if (command === "/basemaps") {
    const items = window.kasugaiApi.listBasemaps();
    if (!items.length) return t("command.noBasemaps");
    return items.map(basemap => `${basemap.selected ? "●" : "○"} ${basemap.title}`).join("\n");
  }
  if (command === "/basemap") {
    const name = args.join(" ");
    if (!name) return t("command.basemapUsage");
    const ok = window.kasugaiApi.setBasemap(name);
    return ok ? t("command.basemapSet", { name }) : t("command.basemapNotFound", { name });
  }
  if (command === "/search") {
    const query = args.join(" ");
    if (!query) return t("command.searchUsage");
    const results = await window.kasugaiApi.searchLocation(query);
    if (!results.length) return t("search.noResults");
    const first = results[0];
    void flyToFeatureOrView(first.latitude, first.longitude);
    return t("command.searchResults", { list: results.map(item => `- ${item.title} (${item.address})`).join("\n") });
  }
  if (command === "/camera") {
    const camera = window.kasugaiApi.getCamera();
    if (!camera) return t("command.cameraFailed");
    return t("command.camera", {
      lat: camera.latitude.toFixed(5), lng: camera.longitude.toFixed(5), height: camera.height.toFixed(0),
      heading: camera.heading.toFixed(1), pitch: camera.pitch.toFixed(1)
    });
  }
  return null;
}

// AIが書き込むコードの適用前確認。コード全文を表示し、ユーザーが明示承認した場合のみ true。
// ストレージプラグインは読み込まれると kasugaiApi へフルアクセスできるため必須のガード
function confirmPluginApply({ id, name, code }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;";
    const panel = document.createElement("div");
    panel.style.cssText = "background:#fff;color:#1d2b35;max-width:720px;width:90%;max-height:80vh;display:flex;flex-direction:column;border-radius:8px;padding:16px;gap:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);";
    const title = document.createElement("strong");
    title.textContent = t("agent.approveTitle", { name: name || id });
    const note = document.createElement("p");
    note.style.cssText = "margin:0;font-size:0.85em;color:#52636d;";
    note.textContent = t("agent.approveNote");
    const pre = document.createElement("pre");
    pre.style.cssText = "flex:1;overflow:auto;background:#f4f7f8;border:1px solid #dbe4e8;border-radius:4px;padding:8px;font-size:0.78em;margin:0;white-space:pre-wrap;word-break:break-all;";
    pre.textContent = code;
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("agent.cancel");
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = t("agent.apply");
    apply.style.cssText = "background:#2f7d8c;color:#fff;border:0;border-radius:4px;padding:6px 14px;";
    const done = ok => { overlay.remove(); resolve(ok); };
    cancel.addEventListener("click", () => done(false));
    apply.addEventListener("click", () => done(true));
    overlay.addEventListener("click", event => { if (event.target === overlay) done(false); });
    buttons.append(cancel, apply);
    panel.append(title, note, pre, buttons);
    overlay.append(panel);
    document.body.append(overlay);
  });
}

// Markdown の最小レンダラ。XSS 防止のため先にHTMLエスケープしてから
// 見出し・箇条書き・太字・インラインコード・リンクのみ装飾する
export function renderMarkdownLite(markdown) {
  const inline = text => String(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      // javascript: 等のスキームを除外し http(s)・相対パスのみリンク化する
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !/^https?:/i.test(url)) return label;
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    });
  const out = [];
  let inList = false;
  for (const raw of escapeHtml(String(markdown ?? "")).split(/\r?\n/)) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (heading) {
      if (inList) { out.push("</ul>"); inList = false; }
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (raw.trim()) out.push(`<p>${inline(raw)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

// 資料モーダル（confirmPluginApply と同じオーバーレイ方式）。
// format=html は sandbox 属性のみの iframe で隔離して描画する
export function showReportModal({ title, format, content } = {}) {
  const isHtml = String(format || "").toLowerCase() === "html";
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;";
  const panel = document.createElement("div");
  panel.style.cssText = "background:#fff;color:#1d2b35;max-width:820px;width:92%;max-height:84vh;display:flex;flex-direction:column;border-radius:8px;padding:16px;gap:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);";
  const titleEl = document.createElement("strong");
  titleEl.textContent = title || t("report.title");
  const body = document.createElement("div");
  body.style.cssText = "flex:1;overflow:auto;border:1px solid #dbe4e8;border-radius:4px;padding:12px;font-size:0.9em;line-height:1.6;background:#fbfcfd;";
  if (isHtml) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.style.cssText = "width:100%;height:100%;min-height:50vh;border:0;background:#fff;";
    frame.srcdoc = String(content ?? "");
    body.append(frame);
  } else {
    body.innerHTML = renderMarkdownLite(content);
  }
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
  const download = document.createElement("button");
  download.type = "button";
  download.textContent = t("report.download");
  download.style.cssText = "background:#2f7d8c;color:#fff;border:0;border-radius:4px;padding:6px 14px;";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = t("report.close");
  const done = () => overlay.remove();
  close.addEventListener("click", done);
  overlay.addEventListener("click", event => { if (event.target === overlay) done(); });
  download.addEventListener("click", () => {
    const blob = new Blob([String(content ?? "")], { type: isHtml ? "text/html" : "text/markdown" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${String(title || "report").replace(/[\\/:*?"<>|]/g, "_")}.${isHtml ? "html" : "md"}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 10000);
  });
  buttons.append(download, close);
  panel.append(titleEl, body, buttons);
  overlay.append(panel);
  document.body.append(overlay);
}

// Gemini へ公開するツール定義。実行は window.kasugaiApi に委譲する
const CHAT_TOOLS = [{
  functionDeclarations: [
    {
      name: "flyTo",
      description: "地図カメラを指定座標へ移動する。height/pitch省略時はドローン視点(対象地上+200m・ピッチ-30°)になる",
      parameters: {
        type: "OBJECT",
        properties: {
          latitude: { type: "NUMBER", description: "緯度(度)" },
          longitude: { type: "NUMBER", description: "経度(度)" },
          height: { type: "NUMBER", description: "カメラ高さ(m)。省略時は対象地上+200m" },
          pitch: { type: "NUMBER", description: "ピッチ(度)。省略時は-30(ドローン視点)。-90で真上から俯瞰" },
          heading: { type: "NUMBER", description: "方位(度)" },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "setLayerVisible",
      description: "レイヤ名を指定して表示/非表示を切り替える",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "レイヤ名(listLayersで確認)" },
          visible: { type: "BOOLEAN", description: "trueで表示、falseで非表示" },
        },
        required: ["name", "visible"],
      },
    },
    {
      name: "setLayerLegendVisible",
      description: "レイヤーの凡例(条件別シンボル)単位で表示/非表示を切り替える。style=(QML)の分類・段階・ルールレンダラを持つレイヤーで有効。凡例ラベルは listLayers の legend で確認できる",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "レイヤ名(listLayersで確認)" },
          label: { type: "STRING", description: "凡例ラベルまたはシンボル名(listLayersのlegendで確認)" },
          visible: { type: "BOOLEAN", description: "trueで表示、falseで非表示" },
        },
        required: ["name", "label", "visible"],
      },
    },
    {
      name: "listLayers",
      description: "登録されているレイヤ一覧(名前・表示状態)を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "focusLayer",
      description: "レイヤ名またはIDを指定し、レイヤ全体が画面に収まるようカメラを移動する。非表示レイヤーは自動で表示してから移動する",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "レイヤ名またはID(listLayersで確認)" },
        },
        required: ["name"],
      },
    },
    {
      name: "getCamera",
      description: "現在のカメラ位置(緯度・経度・高さ・方位・ピッチ)を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "listBasemaps",
      description: "選択可能なベースマップ(背景地図)の一覧と現在の選択を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "setBasemap",
      description: "ベースマップ(背景地図)を名前またはIDで切り替える。特殊値: \"none\"=ベースマップなし(地表は通常描画・背景地図タイルのみ非表示)、\"transparent\"=ベースマップ透明(地表・大気・背景を透明にしてドレープ画像だけ残す)",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "ベースマップ名またはID(listBasemapsで確認)。none=ベースマップなし / transparent=ベースマップ透明 も指定可" },
        },
        required: ["name"],
      },
    },
    {
      name: "searchLocation",
      description: "住所・地名・施設名を検索し、候補(名称・住所・緯度経度)を返す。検索後はflyToまたはflyToFeatureで移動できる",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "検索語(例: 春日井市役所)" },
          provider: { type: "STRING", description: "検索プロバイダ(省略時は検索タブの選択): gsi/google/places/osm/yahoo (google=Geocoding+Placesハイブリッド、places=Placesのみ、osm=OpenStreetMap Nominatim。osmは2Dエンジンのみ)" },
        },
        required: ["query"],
      },
    },
    {
      name: "flyToFeature",
      description: "指定座標が画面中央に来るようにカメラを後退補正して移動する。地点・地物を見せたい場合はこちら。height/pitch省略時はドローン視点(対象地上+200m・ピッチ-30°)になる",
      parameters: {
        type: "OBJECT",
        properties: {
          latitude: { type: "NUMBER", description: "緯度(度)" },
          longitude: { type: "NUMBER", description: "経度(度)" },
          height: { type: "NUMBER", description: "カメラ高さ(m)。省略時は対象地上+200m" },
          pitch: { type: "NUMBER", description: "ピッチ(度)。省略時は-30(ドローン視点)" },
          heading: { type: "NUMBER", description: "方位(度)" },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "flyToPreset",
      description: "登録済みのカメラプリセット名を指定して移動する。listCameraPresetsで一覧を確認できる",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "プリセット名" },
        },
        required: ["name"],
      },
    },
    {
      name: "listCameraPresets",
      description: "登録済みカメラプリセット名の一覧を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "setTerrain",
      description: "地形(DEM)表示のON/OFF",
      parameters: {
        type: "OBJECT",
        properties: {
          enabled: { type: "BOOLEAN" },
        },
        required: ["enabled"],
      },
    },
    {
      name: "setEffect",
      description: "表示効果のON/OFF。nameは lighting(地形照明) translucency(地下透過) fog(霧) atmosphere(大気) shadows(影) depthTest(地形深度テスト) のいずれか",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          enabled: { type: "BOOLEAN" },
        },
        required: ["name", "enabled"],
      },
    },
    {
      name: "setUnderground",
      description: "地下表示の設定。transparencyは地表の透過率0〜1、diveは地下への移動許可",
      parameters: {
        type: "OBJECT",
        properties: {
          transparency: { type: "NUMBER", description: "0〜1" },
          dive: { type: "BOOLEAN" },
        },
      },
    },
    {
      name: "setClip",
      description: "カメラ中心に断面クリップを作成・解除する。typeは ns ew h clear のいずれか",
      parameters: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", description: "ns / ew / h / clear" },
        },
        required: ["type"],
      },
    },
    {
      name: "listFlyPaths",
      description: "登録済みフライパス(巡視ルート)の一覧を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "playFlyPath",
      description: "フライパス(巡視ルート)を名前または番号で再生し、Flyモードで自動走行する",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "フライパス名(listFlyPathsで確認)" },
        },
        required: ["name"],
      },
    },
    {
      name: "stopFly",
      description: "Flyモード・フライパス再生を停止してOrbit(3D)モードに戻る",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "setFlySettings",
      description: "フライパスの速度・高度・ピッチ等を変更する。name省略時は再生中（なければ選択中）のルートが対象。「もっと速く/ゆっくり」「高度を上げて」等に使う",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "フライパス名(省略時は再生中/選択中のルート)" },
          speed: { type: "NUMBER", description: "走行速度(km/h)" },
          agl: { type: "NUMBER", description: "地上高の目標値(m)。地形に追従したままルート全体の地上高を変える。「地上50mで飛んで」等はこちら" },
          height: { type: "NUMBER", description: "カメラの高さオフセット(m・ルート高度からの相対値。絶対的な地上高を変えたい場合はaglを使う)" },
          pitch: { type: "NUMBER", description: "カメラピッチ(度・-85〜0)" },
          loop: { type: "BOOLEAN", description: "ループ再生" },
          view: { type: "STRING", description: "視点: camera(一人称)/center(ルート中心俯瞰)" },
        },
      },
    },
    {
      name: "addFlyPath",
      description: "GeoJSONのLineStringから飛行ルート(フライパス)を作成する。描画ルートとして保存され、listFlyPathsで確認・playFlyPathで再生できる。「○○を巡るルートを作って」「このルートで飛んで」等に使う",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "ルート名" },
          geojson: { type: "OBJECT", description: "LineStringまたはMultiLineStringを含むGeoJSON(FeatureCollection/Feature/ジオメトリいずれも可)。座標は[経度,緯度,高度(省略可)]" },
          speed: { type: "NUMBER", description: "走行速度(km/h・省略時はルート総距離から自動設定: 80〜2000)" },
          height: { type: "NUMBER", description: "カメラの高さオフセット(m・省略時0)" },
          pitch: { type: "NUMBER", description: "カメラピッチ(度・省略時-10)" },
          loop: { type: "BOOLEAN", description: "ループ再生(省略時false)" },
          view: { type: "STRING", description: "視点: camera(一人称・既定)/center(ルート中心俯瞰)" },
        },
        required: ["name", "geojson"],
      },
    },
    {
      name: "flyRoute",
      description: "地点A→B(C経由等)の飛行ルートを自動生成してFlyモードで再生する。waypointsに座標・地名(query)・読込済み地物名(feature)を混在指定でき、地名は自動でジオコーディングされる。経由地間は直線補間し、地形標高をサンプリングして山岳部でも埋まらない高度を各点に付与する(2Dエンジンでは標高サンプリングなしのカメラ巡回のみ)。「AからBまで飛んで」「Cを経由して」等に使う。addFlyPath+playFlyPathの高レベル版",
      parameters: {
        type: "OBJECT",
        properties: {
          waypoints: {
            type: "ARRAY",
            description: "経由地の配列(2件以上・順に飛行)。各要素は {latitude,longitude,height?} ・ {query:\"地名・住所\"} ・ {feature:\"読込済み地物の属性値\"} のいずれか。heightはその地点の地上高(m)",
            items: {
              type: "OBJECT",
              properties: {
                latitude: { type: "NUMBER" },
                longitude: { type: "NUMBER" },
                height: { type: "NUMBER", description: "その地点の地上高(m)" },
                query: { type: "STRING", description: "地名・住所・施設名(ジオコーディング)" },
                feature: { type: "STRING", description: "読込済みベクトル地物の属性値(vectorSearch)" },
                name: { type: "STRING", description: "地点名(座標指定時のラベル、またはqueryの代替)" },
              },
            },
          },
          name: { type: "STRING", description: "ルート名(省略時は「起点→終点」)" },
          agl: { type: "NUMBER", description: "各地点の既定地上高(m・省略時は総距離から自動: 短距離50m〜長距離10000m)" },
          spacing: { type: "NUMBER", description: "ルート補間間隔(m・省略時200)" },
          speed: { type: "NUMBER", description: "走行速度(km/h・省略時は総距離から自動: 短距離80〜長距離2000・戦闘機並み)" },
          height: { type: "NUMBER", description: "カメラ高さオフセット(m・省略時0)" },
          pitch: { type: "NUMBER", description: "カメラピッチ(度・省略時-10)" },
          loop: { type: "BOOLEAN", description: "ループ再生(省略時false)" },
          view: { type: "STRING", description: "視点: camera(一人称・既定)/center(ルート中心俯瞰)" },
          autoplay: { type: "BOOLEAN", description: "生成後すぐ再生(省略時true)" },
          provider: { type: "STRING", description: "地名解決プロバイダ(gsi/google/places/yahoo・省略時は検索タブの選択)" },
        },
        required: ["waypoints"],
      },
    },
    {
      name: "vectorSearch",
      description: "読み込み済みベクトルデータ(GeoJSON等)の属性を検索し、該当する属性名・値・位置を返す。結果の緯度経度へはflyToFeatureで移動できる",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "検索語(属性名や値の一部)" },
        },
        required: ["query"],
      },
    },
    {
      name: "getShareUrl",
      description: "現在のカメラ位置・プロジェクトを含む共有URLを取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "buildShareUrl",
      description: "指定した座標・視点の共有URLを組み立てる。省略した引数は現在視点を使う。資料の各節に視点別パーマリンクを埋め込むときに使う",
      parameters: {
        type: "OBJECT",
        properties: {
          latitude: { type: "NUMBER", description: "緯度(度)" },
          longitude: { type: "NUMBER", description: "経度(度)" },
          height: { type: "NUMBER", description: "カメラ高さ(m)" },
          pitch: { type: "NUMBER", description: "ピッチ(度)" },
          heading: { type: "NUMBER", description: "方位(度)" },
          project: { type: "STRING", description: "プロジェクトID(省略時は現在のプロジェクト)" },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "showReport",
      description: "生成した資料(Markdown/HTML)をモーダル表示しダウンロード可能にする。「資料を作って」等の指示に対し、平面・内容・解決案の構成で content に本文を入れる",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "資料タイトル" },
          format: { type: "STRING", description: "markdown または html(省略時markdown)" },
          content: { type: "STRING", description: "資料本文。各節に視点パーマリンクを含める" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "listProjects",
      description: "切替可能なプロジェクト一覧を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "switchProject",
      description: "プロジェクトを切り替える。レイヤ・カメラプリセット等の設定全体が入れ替わるので、ユーザーが明示した場合のみ使う",
      parameters: {
        type: "OBJECT",
        properties: {
          projectId: { type: "STRING", description: "プロジェクトID(listProjectsで確認)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "toggleDrawMode",
      description: "Drawモード(地図上へのルート描画)をON/OFFする",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "applyInspector",
      description: "インスペクターの設定テキスト(.kasc形式)を登録・適用する。plugin: <id> | key=value 行でカタログ/ストレージのプラグインをそのプロジェクト限定で起動できる(id は listPlugins の catalog で確認)。データレイヤー行のhttp(s) URLは適用前に実在確認され、到達不能なものがあると拒否される。設定全体が上書きされるので、ユーザーが明示した場合のみ使う",
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: ".kasc形式の設定テキスト" },
        },
        required: ["text"],
      },
    },
    {
      name: "exportInspector",
      description: "現在の設定を.kascファイルとしてエクスポート(ダウンロード)する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "checkUpdate",
      description: "アプリの最新バージョンを確認する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "installUpdate",
      description: "最新版をインストールする(更新がある場合のみ有効)",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "bridgeSetup",
      description: "ブリッジハブ(127.0.0.1)経由でブリッジ系プロバイダ用CLIの導入状況確認・自動インストールを行う。action=status(既定)は対象プロバイダのCLI検出状況と自動化可否を返し、action=installは公式手順でCLIを自動導入する(copilot/devinのみ・antigravityは案内のみ)。installはPCにソフトウェアをインストールするため、ユーザーが明示的に導入を求めた場合のみ使う(実行前に確認ダイアログが出る)",
      parameters: {
        type: "OBJECT",
        properties: {
          provider: { type: "STRING", description: "copilot / devin / antigravity" },
          action: { type: "STRING", description: "status(既定) / install" },
        },
        required: ["provider"],
      },
    },
    {
      name: "runCode",
      description: "ブラウザ内サンドボックスでJavaScriptを実行し、戻り値とconsole出力を返す。データ加工・集計・座標計算などに使う。api.flyTo(...)等の地図操作APIが非同期で呼べる(api.<関数名>はkasugaiApiと同じ)。例: const layers = await api.listLayers(); return layers.length; ※DOM・localStorage・外部fetchは不可",
      parameters: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING", description: "実行するJavaScript。returnで値を返す。await使用可" },
        },
        required: ["code"],
      },
    },
    {
      name: "addLayer",
      description: "ベクターレイヤを追加して即座に適用する。type: geojson(既定)/layer/geoparquet/flatgeobuf/gpkg/duckdb/sql。target は duckdb 以外はURLまたは DATA/相対パス、sql は SELECT 文。duckdb には options で where=/limit=/format=/bbox=auto 等を指定可。http(s) URL は実行前に実在確認され、到達不能なものは拒否されるため確実に存在するURLのみ指定する。追加はインスペクター設定に反映されるのでユーザーが明示した場合のみ使う",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "レイヤ名" },
          target: { type: "STRING", description: "データのURLまたは DATA/ファイル名(sql: の場合は SELECT 文)" },
          type: { type: "STRING", description: "geojson/layer/geoparquet/flatgeobuf/gpkg/duckdb/sql (省略時 geojson)" },
          options: { type: "STRING", description: "省略可。duckdb: の where=/limit=/format=/bbox=auto/proxy=on、render=primitive、attr=出典 等(|区切り)" },
        },
        required: ["title", "target"],
      },
    },
    {
      name: "addGeoJsonLayer",
      description: "GeoJSONレイヤをURL指定で追加して即座に適用する(urlはDATA/相対パスまたは外部URL)。他形式は addLayer を使う。http(s) URL は実行前に実在確認され、到達不能なものは拒否されるため確実に存在するURLのみ指定する。追加はインスペクター設定に反映されるのでユーザーが明示した場合のみ使う",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "レイヤ名" },
          url: { type: "STRING", description: "GeoJSONのURLまたは DATA/ファイル名" },
        },
        required: ["title", "url"],
      },
    },
    {
      name: "shutdownApp",
      description: "アプリを停止する。確認ダイアログが出るのでユーザーが最終判断する。破壊的操作のためユーザーが明示した場合のみ使う",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "savePlugin",
      description: "KASUGAI Canvas の拡張機能(プラグイン)をブラウザ内ストレージに保存・有効化する自己拡張ツール。code は export async function init(api, manifest){} 形式のESモジュール。api は kasugaiApi で getCesium/getViewer/registerPluginLayer/getPluginDataSource/setPluginLayerData/addDataLayer/addLayer/listLayers/flyTo/on(イベント) 等が使える。保存前にユーザーへコード確認ダイアログが出る。既存idは上書き更新になり再読み込みされる",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "プラグインID(半角英数・ハイフン・アンダースコア)" },
          name: { type: "STRING", description: "表示名" },
          code: { type: "STRING", description: "プラグインのESモジュールコード全文" },
          layer: { type: "OBJECT", description: "省略可。{title,group,format:\"entities\"|\"geojson\",visible,scope:\"app\"|\"project\",style:\"QGISスタイル(.qml)のURL(任意・geojson形式のみ)\"}。指定するとプラグイン専用レイヤーが自動登録され setPluginLayerData/getPluginDataSource で使える" },
          enable: { type: "BOOLEAN", description: "省略時true。falseで保存のみ(読み込まない)" },
        },
        required: ["id", "code"],
      },
    },
    {
      name: "listPlugins",
      description: "起動中・保存済みプラグインの一覧(id/name/source/enabled/lastError)と、.kasc の plugin: 行で指定できる同梱プラグインカタログ(catalog: id/name/version/auto)を取得する",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "getPluginCode",
      description: "保存済みプラグインのコードと設定を取得する。修正して savePlugin で再保存する修正ループに使う",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "プラグインID(listPluginsで確認)" },
        },
        required: ["id"],
      },
    },
    {
      name: "removePlugin",
      description: "保存済みプラグインを削除する。確認ダイアログが出るのでユーザーが最終判断する",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "プラグインID(listPluginsで確認)" },
        },
        required: ["id"],
      },
    },
    {
      name: "setPluginEnabled",
      description: "保存済みプラグインの有効/無効を切り替える",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "プラグインID(listPluginsで確認)" },
          enabled: { type: "BOOLEAN" },
        },
        required: ["id", "enabled"],
      },
    },
    {
      name: "publishPlugin",
      description: "保存済みプラグインを配布用 PLUGIN/ に書き込み全利用者に公開する(ローカルサーバー版のみ・取り消しは開発者作業)。確認ダイアログが出るのでユーザーが最終判断する",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "プラグインID(listPluginsで確認)" },
        },
        required: ["id"],
      },
    },
    {
      name: "fetchData",
      description: "外部URLからテキスト/JSON/CSV等のデータを取得する(CORS許可サイトのみ・約400KBで打切り)。取得データは runCode で加工し addDataLayer で表示できる",
      parameters: {
        type: "OBJECT",
        properties: {
          url: { type: "STRING", description: "取得するURL(http/https)" },
        },
        required: ["url"],
      },
    },
    {
      name: "getLayerGeoJson",
      description: "読み込み済みレイヤーの地物をGeoJSONで取得する。属性検索より前にデータ全体が必要な時・変換加工の入力に使う",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "レイヤ名またはID(listLayersで確認)" },
        },
        required: ["name"],
      },
    },
    {
      name: "addDataLayer",
      description: "GeoJSONオブジェクトを新規レイヤーとして直接表示する(URL不要の一時レイヤー・.kascには含まれない)。Point/LineString/Polygon/Multi* いずれのジオメトリも描画できる。座標は必ず[経度,緯度]の順(緯度経度ではない)。featureのpropertiesに simplestyle 属性(marker-color/marker-size/stroke/fill/fill-opacity/description等)を入れると色分け・ポップアップを制御できる",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "レイヤ名" },
          geojson: { type: "OBJECT", description: "GeoJSONオブジェクト(FeatureCollection推奨・単体Featureやジオメトリも可)" },
        },
        required: ["title", "geojson"],
      },
    },
    {
      name: "removeDataLayer",
      description: "addDataLayerで追加した一時レイヤーを削除する",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "レイヤ名またはID" },
        },
        required: ["name"],
      },
    },
    {
      name: "searchPlaces",
      description: "Google Places API(テキスト検索)で施設・店舗・観光地等を検索する。Maps APIキー設定時のみ利用可。検索後はflyToまたはflyToFeatureで移動できる",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "検索語(例: 春日井市 カフェ)" },
        },
        required: ["query"],
      },
    },
    {
      name: "openStreetView",
      description: "指定座標の Google ストリートビューを別タブで開く。Maps APIキー設定時のみ利用可",
      parameters: {
        type: "OBJECT",
        properties: {
          latitude: { type: "NUMBER", description: "緯度(度)" },
          longitude: { type: "NUMBER", description: "経度(度)" },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "listDataFiles",
      description: "プロジェクトの DATA/ フォルダ内ファイル一覧(名前・サイズ・更新時刻)を取得する。ローカルサーバー版のみ利用可",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "saveDataFile",
      description: "テキスト内容をプロジェクトの DATA/ フォルダへ保存する(.geojson等・サブフォルダ可)。既存ファイルの上書き時はユーザー確認が出る。ローカルサーバー版のみ利用可",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "DATA/ 以下のファイル名(例: route.geojson, sub/out.txt)" },
          content: { type: "STRING", description: "保存するテキスト内容" },
        },
        required: ["name", "content"],
      },
    },
    {
      name: "deleteDataFile",
      description: "DATA/ フォルダ内のファイルを削除する。実行前にユーザー確認が出る。ローカルサーバー版のみ利用可",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "DATA/ 以下のファイル名" },
        },
        required: ["name"],
      },
    },
    {
      name: "setToolMaxSteps",
      description: "ツール実行の上限往復数を変更する。1回の指示でエージェントが繰り返せるツール実行の回数(1-20)。ユーザーが上限の引き上げ・引き下げを求めたときに使う",
      parameters: {
        type: "OBJECT",
        properties: {
          steps: { type: "NUMBER", description: "新しい上限往復数(1-20)" },
        },
        required: ["steps"],
      },
    },
    {
      name: "setLayerFilter",
      description: "クエリ系レイヤー(duckdb/sql/gpkg等)の絞り込み条件を変更する。レイヤー行の⏷ボタンと同じ操作。sql型はクエリ全文、それ以外はWHERE式をfilterに指定(空文字で解除・sql型は空文字不可)。現在の条件はlistLayersのfilter欄で確認できる",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "レイヤ名またはID(listLayersで確認)" },
          filter: { type: "STRING", description: "WHERE式またはSQLクエリ全文" },
        },
        required: ["name", "filter"],
      },
    },
    {
      name: "listUiControls",
      description: "アプリ内の操作可能なUI要素(ボタン・入力欄・セレクト・タブ等)の一覧を取得する。各項目の target を controlUi に渡すと操作できる。filterで対象名・ラベルの部分一致に絞れる。レイヤー行・検索結果など動的生成の行は含まれない(専用ツールで操作)。data-ui-bridge属性を持つ同一オリジンiframe内の要素は `#<iframeId>/` 接頭辞付きのtargetで列挙・操作できる",
      parameters: {
        type: "OBJECT",
        properties: {
          filter: { type: "STRING", description: "target/ラベルの部分一致フィルタ(省略可)" },
        },
      },
    },
    {
      name: "controlUi",
      description: "UI要素を直接操作する汎用ツール(専用ツールが無い設定項目・パネル切替・ボタン押下用)。targetはlistUiControlsのtarget(要素id・[data-*=...]・CSSセレクタ・`#<iframeId>/<セレクタ>`形式のiframe内要素)。action: click=ボタン/タブ/リンクの押下とチェックボックスのトグル、set=値設定(checkboxはboolean、selectはoption値・入力欄は文字列/数値)、get=現在値・表示テキストの取得。action省略時はvalue指定ならset、ボタン系ならclick、それ以外はget。ファイル選択・フォルダ選択のピッカー自体は開けるが中身の選択はユーザー操作になる",
      parameters: {
        type: "OBJECT",
        properties: {
          target: { type: "STRING", description: "listUiControlsのtarget値" },
          action: { type: "STRING", description: "click / set / get(省略時は自動判定)" },
          value: { type: "STRING", description: "set時の値(checkboxはtrue/false・selectはoptionのvalue・入力欄は文字列)" },
        },
        required: ["target"],
      },
    },
    {
      name: "listGsiLayers",
      description: "GSI Mapsエンジン(engine=gsimaps)専用。iframe内の地理院地図で現在表示中のレイヤ一覧(id・タイトル・タイルURL・透過率・取込可否)を取得する。importGsiLayers でCanvasレイヤーへ取り込める",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "importGsiLayers",
      description: "GSI Mapsエンジン(engine=gsimaps)専用。地理院地図の表示中レイヤーをCanvasレイヤー(xyz行)として取り込み、インスペクタ(.kasc)へ追記して永続化する。ids省略時は取込可能な全レイヤー。cocotile(geojsonタイル)・KML・時系列表示レイヤは未対応で unsupported として返る",
      parameters: {
        type: "OBJECT",
        properties: {
          ids: { type: "ARRAY", items: { type: "STRING" }, description: "取り込むレイヤのidまたはタイトル(listGsiLayersで確認)。省略時は取込可能な全レイヤー" },
        },
      },
    },
    {
      name: "setGsiLayerOpacity",
      description: "GSI Mapsエンジン専用。地理院地図の表示中レイヤーの透過率を変更する(表示中レイヤーパネルの透過率スライダと同じ操作。ベースマップにも使える)",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "レイヤidまたはタイトル(listGsiLayersで確認)" },
          opacity: { type: "NUMBER", description: "不透明度 0〜1(0=透明,1=不透明)" },
        },
        required: ["id", "opacity"],
      },
    },
    {
      name: "moveGsiLayer",
      description: "GSI Mapsエンジン専用。地理院地図の表示中レイヤーの積み順を変える(top/front=最前面・bottom/back=最背面・up/down=1段移動・数値=位置index)",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "レイヤidまたはタイトル" },
          position: { type: "STRING", description: "top / bottom / up / down / 数値index" },
        },
        required: ["id", "position"],
      },
    },
    {
      name: "removeGsiLayer",
      description: "GSI Mapsエンジン専用。地理院地図の表示中レイヤーを解除する(レイヤツリーでチェックを外すのと同じ。ベースマップは対象外)",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "レイヤidまたはタイトル" },
        },
        required: ["id"],
      },
    },
    {
      name: "listGsiCatalog",
      description: "GSI Mapsエンジン専用。地理院地図のレイヤカタログ(layers.txt全件+災害トピック等の遅延ロード群)を検索する。id・タイトル・URL・表示中か・取込可否に使う layerType・確認要否(needsConfirm)を返す。filter で部分一致絞り込み(親フォルダ名=災害名でも子レイヤにヒットする)",
      parameters: {
        type: "OBJECT",
        properties: {
          filter: { type: "STRING", description: "id/タイトルの部分一致フィルタ(省略可)" },
        },
      },
    },
    {
      name: "addGsiLayer",
      description: "GSI Mapsエンジン専用。地理院地図のレイヤカタログから id/タイトル指定で直接表示する(レイヤツリーでチェックを入れるのと同じ。idはlistGsiCatalogで確認)。hidden=trueで非表示のまま追加。要確認レイヤは confirmPending で返り地理院地図側の確認ダイアログ承認が必要。notFound時は candidates に類似レイヤの id/タイトルが返るので、その id で再試行する",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "カタログのレイヤidまたはタイトル" },
          hidden: { type: "BOOLEAN", description: "trueで非表示のまま追加(省略時false)" },
        },
        required: ["id"],
      },
    },
    {
      name: "listGsiSakuzu",
      description: "GSI Mapsエンジン専用。地理院地図の作図(sakuzu)リストを取得する。ユーザーがGSI側で描いた点線面・テキストを importGsiSakuzu でCanvasレイヤーへ取り込める。ours=true はCanvas管理レイヤ由来で取込対象外",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "importGsiSakuzu",
      description: "GSI Mapsエンジン専用。地理院地図の作図をGeoJSONとしてCanvasレイヤーへ取り込む(元の作図は二重描画防止で非表示化)。ローカルサーバー版では DATA/ へ保存し geojson: 行で .kasc 永続化、静的配信環境では一時レイヤーになる。indices省略時は全作図",
      parameters: {
        type: "OBJECT",
        properties: {
          indices: { type: "ARRAY", items: { type: "STRING" }, description: "取り込む作図のindexまたはタイトル(listGsiSakuzuで確認)。省略時は全作図" },
        },
      },
    },
    {
      name: "listGsiBasemaps",
      description: "GSI Mapsエンジン専用。地理院地図のベースマップ(地図の種類: 標準地図/淡色地図/白地図/写真/English等)の一覧を取得する。active=GSI側で表示中・selected=Canvasのベースマップ選択中・imported=.kascのbase:行あり",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "setGsiBasemap",
      description: "GSI Mapsエンジン専用。地理院地図のベースマップを id/タイトルで切替える(listGsiBasemapsで確認)。対応する base: 行が .kasc に無ければ自動で追記され、他エンジンでも同じベースマップが再現される",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "ベースマップのidまたはタイトル" },
        },
        required: ["id"],
      },
    },
    {
      name: "importGsiCatalog",
      description: "GSI Mapsエンジン専用。地理院地図のレイヤカタログから id/タイトル指定で .kasc の xyz: 行として直接取り込む(GSI側に表示していなくても可。idはlistGsiCatalogで確認)。表示中レイヤの取り込みは importGsiLayers、ベースマップは setGsiBasemap を使う",
      parameters: {
        type: "OBJECT",
        properties: {
          ids: { type: "ARRAY", items: { type: "STRING" }, description: "取り込むカタログレイヤのidまたはタイトルの配列" },
        },
        required: ["ids"],
      },
    },
    {
      name: "setGsiLayerHidden",
      description: "GSI Mapsエンジン専用。表示中レイヤーを解除せず一時的に非表示/再表示する(表示中レイヤーパネルの非表示チェックと同じ操作。ベースマップは対象外)",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "レイヤidまたはタイトル(listGsiLayersで確認)" },
          hidden: { type: "BOOLEAN", description: "true=非表示 / false=再表示" },
        },
        required: ["id", "hidden"],
      },
    },
    {
      name: "removeGsiSakuzu",
      description: "GSI Mapsエンジン専用。地理院地図の作図(sakuzu)を削除する。indicesはindexまたはタイトル(listGsiSakuzuで確認)、省略時は全作図。Canvas管理レイヤ由来の作図(ours=true)は対象外",
      parameters: {
        type: "OBJECT",
        properties: {
          indices: { type: "ARRAY", items: { type: "STRING" }, description: "削除する作図のindexまたはタイトル。省略時は全作図" },
        },
      },
    },
    {
      name: "getGsiElevation",
      description: "GSI Mapsエンジン専用。地理院地図の標高APIで指定地点の標高(m)を取得する。sourceはメッシュ種別(例: 5mメッシュ（レーザ）)",
      parameters: {
        type: "OBJECT",
        properties: {
          latitude: { type: "NUMBER", description: "緯度(度数)" },
          longitude: { type: "NUMBER", description: "経度(度数)" },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "getGsiShareUrl",
      description: "GSI Mapsエンジン専用。現在の視点・ベースマップ・表示中レイヤを maps.gsi.go.jp の共有URLとして返す。実サイトで同じ状態が開ける",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "setGsiGlobe",
      description: "GSI Mapsエンジン専用。地理院地図の Globe(3D)表示へ進入/復帰する。on=trueで現在の視点・ベース・表示中レイヤを引き継いでGlobeへ、falseで2D地図へ戻る(Globeの現在視点を引き継ぐ)",
      parameters: {
        type: "OBJECT",
        properties: {
          on: { type: "BOOLEAN", description: "true=Globeへ進入 / false=2D地図へ復帰" },
        },
        required: ["on"],
      },
    },
  ],
}];

// AI に自オリジンを教える — 位置リンクの案内でデプロイ先と異なるドメインを推測させないため
const chatSystemInstruction = () => {
  let custom = getBackendCapabilities()?.ai?.instructions || "";
  if (!custom) {
    try { custom = localStorage.getItem("chatCustomInstructions") || ""; } catch (e) {}
  }
  const engineNote = `\n\nCurrent map engine: "${aiEngine}"${aiEngine === "cesium"
    ? " (CesiumJS・3D 全機能)"
    : aiEngine === "gsimaps"
      ? " (KASUGAI Canvas .kasc プレイヤー(地理院地図)。地形起伏・断面クリップ・描画モード等の一部3Dツールは利用不可。setGsiGlobe で Globe(Cesium) へ切替可能。flyPath 系はカメラ巡回のみで地形追従しない)"
      : " (KASUGAI Canvas .kasc 2D プレイヤー。3D地形・断面クリップ・描画モード系ツールはこのエンジンでは利用不可。flyPath 系はカメラ巡回のみで地形追従しない)"}`;
  return `${t("chat.systemInstruction")} ${t("chat.systemInstructionAppUrl", { url: `${window.location.origin}${window.location.pathname}` })}${engineNote}${custom.trim() ? `\n\nUser's additional instructions:\n${custom.trim()}` : ""}`;
};

// バックエンドの能力に応じて公開するツールを絞る（公開環境に高権限ツールを見せない）
// Mapsキー必須のツール・ローカルサーバー版のファイル書込みツールも同様に条件付き
function activeChatTools() {
  const hasMapsKey = !!window.kasugaiApi?.getGoogleMapsWsApiKey?.();
  const declarations = CHAT_TOOLS[0].functionDeclarations
    .filter(d => d.name !== "publishPlugin" || hasBackendFeature("pluginWrite"))
    .filter(d => !["searchPlaces", "openStreetView"].includes(d.name) || hasMapsKey)
    .filter(d => !["listDataFiles", "saveDataFile", "deleteDataFile"].includes(d.name) || hasBackendFeature("fileWrite"))
    // 更新・停止はローカルサーバー版のみ（静的配信では非公開）
    .filter(d => !["checkUpdate", "installUpdate"].includes(d.name) || hasBackendFeature("update"))
    .filter(d => d.name !== "shutdownApp" || hasBackendFeature("shutdown"))
    // ブリッジCLI導入ツールはハブが検出できる環境のみ（内蔵AIからも使える導線）
    .filter(d => d.name !== "bridgeSetup" || bridgeSetupHubMaybe())
    .filter(d => chatToolAvailable(d.name))
    // MCP サーバー（Box 等）のツールを末尾へ合成する
    .concat(mcpDeclarations());
  return [{ functionDeclarations: declarations }];
}

// ブラウザ内コード実行サンドボックス。
// sandbox属性(allow-scriptsのみ・opaque origin)のiframe内で実行するため、
// localStorage・DOM・APIキーにはアクセスできない。地図操作は postMessage 経由の api ブリッジのみ。
let chatSandboxFrame = null;
let chatSandboxReady = null;
const chatSandboxPending = new Map();

function getChatSandbox() {
  if (chatSandboxFrame) return chatSandboxReady;
  const srcdoc = `<!doctype html><script>
    const logs = [];
    ["log", "warn", "error"].forEach(kind => {
      console[kind] = (...items) => {
        logs.push(items.map(item => { try { return typeof item === "object" ? JSON.stringify(item) : String(item); } catch (e) { return String(item); } }).join(" "));
      };
    });
    window.api = new Proxy({}, {
      get: (target, name) => (...args) => new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2) + Date.now();
        const onMessage = event => {
          if (!event.data || event.data.id !== id) return;
          removeEventListener("message", onMessage);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.result);
        };
        addEventListener("message", onMessage);
        parent.postMessage({ id, call: name, args }, "*");
      }),
    });
    addEventListener("message", async event => {
      const data = event.data || {};
      if (!data.id || typeof data.code !== "string") return;
      logs.length = 0;
      try {
        const fn = new Function("api", "return (async () => { " + data.code + " })()");
        const result = await fn(window.api);
        parent.postMessage({ id: data.id, result: result === undefined ? null : result, logs: logs.slice(0, 50) }, "*");
      } catch (error) {
        parent.postMessage({ id: data.id, error: String(error && error.message || error), logs: logs.slice(0, 50) }, "*");
      }
    });
    parent.postMessage({ ready: true }, "*");
  <\/script>`;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = srcdoc;
  frame.style.display = "none";
  chatSandboxFrame = frame;
  chatSandboxReady = new Promise(resolve => {
    const onMessage = event => {
      if (event.source === frame.contentWindow && event.data?.ready) {
        removeEventListener("message", onMessage);
        resolve();
      }
    };
    addEventListener("message", onMessage);
  });
  document.body.append(frame);
  return chatSandboxReady;
}

// サンドボックスへ公開しないAPI（キー等の機密を外部送信されるのを防ぐ。
// プラグイン書き込み系は確認ダイアログを迂回できるためブロックする）
const CHAT_SANDBOX_BLOCKED_API = new Set(["getGoogleApiKey", "getGoogleMapsApiKey", "getGoogleMapsWsApiKey", "getGeminiModel", "applyInspector", "shutdownApp", "installUpdate", "saveStoragePlugin", "removeStoragePlugin", "setStoragePluginEnabled", "setStoragePluginError", "publishStoragePlugin", "saveDataFile", "deleteDataFile", "controlUi", "setLayerFilter"]);

// サンドボックスからの api.XXX 呼び出しを kasugaiApi に橋渡しする
window.addEventListener("message", async event => {
  if (!chatSandboxFrame || event.source !== chatSandboxFrame.contentWindow) return;
  const { id, call, args } = event.data || {};
  if (!id || typeof call !== "string") return;
  const fn = window.kasugaiApi?.[call];
  let out;
  try {
    if (CHAT_SANDBOX_BLOCKED_API.has(call)) throw new Error(t("error.sandboxBlocked", { call }));
    if (typeof fn !== "function") throw new Error(t("error.apiMissing", { call }));
    out = { result: await fn(...(Array.isArray(args) ? args : [])) };
  } catch (error) {
    out = { error: String(error && error.message || error) };
  }
  event.source.postMessage({ id, ...out }, "*");
});

// サンドボックス内でJSコードを実行し、戻り値とconsole出力を返す
export async function runSandboxedCode(code, timeoutMs = 15000) {
  await getChatSandbox();
  const id = Math.random().toString(36).slice(2) + Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chatSandboxPending.delete(id);
      reject(new Error(t("error.timeout")));
    }, timeoutMs);
    chatSandboxPending.set(id, { resolve, timer });
    const onMessage = event => {
      if (event.source !== chatSandboxFrame.contentWindow || event.data?.id !== id) return;
      removeEventListener("message", onMessage);
      chatSandboxPending.delete(id);
      clearTimeout(timer);
      const { result, error, logs } = event.data;
      if (error) reject(new Error(error));
      else resolve({ result, logs: logs || [] });
    };
    addEventListener("message", onMessage);
    chatSandboxFrame.contentWindow.postMessage({ id, code }, "*");
  });
}

// AIによる地図移動の既定視点: ドローン(対象地上+200m・ピッチ-30°)
async function applyDroneViewDefaults(args) {
  const merged = { ...args };
  if (!Number.isFinite(Number(merged.pitch))) merged.pitch = -30;
  if (!Number.isFinite(Number(merged.height))) {
    const lat = Number(merged.latitude);
    const lng = Number(merged.longitude);
    merged.height = ((await window.kasugaiApi?.sampleGroundHeight?.(lat, lng)) ?? 0) + 200;
  }
  return merged;
}

// AI が提示した URL 指定レイヤーの実在確認（架空・存在しない URL の登録を防ぐ）。
// http(s) 以外（DATA/ 相対パス・sql文等）と proxy=on 指定（直接取得しなくてよい）は検証しない
async function verifyToolTargetUrl(target, options = "") {
  const url = String(target || "");
  if (!/^https?:\/\//i.test(url)) return { ok: true };
  if (/proxy\s*=\s*(on|true|1)/i.test(String(options))) return { ok: true };
  try {
    // ローカル版は /api/fetch 経由で実在確認(CORSに左右されずレイヤー読み込みと同じ経路)
    if (hasBackendFeature("fetchProxy") && isFetchProxyTarget(url)) {
      const res = await fetch(`${backendUrl("/api/fetch")}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(15000) });
      return res.ok ? { ok: true } : { ok: false, status: res.status };
    }
    let res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    if (res.status === 405 || res.status === 501) res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15000) });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, status: String(e && e.message || e) };
  }
}

// applyInspector 用。.kasc テキスト中のデータレイヤー行(タイプ:タイトル|URL|オプション)で
// 新規追加される http(s) URL を一括実在確認する。タイル系({x}{y}{z}プレースホルダ)・
// route:/DATA/相対パス・proxy=on 指定は対象外。既存行に既に含まれる URL は再検証しない
// (CORS非対応でも現状動いているURL・一時的な障害で設定全体の適用を妨げないため)
const INSPECTOR_URL_LAYER_TYPES = new Set(["geojson", "geoparquet", "flatgeobuf", "gpkg", "geopackage", "duckdb", "layer", "fly_geojson"]);

async function findUnreachableInspectorUrls(text) {
  const currentText = document.querySelector("#inspector-input")?.value || "";
  const targets = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    if (!INSPECTOR_URL_LAYER_TYPES.has(line.slice(0, sep).toLowerCase())) continue;
    const parts = line.slice(sep + 1).split("|").map(part => part.trim());
    const target = parts[1] || "";
    if (!/^https?:\/\//i.test(target) || target.includes("{")) continue;
    if (parts.slice(2).some(part => /^proxy\s*=\s*(on|true|1)$/i.test(part))) continue;
    if (currentText.includes(target)) continue;
    targets.push(target);
  }
  const checks = await Promise.all([...new Set(targets)].map(async url => ({ url, ...(await verifyToolTargetUrl(url)) })));
  return checks.filter(check => !check.ok);
}

export async function executeChatTool(name, args = {}) {
  // MCP サーバー由来のツール（"<server>__<tool>" 名）は専用経路へ振り分ける。
  // 書き込み系は実行のたびに確認ダイアログを挟む（高権限操作の既定ポリシー）
  const mcpTarget = mcpToolTarget(name);
  if (mcpTarget) {
    if (mcpTarget.write && !window.confirm(t("mcp.writeConfirm", { server: mcpTarget.serverName, tool: mcpTarget.toolName }))) {
      return { ok: false, message: t("mcp.writeDenied") };
    }
    try {
      return await callMcpTool(mcpTarget.serverKey, mcpTarget.toolName, args);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  const requiredApi = CHAT_TOOL_API[name] ?? name;
  if (!requiredApi.startsWith("local:") && typeof window.kasugaiApi?.[requiredApi] !== "function") {
    return { ok: false, message: t("tool.unknown", { name }) };
  }
  if (name === "flyTo") {
    await window.kasugaiApi?.flyTo?.(await applyDroneViewDefaults(args));
    return { ok: true };
  }
  if (name === "flyToFeature") {
    const merged = await applyDroneViewDefaults(args);
    await flyToFeatureOrView(Number(merged.latitude), Number(merged.longitude), merged);
    return { ok: true };
  }
  if (name === "setLayerVisible") {
    const ok = window.kasugaiApi.setLayerVisible(args.name, args.visible);
    return { ok, message: ok ? undefined : t("tool.layerNotFound", { name: args.name }) };
  }
  if (name === "setLayerLegendVisible") {
    const ok = window.kasugaiApi.setLayerLegendVisible(args.name, args.label, args.visible);
    return { ok, message: ok ? undefined : t("tool.legendNotFound", { name: args.name }) };
  }
  if (name === "listLayers") return { layers: window.kasugaiApi.listLayers() };
  if (name === "focusLayer") {
    const ok = await window.kasugaiApi.focusLayer(args.name);
    return { ok, message: ok ? undefined : t("tool.layerNotFound", { name: args.name }) };
  }
  if (name === "getCamera") return { camera: window.kasugaiApi.getCamera() };
  if (name === "listBasemaps") return { basemaps: window.kasugaiApi.listBasemaps() };
  if (name === "setBasemap") {
    const ok = window.kasugaiApi.setBasemap(args.name);
    return { ok, message: ok ? undefined : t("tool.basemapNotFound", { name: args.name }) };
  }
  if (name === "searchLocation") {
    const results = await window.kasugaiApi.searchLocation(args.query, args.provider);
    return { results };
  }
  if (name === "searchPlaces") {
    try {
      return { results: await window.kasugaiApi.searchPlaces(args.query) };
    } catch (error) {
      return { ok: false, message: String(error && error.message || error) };
    }
  }
  if (name === "openStreetView") {
    try {
      return await window.kasugaiApi.openStreetView(args.latitude, args.longitude);
    } catch (error) {
      return { ok: false, message: String(error && error.message || error) };
    }
  }
  if (name === "listDataFiles") return { files: await window.kasugaiApi.listDataFiles() };
  if (name === "saveDataFile") {
    const fileName = String(args.name || "").trim();
    const existing = await window.kasugaiApi.listDataFiles();
    if (existing.some(f => f.name === fileName) && !window.confirm(t("datafile.confirmOverwrite", { name: fileName }))) {
      return { ok: false, message: t("agent.cancelled") };
    }
    return await window.kasugaiApi.saveDataFile(fileName, String(args.content ?? ""));
  }
  if (name === "deleteDataFile") {
    const fileName = String(args.name || "").trim();
    if (!window.confirm(t("datafile.confirmDelete", { name: fileName }))) return { ok: false, message: t("agent.cancelled") };
    return await window.kasugaiApi.deleteDataFile(fileName);
  }
  if (name === "listCameraPresets") return { presets: window.kasugaiApi.listCameraPresets() };
  if (name === "flyToPreset") {
    const ok = window.kasugaiApi.flyToPreset(args.name);
    return { ok, message: ok ? undefined : t("tool.presetNotFound", { name: args.name }) };
  }
  if (name === "setTerrain") return { ok: window.kasugaiApi.setTerrain(args.enabled) };
  if (name === "setEffect") {
    const ok = window.kasugaiApi.setEffect(args.name, args.enabled);
    return { ok, message: ok ? undefined : t("tool.unknownEffect", { name: args.name }) };
  }
  if (name === "setUnderground") return { ok: window.kasugaiApi.setUnderground(args) };
  if (name === "setClip") return { ok: window.kasugaiApi.setClip(args.type) };
  if (name === "listFlyPaths") return { flyPaths: window.kasugaiApi.listFlyPaths() };
  if (name === "playFlyPath") {
    const ok = window.kasugaiApi.playFlyPath(args.name);
    return { ok, message: ok ? undefined : t("tool.flyPathNotFound", { name: args.name }) };
  }
  if (name === "stopFly") return { ok: window.kasugaiApi.stopFly() };
  if (name === "setFlySettings") {
    const result = await window.kasugaiApi.setFlySettings(args.name, { speed: args.speed, agl: args.agl, height: args.height, pitch: args.pitch, loop: args.loop, view: args.view });
    return result?.ok ? result : { ok: false, message: t("tool.flyPathNotFound", { name: args.name || "(none)" }) };
  }
  if (name === "addFlyPath") {
    const result = await window.kasugaiApi.addFlyPath(args.name, args.geojson, { speed: args.speed, height: args.height, pitch: args.pitch, loop: args.loop, view: args.view });
    return result?.ok ? { ok: true, name: result.name } : { ok: false, message: t("tool.invalidGeoJson") };
  }
  if (name === "flyRoute") {
    const result = await window.kasugaiApi.flyRoute(args.waypoints, {
      name: args.name, agl: args.agl, spacing: args.spacing, speed: args.speed,
      height: args.height, pitch: args.pitch, loop: args.loop, view: args.view,
      autoplay: args.autoplay, provider: args.provider,
    });
    if (result?.ok) return result;
    if (result?.reason === "tooFewWaypoints") return { ok: false, message: t("tool.flyRouteTooFew") };
    if (result?.reason === "waypointFailed") return { ok: false, message: t("tool.flyRouteWaypointFailed", { index: result.index + 1, query: result.query }) };
    return { ok: false, message: t("tool.invalidGeoJson") };
  }
  if (name === "vectorSearch") return { results: window.kasugaiApi.vectorSearch(args.query) };
  if (name === "getShareUrl") return { url: window.kasugaiApi.getShareUrl() };
  if (name === "buildShareUrl") return { url: window.kasugaiApi.buildShareUrl(args) };
  if (name === "showReport") return window.kasugaiApi.showReport(args);
  if (name === "listProjects") return { projects: window.kasugaiApi.listProjects() };
  if (name === "switchProject") {
    const ok = window.kasugaiApi.switchProject(args.projectId);
    return { ok, message: ok ? undefined : t("tool.projectNotFound", { name: args.projectId }) };
  }
  if (name === "toggleDrawMode") return window.kasugaiApi.toggleDrawMode();
  if (name === "applyInspector") {
    const bad = await findUnreachableInspectorUrls(args.text);
    if (bad.length) {
      return { ok: false, message: t("tool.urlsUnreachable", { urls: bad.map(b => `${b.url}(${b.status})`).join(", ") }) };
    }
    return { ok: window.kasugaiApi.applyInspector(args.text) };
  }
  if (name === "exportInspector") return { ok: window.kasugaiApi.exportInspector() };
  if (name === "checkUpdate") {
    const r = await window.kasugaiApi.checkUpdate();
    return r && typeof r === "object" ? r : { ok: !!r };
  }
  if (name === "installUpdate") {
    const r = await window.kasugaiApi.installUpdate();
    if (r && typeof r === "object") return r.ok !== undefined ? r : { ok: true, ...r };
    return { ok: !!r, message: r ? undefined : t("tool.noUpdate") };
  }
  if (name === "runCode") {
    try {
      const { result, logs } = await runSandboxedCode(String(args.code || ""));
      return { result, logs };
    } catch (error) {
      return { ok: false, message: String(error && error.message || error) };
    }
  }
  if (name === "addLayer") {
    const check = await verifyToolTargetUrl(args.target, args.options);
    if (!check.ok) return { ok: false, message: t("tool.urlUnreachable", { status: check.status }) };
    return { ok: window.kasugaiApi.addLayer(args.title, args.target, { type: args.type, options: args.options }) };
  }
  if (name === "addGeoJsonLayer") {
    const check = await verifyToolTargetUrl(args.url);
    if (!check.ok) return { ok: false, message: t("tool.urlUnreachable", { status: check.status }) };
    return { ok: window.kasugaiApi.addGeoJsonLayer(args.title, args.url) };
  }
  if (name === "shutdownApp") {
    const r = await window.kasugaiApi.shutdownApp();
    return r && typeof r === "object" ? r : { ok: !!r };
  }
  if (name === "bridgeSetup") {
    const provider = String(args.provider || "").toLowerCase().trim();
    if (!BRIDGE_PROVIDERS.includes(provider)) {
      return { ok: false, message: `unknown provider: ${provider}` };
    }
    const action = String(args.action || "status").toLowerCase();
    // ソフトウェアのインストールは実行前に必ずユーザー確認を取る
    if (action === "install"
      && !window.confirm(t("chat.bridge.installConfirm", { provider }))) {
      return { ok: false, message: t("agent.cancelled") };
    }
    return await bridgeSetupRun(provider, action);
  }
  if (name === "savePlugin") {
    // 生成コードの適用前にユーザーへ全文確認を取る（プラグインはフル権限で動くため）
    const approved = await confirmPluginApply({ id: args.id, name: args.name, code: String(args.code || "") });
    if (!approved) return { ok: false, message: t("agent.cancelled") };
    return await window.kasugaiApi.saveStoragePlugin(args);
  }
  if (name === "listPlugins") {
    const bundled = window.kasugaiApi.getPlugins().map(plugin => ({ id: plugin.id, name: plugin.name, source: "bundled" }));
    const stored = await window.kasugaiApi.listStoragePlugins();
    // plugin: 行で指定できる同梱プラグインカタログ(plugins.json)も併記する
    const catalog = (window.kasugaiPluginLoader?.catalog?.() || []).map(m => ({ id: m.id, name: m.name, version: m.version, auto: !!m.auto }));
    return { plugins: [...bundled, ...stored.map(plugin => ({ ...plugin, source: "storage" }))], catalog };
  }
  if (name === "getPluginCode") {
    const record = await window.kasugaiApi.getStoragePlugin(args.id);
    if (!record) return { ok: false, message: t("tool.pluginNotFound", { name: args.id }) };
    return { id: record.id, name: record.name, version: record.version, layer: record.layer, enabled: record.enabled, lastError: record.lastError || null, code: record.code };
  }
  if (name === "removePlugin") {
    const record = await window.kasugaiApi.getStoragePlugin(args.id);
    if (!record) return { ok: false, message: t("tool.pluginNotFound", { name: args.id }) };
    if (!window.confirm(t("agent.confirmDelete", { name: record.name || record.id }))) return { ok: false, message: t("agent.cancelled") };
    return { ok: await window.kasugaiApi.removeStoragePlugin(record.id) };
  }
  if (name === "setPluginEnabled") {
    const ok = await window.kasugaiApi.setStoragePluginEnabled(args.id, args.enabled);
    return { ok, message: ok ? undefined : t("tool.pluginNotFound", { name: args.id }) };
  }
  if (name === "publishPlugin") {
    // PLUGIN/ への書き込みは全利用者への配布になるため必ず確認を取る
    const record = await window.kasugaiApi.getStoragePlugin(args.id);
    if (!record) return { ok: false, message: t("tool.pluginNotFound", { name: args.id }) };
    if (!window.confirm(t("agent.confirmPublish", { name: record.name || record.id }))) {
      return { ok: false, message: t("agent.cancelled") };
    }
    const result = await window.kasugaiApi.publishStoragePlugin(record.id);
    if (result?.error) return { ok: false, message: result.error };
    return { ok: true, message: t("agent.published", { name: record.name || record.id }) };
  }
  if (name === "fetchData") {
    try {
      return await window.kasugaiApi.fetchData(args.url);
    } catch (error) {
      return { ok: false, message: String(error && error.message || error) };
    }
  }
  if (name === "getLayerGeoJson") {
    const geojson = window.kasugaiApi.getLayerGeoJson(args.name);
    if (!geojson) return { ok: false, message: t("tool.layerDataNotFound", { name: args.name }) };
    const size = JSON.stringify(geojson).length;
    if (size > 400000) {
      return { ok: false, message: t("tool.dataTooLarge", { size, count: geojson.features?.length ?? 0 }) };
    }
    return { geojson };
  }
  if (name === "addDataLayer") {
    const item = await window.kasugaiApi.addDataLayer(args.title, args.geojson);
    return item ? { ok: true, id: item.id } : { ok: false, message: t("tool.invalidGeoJson") };
  }
  if (name === "removeDataLayer") {
    const ok = await window.kasugaiApi.removeDataLayer(args.name);
    return { ok, message: ok ? undefined : t("tool.layerNotFound", { name: args.name }) };
  }
  if (name === "setToolMaxSteps") {
    return { ok: true, steps: setChatMaxToolSteps(args.steps) };
  }
  if (name === "setLayerFilter") {
    const result = await window.kasugaiApi.setLayerFilter(args.name, args.filter);
    if (result?.ok) return { ok: true };
    if (result?.reason === "unsupported") return { ok: false, message: t("tool.layerFilterUnsupported", { name: args.name }) };
    if (result?.reason === "failed") return { ok: false, message: t("tool.layerFilterFailed", { name: args.name }) };
    return { ok: false, message: t("tool.layerNotFound", { name: args.name }) };
  }
  if (name === "listUiControls") return { controls: window.kasugaiApi.listUiControls(args.filter) };
  if (name === "controlUi") return window.kasugaiApi.controlUi(args.target, { action: args.action, value: args.value });
  if (name === "listGsiLayers") return { layers: window.kasugaiApi.listGsiLayers() };
  if (name === "importGsiLayers") return await window.kasugaiApi.importGsiLayers({ ids: args.ids });
  if (name === "setGsiLayerOpacity") return window.kasugaiApi.setGsiLayerOpacity(args.id, args.opacity);
  if (name === "moveGsiLayer") return window.kasugaiApi.moveGsiLayer(args.id, args.position);
  if (name === "removeGsiLayer") return window.kasugaiApi.removeGsiLayer(args.id);
  if (name === "listGsiCatalog") return window.kasugaiApi.listGsiCatalog(args.filter);
  if (name === "addGsiLayer") return window.kasugaiApi.addGsiLayer(args.id, { hidden: args.hidden });
  if (name === "listGsiSakuzu") return { items: window.kasugaiApi.listGsiSakuzu() };
  if (name === "importGsiSakuzu") return await window.kasugaiApi.importGsiSakuzu({ indices: args.indices });
  if (name === "listGsiBasemaps") return { basemaps: window.kasugaiApi.listGsiBasemaps() };
  if (name === "setGsiBasemap") return window.kasugaiApi.setGsiBasemap(args.id);
  if (name === "importGsiCatalog") return await window.kasugaiApi.importGsiCatalog({ ids: args.ids });
  if (name === "setGsiLayerHidden") return window.kasugaiApi.setGsiLayerHidden(args.id, args.hidden);
  if (name === "removeGsiSakuzu") return window.kasugaiApi.removeGsiSakuzu({ indices: args.indices });
  if (name === "getGsiElevation") return await window.kasugaiApi.getGsiElevation(args.latitude, args.longitude);
  if (name === "getGsiShareUrl") return window.kasugaiApi.getGsiShareUrl();
  if (name === "setGsiGlobe") return window.kasugaiApi.setGsiGlobe(args.on);
  return { ok: false, message: t("tool.unknown", { name }) };
}

// サーバーキーによる内蔵AI用 Gemini プロキシ（capabilities が aiProxy を通知する環境）。
// BYO（Bring Your Own：ブラウザ localStorage のユーザー自身のキー）があればそちらを優先し、
// 無ければプロキシ経由でキーレス利用する
function aiProxyEndpoint() {
  const endpoint = getBackendCapabilities()?.ai?.endpoint;
  if (!endpoint || !hasBackendFeature("aiProxy")) return "";
  try {
    return new URL(endpoint, window.location.href).href;
  } catch (e) {
    return "";
  }
}

// AI チャットのツール実行ループ上限（往復数）。無限ループ防止の安全弁。
// 設定は localStorage "geminiToolMaxSteps"（Gemini 設定パネル）。未設定・不正値は 10、範囲 1-20。
function clampToolSteps(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 20) : 10;
}
function getChatMaxToolSteps() {
  try {
    return clampToolSteps(localStorage.getItem("geminiToolMaxSteps") || "10");
  } catch (e) { return 10; }
}
// AIツール(setToolMaxSteps)からも呼ばれる setter。localStorage へ保存し、
// Gemini 設定パネルの入力欄が開いていれば表示も同期する
function setChatMaxToolSteps(value) {
  const n = clampToolSteps(value);
  try { localStorage.setItem("geminiToolMaxSteps", String(n)); } catch (e) {}
  const el = document.querySelector("#google-tool-max-steps");
  if (el) el.value = String(n);
  return n;
}

// 疎通を試みるブリッジ候補。アプリが capabilities で通知する
// エンドポイントを最優先にし、local ティアではブリッジハブの 8511 を候補とする
function bridgeCandidates(provider) {
  const list = [];
  const advertised = getBackendCapabilities()?.[provider]?.endpoint;
  if (advertised) list.push(advertised);
  // 既定のハブ口(8511)は通知の有無にかかわらず候補に入れる。
  // ブラウザ WebGIS 用 bridge-hub（8512 等）が検出済みならその口も足す。
  // localhost への疎通失敗は即座に返るためコストは無視できる
  list.push(BRIDGE_HUB_ENDPOINT_APP);
  if (webgisHub?.endpoint) list.push(webgisHub.endpoint);
  return [...new Set(list)];
}

// 指定エンドポイントの /health を疎通確認する。
// expect（"copilot"/"devin"）を渡すと、応答の bridge 識別子が別ブリッジを
// 示す場合に不一致とみなす（エンドポイント欄への別ブリッジURL残存対策。
// bridge 識別子を返さない旧版ブリッジは従来どおり応答あり扱い）
async function pingBridge(endpoint, expect) {
  let healthUrl = "";
  try { healthUrl = new URL("/health", endpoint).href; } catch (e) { return null; }
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d?.ok) {
      // ブリッジハブ（hub:true）は全プロバイダを統合して受けるため expect に適合
      if (expect && d?.bridge && d.bridge !== expect && !d?.hub) return null;
      return { endpoint, model: d?.model || "?", bridge: d?.bridge || "", providers: d?.providers || null };
    }
  } catch (e) {}
  return null;
}

// 候補を順に /health で疎通確認し、最初に応答したブリッジを返す
async function detectBridge(provider) {
  for (const endpoint of bridgeCandidates(provider)) {
    const found = await pingBridge(endpoint, provider);
    if (found) return found;
  }
  return null;
}

// 設定済みのブリッジモデル（空 = ブリッジ既定モデル）。ブリッジへの要求に同梱する
function getBridgeModel(provider) {
  try { return localStorage.getItem(provider + "Model") || ""; } catch (e) { return ""; }
}

// 保存済みエンドポイントへの接続に失敗した際、ブリッジ系プロバイダの既知候補を
// 疎通確認して生存している方へ切り替える（旧バージョンのポートが残存した場合等の
// 自己修復）。切替に成功したら保存値と設定欄を更新し、新エンドポイントを返す
async function healBridgeEndpoint(provider, failedEndpoint) {
  for (const endpoint of bridgeCandidates(provider)) {
    if (endpoint === failedEndpoint) continue;
    if (!(await pingBridge(endpoint, provider))) continue;
    try {
      localStorage.setItem("agentEndpoint", endpoint);
      const key = PROVIDER_ENDPOINT_KEYS[provider];
      if (key) localStorage.setItem(key, endpoint);
    } catch (e) {}
    const input = document.querySelector("#agent-endpoint");
    if (input && getChatProvider() === provider) input.value = endpoint;
    return endpoint;
  }
  return null;
}

// ブリッジハブのオリジン(http://127.0.0.1:<port>)を検出する。
// /agent エンドポイント記憶・webgis 検出・既定ポートを順に試し、
// /health が hub:true を返した最初のオリジンを返す(なければ null)
async function detectBridgeHubBase() {
  const eps = [];
  try {
    const saved = (localStorage.getItem("agentEndpoint") || "").trim();
    if (saved) eps.push(saved);
  } catch (e) {}
  if (webgisHub?.endpoint) eps.push(webgisHub.endpoint);
  eps.push(BRIDGE_HUB_ENDPOINT_APP, "http://127.0.0.1:8512/agent");
  for (const ep of [...new Set(eps)]) {
    try {
      const r = await fetch(new URL("/health", ep).href,
        { signal: AbortSignal.timeout(2000), cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.hub) return new URL(ep).origin;
    } catch (e) { /* 次の候補へ */ }
  }
  return null;
}

// bridgeSetup ツールを公開する目安（正確な可否は実行時に detectBridgeHubBase で確認）
function bridgeSetupHubMaybe() {
  return BRIDGE_PROVIDERS.some(p => hasBackendFeature(p + "Bridge"))
    || !!webgisHub?.endpoint;
}

// ハブの /setup を呼ぶ。action=status は GET、install はジョブを開始して
// 完了(またはタイムアウト)までポーリングする。戻り値はツール結果向けの要約
async function bridgeSetupRun(provider, action) {
  const hub = await detectBridgeHubBase();
  if (!hub) return { ok: false, message: t("chat.bridge.hubNotFound") };
  if (action !== "install") {
    try {
      const r = await fetch(`${hub}/setup`, { signal: AbortSignal.timeout(15000) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, message: d?.error || `HTTP ${r.status}` };
      return { ok: true, provider, status: d?.providers?.[provider] || null };
    } catch (e) {
      return { ok: false, message: String(e?.message || e) };
    }
  }
  try {
    const r = await fetch(`${hub}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, action: "install", confirm: true }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: d?.error || `HTTP ${r.status}`, guide: d?.guide };
    const jobId = d?.job;
    const deadline = Date.now() + 480000;
    let last = null;
    for (;;) {
      await new Promise(res => setTimeout(res, 2000));
      try {
        const jr = await fetch(`${hub}/setup/job/${jobId}`, { signal: AbortSignal.timeout(10000) });
        last = await jr.json().catch(() => ({}));
      } catch (e) { /* ポーリング継続 */ }
      if (last?.status && last.status !== "running") break;
      if (Date.now() > deadline) break;
    }
    return {
      ok: last?.status === "done",
      status: last?.status || "timeout",
      result: last?.result || null,
      log: (last?.log || []).slice(-15),
    };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

// 現環境で実際に使えるプロバイダ一覧を返す（チャットヘッダーのドロップダウン用）。
// gemini: BYOキーまたはサーバーキー(aiProxy)。openai: キー設定済み。
// copilot/devin/antigravity: アプリがブリッジを管理（feature通知）しハブが疎通。
// agent: エンドポイント設定済みまたは既定通知がある
async function usableChatProviders() {
  const set = new Set();
  try {
    if (localStorage.getItem("googleApiKey") || hasBackendFeature("aiProxy")) set.add("gemini");
    if (localStorage.getItem("openaiApiKey")) set.add("openai");
  } catch (e) {}
  await Promise.all(BRIDGE_PROVIDERS.map(async (v) => {
    if (!bridgeFeatureAvailable(v)) return;
    for (const endpoint of bridgeCandidates(v)) {
      const found = await pingBridge(endpoint, v);
      if (!found) continue;
      // ハブ応答なら該当プロバイダの available も確認（ブリッジ同梱・有効化済みか）
      if (found.providers && found.providers[v] && found.providers[v].available === false) continue;
      set.add(v);
      return;
    }
  }));
  try {
    // 外部エージェントは「agent 専用キーにURLが保存済み」または「現プロバイダが agent で
    // 送信先がある」場合のみ有効とみなす。共有 agentEndpoint はブリッジ系プロバイダの
    // 送信先としても使われるため、値の存在だけでは agent が設定済みと判断しない
    const agentSaved = (localStorage.getItem("agentEndpoint.agent") || "").trim();
    if (agentSaved || (getChatProvider() === "agent" && (localStorage.getItem("agentEndpoint") || "").trim())) set.add("agent");
  } catch (e) {}
  return PROVIDER_ORDER.filter(v => set.has(v));
}

// チャットヘッダーのプロバイダドロップダウンを「使えるものだけ」で再構築する。
// 現在の選択が無効になった場合は先頭の有効プロバイダへ自動で切り替える
async function refreshChatProviderSwitch() {
  const select = document.querySelector("#chat-provider-switch");
  if (!select) return;
  // capabilities 評価前はブリッジ系が「使えない」と誤判定されるため再構築を遅延する
  if (!isBackendCapabilitiesResolved()) return;
  // 手動起動のブラウザ WebGIS 用 bridge-hub も選択肢対象にするため併せて疎通する
  await probeWebgisHub();
  const usable = await usableChatProviders();
  const prevValue = select.value;
  select.textContent = "";
  for (const v of usable) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t(`chat.provider.${v}`);
    select.appendChild(o);
  }
  select.style.display = usable.length ? "" : "none";
  const current = getChatProvider();
  if (usable.includes(current)) {
    select.value = current;
    // 復元された選択も未確認なら疎通確認を開始する（切替時と同じ扱い）。
    // 過去の検証が別プロバイダへの切替で放棄され「connecting」のまま残った
    // ケース（実際には検証が走っていない）もここで再検証する
    const staleConnecting = providerConnState?.provider === current
      && providerConnState.state === "connecting"
      && providerVerifying !== current;
    if (providerConnState?.provider !== current || staleConnecting) {
      void verifyChatProviderConnection(current);
    }
  } else if (usable.length) {
    selectChatProvider(usable[0]);
    return;
  }
  // 再構築中に外部で値が変わっていた場合はそちらを優先
  if (prevValue && usable.includes(prevValue) && getChatProvider() !== prevValue) {
    selectChatProvider(prevValue);
  }
}

// チャットヘッダーのドロップダウンからの切替。プロバイダ記憶・エンドポイント・
// 有効フラグ・設定画面の select を同期させる（設定画面の保存と同等の効果）
export function selectChatProvider(v) {
  const prev = getChatProvider();
  try {
    const curEp = (localStorage.getItem("agentEndpoint") || "").trim();
    if (PROVIDER_ENDPOINT_KEYS[prev] && curEp) localStorage.setItem(PROVIDER_ENDPOINT_KEYS[prev], curEp);
    localStorage.setItem("chatProvider", v);
    const key = PROVIDER_ENDPOINT_KEYS[v];
    if (key) {
      const saved = (localStorage.getItem(key) || "").trim();
      const detected = v === "agent"
        ? (saved || curEp || defaultAgentEndpoint() || "")
        : (bridgeCandidates(v)[0] || "");
      const ep = saved || detected;
      localStorage.setItem("agentEndpoint", ep);
      if (ep && v !== "agent") localStorage.setItem(key, ep);
    }
    localStorage.setItem("agentEnabled", key ? "1" : "0");
  } catch (e) {}
  const settingsSelect = document.querySelector("#chat-provider");
  if (settingsSelect && settingsSelect.querySelector(`option[value="${v}"]`)) {
    settingsSelect.value = v;
    // チャット起点の切替では設定側の実接続検証を走らせない（利用は軽い接続のみ）
    suppressSettingsVerify = true;
    try { settingsSelect.dispatchEvent(new Event("change")); } finally { suppressSettingsVerify = false; }
  }
  updateChatProviderLabel();
  const select = document.querySelector("#chat-provider-switch");
  if (select && select.value !== v) select.value = v;
  // 疎通確認が取れるまで「未確認」表示（ドロップダウン赤・ラベルは接続中）
  void verifyChatProviderConnection(v);
}

// 外部エージェントの実接続テスト。/health を持つブリッジ型の実装ならそれで確認し、
// 無い場合は /agent へ最小のプローブ POST（ping フラグ＋空メッセージ）を送り、
// プロトコル応答（{reply}/{actions}/{error} を含む JSON の 2xx）が返れば接続済みとみなす。
// no-cors の到達確認では HTTP サーバーが生きているだけでプロトコルを話すか分からないため
async function verifyAgentConnection(endpoint) {
  try {
    const r = await fetch(new URL("/health", endpoint).href, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      // ブリッジハブ（hub:true）は汎用エージェント口ではない
      //（/agent の provider:"agent" は振り分け対象外）ため接続済み扱いしない
      if (d && (d.ok || d.bridge) && !d.hub) return true;
    }
  } catch (e) {}
  try {
    const headers = { "Content-Type": "application/json" };
    try {
      const token = sanitizeHeaderToken(localStorage.getItem("agentToken"));
      if (token) headers["Authorization"] = `Bearer ${token}`;
    } catch (e) {}
    const r = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30000),
      // provider:"agent" を明示しておく。ブリッジハブ宛に誤送された場合に
      // アクティブな子ブリッジへ誤配送されて実ターンを消費するのを防ぐ
      // （ハブには "agent" の振り分け先が無いため 4xx になり正しく未接続判定される）
      body: JSON.stringify({ ping: true, provider: "agent", message: "", project: "default", camera: null, layers: [], history: [], tools: [] }),
    });
    const d = await r.json().catch(() => null);
    return r.ok && !!d && typeof d === "object";
  } catch (e) {
    return false;
  }
}

// ブリッジ系プロバイダの実接続テスト。/health 疎通に留めず /models を実際に取得する。
// ハブはこのリクエストで子ブリッジを遅延起動し、Devin は acp 認証（必要なら
// ブラウザ認証フロー）まで進むため「実際にAIが動くか」がここで確定する。
// コールドスタート/acp 起動中は pending/error が返るため一定間隔でリトライする。
// token は providerVerifyToken — 確認中にプロバイダが切り替わったら中断する
async function verifyBridgeProviderConnection(v, token) {
  // 疎通するエンドポイントを決める。保存済みが死んでいても他候補が生きていれば
  // そちらへ自己修復する（healBridgeEndpoint と同じ効果）
  let endpoint = "";
  for (const candidate of bridgeCandidates(v)) {
    if (await pingBridge(candidate, v)) { endpoint = candidate; break; }
    if (providerVerifyToken !== token || getChatProvider() !== v) return false;
  }
  if (!endpoint) return false;
  try {
    const saved = (localStorage.getItem("agentEndpoint") || "").trim();
    if (saved !== endpoint) {
      localStorage.setItem("agentEndpoint", endpoint);
      const key = PROVIDER_ENDPOINT_KEYS[v];
      if (key) localStorage.setItem(key, endpoint);
    }
  } catch (e) {}
  for (let attempt = 0; attempt < 6; attempt++) {
    if (providerVerifyToken !== token || getChatProvider() !== v) return false;
    try {
      const u = new URL("/models", endpoint);
      u.searchParams.set("provider", v);
      const r = await fetch(u.href, {
        signal: AbortSignal.timeout(45000),
        headers: v === "devin" ? devinAuthHeaders(endpoint) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (d?.model) detectedBridgeModels[v] = d.model;
      if (d?.error) providerConnDetail[v] = String(d.error);
      if (r.ok && !d?.error && !d?.pending) { providerConnDetail[v] = ""; return true; }
    } catch (e) { /* リトライ */ }
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 8000));
  }
  return false;
}

// 選択したプロバイダに実際に接続できるか疎通確認し、結果をヘッダー表示へ反映する。
// ブリッジ系は /health 生存確認のうえ /models で実接続テスト（ブリッジ起動・
// Devin acp 認証まで通す — 軽い疎通だけでは実際にAIが動かないケースを拾えない）、
// 外部エージェントはエンドポイントへの実 fetch、
// API 系は設定済みのみ選択肢に出るため即 ok とみなす
let providerVerifyToken = 0;
let providerVerifying = null;
async function verifyChatProviderConnection(v) {
  const token = ++providerVerifyToken;
  providerVerifying = v;
  providerConnState = { provider: v, state: "connecting" };
  updateChatProviderLabel();
  try {
    let ok = true;
    if (BRIDGE_PROVIDERS.includes(v)) {
      ok = await verifyBridgeProviderConnection(v, token);
    } else if (v === "agent") {
      let endpoint = "";
      try { endpoint = (localStorage.getItem("agentEndpoint") || "").trim() || defaultAgentEndpoint(); } catch (e) {}
      ok = false;
      if (endpoint) ok = await verifyAgentConnection(endpoint);
    }
    // 確認中に別プロバイダへ切り替わっていたら結果は捨てる
    // （その場合 connState は放棄状態になるため、復帰時に refreshChatProviderSwitch が再検証する）
    if (providerVerifyToken === token && getChatProvider() === v) {
      providerConnState = { provider: v, state: ok ? "ok" : "ng", detail: ok ? "" : (providerConnDetail[v] || "") };
    }
  } catch (e) {
    if (providerVerifyToken === token) providerConnState = { provider: v, state: "ng", detail: providerConnDetail[v] || "" };
  } finally {
    if (providerVerifying === v) providerVerifying = null;
    updateChatProviderLabel();
  }
}

// チャットヘッダーに現在使用中のAIプロバイダ・モデルを表示する
function updateChatProviderLabel() {
  const el = document.querySelector("#chat-provider-label");
  if (!el) return;
  const provider = getChatProvider();
  // プロバイダ名はドロップダウン（#chat-provider-switch）が表示するため
  // ラベルはモデル名（外部エージェントは接続先ホスト）のみを出す
  let model = "";
  if (provider === "openai") {
    model = getOpenAIConfig().model;
  } else if (provider === "copilot" || provider === "devin" || provider === "antigravity") {
    const selected = getBridgeModel(provider);
    model = selected || detectedBridgeModels[provider] || "";
    if (model === "?") model = "";
  } else if (provider === "agent") {
    try { model = new URL(getAgentConfig().endpoint || "").host || ""; } catch (e) {}
  } else {
    model = chatGeminiModel() || "";
  }
  // 切替後の接続確認中・疎通失敗時はモデル名ではなく状態を表示し、
  // ドロップダウンを赤背景にする（確認できてから通常表示へ戻る）
  const conn = providerConnState?.provider === provider ? providerConnState : null;
  const connState = conn?.state || null;
  el.textContent = connState === "connecting" ? t("chat.provider.connecting")
    : connState === "ng" ? t("chat.provider.notConnected")
    : model;
  // 失敗理由（ブリッジ応答の error 等）はホバーで見えるようにする
  el.title = conn?.detail || "";
  const select = document.querySelector("#chat-provider-switch");
  if (select) {
    select.classList.toggle("unverified", connState === "connecting" || connState === "ng");
    select.title = conn?.detail || "";
    if (select.querySelector(`option[value="${provider}"]`) && select.value !== provider) {
      select.value = provider;
    }
  }
}

// トークン数の表示用フォーマット（1250000 → "1.3M"、200000 → "200K"）
function formatTokenCount(n) {
  if (!n || !Number.isFinite(n)) return "";
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

// モデルIDからコンテキスト長の目安を推定する（表示のみ・ファミリー別の公称値）。
// ブリッジが usage_update で実測値を通知した場合はそちらが優先される。
// Cognition 独自モデル（swe/adaptive 等）は公称値が無いため空白にする
function modelContextHint(id) {
  const s = String(id || "").toLowerCase();
  if (!s) return "";
  if (/-1m($|-)/.test(s)) return "1M";            // glm-5-2-1m 等の1Mバリアント
  if (s.startsWith("claude")) return "200K";
  if (s.startsWith("gemini")) return "1M";
  if (s.startsWith("gpt") || s.startsWith("codex")) return "400K";
  if (s.startsWith("kimi")) return "256K";
  if (s.startsWith("glm")) return "200K";
  if (s.startsWith("qwen")) return "256K";
  if (s.startsWith("grok")) return "256K";
  if (s.startsWith("deepseek")) return "128K";
  if (s.startsWith("llama")) return "128K";
  if (s.startsWith("mistral") || s.startsWith("codestral") || s.startsWith("magistral")) return "256K";
  if (s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4")) return "200K";
  return "";
}

// モデル選択肢の表示名。ブリッジ通知の実測コンテキスト長（context）があれば
// 正確な値を、なければファミリー推定値を「〜」付きで末尾に添える
function modelOptionLabel(m) {
  const base = m?.name && m.name !== m.id ? `${m.name} (${m.id})` : String(m?.id || "");
  const ctx = m?.context ? formatTokenCount(m.context) : (modelContextHint(m?.id) ? `〜${modelContextHint(m.id)}` : "");
  return ctx ? `${base} · ${ctx}` : base;
}

// 内蔵AIのプロバイダ選択。Gemini（BYOキーまたはサーバープロキシ）、
// OpenAI互換API（GitHub Models・OpenAI・Ollama等）のAPI系と、
// GitHub Copilot（copilot ブリッジ）・外部エージェントのブリッジ系のいずれか
export function getChatProvider() {
  try {
    const p = localStorage.getItem("chatProvider");
    if (["gemini", "openai", "copilot", "devin", "antigravity", "agent"].includes(p)) return p;
    // 移行前の利用形態を推定（プロバイダ未保存＋エージェント有効 → agent 相当）
    if (!p) {
      const enabledFlag = localStorage.getItem("agentEnabled");
      const autoEnabled = enabledFlag === null && !localStorage.getItem("agentEndpoint") && !!defaultAgentEndpoint();
      if (enabledFlag === "1" || autoEnabled) {
        return localStorage.getItem("agentAutoConfig") === "copilot" ? "copilot" : "agent";
      }
    }
    return "gemini";
  } catch (e) { return "gemini"; }
}

// OpenAI互換プロバイダの接続情報。既定は GitHub Models (models.github.ai)。
// ベースURL・モデルを変えれば OpenAI 本家・Azure・Ollama・LM Studio 等にも流用できる
function getOpenAIConfig() {
  try {
    return {
      apiKey: sanitizeHeaderToken(localStorage.getItem("openaiApiKey")),
      baseUrl: ((localStorage.getItem("openaiBaseUrl") || "").trim() || "https://models.github.ai/inference").replace(/\/+$/, ""),
      model: (localStorage.getItem("openaiModel") || "").trim() || "gpt-4o-mini",
    };
  } catch (e) {
    return { apiKey: "", baseUrl: "https://models.github.ai/inference", model: "gpt-4o-mini" };
  }
}

// Gemini形式スキーマ（type が大文字）を OpenAI tools が要求する JSON Schema（小文字）へ変換する
function chatSchemaToJsonSchema(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(chatSchemaToJsonSchema);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" && typeof value === "string") out[key] = value.toLowerCase();
    else if (value && typeof value === "object") out[key] = chatSchemaToJsonSchema(value);
    else out[key] = value;
  }
  return out;
}

// activeChatTools の functionDeclarations を OpenAI tools 形式へ変換する
function chatToolsOpenAI() {
  return (activeChatTools()[0]?.functionDeclarations || []).map(d => ({
    type: "function",
    function: {
      name: d.name,
      description: d.description || "",
      parameters: chatSchemaToJsonSchema(d.parameters || { type: "OBJECT", properties: {} }),
    },
  }));
}

// 履歴の正本（Gemini contents形式）を OpenAI messages 形式へ変換する。
// functionCall/functionResponse も tool_calls / tool メッセージとして順序で対応付ける
function chatHistoryToOpenAI(history) {
  const messages = [];
  let callSeq = 0;
  const pendingIds = [];
  for (const entry of history) {
    const parts = Array.isArray(entry?.parts) ? entry.parts : [];
    if (entry.role === "model") {
      const content = parts.filter(p => p.text).map(p => p.text).join("");
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length && !content) continue;
      const msg = { role: "assistant", content: content || null };
      if (calls.length) {
        msg.tool_calls = calls.map(p => {
          const id = `call_${callSeq++}`;
          pendingIds.push(id);
          return { id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } };
        });
      }
      messages.push(msg);
    } else {
      for (const p of parts) {
        if (p.text) messages.push({ role: "user", content: p.text });
        else if (p.functionResponse) {
          messages.push({ role: "tool", tool_call_id: pendingIds.shift() || `call_${callSeq++}`, content: JSON.stringify(p.functionResponse.response ?? {}) });
        }
      }
    }
  }
  return messages;
}

// OpenAI互換 chat/completions を呼び、tool calling の往復を処理する。
// ツール往復はブラウザ内で行い、履歴の正本（contents形式）にも同内容を追記して
// プロバイダを切り替えても会話が破綻しないようにする
async function callOpenAICompat(history) {
  const { apiKey, baseUrl, model } = getOpenAIConfig();
  const executed = [];
  const messages = [
    { role: "system", content: chatSystemInstruction() },
    ...chatHistoryToOpenAI(history),
  ];
  const tools = chatToolsOpenAI();
  let maxSteps = getChatMaxToolSteps();
  for (let step = 0; ; step++) {
    if (step >= maxSteps) {
      // 上限到達 — Gemini 側と同じく、続行するかユーザーに確認する
      const increment = getChatMaxToolSteps();
      if (!window.confirm(t("chat.toolLimitContinue", { steps: increment }))) {
        return { text: t("chat.toolLimit"), executed };
      }
      maxSteps += increment;
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CHAT_LLM_TIMEOUT_MS),
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error(t("chat.noResponse"));
    messages.push(msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const canonicalParts = [];
    if (typeof msg.content === "string" && msg.content) canonicalParts.push({ text: msg.content });
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch (e) {}
      canonicalParts.push({ functionCall: { name: c.function?.name, args } });
    }
    history.push({ role: "model", parts: canonicalParts });
    if (!calls.length) {
      const text = (typeof msg.content === "string" ? msg.content : "").trim();
      return { text: text || t("chat.noResponse"), executed };
    }
    const responseParts = [];
    for (const c of calls) {
      const name = c.function?.name;
      let args = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch (e) {}
      const result = await executeChatTool(name, args);
      executed.push(`${name}(${JSON.stringify(args)})`);
      messages.push({ role: "tool", tool_call_id: c.id, content: typeof result === "string" ? result : JSON.stringify(result ?? null) });
      responseParts.push({ functionResponse: { name, response: { result } } });
    }
    history.push({ role: "user", parts: responseParts });
  }
}

// Gemini generateContent を呼び、function calling の往復を処理する
async function callGemini(history) {
  const apiKey = chatGoogleApiKey();
  const model = chatGeminiModel();
  // Cloud Run 管理の追加指示がある場合はサーバープロキシを通し、BYOキー経路で迂回しない。
  const proxy = getBackendCapabilities()?.ai?.instructions
    ? aiProxyEndpoint()
    : (apiKey ? "" : aiProxyEndpoint());
  const endpoint = proxy || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const executed = [];
  // プロキシ経由の場合、認証モードではログイン済みの kasugai トークンが必須。
  // 直接 Gemini を呼ぶ経路（BYO キー）には付けない（内部トークンを外部へ送らない）
  const headers = { "Content-Type": "application/json" };
  if (proxy && window.kasugaiAuth?.token) {
    headers["Authorization"] = `Bearer ${window.kasugaiAuth.token}`;
  }
  let maxSteps = getChatMaxToolSteps();
  for (let step = 0; ; step++) {
    if (step >= maxSteps) {
      // 上限到達 — 続行するかユーザーに確認。承認なら現行の設定値を1枠追加して延長。
      // ループ中に AI が setToolMaxSteps で上限を変えていれば新しい値がここで効く
      const increment = getChatMaxToolSteps();
      if (!window.confirm(t("chat.toolLimitContinue", { steps: increment }))) {
        return { text: t("chat.toolLimit"), executed };
      }
      maxSteps += increment;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(CHAT_LLM_TIMEOUT_MS),
      body: JSON.stringify({
        ...(proxy ? { model } : {}),
        systemInstruction: { parts: [{ text: chatSystemInstruction() }] },
        contents: history,
        tools: activeChatTools(),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
    const parts = data?.candidates?.[0]?.content?.parts || [];
    history.push({ role: "model", parts });
    const calls = parts.filter(part => part.functionCall);
    if (!calls.length) {
      const text = parts.map(part => part.text || "").join("").trim();
      return { text: text || t("chat.noResponse"), executed };
    }
    const responseParts = [];
    for (const part of calls) {
      const result = await executeChatTool(part.functionCall.name, part.functionCall.args || {});
      executed.push(`${part.functionCall.name}(${JSON.stringify(part.functionCall.args || {})})`);
      responseParts.push({ functionResponse: { name: part.functionCall.name, response: { result } } });
    }
    history.push({ role: "user", parts: responseParts });
  }
}

export function setupChatPanel() {
  const panel = document.querySelector("#chat-panel");
  if (!panel) return;
  updateChatPanelVisibility();
  const messages = document.querySelector("#chat-messages");
  const form = document.querySelector("#chat-form");
  const input = document.querySelector("#chat-input");
  const history = [];

  // チャット履歴はプロジェクト単位で localStorage に保存する
  const historyKey = `kasugaiChatHistory_${chatProjectId()}`;
  const loadChatLog = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(historyKey) || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch (e) { return []; }
  };
  const saveChatLog = (role, text) => {
    try {
      const log = loadChatLog();
      log.push({ role, text });
      localStorage.setItem(historyKey, JSON.stringify(log.slice(-200)));
    } catch (e) {}
  };

  const addMessage = (role, text, { persist = true, anchor = null } = {}) => {
    const div = document.createElement("div");
    div.className = `chat-message ${role}`;
    // assistant の応答は Markdown（見出し・箇条書き・リンク・コード等）として描画。
    // renderMarkdownLite は内部で escapeHtml 済みのため安全
    if (role === "assistant") div.innerHTML = renderMarkdownLite(text);
    else div.textContent = text;
    // anchor（質問直下の「…」プレースホルダ）が有効ならその直前に挿入する。
    // キュー処理中に後続の質問が既に並んでいても回答は質問の直下に収まる
    if (anchor && anchor.parentNode === messages) messages.insertBefore(div, anchor);
    else messages.append(div);
    messages.scrollTop = messages.scrollHeight;
    if (persist) saveChatLog(role, text);
  };

  // 保存済み履歴を復元し、Gemini の会話コンテキストも user/model ペアで再構成する
  const savedLog = loadChatLog();
  savedLog.forEach(entry => {
    if (!entry || typeof entry.text !== "string") return;
    addMessage(entry.role, entry.text, { persist: false });
    if (entry.role === "user") history.push({ role: "user", parts: [{ text: entry.text }] });
    else if (entry.role === "assistant") history.push({ role: "model", parts: [{ text: entry.text }] });
  });

  // チャットヘッダーのプロバイダドロップダウン。実際に使えるプロバイダのみが
  // 選択肢に出る（usableChatProviders で判定）。設定画面のプロバイダ選択と同期する
  document.querySelector("#chat-provider-switch")?.addEventListener("change", (e) => {
    selectChatProvider(e.target.value);
  });

  const toggle = document.querySelector("#chat-panel-toggle");
  toggle?.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "+" : "−";
    toggle.setAttribute("aria-label", collapsed ? t("common.expand") : t("common.minimize"));
  });

  const clearButton = document.querySelector("#chat-clear");
  clearButton?.addEventListener("click", () => {
    try { localStorage.removeItem(historyKey); } catch (e) {}
    history.length = 0;
    messages.replaceChildren();
    addMessage("system", t("chat.cleared"), { persist: false });
  });

  // 連続送信されたメッセージはキューで1件ずつ処理する。
  // 並行実行すると全ターンが共有 history を同時に変更して会話順が壊れ、
  // 前の質問への回答が次の質問の下に表示される（表示ずれ）ため逐次化する。
  // 「…」プレースホルダは送信時点で質問の直下に置き、回答はその位置に挿入する
  let chatChain = Promise.resolve();
  form?.addEventListener("submit", event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMessage("user", text);
    const thinking = document.createElement("div");
    thinking.className = "chat-message assistant";
    thinking.textContent = "…";
    messages.append(thinking);
    messages.scrollTop = messages.scrollHeight;
    chatChain = chatChain
      .then(() => respondToChat(text, thinking))
      .catch(error => {
        // 例外はここで握りつぶさず必ず表示する。
        // 黙って「…」を消すだけだと質問だけが残り無応答に見える
        thinking.remove();
        addMessage("system", t("common.error", { error: String(error?.message || error) }));
      });
  });

  // 外部エージェントへメッセージを送る。
  // 応答は {reply: "...", actions: [{name, args}]} で、actions はチャットツールと同名で順次実行される。
  // 実行した各アクションの結果は toolResults としてブリッジへ送り返し、結果を踏えた
  // 続きの回答・追加アクションを受け取る往復を、追加アクションが無くなるまで繰り返す
  // （一覧・検索系ツールの実値をエージェントが見て回答できるようにするためのもの）
  async function callExternalAgent(text) {
    const config = getAgentConfig();
    const headers = { "Content-Type": "application/json" };
    if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
    const provider = getChatProvider();
    // Devin プロバイダは設定済みの APIキーをブリッジへ渡して acp 認証に使わせる
    // （未設定時はブリッジ側でブラウザ PKCE 認証が起動する）
    if (provider === "devin") Object.assign(headers, devinAuthHeaders(config.endpoint));
    // BYO キー同梱が有効な場合のみ apiKey を付ける（未設定時はサーバー側のキーに委ねる）
    const apiKey = config.sendKey ? (chatGoogleApiKey() || "") : "";
    // キーを平文で流出させないため、送信先は https または localhost のみ許可する
    if (apiKey && !isSecureAgentEndpoint(config.endpoint)) {
      throw new Error(t("agent.sendKeyInsecure"));
    }
    // 各ラウンドで最新のカメラ・レイヤ状態を取り直して送る（直前アクションで変わるため）
    const makeBody = (extra = {}) => JSON.stringify({
      message: text,
      // 外部エージェントにもアプリの基本指示と保存済み追加指示を渡す
      systemInstruction: chatSystemInstruction(),
      project: chatProjectId(),
      engine: aiEngine,
      camera: window.kasugaiApi?.getCamera?.(),
      layers: window.kasugaiApi?.listLayers?.() ?? [],
      // ブリッジ側のローカル状態ツール（listBasemaps 等）が実値を返せるよう
      // 疑似項目（ベースマップなし/透明）を含む一覧を同梱する
      basemaps: window.kasugaiApi?.listBasemaps?.() ?? [],
      history: loadChatLog().slice(-20),
      // 外部エージェントがツール一覧を必要とする場合のため宣言を同梱する
      // （Copilot ブリッジ等が functionDeclarations をそのまま登録できる）
      tools: activeChatTools()[0]?.functionDeclarations || [],
      // ブリッジハブ（アプリ管理の統一エンドポイント）がバックエンドを
      // 選ぶためのプロバイダ識別子。単体ブリッジはこのフィールドを無視する
      provider,
      // Copilot/Devin/Antigravity プロバイダ利用時は選択モデルをブリッジへ伝える
      ...(BRIDGE_PROVIDERS.includes(provider) && getBridgeModel(provider) ? { model: getBridgeModel(provider) } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...extra,
    });
    const postOnce = async (endpoint, payload) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const r = await fetch(endpoint, { method: "POST", headers, signal: controller.signal, body: payload });
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
        return d || {};
      } finally {
        clearTimeout(timer);
      }
    };
    const post = async (payload) => {
      try {
        return await postOnce(config.endpoint, payload);
      } catch (err) {
        // 接続拒否等（保存済みエンドポイントが旧バージョンのポートで死んでいる等）の場合、
        // ブリッジ系プロバイダは既知候補を疎通確認して生存している方へ一度だけ再試行する
        const healed = err instanceof TypeError ? await healBridgeEndpoint(provider, config.endpoint) : null;
        if (!healed || (apiKey && !isSecureAgentEndpoint(healed))) throw err;
        return await postOnce(healed, payload);
      }
    };

    const executed = [];
    let reply = "";
    let data = await post(makeBody());
    // actions を実行→結果を toolResults で返送→続きの回答/追加 actions、を最大5往復
    for (let round = 0; round < 5; round++) {
      reply = typeof data?.reply === "string" && data.reply ? data.reply : reply;
      // 資料フィールドが返された場合は showReport と同等に扱ってモーダル表示する
      if (data?.report && typeof data.report === "object") {
        try {
          await executeChatTool("showReport", { title: data.report.title, format: data.report.format, content: data.report.content });
          executed.push(`showReport(${JSON.stringify({ title: data.report.title || "" })})`);
        } catch (e) {}
      }
      const actions = (Array.isArray(data?.actions) ? data.actions : [])
        .filter(a => a && typeof a.name === "string");
      if (!actions.length) break;
      const results = [];
      for (const action of actions) {
        let result = null;
        try { result = await executeChatTool(action.name, action.args || {}); }
        catch (e) { result = { error: String(e?.message || e) }; }
        results.push({ name: action.name, args: action.args || {}, result });
        executed.push(`${action.name}(${JSON.stringify(action.args || {})})`);
      }
      data = await post(makeBody({ toolResults: results }));
    }
    return { text: reply || t("chat.noResponse"), executed };
  }

  // Google APIキーが設定されていれば Gemini (function calling)、未設定ならローカルコマンドのみ。
  // "kasugai:chat" カスタムイベントを購読し detail.reply をセットすれば外部エージェントへ橋渡しできる
  // thinking は送信時に質問直下へ挿入済みの「…」プレースホルダ。
  // 応答・実行ログはその直前に挿入し、完了時に取り除く
  async function respondToChat(text, thinking) {
    const say = (role, msg) => addMessage(role, msg, { anchor: thinking });
    const detail = { text, reply: null };
    window.dispatchEvent(new CustomEvent("kasugai:chat", { detail }));
    if (typeof detail.reply === "string" && detail.reply) {
      say("assistant", detail.reply);
      thinking.remove();
      return;
    }
    if (text.startsWith("/")) {
      const local = await handleLocalChatCommand(text);
      say("assistant", local || t("chat.unknownCommand", { command: text }));
      thinking.remove();
      return;
    }
    // 外部エージェントが有効なら Gemini より優先してエンドポイントへ送信する
    if (isAgentEnabled()) {
      try {
        const { text: reply, executed } = await callExternalAgent(text);
        executed.forEach(call => say("system", t("chat.executed", { call })));
        say("assistant", reply);
      } catch (error) {
        say("system", t("common.error", { error: error.message }));
      }
      thinking.remove();
      return;
    }
    // BYO キーが無くても、バックエンドが aiProxy を通知していればサーバーキーで動く
    const provider = getChatProvider();
    const hasKey = provider === "openai"
      ? !!getOpenAIConfig().apiKey
      : (provider === "copilot" || provider === "devin" || provider === "antigravity" || provider === "agent")
        ? isAgentEnabled()
        : (!!chatGoogleApiKey() || !!aiProxyEndpoint());
    if (!hasKey) {
      const local = await handleLocalChatCommand(text);
      const key = provider === "openai" ? "chat.noApiKeyOpenai" : provider === "copilot" ? "chat.noApiKeyCopilot" : provider === "devin" ? "chat.noApiKeyDevin" : provider === "antigravity" ? "chat.noApiKeyAntigravity" : provider === "agent" ? "chat.noBridge" : "chat.noApiKey";
      say("assistant", local || t(key));
      thinking.remove();
      return;
    }
    const historyBase = history.length;
    try {
      history.push({ role: "user", parts: [{ text }] });
      const { text: reply, executed } = provider === "openai" ? await callOpenAICompat(history) : await callGemini(history);
      executed.forEach(call => say("system", t("chat.executed", { call })));
      say("assistant", reply);
    } catch (error) {
      // 途中まで積まれた user/model/関数応答の往復ごとロールバックする
      history.length = historyBase;
      say("system", t("common.error", { error: error.message }));
    }
    thinking.remove();
  }

  // 初回案内は表示しない（API未設定時のチュートリアル表示を省略）
}



// ---- プレイヤー系エンジン向け DOM 注入 ----
// Cesium 版は index.html にマークアップがあるため注入しない。
// maplibre / openlayers / leaflet は本モジュールがパネルと AI 設定欄を生成する

const AI_CHAT_CSS = `
.chat-panel { position: fixed; z-index: 2100; bottom: 30px; right: 14px; width: 340px; max-height: calc(100% - 240px); display: flex; flex-direction: column; padding: 10px; border: 1px solid #d9e4e9; border-radius: 8px; background: rgba(255,255,255,.6); box-shadow: 0 8px 24px rgba(29,43,53,.14); pointer-events: auto; touch-action: auto; user-select: text; font-family: system-ui, "Segoe UI", "Yu Gothic", sans-serif; }
.chat-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.chat-header strong { font-size: 14px; color: #31564f; }
.chat-provider-box { display: flex; align-items: center; gap: 6px; min-width: 0; }
.chat-provider-switch { min-width: 0; max-width: 160px; min-height: 24px; padding: 1px 4px; border: 1px solid #cbd9de; border-radius: 4px; background: rgba(255,255,255,.85); color: #31564f; font-size: 12px; }
.chat-provider-switch.unverified { background: #b03a2e; border-color: #922b21; color: #fff; }
.chat-provider-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: normal; }
.chat-toggle { flex: 0 0 26px; min-width: 26px; min-height: 26px; padding: 1px 4px; border: 0; border-radius: 4px; background: rgba(49,86,79,.16); color: #31564f; cursor: pointer; font-size: 18px; line-height: 1; }
#chat-clear { font-size: 12px; }
.chat-messages { flex: 1; min-height: 280px; margin: 8px 0; padding: 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; border: 1px solid #e4ecef; border-radius: 6px; background: rgba(255,255,255,.7); font-size: 13px; }
.chat-message { max-width: 90%; padding: 6px 9px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-message.user { align-self: flex-end; background: #31564f; color: #fff; }
.chat-message.assistant { align-self: flex-start; background: #eef5f7; color: #1d2b35; }
.chat-message.system { align-self: center; background: transparent; color: #71818d; font-size: 11px; }
.chat-message.assistant p { margin: 0 0 6px; }
.chat-message.assistant p:last-child { margin-bottom: 0; }
.chat-message.assistant ul { margin: 4px 0; padding-left: 18px; }
.chat-message.assistant h3, .chat-message.assistant h4, .chat-message.assistant h5, .chat-message.assistant h6 { margin: 8px 0 4px; font-size: 1em; }
.chat-message.assistant code { background: #dde8ec; padding: 0 3px; border-radius: 3px; font-size: 0.92em; }
.chat-message.assistant a { color: #1b6b7c; }
.chat-form { display: flex; gap: 6px; }
.chat-form input { flex: 1; min-width: 0; min-height: 30px; padding: 5px 7px; border: 1px solid #cbd9de; border-radius: 4px; background: #fff; color: #1d2b35; }
.chat-form button { min-height: 30px; padding: 5px 10px; border: 1px solid #31564f; border-radius: 4px; background: #31564f; color: #fff; cursor: pointer; }
.chat-panel.collapsed { width: 40px; height: 40px; padding: 7px; overflow: hidden; }
.chat-panel.collapsed .chat-header { justify-content: center; }
.chat-panel.collapsed .chat-header strong,
.chat-panel.collapsed .chat-header .chat-provider-box,
.chat-panel.collapsed .chat-header #chat-clear,
.chat-panel.collapsed .chat-messages,
.chat-panel.collapsed .chat-form { display: none; }
@media (max-width: 850px) { .chat-panel { right: 14px; left: 14px; bottom: 60px; width: auto; max-height: 45%; } }
#setpane-ai .field-label { display: block; font-size: 12px; margin: 8px 0 3px; }
#setpane-ai .hint { color: #666; font-size: 11px; margin: 6px 0; }
#setpane-ai .hint code { background: #eef2f4; padding: 0 3px; border-radius: 3px; }
#setpane-ai input[type="text"], #setpane-ai input[type="password"], #setpane-ai input[type="number"], #setpane-ai select, #setpane-ai textarea { box-sizing: border-box; max-width: 100%; }
#setpane-ai .ai-subnav { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
#setpane-ai .ai-subnav button { flex: 1; min-width: 60px; padding: 4px 2px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background: #f4f6f8; cursor: pointer; }
#setpane-ai .ai-subnav button.active { background: #2c5ea8; color: #fff; border-color: #2c5ea8; }
#setpane-ai .ai-subpane:not(.active) { display: none; }
#setpane-ai .ai-sec-title { font-weight: 600; font-size: 12px; margin: 4px 0; }
.mcp-server-row { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 3px 0; }
.mcp-server-row button { font-size: 11px; padding: 1px 6px; }
.mcp-server-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

const CHAT_PANEL_HTML = `
<aside class="chat-panel" id="chat-panel" aria-label="AIチャット" data-i18n-attr="aria-label:chat.ariaLabel">
  <div class="chat-header">
    <span class="chat-provider-box">
      <select id="chat-provider-switch" class="chat-provider-switch" title="使用するAIを選択" data-i18n-attr="title:chat.providerSwitch"></select>
      <strong id="chat-provider-label" class="chat-provider-label"></strong>
    </span>
    <span style="margin-left:auto;display:flex;gap:4px;">
      <button id="chat-clear" class="chat-toggle" type="button" aria-label="履歴をクリア" title="履歴をクリア" data-i18n-attr="aria-label:chat.clear;title:chat.clear">🗑</button>
      <button id="chat-panel-toggle" class="chat-toggle" type="button" aria-label="最小化" data-i18n-attr="aria-label:common.minimize">−</button>
    </span>
  </div>
  <div id="chat-messages" class="chat-messages" aria-live="polite"></div>
  <form id="chat-form" class="chat-form">
    <input id="chat-input" type="text" placeholder="メッセージを入力 (/ でコマンド)" data-i18n-attr="placeholder:chat.placeholder" autocomplete="off" />
    <button type="submit" data-i18n="chat.send">送信</button>
  </form>
</aside>`;

// プレイヤー向け AI 設定（cesium の管理 → AI ペインと同じ要素 id・同じサブタブ構成の簡略版）。
// 各エンジンの index.html が置いた #setpane-ai へ注入し setupAiSettings が配線する
const AI_SETTINGS_HTML = `
<nav class="ai-subnav">
  <button type="button" class="active" data-manage-sub="ai-pane-chat" data-i18n="manage.section.chat">チャット (AI)</button>
  <button type="button" data-manage-sub="ai-pane-instructions" data-i18n="chat.customInstructionsLabel">追加指示</button>
  <button type="button" data-manage-sub="datasource-panel" data-i18n="manage.section.datasource">データソース</button>
  <button type="button" data-manage-sub="plugin-panel" data-i18n="google.tab.plugin">プラグイン</button>
</nav>
<section id="ai-pane-chat" class="ai-subpane active">
  <label class="field-label" for="chat-provider" data-i18n="chat.provider.label">AI プロバイダ</label>
  <select id="chat-provider">
    <option value="gemini" selected data-i18n="chat.provider.gemini">【API】Gemini (Google)</option>
    <option value="openai" data-i18n="chat.provider.openai">【API】OpenAI互換 (GitHub Models 等)</option>
    <option value="copilot" data-i18n="chat.provider.copilot">【ブリッジ】GitHub Copilot</option>
    <option value="devin" data-i18n="chat.provider.devin">【ブリッジ】Devin</option>
    <option value="antigravity" data-i18n="chat.provider.antigravity">【ブリッジ】Antigravity</option>
    <option value="agent" data-i18n="chat.provider.agent">【ブリッジ】外部エージェント</option>
  </select>
  <div id="gemini-fields">
    <p class="hint" data-i18n-html="google.gemini.hint">Gemini API（AIチャット用）の設定です。<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a> で発行したキーを入力してください。</p>
    <label class="field-label" for="google-api-key" data-i18n="google.gemini.keyLabel">Gemini API キー</label>
    <input id="google-api-key" type="password" placeholder="Gemini APIキーを入力" autocomplete="off" size="28" />
    <label class="field-label" for="google-gemini-model" data-i18n="google.gemini.modelLabel">Gemini モデル</label>
    <select id="google-gemini-model">
      <option value="gemini-3.1-flash-lite" selected>gemini-3.1-flash-lite (標準・低コスト)</option>
      <option value="gemini-3.6-flash">gemini-3.6-flash</option>
      <option value="gemini-3.5-flash">gemini-3.5-flash</option>
      <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
    </select>
  </div>
  <div id="openai-fields" hidden>
    <p class="hint" data-i18n-html="chat.openai.hint">AIチャットに使う OpenAI 互換 API の設定です。</p>
    <label class="field-label" for="openai-base-url" data-i18n="chat.openai.baseUrlLabel">エンドポイント ベースURL</label>
    <input id="openai-base-url" type="text" placeholder="https://models.github.ai/inference" autocomplete="off" size="28" />
    <label class="field-label" for="openai-api-key" data-i18n="chat.openai.keyLabel">APIキー / トークン</label>
    <input id="openai-api-key" type="password" placeholder="GitHub PAT 等" autocomplete="off" size="28" />
    <label class="field-label" for="openai-model" data-i18n="chat.openai.modelLabel">モデル</label>
    <input id="openai-model" type="text" placeholder="gpt-4o-mini" autocomplete="off" size="28" />
  </div>
  <div id="bridge-fields" hidden>
    <p class="hint provider-only" data-for="agent" data-i18n-html="agent.externalHint" hidden></p>
    <p class="hint provider-only" data-for="copilot" data-i18n-html="chat.copilot.hint" hidden></p>
    <p class="hint provider-only" data-for="devin" data-i18n-html="chat.devin.hint" hidden></p>
    <p class="hint provider-only" data-for="antigravity" data-i18n-html="chat.antigravity.hint" hidden></p>
    <label class="field-label" for="agent-endpoint" data-i18n="agent.endpointLabel">エンドポイントURL</label>
    <input id="agent-endpoint" type="text" placeholder="http://127.0.0.1:9000/agent" autocomplete="off" size="28" />
    <p class="hint" id="bridge-hub-note" hidden>
      <span data-i18n-html="chat.bridge.hubNote"></span><br />
      <button type="button" id="bridge-hub-install" data-i18n="chat.bridge.hubInstall">ハブを自動インストール</button>
      <a href="../download/bridge-hub.exe" download="bridge-hub.exe" data-i18n="chat.bridge.hubDownload">bridge-hub.exe をダウンロード</a>
      <span id="bridge-hub-status" aria-live="polite"></span>
    </p>
    <div class="provider-only" data-for="agent" hidden>
      <label class="field-label" for="agent-token" data-i18n="agent.tokenLabel">トークン（任意）</label>
      <input id="agent-token" type="password" placeholder="Bearer トークン（省略可）" autocomplete="off" size="28" />
      <label><input id="agent-send-key" type="checkbox" /> <span data-i18n="agent.sendKeyLabel">自分の Gemini API キーをエージェントへ送信（BYO）</span></label>
      <p class="hint" id="agent-backend-status" aria-live="polite"></p>
    </div>
    <div id="copilot-fields" class="provider-only" data-for="copilot" hidden>
      <label class="field-label" for="copilot-model" data-i18n="chat.copilot.modelLabel">モデル</label>
      <select id="copilot-model"></select>
      <p class="hint" id="copilot-endpoint-status" aria-live="polite"></p>
      <div style="margin-top:4px;">
        <button type="button" class="bridge-setup-install" data-i18n="chat.bridge.autoInstall">CLI を自動インストール</button>
        <span class="hint bridge-setup-note" aria-live="polite"></span>
      </div>
    </div>
    <div id="devin-fields" class="provider-only" data-for="devin" hidden>
      <label class="field-label" for="devin-api-key" data-i18n="chat.devin.apiKeyLabel">Devin APIキー（任意）</label>
      <input id="devin-api-key" type="password" placeholder="cog_..." autocomplete="off" size="28" />
      <label class="field-label" for="devin-model" data-i18n="chat.devin.modelLabel">モデル</label>
      <select id="devin-model"></select>
      <p class="hint" id="devin-endpoint-status" aria-live="polite"></p>
      <div style="margin-top:4px;">
        <button type="button" class="bridge-setup-install" data-i18n="chat.bridge.autoInstall">CLI を自動インストール</button>
        <span class="hint bridge-setup-note" aria-live="polite"></span>
      </div>
    </div>
    <div id="antigravity-fields" class="provider-only" data-for="antigravity" hidden>
      <label class="field-label" for="antigravity-model" data-i18n="chat.antigravity.modelLabel">モデル</label>
      <select id="antigravity-model"></select>
      <p class="hint" id="antigravity-endpoint-status" aria-live="polite"></p>
      <div style="margin-top:4px;">
        <button type="button" class="bridge-setup-install" data-i18n="chat.bridge.autoInstall">CLI を自動インストール</button>
        <span class="hint bridge-setup-note" aria-live="polite"></span>
      </div>
    </div>
  </div>
  <label class="field-label" for="google-tool-max-steps" data-i18n="google.gemini.toolStepsLabel">ツール実行の上限往復数</label>
  <input id="google-tool-max-steps" type="number" min="1" max="20" step="1" />
  <div style="margin-top:10px;">
    <button id="google-settings-save" type="button" data-i18n="common.save">保存</button>
  </div>
  <p id="google-settings-status" class="hint" aria-live="polite"></p>
  <p id="google-proxy-status" class="hint" aria-live="polite"></p>
</section>
<section id="ai-pane-instructions" class="ai-subpane">
  <textarea id="chat-custom-instructions" rows="6" maxlength="8000" placeholder="AIにいつも守ってほしい指示を入力" style="width:100%;box-sizing:border-box;"></textarea>
  <div style="margin-top:6px;">
    <button id="chat-instructions-save" type="button" data-i18n="common.save">保存</button>
  </div>
  <p id="chat-instructions-status" class="hint" aria-live="polite"></p>
</section>
<section id="datasource-panel" class="ai-subpane">
  <p class="hint" data-i18n-html="mcp.hint">AI チャットへ外部データソースのツールを追加します（MCP）。</p>
  <div class="ai-sec-title" data-i18n="mcp.box.title">Box</div>
  <label class="field-label" for="box-client-id" data-i18n="mcp.box.clientIdLabel">Client ID</label>
  <input id="box-client-id" type="text" placeholder="Box アプリの Client ID" autocomplete="off" size="28" />
  <div style="display:flex;gap:6px;margin-top:6px;">
    <button id="box-connect" type="button" data-i18n="mcp.box.connect">Box に接続</button>
    <button id="box-disconnect" type="button" data-i18n="mcp.box.disconnect">切断</button>
  </div>
  <p id="box-status" class="hint" aria-live="polite"></p>
  <div class="ai-sec-title" data-i18n="mcp.add.title">MCP サーバー追加</div>
  <label class="field-label" for="mcp-add-name" data-i18n="mcp.add.nameLabel">名前</label>
  <input id="mcp-add-name" type="text" placeholder="my-server" autocomplete="off" size="28" />
  <label class="field-label" for="mcp-add-url" data-i18n="mcp.add.urlLabel">エンドポイント URL</label>
  <input id="mcp-add-url" type="text" placeholder="https://example.com/mcp" autocomplete="off" size="28" />
  <label class="field-label" for="mcp-add-token" data-i18n="mcp.add.tokenLabel">Bearer トークン（任意）</label>
  <input id="mcp-add-token" type="password" placeholder="省略可" autocomplete="off" size="28" />
  <div style="display:flex;gap:6px;margin-top:6px;">
    <button id="mcp-add" type="button" data-i18n="mcp.add.add">追加して接続</button>
  </div>
  <div class="ai-sec-title" data-i18n="mcp.list.title">登録サーバー</div>
  <div id="mcp-server-list"></div>
  <label style="margin-top:10px;display:block;"><input id="mcp-allow-write" type="checkbox" /> <span data-i18n="mcp.allowWrite">書き込み系ツールも AI に公開する</span></label>
  <p id="mcp-status" class="hint" aria-live="polite"></p>
</section>
<section id="plugin-panel" class="ai-subpane">
  <div id="agent-plugin-list"></div>
  <div style="display:flex;gap:6px;margin-top:8px;">
    <button id="agent-import" type="button" data-i18n="agent.import">取込</button>
    <input id="agent-import-file" type="file" accept=".kasp,.json,.js" multiple style="display:none;" />
    <button id="agent-refresh" type="button" data-i18n="agent.refresh">更新</button>
  </div>
  <p id="agent-status" class="hint" aria-live="polite"></p>
</section>`;

function ensureAiChatStyle() {
  if (document.querySelector("#kasc-ai-chat-style")) return;
  const style = document.createElement("style");
  style.id = "kasc-ai-chat-style";
  style.textContent = AI_CHAT_CSS;
  document.head.append(style);
}

// チャットパネル: 既存マークアップがあればそれを使い、無ければ注入する
function ensureChatDom() {
  if (document.querySelector("#chat-panel")) return;
  ensureAiChatStyle();
  const host = document.createElement("div");
  host.innerHTML = CHAT_PANEL_HTML;
  const panel = host.firstElementChild;
  document.body.append(panel);
  applyI18n(panel);
}

// AI 設定欄: cesium は管理ウィンドウ内の既存マークアップ。
// プレイヤーは設定ウィンドウの #setpane-ai へ注入する
function ensureAiSettingsDom() {
  if (document.querySelector("#chat-provider")) return;
  const pane = document.querySelector("#setpane-ai");
  if (!pane) return;
  pane.innerHTML = AI_SETTINGS_HTML;
  // cesium の manage-subnav と同じく data-manage-sub 指名でサブパネルを切替える
  pane.querySelectorAll(".ai-subnav button[data-manage-sub]").forEach(btn => {
    btn.addEventListener("click", () => {
      pane.querySelectorAll(".ai-subnav button").forEach(item => item.classList.toggle("active", item === btn));
      pane.querySelectorAll(".ai-subpane").forEach(panel => panel.classList.toggle("active", panel.id === btn.dataset.manageSub));
    });
  });
  applyI18n(pane);
}

// capabilities 取得後にブリッジ選択肢・既定プロバイダ・設定欄を再同期する
// （起動時は capabilities 未取得で gemini 表示になっているため）
export function resyncProviderSelect() {
  const providerSelect = document.querySelector("#chat-provider");
  if (!providerSelect) return;
  const wanted = getChatProvider();
  if (providerSelect.querySelector(`option[value="${wanted}"]`)) {
    if (providerSelect.value !== wanted) providerSelect.value = wanted;
    providerSelect.dispatchEvent(new Event("change"));
  }
}

// リモートコマンド経路(local ティアのみ): 外部プロセスが /api/command に POST した
// コマンドをロングポーリングで受信し、チャットツールと同じ経路(executeChatTool)で実行する。
// 実行結果は /api/command/results へ返す。破壊的操作はチャット同様確認ダイアログが出る
export function startRemoteCommandLoop() {
  if (!hasBackendFeature("remoteCommand")) return;
  let remoteCommandSince = 0;
  let remoteCommandInitialized = false;
  const remoteCommandLoop = async () => {
    for (;;) {
      try {
        const res = await fetch(backendUrl(`/api/command?since=${remoteCommandSince}&wait=25`), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        if (!remoteCommandInitialized) {
          // ページ読込前に滞留したコマンドは実行せず、以降の新規分のみ処理する
          remoteCommandSince = Number(data?.latest) || 0;
          remoteCommandInitialized = true;
          continue;
        }
        const results = [];
        for (const cmd of Array.isArray(data?.commands) ? data.commands : []) {
          remoteCommandSince = Math.max(remoteCommandSince, Number(cmd?.id) || 0);
          if (!cmd || typeof cmd.name !== "string") continue;
          try {
            const out = await executeChatTool(cmd.name, cmd.args || {});
            results.push({ id: cmd.id, ok: out?.ok !== false, result: out });
          } catch (error) {
            results.push({ id: cmd.id, ok: false, result: { message: String(error && error.message || error) } });
          }
        }
        if (results.length) {
          await fetch(backendUrl("/api/command/results"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ results }),
          });
        }
      } catch (error) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  };
  void remoteCommandLoop();
}

// capabilities 確定後に行う接続系の初期化一式（ブリッジ選択肢・MCP・リモートコマンド）
export function startAiBackend() {
  updateBridgeProviderOptions();
  resyncProviderSelect();
  updateChatPanelVisibility();
  // MCP 接続基盤。mcpProxy の有無で直叩き→プロキシのフォールバック可否を決める
  initMcp({ hasProxy: () => hasBackendFeature("mcpProxy") });
  initBoxAuth();
  void handleBoxRedirect()
    .then(r => { if (r === "done") console.log("[mcp] Box OAuth 接続が完了しました"); })
    .catch(e => console.error(e));
  void connectEnabledMcpServers();
  startRemoteCommandLoop();
}

// AI チャットのエントリポイント。各エンジンの app.js が起動時に呼ぶ。
// - engine: "cesium" | "maplibre" | "openlayers" | "leaflet"（ツール絞り込み・
//   システム指示の補足に使う）
// - manageBackend: true なら本モジュールが /health + /api/capabilities を取得し
//   MCP/ブリッジ/リモートコマンドの初期化まで行う（プレイヤー系）。
//   cesium は app.js の detectBackend + 起動シーケンスが担うため false
export async function initAiChat({ engine = "cesium", manageBackend = false } = {}) {
  aiEngine = engine || "cesium";
  await initI18n();
  ensureChatDom();
  ensureAiSettingsDom();
  setupChatPanel();
  setupAiSettings();
  setupAgentPanel();
  setupDataSources();
  if (manageBackend) {
    await loadBackendCapabilities();
    startAiBackend();
  }
}

// ---- 汎用 UI ブリッジ公開面（kasugaiApi.listUiControls/controlUi の実体） ----
// アプリ内の操作要素を列挙する。filter は target/label の部分一致
// listUiControls の走査対象文書。data-ui-bridge 属性を持つ同一オリジン iframe
// の文書も含め、その中の要素は target に "#<iframeId>/" 接頭辞が付く
// (クロスオリジン・sandbox iframe は contentDocument に触れないため自動除外)
function uiBridgeDocuments() {
  const docs = [{ doc: document, prefix: "" }];
  for (const f of document.querySelectorAll("iframe[data-ui-bridge][id]")) {
    try {
      const d = f.contentDocument;
      if (d) docs.push({ doc: d, prefix: `#${f.id}/` });
    } catch (_) { /* クロスオリジン・sandbox は除外 */ }
  }
  return docs;
}

export function listUiControls(filter) {
  const q = String(filter || "").toLowerCase().trim();
  const entries = [];
  const seen = new Set();
  for (const { doc, prefix } of uiBridgeDocuments()) {
    for (const el of doc.querySelectorAll("button, input, select, textarea, a[href]")) {
      if (el.type === "hidden") continue;
      if (el.closest(UI_BRIDGE_SKIP_SELECTOR)) continue;
      const entry = uiBridgeEntry(el);
      if (!entry.target) continue;
      if (prefix) entry.target = prefix + entry.target;
      if (seen.has(entry.target)) continue;
      seen.add(entry.target);
      if (q && !`${entry.target} ${entry.label}`.toLowerCase().includes(q)) continue;
      entries.push(entry);
    }
  }
  return entries;
}

// 任意の UI 要素を click/set/get で操作する。set は実ユーザー操作と同じく
// input→change イベントを発火させるため、設定保存・再描画も通常通り走る
export function controlUi(target, { action, value } = {}) {
  // "#<iframeId>/..." で解決した要素は、返す target にも接頭辞を戻す
  // (そのまま再指定できるよう listUiControls と同じ形式に揃える)
  const prefix = /^#[\w-]+\//.exec(String(target || "").trim())?.[0] || "";
  const entryOf = (el, opts) => {
    const e = uiBridgeEntry(el, opts);
    if (prefix && e.target) e.target = prefix + e.target;
    return e;
  };
  const el = resolveUiControlTarget(target);
  if (!el) return { ok: false, message: t("tool.uiTargetNotFound", { target }) };
  const kind = uiBridgeKind(el);
  const tag = el.tagName.toLowerCase();
  const clickKind = kind === "button" || kind === "tab" || tag === "a" || kind === "file" || tag === "label";
  const act = action ? String(action).toLowerCase() : (value !== undefined ? "set" : (clickKind ? "click" : "get"));
  if (act === "get") return { ok: true, ...entryOf(el, { brief: false }) };
  if (act === "click") {
    if (el.disabled) return { ok: false, message: t("tool.uiDisabled", { target }) };
    el.click();
    return { ok: true, ...entryOf(el) };
  }
  if (act !== "set") return { ok: false, message: t("tool.uiBadAction", { action: act, target }) };
  if (kind === "file") return { ok: false, message: t("tool.uiFileInput", { target }) };
  if (el.disabled) return { ok: false, message: t("tool.uiDisabled", { target }) };
  if (el.readOnly) return { ok: false, message: t("tool.uiReadonly", { target }) };
  if (kind === "checkbox" || kind === "radio") {
    const on = typeof value === "boolean" ? value : /^(true|1|on|yes)$/i.test(String(value));
    if (el.checked !== on) {
      el.checked = on;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true, ...entryOf(el) };
  }
  if (kind === "select") {
    const v = String(value ?? "");
    const option = [...el.options].find(o => o.value === v || (o.textContent || "").trim() === v);
    if (!option) {
      return { ok: false, message: t("tool.uiInvalidValue", { value: v, target }), options: [...el.options].slice(0, 60).map(o => ({ value: o.value, label: (o.textContent || "").trim() })) };
    }
    if (el.value !== option.value) {
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true, ...entryOf(el) };
  }
  if (kind === "input" || kind === "range" || kind === "password" || kind === "textarea") {
    el.value = String(value ?? "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, ...entryOf(el) };
  }
  return { ok: false, message: t("tool.uiBadAction", { action: "set", target }) };
}
