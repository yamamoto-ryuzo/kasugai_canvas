// KASUGAI Canvas AIチャット → Antigravity CLI (agy) ブリッジ（旧 antigravity-bridge/server.mjs の Rust 移植）。
//
// アプリの「外部エージェント」プロトコルを、Antigravity CLI (agy) の headless 実行へ翻訳する。
//
// 地図操作ツールは MCP (streamable HTTP) で agy に注入する:
// ハブ側が /mcp で MCP サーバーを兼ね、起動時に
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
use super::common::{
    self, authorized, build_prompt, env_flag, env_u64, normalize_tool_decls, prepare_mcp_state,
    request_model, request_project, take_pending, workdir, McpShared,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

fn model_default() -> String {
    std::env::var("ANTIGRAVITY_BRIDGE_MODEL").unwrap_or_default()
}
fn effort() -> String {
    std::env::var("ANTIGRAVITY_BRIDGE_EFFORT").unwrap_or_default()
}
fn send_timeout_ms() -> u64 {
    env_u64("ANTIGRAVITY_BRIDGE_TIMEOUT_MS", 110000)
}
fn token() -> String {
    std::env::var("ANTIGRAVITY_BRIDGE_TOKEN").unwrap_or_default()
}
fn debug() -> bool {
    env_flag("ANTIGRAVITY_BRIDGE_DEBUG")
}
fn no_mcp_register() -> bool {
    env_flag("ANTIGRAVITY_BRIDGE_NO_MCP_REGISTER")
}
fn no_settings_patch() -> bool {
    env_flag("ANTIGRAVITY_BRIDGE_NO_SETTINGS_PATCH")
}
// agy に登録する MCP サーバー名（permissions ルール mcp(<name>/*) と対になる）
fn mcp_server_name() -> String {
    std::env::var("ANTIGRAVITY_BRIDGE_MCP_NAME").unwrap_or_else(|_| "kasugai".to_string())
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

// agy のグローバル MCP 設定ファイル
fn mcp_config_file() -> PathBuf {
    home_dir()
        .join(".gemini")
        .join("config")
        .join("mcp_config.json")
}

// agy CLI の探索順。AGY_CLI_PATH > PATH 上の agy > 代表的なインストール先
fn agy_bin_candidates() -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("AGY_CLI_PATH") {
        if !p.is_empty() {
            list.push(p);
        }
    }
    list.push(if cfg!(windows) { "agy.exe" } else { "agy" }.to_string());
    list.push("agy".to_string());
    if cfg!(windows) {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            list.push(
                PathBuf::from(local)
                    .join("agy")
                    .join("bin")
                    .join("agy.exe")
                    .to_string_lossy()
                    .to_string(),
            );
        }
    } else if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        list.push(home.join(".local").join("bin").join("agy").to_string_lossy().to_string());
        list.push("/usr/local/bin/agy".to_string());
        list.push("/opt/homebrew/bin/agy".to_string());
    }
    list
}

struct AgyRun {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

pub struct AntiBridge {
    agy_bin: StdMutex<Option<String>>,
    // project -> conversationId
    conversations: StdMutex<HashMap<String, String>>,
    // project -> 会話作成時に agy へ登録されていた MCP URL。
    // agy は会話開始時の URL にバインドし続けるため、登録URLが変わると
    // 再開した会話だけが古いポートへ繋ぎに行き Connection refused になる
    conv_url: StdMutex<HashMap<String, String>>,
    last_model: StdMutex<String>,
    // result.usage（{input_tokens,...}）
    last_usage: StdMutex<Option<Value>>,
    models_cache: StdMutex<Option<(Instant, Vec<Value>)>>,
    // /agent 処理の直列化（agy の MCP 設定はグローバル（/mcp 単一エンドポイント）
    // のため、/mcp の tools/list・tools/call を現在プロジェクトに紐付ける必要がある）
    queue: Mutex<()>,
    hub_port: u16,
    last_mcp_add_at: StdMutex<Option<Instant>>,
}

impl AntiBridge {
    pub fn new(hub_port: u16) -> Self {
        Self {
            agy_bin: StdMutex::new(None),
            conversations: StdMutex::new(HashMap::new()),
            conv_url: StdMutex::new(HashMap::new()),
            last_model: StdMutex::new(String::new()),
            last_usage: StdMutex::new(None),
            models_cache: StdMutex::new(None),
            queue: Mutex::new(()),
            hub_port,
            last_mcp_add_at: StdMutex::new(None),
        }
    }

    fn mcp_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.hub_port)
    }

    pub fn check_auth(&self, headers: &axum::http::HeaderMap) -> bool {
        authorized(&token(), headers)
    }

    pub fn running(&self) -> bool {
        // /health 表示用: 解決済みバイナリのキャッシュのみ見る（探索はしない）
        self.agy_bin
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    // キャッシュがあればそれを返す。なければ --version で疎通する候補を探す
    async fn resolve_agy_bin(&self) -> Option<String> {
        if let Ok(guard) = self.agy_bin.lock() {
            if let Some(b) = guard.as_ref() {
                return Some(b.clone());
            }
        }
        for bin in agy_bin_candidates() {
            let mut cmd = common::new_command(&bin);
            cmd.arg("--version")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let ok = match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
                Ok(Ok(out)) => {
                    out.status.success() || !out.stdout.is_empty() || !out.stderr.is_empty()
                }
                _ => false,
            };
            if ok {
                if let Ok(mut guard) = self.agy_bin.lock() {
                    *guard = Some(bin.clone());
                }
                return Some(bin);
            }
        }
        None
    }

    // agy コマンドを実行して stdout/stderr を取る（mcp add / models 用）
    async fn run_agy(&self, args: &[&str], timeout_ms: u64) -> Result<AgyRun, String> {
        let bin = self.resolve_agy_bin().await.ok_or_else(|| {
            "agy CLI が見つかりません（AGY_CLI_PATH を確認）".to_string()
        })?;
        let mut cmd = common::new_command(&bin);
        cmd.args(args)
            .current_dir(workdir("antigravity"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let out = tokio::time::timeout(Duration::from_millis(timeout_ms), cmd.output())
            .await
            .map_err(|_| format!("agy {} timed out", args.first().unwrap_or(&"")))?
            .map_err(|e| e.to_string())?;
        Ok(AgyRun {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout)
                .chars()
                .take(256 * 1024)
                .collect(),
            stderr: String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(64 * 1024)
                .collect(),
        })
    }

    // ~/.gemini/antigravity-cli/settings.json の permissions.allow に
    // `mcp(<name>/*)` を追加する（headless で kasugai MCP 呼び出しが自動拒否
    // されないよう事前許可する。他ツールの権限は変更しない）
    fn ensure_permission_rule(&self) {
        if no_settings_patch() {
            return;
        }
        let file = home_dir()
            .join(".gemini")
            .join("antigravity-cli")
            .join("settings.json");
        let rule = format!("mcp({}/*)", mcp_server_name());
        let mut data = match std::fs::read_to_string(&file) {
            Ok(s) => match serde_json::from_str::<Value>(&s) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[bridge] settings.json の解析に失敗（権限ルール未追加）: {e}");
                    return;
                }
            },
            Err(_) => json!({}),
        };
        let mut perms = data
            .get("permissions")
            .filter(|p| p.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut allow = perms
            .get("allow")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if allow.iter().any(|v| v.as_str() == Some(&rule) || v.as_str() == Some("mcp(*)")) {
            return;
        }
        allow.push(Value::String(rule.clone()));
        perms["allow"] = Value::Array(allow);
        data["permissions"] = perms;
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::write(&file, serde_json::to_string_pretty(&data).unwrap_or_default()).is_ok() {
            eprintln!("[bridge] settings.json の permissions.allow に {rule} を追加しました");
        }
    }

    // agy のグローバル MCP 設定に登録されている kasugai の URL を読む。
    // 未登録は ""、ファイルが読めない環境では None を返す
    fn registered_mcp_url(&self) -> Option<String> {
        let data = std::fs::read_to_string(mcp_config_file()).ok()?;
        let v = serde_json::from_str::<Value>(&data).ok()?;
        let s = v.pointer(&format!("/mcpServers/{}", mcp_server_name()));
        Some(
            s.and_then(|s| {
                s.get("serverUrl")
                    .or_else(|| s.get("url"))
                    .and_then(|u| u.as_str())
            })
            .unwrap_or_default()
            .to_string(),
        )
    }

    // ブリッジの /mcp エンドポイントを agy の MCP サーバーとして登録する
    // （add は add-or-update のため冪等。既存の kasugai エントリは上書きされる）
    async fn ensure_mcp_registration(&self) {
        if no_mcp_register() {
            return;
        }
        if let Ok(mut at) = self.last_mcp_add_at.lock() {
            *at = Some(Instant::now());
        }
        let url = self.mcp_url();
        match self
            .run_agy(&["mcp", "add", &mcp_server_name(), &url], 20000)
            .await
        {
            Ok(r) if r.code == Some(0) => {
                eprintln!("[bridge] agy MCP サーバー \"{}\" を登録: {url}", mcp_server_name());
            }
            Ok(r) => {
                eprintln!(
                    "[bridge] agy mcp add に失敗（地図ツールは使えません）: {}",
                    r.stderr.trim()
                );
            }
            Err(e) => {
                eprintln!("[bridge] agy mcp add に失敗（地図ツールは使えません）: {e}");
            }
        }
    }

    // 登録URLがこのブリッジのポートと違う場合だけ修復する。
    // 手動起動ブリッジ（既定 8791）等の別インスタンスがグローバル登録を
    // 上書きしたケースへの追従。設定ファイルが読めない場合は定期再登録に倒す
    async fn ensure_mcp_url_current(&self) {
        if no_mcp_register() {
            return;
        }
        match self.registered_mcp_url() {
            Some(cur) if cur == self.mcp_url() => {}
            Some(_) => {
                eprintln!(
                    "[bridge] MCP 登録URLが不一致です。再登録します: {}",
                    self.mcp_url()
                );
                self.ensure_mcp_registration().await;
            }
            None => {
                // 設定ファイルが読めない環境では定期再登録に倒す
                let elapsed = self
                    .last_mcp_add_at
                    .lock()
                    .ok()
                    .and_then(|g| *g)
                    .map(|t| t.elapsed().as_secs() < 30)
                    .unwrap_or(false);
                if !elapsed {
                    self.ensure_mcp_registration().await;
                }
            }
        }
    }

    // agy 起動時の初期化（登録・権限ルール）。ハブ側から起動直後に呼ぶ
    pub async fn warmup(&self) {
        if self.resolve_agy_bin().await.is_some() {
            self.ensure_mcp_registration().await;
            self.ensure_permission_rule();
        } else {
            eprintln!("[bridge] agy CLI が見つかりません。Antigravity CLI のインストール・ログイン後に利用できます");
        }
    }

    // `agy models` の出力（"id\t表示名" 行）を /models 応答用にパースする。
    // 短時間キャッシュして設定画面の表示を軽くする
    async fn list_models(&self) -> Result<Vec<Value>, String> {
        {
            let cache = self.models_cache.lock().map_err(|e| e.to_string())?;
            if let Some((at, models)) = cache.as_ref() {
                if at.elapsed() < Duration::from_secs(60) && !models.is_empty() {
                    return Ok(models.clone());
                }
            }
        }
        let r = self.run_agy(&["models"], 20000).await?;
        if r.code != Some(0) {
            return Err(r
                .stderr
                .trim()
                .to_string()
                .into());
        }
        let models: Vec<Value> = r
            .stdout
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let (id, name) = line.split_once('\t')?;
                let name = name.trim();
                if id.is_empty() || name.is_empty() {
                    None
                } else {
                    Some(json!({ "id": id, "name": name }))
                }
            })
            .collect();
        if let Ok(mut cache) = self.models_cache.lock() {
            *cache = Some((Instant::now(), models.clone()));
        }
        Ok(models)
    }

    pub async fn models(&self) -> Value {
        let (models, error) = match self.list_models().await {
            Ok(m) => (m, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        let model = {
            let m = model_default();
            if !m.is_empty() {
                m
            } else {
                self.last_model
                    .lock()
                    .map(|l| l.clone())
                    .unwrap_or_default()
            }
        };
        let usage = self.last_usage.lock().ok().and_then(|u| u.clone());
        let mut out = json!({
            "models": models,
            "model": if model.is_empty() { Value::Null } else { Value::String(model) },
            "usage": usage,
        });
        if let Some(e) = error {
            out["error"] = Value::String(e);
        }
        out
    }

    // ---- agy headless 実行（stream-json stdin → stream-json stdout） ----
    // 1メッセージ = 1プロセス。プロンプトは stdin の NDJSON（{"event":"user",...}）
    // で渡すためコマンドライン長制限を受けない。会話継続は --conversation <id>。
    async fn run_agy_turn(
        &self,
        prompt: &str,
        conversation_id: &str,
        model: &str,
        timeout_ms: u64,
    ) -> Result<AgyTurn, String> {
        let bin = self.resolve_agy_bin().await.ok_or_else(|| {
            "agy CLI が見つかりません。Antigravity CLI をインストールしてログインするか、AGY_CLI_PATH で場所を指定してください".to_string()
        })?;
        let mut args: Vec<String> = vec![
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
        ];
        if !conversation_id.is_empty() {
            args.push("--conversation".to_string());
            args.push(conversation_id.to_string());
        }
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model.to_string());
        } else if !model_default().is_empty() {
            args.push("--model".to_string());
            args.push(model_default());
        }
        if !effort().is_empty() {
            args.push("--effort".to_string());
            args.push(effort());
        }
        // ブリッジ側タイムアウトの少し手前で agy 自身にも打ち切らせる
        let print_timeout_sec = std::cmp::max(10, (timeout_ms.saturating_sub(10000)) / 1000);
        args.push("--print-timeout".to_string());
        args.push(format!("{print_timeout_sec}s"));
        let mut cmd = common::new_command(&bin);
        cmd.args(&args)
            .current_dir(workdir("antigravity"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("agy stdout が取れません")?;
        let stderr = child.stderr.take().ok_or("agy stderr が取れません")?;
        let mut stdin = child.stdin.take().ok_or("agy stdin が取れません")?;
        // プロンプトは stdin NDJSON で渡す（event:"user" が必須形式）
        let mut line = serde_json::to_string(&json!({
            "event": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] },
        }))
        .unwrap_or_default();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        drop(stdin);

        let stderr_task = tokio::spawn(async move {
            let mut s = String::new();
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if s.len() < 64 * 1024 {
                    s.push_str(&l);
                    s.push('\n');
                }
            }
            s
        });

        let read_task = tokio::spawn(async move {
            let mut result = Value::Null;
            let mut has_result = false;
            let mut new_conversation_id = String::new();
            let mut chunks: Vec<String> = Vec::new();
            let mut tool_steps: Vec<(String, String)> = Vec::new();
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let s = line.trim();
                if s.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(s) else {
                    continue;
                };
                match msg.get("event").and_then(|v| v.as_str()) {
                    Some("init") => {
                        if let Some(id) = msg.get("conversation_id").and_then(|v| v.as_str()) {
                            new_conversation_id = id.to_string();
                        }
                    }
                    Some("step_update") => {
                        let u = msg.get("step_update").cloned().unwrap_or(json!({}));
                        if u.get("step_type").and_then(|v| v.as_str()) == Some("agent_response") {
                            if let Some(t) = u.get("text_delta").and_then(|v| v.as_str()) {
                                chunks.push(t.to_string());
                            }
                        }
                        if u.get("step_type").and_then(|v| v.as_str()) == Some("tool") {
                            let name = u
                                .get("tool_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let state = u
                                .get("state")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            if !name.is_empty() {
                                if debug() {
                                    eprintln!("[agy] tool {name} {state}");
                                }
                                tool_steps.push((name, state));
                            }
                        }
                    }
                    Some("result") => {
                        result = msg.get("result").cloned().unwrap_or(Value::Null);
                        has_result = true;
                    }
                    _ => {}
                }
            }
            (result, has_result, new_conversation_id, chunks.join(""), tool_steps)
        });

        let timeout = Duration::from_millis(timeout_ms);
        let read = tokio::time::timeout(timeout, read_task).await;
        let (result, has_result, new_conversation_id, text, tool_steps) = match read {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return Err(format!("agy 出力の読み取りに失敗: {e}"));
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err(format!("agy が {timeout_ms}ms でタイムアウトしました"));
            }
        };
        let stderr_text = stderr_task.await.unwrap_or_default().trim().to_string();
        let code = child.wait().await.ok().and_then(|s| s.code());
        Ok(AgyTurn {
            code,
            result: has_result.then_some(result),
            conversation_id: if new_conversation_id.is_empty() {
                conversation_id.to_string()
            } else {
                new_conversation_id
            },
            text,
            stderr: stderr_text,
            tool_steps,
        })
    }

    async fn agy_turn(&self, body: &Value, conversation_id: &str) -> Result<AgyTurn, String> {
        let prompt = build_prompt(body, !conversation_id.is_empty(), true);
        self.run_agy_turn(&prompt, conversation_id, &request_model(body, ""), send_timeout_ms())
            .await
    }

    async fn handle_agent(&self, body: &Value, shared: &Arc<McpShared>) -> Result<Value, String> {
        let decls = normalize_tool_decls(body.get("tools").unwrap_or(&Value::Null));
        let project = request_project(body);
        *shared.current_project.lock().map_err(|e| e.to_string())? = project.clone();
        prepare_mcp_state(shared, &project, decls.clone(), body);
        // 別インスタンスがグローバル MCP 登録を上書きしていたら先に修復する
        self.ensure_mcp_url_current().await;
        let mut conversation_id = self
            .conversations
            .lock()
            .map(|c| c.get(&project).cloned().unwrap_or_default())
            .unwrap_or_default();
        // 会話作成時の登録URLと現在のブリッジが違う会話は MCP バインドが古い
        // （agy は会話開始時の URL を使い続ける）ため破棄して新規にする
        if !conversation_id.is_empty() {
            let bound = self
                .conv_url
                .lock()
                .ok()
                .and_then(|m| m.get(&project).cloned());
            if let Some(bound) = bound {
                if bound != self.mcp_url() {
                    eprintln!(
                        "[bridge] 会話 {conversation_id} は旧 MCP URL（{bound}）に紐付いています。新規会話に切り替えます"
                    );
                    if let Ok(mut c) = self.conversations.lock() {
                        c.remove(&project);
                    }
                    if let Ok(mut m) = self.conv_url.lock() {
                        m.remove(&project);
                    }
                    conversation_id = String::new();
                }
            }
        }
        // この後に会話が新規作成される場合の想定バインドURL
        let reg_now = self.registered_mcp_url().unwrap_or_else(|| self.mcp_url());
        let mcp_before = shared.hits.load(std::sync::atomic::Ordering::SeqCst);
        // agy 側が別（古い）MCP URL を見ている兆候: ターン中にこのブリッジの
        // /mcp へ一度も届かず、kasugai ツール呼出・ツール失敗・接続エラー系の
        // 応答が見える（古いポートが死んでいるか、別インスタンスへ誤配送）
        let is_kasugai_step = |t: &(String, String)| {
            t.0.contains(&mcp_server_name()) || decls.iter().any(|d| d.name == t.0)
        };
        let stale_mcp = |r: &AgyTurn| {
            if shared.hits.load(std::sync::atomic::Ordering::SeqCst) != mcp_before {
                return false;
            }
            if r.tool_steps.iter().any(|t| is_kasugai_step(t)) {
                return true;
            }
            if r.tool_steps
                .iter()
                .any(|t| t.1.to_lowercase().contains("fail") || t.1.to_lowercase().contains("error") || t.1.to_lowercase().contains("denied"))
            {
                return true;
            }
            let blob = format!(
                "{}\n{}\n{}",
                r.text,
                r.result
                    .as_ref()
                    .and_then(|v| v.get("response").and_then(|x| x.as_str()))
                    .unwrap_or_default(),
                r.stderr
            );
            let lower = blob.to_lowercase();
            lower.contains("mcp")
                && (lower.contains("refus")
                    || lower.contains("econnrefused")
                    || lower.contains("error")
                    || lower.contains("fail")
                    || blob.contains("エラー")
                    || blob.contains("接続")
                    || blob.contains("失敗")
                    || blob.contains("拒否")
                    || lower.contains("unreachable")
                    || lower.contains("timed out")
                    || lower.contains("timeout"))
        };
        let mut run = self.agy_turn(body, &conversation_id).await?;
        let failed = run
            .result
            .as_ref()
            .is_none_or(|r| r.get("status").and_then(|v| v.as_str()) != Some("SUCCESS"));
        // 会話再開に失敗した（会話が消えた・ID不正等）、または古い MCP URL に
        // 紐付いたままの会話は、破棄して新規会話で一度だけ再試行する
        if failed || stale_mcp(&run) {
            if !conversation_id.is_empty() {
                eprintln!(
                    "[bridge] 会話 {conversation_id} を破棄して新規会話で再試行します: {}",
                    run.stderr.chars().take(200).collect::<String>()
                );
                if let Ok(mut c) = self.conversations.lock() {
                    c.remove(&project);
                }
                if let Ok(mut m) = self.conv_url.lock() {
                    m.remove(&project);
                }
            } else {
                eprintln!("[bridge] agy がこのブリッジの /mcp に到達していません。MCP 登録を修復して再試行します");
                self.ensure_mcp_registration().await;
            }
            if let Ok(mut m) = shared.pending.lock() {
                m.insert(project.clone(), Vec::new());
            }
            run = self.agy_turn(body, "").await?;
        }
        if !run.conversation_id.is_empty() {
            if let Ok(mut c) = self.conversations.lock() {
                c.insert(project.clone(), run.conversation_id.clone());
            }
            // 会話のバインドURLを記録する: ターン中にこのブリッジへ MCP リクエストが
            // 届いた会話は現行 URL 確定、それ以外は作成時の登録URLを残す
            let bound = if shared.hits.load(std::sync::atomic::Ordering::SeqCst) > mcp_before {
                self.mcp_url()
            } else {
                reg_now
            };
            if let Ok(mut m) = self.conv_url.lock() {
                m.insert(project.clone(), bound);
            }
        }
        let result = run.result.clone().unwrap_or(Value::Null);
        if result.get("status").and_then(|v| v.as_str()) != Some("SUCCESS") {
            let detail = result
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    let s = run.stderr.chars().take(500).collect::<String>();
                    (!s.is_empty()).then_some(s)
                })
                .unwrap_or_else(|| format!("exit code {:?}", run.code));
            return Err(format!("agy の実行に失敗しました: {detail}"));
        }
        if result.get("usage").is_some() {
            if let Ok(mut u) = self.last_usage.lock() {
                *u = result.get("usage").cloned();
            }
        }
        let req_model = request_model(body, "");
        if !req_model.is_empty() {
            if let Ok(mut m) = self.last_model.lock() {
                *m = req_model;
            }
        }
        let mut reply = result
            .get("response")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| run.text.clone())
            .trim()
            .to_string();
        let mut last_result = result;
        // 応答もアクションも無い空の SUCCESS はモデル側の取りこぼしのことがある。
        // 表示できるものが一切無いため、同一会話でもう一度だけ促す
        if reply.is_empty()
            && take_pending(shared, &project).is_empty()
            && !last_result
                .get("denied_actions")
                .and_then(|v| v.as_array())
                .is_some_and(|a| !a.is_empty())
        {
            eprintln!("[bridge] 応答が空でした。再試行します");
            let conv = self
                .conversations
                .lock()
                .map(|c| c.get(&project).cloned().unwrap_or_default())
                .unwrap_or_default();
            let retry = self.agy_turn(body, &conv).await?;
            if !retry.conversation_id.is_empty() {
                if let Ok(mut c) = self.conversations.lock() {
                    c.insert(project.clone(), retry.conversation_id.clone());
                }
            }
            let r = retry.result.clone().unwrap_or(Value::Null);
            if r.get("status").and_then(|v| v.as_str()) != Some("SUCCESS") {
                let detail = r
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        let s = retry.stderr.chars().take(500).collect::<String>();
                        (!s.is_empty()).then_some(s)
                    })
                    .unwrap_or_else(|| format!("exit code {:?}", retry.code));
                return Err(format!("agy の実行に失敗しました: {detail}"));
            }
            if r.get("usage").is_some() {
                if let Ok(mut u) = self.last_usage.lock() {
                    *u = r.get("usage").cloned();
                }
            }
            reply = r
                .get("response")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or(retry.text.clone())
                .trim()
                .to_string();
            last_result = r;
        }
        // 権限拒否で応答が空のケース（mcp(kasugai/*) ルール未適用等）を明示する
        let denied = last_result
            .get("denied_actions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if reply.is_empty() && !denied.is_empty() {
            let names: Vec<String> = denied
                .iter()
                .map(|d| {
                    d.get("action")
                        .or_else(|| d.get("display_name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                        .to_string()
                })
                .collect();
            reply = format!(
                "ツール呼び出しが権限により拒否されました（{}）。~/.gemini/antigravity-cli/settings.json の permissions.allow に mcp({}/*) があるか確認してください。",
                names.join(", "),
                mcp_server_name()
            );
        }
        Ok(json!({ "reply": reply, "actions": take_pending(shared, &project) }))
    }

    pub async fn agent(&self, body: &Value, shared: &Arc<McpShared>) -> Result<Value, String> {
        // agy 起動は直列化（MCP エンドポイントが現在プロジェクト基準のため）
        let _guard = self.queue.lock().await;
        self.handle_agent(body, shared).await
    }
}

struct AgyTurn {
    code: Option<i32>,
    result: Option<Value>,
    conversation_id: String,
    text: String,
    stderr: String,
    tool_steps: Vec<(String, String)>,
}
