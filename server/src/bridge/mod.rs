// KASUGAI Canvas AIブリッジハブ（旧 bridge-hub/server.mjs + 各プロバイダブリッジの Rust 統合版）。
//
// 127.0.0.1:8511 で待受け、AI プロバイダ（copilot / devin / antigravity）への
// /agent・/models を振り分ける。旧実装は Node 製ブリッジを子プロセス起動して
// プロキシしていたが、本実装はアプリ内モジュールとして直接実行する
// （外部 CLI は各プロバイダ実装が必要時に spawn する）。
//
// エージェント連携は双方向:
// - ブラウザ → エージェント（チャットから AI を使う）… 本ハブ（/agent・/models）
// - エージェント → ブラウザ（外から地図を操る）… アプリ本体（8510）の /api/command
//
// ルーティング:
//   GET  /health              → ハブ自身の状態
//   GET  /models?provider=<p> → プロバイダの /models
//   POST /agent               → body.provider でプロバイダを選択
//   POST /mcp[/<project>]     → 地図ツールの MCP 公開（devin/agy から呼ばれる）
pub mod antigravity;
pub mod common;
pub mod copilot;
pub mod devin;
pub mod setup;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{response::Html, Json, Router};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

use common::McpShared;

const PROVIDERS: &[(&str, &str)] = &[
    ("copilot", "KASUGAI_NO_COPILOT_BRIDGE"),
    ("devin", "KASUGAI_NO_DEVIN_BRIDGE"),
    ("antigravity", "KASUGAI_NO_ANTIGRAVITY_BRIDGE"),
];

pub struct BridgeState {
    copilot: copilot::CopilotBridge,
    devin: Arc<devin::DevinBridge>,
    antigravity: antigravity::AntiBridge,
    pub mcp: Arc<McpShared>,
    pub setup: setup::SetupJobs,
    // 起動・切替は直列化して競合を防ぐ（/agent 処理中に別プロバイダの
    // /models が来ても進行中の会話を乱さない）
    serialize: Mutex<()>,
    // 最後に使われたプロバイダ（/health の active 表示用）
    active: StdMutex<Option<String>>,
}

impl BridgeState {
    pub fn new(hub_port: u16) -> Self {
        Self {
            copilot: copilot::CopilotBridge::new(),
            devin: Arc::new(devin::DevinBridge::new(hub_port)),
            antigravity: antigravity::AntiBridge::new(hub_port),
            mcp: Arc::new(McpShared::default()),
            setup: setup::SetupJobs::default(),
            serialize: Mutex::new(()),
            active: StdMutex::new(None),
        }
    }

    fn enabled(&self, name: &str) -> bool {
        PROVIDERS
            .iter()
            .find(|(n, _)| *n == name)
            .is_some_and(|(_, env)| std::env::var_os(env).is_none())
    }

    fn provider_running(&self, name: &str) -> bool {
        match name {
            "copilot" => self.copilot.running(),
            "devin" => self.devin.running(),
            "antigravity" => self.antigravity.running(),
            _ => false,
        }
    }

    // 終了時にエージェントの子プロセスを掃除する
    pub async fn shutdown(&self) {
        self.copilot.shutdown().await;
        self.devin.shutdown().await;
        // antigravity はターン毎の子プロセスのみ（kill_on_drop で随時終了）
    }
}

fn provider_disabled(name: &str) -> Option<String> {
    PROVIDERS
        .iter()
        .find(|(n, _)| *n == name)
        .and_then(|(_, env)| std::env::var_os(env).map(|_| env.to_string()))
}

async fn health(State(state): State<Arc<BridgeState>>) -> impl IntoResponse {
    let active = state.active.lock().ok().and_then(|a| a.clone());
    let mut providers = serde_json::Map::new();
    for (name, _) in PROVIDERS {
        providers.insert(
            name.to_string(),
            json!({
                "available": state.enabled(name),
                "running": state.provider_running(name),
            }),
        );
    }
    Json(json!({
        "ok": true,
        "bridge": "hub",
        "hub": true,
        // フロントが旧ハブ（fallback フラグ非対応・version フィールド無し）を
        // 識別できるよう同梱バージョンを返す
        "version": env!("CARGO_PKG_VERSION"),
        "active": active,
        "providers": providers,
        "model": Value::Null,
        "sessions": state.copilot.session_count(),
    }))
}

// ブラウザで開けるハブ状態確認ページ（GET /）。表示側 JS が /health・/setup を
// 取って描画するためサーバー側テンプレは不要。/agent は POST 専用でブラウザ
// からは確認できないため、動作確認用の着地点としてこのページを提供する
async fn status_page() -> Html<&'static str> {
    Html(include_str!("hub_status.html"))
}

async fn models(
    State(state): State<Arc<BridgeState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let provider = q.get("provider").cloned().unwrap_or_else(|| {
        state
            .active
            .lock()
            .ok()
            .and_then(|a| a.clone())
            .unwrap_or_default()
    });
    if provider.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "provider を指定してください（copilot / devin / antigravity）", "models": [] })),
        );
    }
    if let Some(env) = provider_disabled(&provider) {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("プロバイダ \"{provider}\" は {env} で無効化されています"), "models": [] })),
        );
    }
    let _guard = state.serialize.lock().await;
    let out = match provider.as_str() {
        "copilot" => state.copilot.models().await,
        "devin" => state.devin.clone().models(&headers, &state.mcp).await,
        "antigravity" => state.antigravity.models().await,
        _ => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("プロバイダ \"{provider}\" は利用できません"), "models": [] })),
            )
        }
    };
    (StatusCode::OK, Json(out))
}

async fn agent(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if body.len() > 2 * 1024 * 1024 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "body too large" })),
        );
    }
    let body: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid json: {e}") })),
            )
        }
    };
    let provider = body
        .get("provider")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| state.active.lock().ok().and_then(|a| a.clone()))
        .unwrap_or_default();
    if provider.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "provider を指定してください（copilot / devin / antigravity）" })),
        );
    }
    if let Some(env) = provider_disabled(&provider) {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("プロバイダ \"{provider}\" は {env} で無効化されています") })),
        );
    }
    // プロバイダごとの Bearer トークン（未設定なら無認証=ローカル専用想定）
    let auth_ok = match provider.as_str() {
        "copilot" => state.copilot.check_auth(&headers),
        "devin" => state.devin.check_auth(&headers),
        "antigravity" => state.antigravity.check_auth(&headers),
        _ => false,
    };
    if !auth_ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        );
    }
    let _guard = state.serialize.lock().await;
    let result = match provider.as_str() {
        "copilot" => state.copilot.agent(&body).await,
        "devin" => state.devin.agent(&body, &headers, &state.mcp).await,
        "antigravity" => state.antigravity.agent(&body, &state.mcp).await,
        _ => Err(format!("プロバイダ \"{provider}\" は利用できません")),
    };
    match result {
        Ok(v) => {
            if let Ok(mut a) = state.active.lock() {
                *a = Some(provider);
            }
            (StatusCode::OK, Json(v))
        }
        Err(e) => {
            eprintln!("[bridge] agent error ({provider}): {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
        }
    }
}

// ---- /setup: ブリッジ用CLIの導入状況確認・自動インストール ----
// Origin ガード(ブラウザ発の踏み台防止) + 任意トークン。
// install はホワイトリスト化した公式手順のみ実行する

fn setup_forbidden(headers: &HeaderMap) -> Option<(StatusCode, Json<Value>)> {
    if !setup::origin_allowed(headers) {
        return Some((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "この Origin からのセットアップ要求は許可されていません" })),
        ));
    }
    if !common::authorized(&setup::token(), headers) {
        return Some((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        ));
    }
    None
}

async fn setup_status(headers: HeaderMap) -> impl IntoResponse {
    if let Some(res) = setup_forbidden(&headers) {
        return res;
    }
    (StatusCode::OK, Json(setup::status_all()))
}

async fn setup_run(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if let Some(res) = setup_forbidden(&headers) {
        return res;
    }
    if body.len() > 64 * 1024 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "body too large" })),
        );
    }
    let body: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid json: {e}") })),
            )
        }
    };
    let provider = body
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("status");
    match action {
        "status" => (StatusCode::OK, Json(setup::status_all())),
        "login" => {
            // 対話ログイン（copilot の /login・devin のブラウザ PKCE）はハブから
            // 代理実行できないため、CLI を別コンソールで起動してユーザー自身に
            // 完了してもらう。完了後はクライアント側で接続を再確認する
            if !setup::SETUP_PROVIDERS.contains(&provider) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("unknown provider: {provider}") })),
                );
            }
            if provider == "antigravity" {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "antigravity は Antigravity(IDE) の GUI から Google ログインしてください" })),
                );
            }
            match setup::spawn_login(provider) {
                Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
                Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
            }
        }
        "install" => {
            if body.get("confirm").and_then(|v| v.as_bool()) != Some(true) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "install には confirm:true が必要です" })),
                );
            }
            if !setup::SETUP_PROVIDERS.contains(&provider) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("unknown provider: {provider}") })),
                );
            }
            if provider == "antigravity" {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "antigravity は自動インストール非対応です",
                        "guide": "Antigravity(IDE) を導入し、agy で Google ログインしてください",
                    })),
                );
            }
            match state.setup.start(provider) {
                Ok(id) => (
                    StatusCode::ACCEPTED,
                    Json(json!({ "job": id, "status": "running" })),
                ),
                Err(e) => (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": e })),
                ),
            }
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown action: {action}") })),
        ),
    }
}

async fn setup_job(
    State(state): State<Arc<BridgeState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(res) = setup_forbidden(&headers) {
        return res;
    }
    match state.setup.describe(&id) {
        Some(v) => (StatusCode::OK, Json(v)),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "job not found" })),
        ),
    }
}

// MCP エンドポイント（devin / agy の MCP クライアントから呼ばれる）。
// /mcp は現在処理中のプロジェクト、/mcp/<project> は明示指定として扱う
async fn mcp(
    state: &Arc<BridgeState>,
    project: Option<String>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    state.mcp.hits.fetch_add(1, Ordering::SeqCst);
    let project = project.unwrap_or_else(|| {
        state
            .mcp
            .current_project
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|_| "default".to_string())
    });
    let json_response = |status: StatusCode, session_id: Option<String>, v: Value| {
        let mut res = (status, Json(v)).into_response();
        if let Some(id) = session_id {
            if let Ok(hv) = axum::http::HeaderValue::from_str(&id) {
                res.headers_mut()
                    .insert(axum::http::HeaderName::from_static("mcp-session-id"), hv);
            }
        }
        res
    };
    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                None,
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }),
            )
        }
    };
    if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
        if method != "ping" {
            let name = msg
                .pointer("/params/name")
                .and_then(|v| v.as_str())
                .map(|n| format!(" {n}"))
                .unwrap_or_default();
            eprintln!("[mcp] {project}: {method}{name}");
        }
    }
    let reply = common::handle_mcp_rpc(&state.mcp, &project, &msg);
    json_response(reply.status, reply.session_id, reply.body.unwrap_or(Value::Null))
}

async fn mcp_root(
    State(state): State<Arc<BridgeState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    mcp(&state, None, body).await
}

async fn mcp_project(
    State(state): State<Arc<BridgeState>>,
    Path(project): Path<String>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    mcp(&state, Some(project), body).await
}

// hub 用の axum ルーターを構築する
fn router(state: Arc<BridgeState>) -> Router {
    // HTTPS の公開デプロイ（Cloud Run/Pages等）から localhost ブリッジを呼ぶ
    // public→private の Private Network Access プリフライトに応答する
    let cors = CorsLayer::very_permissive().allow_private_network(true);
    Router::new()
        .route("/", get(status_page))
        .route("/health", get(health))
        .route("/models", get(models))
        .route("/agent", post(agent))
        .route("/setup", get(setup_status).post(setup_run))
        .route("/setup/job/{id}", get(setup_job))
        .route("/mcp", post(mcp_root).delete(mcp_root_delete))
        .route("/mcp/{project}", post(mcp_project).delete(mcp_project_delete))
        .layer(cors)
        .with_state(state)
}

async fn mcp_root_delete() -> StatusCode {
    StatusCode::OK
}
async fn mcp_project_delete(Path(_p): Path<String>) -> StatusCode {
    StatusCode::OK
}

// ハブを起動する。ポート確保は呼び出し側（占有チェック済みの listener を受け取る）。
// agy の MCP 登録・権限ルールは起動時に一度だけ行う
pub async fn serve(state: Arc<BridgeState>, listener: tokio::net::TcpListener) {
    let warmup_state = state.clone();
    tokio::spawn(async move {
        warmup_state.antigravity.warmup().await;
    });
    let app = router(state);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("bridge-hub: サーバーが終了しました: {e}");
    }
}
