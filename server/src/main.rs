#![windows_subsystem = "windows"]

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tower_http::services::ServeDir;

const UPDATE_CONFIG_FILE_NAME: &str = "kasugai_canvas.update.json";
const LATEST_JSON_URLS: [&str; 1] = [
    "https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/latest.json",
];
const REPOSITORY_DOWNLOAD_URL: &str =
    "https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/kasugai_canvas.zip";

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

#[derive(Clone)]
struct AppState {
    update_config_path: Arc<PathBuf>,
    shutdown: Arc<Notify>,
    port: u16,
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "name": "kasugai_canvas",
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.port,
    }))
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

async fn fetch_latest() -> Result<Value, (StatusCode, String)> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut last_error = "最新バージョン情報を取得できませんでした".to_string();
    for url in LATEST_JSON_URLS {
        let busted = format!("{url}?t={now}");
        match reqwest::get(busted.as_str()).await {
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

async fn request_shutdown(State(state): State<AppState>) -> StatusCode {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        state.shutdown.notify_one();
    });
    StatusCode::NO_CONTENT
}

async fn install_update(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let latest = fetch_latest().await?;
    let url = latest["platforms"]["windows-x86_64"]["url"]
        .as_str()
        .unwrap_or(REPOSITORY_DOWNLOAD_URL);
    let allowed = reqwest::Url::parse(REPOSITORY_DOWNLOAD_URL).map_err(internal_error)?;
    let actual = reqwest::Url::parse(url).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "更新ファイルURLが不正です".to_string(),
        )
    })?;
    if actual.host() != allowed.host() || actual.path() != allowed.path() {
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
        "$parentPid = {parent_pid}\n$newExe = '{new}'\n$currentExe = '{current}'\nwhile (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 500 }}\n$ErrorActionPreference = 'Stop'\ntry {{\n    Copy-Item -Path $newExe -Destination $currentExe -Force\n    Start-Process -FilePath $currentExe -WindowStyle Hidden\n}} catch {{\n    Write-Error \"EXEの差し替えに失敗しました: $_\"\n    exit 1\n}}\n",
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

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn open_browser(port: u16) {
    let url = format!("http://127.0.0.1:{port}/");
    let _ = opener::open(&url);
}

fn resolve_dir(exe_dir: &Option<PathBuf>, name: &str, fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    if let Some(dir) = exe_dir {
        let candidate = dir.join(name);
        if candidate.exists() {
            return candidate;
        }
    }
    fallback()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("KASUGAI_CANVAS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8510);
    let address = SocketAddr::from(([127, 0, 0, 1], port));

    let open_browser_requested = std::env::args().any(|arg| arg == "--open-browser");

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from));
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_dir = manifest_dir
        .parent()
        .ok_or("Cargo manifest has no parent directory")?;

    let executable_directory = exe_dir.as_ref().cloned().unwrap_or_else(|| repo_dir.to_path_buf());
    let web_dir = resolve_dir(&exe_dir, "web", || repo_dir.join("web"));
    let projects_dir = resolve_dir(&exe_dir, "projects", || repo_dir.join("installer/projects"));

    let state = AppState {
        update_config_path: Arc::new(executable_directory.join(UPDATE_CONFIG_FILE_NAME)),
        shutdown: Arc::new(Notify::new()),
        port,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route(
            "/api/update/settings",
            get(get_update_settings).put(put_update_settings),
        )
        .route("/api/update/latest", get(update_latest))
        .route("/api/update/install", post(install_update))
        .route("/api/shutdown", post(request_shutdown))
        .nest_service("/projects", ServeDir::new(projects_dir))
        .fallback_service(ServeDir::new(web_dir).append_index_html_on_directories(true))
        .with_state(state.clone());

    let listener = TcpListener::bind(address).await?;
    println!("KASUGAI Canvas: http://{address}");

    if open_browser_requested {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            open_browser(port);
        });
    }

    let shutdown = state.shutdown.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { shutdown.notified().await })
        .await?;
    Ok(())
}
