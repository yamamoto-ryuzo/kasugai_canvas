#![windows_subsystem = "windows"]

use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

async fn health() -> impl IntoResponse {
    let body = format!(
        r#"{{"status":"ok","version":"{}"}}"#,
        env!("CARGO_PKG_VERSION")
    );
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
}

fn open_browser(port: u16) {
    let url = format!("http://127.0.0.1:{port}/");
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
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

    let web_dir = resolve_dir(&exe_dir, "web", || repo_dir.join("web"));
    let projects_dir = resolve_dir(&exe_dir, "projects", || repo_dir.join("installer/projects"));

    let app = Router::new()
        .route("/health", get(health))
        .nest_service("/projects", ServeDir::new(projects_dir))
        .fallback_service(ServeDir::new(web_dir).append_index_html_on_directories(true));

    let listener = TcpListener::bind(address).await?;
    println!("KASUGAI Canvas: http://{address}");

    if open_browser_requested {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            open_browser(port);
        });
    }

    axum::serve(listener, app).await?;
    Ok(())
}
