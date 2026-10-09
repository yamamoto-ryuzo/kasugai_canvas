#![windows_subsystem = "windows"]

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use tower_http::services::ServeDir;

const UPDATE_CONFIG_FILE_NAME: &str = "kasugai_canvas.update.json";
const CLOUD_CONFIG_FILE_NAME: &str = "kasugai_canvas.cloud.json";
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

#[derive(Clone)]
struct AppState {
    update_config_path: Arc<PathBuf>,
    cloud_config_path: Arc<PathBuf>,
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

// projects/<project>/DATA/ 以下の相対パスを検証して絶対パスへ解決する。
// ".." やドライブ指定・バックスラッシュを拒否し、書き込みを DATA/ 内に限定する
fn resolve_data_path(
    projects_dir: &Path,
    project: &str,
    rel: &str,
) -> Result<PathBuf, (StatusCode, String)> {
    if !is_valid_project_id(project) {
        return Err((
            StatusCode::BAD_REQUEST,
            "プロジェクトIDが不正です".to_string(),
        ));
    }
    let mut path = projects_dir.join(project).join("DATA");
    if rel.is_empty() {
        return Ok(path);
    }
    if rel.len() > 512 {
        return Err((
            StatusCode::BAD_REQUEST,
            "パスが長すぎます".to_string(),
        ));
    }
    for segment in rel.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment
                .chars()
                .any(|c| c.is_control() || c == '\\' || c == ':')
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "ファイル名が不正です".to_string(),
            ));
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
    let dir = resolve_data_path(&state.projects_dir, &query.project, "")?;
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
    let path = resolve_data_path(&state.projects_dir, &project, &rel)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(internal_error)?;
    }
    tokio::fs::write(&path, &body).await.map_err(internal_error)?;
    Ok(Json(json!({ "ok": true, "name": rel })))
}

async fn delete_data_file(
    State(state): State<AppState>,
    axum::extract::Path((project, rel)): axum::extract::Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = resolve_data_path(&state.projects_dir, &project, &rel)?;
    if path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            "フォルダは削除できません".to_string(),
        ));
    }
    if path.exists() {
        tokio::fs::remove_file(&path).await.map_err(internal_error)?;
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
        (StatusCode::BAD_REQUEST, "ルートフォルダのURLが不正です".to_string())
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
        if let Ok(output) = new_rclone_command(exe)
            .arg("version")
            .output()
            .await
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().next() {
                // "rclone v1.75.2" → "v1.75.2" に整形
                let line = line.trim();
                version = json!(line.strip_prefix("rclone ").unwrap_or(line));
            }
        }
        if let Ok(output) = new_rclone_command(exe)
            .arg("listremotes")
            .output()
            .await
        {
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
            return Err((StatusCode::INTERNAL_SERVER_ERROR, "ZIP展開に失敗しました".to_string()));
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
            return Err((StatusCode::INTERNAL_SERVER_ERROR, "ZIP展開に失敗しました".to_string()));
        }
    }
    // rclone-vX.Y.Z-<os>-<arch>/rclone[.exe] を探して exe 隣の rclone/ へ移す
    let exe_name = if cfg!(windows) { "rclone.exe" } else { "rclone" };
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
    let dest = match request.dir.as_deref().map(str::trim).filter(|dir| !dir.is_empty()) {
        Some(dir) => {
            if dir.len() > 260 || dir.chars().any(|c| c.is_control()) {
                return Err((StatusCode::BAD_REQUEST, "インストール先が不正です".to_string()));
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
    tokio::fs::copy(&found, &dest).await.map_err(internal_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest).map_err(internal_error)?.permissions();
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
        || !remote_type.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
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
    let port = listener
        .local_addr()
        .map_err(internal_error)?
        .port();
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
            format!("ドライブ割り当てに失敗しました: {}{}", stdout.trim(), stderr.trim()),
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
    let remote = normalize_remote_name(&request.remote).ok_or((
        StatusCode::BAD_REQUEST,
        "リモート名が不正です".to_string(),
    ))?;
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
    let (root, remote_spec, folder_id) = match resolve_cloud_root(&exe, &remote, &request.root).await? {
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
}

// .kasc 各行の | 区切りフィールドで "cloud:xxx" を "DATA/xxx" に置き換える
fn rewrite_cloud_refs(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            line.split('|')
                .map(|part| {
                    let trimmed = part.trim_start();
                    match trimmed.strip_prefix("cloud:") {
                        // ../ 等を含む参照は DATA/ に置き換えると
                        // プロジェクト外に出るため書き換えない
                        Some(rest) if is_valid_cloud_path(rest) => {
                            let indent = &part[..part.len() - trimmed.len()];
                            format!("{indent}DATA/{rest}")
                        }
                        _ => part.to_string(),
                    }
                })
                .collect::<Vec<_>>()
                .join("|")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// 接続中のクラウドルートを projects/<project>/DATA/ へ丸ごとコピーし、
// .kasc 内の cloud: 参照を DATA/ 相対に書き換える(納品用ローカル化)。
// 納品先は rclone 設定・OAuth 不要でファイル一式だけで動く構成になる
async fn cloud_localize(
    State(state): State<AppState>,
    Json(request): Json<CloudLocalizeRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !is_valid_project_id(&request.project) {
        return Err((StatusCode::BAD_REQUEST, "プロジェクトIDが不正です".to_string()));
    }
    let (exe, source) = {
        let cloud = state.cloud.lock().await;
        let serve = cloud.serve.as_ref().ok_or((
            StatusCode::CONFLICT,
            "クラウドに接続していません".to_string(),
        ))?;
        let exe = rclone_exe(&state).await.ok_or((
            StatusCode::BAD_REQUEST,
            "rclone が見つかりません".to_string(),
        ))?;
        (exe, serve_target(serve, ""))
    };
    let project_dir = state.projects_dir.join(&request.project);
    if !project_dir.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            "プロジェクトが見つかりません".to_string(),
        ));
    }
    let data_dir = resolve_data_path(&state.projects_dir, &request.project, "")?;
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(internal_error)?;
    let output = new_rclone_command(&exe)
        .args(["copy", &source])
        .arg(&data_dir)
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
    let kasc_path = project_dir.join("kasugai_canvas.kasc");
    let mut kasc_rewritten = false;
    if let Ok(text) = tokio::fs::read_to_string(&kasc_path).await {
        let rewritten = rewrite_cloud_refs(&text);
        if rewritten != text {
            tokio::fs::write(&kasc_path, &rewritten)
                .await
                .map_err(internal_error)?;
            kasc_rewritten = true;
        }
    }
    Ok(Json(json!({ "ok": true, "kascRewritten": kasc_rewritten })))
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
    let pa: Vec<u64> = a.split('.').map(|p| p.trim().parse().unwrap_or(0)).collect();
    let pb: Vec<u64> = b.split('.').map(|p| p.trim().parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        match pa.get(i).copied().unwrap_or(0).cmp(&pb.get(i).copied().unwrap_or(0)) {
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

fn open_browser(port: u16) {
    let url = format!("http://127.0.0.1:{port}/");
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

    let executable_directory = exe_dir
        .as_ref()
        .cloned()
        .unwrap_or_else(|| repo_dir.to_path_buf());
    let web_dir = resolve_dir(&exe_dir, "web", || repo_dir.join("web"));
    let projects_dir = resolve_dir(&exe_dir, "projects", || repo_dir.join("installer/projects"));

    // コンテナ実行(PORT 設定時)は高権限APIを公開しない
    let is_local = cloud_port.is_none();

    let state = AppState {
        update_config_path: Arc::new(executable_directory.join(UPDATE_CONFIG_FILE_NAME)),
        cloud_config_path: Arc::new(executable_directory.join(CLOUD_CONFIG_FILE_NAME)),
        cloud: Arc::new(Mutex::new(CloudState::default())),
        shutdown: Arc::new(Notify::new()),
        port,
        web_dir: Arc::new(web_dir.clone()),
        projects_dir: Arc::new(projects_dir.clone()),
        is_local,
    };

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

    // クラウドストレージ(rclone)連携はローカル実行時のみ公開する
    if is_local {
        app = app
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
        .nest_service("/projects", ServeDir::new(projects_dir))
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
                if open_browser_requested {
                    open_browser(port);
                }
                return Ok(());
            }
            return Err(err.into());
        }
        Err(err) => return Err(err.into()),
    };
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

    // rclone serve 子プロセスが残らないようにする(ドライブ割当はOS側の設定なので残る)
    if let Some(mut serve) = state.cloud.lock().await.serve.take() {
        let _ = serve.child.kill().await;
    }
    Ok(())
}
