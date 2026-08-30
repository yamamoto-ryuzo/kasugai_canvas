#![windows_subsystem = "windows"]

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex as TokioMutex, Notify};

const _WEB_ASSET_HASH: &str = env!("WEB_ASSET_HASH");
const INDEX_HTML: &str = include_str!("../../web/index.html");
const APP_JS: &str = include_str!("../../web/app.js");
const STYLES_CSS: &str = include_str!("../../web/styles.css");
const FAVICON_ICO: &[u8] = include_bytes!("../../web/favicon.ico");
const CONFIG_FILE_NAME: &str = "kasugai_canvas.config";
const PROJECTS_DIRECTORY_NAME: &str = "projects";
const PROJECT_CONFIG_FILE_NAME: &str = "kasugai_canvas.config";
const PROJECT_MANIFEST_FILE_NAME: &str = "project.json";
const UPDATE_CONFIG_FILE_NAME: &str = "kasugai_canvas.update.json";
const LATEST_JSON_URLS: [&str; 1] = [
    "https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/latest.json",
];
const REPOSITORY_DOWNLOAD_URL: &str =
    "https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/kasugai_canvas.zip";

#[derive(Clone)]
struct TileFetch {
    body: Vec<u8>,
    status: u16,
    content_type: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct TileMeta {
    etag: Option<String>,
    last_modified: Option<String>,
}

type TileResult = Result<TileFetch, (StatusCode, String)>;

#[derive(Clone)]
struct AppState {
    config_path: Arc<PathBuf>,
    projects_path: Arc<PathBuf>,
    update_config_path: Arc<PathBuf>,
    shutdown: Arc<Notify>,
    port: u16,
    cache_path: Arc<PathBuf>,
    client: reqwest::Client,
    in_flight: Arc<TokioMutex<HashMap<String, broadcast::Sender<TileResult>>>>,
}

#[derive(Deserialize)]
struct InfoQuery {
    url: String,
}

#[derive(Deserialize)]
struct SearchQuery {
    query: String,
    appid: Option<String>,
}

#[derive(Deserialize)]
struct TileQuery {
    url: String,
    ttl: Option<u64>,
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
    project: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    id: String,
    title: String,
}

#[derive(Deserialize)]
struct ProjectManifest {
    title: Option<String>,
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

async fn index() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
        INDEX_HTML,
    )
        .into_response()
}

async fn app_js() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        APP_JS,
    )
        .into_response()
}

async fn styles_css() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        STYLES_CSS,
    )
        .into_response()
}

async fn favicon() -> Response {
    ([(header::CONTENT_TYPE, "image/x-icon")], FAVICON_ICO).into_response()
}

async fn proxy_info(Query(query): Query<InfoQuery>) -> Result<Html<String>, (StatusCode, String)> {
    let url = reqwest::Url::parse(&query.url)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INFO URLが不正です".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "INFO URLはhttpまたはhttpsで指定してください".to_string(),
        ));
    }
    let response = reqwest::get(url)
        .await
        .map_err(internal_error)?
        .error_for_status()
        .map_err(internal_error)?;
    let content = response.text().await.map_err(internal_error)?;
    Ok(Html(content))
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "name": "kasugai_canvas",
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.port,
    }))
}

async fn proxy_search(
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if query.query.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "検索語が空です".to_string()));
    }
    let (url, yahoo) = if let Some(appid) = query
        .appid
        .filter(|value| !value.trim().is_empty() && !value.contains("あなたのYahoo"))
    {
        let mut url = reqwest::Url::parse("https://map.yahooapis.jp/search/V1/LocalSearch")
            .map_err(internal_error)?;
        url.query_pairs_mut()
            .append_pair("appid", &appid)
            .append_pair("query", query.query.trim())
            .append_pair("output", "json");
        (url, true)
    } else {
        let mut url = reqwest::Url::parse("https://msearch.gsi.go.jp/address-search/AddressSearch")
            .map_err(internal_error)?;
        url.query_pairs_mut().append_pair("q", query.query.trim());
        (url, false)
    };
    let client = reqwest::Client::builder()
        .user_agent(concat!("kasugai_canvas/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(internal_error)?;
    let data = client
        .get(url)
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(internal_error)?
        .error_for_status()
        .map_err(internal_error)?
        .json::<Value>()
        .await
        .map_err(internal_error)?;
    if yahoo && !data.is_object() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Yahoo検索の応答が不正です".to_string(),
        ));
    }
    Ok(Json(data))
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

fn valid_project_id(project_id: &str) -> bool {
    !project_id.is_empty()
        && project_id != "."
        && project_id != ".."
        && project_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn project_config_path(
    state: &AppState,
    project_id: &str,
) -> Result<PathBuf, (StatusCode, String)> {
    if !valid_project_id(project_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "不正なプロジェクトIDです".to_string(),
        ));
    }
    Ok(state
        .projects_path
        .join(project_id)
        .join(PROJECT_CONFIG_FILE_NAME))
}

async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProjectSummary>>, (StatusCode, String)> {
    let mut projects = Vec::new();
    let entries = match std::fs::read_dir(state.projects_path.as_ref()) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Json(projects)),
        Err(error) => return Err(internal_error(error)),
    };
    for entry in entries {
        let entry = entry.map_err(internal_error)?;
        if !entry.file_type().map_err(internal_error)?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_project_id(&id) {
            continue;
        }
        let manifest_path = entry.path().join(PROJECT_MANIFEST_FILE_NAME);
        let title = std::fs::read_to_string(manifest_path)
            .ok()
            .and_then(|content| serde_json::from_str::<ProjectManifest>(&content).ok())
            .and_then(|manifest| manifest.title)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| id.clone());
        projects.push(ProjectSummary { id, title });
    }
    projects.sort_by(|left, right| left.title.cmp(&right.title));
    Ok(Json(projects))
}

async fn get_project_config(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let path = project_config_path(&state, &project_id)?;
    match std::fs::read_to_string(path) {
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
        Err(error) => Err(internal_error(error)),
    }
}

async fn put_project_config(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    config: String,
) -> Result<StatusCode, (StatusCode, String)> {
    let path = project_config_path(&state, &project_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(internal_error)?;
    }
    std::fs::write(path, config).map_err(internal_error)?;
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

fn content_type_from_path(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("json") => "application/json",
        Some("geojson") => "application/geo+json",
        Some("kml") => "application/vnd.google-earth.kml+xml",
        Some("kmz") => "application/vnd.google-earth.kmz",
        Some("gltf") => "model/gltf+json",
        Some("glb") => "model/gltf-binary",
        Some("b3dm") => "application/octet-stream",
        Some("i3dm") => "application/octet-stream",
        Some("pnts") => "application/octet-stream",
        Some("cmpt") => "application/octet-stream",
        Some("terrain") => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn content_type_from_url(url: &reqwest::Url) -> &'static str {
    if let Some(last) = url.path_segments().and_then(|mut s| s.next_back()) {
        let lower = last.to_lowercase();
        let pseudo = std::path::Path::new(&lower);
        return content_type_from_path(pseudo);
    }
    "application/octet-stream"
}

fn tile_cache_key(url: &reqwest::Url) -> String {
    let mut hasher = DefaultHasher::new();
    url.as_str().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

enum CacheState {
    None,
    Fresh(Vec<u8>),
}

async fn read_cached(cache_path: &std::path::Path, key: &str, ttl: u64) -> CacheState {
    let ttl_file = cache_path.join(format!("{key}.ttl"));
    let cache_file = cache_path.join(format!("{key}.bin"));
    let now = now_secs();
    let expires = tokio::fs::read_to_string(&ttl_file)
        .await
        .ok()
        .and_then(|text| text.parse::<u64>().ok());
    if let Some(expires) = expires {
        if now < expires {
            if let Ok(body) = tokio::fs::read(&cache_file).await {
                if expires - now < 7 * 24 * 60 * 60 {
                    let _ = tokio::fs::write(&ttl_file, (now + ttl).to_string()).await;
                }
                return CacheState::Fresh(body);
            }
        } else if now < expires + ttl {
            if let Ok(body) = tokio::fs::read(&cache_file).await {
                let _ = tokio::fs::write(&ttl_file, (now + ttl).to_string()).await;
                return CacheState::Fresh(body);
            }
        }
    } else if let Ok(body) = tokio::fs::read(&cache_file).await {
        let _ = tokio::fs::write(&ttl_file, (now + ttl).to_string()).await;
        return CacheState::Fresh(body);
    }
    CacheState::None
}

async fn do_fetch_and_save(
    client: &reqwest::Client,
    cache_path: &std::path::Path,
    url: &reqwest::Url,
    key: &str,
    ttl: u64,
) -> Result<TileFetch, (StatusCode, String)> {
    let meta_file = cache_path.join(format!("{key}.meta"));
    let ttl_file = cache_path.join(format!("{key}.ttl"));
    let cache_file = cache_path.join(format!("{key}.bin"));
    let meta = tokio::fs::read_to_string(&meta_file)
        .await
        .ok()
        .and_then(|text| serde_json::from_str::<TileMeta>(&text).ok())
        .unwrap_or_default();
    let mut request = client.get(url.as_str());
    if let Some(etag) = &meta.etag {
        request = request.header(header::IF_NONE_MATCH, etag);
    }
    if let Some(last_modified) = &meta.last_modified {
        request = request.header(header::IF_MODIFIED_SINCE, last_modified);
    }
    let response = request.send().await.map_err(internal_error)?;
    let status = response.status().as_u16();
    let response_etag = response
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(String::from);
    let response_last_modified = response
        .headers()
        .get(header::LAST_MODIFIED)
        .and_then(|value| value.to_str().ok())
        .map(String::from);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| content_type_from_url(url).to_string());
    if status == 304 {
        let body = tokio::fs::read(&cache_file).await.map_err(internal_error)?;
        let _ = tokio::fs::write(&ttl_file, (now_secs() + ttl).to_string()).await;
        return Ok(TileFetch {
            body,
            status: 200,
            content_type,
        });
    }
    let bytes = response.bytes().await.map_err(internal_error)?;
    let body = bytes.to_vec();
    if (200..=299).contains(&status) {
        if let Some(parent) = cache_file.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&cache_file, &body).await;
        let _ = tokio::fs::write(&ttl_file, (now_secs() + ttl).to_string()).await;
        let new_meta = TileMeta {
            etag: response_etag.clone(),
            last_modified: response_last_modified.clone(),
        };
        let _ = tokio::fs::write(
            &meta_file,
            serde_json::to_string(&new_meta).unwrap_or_default(),
        )
        .await;
    }
    Ok(TileFetch {
        body,
        status,
        content_type,
    })
}

async fn fetch_unique_tile(
    state: &AppState,
    url: &reqwest::Url,
    key: &str,
    ttl: u64,
) -> Result<TileFetch, (StatusCode, String)> {
    match read_cached(&state.cache_path, key, ttl).await {
        CacheState::Fresh(body) => {
            return Ok(TileFetch {
                body,
                status: 200,
                content_type: content_type_from_url(url).to_string(),
            });
        }
        _ => {}
    }

    let tx = {
        let mut guard = state.in_flight.lock().await;
        if let Some(tx) = guard.get(key) {
            let mut rx = tx.subscribe();
            drop(guard);
            let result = rx.recv().await.map_err(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "in-flight channel closed".to_string())
            })?;
            return result;
        }
        let (tx, _rx) = broadcast::channel::<TileResult>(1);
        guard.insert(key.to_string(), tx.clone());
        tx
    };

    let result = do_fetch_and_save(&state.client, &state.cache_path, url, key, ttl).await;
    let _ = tx.send(result.clone());
    let mut guard = state.in_flight.lock().await;
    guard.remove(key);
    drop(guard);
    result
}

async fn proxy_tile(
    Query(query): Query<TileQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let url = reqwest::Url::parse(&query.url)
        .map_err(|_| (StatusCode::BAD_REQUEST, "タイルURLが不正です".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "タイルURLはhttpまたはhttpsを指定してください".to_string(),
        ));
    }
    let ttl = query.ttl.unwrap_or(2592000);
    let cache_key = tile_cache_key(&url);
    if let CacheState::Fresh(body) = read_cached(&state.cache_path, &cache_key, ttl).await {
        let content_type = content_type_from_url(&url);
        return Ok((
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "public, max-age=2592000"),
            ],
            body,
        )
            .into_response());
    }
    let tile = fetch_unique_tile(&state, &url, &cache_key, ttl).await?;
    let status = StatusCode::from_u16(tile.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let cache = if status.is_success() {
        "public, max-age=2592000"
    } else {
        "public, max-age=0"
    };
    Ok((
        status,
        [
            (header::CONTENT_TYPE, tile.content_type.as_str()),
            (header::CACHE_CONTROL, cache),
        ],
        tile.body,
    )
        .into_response())
}

fn hex_decode(input: &str) -> Result<Vec<u8>, (StatusCode, String)> {
    if input.len() % 2 != 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "タイルディレクトリが不正です".to_string(),
        ));
    }
    let mut result = Vec::with_capacity(input.len() / 2);
    for chunk in input.as_bytes().chunks(2) {
        let s = std::str::from_utf8(chunk).map_err(|_| {
            (StatusCode::BAD_REQUEST, "タイルディレクトリのデコードに失敗しました".to_string())
        })?;
        let b = u8::from_str_radix(s, 16).map_err(|_| {
            (StatusCode::BAD_REQUEST, "タイルディレクトリのデコードに失敗しました".to_string())
        })?;
        result.push(b);
    }
    Ok(result)
}

async fn proxy_tile_path(
    Path(target): Path<String>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let (hex, rest) = target.split_once('/').unwrap_or((&target, ""));
    if hex.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "タイルディレクトリが指定されていません".to_string(),
        ));
    }
    let dir_bytes = hex_decode(hex)?;
    let mut dir = String::from_utf8(dir_bytes)
        .map_err(|_| (StatusCode::BAD_REQUEST, "タイルディレクトリが不正です".to_string()))?;
    if !dir.ends_with('/') {
        dir.push('/');
    }
    let full = format!("{}{}", dir, rest);
    let url = reqwest::Url::parse(&full)
        .map_err(|_| (StatusCode::BAD_REQUEST, "タイルURLが不正です".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "タイルURLはhttpまたはhttpsを指定してください".to_string(),
        ));
    }
    let ttl = 2592000;
    let cache_key = tile_cache_key(&url);
    if let CacheState::Fresh(body) = read_cached(&state.cache_path, &cache_key, ttl).await {
        let content_type = content_type_from_url(&url);
        return Ok((
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "public, max-age=2592000"),
            ],
            body,
        )
            .into_response());
    }
    let tile = fetch_unique_tile(&state, &url, &cache_key, ttl).await?;
    let status = StatusCode::from_u16(tile.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let cache = if status.is_success() {
        "public, max-age=2592000"
    } else {
        "public, max-age=0"
    };
    Ok((
        status,
        [
            (header::CONTENT_TYPE, tile.content_type.as_str()),
            (header::CACHE_CONTROL, cache),
        ],
        tile.body,
    )
        .into_response())
}

async fn serve_local_file(
    Query(query): Query<FileQuery>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let base = if let Some(project) = query.project.as_deref().filter(|v| valid_project_id(v)) {
        state.projects_path.join(project)
    } else {
        state.projects_path.as_ref().clone()
    };
    let requested = base.join(&query.path);
    let canonical = requested.canonicalize().map_err(|error| {
        (
            StatusCode::NOT_FOUND,
            format!("ファイルが見つかりません: {error}"),
        )
    })?;
    let base_canonical = base.canonicalize().map_err(|error| {
        (
            StatusCode::NOT_FOUND,
            format!("ベースフォルダが見つかりません: {error}"),
        )
    })?;
    if !canonical.starts_with(&base_canonical) {
        return Err((
            StatusCode::FORBIDDEN,
            "指定されたファイルへのアクセスは許可されていません".to_string(),
        ));
    }
    let bytes = tokio::fs::read(&canonical).await.map_err(internal_error)?;
    let content_type = content_type_from_path(&canonical);
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        bytes,
    )
        .into_response())
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

async fn put_local_file(
    Query(query): Query<FileQuery>,
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let base = if let Some(project) = query.project.as_deref().filter(|v| valid_project_id(v)) {
        state.projects_path.join(project)
    } else {
        state.projects_path.as_ref().clone()
    };
    tokio::fs::create_dir_all(&base).await.map_err(internal_error)?;
    let base_canonical = base.canonicalize().map_err(|error| {
        (
            StatusCode::NOT_FOUND,
            format!("ベースフォルダが見つかりません: {error}"),
        )
    })?;
    let requested = base.join(&query.path);
    let parent = requested.parent().unwrap_or(&base).to_path_buf();
    tokio::fs::create_dir_all(&parent).await.map_err(internal_error)?;
    let parent_canonical = parent.canonicalize().map_err(|error| {
        (
            StatusCode::FORBIDDEN,
            format!("指定されたフォルダにアクセスできません: {error}"),
        )
    })?;
    if !parent_canonical.starts_with(&base_canonical) {
        return Err((
            StatusCode::FORBIDDEN,
            "指定されたファイルへのアクセスは許可されていません".to_string(),
        ));
    }
    let file_name = requested.file_name().and_then(|n| n.to_str()).ok_or((
        StatusCode::BAD_REQUEST,
        "不正なファイル名です".to_string(),
    ))?;
    let file_path = parent_canonical.join(file_name);
    tokio::fs::write(&file_path, body).await.map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_files(
    Query(query): Query<FileQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let base = if let Some(project) = query.project.as_deref().filter(|v| valid_project_id(v)) {
        state.projects_path.join(project)
    } else {
        state.projects_path.as_ref().clone()
    };
    tokio::fs::create_dir_all(&base).await.map_err(internal_error)?;
    let mut files = Vec::new();
    let mut entries = tokio::fs::read_dir(&base).await.map_err(internal_error)?;
    while let Some(entry) = entries.next_entry().await.map_err(internal_error)? {
        if entry.file_type().await.map_err(internal_error)?.is_file() {
            files.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok(Json(files))
}

async fn open_local_file(
    Query(query): Query<FileQuery>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    let base = if let Some(project) = query.project.as_deref().filter(|v| valid_project_id(v)) {
        state.projects_path.join(project)
    } else {
        state.projects_path.as_ref().clone()
    };
    tokio::fs::create_dir_all(&base).await.map_err(internal_error)?;
    let base_canonical = base.canonicalize().map_err(|error| {
        (
            StatusCode::NOT_FOUND,
            format!("ベースフォルダが見つかりません: {error}"),
        )
    })?;
    let requested = base.join(&query.path);
    let parent = requested.parent().unwrap_or(&base).to_path_buf();
    if !parent.exists() {
        let _ = tokio::fs::create_dir_all(&parent).await;
    }
    let parent_canonical = parent.canonicalize().unwrap_or(base_canonical.clone());
    if !parent_canonical.starts_with(&base_canonical) {
        return Err((
            StatusCode::FORBIDDEN,
            "指定されたフォルダへのアクセスは許可されていません".to_string(),
        ));
    }
    if !parent_canonical.exists() {
        return Err((StatusCode::NOT_FOUND, "フォルダが見つかりません".to_string()));
    }
    let open_path = parent_canonical.to_string_lossy().into_owned();
    let open_path = open_path.strip_prefix(r"\\?\").unwrap_or(&open_path).to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(open_path).spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open").arg(open_path).spawn();
    }
    Ok(StatusCode::NO_CONTENT)
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

async fn request_shutdown(State(state): State<AppState>) -> StatusCode {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        state.shutdown.notify_one();
    });
    StatusCode::NO_CONTENT
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
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

async fn is_running_server(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    let Ok(response) = reqwest::get(url).await else {
        return false;
    };
    let Ok(data) = response.json::<Value>().await else {
        return false;
    };
    data.get("name").and_then(Value::as_str) == Some("kasugai_canvas")
}

async fn install_update(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let latest = fetch_latest().await?;
    let url = latest["platforms"]["windows-x86_64"]["url"]
        .as_str()
        .unwrap_or(REPOSITORY_DOWNLOAD_URL);
    if url != REPOSITORY_DOWNLOAD_URL {
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
    let projects_path = executable_directory.join(PROJECTS_DIRECTORY_NAME);
    std::fs::create_dir_all(&projects_path)?;
    let default_project_path = projects_path.join("default");
    let default_project_config = default_project_path.join(PROJECT_CONFIG_FILE_NAME);
    let legacy_config_path = executable_directory.join(CONFIG_FILE_NAME);
    if !default_project_config.exists() && legacy_config_path.exists() {
        std::fs::create_dir_all(&default_project_path)?;
        std::fs::copy(&legacy_config_path, &default_project_config)?;
        std::fs::write(
            default_project_path.join(PROJECT_MANIFEST_FILE_NAME),
            r#"{
  "title": "デフォルトプロジェクト"
}
"#,
        )?;
    }
    let cache_path = executable_directory.join("cache");
    tokio::fs::create_dir_all(&cache_path).await?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("kasugai_canvas/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let state = AppState {
        config_path: Arc::new(executable_directory.join(CONFIG_FILE_NAME)),
        projects_path: Arc::new(projects_path),
        update_config_path: Arc::new(executable_directory.join(UPDATE_CONFIG_FILE_NAME)),
        shutdown: Arc::new(Notify::new()),
        port,
        cache_path: Arc::new(cache_path),
        client,
        in_flight: Arc::new(TokioMutex::new(HashMap::new())),
    };
    let shutdown = state.shutdown.clone();
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/styles.css", get(styles_css))
        .route("/favicon.ico", get(favicon))
        .route("/health", get(health))
        .route("/api/info", get(proxy_info))
        .route("/api/search", get(proxy_search))
        .route("/api/tile", get(proxy_tile))
        .route("/api/tile/{*target}", get(proxy_tile_path))
        .route("/api/file", get(serve_local_file).put(put_local_file))
        .route("/api/files", get(list_files))
        .route("/api/open", post(open_local_file))
        .route("/api/projects", get(list_projects))
        .route(
            "/api/projects/{project_id}/config",
            get(get_project_config).put(put_project_config),
        )
        .route("/api/shutdown", post(request_shutdown))
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
    let open_browser_requested = std::env::args().any(|argument| argument == "--open-browser");
    let listener = if open_browser_requested {
        let mut listener = None;
        for attempt in 0..60 {
            match tokio::net::TcpListener::bind(address).await {
                Ok(l) => {
                    listener = Some(l);
                    break;
                }
                Err(_) if is_running_server(port).await => {
                    if attempt == 0 {
                        println!("KASUGAI Canvas は既にポート {port} で起動しています。古いインスタンスを停止します。");
                    }
                    let stop_url = format!("http://127.0.0.1:{port}/api/shutdown");
                    let _ = reqwest::Client::new().post(&stop_url).send().await;
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
        if let Some(listener) = listener {
            listener
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("KASUGAI Canvas: ポート {port} の解放を待ちましたが、起動できません"),
            )
            .into());
        }
    } else {
        tokio::net::TcpListener::bind(address).await?
    };
    if open_browser_requested {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            open_browser(port);
        });
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { shutdown.notified().await })
        .await?;
    Ok(())
}
