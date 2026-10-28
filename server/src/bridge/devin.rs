// KASUGAI Canvas AIチャット → Devin CLI (devin acp) ブリッジ（旧 devin-bridge/server.mjs の Rust 移植）。
//
// アプリの「外部エージェント」プロトコルを、Devin CLI の ACP
// （Agent Client Protocol / stdio NDJSON-RPC）セッションへ翻訳する。
//
// 地図操作ツールは MCP (streamable HTTP) で Devin に注入する:
// ハブ側が /mcp/<project> で MCP サーバーを兼ね、session/new の
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
use super::common::{
    self, authorized, build_prompt, env_flag, env_u64, normalize_tool_decls, prepare_mcp_state,
    request_model, request_project, take_pending, workdir, McpShared, ToolDecl,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

fn model_default() -> String {
    std::env::var("DEVIN_BRIDGE_MODEL").unwrap_or_default()
}
fn send_timeout_ms() -> u64 {
    env_u64("DEVIN_BRIDGE_TIMEOUT_MS", 110000)
}
fn token() -> String {
    std::env::var("DEVIN_BRIDGE_TOKEN").unwrap_or_default()
}
fn debug() -> bool {
    env_flag("DEVIN_BRIDGE_DEBUG")
}

// ---- ACP クライアント（devin acp 子プロセスを NDJSON で駆動） ----

struct AcpInner {
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    ready: AtomicBool,
    dead: AtomicBool,
    auth_methods: Mutex<Vec<Value>>,
    model_options: Mutex<Vec<Value>>,
    turn_text: Mutex<HashMap<String, Vec<String>>>,
    session_model: Mutex<HashMap<String, String>>,
    context_by_model: Mutex<HashMap<String, Value>>,
    last_usage: Mutex<Option<Value>>,
    auth_error: Mutex<Option<String>>,
    // 権限要求が kasugai MCP ツールかを判定するための登録済みツール名
    tool_names: StdMutex<HashSet<String>>,
}

struct Acp {
    inner: Arc<AcpInner>,
    child: Mutex<Child>,
}

impl Acp {
    // devin acp を起動し stdout リーダータスクを回す。失敗時 Err
    async fn start(bin: &str) -> Result<Self, String> {
        let mut args = vec!["acp".to_string()];
        let model = model_default();
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model);
        }
        let mut cmd = common::new_command(bin);
        cmd.args(&args)
            .current_dir(workdir("devin"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("devin acp spawn failed ({bin}): {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "devin acp stdout が取れません".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "devin acp stdin が取れません".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    // Devin 側のエラー等を拾う。INFO 系の定常ログは DEBUG 時のみ出力
                    if debug()
                        || line.to_lowercase().contains("error")
                        || line.to_lowercase().contains("warn")
                        || line.to_lowercase().contains("mcp")
                    {
                        eprintln!("[acp] {}", &line.chars().take(400).collect::<String>());
                    }
                }
            });
        }
        let inner = Arc::new(AcpInner {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            ready: AtomicBool::new(false),
            dead: AtomicBool::new(false),
            auth_methods: Mutex::new(Vec::new()),
            model_options: Mutex::new(Vec::new()),
            turn_text: Mutex::new(HashMap::new()),
            session_model: Mutex::new(HashMap::new()),
            context_by_model: Mutex::new(HashMap::new()),
            last_usage: Mutex::new(None),
            auth_error: Mutex::new(None),
            tool_names: StdMutex::new(HashSet::new()),
        });
        // stdout リーダー: 行ごとの NDJSON をディスパッチ。EOF で dead にし
        // 保留中の全 RPC を失敗させる
        let reader_inner = inner.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let s = line.trim();
                        if !s.is_empty() {
                            Self::on_message(&reader_inner, s).await;
                        }
                    }
                    _ => break,
                }
            }
            reader_inner.ready.store(false, Ordering::SeqCst);
            reader_inner.dead.store(true, Ordering::SeqCst);
            let mut pending = reader_inner.pending.lock().await;
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err("devin acp process exited".to_string()));
            }
            eprintln!("[bridge] devin acp exited; 次の要求で再起動します");
        });
        Ok(Self {
            inner,
            child: Mutex::new(child),
        })
    }

    async fn on_message(inner: &Arc<AcpInner>, line: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return;
        };
        // サーバ→クライアントの要求（id + method）: 権限確認など
        if msg.get("id").is_some() && msg.get("method").is_some() {
            Self::handle_server_request(inner, &msg).await;
            return;
        }
        // 要求への応答
        if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
            if msg.get("result").is_some() || msg.get("error").is_some() {
                let tx = inner.pending.lock().await.remove(&id);
                if let Some(tx) = tx {
                    if let Some(err) = msg.get("error") {
                        let msg_text = err
                            .get("message")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| err.to_string());
                        let _ = tx.send(Err(msg_text));
                    } else {
                        let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
                return;
            }
        }
        // 通知
        if msg.get("method").is_some() {
            Self::handle_notify(inner, &msg).await;
        }
    }

    async fn send(inner: &Arc<AcpInner>, obj: Value) {
        let mut stdin = inner.stdin.lock().await;
        let mut line = serde_json::to_string(&obj).unwrap_or_default();
        line.push('\n');
        let _ = stdin.write_all(line.as_bytes()).await;
        let _ = stdin.flush().await;
    }

    async fn handle_server_request(inner: &Arc<AcpInner>, msg: &Value) {
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let reply = |inner: &Arc<AcpInner>, result: Value| {
            let inner = inner.clone();
            let id = id.clone();
            async move {
                Self::send(&inner, json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
            }
        };
        let reply_error = |inner: &Arc<AcpInner>, code: i64, message: String| {
            let inner = inner.clone();
            let id = id.clone();
            async move {
                Self::send(
                    &inner,
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
                )
                .await;
            }
        };
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        if method == "session/request_permission" {
            let params = msg.get("params").cloned().unwrap_or(json!({}));
            let options = params
                .get("options")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let tool_name = permission_tool_name(inner, params.get("toolCall"));
            let is_map_tool = !tool_name.is_empty()
                && (tool_name.starts_with("kasugai")
                    || tool_names(inner).contains(&tool_name)
                    || tool_name.to_lowercase().contains("kasugai"));
            let pick = |kinds: &[&str]| -> Option<String> {
                options
                    .iter()
                    .find(|o| {
                        o.get("kind")
                            .and_then(|k| k.as_str())
                            .is_some_and(|k| kinds.contains(&k))
                    })
                    .and_then(|o| o.get("optionId").and_then(|v| v.as_str()).map(String::from))
            };
            if is_map_tool {
                // 地図操作のみ許可。allow_always があれば以降の往復を減らせる
                let id = pick(&["allow_always", "allow_once"])
                    .or_else(|| {
                        options
                            .first()
                            .and_then(|o| o.get("optionId").and_then(|v| v.as_str()).map(String::from))
                    });
                if let Some(id) = id {
                    return reply(inner, json!({ "outcome": { "outcome": "selected", "optionId": id } }))
                        .await;
                }
                return reply(inner, json!({ "outcome": { "outcome": "cancelled" } })).await;
            }
            // kasugai 以外（ファイル・シェル等の内蔵ツール）は拒否する
            if let Some(id) = pick(&["reject_once", "reject_always"]) {
                return reply(inner, json!({ "outcome": { "outcome": "selected", "optionId": id } }))
                    .await;
            }
            return reply(inner, json!({ "outcome": { "outcome": "cancelled" } })).await;
        }
        // fs/terminal 等のクライアント側要求は未対応として拒否
        reply_error(inner, -32601, format!("unsupported client method: {method}")).await;
    }

    async fn handle_notify(inner: &Arc<AcpInner>, msg: &Value) {
        if msg.get("method").and_then(|v| v.as_str()) != Some("session/update") {
            return;
        }
        let p = msg.get("params").cloned().unwrap_or(json!({}));
        let u = p.get("update").cloned().unwrap_or(json!({}));
        let session_id = p.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
        if u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agent_message_chunk")
            && u.pointer("/content/type").and_then(|v| v.as_str()) == Some("text")
        {
            let text = u
                .pointer("/content/text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if let Some(arr) = inner.turn_text.lock().await.get_mut(session_id) {
                arr.push(text);
            }
            return;
        }
        // usage_update: {size: コンテキスト総量, used: 使用量, cost?}
        // 実測値をモデルに紐付けて /models の context 表示に使う
        if u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("usage_update") {
            let usage = json!({
                "used": u.get("used").cloned().unwrap_or(Value::Null),
                "size": u.get("size").cloned().unwrap_or(Value::Null),
                "cost": u.get("cost").cloned().unwrap_or(Value::Null),
            });
            *inner.last_usage.lock().await = Some(usage.clone());
            let model = inner.session_model.lock().await.get(session_id).cloned();
            if let Some(model) = model {
                if usage.get("size").is_some_and(|v| !v.is_null()) {
                    inner
                        .context_by_model
                        .lock()
                        .await
                        .insert(model, usage.get("size").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }

    async fn rpc(inner: &Arc<AcpInner>, method: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
        if inner.dead.load(Ordering::SeqCst) {
            return Err("devin acp is not running".to_string());
        }
        let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        inner.pending.lock().await.insert(id, tx);
        Self::send(
            inner,
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .await;
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("devin acp channel closed".to_string()),
            Err(_) => {
                inner.pending.lock().await.remove(&id);
                Err(format!("{method} timed out"))
            }
        }
    }

    // initialize + 必要なら authenticate（api_key 優先・なければブラウザ PKCE）
    async fn ensure_ready(&self, api_key: &str) -> Result<(), String> {
        if self.inner.ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        let init = Self::rpc(
            &self.inner,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
                "clientInfo": { "name": "kasugai-devin-bridge", "version": "1.0.0" },
            }),
            30000,
        )
        .await?;
        let auth_methods = init
            .get("authMethods")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        *self.inner.auth_methods.lock().await = auth_methods.clone();
        if !auth_methods.is_empty() {
            let method_id = auth_methods[0].get("id").cloned().unwrap_or(Value::Null);
            let result = if !api_key.is_empty() {
                Self::rpc(
                    &self.inner,
                    "authenticate",
                    json!({ "methodId": method_id, "_meta": { "api_key": api_key } }),
                    30000,
                )
                .await
            } else {
                // ブラウザ PKCE フロー（利用者のマシンでブラウザが開く）。
                // フロー完了まで時間がかかることがあるため長めに待つ
                Self::rpc(
                    &self.inner,
                    "authenticate",
                    json!({ "methodId": method_id }),
                    180000,
                )
                .await
            };
            // authenticate は資格の受理後の後段処理（team settings 取得等）でも
            // 失敗し得る（個人プランのアカウントで Permission denied になる等）。
            // 資格自体が生きている可能性があるため session/new まで進めてみる。
            // 失敗時に根本原因を報告できるようエラーを保持しておく
            if let Err(e) = result {
                *self.inner.auth_error.lock().await = Some(e.clone());
                eprintln!("[bridge] authenticate に失敗しましたが継続します: {e}");
            }
        }
        self.inner.ready.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn tool_names(inner: &Arc<AcpInner>) -> std::sync::MutexGuard<'_, HashSet<String>> {
    inner.tool_names.lock().unwrap_or_else(|e| e.into_inner())
}

// 権限要求が kasugai MCP ツールかを判定する
fn permission_tool_name(inner: &Arc<AcpInner>, tool_call: Option<&Value>) -> String {
    let Some(tc) = tool_call else { return String::new() };
    let cand = [
        tc.get("title").and_then(|v| v.as_str()),
        tc.get("kind").and_then(|v| v.as_str()),
        tc.get("toolCallId").and_then(|v| v.as_str()),
    ];
    for c in cand.into_iter().flatten() {
        if c.to_lowercase().contains("kasugai") {
            return c.to_string();
        }
    }
    // タイトル等が "kasugai/flyTo"・"flyTo"・"mcp__kasugai__flyTo" 等で来る想定
    let names = tool_names(inner);
    for c in [
        tc.get("title").and_then(|v| v.as_str()),
        tc.get("kind").and_then(|v| v.as_str()),
        tc.get("toolCallId").and_then(|v| v.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        let tail = c.rsplit(['/', '_', ':', '.']).next().unwrap_or("");
        if names.contains(c) || names.contains(tail) {
            return c.to_string();
        }
    }
    String::new()
}

// Devin CLI の探索順。DEVIN_CLI_PATH > 前回成功パス > PATH 上の devin > 代表的なインストール先
fn devin_bin_candidates() -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("DEVIN_CLI_PATH") {
        if !p.is_empty() {
            list.push(p);
        }
    }
    // 前回起動に成功した devin バイナリのパスをキャッシュする
    let cache = workdir("devin").join("acp-bin.txt");
    if let Ok(p) = std::fs::read_to_string(&cache) {
        let p = p.trim().to_string();
        if !p.is_empty() && PathBuf::from(&p).is_file() {
            list.push(p);
        }
    }
    list.push(if cfg!(windows) { "devin.exe" } else { "devin" }.to_string());
    list.push("devin".to_string());
    if cfg!(windows) {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            list.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("Devin")
                    .join("resources")
                    .join("app")
                    .join("extensions")
                    .join("windsurf")
                    .join("devin")
                    .join("bin")
                    .join("devin.exe")
                    .to_string_lossy()
                    .to_string(),
            );
        }
    } else if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        list.push(home.join(".local").join("bin").join("devin").to_string_lossy().to_string());
        list.push("/usr/local/bin/devin".to_string());
        list.push("/opt/homebrew/bin/devin".to_string());
    }
    // 重複と「存在しない絶対パス」の候補は除外する（spawn 失敗を待つ時間を省く）
    let mut seen = HashSet::new();
    list.into_iter()
        .filter(|b| seen.insert(b.clone()))
        .filter(|b| !PathBuf::from(b).is_absolute() || PathBuf::from(b).exists())
        .collect()
}

fn remember_bin(bin: &str) {
    let _ = std::fs::write(workdir("devin").join("acp-bin.txt"), bin);
}

struct DevinSession {
    session_id: String,
    tools_sig: String,
    seeded: bool,
    model: String,
}

pub struct DevinBridge {
    // Devin APIキー。環境変数のほか、ブラウザ設定画面から X-Devin-Api-Key
    // ヘッダで届いた値も使う（後者はリクエストごとに更新・キー変化で acp を再認証）
    api_key: StdMutex<String>,
    acp: Mutex<Option<Arc<Acp>>>,
    sessions: StdMutex<HashMap<String, DevinSession>>,
    hub_port: u16,
    // /agent 処理の直列化（同一セッションへの同時 prompt 防止）
    queue: Mutex<()>,
    // /models 用の acp 起動・モデル一覧取得の多重実行防止
    models_warmup: Mutex<bool>,
    // 直近の起動・認証失敗理由（アプリ側の「未接続」表示の詳細に使う）
    last_warmup_error: StdMutex<String>,
}

impl DevinBridge {
    pub fn new(hub_port: u16) -> Self {
        Self {
            api_key: StdMutex::new(std::env::var("DEVIN_API_KEY").unwrap_or_default()),
            acp: Mutex::new(None),
            sessions: StdMutex::new(HashMap::new()),
            hub_port,
            queue: Mutex::new(()),
            models_warmup: Mutex::new(false),
            last_warmup_error: StdMutex::new(String::new()),
        }
    }

    pub fn check_auth(&self, headers: &axum::http::HeaderMap) -> bool {
        authorized(&token(), headers)
    }

    // ブラウザ設定画面から届いた APIキー（X-Devin-Api-Key ヘッダ）を取り込む。
    // キーが変化した場合は devin acp 子プロセスを再起動して新しいキーで
    // 認証し直す（ACP の資格はプロセス存続中のみ有効なため）
    async fn capture_api_key(&self, headers: &axum::http::HeaderMap) {
        let Some(h) = headers.get("x-devin-api-key").and_then(|v| v.to_str().ok()) else {
            return;
        };
        let key = h.trim().to_string();
        let changed = {
            let mut cur = self.api_key.lock().unwrap_or_else(|e| e.into_inner());
            if *cur == key {
                false
            } else {
                *cur = key.clone();
                true
            }
        };
        if changed {
            eprintln!(
                "[bridge] Devin APIキーを{}しました。次の要求で devin acp を再認証します",
                if key.is_empty() { "クリア" } else { "更新" }
            );
            let old = self.acp.lock().await.take();
            if let Some(acp) = old {
                if let Ok(mut child) = acp.child.try_lock() {
                    let _ = child.kill().await;
                }
            }
        }
    }

    pub fn running(&self) -> bool {
        self.acp
            .try_lock()
            .map(|a| a.is_some())
            .unwrap_or(true)
    }

    async fn get_acp(&self) -> Result<Arc<Acp>, String> {
        {
            let guard = self.acp.lock().await;
            if let Some(a) = guard.as_ref() {
                if a.inner.ready.load(Ordering::SeqCst) && !a.inner.dead.load(Ordering::SeqCst) {
                    return Ok(a.clone());
                }
            }
        }
        let api_key = self
            .api_key
            .lock()
            .map(|k| k.clone())
            .unwrap_or_default();
        // バイナリ未検出（spawn ENOENT 等）は探索ノイズなので、実際に起動できた
        // 候補の失敗（認証エラー等）があればそちらを優先して報告する
        let mut last_err = String::new();
        let mut real_err: Option<String> = None;
        for bin in devin_bin_candidates() {
            match Acp::start(&bin).await {
                Ok(acp) => {
                    match acp.ensure_ready(&api_key).await {
                        Ok(()) => {
                            remember_bin(&bin);
                            eprintln!("[bridge] devin acp connected: {bin}");
                            let acp = Arc::new(acp);
                            // acp プロセスが差し替わると旧 sessionId は無効になる
                            // （旧 server.mjs はプロセス終了時に sessions.clear() していた）
                            if let Ok(mut sessions) = self.sessions.lock() {
                                sessions.clear();
                            }
                            *self.acp.lock().await = Some(acp.clone());
                            return Ok(acp);
                        }
                        Err(e) => {
                            last_err = e.clone();
                            real_err = real_err.or(Some(e));
                            if let Ok(mut child) = acp.child.try_lock() {
                                let _ = child.kill().await;
                            }
                        }
                    }
                }
                Err(e) => last_err = e,
            }
        }
        let has_real = real_err.is_some();
        let err = real_err.unwrap_or(last_err);
        let hint = if !has_real {
            "。devin CLI が見つかりません（DEVIN_CLI_PATH でインストール先を指定してください）"
        } else {
            ""
        };
        Err(format!("devin acp への接続に失敗しました: {err}{hint}"))
    }

    async fn get_session(
        &self,
        acp: &Arc<Acp>,
        project: &str,
        decls: &[ToolDecl],
        model: &str,
    ) -> Result<String, String> {
        let sig = serde_json::to_string(&decls.iter().map(|d| &d.name).collect::<Vec<_>>())
            .unwrap_or_default();
        let want_model = if model.is_empty() { model_default() } else { model.to_string() };
        // (session_id, seeded) を返すのではなく内部で再利用判定し、再利用なら None
        let existing = self
            .sessions
            .lock()
            .map(|s| s.get(project).map(|e| (e.session_id.clone(), e.tools_sig.clone(), e.model.clone())))
            .unwrap_or(None);
        if let Some((sid, tsig, m)) = &existing {
            if *tsig == sig && (want_model.is_empty() || *m == want_model) {
                return Ok(sid.clone());
            }
        }
        let params = json!({
            "cwd": workdir("devin"),
            "mcpServers": [{
                "type": "http",
                "name": "kasugai",
                "url": format!("http://127.0.0.1:{}/mcp/{}", self.hub_port, urlencoding(project)),
                "headers": [],
            }],
        });
        let res = match Acp::rpc(&acp.inner, "session/new", params, 60000).await {
            Ok(r) => r,
            Err(e) => {
                // authenticate 失敗を継続した経路でここが失敗した場合、根本原因
                // （認証エラー）を優先して報告する
                let auth_err = acp.inner.auth_error.lock().await.clone();
                if let Some(ae) = auth_err {
                    return Err(format!("{e}（認証時エラー: {ae}）"));
                }
                return Err(e);
            }
        };
        let session_id = res
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "session/new returned no sessionId".to_string())?
            .to_string();
        acp.inner
            .turn_text
            .lock()
            .await
            .insert(session_id.clone(), Vec::new());
        // モデル一覧を /models 応答用に拾う。ACP の configOptions（新形式）と
        // session/new の models.availableModels（標準形式）の両方を見る
        let opts = res
            .get("configOptions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let model_opt = opts.iter().find(|o| {
            o.get("id").and_then(|v| v.as_str()) == Some("model")
                || o.get("category").and_then(|v| v.as_str()) == Some("model")
        });
        let from_options: Vec<Value> = model_opt
            .and_then(|o| o.get("options"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|o| {
                        let id = o
                            .get("value")
                            .or_else(|| o.get("id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let name = o
                            .get("name")
                            .or_else(|| o.get("value"))
                            .or_else(|| o.get("id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or(id);
                        json!({ "id": id, "name": name })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let from_models: Vec<Value> = res
            .pointer("/models/availableModels")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|m| {
                        let id = m
                            .get("modelId")
                            .or_else(|| m.get("id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let name = m
                            .get("name")
                            .or_else(|| m.get("modelId"))
                            .or_else(|| m.get("id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or(id);
                        json!({ "id": id, "name": name })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut seen = HashSet::new();
        let merged: Vec<Value> = from_options
            .into_iter()
            .chain(from_models)
            .filter(|m| {
                m.get("id").and_then(|v| v.as_str()).is_some_and(|id| {
                    !id.is_empty() && seen.insert(id.to_string())
                })
            })
            .collect();
        let mut effective_model = want_model.clone();
        if !merged.is_empty() {
            *acp.inner.model_options.lock().await = merged;
            if want_model.is_empty() {
                effective_model = model_opt
                    .and_then(|o| o.get("currentValue"))
                    .or_else(|| res.pointer("/models/currentModelId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
            }
        }
        // 要求モデルがあれば切替を試みる（set_config_option → 未対応なら握りつぶす）
        if !want_model.is_empty() && want_model != effective_model {
            let switched = Acp::rpc(
                &acp.inner,
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": "model", "value": want_model }),
                15000,
            )
            .await
            .is_ok()
                || Acp::rpc(
                    &acp.inner,
                    "session/set_model",
                    json!({ "sessionId": session_id, "modelId": want_model }),
                    15000,
                )
                .await
                .is_ok();
            if switched {
                effective_model = want_model.clone();
            } else {
                eprintln!("[bridge] モデル切替に失敗（このビルドでは未対応の可能性）");
            }
        }
        // usage_update をモデルへ紐付けるため sessionId → model を記録する
        if !effective_model.is_empty() {
            acp.inner
                .session_model
                .lock()
                .await
                .insert(session_id.clone(), effective_model.clone());
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(
                project.to_string(),
                DevinSession {
                    session_id: session_id.clone(),
                    tools_sig: sig,
                    seeded: false,
                    model: effective_model,
                },
            );
        }
        Ok(session_id)
    }

    async fn handle_agent(&self, body: &Value, shared: &Arc<McpShared>) -> Result<Value, String> {
        let decls = normalize_tool_decls(body.get("tools").unwrap_or(&Value::Null));
        let project = request_project(body);
        prepare_mcp_state(shared, &project, decls.clone(), body);
        let acp = self.get_acp().await?;
        // 権限判定用にツール名を登録
        if let Ok(mut names) = acp.inner.tool_names.lock() {
            for d in &decls {
                names.insert(d.name.clone());
            }
        }
        let model = request_model(body, "");
        let session_id = self.get_session(&acp, &project, &decls, &model).await?;
        acp.inner
            .turn_text
            .lock()
            .await
            .insert(session_id.clone(), Vec::new());
        let seeded = self
            .sessions
            .lock()
            .map(|s| s.get(&project).is_some_and(|e| e.seeded))
            .unwrap_or(false);
        Acp::rpc(
            &acp.inner,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": build_prompt(body, seeded, true) }],
            }),
            send_timeout_ms(),
        )
        .await?;
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(e) = sessions.get_mut(&project) {
                e.seeded = true;
            }
        }
        let reply = acp
            .inner
            .turn_text
            .lock()
            .await
            .get(&session_id)
            .map(|v| v.join(""))
            .unwrap_or_default()
            .trim()
            .to_string();
        Ok(json!({ "reply": reply, "actions": take_pending(shared, &project) }))
    }

    pub async fn agent(
        &self,
        body: &Value,
        headers: &axum::http::HeaderMap,
        shared: &Arc<McpShared>,
    ) -> Result<Value, String> {
        self.capture_api_key(headers).await;
        // ACP セッションの作成・プロンプトは直列化（同一セッションへの同時 prompt 防止）
        let _guard = self.queue.lock().await;
        self.handle_agent(body, shared).await
    }

    // Devin 側が利用できるモデル一覧。モデル情報は devin acp との
    // セッション（configOptions / models.availableModels）からしか取れず、
    // acp 未起動時の起動・認証には数十秒〜ブラウザログイン要で数分かかる
    // ことがある。待たずに {pending:true} を即返し、起動は裏で進める
    pub async fn models(
        self: &Arc<Self>,
        headers: &axum::http::HeaderMap,
        _shared: &Arc<McpShared>,
    ) -> Value {
        self.capture_api_key(headers).await;
        let has_models = self
            .acp
            .try_lock()
            .ok()
            .and_then(|g| g.as_ref().map(|a| a.inner.model_options.try_lock().map(|m| !m.is_empty()).unwrap_or(false)))
            .unwrap_or(false);
        if !has_models {
            let mut warmup = self.models_warmup.lock().await;
            if !*warmup {
                *warmup = true;
                let this = self.clone();
                tokio::spawn(async move {
                    let result = async {
                        let acp = this.get_acp().await?;
                        let empty: Vec<ToolDecl> = Vec::new();
                        let has = acp.inner.model_options.lock().await.is_empty();
                        if has {
                            this.get_session(&acp, "__models__", &empty, &model_default())
                                .await?;
                        }
                        Ok::<(), String>(())
                    }
                    .await;
                    match result {
                        Ok(()) => {
                            if let Ok(mut e) = this.last_warmup_error.lock() {
                                *e = String::new();
                            }
                        }
                        Err(e) => {
                            if let Ok(mut le) = this.last_warmup_error.lock() {
                                *le = e.clone();
                            }
                            eprintln!("[bridge] models warmup failed: {e}");
                        }
                    }
                    *this.models_warmup.lock().await = false;
                });
            }
        }
        let (options, context_by_model, last_usage) = match self.acp.try_lock() {
            Ok(g) => match g.as_ref() {
                Some(a) => (
                    a.inner.model_options.try_lock().map(|m| m.clone()).unwrap_or_default(),
                    a.inner.context_by_model.try_lock().map(|m| m.clone()).unwrap_or_default(),
                    a.inner.last_usage.try_lock().ok().and_then(|l| l.clone()),
                ),
                None => (Vec::new(), HashMap::new(), None),
            },
            Err(_) => (Vec::new(), HashMap::new(), None),
        };
        let models: Vec<Value> = options
            .iter()
            .map(|m| {
                let mut m = m.clone();
                if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                    if let Some(ctx) = context_by_model.get(id) {
                        m.as_object_mut()
                            .map(|o| o.insert("context".to_string(), ctx.clone()));
                    }
                }
                m
            })
            .collect();
        let current_model = {
            let m = model_default();
            if !m.is_empty() {
                Value::String(m)
            } else {
                self.sessions
                    .lock()
                    .map(|s| {
                        s.values()
                            .map(|e| e.model.clone())
                            .find(|m| !m.is_empty())
                            .map(Value::String)
                            .unwrap_or(Value::Null)
                    })
                    .unwrap_or(Value::Null)
            }
        };
        let error = self
            .last_warmup_error
            .lock()
            .map(|e| e.clone())
            .unwrap_or_default();
        json!({
            "models": models,
            "pending": options.is_empty(),
            "model": current_model,
            "usage": last_usage,
            "error": if error.is_empty() { Value::Null } else { Value::String(error) },
        })
    }

    pub async fn shutdown(&self) {
        let old = self.acp.lock().await.take();
        if let Some(acp) = old {
            if let Ok(mut child) = acp.child.try_lock() {
                let _ = child.kill().await;
            }
        }
    }
}

// パス埋め込み用の最小限 URL エンコード（プロジェクト名用）
fn urlencoding(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
