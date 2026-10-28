// AIブリッジ共通部品。旧 bridge-hub/copilot-bridge/devin-bridge/antigravity-bridge
// の server.mjs から移植した共有ロジック。
//
// アプリの「外部エージェント」プロトコル:
//   POST /agent  {message, project, camera, layers, basemaps, history, tools, model, toolResults, provider}
//   →            {reply, actions:[{name, args}]}
// 地図操作ツールの実実行はブラウザ側。ここでは呼び出しを actions として
// 収集して返し、参照系ツール(listLayers/getCamera/listBasemaps)のみ実値を返す。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex as StdMutex;

// 各ブリッジのシステムプロンプト（旧 server.mjs と同一文面）
pub const SYSTEM_PROMPT: &str = "あなたは3D地図アプリ「KASUGAI Canvas」の操作アシスタントです。\n\
ユーザーの指示に応じて、登録された地図操作ツールで地図を操作してください。\n\
\n\
重要な前提:\n\
- このブリッジではツール呼び出しは「キュー」に積まれ、あなたの応答後にブラウザアプリ側で実行されます。実行結果は次のターンに [ツール実行結果] としてあなたへ返されるので、一覧・検索・確認系ツールも呼び出せば結果を見てから回答・追加操作ができます。結果に依存しない操作系の呼び出しはまとめて出せます。\n\
- listLayers / getCamera / listBasemaps は現在の実値を即時返します（それ以外のツール結果は呼び出し時点ではプレースホルダで、実値は次ターンの [ツール実行結果] で届きます）。レイヤ名が曖昧な場合は listLayers、ベースマップ名が曖昧な場合は listBasemaps で確認し、最も近いものを使ってください。ベースマップには「ベースマップなし」(id: none)と「ベースマップ透明」(id: transparent)という特殊な選択肢があります。\n\
- switchProject・applyInspector・shutdownApp・installUpdate・exportInspector・publishPlugin など影響の大きい操作は、ユーザーが明示的に指示した場合のみ実行してください（ブラウザ側に確認ダイアログも出ます）。\n\
- データの作成・追加を求められたら、確認を求めず GeoJSON を生成して addDataLayer で表示してください。架空・サンプルデータの場合は各 feature の properties に dataSource・generatedAt(ISO8601)・aiGenerated:true を入れてください。\n\
- 資料作成を求められたら Markdown でまとめて showReport で表示してください。\n\
- ファイル操作・シェル・検索などのビルトインツールは使わないでください。地図操作は登録ツール（kasugai の MCP ツール）のみで行います。\n\
- 回答は日本語で簡潔に。";

// アプリが送るツール宣言（Gemini functionDeclarations 形式を正規化したもの）
#[derive(Clone)]
pub struct ToolDecl {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

// Gemini形式スキーマ（type が大文字）を JSON Schema（小文字）へ変換する
fn to_json_schema(node: &Value) -> Value {
    match node {
        Value::Array(items) => Value::Array(items.iter().map(to_json_schema).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, value) in map {
                if key == "type" && value.is_string() {
                    out.insert(
                        key.clone(),
                        Value::String(value.as_str().unwrap_or_default().to_lowercase()),
                    );
                } else {
                    out.insert(key.clone(), to_json_schema(value));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

// アプリが送る tools（functionDeclarations 形式）を正規化する。
// OpenAI tools 形式 [{type:"function",function:{...}}] も一応受け付ける
pub fn normalize_tool_decls(tools: &Value) -> Vec<ToolDecl> {
    let Some(arr) = tools.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .map(|t| {
            if t.get("function").is_some_and(|f| f.is_object()) {
                t.get("function").cloned().unwrap_or(Value::Null)
            } else {
                t.clone()
            }
        })
        .filter_map(|d| {
            let name = d.get("name")?.as_str()?.to_string();
            if name.is_empty() {
                return None;
            }
            Some(ToolDecl {
                name,
                description: d
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                parameters: to_json_schema(
                    &d.get("parameters")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                ),
            })
        })
        .collect()
}

// リクエストの state（camera/layers/basemaps）から実値を返せる参照系ツール。
// これらがプレースホルダだと、エージェントがレイヤ名を確認してから操作する流れが破綻する
pub fn local_state_tool(name: &str, state: &Value) -> Option<Value> {
    match name {
        "listLayers" => Some(json!({ "layers": state.get("layers").cloned().unwrap_or(json!([])) })),
        "getCamera" => Some(state.get("camera").cloned().unwrap_or(Value::Null)),
        "listBasemaps" => Some(
            json!({ "basemaps": state.get("basemaps").cloned().unwrap_or(json!([])) }),
        ),
        _ => None,
    }
}

// ブリッジの作業ディレクトリ。エージェントのビルトインツール
// （ファイル・シェル）が触れる範囲を空の専用ディレクトリに限定する
pub fn workdir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kasugai-{tag}-bridge"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

pub fn env_flag(name: &str) -> bool {
    std::env::var_os(name).is_some()
}

// JSON を 8000 文字で切り詰めて埋め込む（state 表示用）
pub fn state_json(v: &Value) -> String {
    let s = serde_json::to_string(v).unwrap_or_else(|_| "null".to_string());
    s.chars().take(8000).collect()
}

// /agent ボディのプロンプト組み立て。
// include_system_prompt=true のプロバイダ（devin/agy）は初回ターンに
// システムプロンプトを前置きする。Copilot は session の systemMessage で渡す
pub fn build_prompt(body: &Value, seeded: bool, include_system_prompt: bool) -> String {
    let state = format!(
        "[State] camera={} layers={} basemaps={}",
        state_json(body.get("camera").unwrap_or(&Value::Null)),
        state_json(body.get("layers").unwrap_or(&Value::Null)),
        state_json(body.get("basemaps").unwrap_or(&Value::Null)),
    );
    // ブラウザで実行されたキュー済みツールの実結果。届いたターンは結果を踏えて完遂する
    let tr = match body.get("toolResults").and_then(|v| v.as_array()) {
        Some(list) if !list.is_empty() => {
            let dumped = serde_json::to_string(list).unwrap_or_default();
            format!(
                "\n\n[キューへ積んだツールのブラウザ側実行結果]\n{}",
                dumped.chars().take(20000).collect::<String>()
            )
        }
        _ => String::new(),
    };
    let message = body
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if !include_system_prompt {
        // Copilot: [Prior chat log] は未 seeded のときだけ
        if !seeded {
            if let Some(history) = body.get("history").and_then(|v| v.as_array()) {
                if !history.is_empty() {
                    let lines = history
                        .iter()
                        .rev()
                        .take(20)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .map(|h| {
                            format!(
                                "{}: {}",
                                h.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                                h.get("text")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .chars()
                                    .take(2000)
                                    .collect::<String>()
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    return format!("[Prior chat log]\n{lines}\n\n{state}\n\n{message}{tr}");
                }
            }
        }
        return format!("{state}\n\n{message}{tr}");
    }
    // devin / agy: 末尾に明示的なタスク枠を置く。システム指示＋状態だけだと
    // モデルが「準備完了」のみ返して実指示を実行しないことがあるため
    let mut prompt = String::new();
    if !seeded {
        prompt.push_str(SYSTEM_PROMPT);
        prompt.push_str("\n\n");
        if let Some(history) = body.get("history").and_then(|v| v.as_array()) {
            if !history.is_empty() {
                let lines = history
                    .iter()
                    .rev()
                    .take(20)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .map(|h| {
                        format!(
                            "{}: {}",
                            h.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                            h.get("text")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .chars()
                                .take(2000)
                                .collect::<String>()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                prompt.push_str(&format!("[Prior chat log]\n{lines}\n\n"));
            }
        }
    }
    let tail = if tr.is_empty() {
        "この指示に今すぐ従ってください。地図操作が必要なら登録ツール（kasugai の MCP ツール）を呼び出し、終わったら結果を日本語で簡潔に報告してください。"
    } else {
        "上記の実行結果を踏えてユーザーの指示を完遂・回答してください。追加のツール呼び出しが必要なら呼び出し、終わったら結果を日本語で簡潔に報告してください。"
    };
    format!("{prompt}{state}\n\n[ユーザーの指示]\n{message}{tr}\n\n{tail}")
}

// リクエストの model フィールド優先、なければ既定
pub fn request_model(body: &Value, default: &str) -> String {
    body.get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub fn request_project(body: &Value) -> String {
    body.get("project")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string()
}

// Bearer トークンのチェック。token 未設定時は常に許可（ローカル専用想定）
pub fn authorized(token: &str, headers: &axum::http::HeaderMap) -> bool {
    token.is_empty()
        || headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {token}").as_str())
}

// ---- MCP (streamable HTTP 簡易実装): エージェントへ地図ツールを公開する側 ----

// devin/agy 共有の MCP 状態。プロジェクトごとの公開ツール宣言・
// 保留アクション・現在の地図状態を持つ
#[derive(Default)]
pub struct McpShared {
    pub decls: StdMutex<HashMap<String, Vec<ToolDecl>>>,
    pub pending: StdMutex<HashMap<String, Vec<Value>>>,
    pub state: StdMutex<HashMap<String, Value>>,
    // agy の MCP 設定はグローバル（/mcp 単一エンドポイント）のため、
    // パス無し /mcp は現在処理中のプロジェクトに紐付ける
    pub current_project: StdMutex<String>,
    // 本ブリッジの /mcp に届いたリクエストの累計。
    // agy のターン中に 0 なら agy 側が別（古い）URL を見ている兆候
    pub hits: AtomicU64,
}

pub struct McpReply {
    pub status: axum::http::StatusCode,
    pub session_id: Option<String>,
    pub body: Option<Value>,
}

fn mcp_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}
fn mcp_tool_text(obj: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": serde_json::to_string(&obj).unwrap_or_default() }] })
}

// 1 JSON-RPC メッセージの処理（devin/agy 共通ロジック）
pub fn handle_mcp_rpc(shared: &McpShared, project: &str, msg: &Value) -> McpReply {
    let Some(id) = msg.get("id") else {
        // 通知（id なし）は受理のみ
        return McpReply {
            status: axum::http::StatusCode::ACCEPTED,
            session_id: None,
            body: None,
        };
    };
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    match method {
        "initialize" => McpReply {
            status: axum::http::StatusCode::OK,
            session_id: Some(uuid::Uuid::new_v4().to_string()),
            body: Some(mcp_result(
                id,
                json!({
                    "protocolVersion": msg.pointer("/params/protocolVersion")
                        .and_then(|v| v.as_str())
                        .unwrap_or("2025-06-18"),
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "kasugai-map-tools", "version": "1.0.0" },
                }),
            )),
        },
        "ping" => McpReply {
            status: axum::http::StatusCode::OK,
            session_id: None,
            body: Some(mcp_result(id, json!({}))),
        },
        "tools/list" => {
            let decls = shared
                .decls
                .lock()
                .map(|m| m.get(project).cloned().unwrap_or_default())
                .unwrap_or_default();
            McpReply {
                status: axum::http::StatusCode::OK,
                session_id: None,
                body: Some(mcp_result(
                    id,
                    json!({
                        "tools": decls.iter().map(|d| json!({
                            "name": d.name,
                            "description": d.description,
                            "inputSchema": d.parameters,
                        })).collect::<Vec<_>>()
                    }),
                )),
            }
        }
        "tools/call" => {
            let name = msg
                .pointer("/params/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = msg
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));
            let decls = shared
                .decls
                .lock()
                .map(|m| m.get(project).cloned().unwrap_or_default())
                .unwrap_or_default();
            if !decls.iter().any(|d| d.name == name) {
                return McpReply {
                    status: axum::http::StatusCode::OK,
                    session_id: None,
                    body: Some(mcp_result(
                        id,
                        json!({
                            "content": mcp_tool_text(json!({ "error": format!("unknown tool: {name}") }))["content"],
                            "isError": true,
                        }),
                    )),
                };
            }
            let state = shared
                .state
                .lock()
                .map(|m| m.get(project).cloned().unwrap_or(Value::Null))
                .unwrap_or(Value::Null);
            if let Some(v) = local_state_tool(name, &state) {
                return McpReply {
                    status: axum::http::StatusCode::OK,
                    session_id: None,
                    body: Some(mcp_result(id, mcp_tool_text(v))),
                };
            }
            if let Ok(mut pending) = shared.pending.lock() {
                pending
                    .entry(project.to_string())
                    .or_default()
                    .push(json!({ "name": name, "args": args }));
            }
            McpReply {
                status: axum::http::StatusCode::OK,
                session_id: None,
                body: Some(mcp_result(
                    id,
                    mcp_tool_text(json!({
                        "queued": true,
                        "note": "Action queued; it runs in the browser after your reply and the real result is delivered back to you in the next turn.",
                    })),
                )),
            }
        }
        _ => McpReply {
            status: axum::http::StatusCode::OK,
            session_id: None,
            body: Some(mcp_error(id, -32601, &format!("method not found: {method}"))),
        },
    }
}

// /agent 前処理: プロジェクトの宣言・保留キュー・現在状態を共有マップへ反映
pub fn prepare_mcp_state(shared: &McpShared, project: &str, decls: Vec<ToolDecl>, body: &Value) {
    if let Ok(mut m) = shared.decls.lock() {
        m.insert(project.to_string(), decls);
    }
    if let Ok(mut m) = shared.pending.lock() {
        m.insert(project.to_string(), Vec::new());
    }
    if let Ok(mut m) = shared.state.lock() {
        m.insert(
            project.to_string(),
            json!({
                "layers": body.get("layers").cloned().unwrap_or(Value::Null),
                "camera": body.get("camera").cloned().unwrap_or(Value::Null),
                "basemaps": body.get("basemaps").cloned().unwrap_or(Value::Null),
            }),
        );
    }
}

pub fn take_pending(shared: &McpShared, project: &str) -> Vec<Value> {
    shared
        .pending
        .lock()
        .map(|m| m.get(project).cloned().unwrap_or_default())
        .unwrap_or_default()
}

// 子プロセスの生成。Windows GUI サブシステムからの起動で
// コンソールウィンドウが出ないよう CREATE_NO_WINDOW を付ける
pub fn new_command(program: &str) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}
