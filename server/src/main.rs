#![windows_subsystem = "windows"]

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Notify;

const INDEX_HTML: &str = include_str!("../../web/index.html");
const APP_JS: &str = include_str!("../../web/app.js");
const BOOTSTRAP_JS: &str = include_str!("../../web/bootstrap.js");
const STYLES_CSS: &str = include_str!("../../web/styles.css");
const CONFIG_FILE_NAME: &str = "kasugai_canvas.config";
const UPDATE_CONFIG_FILE_NAME: &str = "kasugai_canvas.update.json";
const LATEST_JSON_URLS: [&str; 2] = [
    "https://yamamoto-ryuzo.github.io/kasugai_canvas/download/latest.json",
    "https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/latest.json",
];
const RELEASE_DOWNLOAD_URL: &str =
    "https://github.com/yamamoto-ryuzo/kasugai_canvas/releases/latest/download/kasugai_canvas.zip";

#[derive(Clone)]
struct AppState {
    config_path: Arc<PathBuf>,
    update_config_path: Arc<PathBuf>,
    shutdown: Arc<Notify>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettings {
    #[serde(default = "default_true")]
    auto_update: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { auto_update: true }
    }
}

fn default_true() -> bool {
    true
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn app_js() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        APP_JS,
    )
        .into_response()
}

async fn bootstrap_js() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        BOOTSTRAP_JS,
    )
        .into_response()
}

async fn styles_css() -> Response {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        STYLES_CSS,
    )
        .into_response()
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "name": "kasugai_canvas",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

async fn get_config(State(state): State<AppState>) -> Result<Response, (StatusCode, String)> {
    match std::fs::read_to_string(state.config_path.as_ref()) {
        Ok(config) => Ok((
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            config,
        )
            .into_response()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            String::new(),
        )
            .into_response()),
        Err(error) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("設定ファイルを読み込めません: {error}"),
        )),
    }
}

async fn put_config(
    State(state): State<AppState>,
    config: String,
) -> Result<StatusCode, (StatusCode, String)> {
    std::fs::write(state.config_path.as_ref(), config).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("設定ファイルを保存できません: {error}"),
        )
    })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_update_settings(State(state): State<AppState>) -> Json<UpdateSettings> {
    let settings = std::fs::read_to_string(state.update_config_path.as_ref())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default();
    Json(settings)
}

async fn put_update_settings(
    State(state): State<AppState>,
    Json(settings): Json<UpdateSettings>,
) -> Result<Json<UpdateSettings>, (StatusCode, String)> {
    let content = serde_json::to_string_pretty(&settings).map_err(internal_error)?;
    std::fs::write(state.update_config_path.as_ref(), content).map_err(internal_error)?;
    Ok(Json(settings))
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

async fn fetch_latest() -> Result<Value, (StatusCode, String)> {
    let mut last_error = "最新バージョン情報を取得できませんでした".to_string();
    for url in LATEST_JSON_URLS {
        match reqwest::get(url).await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.text().await {
                    Ok(text) => match serde_json::from_str(&text) {
                        Ok(data) => return Ok(data),
                        Err(error) => last_error = error.to_string(),
                    },
                    Err(error) => last_error = error.to_string(),
                },
                Err(error) => last_error = error.to_string(),
            },
            Err(error) => last_error = error.to_string(),
        }
    }
    Err((StatusCode::BAD_GATEWAY, last_error))
}

async fn update_latest() -> Result<Json<Value>, (StatusCode, String)> {
    Ok(Json(fetch_latest().await?))
}

async fn install_update(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let latest = fetch_latest().await?;
    let url = latest["platforms"]["windows-x86_64"]["url"]
        .as_str()
        .unwrap_or(RELEASE_DOWNLOAD_URL);
    if url != RELEASE_DOWNLOAD_URL {
        return Err((
            StatusCode::BAD_REQUEST,
            "許可されていない更新ファイルURLです".to_string(),
        ));
    }

    let current_exe = std::env::current_exe().map_err(internal_error)?;
    let parent_pid = std::process::id();
    let tmp_dir = std::env::temp_dir().join(format!("kasugai_canvas_update_{parent_pid}"));
    let zip_path = tmp_dir.join("kasugai_canvas.zip");
    let extract_dir = tmp_dir.join("extracted");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(internal_error)?;

    let bytes = reqwest::get(url)
        .await
        .map_err(internal_error)?
        .error_for_status()
        .map_err(internal_error)?
        .bytes()
        .await
        .map_err(internal_error)?;
    tokio::fs::write(&zip_path, bytes)
        .await
        .map_err(internal_error)?;

    let extract_status = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Expand-Archive",
            "-Path",
            &zip_path.to_string_lossy(),
            "-DestinationPath",
            &extract_dir.to_string_lossy(),
            "-Force",
        ])
        .status()
        .await
        .map_err(internal_error)?;
    if !extract_status.success() {
        return Err((StatusCode::BAD_REQUEST, "ZIP展開に失敗しました".to_string()));
    }

    let new_exe = extract_dir.join("kasugai_canvas.exe");
    if !new_exe.exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            "展開後に実行ファイルが見つかりません".to_string(),
        ));
    }

    let script_path = tmp_dir.join("update.ps1");
    let script = format!(
        "$parentPid = {parent_pid}\n$newExe = '{new}'\n$currentExe = '{current}'\nwhile (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 500 }}\nCopy-Item -Path $newExe -Destination $currentExe -Force\nStart-Process -FilePath $currentExe -WindowStyle Hidden\n",
        new = new_exe.to_string_lossy().replace('\'', "''"),
        current = current_exe.to_string_lossy().replace('\'', "''")
    );
    tokio::fs::write(&script_path, script)
        .await
        .map_err(internal_error)?;

    tokio::process::Command::new("powershell")
        .args([
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.to_string_lossy(),
        ])
        .spawn()
        .map_err(internal_error)?;

    let shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        shutdown.notify_one();
    });

    Ok(Json(json!({
        "message": "アップデートを開始しました。数秒後に再起動します。"
    })))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("KASUGAI_CANVAS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8510);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let executable_directory = std::env::current_exe()?
        .parent()
        .ok_or_else(|| std::io::Error::other("実行ファイルのフォルダを取得できません"))?
        .to_path_buf();
    let state = AppState {
        config_path: Arc::new(executable_directory.join(CONFIG_FILE_NAME)),
        update_config_path: Arc::new(executable_directory.join(UPDATE_CONFIG_FILE_NAME)),
        shutdown: Arc::new(Notify::new()),
    };
    let shutdown = state.shutdown.clone();
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/bootstrap.js", get(bootstrap_js))
        .route("/styles.css", get(styles_css))
        .route("/health", get(health))
        .route("/api/config", get(get_config).put(put_config))
        .route(
            "/api/update/settings",
            get(get_update_settings).put(put_update_settings),
        )
        .route("/api/update/latest", get(update_latest))
        .route("/api/update/install", post(install_update))
        .with_state(state);

    println!("KASUGAI Canvas: http://{address}");
    println!(
        "Config: {}",
        executable_directory.join(CONFIG_FILE_NAME).display()
    );
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { shutdown.notified().await })
        .await?;
    Ok(())
}
