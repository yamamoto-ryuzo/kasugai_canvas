#![windows_subsystem = "windows"]

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

const INDEX_HTML: &str = include_str!("../../web/index.html");
const APP_JS: &str = include_str!("../../web/app.js");
const STYLES_CSS: &str = include_str!("../../web/styles.css");
const CONFIG_FILE_NAME: &str = "kasugai_canvas.config";

#[derive(Clone)]
struct AppState {
    config_path: Arc<PathBuf>,
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn app_js() -> Response {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], APP_JS).into_response()
}

async fn styles_css() -> Response {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], STYLES_CSS).into_response()
}

async fn health() -> &'static str {
    "ok"
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
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/styles.css", get(styles_css))
        .route("/health", get(health))
        .route("/api/config", get(get_config).put(put_config))
        .with_state(state.clone());

    println!("KASUGAI Canvas: http://{address}");
    println!("Config: {}", state.config_path.display());
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
