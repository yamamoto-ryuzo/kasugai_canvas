#![windows_subsystem = "windows"]

use axum::http::header;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::net::SocketAddr;

const INDEX_HTML: &str = include_str!("../../web/index.html");
const APP_JS: &str = include_str!("../../web/app.js");
const STYLES_CSS: &str = include_str!("../../web/styles.css");

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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("KASUGAI_CANVAS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3800);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/styles.css", get(styles_css))
        .route("/health", get(health));

    println!("KASUGAI Canvas: http://{address}");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

