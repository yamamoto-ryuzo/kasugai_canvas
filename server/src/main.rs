#![windows_subsystem = "windows"]

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use tower::ServiceExt;
use tower_http::services::ServeDir;

const UPDATE_CONFIG_FILE_NAME: &str = "kasugai_canvas.update.json";
const CLOUD_CONFIG_FILE_NAME: &str = "kasugai_canvas.cloud.json";
// 外部プロジェクト(.kasc ファイル関連付け等で登録された、インストール外の
// フォルダにあるプロジェクト)の永続化レジストリ
const EXTERNAL_PROJECTS_FILE_NAME: &str = "kasugai_canvas.projects.json";
const KASC_FILE_NAME: &str = "kasugai_canvas.kasc";
const GROUP_MANIFEST_FILE_NAME: &str = "projects.json";
const LATEST_JSON_URLS: [&str; 1] =
    ["https://raw.githubusercontent.com/yamamoto-ryuzo/kasugai_canvas/main/download/latest.json"];
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

// .kasc ファイルから起動(または /api/projects/register)した、
// projects/ 以外の場所にあるプロジェクト。dir がプロジェクトルートになり、
// /projects/<id>/ でそのフォルダを配信する。相対パス(DATA/ 等)は dir 基準
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalProject {
    id: String,
    title: String,
    // プロジェクトルートの絶対パス
    dir: String,
    // dir 内の実際の .kasc ファイル名(kasugai_canvas.kasc 以外でも可)
    kasc: String,
}

#[derive(Clone)]
struct AppState {
    update_config_path: Arc<PathBuf>,
    cloud_config_path: Arc<PathBuf>,
    external_projects_path: Arc<PathBuf>,
    external_projects: Arc<StdMutex<Vec<ExternalProject>>>,
    cloud: Arc<Mutex<CloudState>>,
    shutdown: Arc<Notify>,
    port: u16,
    web_dir: Arc<PathBuf>,
    projects_dir: Arc<PathBuf>,
    // ローカル実行(127.0.0.1バインド)のとき true。高権限APIの公開可否判定に使う
    is_local: bool,
}

// /api/fetch の上限とタイムアウト
const FETCH_MAX_BYTES: usize = 20 * 1024 * 1024;
const FETCH_TIMEOUT_SECS: u64 = 30;
// プラグインIDはファイル名・plugins.json の双方に使うため厳密に制限する
fn is_valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
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

// バックエンドの能力を返す。フロントはこれで tier(local/workers/static)と
// 利用可能機能を判別し、ツール定義・UI を出し分ける
async fn capabilities(State(state): State<AppState>) -> Json<Value> {
    let mut features = vec![
        "fetchProxy",
        "fetchRange",
        "pluginWrite",
        "fileWrite",
        "update",
        "shutdown",
    ];
    // ローカル実行のみ rclone 連携を公開する(0.0.0.0 バインドのコンテナ実行では無効)
    if state.is_local {
        features.push("cloudRclone");
    }
    Json(json!({
        "tier": "local",
        "name": "kasugai_canvas",
        "version": env!("CARGO_PKG_VERSION"),
        "features": features
    }))
}

#[derive(Deserialize)]
struct FetchQuery {
    url: String,
}

// CORS 非対応の外部データを取り込むための GET/HEAD プロキシ。
// ローカルサーバー(127.0.0.1バインド)前提の機能で、呼び出し元はこのPCのブラウザのみ。
// GET の Range ヘッダーを転送し 206 をそのまま返すため、DuckDB-WASM の httpfs による
// Parquet の範囲読み(metadata・row group スキップ)がこの経路でも機能する。
// 応答はいったんバッファするため、Range 無しの全件 GET は FETCH_MAX_BYTES 上限のまま
async fn fetch_proxy(
    method: Method,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<FetchQuery>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let url = reqwest::Url::parse(&query.url)
        .map_err(|_| (StatusCode::BAD_REQUEST, "URLが不正です".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err((
            StatusCode::BAD_REQUEST,
            "http/https のみ取得できます".to_string(),
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(internal_error)?;
    let is_head = method == Method::HEAD;
    let upstream_method = if is_head {
        reqwest::Method::HEAD
    } else {
        reqwest::Method::GET
    };
    let mut request = client.request(upstream_method, url);
    if !is_head {
        if let Some(range) = headers
            .get(axum::http::header::RANGE)
            .and_then(|v| v.to_str().ok())
        {
            request = request.header(reqwest::header::RANGE, range);
        }
    }
    let response = request.send().await.map_err(internal_error)?;
    let status = response.status();
    let mut builder = axum::response::Response::builder().status(status);
    for key in [
        axum::http::header::CONTENT_TYPE,
        axum::http::header::CONTENT_LENGTH,
        axum::http::header::CONTENT_RANGE,
        axum::http::header::ACCEPT_RANGES,
        axum::http::header::ETAG,
        axum::http::header::LAST_MODIFIED,
    ] {
        if let Some(value) = response.headers().get(&key) {
            builder = builder.header(key, value.clone());
        }
    }
    if is_head {
        return builder
            .body(axum::body::Body::empty())
            .map_err(internal_error);
    }
    let bytes = response.bytes().await.map_err(internal_error)?;
    if bytes.len() > FETCH_MAX_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "取得データが上限を超えています".to_string(),
        ));
    }
    builder
        .body(axum::body::Body::from(bytes))
        .map_err(internal_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSaveRequest {
    id: String,
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    layer: Option<Value>,
    code: String,
}

// plugins.json の plugins 配列を更新する（同 id は置き換え、remove=true で削除）
fn update_plugins_json(
    web_dir: &PathBuf,
    id: &str,
    entry: Option<Value>,
) -> Result<(), (StatusCode, String)> {
    let path = web_dir.join("plugins.json");
    let mut doc: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({ "version": "1.0.0", "plugins": [] }));
    let plugins = doc
        .pointer_mut("/plugins")
        .and_then(Value::as_array_mut)
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugins.json の形式が不正です".to_string(),
        ))?;
    plugins.retain(|p| p.get("id").and_then(Value::as_str) != Some(id));
    if let Some(entry) = entry {
        plugins.push(entry);
    }
    let text = serde_json::to_string_pretty(&doc).map_err(internal_error)?;
    std::fs::write(&path, text).map_err(internal_error)
}

// AI生成・ユーザー取込みのストレージプラグインを配布用 PLUGIN/ へ昇格させる。
// 実ファイルを書き換える破壊的操作のため、フロント側では確認ダイアログ必須とする
async fn save_plugin(
    State(state): State<AppState>,
    Json(request): Json<PluginSaveRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !is_valid_plugin_id(&request.id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "プラグインIDは半角英数・-・_ のみ使用できます".to_string(),
        ));
    }
    if request.code.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "code が空です".to_string()));
    }
    let plugin_dir = state.web_dir.join("PLUGIN").join(&request.id);
    tokio::fs::create_dir_all(&plugin_dir)
        .await
        .map_err(internal_error)?;
    tokio::fs::write(plugin_dir.join("plugin.js"), &request.code)
        .await
        .map_err(internal_error)?;
    let manifest = json!({
        "id": request.id,
        "name": request.name.clone().unwrap_or_else(|| request.id.clone()),
        "version": request.version.clone().unwrap_or_else(|| "0.1.0".to_string()),
        "description": request.description.clone().unwrap_or_default(),
    });
    let manifest_text = serde_json::to_string_pretty(&manifest).map_err(internal_error)?;
    tokio::fs::write(plugin_dir.join("manifest.json"), manifest_text)
        .await
        .map_err(internal_error)?;

    let mut entry = json!({
        "id": request.id,
        "name": request.name.unwrap_or_else(|| request.id.clone()),
        "version": request.version.unwrap_or_else(|| "0.1.0".to_string()),
        "url": format!("./PLUGIN/{}/plugin.js", request.id),
    });
    if let Some(layer) = request.layer {
        entry["layer"] = layer;
    }
    update_plugins_json(&state.web_dir, &request.id, Some(entry))?;
    Ok(Json(json!({ "ok": true, "id": request.id })))
}

async fn delete_plugin(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !is_valid_plugin_id(&id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "プラグインIDが不正です".to_string(),
        ));
    }
    let plugin_dir = state.web_dir.join("PLUGIN").join(&id);
    if plugin_dir.exists() {
        tokio::fs::remove_dir_all(&plugin_dir)
            .await
            .map_err(internal_error)?;
    }
    update_plugins_json(&state.web_dir, &id, None)?;
    Ok(Json(json!({ "ok": true, "id": id })))
}

// /api/files のアップロード上限
const FILE_WRITE_MAX_BYTES: usize = 64 * 1024 * 1024;

// プロジェクトIDはフォルダ名に使うため plugins.json の id 規則に準拠（"."も許可するが先頭は不可）
fn is_valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

// プロジェクトIDからプロジェクトルートを解決する。
// 外部プロジェクト(.kasc 登録)はそのフォルダ、それ以外は projects/<id>
fn resolve_project_dir(state: &AppState, id: &str) -> Result<PathBuf, (StatusCode, String)> {
    if !is_valid_project_id(id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "プロジェクトIDが不正です".to_string(),
        ));
    }
    let external = state
        .external_projects
        .lock()
        .ok()
        .and_then(|list| list.iter().find(|e| e.id == id).cloned());
    if let Some(ext) = external {
        return Ok(PathBuf::from(ext.dir));
    }
    Ok(state.projects_dir.join(id))
}

// <project_dir>/DATA/ 以下の相対パスを検証して絶対パスへ解決する。
// ".." やドライブ指定・バックスラッシュを拒否し、書き込みを DATA/ 内に限定する
fn resolve_data_path(project_dir: &Path, rel: &str) -> Result<PathBuf, (StatusCode, String)> {
    let mut path = project_dir.join("DATA");
    if rel.is_empty() {
        return Ok(path);
    }
    if rel.len() > 512 {
        return Err((StatusCode::BAD_REQUEST, "パスが長すぎます".to_string()));
    }
    for segment in rel.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment
                .chars()
                .any(|c| c.is_control() || c == '\\' || c == ':')
        {
            return Err((StatusCode::BAD_REQUEST, "ファイル名が不正です".to_string()));
        }
        path.push(segment);
    }
    Ok(path)
}

#[derive(Deserialize)]
struct FileListQuery {
    project: String,
}

// GET /api/files?project=<id> → DATA/ 内のファイル一覧（再帰・相対パス）
async fn list_data_files(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<FileListQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let dir = resolve_data_path(&resolve_project_dir(&state, &query.project)?, "")?;
    let mut files = Vec::new();
    let mut stack = vec![dir.clone()];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(&dir) {
                let meta = entry.metadata().ok();
                files.push(json!({
                    "name": rel.to_string_lossy().replace('\\', "/"),
                    "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    "modified": meta
                        .and_then(|m| m.modified().ok())
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64),
                }));
            }
        }
    }
    files.sort_by_key(|f| f["name"].as_str().unwrap_or("").to_string());
    Ok(Json(json!({ "files": files })))
}

// PUT /api/files/{project}/{*path} → DATA/ へボディをそのまま書き込む。
// ローカルサーバー(127.0.0.1)前提の高権限API。フロント側では上書き時に確認ダイアログを挟む
async fn write_data_file(
    State(state): State<AppState>,
    axum::extract::Path((project, rel)): axum::extract::Path<(String, String)>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = resolve_data_path(&resolve_project_dir(&state, &project)?, &rel)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(internal_error)?;
    }
    tokio::fs::write(&path, &body)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true, "name": rel })))
}

async fn delete_data_file(
    State(state): State<AppState>,
    axum::extract::Path((project, rel)): axum::extract::Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = resolve_data_path(&resolve_project_dir(&state, &project)?, &rel)?;
    if path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            "フォルダは削除できません".to_string(),
        ));
    }
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(internal_error)?;
    }
    Ok(Json(json!({ "ok": true, "name": rel })))
}

// ---- クラウドストレージ連携 (rclone) ----
// ローカルサーバー(127.0.0.1バインド)時のみルート登録される高権限API群。
// rclone を子プロセスとして管理し、`rclone serve webdav` でローカルWebDAVを
// 立てて、アプリ内からは /api/cloud/file プロキシ、OS からは net use の
// ドライブ割当で利用する。書き込み可否は起動時の --read-only で固定する。

// クラウドプロキシの読み込み上限(Range付きGETはこの上限を受けない)
const CLOUD_FILE_MAX_BYTES: usize = 256 * 1024 * 1024;
// /api/cloud/file PUT のアップロード上限
const CLOUD_WRITE_MAX_BYTES: usize = 64 * 1024 * 1024;
const CLOUD_FETCH_TIMEOUT_SECS: u64 = 120;

#[derive(Default)]
struct CloudState {
    serve: Option<CloudServe>,
}

struct CloudServe {
    child: tokio::process::Child,
    remote: String,
    // rclone に渡すリモート指定。"box" または "box,root_folder_id=123" のような
    // バックエンドフラグ付きの形式を取り得る
    remote_spec: String,
    root: String,
    folder_id: Option<String>,
    port: u16,
    read_only: bool,
    drive: Option<String>,
}

fn load_cloud_config(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}))
}

fn save_cloud_config(path: &Path, config: &Value) -> Result<(), (StatusCode, String)> {
    let text = serde_json::to_string_pretty(config).map_err(internal_error)?;
    std::fs::write(path, text).map_err(internal_error)
}

// rclone の既定配置先。配布版が C:\kasugai\kasugai_canvas\ に入るため
// 共有フォルダとして C:\kasugai\rclone\rclone.exe を既定とする。
// 非Windowsでは exe 隣の rclone/ を使う
fn default_rclone_exe(state: &AppState) -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from(r"C:\kasugai\rclone\rclone.exe");
    }
    state
        .cloud_config_path
        .parent()
        .map(|dir| dir.join("rclone").join("rclone"))
        .unwrap_or_else(|| PathBuf::from("rclone"))
}

// rclone 実行ファイルを解決する。設定ファイルの明示パス → PATH → 既定配置先の順
async fn rclone_exe(state: &AppState) -> Option<PathBuf> {
    let config = load_cloud_config(&state.cloud_config_path);
    if let Some(configured) = config["rclonePath"].as_str() {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }
    let which = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = tokio::process::Command::new(which)
        .arg("rclone")
        .output()
        .await
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first) = stdout.lines().next() {
                let path = PathBuf::from(first.trim());
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    let default = default_rclone_exe(state);
    if default.is_file() {
        return Some(default);
    }
    None
}

// Windows ではコンソールウィンドウが一瞬出るのを防ぐ
fn new_rclone_command(exe: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(exe);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

// rclone リモート名。"box" / "box:" どちらも受け付ける(保持時は ":" 無し)
fn normalize_remote_name(name: &str) -> Option<String> {
    let trimmed = name.trim().strip_suffix(':').unwrap_or(name.trim());
    if !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        Some(trimmed.to_string())
    } else {
        None
    }
}

// クラウド内の相対パス検証。resolve_data_path と同じ方針で ".." 等を拒否
fn is_valid_cloud_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment
                    .chars()
                    .any(|c| c.is_control() || c == '\\' || c == ':')
        })
}

// ルートフォルダ指定。空は許可、指定時はパス規則と同じ。前後 "/" は畳む
fn normalize_cloud_root(root: &str) -> Result<String, (StatusCode, String)> {
    let trimmed = root.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if is_valid_cloud_path(trimmed) {
        Ok(trimmed.to_string())
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "ルートフォルダの指定が不正です".to_string(),
        ))
    }
}

// ルートフォルダ指定の解釈結果。パスか、フォルダURLから解決したフォルダID
enum CloudRoot {
    Path(String),
    FolderId(String),
}

// "config dump" からリモートのバックエンド種別(box/drive/...)を取得する
async fn rclone_remote_type(exe: &Path, remote: &str) -> Result<String, (StatusCode, String)> {
    let dump = run_rclone_json(exe, &["config", "dump"]).await?;
    dump.get(remote)
        .and_then(|r| r.get("type"))
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("リモート {remote} が見つかりません"),
            )
        })
}

// ルートフォルダ指定を解釈する。パスならそのまま、フォルダURL(http...)なら
// フォルダIDを取り出し remote,root_folder_id=<id>: 起点で接続する。
// 権限・共有経路によってリモート内の見える位置が変わっても、ID起点なら
// 全員が同じフォルダをルートとして参照できる
async fn resolve_cloud_root(
    exe: &Path,
    remote: &str,
    input: &str,
) -> Result<CloudRoot, (StatusCode, String)> {
    let input = input.trim();
    if !input.starts_with("http://") && !input.starts_with("https://") {
        return Ok(CloudRoot::Path(normalize_cloud_root(input)?));
    }
    let remote_type = rclone_remote_type(exe, remote).await?;
    let url = reqwest::Url::parse(input).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "ルートフォルダのURLが不正です".to_string(),
        )
    })?;
    let segments: Vec<String> = url
        .path_segments()
        .map(|s| s.map(String::from).collect())
        .unwrap_or_default();
    let folder_id = match remote_type.as_str() {
        // https://*.box.com/folder/<id> または共有リンク /s/<slug>
        "box" => match segments.iter().position(|s| s == "folder") {
            Some(pos) => segments.get(pos + 1).cloned(),
            None if segments.iter().any(|s| s == "s") => {
                return resolve_box_shared_link(exe, remote, input)
                    .await
                    .map(CloudRoot::FolderId);
            }
            None => None,
        },
        // https://drive.google.com/drive/folders/<id>
        "drive" => segments
            .iter()
            .position(|s| s == "folders")
            .and_then(|pos| segments.get(pos + 1))
            .cloned(),
        // OneDrive/SharePoint 系は ?id=<アイテムID>
        "onedrive" | "pcloud" => url
            .query_pairs()
            .find(|(key, _)| key == "id")
            .map(|(_, value)| value.into_owned()),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "{remote_type} ではフォルダURL指定に対応していません。フォルダパスを入力してください"
                ),
            ));
        }
    }
    .ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "フォルダURLからIDを取得できませんでした".to_string(),
        )
    })?;
    if folder_id.is_empty()
        || !folder_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '!' | '.'))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "フォルダURLからIDを取得できませんでした".to_string(),
        ));
    }
    Ok(CloudRoot::FolderId(folder_id))
}

// Box の共有リンク(/s/<slug>)を Box API の shared_items でフォルダIDに解決する。
// アクセストークンは rclone.conf の token から読む
async fn resolve_box_shared_link(
    exe: &Path,
    remote: &str,
    url: &str,
) -> Result<String, (StatusCode, String)> {
    // rclone を一度叩いてトークンを最新化してから conf を読む
    let _ = new_rclone_command(exe)
        .args(["lsd", &format!("{remote}:")])
        .output()
        .await;
    let dump = run_rclone_json(exe, &["config", "dump"]).await?;
    let token = dump
        .get(remote)
        .and_then(|r| r.get("token"))
        .and_then(Value::as_str)
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|t| t.get("access_token")?.as_str().map(String::from))
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "Box のアクセストークンを取得できませんでした".to_string(),
            )
        })?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(internal_error)?
        .get("https://api.box.com/2.0/shared_items")
        .bearer_auth(token)
        .header("BoxApi", format!("shared_link={url}"))
        .send()
        .await
        .map_err(internal_error)?;
    let body: Value = response.json().await.map_err(internal_error)?;
    if body.get("type").and_then(Value::as_str) != Some("folder") {
        let detail = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("フォルダではないかアクセスできません");
        return Err((
            StatusCode::BAD_REQUEST,
            format!("共有リンクの解決に失敗しました: {detail}"),
        ));
    }
    body.get("id")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "共有リンクからフォルダIDを取得できませんでした".to_string(),
            )
        })
}

// serve 中のリモート起点 "remote:root" 形式の文字列を作る
fn serve_target(serve: &CloudServe, path: &str) -> String {
    match (serve.root.is_empty(), path.is_empty()) {
        (true, true) => format!("{}:", serve.remote_spec),
        (true, false) => format!("{}:{}", serve.remote_spec, path),
        (false, true) => format!("{}:{}", serve.remote_spec, serve.root),
        (false, false) => format!("{}:{}/{}", serve.remote_spec, serve.root, path),
    }
}

// serve 中のWebDAVのURLを作る(セグメントはパーセントエンコード)
fn serve_url(port: u16, path: &str) -> Result<reqwest::Url, (StatusCode, String)> {
    let base = reqwest::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(internal_error)?;
    if path.is_empty() {
        return Ok(base);
    }
    let mut url = base.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| internal_error("URLの構築に失敗しました"))?;
        for segment in path.split('/') {
            segments.push(segment);
        }
    }
    Ok(url)
}

fn serve_info(serve: &CloudServe) -> Value {
    json!({
        "remote": serve.remote,
        "root": serve.root,
        "folderId": serve.folder_id,
        "port": serve.port,
        "readOnly": serve.read_only,
        "drive": serve.drive,
    })
}

async fn run_rclone_json(exe: &Path, args: &[&str]) -> Result<Value, (StatusCode, String)> {
    let output = new_rclone_command(exe)
        .args(args)
        .output()
        .await
        .map_err(internal_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("rclone が失敗しました: {}", stderr.trim()),
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(internal_error)
}

async fn cloud_status(State(state): State<AppState>) -> Json<Value> {
    let exe = rclone_exe(&state).await;
    let mut version = Value::Null;
    let mut remotes: Vec<String> = Vec::new();
    if let Some(exe) = &exe {
        if let Ok(output) = new_rclone_command(exe).arg("version").output().await {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                // "rclone v1.75.2" → "v1.75.2" に整形
                let line = line.trim();
                version = json!(line.strip_prefix("rclone ").unwrap_or(line));
            }
        }
        if let Ok(output) = new_rclone_command(exe).arg("listremotes").output().await {
            if output.status.success() {
                remotes = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(|line| line.trim().trim_end_matches(':'))
                    .filter(|line| !line.is_empty())
                    .map(String::from)
                    .collect();
            }
        }
    }
    let serving = state
        .cloud
        .lock()
        .await
        .serve
        .as_ref()
        .map(serve_info)
        .unwrap_or(Value::Null);
    Json(json!({
        "os": std::env::consts::OS,
        "installed": exe.is_some(),
        "path": exe.map(|p| p.to_string_lossy().to_string()),
        "version": version,
        "remotes": remotes,
        "serving": serving,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudPathRequest {
    path: String,
}

// rclone.exe のパスを明示指定して保存する
async fn cloud_set_path(
    State(state): State<AppState>,
    Json(request): Json<CloudPathRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = PathBuf::from(request.path.trim());
    if !path.is_file() {
        return Err((
            StatusCode::BAD_REQUEST,
            "指定されたファイルが見つかりません".to_string(),
        ));
    }
    let mut config = load_cloud_config(&state.cloud_config_path);
    config["rclonePath"] = json!(path.to_string_lossy());
    save_cloud_config(&state.cloud_config_path, &config)?;
    Ok(Json(json!({ "ok": true, "path": path.to_string_lossy() })))
}

// rclone 未導入時に公式配布 zip をダウンロードして exe 隣の rclone/ に配置する
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudInstallRequest {
    dir: Option<String>,
}

async fn cloud_install(
    State(state): State<AppState>,
    Json(request): Json<CloudInstallRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let url = if cfg!(all(windows, target_arch = "x86_64")) {
        "https://downloads.rclone.org/rclone-current-windows-amd64.zip"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "https://downloads.rclone.org/rclone-current-osx-arm64.zip"
    } else if cfg!(all(target_os = "macos")) {
        "https://downloads.rclone.org/rclone-current-osx-amd64.zip"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "https://downloads.rclone.org/rclone-current-linux-amd64.zip"
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            "このOSでは自動インストールに対応していません".to_string(),
        ));
    };
    let bytes = reqwest::get(url)
        .await
        .map_err(internal_error)?
        .error_for_status()
        .map_err(internal_error)?
        .bytes()
        .await
        .map_err(internal_error)?;
    let tmp_dir = std::env::temp_dir().join(format!("kasugai_rclone_{}", std::process::id()));
    let zip_path = tmp_dir.join("rclone.zip");
    let extract_dir = tmp_dir.join("extracted");
    tokio::fs::create_dir_all(&extract_dir)
        .await
        .map_err(internal_error)?;
    tokio::fs::write(&zip_path, bytes)
        .await
        .map_err(internal_error)?;
    #[cfg(windows)]
    {
        let status = tokio::process::Command::new("powershell")
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
        if !status.success() {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "ZIP展開に失敗しました".to_string(),
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let status = tokio::process::Command::new("unzip")
            .args(["-o", "-q"])
            .arg(&zip_path)
            .arg("-d")
            .arg(&extract_dir)
            .status()
            .await
            .map_err(internal_error)?;
        if !status.success() {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "ZIP展開に失敗しました".to_string(),
            ));
        }
    }
    // rclone-vX.Y.Z-<os>-<arch>/rclone[.exe] を探して exe 隣の rclone/ へ移す
    let exe_name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    let mut found = None;
    if let Ok(entries) = std::fs::read_dir(&extract_dir) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(exe_name);
            if candidate.is_file() {
                found = Some(candidate);
                break;
            }
        }
    }
    let found = found.ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "展開後に rclone が見つかりません".to_string(),
    ))?;
    let dest = match request
        .dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        Some(dir) => {
            if dir.len() > 260 || dir.chars().any(|c| c.is_control()) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "インストール先が不正です".to_string(),
                ));
            }
            PathBuf::from(dir).join(exe_name)
        }
        None => default_rclone_exe(&state),
    };
    if let Some(dest_dir) = dest.parent() {
        tokio::fs::create_dir_all(dest_dir)
            .await
            .map_err(internal_error)?;
    }
    tokio::fs::copy(&found, &dest)
        .await
        .map_err(internal_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(internal_error)?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(internal_error)?;
    }
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let mut config = load_cloud_config(&state.cloud_config_path);
    config["rclonePath"] = json!(dest.to_string_lossy());
    save_cloud_config(&state.cloud_config_path, &config)?;
    Ok(Json(json!({ "ok": true, "path": dest.to_string_lossy() })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudConfigRequest {
    name: String,
    #[serde(rename = "type")]
    remote_type: String,
}

// リモートを新規追加する。rclone config create がブラウザでOAuth認可を開始するため
// 呼び出しは即時返し、フロントは /api/cloud/status の remotes をポーリングする
async fn cloud_config(
    State(state): State<AppState>,
    Json(request): Json<CloudConfigRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let name = normalize_remote_name(&request.name).ok_or((
        StatusCode::BAD_REQUEST,
        "リモート名は半角英数・-・_・. のみ使用できます".to_string(),
    ))?;
    let remote_type = request.remote_type.trim();
    if remote_type.is_empty()
        || remote_type.len() > 32
        || !remote_type
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err((StatusCode::BAD_REQUEST, "種別が不正です".to_string()));
    }
    let exe = rclone_exe(&state).await.ok_or((
        StatusCode::BAD_REQUEST,
        "rclone が見つかりません".to_string(),
    ))?;
    new_rclone_command(&exe)
        .args(["config", "create", &name, remote_type])
        .spawn()
        .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true, "name": name })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudServeRequest {
    remote: String,
    #[serde(default)]
    root: String,
    #[serde(default)]
    read_only: bool,
    drive: Option<String>,
}

// 占有していない localhost ポートを拾う
fn pick_free_port() -> Result<u16, (StatusCode, String)> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(internal_error)?;
    let port = listener.local_addr().map_err(internal_error)?.port();
    drop(listener);
    Ok(port)
}

// Windows の net use で WebDAV をドライブに割り当てる
#[cfg(windows)]
async fn mount_drive(drive: &str, port: u16) -> Result<(), (StatusCode, String)> {
    let letter = format!("{}:", drive);
    let _ = tokio::process::Command::new("net")
        .args(["use", &letter, "/delete", "/y"])
        .output()
        .await;
    let url = format!("http://127.0.0.1:{port}");
    let output = tokio::process::Command::new("net")
        .args(["use", &letter, &url])
        .output()
        .await
        .map_err(internal_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "ドライブ割り当てに失敗しました: {}{}",
                stdout.trim(),
                stderr.trim()
            ),
        ));
    }
    Ok(())
}

#[cfg(windows)]
async fn unmount_drive(drive: &str) {
    let letter = format!("{}:", drive);
    let _ = tokio::process::Command::new("net")
        .args(["use", &letter, "/delete", "/y"])
        .output()
        .await;
}

fn normalize_drive(drive: &str) -> Result<String, (StatusCode, String)> {
    let letter = drive.trim().trim_end_matches(':').to_ascii_uppercase();
    if letter.len() == 1 && letter.chars().next().unwrap().is_ascii_alphabetic() {
        Ok(letter)
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "ドライブレターが不正です".to_string(),
        ))
    }
}

// rclone serve webdav を起動し、必要ならドライブ割当まで行う。
// 既に serve 中なら一度停止して新しい設定で立て直す
async fn cloud_serve(
    State(state): State<AppState>,
    Json(request): Json<CloudServeRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let remote = normalize_remote_name(&request.remote)
        .ok_or((StatusCode::BAD_REQUEST, "リモート名が不正です".to_string()))?;
    let drive = match request.drive.as_deref() {
        Some(drive) if !drive.trim().is_empty() => Some(normalize_drive(drive)?),
        _ => None,
    };
    #[cfg(not(windows))]
    if drive.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            "ドライブ割当は Windows のみ対応しています".to_string(),
        ));
    }
    let exe = rclone_exe(&state).await.ok_or((
        StatusCode::BAD_REQUEST,
        "rclone が見つかりません。パスを指定するかダウンロードしてください".to_string(),
    ))?;
    // ルート指定: フォルダパスか、フォルダURL(→フォルダID起点)
    let (root, remote_spec, folder_id) =
        match resolve_cloud_root(&exe, &remote, &request.root).await? {
            CloudRoot::Path(path) => (path, remote.clone(), None),
            CloudRoot::FolderId(id) => (
                String::new(),
                format!("{remote},root_folder_id={id}"),
                Some(id),
            ),
        };

    // 既存 serve の停止(ドライブ割当も解除)
    {
        let mut cloud = state.cloud.lock().await;
        if let Some(mut serve) = cloud.serve.take() {
            let _ = serve.child.kill().await;
            #[cfg(windows)]
            if let Some(drive) = &serve.drive {
                unmount_drive(drive).await;
            }
        }
    }

    let port = pick_free_port()?;
    let target = format!("{remote_spec}:{root}");
    let mut command = new_rclone_command(&exe);
    command.args([
        "serve",
        "webdav",
        &target,
        "--addr",
        &format!("127.0.0.1:{port}"),
        "--vfs-cache-mode",
        "full",
        "--dir-cache-time",
        "10s",
    ]);
    if request.read_only {
        command.arg("--read-only");
    }
    let mut child = command.kill_on_drop(true).spawn().map_err(internal_error)?;

    // WebDAV が応答するまで待つ(初回はOAuthトークン更新等で時間がかかることがある)
    let check_url = format!("http://127.0.0.1:{port}/");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(internal_error)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if let Ok(response) = client.get(&check_url).send().await {
            if response.status().is_success() || response.status() == StatusCode::UNAUTHORIZED {
                break;
            }
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill().await;
            return Err((
                StatusCode::BAD_GATEWAY,
                "クラウドへの接続がタイムアウトしました".to_string(),
            ));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err((
                StatusCode::BAD_GATEWAY,
                format!("rclone serve が終了しました: {status}"),
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    #[cfg(windows)]
    if let Some(drive) = &drive {
        if let Err(error) = mount_drive(drive, port).await {
            let _ = child.kill().await;
            return Err(error);
        }
    }

    let serve = CloudServe {
        child,
        remote,
        remote_spec,
        root,
        folder_id,
        port,
        read_only: request.read_only,
        drive,
    };
    let info = serve_info(&serve);
    state.cloud.lock().await.serve = Some(serve);
    Ok(Json(json!({ "ok": true, "serving": info })))
}

async fn cloud_stop(State(state): State<AppState>) -> Result<Json<Value>, (StatusCode, String)> {
    let mut cloud = state.cloud.lock().await;
    if let Some(mut serve) = cloud.serve.take() {
        let _ = serve.child.kill().await;
        #[cfg(windows)]
        if let Some(drive) = &serve.drive {
            unmount_drive(drive).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudDriveRequest {
    action: String,
    drive: String,
}

// serve 中の WebDAV に対するドライブ割当/解除だけを行う
async fn cloud_drive(
    State(state): State<AppState>,
    Json(request): Json<CloudDriveRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    #[cfg(not(windows))]
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "ドライブ割当は Windows のみ対応しています".to_string(),
        ));
    }
    #[cfg(windows)]
    {
        let drive = normalize_drive(&request.drive)?;
        let mut cloud = state.cloud.lock().await;
        let serve = cloud.serve.as_mut().ok_or((
            StatusCode::CONFLICT,
            "クラウドに接続していません".to_string(),
        ))?;
        match request.action.as_str() {
            "mount" => {
                mount_drive(&drive, serve.port).await?;
                serve.drive = Some(drive.clone());
                Ok(Json(json!({ "ok": true, "drive": drive })))
            }
            "unmount" => {
                unmount_drive(&drive).await;
                if serve.drive.as_deref() == Some(drive.as_str()) {
                    serve.drive = None;
                }
                Ok(Json(json!({ "ok": true })))
            }
            _ => Err((StatusCode::BAD_REQUEST, "action が不正です".to_string())),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudLocalizeRequest {
    project: String,
    #[serde(default)]
    scope: LocalizeScope,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum LocalizeScope {
    Project,
    #[default]
    Shared,
}

static LOCALIZE_LOCK: Mutex<()> = Mutex::const_new(());

// ディレクトリを再帰的にコピーする。シンボリックリンクは辿らない。
// skip_top は最上位階層だけで除外するファイル・フォルダ名(大文字小文字無視)
async fn copy_dir_all(
    src: &Path,
    dst: &Path,
    skip_top: &[&str],
) -> Result<(), (StatusCode, String)> {
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf(), true)];
    while let Some((from_dir, to_dir, is_top)) = stack.pop() {
        tokio::fs::create_dir_all(&to_dir)
            .await
            .map_err(internal_error)?;
        let mut entries = tokio::fs::read_dir(&from_dir)
            .await
            .map_err(internal_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(internal_error)? {
            let name = entry.file_name();
            if is_top && skip_top.iter().any(|skip| name.eq_ignore_ascii_case(*skip)) {
                continue;
            }
            let file_type = entry.file_type().await.map_err(internal_error)?;
            if file_type.is_dir() {
                stack.push((entry.path(), to_dir.join(&name), false));
            } else if file_type.is_file() {
                tokio::fs::copy(entry.path(), to_dir.join(&name))
                    .await
                    .map_err(internal_error)?;
            }
        }
    }
    Ok(())
}

// ディレクトリを再帰的に削除する。Windows で残りがちな読み取り専用属性は
// 外して削除し、シンボリックリンクはリンク自体だけを消す(中身は辿らない)
fn remove_dir_all_forced(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.is_dir() {
        for entry in std::fs::read_dir(path)? {
            remove_dir_all_forced(&entry?.path())?;
        }
        std::fs::remove_dir(path)
    } else {
        let mut permissions = meta.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(path, permissions);
        }
        std::fs::remove_file(path)
    }
}

// 直前に書き込んだファイルが AV スキャン等で一時ロックされて削除に
// 失敗することがあるため、一定回数リトライする
fn remove_dir_all_retry(path: &Path) -> std::io::Result<()> {
    let mut last_error = None;
    for _ in 0..10 {
        match remove_dir_all_forced(path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }
    Err(last_error
        .unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "remove_dir_all failed")))
}

fn localize_output_path(root: &Path, rel: &str) -> Result<PathBuf, (StatusCode, String)> {
    let path = resolve_data_path(root, rel)?;
    let mut current = root.to_path_buf();
    for component in path
        .strip_prefix(root)
        .map_err(internal_error)?
        .components()
    {
        current.push(component);
        if let Ok(meta) = std::fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() || !normalize_fs_path(&current).starts_with(root) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "保存先のリンクは使用できません".to_string(),
                ));
            }
        }
    }
    Ok(path)
}

// 複製内の .kasc から見た DATA/ の位置。共有は _local/ 直下、
// 専用は複製プロジェクト内に置く
fn localize_output_scope(
    local_root: &Path,
    project_dir: &Path,
    scope: LocalizeScope,
) -> (PathBuf, &'static str) {
    match scope {
        LocalizeScope::Shared => (local_root.to_path_buf(), "../DATA"),
        LocalizeScope::Project => (project_dir.to_path_buf(), "DATA"),
    }
}

// ---- 納品用ローカル化(.kasc 内のリモート参照の DATA/ 化) ----
// 参照の置き換え先は出所で分ける: クラウド由来は DATA/cloud/、
// 一般の http(s) URL は DATA/http/(ファイル名→取得元URLは DATA/http/_sources.json)

// 1ファイルのダウンロード上限(タイル系は対象外のためこの程度で十分)
const LOCALIZE_FILE_MAX_BYTES: usize = 256 * 1024 * 1024;

// 大文字小文字を無視した接頭辞マッチ。マッチしたら残りを返す
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    s.get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &s[prefix.len()..])
}

fn is_remote_url(text: &str) -> bool {
    strip_prefix_ci(text, "https://").is_some() || strip_prefix_ci(text, "http://").is_some()
}

// github.com の /raw/・/blob/ URL を raw.githubusercontent.com へ正規化する。
// フロントの normalizeRemoteUrl と同じ変換で、同一ファイルの重複取得を防ぐ
fn normalize_remote_url(url: &str) -> String {
    let rest = match strip_prefix_ci(url, "https://github.com/")
        .or_else(|| strip_prefix_ci(url, "http://github.com/"))
    {
        Some(rest) => rest,
        None => return url.to_string(),
    };
    let mut parts = rest.splitn(4, '/');
    let (Some(owner), Some(repo), Some(kind), Some(tail)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return url.to_string();
    };
    if !kind.eq_ignore_ascii_case("raw") && !kind.eq_ignore_ascii_case("blob") {
        return url.to_string();
    }
    format!("https://raw.githubusercontent.com/{owner}/{repo}/{tail}")
}

// ファイル名衝突時の接尾辞用。ビルド・実行間で安定したハッシュ(FNV-1a)
fn fnv1a64(text: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split_file_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    }
}

// Windows で作れない文字・末尾ドット/空白を除き、空なら download にする
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim_end();
    let mut name = if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    };
    let device = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
    {
        name.insert(0, '_');
    }
    if name.chars().count() > 120 {
        let (stem, ext) = split_file_ext(&name);
        let keep = 120usize.saturating_sub(ext.chars().count()).max(8);
        let stem: String = stem.chars().take(keep).collect();
        name = format!("{stem}{ext}");
    }
    name
}

// URL の basename(パーセントデコード済み)から保存ファイル名を作る。
// duckdb: の拡張子自動判別等があるため拡張子は維持する
fn localize_file_name(url: &str) -> String {
    let base = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.path_segments().map(|segments| {
                segments
                    .filter(|segment| !segment.is_empty())
                    .next_back()
                    .unwrap_or("")
                    .to_string()
            })
        })
        .unwrap_or_default();
    sanitize_file_name(&percent_decode(&base))
}

// 正規化済み URL 一覧に DATA/http/ 内の保存先を割り当てる。
// 同一 URL は常に同名(重複アドレスは1ファイルに簡素化)で、
// 別 URL の同名衝突だけ hash 接尾辞を付ける
fn read_localize_sources(
    path: &Path,
) -> Result<serde_json::Map<String, Value>, (StatusCode, String)> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| {
            (
                StatusCode::CONFLICT,
                "出典一覧が壊れています。保存先を確認してください".to_string(),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(error) => Err(internal_error(error)),
    }
}

fn assign_localize_names(
    urls: &[String],
    sources: &serde_json::Map<String, Value>,
    occupied: &HashSet<String>,
) -> HashMap<String, String> {
    let mut by_url = HashMap::new();
    let mut used: HashMap<String, String> = occupied
        .iter()
        .map(|name| (name.to_lowercase(), String::new()))
        .collect();
    used.insert("_sources.json".to_string(), String::new());
    for (rel, source) in sources {
        if let (Some(name), Some(url)) = (rel.strip_prefix("http/"), source.as_str()) {
            if !name.eq_ignore_ascii_case("_sources.json")
                && !name.contains('/')
                && sanitize_file_name(name) == name
            {
                used.insert(name.to_lowercase(), url.to_string());
                by_url.entry(url.to_string()).or_insert_with(|| rel.clone());
            }
        }
    }
    for url in urls {
        if by_url.contains_key(url) {
            continue;
        }
        let mut name = localize_file_name(url);
        if used
            .get(&name.to_lowercase())
            .is_some_and(|used_url| used_url != url)
        {
            let (stem, ext) = split_file_ext(&name);
            let mut candidate = format!("{stem}--{:016x}{ext}", fnv1a64(url));
            let mut n = 2u32;
            while used
                .get(&candidate.to_lowercase())
                .is_some_and(|used_url| used_url != url)
            {
                candidate = format!("{stem}--{:016x}-{n}{ext}", fnv1a64(url));
                n += 1;
            }
            name = candidate;
        }
        used.insert(name.to_lowercase(), url.clone());
        by_url.insert(url.clone(), format!("http/{name}"));
    }
    by_url
}

// リモート参照の出現位置。置換文字列の形が位置によって異なる
// Field: DATA/http/x または ../DATA/http/x(resolveProjectUrl で解決する)
// Sql:   同じ相対パスを保存し、実行時に resolveProjectSql で解決する
#[derive(Clone, Copy)]
enum RefPos {
    Field,
    Sql,
}

// 行タイプごとの URL フィールド位置(| 区切りの先頭フィールドを 0 とする)。
// タイル系(xyz/base/3dtiles)は DATA/http/ の単体取得では対象外で None を
// 返す(3dtiles は tileset.json ツリーごと取るため collect_tileset_urls で
// 別系統として収集する)
fn kasc_url_field_index(line_type: &str, field_count: usize) -> Option<usize> {
    match line_type {
        "geojson" | "layer" | "geoparquet" | "flatgeobuf" | "gpkg" | "geopackage" | "duckdb"
        | "fly_geojson" => Some(1),
        "info" => Some(0),
        "legend" => field_count.checked_sub(1),
        _ => None,
    }
}

// ローカル参照・リモート置換の書き換え対象フィールド。xyz/base のリモート
// URL は取得しないがローカルファイルを参照しうるし、3dtiles は
// DATA/http/3dtiles/ への参照に書き換えるため、全レイヤー行を対象にする
fn kasc_local_ref_field_index(line_type: &str, field_count: usize) -> Option<usize> {
    match line_type {
        "xyz" | "base" | "3dtiles" => Some(1),
        _ => kasc_url_field_index(line_type, field_count),
    }
}

// 複製では既存 DATA/ の中身を DATA/local/ に集約するため、既存のローカル
// 参照を local/ 入りに書き換える。リモート URL・cloud: は対象外
fn localize_data_ref(text: &str) -> Option<String> {
    if is_remote_url(text) || strip_prefix_ci(text, "cloud:").is_some() {
        return None;
    }
    if let Some(rest) = strip_prefix_ci(text, "data/") {
        return Some(format!("DATA/local/{rest}"));
    }
    if let Some(rest) = strip_prefix_ci(text, "./data/") {
        return Some(format!("DATA/local/{rest}"));
    }
    if let Some(rest) = strip_prefix_ci(text, "../data/") {
        return Some(format!("../DATA/local/{rest}"));
    }
    None
}

// | 区切りフィールド1つの書き換え。
// cloud: → cloud_prefix(指定時のみ)、URLフィールド・style=/qml= 値 → lookup の結果
fn rewrite_kasc_field(
    part: &str,
    is_url_field: bool,
    cloud_prefix: Option<&str>,
    lookup: &mut impl FnMut(&str, RefPos) -> Option<String>,
) -> String {
    let trimmed = part.trim_start();
    let indent = &part[..part.len() - trimmed.len()];
    if let Some(prefix) = cloud_prefix {
        if let Some(rest) = strip_prefix_ci(trimmed, "cloud:") {
            // ../ 等を含む参照は DATA/ に置き換えるとプロジェクト外に出るため書き換えない
            if is_valid_cloud_path(rest) {
                return format!("{indent}{prefix}/{rest}");
            }
            return part.to_string();
        }
    }
    // 末尾空白は値に含めない(同一URLが末尾空白の有無で別扱いになるのを防ぐ)
    let url_text = trimmed.trim_end();
    if is_url_field {
        if let Some(replacement) = lookup(url_text, RefPos::Field) {
            let trail = &trimmed[url_text.len()..];
            return format!("{indent}{replacement}{trail}");
        }
        return part.to_string();
    }
    // style=/qml= オプション値(前後空白許容)
    if let Some(eq) = trimmed.find('=') {
        let key = trimmed[..eq].trim();
        if key.eq_ignore_ascii_case("style") || key.eq_ignore_ascii_case("qml") {
            let after_eq = &trimmed[eq + 1..];
            let lead = after_eq.len() - after_eq.trim_start().len();
            let value = after_eq[lead..].trim_end();
            if let Some(replacement) = lookup(value, RefPos::Field) {
                let trail = &after_eq[lead + value.len()..];
                return format!(
                    "{indent}{}{}{replacement}{trail}",
                    &trimmed[..eq + 1],
                    &after_eq[..lead]
                );
            }
        }
    }
    part.to_string()
}

// sql: 行の "|" 直後にある style=/qml= 末尾オプションの値を書き換える。
// 戻り値は (消費した文字数, 置き換え後テキスト)。対象でなければ None
fn rewrite_sql_tail_option(
    rest: &str,
    lookup: &mut impl FnMut(&str, RefPos) -> Option<String>,
) -> Option<(usize, String)> {
    let lead = rest.len() - rest.trim_start().len();
    let after_ws = &rest[lead..];
    for key in ["style", "qml"] {
        let Some(tail) = strip_prefix_ci(after_ws, key) else {
            continue;
        };
        let mid = tail.len() - tail.trim_start().len();
        let Some(after_eq) = tail[mid..].strip_prefix('=') else {
            continue;
        };
        let lead2 = after_eq.len() - after_eq.trim_start().len();
        let token_end = after_eq[lead2..]
            .find(|ch: char| ch == '|' || ch.is_whitespace())
            .unwrap_or(after_eq[lead2..].len());
        let token = &after_eq[lead2..][..token_end];
        let replacement = lookup(token, RefPos::Field)?;
        let consumed = lead + key.len() + mid + 1 + lead2 + token.len();
        let text = format!(
            "{}{key}{}={}{replacement}",
            &rest[..lead],
            &tail[..mid],
            &after_eq[..lead2]
        );
        return Some((consumed, text));
    }
    None
}

// sql: 行の値部分(タイトルの次の | 以降=クエリ+末尾オプション)中の参照を書き換える。
// クエリ内のクォートリテラルは RefPos::Sql、末尾オプションの style=/qml= は
// RefPos::Field として lookup に渡す。対象判定は lookup 側で行う
fn rewrite_sql_refs(
    value: &str,
    lookup: &mut impl FnMut(&str, RefPos) -> Option<String>,
) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(c) = rest.chars().next() {
        if c == '\'' || c == '"' {
            // クォートリテラル('' はエスケープとして読み飛ばす)
            let mut j = c.len_utf8();
            let mut end = None;
            while j < rest.len() {
                let cj = rest[j..].chars().next().unwrap();
                if cj == c {
                    if rest[j + cj.len_utf8()..].starts_with(c) {
                        j += 2 * cj.len_utf8();
                        continue;
                    }
                    end = Some(j);
                    break;
                }
                j += cj.len_utf8();
            }
            match end {
                Some(end) => {
                    let inner = &rest[c.len_utf8()..end];
                    if let Some(replacement) = lookup(inner, RefPos::Sql) {
                        out.push(c);
                        out.push_str(&replacement);
                        out.push(c);
                        rest = &rest[end + c.len_utf8()..];
                        continue;
                    }
                    out.push_str(&rest[..end + c.len_utf8()]);
                    rest = &rest[end + c.len_utf8()..];
                }
                None => {
                    out.push(c);
                    rest = &rest[c.len_utf8()..];
                }
            }
            continue;
        }
        if c == '|' {
            out.push(c);
            rest = &rest[1..];
            if let Some((consumed, text)) = rewrite_sql_tail_option(rest, lookup) {
                out.push_str(&text);
                rest = &rest[consumed..];
            }
            continue;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn rewrite_kasc_line(
    line: &str,
    cloud_prefix: Option<&str>,
    url_field_index: fn(&str, usize) -> Option<usize>,
    lookup: &mut impl FnMut(&str, RefPos) -> Option<String>,
) -> String {
    let (body, cr) = match line.strip_suffix('\r') {
        Some(body) => (body, "\r"),
        None => (line, ""),
    };
    let Some(sep) = body.find(':') else {
        return line.to_string();
    };
    let line_type = body[..sep].trim().to_ascii_lowercase();
    // cloud: 接続行は、納品先で自動接続(受取側での rclone 自動インストール)が
    // 走らないようコメント化する。クラウド未接続で同期できなかった場合は
    // 参照・行ともそのまま残す
    if line_type == "cloud" {
        if cloud_prefix.is_some() {
            let indent = &body[..body.len() - body.trim_start().len()];
            return format!("{indent}# {}{cr}", body.trim_start());
        }
        return line.to_string();
    }
    let prefix = &body[..sep + 1];
    let value = &body[sep + 1..];
    // sql: のクエリには | を含められるためフィールド分割せず専用スキャンで処理する
    if line_type == "sql" {
        return format!("{prefix}{}{cr}", rewrite_sql_refs(value, lookup));
    }
    let field_count = value.split('|').count();
    let url_index = url_field_index(&line_type, field_count);
    let parts: Vec<String> = value
        .split('|')
        .enumerate()
        .map(|(index, part)| {
            rewrite_kasc_field(part, Some(index) == url_index, cloud_prefix, lookup)
        })
        .collect();
    format!("{prefix}{}{cr}", parts.join("|"))
}

// .kasc 全文の参照を書き換える。lookup は参照の原文を受け取り、
// Some(置換文字列) を返せば差し替え、None なら参照をそのまま残す。
// url_field_index は行タイプごとの URL フィールド位置を返す。
// cloud_prefix=None のとき cloud: 参照・接続行は一切触らない
fn rewrite_kasc_refs(
    text: &str,
    cloud_prefix: Option<&str>,
    url_field_index: fn(&str, usize) -> Option<usize>,
    lookup: &mut impl FnMut(&str, RefPos) -> Option<String>,
) -> String {
    text.split('\n')
        .map(|line| rewrite_kasc_line(line, cloud_prefix, url_field_index, lookup))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_kasc_remote_refs(
    text: &str,
    cloud_prefix: Option<&str>,
    lookup: &mut impl FnMut(&str, RefPos) -> Option<String>,
) -> String {
    rewrite_kasc_refs(text, cloud_prefix, kasc_url_field_index, lookup)
}

// 残った cloud: 参照の数(未同期・書き換え不能の目安として応答に含める)
fn count_cloud_refs(text: &str) -> usize {
    text.split('\n')
        .flat_map(|line| line.split('|'))
        .filter(|part| strip_prefix_ci(part.trim_start(), "cloud:").is_some())
        .count()
}

// ---- 3dtiles のローカル化(tileset.json ツリーごと取得) ----
// 3dtiles: 行のリモート参照は tileset.json 単体では意味を成さないため、
// 参照される外部タイルセット(.json)とコンテンツ(content.uri/contents[].uri)
// を辿って DATA/http/3dtiles/<name>/ 配下に一式取得する(取得元別の構成は
// 他形式と同じ)。ルート tileset.json のディレクトリ配下に収まる参照は階層を
// そのまま保持し、収まらない外部参照は _ext/ に集めて参照元 JSON の uri を
// 書き換える

// 1タイルセットの取得ファイル数上限(全球タイルセット等の暴走防止)
const LOCALIZE_TILESET_MAX_FILES: usize = 10000;

// ベースマップ相当の 3D Tiles サービス(全球カバレッジで APIキー/セッション
// 依存のため納品パッケージへ取り込めないもの)は対象外とし URL を残す
fn is_basemap_tileset_url(url: &str) -> bool {
    let Some(host) = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
    else {
        return false;
    };
    // Google Photorealistic 3D Tiles・Cesium ion 系
    matches!(
        host.as_str(),
        "tile.googleapis.com" | "assets.cesium.com" | "api.cesium.com"
    )
}

// .kasc 内の 3dtiles: 行の URL フィールド(タイトル | URL | ...)を正規化して
// 列挙する。ツリーごとの取得になるため通常の DATA/http/ 収集とは別経路
fn collect_tileset_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    for line in text.split('\n') {
        let body = line.strip_suffix('\r').unwrap_or(line);
        let Some(sep) = body.find(':') else {
            continue;
        };
        if !body[..sep].trim().eq_ignore_ascii_case("3dtiles") {
            continue;
        }
        let url = body[sep + 1..]
            .split('|')
            .nth(1)
            .map(str::trim)
            .unwrap_or_default();
        if is_remote_url(url) {
            let normalized = normalize_remote_url(url);
            if seen.insert(normalized.clone()) {
                urls.push(normalized);
            }
        }
    }
    urls
}

// http/3dtiles/ 内の保存先フォルダ名。tileset.json・root.json 等の汎用
// ファイル名なら親フォルダ名を使い、衝突は呼び出し側で処理する
fn localize_tileset_dir_name(url: &str) -> String {
    let segments: Vec<String> = reqwest::Url::parse(url)
        .ok()
        .map(|u| {
            u.path_segments()
                .map(|s| {
                    s.filter(|segment| !segment.is_empty())
                        .map(percent_decode)
                        .collect()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let stem = segments
        .last()
        .map(|name| split_file_ext(name).0.to_string())
        .unwrap_or_default();
    let name = if stem.is_empty()
        || matches!(
            stem.to_ascii_lowercase().as_str(),
            "tileset" | "root" | "scene" | "index"
        ) {
        segments.iter().rev().nth(1).cloned().unwrap_or(stem)
    } else {
        stem
    };
    sanitize_file_name(&name)
}

// ルート tileset.json のディレクトリ配下に収まる URL なら、そのディレクトリ
// からの相対パス(各セグメントをファイル名用にサニタイズ)を返す
fn tileset_inner_path(root_dir: &reqwest::Url, url: &reqwest::Url) -> Option<String> {
    if url.origin() != root_dir.origin() {
        return None;
    }
    let inner = url.path().strip_prefix(root_dir.path())?;
    let segments: Vec<String> = inner
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| sanitize_file_name(&percent_decode(segment)))
        .collect();
    if segments.is_empty() || segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    Some(segments.join("/"))
}

// ---- xyz: タイルのローカル化(受け皿のみ生成) ----
// xyz: 行のリモート {z}/{x}/{y} テンプレートは、タイル本体の取得範囲が
// 曖昧なため納品側ではダウンロードしない。代わりにユーザーがタイルを配置
// する受け皿 DATA/http/xyz/<name>/ を生成し、参照をそのローカルテンプレート
// へ書き換える(元 URL は http/_sources.json に記録)。base: のベースマップ
// 相当は対象外。ローカル DATA/ 内のテンプレート参照は既存の local/ 集約で
// ディレクトリごと複製される

// xyz: 行の URL フィールドを (受け皿フォルダ名, ローカルテンプレート末尾)
// に分解する。{z}/{x}/{y} 等のプレースホルダを含まない URL は None
fn xyz_template_parts(url: &str) -> Option<(String, String)> {
    let host_start = url.find("://").map(|i| i + 3)?;
    let path_start = url[host_start..].find('/').map(|i| host_start + i + 1)?;
    let path = url[path_start..]
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // プレースホルダを含む最初のセグメント以降をテンプレート末尾とする
    let index = segments.iter().position(|s| s.contains('{'))?;
    let tail = segments[index..].join("/");
    // 座標プレースホルダを含まないもの({s} のみ等)はタイルテンプレートとみなさない
    if !tail.contains("{z}") && !tail.contains("{x}") && !tail.contains("{y}") {
        return None;
    }
    // フォルダ名はプレースホルダ直前の実セグメント。無ければ URL ハッシュ
    let name = segments[..index]
        .last()
        .map(|s| sanitize_file_name(&percent_decode(s)))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("xyz-{:016x}", fnv1a64(url)));
    Some((name, tail))
}

// .kasc 内の xyz: 行のリモートタイルテンプレートを正規化して列挙する
fn collect_xyz_template_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    for line in text.split('\n') {
        let body = line.strip_suffix('\r').unwrap_or(line);
        let Some(sep) = body.find(':') else {
            continue;
        };
        if !body[..sep].trim().eq_ignore_ascii_case("xyz") {
            continue;
        }
        let url = body[sep + 1..]
            .split('|')
            .nth(1)
            .map(str::trim)
            .unwrap_or_default();
        if is_remote_url(url) && xyz_template_parts(url).is_some() {
            let normalized = normalize_remote_url(url);
            if seen.insert(normalized.clone()) {
                urls.push(normalized);
            }
        }
    }
    urls
}

// xyz 受け皿フォルダに書く配置手順メッセージ
fn xyz_container_readme(url: &str, tail: &str) -> String {
    format!(
        "このフォルダは XYZ タイルの受け皿です（納品パッケージ生成で作成）。\n\
         タイル本体は取得していません。以下の階層でタイルファイルを配置してください。\n\n\
         元の参照: {url}\n\
         配置する構造: {tail}\n\
         例: 15/28400/12902.png（{tail} のプレースホルダを座標に置き換えたパス）\n\n\
         タイル画像を Z/X/Y の階層フォルダ（例: QGIS の XYZ Tiles エクスポート、\n\
         gdal2tiles 等の出力）として出力し、このフォルダ直下にコピーしてください。\n\
         表示するズーム範囲・範囲の限定は .kasc の xyz: 行で minZoom= / maxZoom= /\n\
         bbox=西経,南緯,東経,北緯 を指定してください（bbox 指定で範囲外への要求を抑止）。\n"
    )
}

// 保存先フォルダ名の重複を避ける。衝突時は URL ハッシュ接尾辞を付ける
fn localize_unique_dir_name(stem: &str, url: &str, used: &mut HashSet<String>) -> String {
    let mut name = stem.to_string();
    if used.contains(&name.to_lowercase()) {
        let mut candidate = format!("{stem}--{:016x}", fnv1a64(url));
        let mut n = 2u32;
        while used.contains(&candidate.to_lowercase()) {
            candidate = format!("{stem}--{:016x}-{n}", fnv1a64(url));
            n += 1;
        }
        name = candidate;
    }
    used.insert(name.to_lowercase());
    name
}

// {z} 等のプレースホルダを残したまま URI パスをエンコードする
// (Cesium が {z}/{x}/{y} を置換するため、括弧を %7B 等にしてはいけない)
fn encode_uri_template(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut depth = 0u32;
    let mut plain = String::new();
    for ch in path.chars() {
        match ch {
            '{' if depth == 0 => {
                out.push_str(&encode_uri_path(&plain));
                plain.clear();
                depth = 1;
                out.push('{');
            }
            '}' if depth > 0 => {
                depth -= 1;
                out.push('}');
            }
            _ if depth > 0 => out.push(ch),
            _ => plain.push(ch),
        }
    }
    out.push_str(&encode_uri_path(&plain));
    out
}

// implicit tiling のコンテンツ URI は {level}/{x}/{y} テンプレートで、実在
// ファイルの集合が .subtree のビットストリーム依存のためローカル化できない
fn contains_implicit_tiling(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key("implicitTiling") || map.values().any(contains_implicit_tiling)
        }
        Value::Array(items) => items.iter().any(contains_implicit_tiling),
        _ => false,
    }
}

// tileset JSON 内のコンテンツ参照(content.uri・contents[].uri、旧式の url
// キーも)を再帰的に走査する。コールバックで文字列を書き換えると JSON に反映
fn walk_tileset_uris(node: &mut Value, f: &mut impl FnMut(&mut String)) {
    let Some(obj) = node.as_object_mut() else {
        return;
    };
    for key in ["content", "contents"] {
        match obj.get_mut(key) {
            Some(Value::Object(content)) => {
                for uri_key in ["uri", "url"] {
                    if let Some(Value::String(uri)) = content.get_mut(uri_key) {
                        f(uri);
                    }
                }
            }
            Some(Value::Array(items)) => {
                for content in items.iter_mut().filter_map(Value::as_object_mut) {
                    for uri_key in ["uri", "url"] {
                        if let Some(Value::String(uri)) = content.get_mut(uri_key) {
                            f(uri);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    // タイルツリーは root ノードから children へ再帰する構造
    if let Some(root) = obj.get_mut("root") {
        walk_tileset_uris(root, f);
    }
    if let Some(Value::Array(children)) = obj.get_mut("children") {
        for child in children {
            walk_tileset_uris(child, f);
        }
    }
}

async fn localize_fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > LOCALIZE_FILE_MAX_BYTES {
            return Err("サイズ上限(256MB)を超えています".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

// tileset.json を起点に参照ツリーごと dir_rel(例: "http/3dtiles/name")配下へ
// 保存し、(ルート JSON の rel パス, 取得ファイル数)を返す。
// 外部タイルセットは内容を辿るためキューで先に処理し、コンテンツは収集後に
// 並列ダウンロードする
async fn localize_tileset(
    client: &reqwest::Client,
    root_url: &str,
    dir_rel: &str,
    output_root: &Path,
) -> Result<(String, usize), String> {
    let root_parsed = reqwest::Url::parse(root_url).map_err(|e| e.to_string())?;
    if !matches!(root_parsed.scheme(), "http" | "https") {
        return Err("http(s) URL ではありません".to_string());
    }
    let root_dir = root_parsed.join("./").map_err(|e| e.to_string())?;
    let root_name = root_parsed
        .path_segments()
        .and_then(|mut s| s.next_back().filter(|n| !n.is_empty()).map(str::to_string))
        .unwrap_or_else(|| "tileset.json".to_string());
    let root_rel = format!(
        "{dir_rel}/{}",
        sanitize_file_name(&percent_decode(&root_name))
    );

    // 解決済み URL → rel の対応表(同一ファイルの重複取得防止)
    let mut known: HashMap<String, String> = HashMap::new();
    known.insert(root_parsed.to_string(), root_rel.clone());
    let mut tileset_queue: VecDeque<(String, String)> = VecDeque::new();
    tileset_queue.push_back((root_parsed.to_string(), root_rel.clone()));
    let mut content_jobs: Vec<(String, String)> = Vec::new();
    let mut files = 0usize;

    while let Some((url, rel)) = tileset_queue.pop_front() {
        let bytes = localize_fetch_bytes(client, &url).await?;
        let mut json_value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "tileset JSON の解析に失敗しました".to_string())?;
        if contains_implicit_tiling(&json_value) {
            return Err("implicit tiling のタイルセットは対象外です".to_string());
        }
        let tile_dir = reqwest::Url::parse(&url)
            .and_then(|u| u.join("./"))
            .map_err(|e| e.to_string())?;
        let mut discovered: Vec<(String, String, bool)> = Vec::new();
        let mut changed = false;
        walk_tileset_uris(&mut json_value, &mut |uri| {
            let resolved = match reqwest::Url::parse(uri.as_str()) {
                Ok(u) => u,
                Err(_) => match tile_dir.join(uri.as_str()) {
                    Ok(u) => u,
                    Err(_) => return,
                },
            };
            if !matches!(resolved.scheme(), "http" | "https") {
                return;
            }
            let inner_rel = match tileset_inner_path(&root_dir, &resolved) {
                Some(inner) => format!("{dir_rel}/{inner}"),
                None => {
                    // ルート外への参照は _ext/ に集める
                    let base = resolved
                        .path_segments()
                        .and_then(|mut s| {
                            s.next_back().filter(|n| !n.is_empty()).map(str::to_string)
                        })
                        .unwrap_or_else(|| "download".to_string());
                    let name = sanitize_file_name(&percent_decode(&base));
                    format!("{dir_rel}/_ext/{:016x}-{name}", fnv1a64(resolved.as_str()))
                }
            };
            if let std::collections::hash_map::Entry::Vacant(entry) =
                known.entry(resolved.to_string())
            {
                let is_tileset = resolved
                    .path()
                    .rsplit('/')
                    .next()
                    .is_some_and(|n| n.to_ascii_lowercase().ends_with(".json"));
                discovered.push((resolved.to_string(), inner_rel.clone(), is_tileset));
                entry.insert(inner_rel);
            }
            // ルート内の参照は階層を保持するので JSON 側は無変更。
            // _ext へ逃がした参照だけ、参照元ファイルからの相対パスへ書き換える
            let known_rel = &known[resolved.as_str()];
            if let Some(name) = known_rel.strip_prefix(&format!("{dir_rel}/_ext/")) {
                let ups = rel.matches('/').count() - dir_rel.matches('/').count() - 1;
                *uri = format!("{}_ext/{name}", "../".repeat(ups));
                changed = true;
            }
        });
        for (u, r, is_tileset) in discovered {
            if is_tileset {
                tileset_queue.push_back((u, r));
            } else {
                content_jobs.push((u, r));
            }
        }
        if known.len() > LOCALIZE_TILESET_MAX_FILES {
            return Err(format!(
                "ファイル数が上限({LOCALIZE_TILESET_MAX_FILES})を超えています"
            ));
        }
        let out = if changed {
            serde_json::to_vec(&json_value).map_err(|e| e.to_string())?
        } else {
            bytes
        };
        let path = localize_output_path(output_root, &rel).map_err(|(_, m)| m)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&path, &out)
            .await
            .map_err(|e| e.to_string())?;
        files += 1;
    }

    // コンテンツは全タイルセットを辿り終えてから並列取得する
    let semaphore = Arc::new(tokio::sync::Semaphore::new(8));
    let mut tasks: tokio::task::JoinSet<Result<(), String>> = tokio::task::JoinSet::new();
    for (url, rel) in content_jobs {
        let client = client.clone();
        let semaphore = semaphore.clone();
        let root = output_root.to_path_buf();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.map_err(|e| e.to_string())?;
            let bytes = localize_fetch_bytes(&client, &url).await?;
            let path = localize_output_path(&root, &rel).map_err(|(_, m)| m)?;
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            tokio::fs::write(&path, &bytes)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.map_err(|e| e.to_string())??;
        files += 1;
    }
    Ok((root_rel, files))
}

// リモート参照のローカル化(納品用)。元プロジェクトは変更せず、
// 兄弟に <dir>_local/ ワークスペース(群マニフェスト+プロジェクト複製+
// DATA/)を生成する。接続中ならクラウドルートを選択先の
// DATA/cloud/<取得元ハッシュ>/ へ rclone copy し、cloud: 参照を .kasc 基準の
// 相対パスに書き換える。さらに http(s) 参照(レイヤーURL・style=・
// info:/legend:・sql: クエリ内リテラル)を DATA/http/ へダウンロードして
// 参照を書き換える。3dtiles: 行のリモート URL は tileset.json から参照
// ツリーごと DATA/http/3dtiles/<name>/ に取得する(ベースマップ相当のサービス
// ・implicit tiling は対象外)。重複する URL は1ファイルにまとめ、sql: 文中の
// URL も同一ファイルを指す。納品先は rclone 設定・OAuth・ネット接続不要で
// ファイル一式だけで動く構成になる
async fn cloud_localize(
    State(state): State<AppState>,
    Json(request): Json<CloudLocalizeRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let _guard = LOCALIZE_LOCK.lock().await;
    let project_dir = normalize_fs_path(&resolve_project_dir(&state, &request.project)?);
    if !project_dir.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            "プロジェクトが見つかりません".to_string(),
        ));
    }
    let kasc_name = project_kasc_name(&state, &request.project);
    let kasc_path = project_dir.join(&kasc_name);
    let text = tokio::fs::read_to_string(&kasc_path)
        .await
        .map_err(internal_error)?;

    // 出力は元プロジェクトを変更しない納品ワークスペース。
    // 兄弟に <dir>_local/ を作り、群マニフェスト + プロジェクト複製 +
    // DATA/ を内包する自己完結パッケージにする。
    // 既存 _local は毎回作り直し、スコープ違いの残りファイルが
    // 混ざらないようにする
    let dir_name = project_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or((
            StatusCode::BAD_REQUEST,
            "プロジェクトフォルダ名を特定できません".to_string(),
        ))?;
    let parent = project_dir.parent().ok_or((
        StatusCode::BAD_REQUEST,
        "プロジェクトの親フォルダを特定できません".to_string(),
    ))?;
    let local_root = normalize_fs_path(&parent.join(format!("{dir_name}_local")));
    if local_root.is_dir() {
        remove_dir_all_retry(&local_root).map_err(internal_error)?;
    } else if local_root.exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            "納品ワークスペースと同名のファイルが存在します".to_string(),
        ));
    }
    let local_project_dir = local_root.join(dir_name);
    copy_dir_all(&project_dir, &local_project_dir, &["DATA"]).await?;
    // 既存のローカル DATA/ は取得物(http/, cloud/)と混ざらないよう
    // DATA/local/ に集約して複製する
    let project_data = project_dir.join("DATA");
    if project_data.is_dir() {
        copy_dir_all(&project_data, &local_project_dir.join("DATA/local"), &[]).await?;
    }
    // 共有スコープ(../DATA)が既存データを指している場合も _local 内で
    // 解決できるよう、親の DATA/ をワークスペース側へ複製しておく
    let shared_src = parent.join("DATA");
    if shared_src.is_dir() {
        copy_dir_all(&shared_src, &local_root.join("DATA/local"), &[]).await?;
    }
    // 群マニフェスト: 生成フォルダ内の .kasc を開けば既存の群登録で
    // 取り込める構造にし、../ スコープの階層宣言としても機能させる
    let title = read_project_title(&project_dir)
        .or_else(|| {
            state.external_projects.lock().ok().and_then(|list| {
                list.iter()
                    .find(|e| e.id == request.project)
                    .map(|e| e.title.clone())
            })
        })
        .or_else(|| {
            std::fs::read_to_string(state.projects_dir.join(GROUP_MANIFEST_FILE_NAME))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| {
                    value.as_array().into_iter().flatten().find_map(|entry| {
                        if entry.get("id").and_then(Value::as_str) == Some(request.project.as_str())
                        {
                            entry
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        } else {
                            None
                        }
                    })
                })
        })
        .unwrap_or_else(|| dir_name.to_string());
    let group_manifest = json!([{
        "id": request.project,
        "title": title,
        "dir": dir_name,
        "kasc": kasc_name,
    }]);
    tokio::fs::write(
        local_root.join(GROUP_MANIFEST_FILE_NAME),
        serde_json::to_vec_pretty(&group_manifest).map_err(internal_error)?,
    )
    .await
    .map_err(internal_error)?;

    let (output_root, data_prefix) =
        localize_output_scope(&local_root, &local_project_dir, request.scope);
    let data_dir = localize_output_path(&output_root, "")?;
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(internal_error)?;

    // クラウド側のコピーは接続中のみ。未接続でも Web 参照だけの同期は可能とする
    let mut cloud_synced = false;
    let mut cloud_prefix = None;
    let source = {
        let cloud = state.cloud.lock().await;
        cloud.serve.as_ref().map(|serve| serve_target(serve, ""))
    };
    if let Some(source) = source {
        let exe = rclone_exe(&state).await.ok_or((
            StatusCode::BAD_REQUEST,
            "rclone が見つかりません".to_string(),
        ))?;
        let cloud_rel = format!("cloud/{:016x}", fnv1a64(&source));
        let cloud_dir = localize_output_path(&output_root, &cloud_rel)?;
        let sources_path = localize_output_path(&output_root, "cloud/_sources.json")?;
        let mut sources = read_localize_sources(&sources_path)?;
        if (cloud_dir.exists() || sources.contains_key(&cloud_rel))
            && sources.get(&cloud_rel).and_then(Value::as_str) != Some(&source)
        {
            return Err((
                StatusCode::CONFLICT,
                "クラウド保存先が別のデータと衝突しています".to_string(),
            ));
        }
        tokio::fs::create_dir_all(&cloud_dir)
            .await
            .map_err(internal_error)?;
        sources.insert(cloud_rel.clone(), json!(source));
        tokio::fs::write(
            &sources_path,
            serde_json::to_vec_pretty(&sources).map_err(internal_error)?,
        )
        .await
        .map_err(internal_error)?;
        let output = new_rclone_command(&exe)
            .args(["copy", &source])
            .arg(&cloud_dir)
            .output()
            .await
            .map_err(internal_error)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err((
                StatusCode::BAD_GATEWAY,
                format!("rclone copy が失敗しました: {}", stderr.trim()),
            ));
        }
        cloud_synced = true;
        cloud_prefix = Some(format!("{data_prefix}/{cloud_rel}"));
    }

    // .kasc からリモート URL を収集(正規化して重複除去)
    let mut urls: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    rewrite_kasc_remote_refs(&text, cloud_prefix.as_deref(), &mut |url, _pos| {
        if !is_remote_url(url) {
            return None;
        }
        let normalized = normalize_remote_url(url);
        if seen.insert(normalized.clone()) {
            urls.push(normalized);
        }
        None
    });

    // 3dtiles: 行は tileset.json ツリーごと取得するため別経路で先に列挙する
    // (http(s) 由来の保存先は他形式と同じく取得元別の DATA/http/3dtiles/<name>/)
    let tileset_urls = collect_tileset_urls(&text);
    // xyz: 行のリモートタイルテンプレートは受け皿のみ生成(別経路)
    let xyz_template_urls = collect_xyz_template_urls(&text);

    // DATA/http/<name> に割り当てて順次ダウンロード。失敗した参照は URL のまま残す
    let http_dir = localize_output_path(&output_root, "http")?;
    let manifest_path = localize_output_path(&output_root, "http/_sources.json")?;
    let mut sources = read_localize_sources(&manifest_path)?;
    let mut occupied = if http_dir.exists() {
        std::fs::read_dir(&http_dir)
            .map_err(internal_error)?
            .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().to_string()))
            .collect::<Result<HashSet<_>, _>>()
            .map_err(internal_error)?
    } else {
        HashSet::new()
    };
    // http/3dtiles/・http/xyz/ サブフォルダと同名のファイルが作られないよう予約する
    if !tileset_urls.is_empty() {
        occupied.insert("3dtiles".to_string());
    }
    if !xyz_template_urls.is_empty() {
        occupied.insert("xyz".to_string());
    }
    let names = assign_localize_names(&urls, &sources, &occupied);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CLOUD_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(internal_error)?;
    let mut downloaded: HashSet<String> = HashSet::new();
    let mut failed: Vec<Value> = Vec::new();
    for url in &urls {
        let rel = &names[url];
        let result = localize_fetch_bytes(&client, url).await;
        match result {
            Ok(bytes) => {
                let path = localize_output_path(&output_root, rel)?;
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(internal_error)?;
                }
                match tokio::fs::write(&path, &bytes).await {
                    Ok(()) => {
                        downloaded.insert(url.clone());
                        sources.insert(rel.clone(), json!(url));
                    }
                    Err(error) => {
                        failed.push(json!({ "url": url, "error": error.to_string() }));
                    }
                }
            }
            Err(error) => {
                failed.push(json!({ "url": url, "error": error }));
            }
        }
    }
    // 3dtiles: 行は tileset.json を起点に参照ツリーごと DATA/http/3dtiles/<name>/
    // へ取得する。ベースマップ相当のサービス(Google Photorealistic 3D Tiles
    // 等の全球・キー依存サービス)は対象外として URL を残す
    let mut tilesets: Vec<Value> = Vec::new();
    let mut tileset_skipped: Vec<Value> = Vec::new();
    let mut tileset_paths: HashMap<String, String> = HashMap::new();
    {
        let mut used_dirs: HashSet<String> = sources
            .keys()
            .filter_map(|rel| rel.strip_prefix("http/3dtiles/"))
            .filter(|name| !name.contains('/'))
            .map(|name| name.to_lowercase())
            .collect();
        for url in tileset_urls {
            if is_basemap_tileset_url(&url) {
                tileset_skipped.push(json!({ "url": url }));
                continue;
            }
            let name =
                localize_unique_dir_name(&localize_tileset_dir_name(&url), &url, &mut used_dirs);
            let dir_rel = format!("http/3dtiles/{name}");
            match localize_tileset(&client, &url, &dir_rel, &output_root).await {
                Ok((root_rel, count)) => {
                    tileset_paths.insert(url.clone(), root_rel);
                    sources.insert(dir_rel.clone(), json!(url));
                    tilesets.push(json!({ "url": url, "dir": dir_rel, "files": count }));
                }
                Err(error) => {
                    failed.push(json!({ "url": url, "error": error }));
                    if let Ok(path) = localize_output_path(&output_root, &dir_rel) {
                        let _ = remove_dir_all_retry(&path);
                    }
                }
            }
        }
    }
    // xyz: 行のリモートタイルテンプレートはタイル本体を取得せず、ユーザーが
    // データを配置する受け皿 http/xyz/<name>/ のみ生成する(最低限の枠組み)。
    // テンプレートのプレースホルダ以降の末尾構造はそのままローカル側へ引き継ぐ
    let mut xyz_tiles: Vec<Value> = Vec::new();
    let mut xyz_template_paths: HashMap<String, String> = HashMap::new();
    {
        let mut used_dirs: HashSet<String> = sources
            .keys()
            .filter_map(|rel| rel.strip_prefix("http/xyz/"))
            .filter(|name| !name.contains('/'))
            .map(|name| name.to_lowercase())
            .collect();
        for url in xyz_template_urls {
            let Some((stem, tail)) = xyz_template_parts(&url) else {
                continue;
            };
            let name = localize_unique_dir_name(&stem, &url, &mut used_dirs);
            let dir_rel = format!("http/xyz/{name}");
            match localize_output_path(&output_root, &dir_rel) {
                Ok(path) => {
                    if let Err(error) = tokio::fs::create_dir_all(&path)
                        .await
                        .map_err(internal_error)
                    {
                        failed.push(json!({ "url": url, "error": error.1 }));
                        continue;
                    }
                    // 受け皿の使い方を同梱する(失敗しても受け皿自体は残す)
                    let _ = tokio::fs::write(
                        path.join("_README.txt"),
                        xyz_container_readme(&url, &tail),
                    )
                    .await;
                }
                Err((_, error)) => {
                    failed.push(json!({ "url": url, "error": error }));
                    continue;
                }
            }
            xyz_template_paths.insert(url.clone(), format!("{dir_rel}/{tail}"));
            sources.insert(dir_rel.clone(), json!(url));
            xyz_tiles.push(json!({ "url": url, "dir": dir_rel }));
        }
    }
    // どこからダウンロードしたかの一覧(整理用)。既存マニフェストにマージする。
    // ファイルは http/<name>、タイルセットは http/3dtiles/<name>、
    // xyz テンプレートの受け皿は http/xyz/<name> をキーにする
    if !downloaded.is_empty() || !tilesets.is_empty() || !xyz_tiles.is_empty() {
        let manifest =
            serde_json::to_string_pretty(&Value::Object(sources)).map_err(internal_error)?;
        tokio::fs::write(&manifest_path, manifest)
            .await
            .map_err(internal_error)?;
    }

    // 参照の書き換え。既存のローカル DATA 参照を先に local/ へ集約して
    // から、ダウンロード済みのリモート参照を http/・cloud/ へ置き換える
    // (この順でないと生成した参照を二重書き換えしてしまう)。
    // 書き換え対象は 3dtiles を含む全レイヤー行の URL フィールド
    // (xyz は受け皿のローカルテンプレートへ、base はベースマップ相当のため無変更)
    let local_text = rewrite_kasc_refs(
        &text,
        None,
        kasc_local_ref_field_index,
        &mut |value, _pos| localize_data_ref(value),
    );
    let new_text = rewrite_kasc_refs(
        &local_text,
        cloud_prefix.as_deref(),
        kasc_local_ref_field_index,
        &mut |url, _pos| {
            let normalized = normalize_remote_url(url);
            if let Some(rel) = tileset_paths.get(&normalized) {
                return Some(format!("{data_prefix}/{}", encode_uri_path(rel)));
            }
            // xyz テンプレートは {z} 等のプレースホルダを残して書き換える
            if let Some(rel) = xyz_template_paths.get(&normalized) {
                return Some(format!("{data_prefix}/{}", encode_uri_template(rel)));
            }
            let rel = names.get(&normalized)?;
            if !downloaded.contains(&normalized) {
                return None;
            }
            Some(format!("{data_prefix}/{}", encode_uri_path(rel)))
        },
    );
    // 書き換えは複製側の .kasc に反映し、元プロジェクトは変更しない
    let kasc_rewritten = new_text != text;
    if kasc_rewritten {
        tokio::fs::write(local_project_dir.join(&kasc_name), &new_text)
            .await
            .map_err(internal_error)?;
    }
    Ok(Json(json!({
        "ok": true,
        "cloudSynced": cloud_synced,
        "downloaded": downloaded.len(),
        "tilesets": tilesets,
        "tilesetSkipped": tileset_skipped,
        "xyzTiles": xyz_tiles,
        "failed": failed,
        "cloudRefsRemaining": count_cloud_refs(&new_text),
        "kascRewritten": kasc_rewritten,
        "outputPath": local_root.to_string_lossy(),
        "projectDir": local_project_dir.to_string_lossy(),
        "dataPath": data_dir.to_string_lossy(),
        "dataReference": data_prefix,
    })))
}

#[cfg(test)]
mod localize_tests {
    use super::*;

    fn collect_urls(text: &str) -> Vec<String> {
        let mut urls = Vec::new();
        let mut seen = HashSet::new();
        rewrite_kasc_remote_refs(text, None, &mut |url, _pos| {
            if !is_remote_url(url) {
                return None;
            }
            let normalized = normalize_remote_url(url);
            if seen.insert(normalized.clone()) {
                urls.push(normalized);
            }
            None
        });
        urls
    }

    fn rewrite(text: &str, include_cloud: bool, urls: &[&str]) -> String {
        let names = assign_localize_names(
            &urls
                .iter()
                .map(|u| normalize_remote_url(u))
                .collect::<Vec<_>>(),
            &serde_json::Map::new(),
            &HashSet::new(),
        );
        rewrite_kasc_remote_refs(
            text,
            include_cloud.then_some("DATA/cloud"),
            &mut |url, _pos| {
                let rel = names.get(&normalize_remote_url(url))?;
                Some(format!("DATA/{rel}"))
            },
        )
    }

    #[test]
    fn collects_only_downloadable_positions() {
        let text = "geojson: a | https://x/a.geojson\n\
                    duckdb: b | https://x/b.parquet | where=x=1\n\
                    gpkg: c | https://x/c.gpkg | style=https://x/c.qml\n\
                    fly_geojson: d | https://x/d.geojson\n\
                    info: https://x/i.html\n\
                    legend: l | https://x/l.png\n\
                    xyz: t | https://x/{z}/{x}/{y}.png\n\
                    base: t | https://x/{z}/{x}/{y}.png\n\
                    3dtiles: t | https://x/tileset.json";
        assert_eq!(
            collect_urls(text),
            vec![
                "https://x/a.geojson",
                "https://x/b.parquet",
                "https://x/c.gpkg",
                "https://x/c.qml",
                "https://x/d.geojson",
                "https://x/i.html",
                "https://x/l.png"
            ]
        );
    }

    #[test]
    fn duplicate_urls_share_one_file() {
        // 末尾空白の有無・sql: リテラル・style= の重複も同一ファイルにまとめる
        let text = "geojson: a | https://x/d.csv \n\
                    duckdb: b | https://x/d.csv\n\
                    sql: q | SELECT * FROM 'https://x/d.csv' | style=https://x/d.csv";
        let out = rewrite(text, false, &["https://x/d.csv"]);
        assert!(out.contains("geojson: a | DATA/http/d.csv "));
        assert!(out.contains("duckdb: b | DATA/http/d.csv"));
        assert!(out.contains("'DATA/http/d.csv'"));
        assert!(out.contains("style=DATA/http/d.csv"));
        assert!(!out.contains("--"));
    }

    #[test]
    fn name_collision_gets_hash_suffix() {
        let names = assign_localize_names(
            &[
                "https://a.com/dir/data.csv".to_string(),
                "https://b.com/other/data.csv".to_string(),
            ],
            &serde_json::Map::new(),
            &HashSet::new(),
        );
        assert_eq!(names["https://a.com/dir/data.csv"], "http/data.csv");
        assert_ne!(names["https://b.com/other/data.csv"], "http/data.csv");
        assert!(names["https://b.com/other/data.csv"].ends_with(".csv"));
    }

    #[test]
    fn cloud_refs_rewritten_only_when_synced() {
        let text = "cloud: box | root\n\
                    geojson: a | cloud:dir/f.geojson\n\
                    geojson: b | cloud:../evil\n\
                    xyz: t | cloud:tiles/{z}/{x}/{y}.png";
        // 未接続(未同期)なら接続行も参照もそのまま
        assert_eq!(rewrite(text, false, &[]), text);
        // 同期済みなら接続行はコメント化・参照は DATA/cloud/(タイル系も同様)
        let out = rewrite(text, true, &[]);
        assert!(out.contains("# cloud: box | root"));
        assert!(out.contains("geojson: a | DATA/cloud/dir/f.geojson"));
        assert!(out.contains("xyz: t | DATA/cloud/tiles/{z}/{x}/{y}.png"));
        // ../ を含む参照はプロジェクト外に出るため保持
        assert!(out.contains("geojson: b | cloud:../evil"));
    }

    #[test]
    fn failed_download_keeps_url() {
        // urls に無い(=ダウンロード失敗)参照は URL のまま残る
        let text = "geojson: a | https://x/miss.geojson";
        assert_eq!(rewrite(text, false, &[]), text);
    }

    struct TestWorkspace {
        root: PathBuf,
        state: AppState,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "kasugai-localize-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(root.join("projects")).unwrap();
            let root = normalize_fs_path(&root);
            let state = AppState {
                update_config_path: Arc::new(root.join("update.json")),
                cloud_config_path: Arc::new(root.join("cloud.json")),
                external_projects_path: Arc::new(root.join("registry.json")),
                external_projects: Arc::new(StdMutex::new(Vec::new())),
                cloud: Arc::new(Mutex::new(CloudState::default())),
                shutdown: Arc::new(Notify::new()),
                port: 0,
                web_dir: Arc::new(root.clone()),
                projects_dir: Arc::new(root.join("projects")),
                is_local: true,
            };
            Self { root, state }
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn group_registration_uses_manifest_for_primary_without_requiring_ids() {
        let env = TestWorkspace::new();
        let group = env.root.join("delivery");
        for name in ["A", "B"] {
            std::fs::create_dir_all(group.join(name)).unwrap();
            std::fs::write(group.join(name).join("view.kasc"), "title: test").unwrap();
        }
        std::fs::write(group.join("B/notes.txt"), "not a project").unwrap();
        std::fs::write(
            group.join("projects.json"),
            r#"[
            {"dir":"A","title":"Manifest A","kasc":"view.kasc"},
            {"id":"custom-b","dir":"B","title":"Manifest B","kasc":"view.kasc"},
            {"id":"invalid","dir":"B","kasc":"notes.txt"}
        ]"#,
        )
        .unwrap();
        let (primary, members) =
            register_external_project(&env.state, &group.join("A/view.kasc")).unwrap();
        assert_eq!(primary.title, "Manifest A");
        assert_eq!(members.len(), 2);
        assert_eq!(members[1].id, "custom-b");
        let (other, repeated) =
            register_external_project(&env.state, &group.join("B/view.kasc")).unwrap();
        assert_eq!(other.id, "custom-b");
        assert_eq!(other.title, "Manifest B");
        assert_eq!(repeated.len(), 2);
        assert_eq!(env.state.external_projects.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn localize_builds_self_contained_workspace() {
        let env = TestWorkspace::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/a/data.csv", get(|| async { "lon,lat\n139,35\n" }))
                    .route("/b/data.csv", get(|| async { "lon,lat\n140,36\n" })),
            )
            .await
            .unwrap();
        });
        // 既存のローカル参照と共有 ../DATA が _local 内で解決できるかを見る
        let shared_dir = env.state.projects_dir.join("DATA");
        std::fs::create_dir_all(&shared_dir).unwrap();
        std::fs::write(shared_dir.join("shared.geojson"), "{}").unwrap();
        let dir = env.state.projects_dir.join("A");
        std::fs::create_dir_all(dir.join("DATA/http")).unwrap();
        std::fs::write(dir.join("DATA/local.geojson"), "{}").unwrap();
        // 元 DATA/http は生成物ではなくローカルデータとして local/ 側に集約する
        std::fs::write(dir.join("DATA/http/old.geojson"), "{}").unwrap();
        std::fs::write(
            dir.join(KASC_FILE_NAME),
            format!(
                "geojson: keep | DATA/local.geojson | on\ngeojson: shared | ../DATA/shared.geojson | on\ngeojson: old | DATA/http/old.geojson | on\nduckdb: data | {base}/a/data.csv\nsql: sql | SELECT * FROM read_csv('{base}/a/data.csv')\nsql: localsql | SELECT * FROM read_csv('DATA/local.geojson')"
            ),
        )
        .unwrap();
        let original = std::fs::read_to_string(dir.join(KASC_FILE_NAME)).unwrap();
        let result = cloud_localize(
            State(env.state.clone()),
            Json(CloudLocalizeRequest {
                project: "A".to_string(),
                scope: LocalizeScope::Shared,
            }),
        )
        .await
        .unwrap()
        .0;
        let local_root = env.state.projects_dir.join("A_local");
        let copied = local_root.join("A").join(KASC_FILE_NAME);
        assert_eq!(result["downloaded"], 1);
        assert_eq!(result["dataReference"], "../DATA");
        assert_eq!(result["outputPath"], json!(local_root.to_string_lossy()));
        // 元プロジェクトは kasc・DATA とも変更されない
        assert_eq!(
            std::fs::read_to_string(dir.join(KASC_FILE_NAME)).unwrap(),
            original
        );
        // ダウンロードは元の DATA/http に書き込まれない
        assert_eq!(
            std::fs::read_dir(dir.join("DATA/http"))
                .unwrap()
                .filter_map(|e| e.ok())
                .count(),
            1
        );
        // 群マニフェスト + プロジェクト複製 + DATA/ の構成
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(local_root.join(GROUP_MANIFEST_FILE_NAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest[0]["id"], "A");
        assert_eq!(manifest[0]["dir"], "A");
        assert_eq!(manifest[0]["kasc"], json!(KASC_FILE_NAME));
        let text = std::fs::read_to_string(&copied).unwrap();
        assert!(text.contains("../DATA/http/data.csv"));
        assert!(text.contains("read_csv('../DATA/http/data.csv')"));
        assert!(text.contains("| DATA/local/local.geojson |"));
        assert!(!text.contains("| DATA/local.geojson |"));
        assert!(text.contains("read_csv('DATA/local/local.geojson')"));
        assert!(text.contains("| ../DATA/local/shared.geojson |"));
        assert!(text.contains("| DATA/local/http/old.geojson |"));
        assert!(!text.contains(&base));
        // 生成物(http/)と複製したローカルデータ(local/)は混在しない
        assert!(local_root.join("DATA/http/data.csv").is_file());
        assert!(!local_root.join("DATA/shared.geojson").exists());
        assert!(local_root.join("DATA/local/shared.geojson").is_file());
        assert!(!local_root.join("A/DATA/local.geojson").exists());
        assert!(local_root.join("A/DATA/local/local.geojson").is_file());
        assert!(local_root.join("A/DATA/local/http/old.geojson").is_file());
        let sources = read_localize_sources(&local_root.join("DATA/http/_sources.json")).unwrap();
        assert_eq!(sources.len(), 1);
        // 生成物はそのまま群として外部プロジェクト登録できる
        let (_primary, members) = register_external_project(&env.state, &copied).unwrap();
        assert_eq!(members.len(), 1);
        // 再実行はワークスペースを作り直すので残滓が混ざらない
        std::fs::write(local_root.join("DATA/http/stale.tmp"), "stale").unwrap();
        let result = cloud_localize(
            State(env.state.clone()),
            Json(CloudLocalizeRequest {
                project: "A".to_string(),
                scope: LocalizeScope::Shared,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(result["downloaded"], 1);
        assert!(!local_root.join("DATA/http/stale.tmp").exists());
        assert!(local_root.join("DATA/http/data.csv").is_file());
        // 専用スコープは複製プロジェクト内 DATA/ に置き直す
        let private = cloud_localize(
            State(env.state.clone()),
            Json(CloudLocalizeRequest {
                project: "A".to_string(),
                scope: LocalizeScope::Project,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(private["dataReference"], "DATA");
        assert!(local_root.join("A/DATA/http/data.csv").is_file());
        assert!(!local_root.join("DATA/http/data.csv").exists());
        let text = std::fs::read_to_string(&copied).unwrap();
        assert!(text.contains("DATA/http/data.csv"));
        assert!(text.contains("| DATA/local/local.geojson |"));
        task.abort();
    }

    #[test]
    fn existing_local_refs_move_under_data_local() {
        let text = "geojson: a | DATA/a.geojson | on\n\
                    geojson: b | ../DATA/b.geojson | on\n\
                    3dtiles: t | DATA/tiles/tileset.json\n\
                    xyz: t | DATA/tiles/{z}/{x}/{y}.png\n\
                    info: ./DATA/i.html\n\
                    legend: l | DATA/l.png\n\
                    sql: s | SELECT * FROM read_csv('DATA/x.csv')\n\
                    geojson: c | cloud:folder/c.geojson\n\
                    geojson: d | https://x/d.geojson";
        let out = rewrite_kasc_refs(text, None, kasc_local_ref_field_index, &mut |v, _| {
            localize_data_ref(v)
        });
        assert!(out.contains("| DATA/local/a.geojson |"));
        assert!(out.contains("| ../DATA/local/b.geojson |"));
        assert!(out.contains("3dtiles: t | DATA/local/tiles/tileset.json"));
        assert!(out.contains("xyz: t | DATA/local/tiles/{z}/{x}/{y}.png"));
        assert!(out.contains("info: DATA/local/i.html"));
        assert!(out.contains("| DATA/local/l.png"));
        assert!(out.contains("read_csv('DATA/local/x.csv')"));
        // cloud:・リモート URL・非参照フィールドは無変更
        assert!(out.contains("cloud:folder/c.geojson"));
        assert!(out.contains("https://x/d.geojson"));
    }

    #[test]
    fn shared_is_default_and_private_is_explicit() {
        let request: CloudLocalizeRequest = serde_json::from_value(json!({"project":"p"})).unwrap();
        assert_eq!(request.scope, LocalizeScope::Shared);
        let root = Path::new("workspace/p_local");
        let dir = root.join("p");
        assert_eq!(
            localize_output_scope(root, &dir, request.scope),
            (root.to_path_buf(), "../DATA")
        );
        assert_eq!(
            localize_output_scope(root, &dir, LocalizeScope::Project),
            (dir.to_path_buf(), "DATA")
        );
        assert!(serde_json::from_value::<CloudLocalizeRequest>(
            json!({"project":"p","scope":"../../"})
        )
        .is_err());
    }

    #[test]
    fn persistent_names_protect_existing_and_reserved_files() {
        let sources =
            serde_json::from_value(json!({"http/data.csv":"https://a/data.csv"})).unwrap();
        let occupied = ["data.csv", "User.csv"]
            .map(str::to_string)
            .into_iter()
            .collect();
        let urls = [
            "https://a/data.csv",
            "https://b/DATA.csv",
            "https://b/user.csv",
            "https://b/_sources.json",
        ]
        .map(str::to_string);
        let names = assign_localize_names(&urls, &sources, &occupied);
        assert_eq!(names[&urls[0]], "http/data.csv");
        assert_ne!(names[&urls[1]].to_lowercase(), "http/data.csv");
        assert_ne!(names[&urls[2]].to_lowercase(), "http/user.csv");
        assert_ne!(names[&urls[3]], "http/_sources.json");
        assert_eq!(sanitize_file_name("CON.csv"), "_CON.csv");
    }

    #[test]
    fn shared_references_do_not_embed_registration_id() {
        let text = "geojson: a | https://a/data.csv\nsql: b | SELECT * FROM read_csv('https://a/data.csv')\ngeojson: c | cloud:folder/c.geojson";
        let out = rewrite_kasc_remote_refs(text, Some("../DATA/cloud/source"), &mut |_, _| {
            Some("../DATA/http/data.csv".to_string())
        });
        assert!(out.contains("read_csv('../DATA/http/data.csv')"));
        assert!(out.contains("geojson: a | ../DATA/http/data.csv"));
        assert!(out.contains("../DATA/cloud/source/folder/c.geojson"));
        assert!(!out.contains("/projects/"));
    }

    #[test]
    fn github_urls_normalize_for_dedup() {
        assert_eq!(
            normalize_remote_url("https://github.com/o/r/blob/main/f.geojson"),
            "https://raw.githubusercontent.com/o/r/main/f.geojson"
        );
        assert_eq!(
            normalize_remote_url("https://github.com/o/r/raw/main/f.geojson"),
            "https://raw.githubusercontent.com/o/r/main/f.geojson"
        );
        assert_eq!(
            normalize_remote_url("https://example.com/x"),
            "https://example.com/x"
        );
    }

    #[test]
    fn collects_tileset_urls_only_from_3dtiles_lines() {
        let text = "3dtiles: a | https://x/a/tileset.json | on\n\
                    3dtiles: b | https://x/a/tileset.json\n\
                    3dtiles: c | DATA/local/tileset.json\n\
                    geojson: d | https://x/d.geojson\n\
                    # 3dtiles: e | https://x/e/tileset.json\n\
                    xyz: t | https://x/{z}/{x}/{y}.png";
        assert_eq!(collect_tileset_urls(text), vec!["https://x/a/tileset.json"]);
        // xyz: 行の {z}/{x}/{y} テンプレートは別経路(受け皿生成)で列挙する
        assert_eq!(
            collect_xyz_template_urls(text),
            vec!["https://x/{z}/{x}/{y}.png"]
        );
        // フォルダ名はプレースホルダ直前の実セグメント、末尾はテンプレート部分
        assert_eq!(
            xyz_template_parts("https://cyber/xyz/std/{z}/{x}/{y}.png?key=k"),
            Some(("std".to_string(), "{z}/{x}/{y}.png".to_string()))
        );
        let (name, tail) = xyz_template_parts("https://x/{z}/{x}/{y}.png").unwrap();
        assert!(name.starts_with("xyz-"));
        assert_eq!(tail, "{z}/{x}/{y}.png");
        // 座標プレースホルダのない URL はテンプレートとみなさない
        assert_eq!(xyz_template_parts("https://x/a/{s}/tile.png"), None);
        assert_eq!(xyz_template_parts("https://x/a/tile.png"), None);
        // ベースマップ相当のサービスは対象外判定になる
        assert!(is_basemap_tileset_url(
            "https://tile.googleapis.com/v1/3dtiles/root.json?key=k"
        ));
        assert!(is_basemap_tileset_url(
            "https://assets.cesium.com/1/tileset.json"
        ));
        assert!(!is_basemap_tileset_url("https://x/a/tileset.json"));
        // フォルダ名は汎用ファイル名なら親ディレクトリ名になる
        assert_eq!(
            localize_tileset_dir_name("https://x/dir/lod1/tileset.json"),
            "lod1"
        );
        assert_eq!(
            localize_tileset_dir_name("https://x/dir/model.json"),
            "model"
        );
    }

    #[tokio::test]
    async fn localize_downloads_3dtiles_tree() {
        let env = TestWorkspace::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let box_volume =
            r#"{"boundingVolume":{"box":[0,0,0,1,0,0,0,1,0,0,0,1]},"geometricError":0}"#;
        let root_tileset = format!(
            r#"{{"asset":{{"version":"1.0"}},"geometricError":1,"root":{{"boundingVolume":{{"box":[0,0,0,1,0,0,0,1,0,0,0,1]}},"geometricError":1,"children":[{{"boundingVolume":{{"box":[0,0,0,1,0,0,0,1,0,0,0,1]}},"geometricError":1,"content":{{"uri":"sub/child.json"}},"children":[{{"boundingVolume":{{"box":[0,0,0,1,0,0,0,1,0,0,0,1]}},"geometricError":0,"content":{{"uri":"a.b3dm"}}}}]}}]}}}}"#
        );
        let child_tileset = format!(
            r#"{{"asset":{{"version":"1.0"}},"geometricError":1,"root":{{"boundingVolume":{{"box":[0,0,0,1,0,0,0,1,0,0,0,1]}},"geometricError":1,"content":{{"uri":"b.b3dm"}},"children":[{box_volume},{{"boundingVolume":{{"box":[0,0,0,1,0,0,0,1,0,0,0,1]}},"geometricError":0,"content":{{"uri":"../a.b3dm"}}}},{{"boundingVolume":{{"box":[0,0,0,1,0,0,0,1,0,0,0,1]}},"geometricError":0,"contents":[{{"uri":"{base}/ext/model.glb"}}]}}]}}}}"#
        );
        let task = tokio::spawn({
            let root_tileset = root_tileset.clone();
            let child_tileset = child_tileset.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route(
                            "/tiles/tileset.json",
                            get(move || {
                                let t = root_tileset.clone();
                                async move { t }
                            }),
                        )
                        .route(
                            "/tiles/sub/child.json",
                            get(move || {
                                let t = child_tileset.clone();
                                async move { t }
                            }),
                        )
                        .route("/tiles/a.b3dm", get(|| async { "a" }))
                        .route("/tiles/sub/b.b3dm", get(|| async { "b" }))
                        .route("/ext/model.glb", get(|| async { "m" })),
                )
                .await
                .unwrap();
            }
        });
        let dir = env.state.projects_dir.join("T");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join("DATA/xyz/ortho/0/0")).unwrap();
        std::fs::write(dir.join("DATA/xyz/ortho/0/0/0.png"), "p").unwrap();
        std::fs::write(
            dir.join(KASC_FILE_NAME),
            format!(
                "3dtiles: tileset | {base}/tiles/tileset.json | on\n\
                 3dtiles: google | https://tile.googleapis.com/v1/3dtiles/root.json?key=k | on\n\
                 xyz: std | {base}/xyz/std/{{z}}/{{x}}/{{y}}.png | attr | maxZoom=15\n\
                 xyz: ortho | DATA/xyz/ortho/{{z}}/{{x}}/{{y}}.png | on\n\
                 base: gsi | https://cyberjapandata.gsi.go.jp/xyz/std/{{z}}/{{x}}/{{y}}.png | 出典 | maxZoom=18"
            ),
        )
        .unwrap();
        let result = cloud_localize(
            State(env.state.clone()),
            Json(CloudLocalizeRequest {
                project: "T".to_string(),
                scope: LocalizeScope::Shared,
            }),
        )
        .await
        .unwrap()
        .0;
        let local_root = env.state.projects_dir.join("T_local");
        // http 由来のタイルセットは他形式と同じく http/ 配下(3dtiles/ 区画)へ
        // ルート内の参照は階層保持、ルート外は _ext/ へ
        let data = local_root.join("DATA/http/3dtiles/tiles");
        assert!(data.join("tileset.json").is_file());
        assert!(data.join("sub/child.json").is_file());
        assert!(data.join("a.b3dm").is_file());
        assert!(data.join("sub/b.b3dm").is_file());
        let ext: Vec<_> = std::fs::read_dir(data.join("_ext"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(ext.len(), 1);
        assert!(ext[0].file_name().to_string_lossy().ends_with("-model.glb"));
        // 外部参照は参照元 JSON の uri を相対パスに書き換える
        let child = std::fs::read_to_string(data.join("sub/child.json")).unwrap();
        assert!(child.contains("\"uri\":\"../_ext/"));
        assert!(child.contains("\"uri\":\"../a.b3dm\""));
        assert_eq!(result["tilesets"].as_array().unwrap().len(), 1);
        assert_eq!(result["tilesets"][0]["files"], 5);
        assert_eq!(result["tilesetSkipped"].as_array().unwrap().len(), 1);
        // .kasc の参照はルート tileset.json を指し、Google は URL のまま残る
        let text = std::fs::read_to_string(local_root.join("T").join(KASC_FILE_NAME)).unwrap();
        assert!(text.contains("| ../DATA/http/3dtiles/tiles/tileset.json |"));
        assert!(text.contains("tile.googleapis.com"));
        // タイルセットの対応も http/_sources.json に記録する
        let sources = read_localize_sources(&local_root.join("DATA/http/_sources.json")).unwrap();
        assert_eq!(
            sources["http/3dtiles/tiles"],
            json!(format!("{base}/tiles/tileset.json"))
        );
        // xyz: リモートテンプレートは受け皿のみ生成し参照をローカル化する。
        // 受け皿には配置手順の _README.txt が入る(タイル本体は取得しない)
        let xyz_dir = local_root.join("DATA/http/xyz/std");
        let entries: Vec<_> = std::fs::read_dir(&xyz_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        let readme = std::fs::read_to_string(xyz_dir.join("_README.txt")).unwrap();
        assert!(readme.contains(&format!("{base}/xyz/std/")));
        assert!(
            text.contains("| ../DATA/http/xyz/std/{z}/{x}/{y}.png |"),
            "{text}"
        );
        assert!(text.contains("maxZoom=15"));
        assert_eq!(result["xyzTiles"].as_array().unwrap().len(), 1);
        assert_eq!(result["xyzTiles"][0]["dir"], json!("http/xyz/std"));
        assert_eq!(
            sources["http/xyz/std"],
            json!(format!("{base}/xyz/std/{{z}}/{{x}}/{{y}}.png"))
        );
        // ローカル DATA/ 内のテンプレートは local/ へ集約され複製される
        assert!(local_root
            .join("T/DATA/local/xyz/ortho/0/0/0.png")
            .is_file());
        assert!(text.contains("| DATA/local/xyz/ortho/{z}/{x}/{y}.png |"));
        // base: のベースマップ相当はリモート URL のまま残る
        assert!(text.contains("cyberjapandata.gsi.go.jp"));
        task.abort();
    }
}

#[derive(Deserialize)]
struct CloudPathQuery {
    path: String,
}

// serve 中リモートのフォルダ一覧。rclone lsjson の結果をそのまま返す
async fn cloud_list(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<CloudPathQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = query.path.trim().trim_matches('/');
    if !path.is_empty() && !is_valid_cloud_path(path) {
        return Err((StatusCode::BAD_REQUEST, "パスが不正です".to_string()));
    }
    let (exe, target) = {
        let cloud = state.cloud.lock().await;
        let serve = cloud.serve.as_ref().ok_or((
            StatusCode::CONFLICT,
            "クラウドに接続していません".to_string(),
        ))?;
        let exe = rclone_exe(&state).await.ok_or((
            StatusCode::BAD_REQUEST,
            "rclone が見つかりません".to_string(),
        ))?;
        (exe, serve_target(serve, path))
    };
    run_rclone_json(&exe, &["lsjson", &target]).await.map(Json)
}

// serve 中リモートへのファイル読み取り。Range を転送するので
// DuckDB-WASM 等の範囲読み経路でもそのまま使える
async fn cloud_get_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<CloudPathQuery>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let path = query.path.trim().trim_matches('/');
    if !is_valid_cloud_path(path) {
        return Err((StatusCode::BAD_REQUEST, "パスが不正です".to_string()));
    }
    let port = {
        let cloud = state.cloud.lock().await;
        cloud.serve.as_ref().map(|s| s.port).ok_or((
            StatusCode::CONFLICT,
            "クラウドに接続していません".to_string(),
        ))?
    };
    let url = serve_url(port, path)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CLOUD_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(internal_error)?;
    let mut request = client.get(url);
    if let Some(range) = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
    {
        request = request.header(reqwest::header::RANGE, range);
    }
    let response = request.send().await.map_err(internal_error)?;
    let status = response.status();
    let mut builder = axum::response::Response::builder().status(status);
    for key in [
        axum::http::header::CONTENT_TYPE,
        axum::http::header::CONTENT_LENGTH,
        axum::http::header::CONTENT_RANGE,
        axum::http::header::ACCEPT_RANGES,
        axum::http::header::ETAG,
        axum::http::header::LAST_MODIFIED,
    ] {
        if let Some(value) = response.headers().get(&key) {
            builder = builder.header(key, value.clone());
        }
    }
    let bytes = response.bytes().await.map_err(internal_error)?;
    if bytes.len() > CLOUD_FILE_MAX_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "取得データが上限を超えています".to_string(),
        ));
    }
    builder
        .body(axum::body::Body::from(bytes))
        .map_err(internal_error)
}

// serve 中リモートへのファイル書き込み。read-only 接続時は拒否
async fn cloud_put_file(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<CloudPathQuery>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = query.path.trim().trim_matches('/');
    if !is_valid_cloud_path(path) {
        return Err((StatusCode::BAD_REQUEST, "パスが不正です".to_string()));
    }
    let port = {
        let cloud = state.cloud.lock().await;
        let serve = cloud.serve.as_ref().ok_or((
            StatusCode::CONFLICT,
            "クラウドに接続していません".to_string(),
        ))?;
        if serve.read_only {
            return Err((
                StatusCode::FORBIDDEN,
                "読み取り専用で接続中のため書き込めません".to_string(),
            ));
        }
        serve.port
    };
    let url = serve_url(port, path)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CLOUD_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(internal_error)?;
    let response = client
        .put(url)
        .body(body.to_vec())
        .send()
        .await
        .map_err(internal_error)?;
    if !response.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("書き込みに失敗しました: {}", response.status()),
        ));
    }
    Ok(Json(json!({ "ok": true, "name": path })))
}

async fn cloud_delete_file(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<CloudPathQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = query.path.trim().trim_matches('/');
    if !is_valid_cloud_path(path) {
        return Err((StatusCode::BAD_REQUEST, "パスが不正です".to_string()));
    }
    let port = {
        let cloud = state.cloud.lock().await;
        let serve = cloud.serve.as_ref().ok_or((
            StatusCode::CONFLICT,
            "クラウドに接続していません".to_string(),
        ))?;
        if serve.read_only {
            return Err((
                StatusCode::FORBIDDEN,
                "読み取り専用で接続中のため削除できません".to_string(),
            ));
        }
        serve.port
    };
    let url = serve_url(port, path)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CLOUD_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(internal_error)?;
    let response = client.delete(url).send().await.map_err(internal_error)?;
    if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("削除に失敗しました: {}", response.status()),
        ));
    }
    Ok(Json(json!({ "ok": true, "name": path })))
}

async fn request_shutdown(State(state): State<AppState>) -> StatusCode {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        state.shutdown.notify_one();
    });
    StatusCode::NO_CONTENT
}

// "4.20.0" 形式のバージョンを比較する（欠けた要素は 0 扱い）
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u64> = a
        .split('.')
        .map(|p| p.trim().parse().unwrap_or(0))
        .collect();
    let pb: Vec<u64> = b
        .split('.')
        .map(|p| p.trim().parse().unwrap_or(0))
        .collect();
    for i in 0..pa.len().max(pb.len()) {
        match pa
            .get(i)
            .copied()
            .unwrap_or(0)
            .cmp(&pb.get(i).copied().unwrap_or(0))
        {
            std::cmp::Ordering::Equal => continue,
            ord => return ord,
        }
    }
    std::cmp::Ordering::Equal
}

async fn install_update(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let latest = fetch_latest().await?;
    // latest.json が現行以下を指す場合は差し替えない（古い配布物へのダウングレード防止）
    let latest_version = latest["version"].as_str().unwrap_or_default();
    if compare_versions(latest_version, env!("CARGO_PKG_VERSION")) != std::cmp::Ordering::Greater {
        return Err((StatusCode::CONFLICT, "既に最新バージョンです".to_string()));
    }
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

    let install_dir = current_exe.parent().map(PathBuf::from).ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "インストール先ディレクトリを取得できません".to_string(),
    ))?;
    let new_web_dir = extract_dir.join("web");
    let current_web_dir = install_dir.join("web");

    let script_path = tmp_dir.join("update.ps1");
    let script = format!(
        "$parentPid = {parent_pid}\n$newExe = '{new}'\n$currentExe = '{current}'\n$newWeb = '{new_web}'\n$currentWeb = '{current_web}'\nwhile (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 500 }}\n$ErrorActionPreference = 'Stop'\ntry {{\n    Copy-Item -Path $newExe -Destination $currentExe -Force\n    if (Test-Path $newWeb) {{\n        if (Test-Path $currentWeb) {{ Remove-Item -Path $currentWeb -Recurse -Force }}\n        Copy-Item -Path $newWeb -Destination $currentWeb -Recurse -Force\n    }}\n    Start-Process -FilePath $currentExe -ArgumentList '--no-browser' -WindowStyle Hidden\n}} catch {{\n    Write-Error \"更新ファイルの差し替えに失敗しました: $_\"\n    exit 1\n}}\n",
        new = new_exe.to_string_lossy().replace('\'', "''"),
        current = current_exe.to_string_lossy().replace('\'', "''"),
        new_web = new_web_dir.to_string_lossy().replace('\'', "''"),
        current_web = current_web_dir.to_string_lossy().replace('\'', "''")
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

// ---- 外部プロジェクト(.kasc ファイル関連付け起動) ----
// インストールフォルダ外にある .kasc をプロジェクトとして登録する。
// .kasc のあるフォルダがそのまま /projects/<id>/ のルートになるため、
// DATA/ 等の相対参照はそのフォルダ基準で解決される。納品フォルダを
// そのまま開ける構成。.kasc の実ファイル名は kasugai_canvas.kasc 以外でもよい

// canonicalize は \\?\ プレフィックスを返すことがある。比較・結合で扱いにくいので剥がす
fn normalize_fs_path(path: &Path) -> PathBuf {
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canon.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    canon
}

fn load_external_projects(path: &Path) -> Vec<ExternalProject> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("projects").and_then(Value::as_array).cloned())
        .map(|list| {
            list.iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn save_external_projects(path: &Path, list: &[ExternalProject]) {
    if let Ok(text) = serde_json::to_string_pretty(&json!({ "projects": list })) {
        let _ = std::fs::write(path, text);
    }
}

// プロジェクトIDに使える文字だけ残す。非ASCII(日本語等)は - に置き換わる
fn sanitize_project_id(name: &str) -> String {
    let id: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = id.trim_start_matches('.').trim_matches('-');
    let mut id: String = trimmed.chars().take(64).collect();
    if id.is_empty() {
        id = "external".to_string();
    }
    id
}

// フォルダ名から一意なプロジェクトIDを作る。既存 projects/・登録済み外部IDと
// 衝突する場合は -2, -3, ... を付ける
fn unique_external_id(registry: &[ExternalProject], projects_dir: &Path, base: String) -> String {
    let mut id = base.clone();
    let mut seq = 2u32;
    while registry.iter().any(|e| e.id == id) || projects_dir.join(&id).exists() {
        id = format!("{base}-{seq}");
        seq += 1;
    }
    id
}

// プロジェクトフォルダ内の project.json の title を読む
fn read_project_title(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("project.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|title| !title.is_empty())
}

// フォルダ直下の最初の .kasc ファイル名を返す(辞書順)
fn first_kasc_name(dir: &Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let p = entry.path();
            p.is_file()
                && p.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("kasc"))
                    .unwrap_or(false)
        })
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names.into_iter().next()
}

// dir+kasc の組を外部プロジェクトとして登録する(同一組の再登録は冪等)。
// preferred_id/title はプロジェクト群マニフェスト由来の優先値
fn upsert_external_project(
    state: &AppState,
    dir: &Path,
    kasc_name: &str,
    preferred_id: Option<&str>,
    preferred_title: Option<&str>,
) -> Result<ExternalProject, (StatusCode, String)> {
    let dir_key = dir.to_string_lossy().to_string();
    // タイトルは project.json > マニフェスト > フォルダ名 > ファイル名 の順
    let title = read_project_title(dir)
        .or_else(|| preferred_title.map(str::to_string))
        .or_else(|| {
            dir.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .or_else(|| {
            Path::new(kasc_name)
                .file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "external".to_string());
    let base = preferred_id
        .filter(|id| is_valid_project_id(id))
        .map(str::to_string)
        .unwrap_or_else(|| {
            sanitize_project_id(
                dir.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("external"),
            )
        });
    let mut list = state
        .external_projects
        .lock()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "内部エラー".to_string()))?;
    if let Some(existing) = list
        .iter_mut()
        .find(|e| e.dir.eq_ignore_ascii_case(&dir_key) && e.kasc.eq_ignore_ascii_case(kasc_name))
    {
        existing.title = title;
        let project = existing.clone();
        save_external_projects(&state.external_projects_path, &list);
        return Ok(project);
    }
    let project = ExternalProject {
        id: unique_external_id(&list, &state.projects_dir, base),
        title,
        dir: dir_key,
        kasc: kasc_name.to_string(),
    };
    list.push(project.clone());
    save_external_projects(&state.external_projects_path, &list);
    Ok(project)
}

// プロジェクト群マニフェスト(group_dir/projects.json)に列挙された
// プロジェクトをまとめて登録する。エントリは {id,title,dir?,kasc?}。
// dir 省略時は id と同名のサブフォルダ、kasc 省略時はフォルダ内の
// 最初の .kasc を使う
fn register_group_members(state: &AppState, group_dir: &Path) -> Vec<ExternalProject> {
    let Ok(text) = std::fs::read_to_string(group_dir.join(GROUP_MANIFEST_FILE_NAME)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in value.as_array().into_iter().flatten() {
        let Some(dir_name) = entry
            .get("dir")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if dir_name.starts_with('.') || sanitize_file_name(dir_name) != dir_name {
            continue;
        }
        let dir = normalize_fs_path(&group_dir.join(dir_name));
        if !dir.is_dir() || dir.parent() != Some(group_dir) {
            continue;
        }
        let kasc_name = match entry.get("kasc") {
            Some(value) => value.as_str().map(str::to_string),
            None => first_kasc_name(&dir),
        };
        let Some(kasc_name) = kasc_name.filter(|name| {
            sanitize_file_name(name) == *name
                && Path::new(name)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("kasc"))
                && dir.join(name).is_file()
                && normalize_fs_path(&dir.join(name)).parent() == Some(dir.as_path())
        }) else {
            continue;
        };
        if let Ok(project) = upsert_external_project(
            state,
            &dir,
            &kasc_name,
            entry.get("id").and_then(Value::as_str),
            entry.get("title").and_then(Value::as_str),
        ) {
            out.push(project);
        }
    }
    out
}

// .kasc ファイルを外部プロジェクトとして登録する。
// 親フォルダに projects.json(プロジェクト群マニフェスト)があれば
// 群に属する他プロジェクトもまとめて登録する。
// 戻り値は (起動対象の主プロジェクト, 登録された全プロジェクト)
fn register_external_project(
    state: &AppState,
    kasc_path: &Path,
) -> Result<(ExternalProject, Vec<ExternalProject>), (StatusCode, String)> {
    let path = normalize_fs_path(kasc_path);
    if !path.is_file() {
        return Err((
            StatusCode::BAD_REQUEST,
            "ファイルが見つかりません".to_string(),
        ));
    }
    let is_kasc = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("kasc"))
        .unwrap_or(false);
    if !is_kasc {
        return Err((
            StatusCode::BAD_REQUEST,
            ".kasc ファイルではありません".to_string(),
        ));
    }
    let Some(dir) = path.parent().map(Path::to_path_buf) else {
        return Err((
            StatusCode::BAD_REQUEST,
            "フォルダを特定できません".to_string(),
        ));
    };
    let Some(kasc_name) = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
    else {
        return Err((StatusCode::BAD_REQUEST, "ファイル名が不正です".to_string()));
    };
    let mut members = dir
        .parent()
        .map(|group_dir| register_group_members(state, group_dir))
        .unwrap_or_default();
    let primary = match members.iter().find(|member| {
        member.dir.eq_ignore_ascii_case(&dir.to_string_lossy())
            && member.kasc.eq_ignore_ascii_case(&kasc_name)
    }) {
        Some(member) => member.clone(),
        None => upsert_external_project(state, &dir, &kasc_name, None, None)?,
    };
    members.retain(|m| m.id != primary.id);
    let mut all = vec![primary.clone()];
    all.extend(members);
    Ok((primary, all))
}

// プロジェクトの実 .kasc ファイル名(外部プロジェクトは登録名、それ以外は既定名)
fn project_kasc_name(state: &AppState, id: &str) -> String {
    state
        .external_projects
        .lock()
        .ok()
        .and_then(|list| list.iter().find(|e| e.id == id).map(|e| e.kasc.clone()))
        .unwrap_or_else(|| KASC_FILE_NAME.to_string())
}

#[derive(Deserialize)]
struct RegisterProjectRequest {
    path: String,
}

// POST /api/projects/register { path } → .kasc を外部プロジェクトとして登録。
// 親にプロジェクト群マニフェスト(projects.json)があれば群の他プロジェクトも
// まとめて登録し registered に全 id を返す。
// ファイル関連付けで起動済みインスタンスに登録を依頼する用途
async fn register_project(
    State(state): State<AppState>,
    Json(request): Json<RegisterProjectRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (primary, members) = register_external_project(&state, Path::new(&request.path))?;
    let registered: Vec<&str> = members.iter().map(|m| m.id.as_str()).collect();
    Ok(Json(json!({
        "ok": true,
        "id": primary.id,
        "title": primary.title,
        "registered": registered,
    })))
}

// DELETE /api/projects/{id} → 外部プロジェクトの登録解除。
// レジストリから外すだけでファイル・フォルダは削除しない
async fn unregister_project(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let mut list = state
        .external_projects
        .lock()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "内部エラー".to_string()))?;
    let Some(index) = list.iter().position(|e| e.id == id) else {
        return Err((
            StatusCode::NOT_FOUND,
            "外部プロジェクトが見つかりません".to_string(),
        ));
    };
    list.remove(index);
    save_external_projects(&state.external_projects_path, &list);
    Ok(Json(json!({ "ok": true, "id": id })))
}

// 静的 projects.json に外部プロジェクトをマージして返す
fn merged_projects_manifest(state: &AppState) -> Value {
    let mut definitions: Vec<Value> =
        std::fs::read_to_string(state.projects_dir.join("projects.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
    let known: HashSet<String> = definitions
        .iter()
        .filter_map(|def| def.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    // プロジェクトルートの実パスはローカル実行時のみ通知する
    // (コンテナ公開環境でサーバー内パスを見せないため)
    if state.is_local {
        for def in definitions.iter_mut() {
            if let Some(id) = def.get("id").and_then(Value::as_str) {
                def["dir"] = json!(state.projects_dir.join(id).to_string_lossy());
            }
        }
    }
    if let Ok(list) = state.external_projects.lock() {
        for ext in list.iter() {
            if !known.contains(&ext.id) {
                let mut entry = json!({
                    "id": ext.id,
                    "title": ext.title,
                    "external": true,
                });
                if state.is_local {
                    entry["dir"] = json!(ext.dir);
                    entry["kasc"] = json!(ext.kasc);
                }
                definitions.push(entry);
            }
        }
    }
    Value::Array(definitions)
}

// URI パス用の最小限パーセントエンコード。/ はセグメント区切りとして残し、
// それ以外の非 unreserved 文字(空白・日本語等)は UTF-8 バイト列を %XX 化する
fn encode_uri_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// GET /projects/* → プロジェクト内ファイルの配信。
// projects.json は静的定義+外部プロジェクトのマージ結果を返す。
// 外部プロジェクトは登録フォルダから配信し、要求が kasugai_canvas.kasc の
// ときは登録した実ファイル名にマップする(フロントは既定名で取得するため)
async fn serve_project_files(
    State(state): State<AppState>,
    axum::extract::Path(path): axum::extract::Path<String>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let not_found = || (StatusCode::NOT_FOUND, "not found".to_string());
    if path == "projects.json" {
        return Ok(Json(merged_projects_manifest(&state)).into_response());
    }
    let Some((id, rel)) = path.split_once('/') else {
        return Err(not_found());
    };
    if rel.is_empty() || !is_valid_project_id(id) {
        return Err(not_found());
    }
    // セグメントを字句解決する。プロジェクトルートを上に出る ".." の数を
    // depth として数え、危険文字を含むセグメントは拒否する。
    // ".." はブラウザのURL正規化で畳まれるため、外部プロジェクトのフロントは
    // マーカー "@parent" で送ってくる。ここでは ".." と同じ親参照として扱う
    let mut depth = 0u32;
    let mut out: Vec<&str> = Vec::new();
    let mut bad = false;
    for segment in rel.split('/') {
        match segment {
            "" | "." => {}
            ".." | "@parent" => {
                if out.pop().is_none() {
                    depth += 1;
                }
            }
            s if s.chars().any(|c| c.is_control() || c == '\\' || c == ':') => {
                bad = true;
                break;
            }
            s => out.push(s),
        }
    }
    if bad {
        return Err((StatusCode::BAD_REQUEST, "パスが不正です".to_string()));
    }
    let external = state
        .external_projects
        .lock()
        .ok()
        .and_then(|list| list.iter().find(|e| e.id == id).cloned());
    // ".." の許可範囲はプロジェクトフォルダの1階層上(ワークスペース)まで。
    // ただし祖先に projects.json(プロジェクト群マニフェスト)を持つフォルダが
    // 連続する場合、その数だけ追加で上に出られる(群→ワークスペースルート)。
    // 通常プロジェクトはブラウザ側で projects/<id>/.. が正規化されここには
    // 届かないため depth>0 は拒否でよい
    let (root, target) = match &external {
        Some(ext) => {
            let dir = PathBuf::from(&ext.dir);
            let allowed_up = {
                let mut n = 1u32;
                let mut anc = dir.parent();
                while let Some(p) = anc {
                    if p.join(GROUP_MANIFEST_FILE_NAME).is_file() {
                        n += 1;
                        anc = p.parent();
                    } else {
                        break;
                    }
                }
                n
            };
            if depth > allowed_up {
                return Err(not_found());
            }
            let base = dir
                .ancestors()
                .nth(depth as usize)
                .map(Path::to_path_buf)
                .ok_or_else(not_found)?;
            let target = out.join("/");
            (
                base,
                if depth == 0 && target == KASC_FILE_NAME {
                    ext.kasc.clone()
                } else {
                    target
                },
            )
        }
        None => {
            if depth > 0 {
                return Err(not_found());
            }
            (state.projects_dir.join(id), out.join("/"))
        }
    };
    // ServeDir に処理を委譲するため URI をプロジェクトルート相対に書き換える。
    // メソッド・ヘッダ(Range 等)は元リクエストを引き継ぐ
    let (mut parts, _body) = request.into_parts();
    parts.uri = format!("/{}", encode_uri_path(&target))
        .parse()
        .map_err(internal_error)?;
    let forwarded = axum::extract::Request::from_parts(parts, axum::body::Body::empty());
    let response = ServeDir::new(&root)
        .oneshot(forwarded)
        .await
        .map_err(internal_error)?;
    Ok(response.map(axum::body::Body::new))
}

// 起動済みインスタンスへ .kasc の外部プロジェクト登録を依頼し、IDを返す
async fn register_remote_project(port: u16, path: &Path) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let response = client
        .post(format!("http://127.0.0.1:{port}/api/projects/register"))
        .json(&json!({ "path": path.to_string_lossy() }))
        .send()
        .await
        .ok()?;
    let body = response.json::<Value>().await.ok()?;
    body.get("id").and_then(Value::as_str).map(str::to_string)
}

fn open_browser(port: u16, query: &str) {
    let url = format!("http://127.0.0.1:{port}/{query}");
    let _ = opener::open(&url);
}

/// ポートを占有しているのが起動済みの KASUGAI Canvas かどうかを /health で確認する
async fn is_existing_instance(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(response) => match response.json::<Value>().await {
            Ok(body) => body.get("name").and_then(Value::as_str) == Some("kasugai_canvas"),
            Err(_) => false,
        },
        Err(_) => false,
    }
}

fn resolve_dir(
    exe_dir: &Option<PathBuf>,
    name: &str,
    fallback: impl FnOnce() -> PathBuf,
) -> PathBuf {
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
    // Cloud Run 等のコンテナ環境は PORT が設定される。その場合は 0.0.0.0 で待ち受け、
    // 未設定のローカル実行は従来通り localhost のみにバインドする
    let cloud_port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok());
    let port = cloud_port
        .or_else(|| {
            std::env::var("KASUGAI_CANVAS_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(8510);
    let host: [u8; 4] = if cloud_port.is_some() {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };
    let address = SocketAddr::from((host, port));

    // ウィンドウレス実行のため、引数なし起動(手動作成ショートカット・exe ダブルクリック)でも
    // 何も見えない事故を防ぐべく、ブラウザを開くのを既定とする。サイレント起動は --no-browser
    // (自動更新の再起動・run.py が使用)。--open-browser は後方互換のため受理する(既定と同じ挙動)。
    // コンテナ実行(PORT 設定時)はブラウザを開かない
    let open_browser_requested =
        cloud_port.is_none() && !std::env::args().any(|arg| arg == "--no-browser");

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from));
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_dir = manifest_dir
        .parent()
        .ok_or("Cargo manifest has no parent directory")?;

    // .kasc ファイル関連付けからの起動引数。インストーラの open コマンドが
    // "kasugai_canvas.exe" "--open-browser" "%1" を実行するため、
    // --xxx オプション以外の引数で .kasc 拡張子のものをファイル指定とみなす
    let kasc_arg = std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .filter(|arg| {
            Path::new(arg)
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("kasc"))
                .unwrap_or(false)
        })
        .map(PathBuf::from);

    let executable_directory = exe_dir
        .as_ref()
        .cloned()
        .unwrap_or_else(|| repo_dir.to_path_buf());
    let web_dir = resolve_dir(&exe_dir, "web", || repo_dir.join("web"));
    let projects_dir = resolve_dir(&exe_dir, "projects", || repo_dir.join("installer/projects"));

    // コンテナ実行(PORT 設定時)は高権限APIを公開しない
    let is_local = cloud_port.is_none();

    let external_projects_path = executable_directory.join(EXTERNAL_PROJECTS_FILE_NAME);
    let state = AppState {
        update_config_path: Arc::new(executable_directory.join(UPDATE_CONFIG_FILE_NAME)),
        cloud_config_path: Arc::new(executable_directory.join(CLOUD_CONFIG_FILE_NAME)),
        external_projects_path: Arc::new(external_projects_path.clone()),
        external_projects: Arc::new(StdMutex::new(load_external_projects(
            &external_projects_path,
        ))),
        cloud: Arc::new(Mutex::new(CloudState::default())),
        shutdown: Arc::new(Notify::new()),
        port,
        web_dir: Arc::new(web_dir.clone()),
        projects_dir: Arc::new(projects_dir.clone()),
        is_local,
    };

    // 引数指定の .kasc を外部プロジェクトとして登録し、そのプロジェクトで開く
    let mut startup_query = String::new();
    if let Some(path) = &kasc_arg {
        match register_external_project(&state, path) {
            Ok((primary, members)) => {
                if members.len() > 1 {
                    eprintln!(
                        "プロジェクト群を登録しました: {}",
                        members
                            .iter()
                            .map(|m| m.id.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                }
                startup_query = format!("?project={}", primary.id);
            }
            Err((_, error)) => eprintln!(".kasc の登録に失敗しました: {error}"),
        }
    }

    let mut app = Router::new()
        .route("/health", get(health))
        .route("/api/capabilities", get(capabilities))
        .route("/api/fetch", get(fetch_proxy).head(fetch_proxy))
        .route("/api/plugins", post(save_plugin))
        .route("/api/plugins/{id}", delete(delete_plugin))
        .route("/api/files", get(list_data_files))
        .route(
            "/api/files/{project}/{*path}",
            put(write_data_file)
                .delete(delete_data_file)
                .layer(DefaultBodyLimit::max(FILE_WRITE_MAX_BYTES)),
        )
        .route(
            "/api/update/settings",
            get(get_update_settings).put(put_update_settings),
        )
        .route("/api/update/latest", get(update_latest))
        .route("/api/update/install", post(install_update))
        .route("/api/shutdown", post(request_shutdown));

    // クラウドストレージ(rclone)連携・外部プロジェクト登録はローカル実行時のみ公開する
    if is_local {
        app = app
            .route("/api/projects/register", post(register_project))
            .route("/api/projects/{id}", delete(unregister_project))
            .route("/api/cloud/status", get(cloud_status))
            .route("/api/cloud/path", post(cloud_set_path))
            .route("/api/cloud/install", post(cloud_install))
            .route("/api/cloud/config", post(cloud_config))
            .route("/api/cloud/serve", post(cloud_serve))
            .route("/api/cloud/stop", post(cloud_stop))
            .route("/api/cloud/drive", post(cloud_drive))
            .route("/api/cloud/list", get(cloud_list))
            .route("/api/cloud/localize", post(cloud_localize))
            .route(
                "/api/cloud/file",
                get(cloud_get_file)
                    .put(cloud_put_file)
                    .delete(cloud_delete_file)
                    .layer(DefaultBodyLimit::max(CLOUD_WRITE_MAX_BYTES)),
            );
    }

    let app = app
        .route("/projects/{*path}", get(serve_project_files))
        .fallback_service(ServeDir::new(web_dir).append_index_html_on_directories(true))
        .with_state(state.clone());

    // ウィンドウレス実行(windows_subsystem="windows")のためバインド失敗は利用者に見えない。
    // 既に起動済みのインスタンスがポートを占有している場合は、無言終了ではなく
    // 既存インスタンスのブラウザを開いて正常終了する(ショートカット再クリック対策)
    let listener = match TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            if is_existing_instance(port).await {
                println!("KASUGAI Canvas は既に起動しています: http://{address}");
                // 引数の .kasc は起動済みインスタンスへ登録を依頼し、
                // そのプロジェクトをブラウザで開く
                let mut query = String::new();
                if let Some(path) = &kasc_arg {
                    if let Some(id) = register_remote_project(port, path).await {
                        query = format!("?project={id}");
                    }
                }
                if open_browser_requested {
                    open_browser(port, &query);
                }
                return Ok(());
            }
            return Err(err.into());
        }
        Err(err) => return Err(err.into()),
    };
    println!("KASUGAI Canvas: http://{address}");

    if open_browser_requested {
        let query = startup_query.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            open_browser(port, &query);
        });
    }

    let shutdown = state.shutdown.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { shutdown.notified().await })
        .await?;

    // rclone serve 子プロセスが残らないようにする(ドライブ割当はOS側の設定なので残る)
    if let Some(mut serve) = state.cloud.lock().await.serve.take() {
        let _ = serve.child.kill().await;
    }
    Ok(())
}
