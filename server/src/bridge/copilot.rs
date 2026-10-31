// KASUGAI Canvas AIチャット → GitHub Copilot ブリッジ（旧 copilot-bridge/server.mjs の Rust 移植）。
//
// Node 版と違いランタイムを内蔵しない。ユーザーがインストールした
// `copilot` CLI を `copilot --server --stdio --no-auto-update` で子プロセス起動し、
// github-copilot-sdk の外部ストリーム接続（Client::from_streams）で JSON-RPC する。
//
// 地図操作の実実行はブラウザ側が行うため、ここでは Copilot のツール呼び出しを
// actions として収集して返すだけ（ハンドラはスタブ結果を返す）。
// listLayers / getCamera はリクエストに同梱された現在状態から実値を返す。
use super::common::{
    self, authorized, build_prompt, env_u64, normalize_tool_decls, request_model, request_project,
    ToolDecl,
};
use github_copilot_sdk::tool::{try_tool_parameters, ToolHandler};
use github_copilot_sdk::types::{
    CustomAgentConfig, MessageOptions, SessionEvent, SystemMessageConfig, Tool, ToolInvocation,
    ToolResult,
};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::{Client, Error as SdkError, SessionConfig};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::process::Child;
use tokio::sync::Mutex;

fn model_default() -> String {
    std::env::var("COPILOT_BRIDGE_MODEL").unwrap_or_else(|_| "gpt-5".to_string())
}
fn send_timeout() -> Duration {
    Duration::from_millis(env_u64("COPILOT_BRIDGE_TIMEOUT_MS", 110000))
}
fn token() -> String {
    std::env::var("COPILOT_BRIDGE_TOKEN").unwrap_or_default()
}

// listModels() が空を返すランタイム/アカウント向けの既知モデル一覧
const FALLBACK_MODELS: &[&str] = &[
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4o",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "claude-sonnet-4",
    "claude-opus-4.1",
    "gemini-2.5-pro",
];

// ツール呼び出しをキューへ積むだけのハンドラ（実実行はブラウザ）
struct QueueCtx {
    pending: Vec<Value>,
    state: Value,
}

struct QueueTool {
    ctx: Arc<StdMutex<QueueCtx>>,
}

#[async_trait::async_trait]
impl ToolHandler for QueueTool {
    async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
        let mut ctx = match self.ctx.lock() {
            Ok(c) => c,
            Err(_) => return Ok(ToolResult::Text("{}".to_string())),
        };
        if let Some(v) = common::local_state_tool(&invocation.tool_name, &ctx.state) {
            return Ok(ToolResult::Text(v.to_string()));
        }
        ctx.pending.push(json!({
            "name": invocation.tool_name,
            "args": invocation.arguments,
        }));
        Ok(ToolResult::Text(
            json!({
                "queued": true,
                "note": "Action queued; it runs in the browser after your reply and the real result is delivered back to you in the next turn.",
            })
            .to_string(),
        ))
    }
}

struct CopilotSession {
    session: Session,
    ctx: Arc<StdMutex<QueueCtx>>,
    tools_sig: String,
    seeded: bool,
    model: String,
}

#[derive(Default)]
struct CopilotInner {
    client: Option<Client>,
    // SDK は外部ストリーム接続では子プロセスを所有しないため、
    // こちらで保持して終了時に kill する
    child: Option<Child>,
    sessions: HashMap<String, CopilotSession>,
}

pub struct CopilotBridge {
    inner: Mutex<CopilotInner>,
}

// copilot CLI の探索順。COPILOT_CLI_PATH > PATH 上の copilot > npm グローバルの cmd shim
// 返り値は (プログラム, 前置引数)。cmd shim は "cmd /c copilot ..." として起動する
fn cli_candidates() -> Vec<(String, Vec<String>)> {
    let mut list: Vec<(String, Vec<String>)> = Vec::new();
    if let Ok(p) = std::env::var("COPILOT_CLI_PATH") {
        if !p.is_empty() {
            list.push((p, Vec::new()));
        }
    }
    // ハブの自動セットアップ(/setup・--setup)が配置した管理コピー
    let managed = common::managed_cli("copilot");
    if managed.is_file() {
        list.push((managed.to_string_lossy().to_string(), Vec::new()));
    }
    // プロセス環境＋レジストリの最新 PATH で解決した絶対パス。
    // 直後インストール(winget/npm)も常駐プロセスから拾える
    if let Some(p) = common::find_executable("copilot") {
        list.push((p.to_string_lossy().to_string(), Vec::new()));
    }
    #[cfg(windows)]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        // winget install GitHub.Copilot の shim 置き場
        let shim = PathBuf::from(&local)
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join("copilot.exe");
        if shim.is_file() {
            list.push((shim.to_string_lossy().to_string(), Vec::new()));
        }
    }
    // PATH 解決に任せる直接起動（CreateProcess は .exe は補うが .cmd は解決しない）
    list.push(("copilot.exe".to_string(), Vec::new()));
    list.push(("copilot".to_string(), Vec::new()));
    #[cfg(windows)]
    {
        // npm i -g @github/copilot は %APPDATA%\npm\copilot.cmd の shim を置く。
        // .cmd は直接 spawn できないため cmd /c 経由にする
        if let Ok(appdata) = std::env::var("APPDATA") {
            let shim = PathBuf::from(&appdata).join("npm").join("copilot.cmd");
            if shim.is_file() {
                list.push((
                    "cmd.exe".to_string(),
                    vec!["/c".to_string(), shim.to_string_lossy().to_string()],
                ));
            }
        }
        list.push((
            "cmd.exe".to_string(),
            vec!["/c".to_string(), "copilot".to_string()],
        ));
    }
    #[cfg(not(windows))]
    {
        list.push((
            "sh".to_string(),
            vec!["-c".to_string(), "copilot \"$@\"".to_string(), "copilot".to_string()],
        ));
    }
    list
}

// GitHub CLI (gh) が認証済みならトークンを取得する
// （copilot CLI の TUI /login を省略するための自動認証用）
fn gh_auth_token() -> Option<String> {
    std::process::Command::new("gh")
        .args(["auth", "token"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        })
}

impl CopilotBridge {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CopilotInner::default()),
        }
    }

    // /health 表示用: CLI 接続済みか（ロック競合時は true 扱いで様子見）
    pub fn running(&self) -> bool {
        self.inner
            .try_lock()
            .map(|i| i.client.is_some())
            .unwrap_or(true)
    }

    pub fn check_auth(&self, headers: &axum::http::HeaderMap) -> bool {
        authorized(&token(), headers)
    }

    // copilot CLI を spawn して外部ストリーム接続を確立する。
    // 候補を順に試し、spawn 失敗とハンドシェイク失敗の両方で次へ進む
    async fn ensure_client(
        inner: &mut CopilotInner,
    ) -> Result<Client, String> {
        if let Some(c) = &inner.client {
            return Ok(c.clone());
        }
        let workdir = common::workdir("copilot");
        // GitHub CLI (gh) が認証済みなら token を環境変数で渡し、copilot の
        // TUI /login を省略して自動認証する（devin の PKCE 自動認証相当）。
        // 既に COPILOT_GITHUB_TOKEN/GH_TOKEN が設定済みなら spawn に自動継承される
        let gh_tok = if std::env::var("COPILOT_GITHUB_TOKEN").is_ok()
            || std::env::var("GH_TOKEN").is_ok() { None } else { gh_auth_token() };
        let mut last_err = String::from("copilot CLI が見つかりません（COPILOT_CLI_PATH でインストール先を指定してください）");
        for (program, prefix) in cli_candidates() {
            let mut cmd = common::new_command(&program);
            cmd.args(&prefix)
                .args(["--server", "--stdio", "--no-auto-update"])
                .current_dir(&workdir)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            if let Some(tok) = &gh_tok {
                cmd.env("COPILOT_GITHUB_TOKEN", tok).env("GH_TOKEN", tok);
            }
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let Some(stdout) = child.stdout.take() else { continue };
            let Some(stdin) = child.stdin.take() else { continue };
            // stderr は捨てずにログへ流す（診断用）
            if let Some(stderr) = child.stderr.take() {
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if common::env_flag("COPILOT_BRIDGE_DEBUG") {
                            eprintln!("[copilot] {}", &line.chars().take(400).collect::<String>());
                        }
                    }
                });
            }
            let client = match Client::from_streams(stdout, stdin, workdir.clone()) {
                Ok(c) => c,
                Err(e) => {
                    let _ = child.kill().await;
                    last_err = format!("copilot client 構築に失敗: {e}");
                    continue;
                }
            };
            match tokio::time::timeout(Duration::from_secs(30), client.verify_protocol_version())
                .await
            {
                Ok(Ok(())) => {
                    inner.client = Some(client.clone());
                    inner.child = Some(child);
                    eprintln!("bridge: copilot CLI connected: {program}");
                    return Ok(client);
                }
                Ok(Err(e)) => {
                    last_err = format!("copilot protocol handshake に失敗 ({program}): {e}");
                    let _ = child.kill().await;
                }
                Err(_) => {
                    last_err = format!("copilot protocol handshake がタイムアウト ({program})");
                    let _ = child.kill().await;
                }
            }
        }
        Err(last_err)
    }

    // プロジェクトごとのセッションを保持する。ツール構成・モデルが変われば
    // setTools/setModel を試み、ダメなら作り直す（旧 server.mjs と同じ流儀）
    async fn get_session(
        &self,
        inner: &mut CopilotInner,
        project: &str,
        decls: &[ToolDecl],
        model: &str,
    ) -> Result<(), String> {
        let sig = serde_json::to_string(&decls.iter().map(|d| &d.name).collect::<Vec<_>>())
            .unwrap_or_default();
        // 要求モデルがセッションと違えば切り替える
        if let Some(entry) = inner.sessions.get_mut(project) {
            if entry.model != model {
                match entry.session.set_model(model, None).await {
                    Ok(()) => entry.model = model.to_string(),
                    Err(_) => {
                        let _ = entry.session.disconnect().await;
                        inner.sessions.remove(project);
                    }
                }
            }
        }
        if inner
            .sessions
            .get(project)
            .is_some_and(|e| e.tools_sig == sig)
        {
            return Ok(());
        }
        if let Some(entry) = inner.sessions.get_mut(project) {
            // ツール構成が変わった場合は差し替えを試み、ダメならセッションを作り直す
            let defs = build_tool_defs(decls, entry.ctx.clone());
            match entry.session.set_tools(defs).await {
                Ok(()) => {
                    entry.tools_sig = sig;
                    return Ok(());
                }
                Err(_) => {
                    let _ = entry.session.disconnect().await;
                    inner.sessions.remove(project);
                }
            }
        }
        let ctx = Arc::new(StdMutex::new(QueueCtx {
            pending: Vec::new(),
            state: Value::Null,
        }));
        let tool_defs = build_tool_defs(decls, ctx.clone());
        let session = create_session_with_fallback(
            inner.client.as_ref().ok_or("copilot client not started")?,
            tool_defs,
            decls,
            model,
        )
        .await
        .map_err(|e| format!("copilot session 作成に失敗: {e}"))?;
        inner.sessions.insert(
            project.to_string(),
            CopilotSession {
                session,
                ctx,
                tools_sig: sig,
                seeded: false,
                model: model.to_string(),
            },
        );
        Ok(())
    }

    pub async fn agent(&self, body: &Value) -> Result<Value, String> {
        let decls = normalize_tool_decls(body.get("tools").unwrap_or(&Value::Null));
        let project = request_project(body);
        let model = request_model(body, &model_default());
        let mut inner = self.inner.lock().await;
        Self::ensure_client(&mut inner).await?;
        self.get_session(&mut inner, &project, &decls, &model).await?;
        let entry = inner.sessions.get_mut(&project).ok_or("session not found")?;
        if let Ok(mut ctx) = entry.ctx.lock() {
            ctx.pending = Vec::new();
            ctx.state = json!({
                "layers": body.get("layers").cloned().unwrap_or(Value::Null),
                "camera": body.get("camera").cloned().unwrap_or(Value::Null),
                "basemaps": body.get("basemaps").cloned().unwrap_or(Value::Null),
            });
        }
        let prompt = build_prompt(body, entry.seeded, false);
        let mut opts = MessageOptions::new(prompt);
        opts.wait_timeout = Some(send_timeout());
        let result = entry.session.send_and_wait(opts).await;
        let event = match result {
            Ok(e) => e,
            Err(e) => {
                // 送受信に失敗したセッションは再利用せず破棄（次回リクエストで作り直す）
                if let Some(entry) = inner.sessions.remove(&project) {
                    let _ = entry.session.disconnect().await;
                }
                return Err(format!("copilot への送信に失敗: {e}"));
            }
        };
        let entry = inner.sessions.get_mut(&project).ok_or("session lost")?;
        entry.seeded = true;
        let reply = event
            .as_ref()
            .map(reply_text)
            .unwrap_or_default();
        let actions = entry
            .ctx
            .lock()
            .map(|c| c.pending.clone())
            .unwrap_or_default();
        Ok(json!({ "reply": reply, "actions": actions }))
    }

    pub async fn models(&self) -> Value {
        let mut inner = self.inner.lock().await;
        let client = match Self::ensure_client(&mut inner).await {
            Ok(c) => c,
            Err(e) => {
                return json!({ "models": [], "error": e });
            }
        };
        // listModels が稀に応答しなくなることがあるためタイムアウトをかける。
        // ハングするとハブの直列キューを占有し /agent も含め全要求が滞留する
        let list = match tokio::time::timeout(Duration::from_secs(20), client.list_models()).await {
            Ok(Ok(list)) => list,
            Ok(Err(e)) => return json!({ "models": [], "error": e.to_string() }),
            Err(_) => return json!({ "models": [], "error": "listModels timed out" }),
        };
        let mut models: Vec<Value> = list
            .iter()
            .filter_map(|m| {
                let v = serde_json::to_value(m).ok()?;
                let id = v
                    .get("id")
                    .or_else(|| v.get("modelId"))
                    .and_then(|x| x.as_str())
                    .or_else(|| v.as_str())?;
                Some(json!({
                    "id": id,
                    "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(id),
                }))
            })
            .collect();
        if models.is_empty() {
            // CLI がモデル一覧を返さない（未ログイン等）場合の既定一覧。
            // 実在する一覧のふりをしないよう fallback フラグを付け、
            // フロント側は「取得失敗」として扱う
            models = FALLBACK_MODELS
                .iter()
                .map(|id| json!({ "id": id, "name": id }))
                .collect();
            return json!({ "models": models, "fallback": true });
        }
        json!({ "models": models })
    }

    pub fn session_count(&self) -> usize {
        // ロックの邪魔をしないよう try_lock ベース（/health 表示用）
        self.inner
            .try_lock()
            .map(|i| i.sessions.len())
            .unwrap_or(0)
    }

    pub async fn shutdown(&self) {
        let mut inner = self.inner.lock().await;
        for (_, entry) in inner.sessions.drain() {
            let _ = entry.session.disconnect().await;
        }
        if let Some(c) = inner.client.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), c.stop()).await;
        }
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill().await;
        }
    }
}

// セッションイベントから assistant の本文を取り出す
fn reply_text(event: &SessionEvent) -> String {
    event
        .data
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn build_tool_defs(decls: &[ToolDecl], ctx: Arc<StdMutex<QueueCtx>>) -> Vec<Tool> {
    decls
        .iter()
        .map(|d| {
            let mut tool = Tool::default();
            tool.name = d.name.clone();
            tool.description = d.description.clone();
            tool.parameters =
                try_tool_parameters(d.parameters.clone()).unwrap_or_default();
            // ハンドラはキューに積むだけ（実実行はブラウザ）。副作用がないため権限確認も不要
            tool.skip_permission = true;
            tool.with_handler(Arc::new(QueueTool { ctx: ctx.clone() }))
        })
        .collect()
}

async fn create_session_with_fallback(
    client: &Client,
    tool_defs: Vec<Tool>,
    decls: &[ToolDecl],
    model: &str,
) -> Result<Session, SdkError> {
    let base = || {
        let mut cfg = SessionConfig::default()
            .with_model(model)
            .with_permission_handler(Arc::new(
                github_copilot_sdk::handler::ApproveAllHandler,
            ))
            .with_working_directory(common::workdir("copilot"));
        cfg.tools = Some(tool_defs.clone());
        let mut sm = SystemMessageConfig::default();
        sm.mode = Some("append".to_string());
        sm.content = Some(common::SYSTEM_PROMPT.to_string());
        cfg = cfg.with_system_message(sm);
        cfg
    };
    // 利用可能ならカスタムエージェントでツールを地図操作のみに限定する
    // （ビルトインのファイル/シェルツールをモデルに見せない）。未対応ランタイムでは握りつぶす
    let mut cfg = base();
    let mut agent_cfg = CustomAgentConfig::default();
    agent_cfg.name = "kasugai-map".to_string();
    agent_cfg.display_name = Some("KASUGAI Map Operator".to_string());
    agent_cfg.description =
        Some("Operates the KASUGAI Canvas map via registered tools".to_string());
    agent_cfg.tools = Some(decls.iter().map(|d| d.name.clone()).collect());
    agent_cfg.prompt = common::SYSTEM_PROMPT.to_string();
    cfg.custom_agents = Some(vec![agent_cfg]);
    cfg.agent = Some("kasugai-map".to_string());
    match client.create_session(cfg).await {
        Ok(s) => Ok(s),
        Err(e) => {
            eprintln!("bridge: copilot customAgents 未対応のため通常セッションへフォールバック: {e}");
            client.create_session(base()).await
        }
    }
}
