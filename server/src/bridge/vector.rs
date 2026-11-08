// ローカルベクトルサービス: ネイティブ DuckDB CLI をバックエンドに
// parquet / gpkg / fgb / geojson / csv を永続 .duckdb へ取り込み、
// GeoJSON として HTTP 配信する。
//
// 目的: ブラウザ側（Re:Earth geo_suite / KASUGAI Canvas）が
// `geojson: http://127.0.0.1:8511/vector/geojson/<name>` の1行で
// ベクターレイヤーを表示できるようにすること。DuckDB-Wasm の
// セッション毎 ~15s 初期化・opaque origin のキャッシュ不可・
// 拡張ctx 4MB 制約を全て回避する。永続 DB は CANVAS 等の
// 他クライアントとも共有できる。
//
//   GET    /vector/status          duckdb 検出・ストア・登録ソース
//   GET    /vector/sources         登録ソース一覧
//   POST   /vector/sources         {name, src|sql, kind?, layer?, lon?, lat?,
//                                   geom_col?, where?, limit?, materialize?,
//                                   force?}
//                                  冪等: 同一 spec の再 POST は cached 応答、
//                                  force:true で強制再取込み。登録中は manifest
//                                  に materializing:true、テーブル欠落は
//                                  missing:true として /sources で見える
//   DELETE /vector/sources/{name}  登録解除（テーブル/ビュー drop）
//   GET    /vector/geojson/{name}  GeoJSON 配信
//                                  ?where=&bbox=w,s,e,n&limit=&simplify=<deg>&columns=a,b
//   POST   /vector/query           {sql: "SELECT ..."} → GeoJSON
//                                  （geom 列を含む SELECT。ローカル任意SQL）
//
// 信頼境界: 127.0.0.1 専用のローカルエージェント経路（/agent と同等）。
// 到達者は登録ソースの内容と（query / kind:"sql" 経由で）ローカルファイルを
// 読める点に注意。duckdb CLI の導入は /setup {provider:"duckdb"} または
// bridge-hub.exe --setup duckdb。
use super::common;
use axum::body::Bytes;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

// spatial/geo 系 SQL の前処理。INSTALL はインストール済みならローカルで
// no-op になる（拡張は ~/.duckdb/extensions に永続化される）
const PRELUDE: &str = "INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;";

// duckdb 書き込み実行の直列化。永続 .duckdb はプロセス横断の書込みロックを
// 取るため、書き込み呼び出しは1本に絞る。:memory: / -readonly は排他ロックを
// 取らないため直列化しない（取込み中でも DESCRIBE・geojson 参照が待たない）
fn duckdb_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

// 直列化しない duckdb 実行（:memory:/-readonly）の同時起動数上限。
// リモート読込みを伴う DESCRIBE 等が重なっても暴走しないよう絞る
fn spawn_sem() -> &'static tokio::sync::Semaphore {
    static S: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(4))
}

async fn acquire_spawn(
    deadline: tokio::time::Instant,
) -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    tokio::time::timeout_at(deadline, spawn_sem().acquire())
        .await
        .map_err(|_| "duckdb 実行スロットの取得がタイムアウト".to_string())?
        .map_err(|_| "duckdb 実行スロットが閉じています".to_string())
}

// ベクトルストア: 永続 .duckdb とソースレジストリ(sources.json)の置き場。
// CANVAS 等他クライアントとの共有を意識し CLI 管理領域(bridge-cli)とは分離
pub fn store_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("kasugai").join("vector");
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("kasugai")
        .join("vector")
}

fn db_path() -> PathBuf {
    store_dir().join("vector.duckdb")
}

fn manifest_path() -> PathBuf {
    store_dir().join("sources.json")
}

// duckdb CLI の検出順: DUCKDB_CLI_PATH 環境変数 → ハブ管理パス → PATH
pub fn duckdb_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DUCKDB_CLI_PATH") {
        if !p.is_empty() && PathBuf::from(&p).is_file() {
            return Some(PathBuf::from(p));
        }
    }
    let managed = common::managed_cli("duckdb");
    if managed.is_file() {
        return Some(managed);
    }
    common::find_executable("duckdb")
}

fn missing_cli() -> String {
    "duckdb CLI が見つかりません。POST /setup {\"provider\":\"duckdb\",\"action\":\"install\",\"confirm\":true} または bridge-hub.exe --setup duckdb で導入してください".to_string()
}

// duckdb <db> -json -c "<sql>" を実行し stdout を返す。
// persistent=true で永続 vector.duckdb（書込み・直列化）、false で :memory:
// （DESCRIBE 等。ファイル競合がないため直列化しない）。
// timeout_secs はロック取得待ちを含む総デッドライン。
async fn run_duckdb(sql: &str, persistent: bool, timeout_secs: u64) -> Result<String, String> {
    let cli = duckdb_cli().ok_or_else(missing_cli)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    if !persistent {
        let _permit = acquire_spawn(deadline).await?;
        return duckdb_once(&cli, sql, false, false, deadline).await;
    }
    // 書込みパス: グローバル直列化。先行処理のハングで無制限待ちにならない
    // ようロック取得にも残り時間でタイムアウトを掛ける
    duckdb_write(&cli, sql, deadline).await
}

async fn lock_write(
    deadline: tokio::time::Instant,
) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    tokio::time::timeout_at(deadline, duckdb_lock().lock())
        .await
        .map_err(|_| "duckdb が混み合っています（前の処理がデッドライン内に終わらない）".to_string())
}

// ロック取得済みの書込み実行。-readonly 子プロセスの共有ロックと競合した
// 場合（"File is already open"）は読み取り完了を想定してデッドラインまで
// 短い間隔で再試行する
async fn duckdb_write(
    cli: &std::path::Path,
    sql: &str,
    deadline: tokio::time::Instant,
) -> Result<String, String> {
    let _guard = lock_write(deadline).await?;
    loop {
        match duckdb_once(cli, sql, true, false, deadline).await {
            Err(e) if is_lock_error(&e) => {
                let remain =
                    deadline.saturating_duration_since(tokio::time::Instant::now());
                if remain < Duration::from_millis(500) {
                    return Err(e);
                }
                tokio::time::sleep(Duration::from_millis(250).min(remain)).await;
            }
            r => return r,
        }
    }
}

// 永続 DB への読み取り専用実行。-readonly（共有ロック）で開くため読み取り
// 同士は並行でき、書込みプロセス占有中・WAL 回復待ち・未作成時のみ即時
// エラーとなる。その場合は書込み直列化パスにフォールバックして待ち合わせる
async fn run_duckdb_read(sql: &str, timeout_secs: u64) -> Result<String, String> {
    let cli = duckdb_cli().ok_or_else(missing_cli)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    if db_path().is_file() {
        let _permit = acquire_spawn(deadline).await?;
        match duckdb_once(&cli, sql, true, true, deadline).await {
            Ok(o) => return Ok(o),
            Err(e) if is_lock_error(&e) => {}
            Err(e) => return Err(e),
        }
    }
    duckdb_write(&cli, sql, deadline).await
}

// -readonly での単発実行（フォールバック無し）。書込み占有中・WAL 回復待ち
// 等で開けない場合は None。reconcile のような任意の健全性チェック用
async fn try_duckdb_readonly(sql: &str, timeout_secs: u64) -> Option<String> {
    let cli = duckdb_cli()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let _permit = acquire_spawn(deadline).await.ok()?;
    duckdb_once(&cli, sql, true, true, deadline).await.ok()
}

// 読み取り専用オープンの失敗が「DB の排他占有・未回復」由来か判定。
// SQL エラー等はフォールバックせずそのまま返す
fn is_lock_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("cannot open") || m.contains("already open") || m.contains("lock")
}

async fn duckdb_once(
    cli: &std::path::Path,
    sql: &str,
    persistent: bool,
    readonly: bool,
    deadline: tokio::time::Instant,
) -> Result<String, String> {
    let mut cmd = common::new_command(&cli.to_string_lossy());
    if persistent {
        let db = db_path();
        if readonly {
            cmd.arg("-readonly");
        } else if let Some(parent) = db.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        cmd.arg(&db);
    } else {
        cmd.arg(":memory:");
    }
    // -no-agent: v2.0.0〜 AI_AGENT 環境変数があると agent mode の
    // バナーが出力されるのを抑止（-json 出力の保護）
    cmd.args(["-json", "-no-agent", "-c", sql])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // タイムアウト時に子プロセスが孤児化して vector.duckdb のロックを
        // 保持し続けるのを防ぐ（output() future drop で Child も kill される）
        .kill_on_drop(true);
    let out = match tokio::time::timeout_at(deadline, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("duckdb の起動に失敗: {e}")),
        Err(_) => return Err("duckdb がタイムアウト".to_string()),
    };
    if !out.status.success() {
        let stderr: String = String::from_utf8_lossy(&out.stderr).chars().take(2000).collect();
        let stdout: String = String::from_utf8_lossy(&out.stdout).chars().take(1000).collect();
        return Err(format!(
            "duckdb 失敗 (code {:?}): {stderr}{stdout}",
            out.status.code()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// -json 出力を行配列へ。複数ステートメントで結果が連続出力された場合は
// 最後の JSON 配列を取る
fn parse_rows(out: &str) -> Result<Vec<Value>, String> {
    let t = out.trim();
    if t.is_empty() {
        return Ok(Vec::new());
    }
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Ok(v.as_array().cloned().unwrap_or_default());
    }
    let start = t.rfind("\n[").map(|i| i + 1).or_else(|| t.find('[')).unwrap_or(0);
    let end = t.rfind(']').map(|i| i + 1).unwrap_or(t.len());
    if end <= start {
        return Err(format!("出力の解析に失敗: {}", &t[..t.len().min(500)]));
    }
    let v: Value = serde_json::from_str(&t[start..end])
        .map_err(|e| format!("出力の解析に失敗: {e}"))?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

// SQL 文字列リテラル用: シングルクォートを重ね、Windows パスの \ を / へ
fn lit(s: &str) -> String {
    s.replace('\\', "/").replace('\'', "''")
}

fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn table_name(name: &str) -> String {
    format!("v_{name}")
}

// ---- ソースレジストリ（sources.json） ----

fn load_manifest() -> Value {
    std::fs::read_to_string(manifest_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "sources": {} }))
}

fn save_manifest(m: &Value) -> Result<(), String> {
    let dir = store_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("ストアを作れません: {e}"))?;
    let tmp = manifest_path().with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(m).unwrap_or_default())
        .map_err(|e| format!("レジストリの書込みに失敗: {e}"))?;
    std::fs::rename(&tmp, manifest_path()).map_err(|e| format!("レジストリの保存に失敗: {e}"))?;
    Ok(())
}

fn source_entry(name: &str) -> Option<Value> {
    load_manifest()
        .pointer(&format!("/sources/{name}"))
        .cloned()
}

// 鮮度情報の採取(#65): リモート src は HEAD の ETag/Last-Modified/
// Content-Length、ローカルファイルは mtime+size を記録する。
// 取得不能は None（判定不能として現状維持・誤 stale 化を防ぐ）
async fn source_freshness(src: &str) -> Option<Value> {
    if src.starts_with("http://") || src.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .ok()?;
        let r = client.head(src).send().await.ok()?;
        let h = r.headers();
        let gs = |k: &str| {
            h.get(k).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
        };
        Some(json!({
            "type": "remote",
            "etag": gs("etag"),
            "lastModified": gs("last-modified"),
            "length": gs("content-length").and_then(|s| s.parse::<u64>().ok()),
        }))
    } else {
        let meta = std::fs::metadata(src).ok()?;
        let mtime = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        Some(json!({ "type": "local", "mtime": mtime, "size": meta.len() }))
    }
}

// 記録済み fresh と最新 probe の比較。Some(true)=stale / Some(false)=同一 /
// None=判定不能。stored が Null(旧エントリ)は基線なし→Some(false)で記録のみ
fn freshness_changed(stored: &Value, probe: Value) -> Option<bool> {
    if stored.is_null() {
        return Some(false);
    }
    match stored.get("type").and_then(|v| v.as_str()) {
        Some("remote") => {
            let mut comparable = false;
            for k in ["etag", "lastModified", "length"] {
                let a = stored.get(k).cloned().unwrap_or(Value::Null);
                let b = probe.get(k).cloned().unwrap_or(Value::Null);
                if !a.is_null() && !b.is_null() {
                    comparable = true;
                    if a != b {
                        return Some(true);
                    }
                }
            }
            if comparable {
                Some(false)
            } else {
                None
            }
        }
        Some("local") => {
            let a = stored.get("mtime").and_then(|v| v.as_u64());
            let b = probe.get("mtime").and_then(|v| v.as_u64());
            let sa = stored.get("size").and_then(|v| v.as_u64());
            let sb = probe.get("size").and_then(|v| v.as_u64());
            if (a.is_some() && b.is_some() && a != b)
                || (sa.is_some() && sb.is_some() && sa != sb)
            {
                return Some(true);
            }
            if (a.is_some() && b.is_some()) || (sa.is_some() && sb.is_some()) {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

// ソース名ごとの登録直列化。同一 name の POST/DELETE を1本に絞り、
// 重複登録による materialize の二重走行を防ぐ。ガードは future drop で
// 解放されるため、リクエスト切断・タイムアウトでも後続が詰まらない
fn name_lock(name: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static M: OnceLock<std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    let m = M.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut map = m.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(name.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

// manifest(sources.json) と永続 DB の実テーブルを照合し、テーブルが
// 存在しないエントリへ missing:true を付ける（復旧したら消す）。
// 「登録済みだが配信できない」状態をクライアントから識別可能にする。
// 60秒に1回まで・失敗時は現状維持（書込み占有中は次回に持ち越し）
async fn reconcile() {
    static LAST: OnceLock<tokio::sync::Mutex<std::time::Instant>> = OnceLock::new();
    let last = LAST.get_or_init(|| {
        tokio::sync::Mutex::new(std::time::Instant::now() - Duration::from_secs(3600))
    });
    {
        let mut g = last.lock().await;
        if g.elapsed() < Duration::from_secs(60) {
            return;
        }
        *g = std::time::Instant::now();
    }
    let tables: Option<std::collections::HashSet<String>> = if !db_path().is_file() {
        Some(Default::default())
    } else {
        // フォールバック無しの readonly 単発 — 書込み占有中は確認を
        // 持ち越して status/sources の応答をブロックしない
        try_duckdb_readonly(
            "SELECT table_name FROM information_schema.tables WHERE starts_with(table_name, 'v_');",
            30,
        )
        .await
        .map(|out| {
            parse_rows(&out)
                .unwrap_or_default()
                .iter()
                .filter_map(|r| {
                    r.get("table_name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
    };
    let Some(tables) = tables else { return };
    let mut m = load_manifest();
    let mut changed = false;
    // ---- 鮮度チェック(#65): 登録時に記録した fresh と現在値を比較し、
    // 変化があれば stale:true を付与する。probe 失敗は判定不能として扱わない
    let probes: Vec<(String, String, Value)> = m
        .get("sources")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(n, e)| {
                    if e.get("materializing").and_then(|v| v.as_bool()) == Some(true) {
                        return None;
                    }
                    let src = e.get("src").and_then(|v| v.as_str())?.to_string();
                    let fresh = e.get("fresh").cloned().unwrap_or(Value::Null);
                    Some((n.clone(), src, fresh))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut fresh_results: std::collections::HashMap<String, (Option<bool>, Value)> =
        Default::default();
    for (n, src, stored) in probes {
        if let Some(pr) = source_freshness(&src).await {
            fresh_results.insert(n, (freshness_changed(&stored, pr.clone()), pr));
        }
    }
    if let Some(sources) = m.get_mut("sources").and_then(|v| v.as_object_mut()) {
        for e in sources.values_mut() {
            if e.get("materializing").and_then(|v| v.as_bool()) == Some(true) {
                continue;
            }
            let t = e.get("table").and_then(|v| v.as_str()).unwrap_or("");
            if t.is_empty() {
                continue;
            }
            let missing = !tables.contains(t);
            let cur = e.get("missing").and_then(|v| v.as_bool()).unwrap_or(false);
            if missing != cur {
                e["missing"] = json!(missing);
                changed = true;
            }
        }
        // 鮮度比較結果の反映: fresh 基線の更新と stale フラグの付与/解除
        for (n, e) in sources.iter_mut() {
            if let Some((st, pr)) = fresh_results.remove(n.as_str()) {
                if e.get("fresh") != Some(&pr) {
                    e["fresh"] = pr;
                    changed = true;
                }
                match st {
                    Some(true) => {
                        if e.get("stale").and_then(|v| v.as_bool()) != Some(true) {
                            e["stale"] = json!(true);
                            changed = true;
                        }
                    }
                    Some(false) => {
                        if e.get("stale").and_then(|v| v.as_bool()) == Some(true) {
                            e["stale"] = json!(false);
                            changed = true;
                        }
                    }
                    None => {}
                }
            }
        }
    }
    if changed {
        let _ = save_manifest(&m);
    }
}

// ---- 入力形式 → duckdb リーダ ----

fn kind_of(src: &str, declared: Option<&str>) -> Result<String, String> {
    if let Some(k) = declared {
        return Ok(k.to_lowercase());
    }
    let path = src.split('?').next().unwrap_or(src).to_lowercase();
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "parquet" | "geoparquet" | "pq" => Ok("parquet".into()),
        "gpkg" | "geopackage" => Ok("gpkg".into()),
        "fgb" | "flatgeobuf" => Ok("fgb".into()),
        "geojson" | "json" => Ok("geojson".into()),
        "csv" | "tsv" | "txt" => Ok("csv".into()),
        "shp" | "zip" => Ok("shp".into()),
        _ => Err(format!(
            "kind を特定できません（拡張子 .{ext}）。kind= を指定してください"
        )),
    }
}

fn reader_sql(kind: &str, src: &str, layer: Option<&str>, sql: Option<&str>) -> Result<String, String> {
    match kind {
        "sql" => {
            let s = sql.ok_or("kind:sql には sql= が必要です")?;
            Ok(format!("({s})"))
        }
        "parquet" | "geoparquet" | "pq" => Ok(format!("read_parquet('{}')", lit(src))),
        "gpkg" | "geopackage" => {
            let l = layer
                .map(|x| format!(", layer='{}'", lit(x)))
                .unwrap_or_default();
            Ok(format!("ST_Read('{}'{l})", lit(src)))
        }
        "fgb" | "flatgeobuf" | "geojson" | "json" | "shp" => {
            Ok(format!("ST_Read('{}')", lit(src)))
        }
        "csv" | "tsv" => Ok(format!(
            "read_csv('{}', header=true, auto_detect=true)",
            lit(src)
        )),
        _ => Err(format!("unknown kind: {kind}")),
    }
}

// DESCRIBE でスキーマを取得（:memory: で実行。リーダの読込み自体は走るが
// 結果スキーマの取得のみ）
async fn describe_cols(reader: &str) -> Result<Vec<(String, String)>, String> {
    let sql = format!("{PRELUDE} DESCRIBE SELECT * FROM {reader};");
    let out = run_duckdb(&sql, false, 180).await?;
    let rows = parse_rows(&out)?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let n = r.get("column_name").and_then(|v| v.as_str())?.to_string();
            let t = r
                .get("column_type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some((n, t))
        })
        .collect())
}

// (列名, GEOMETRY型か) を返す。GEOMETRY 型 → そのまま、
// geometry/geom/wkb_geometry/the_geom 名または BLOB → WKB として扱う
fn pick_geom(cols: &[(String, String)]) -> (Option<String>, bool) {
    for (n, t) in cols {
        if t.to_uppercase().contains("GEOMETRY") {
            return (Some(n.clone()), true);
        }
    }
    for cand in ["geometry", "geom", "wkb_geometry", "the_geom"] {
        if let Some((n, _)) = cols.iter().find(|(n, _)| n.eq_ignore_ascii_case(cand)) {
            return (Some(n.clone()), false);
        }
    }
    for (n, t) in cols {
        if t.eq_ignore_ascii_case("BLOB") {
            return (Some(n.clone()), false);
        }
    }
    (None, false)
}

fn pick_lonlat(cols: &[(String, String)]) -> Option<(String, String)> {
    let find = |keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some((n, _)) = cols.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)) {
                return Some(n.clone());
            }
        }
        None
    };
    let lon = find(&["lon", "lng", "longitude", "x"])?;
    let lat = find(&["lat", "latitude", "y"])?;
    Some((lon, lat))
}

// ---- ハンドラ ----

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn parse_body(body: &Bytes, max: usize) -> Result<Value, Response> {
    if body.len() > max {
        return Err(err(StatusCode::BAD_REQUEST, "body too large"));
    }
    serde_json::from_slice(body)
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("invalid json: {e}")))
}

pub async fn status() -> Response {
    reconcile().await;
    let cli = duckdb_cli();
    let mut version = Value::Null;
    if let Some(p) = &cli {
        let out = common::new_command(&p.to_string_lossy())
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .output();
        if let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(10), out).await {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !v.is_empty() {
                version = json!(v);
            }
        }
    }
    let db = db_path();
    let manifest = load_manifest();
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "duckdb": {
                "found": cli.is_some(),
                "path": cli.map(|p| p.to_string_lossy().to_string()),
                "version": version,
                "install": "POST /setup {\"provider\":\"duckdb\",\"action\":\"install\",\"confirm\":true}",
            },
            "store_dir": store_dir().to_string_lossy(),
            "db": {
                "path": db.to_string_lossy(),
                "exists": db.is_file(),
                "size_bytes": db.metadata().ok().map(|m| m.len()),
            },
            "sources": manifest.get("sources").cloned().unwrap_or(json!({})),
        })),
    )
        .into_response()
}

pub async fn list_sources() -> Response {
    reconcile().await;
    let m = load_manifest();
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "sources": m.get("sources").cloned().unwrap_or(json!({})) })),
    )
        .into_response()
}

// POST /vector/sources — ソースを登録し永続 DB へ取り込む
pub async fn register_source(body: Bytes) -> Response {
    let body = match parse_body(&body, 256 * 1024) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !valid_name(name) {
        return err(
            StatusCode::BAD_REQUEST,
            "name は [A-Za-z0-9_] 1〜64文字で指定してください",
        );
    }
    let src = body.get("src").and_then(|v| v.as_str()).unwrap_or("").trim();
    let inline_sql = body.get("sql").and_then(|v| v.as_str());
    let kind = match body.get("kind").and_then(|v| v.as_str()) {
        Some(k) if k.eq_ignore_ascii_case("sql") => "sql".to_string(),
        Some(k) => match kind_of(src, Some(k)) {
            Ok(k) => k,
            Err(e) => return err(StatusCode::BAD_REQUEST, e),
        },
        None => match kind_of(src, None) {
            Ok(k) => k,
            Err(e) => return err(StatusCode::BAD_REQUEST, e),
        },
    };
    if kind != "sql" && src.is_empty() {
        return err(StatusCode::BAD_REQUEST, "src を指定してください");
    }
    let reader = match reader_sql(
        &kind,
        src,
        body.get("layer").and_then(|v| v.as_str()),
        inline_sql,
    ) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };

    // 冪等化用の登録 spec。同一内容の再 POST を「登録済み」として高速応答
    // するための比較キー（manifest の spec フィールドに保存される）
    let materialize = body
        .get("materialize")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    // force: true で spec 一致でも再取込み（リモートファイルの更新反映用）
    let force = body
        .get("force")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let spec = json!({
        "src": src,
        "kind": kind,
        "sql": inline_sql,
        "layer": body.get("layer").cloned().unwrap_or(Value::Null),
        "lon": body.get("lon").cloned().unwrap_or(Value::Null),
        "lat": body.get("lat").cloned().unwrap_or(Value::Null),
        "geom_col": body.get("geom_col").cloned().unwrap_or(Value::Null),
        "where": body.get("where").cloned().unwrap_or(Value::Null),
        "limit": body.get("limit").cloned().unwrap_or(Value::Null),
        "materialize": materialize,
    });

    // 同名ソースの登録を直列化。登録中の重複 POST は完了を待ち、
    // manifest 上の一致エントリをそのまま返す（materialize の二重走行を防ぐ）
    let lock = name_lock(name);
    let _name_guard = match tokio::time::timeout(Duration::from_secs(660), lock.lock()).await {
        Ok(g) => g,
        Err(_) => {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "同名ソースの登録処理が継続中です。完了後に再試行してください",
            )
        }
    };
    if !force {
        if let Some(e) = source_entry(name) {
            let busy = e.get("materializing").and_then(|v| v.as_bool()) == Some(true)
                || e.get("missing").and_then(|v| v.as_bool()) == Some(true)
                // stale なら spec 一致でも再取込み（reconcile の鮮度検出と連動 #65）
                || e.get("stale").and_then(|v| v.as_bool()) == Some(true);
            if !busy && e.get("spec") == Some(&spec) {
                // マニフェストと実テーブルの不整合（テーブル欠落）に備えて
                // 実在確認する。欠落していればキャッシュ返却せず再取込みへ
                let t = table_name(name);
                let exists_sql = format!(
                    "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = '{}';",
                    lit(&t)
                );
                let exists = run_duckdb_read(&exists_sql, 30)
                    .await
                    .ok()
                    .and_then(|o| parse_rows(&o).ok())
                    .map(|r| !r.is_empty())
                    // 確認不能（書込み占有中等）は「ある」扱いで誤再取込みを防ぐ
                    .unwrap_or(true);
                if exists {
                    return (
                        StatusCode::OK,
                        Json(json!({
                            "ok": true,
                            "name": name,
                            "kind": e.get("kind").cloned().unwrap_or(json!(kind)),
                            "materialized": e
                                .get("materialized")
                                .cloned()
                                .unwrap_or(json!(materialize)),
                            "features": e.get("features").cloned().unwrap_or(Value::Null),
                            "geojson_url": format!("/vector/geojson/{name}"),
                            "cached": true,
                        })),
                    )
                        .into_response();
                }
            }
        }
    }

    // 進行中フラグを manifest へ記録（クライアント切断・ハブ停止後も状態を
    // 追跡可能に。残存した materializing:true は次回 POST で再取込みされる）
    let mut m = load_manifest();
    let prev_entry = m.pointer(&format!("/sources/{name}")).cloned();
    if let Some(sources) = m.get_mut("sources").and_then(|v| v.as_object_mut()) {
        sources.insert(
            name.to_string(),
            json!({
                "materializing": true,
                "spec": spec,
                "src": src,
                "kind": kind,
                "table": table_name(name),
                "geojson_url": format!("/vector/geojson/{name}"),
            }),
        );
        let _ = save_manifest(&m);
    }
    // 失敗時は登録前のエントリ状態へ戻す
    let restore = |prev: &Option<Value>| {
        let mut m = load_manifest();
        if let Some(s) = m.get_mut("sources").and_then(|v| v.as_object_mut()) {
            match prev {
                Some(e) => {
                    s.insert(name.to_string(), e.clone());
                }
                None => {
                    s.remove(name);
                }
            }
            let _ = save_manifest(&m);
        }
    };

    // スキーマ確認 → geometry 列の特定
    let cols = match describe_cols(&reader).await {
        Ok(c) => c,
        Err(e) => {
            restore(&prev_entry);
            return err(
                StatusCode::BAD_GATEWAY,
                format!("ソースのスキーマ取得に失敗: {e}"),
            );
        }
    };
    let declared_geom = body
        .get("geom_col")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let (gcol, is_geo) = match declared_geom {
        Some(g) => {
            let typed = cols
                .iter()
                .any(|(n, t)| *n == g && t.to_uppercase().contains("GEOMETRY"));
            (Some(g), typed)
        }
        None => pick_geom(&cols),
    };
    let lonlat = body
        .get("lon")
        .and_then(|v| v.as_str())
        .zip(body.get("lat").and_then(|v| v.as_str()))
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .or_else(|| pick_lonlat(&cols));
    let geom_expr = match (&gcol, is_geo, &lonlat) {
        (Some(g), true, _) => format!("t.{}", ident(g)),
        (Some(g), false, _) => format!("ST_GeomFromWKB(t.{})", ident(g)),
        (None, _, Some((lon, lat))) => format!(
            "ST_Point(CAST(t.{} AS DOUBLE), CAST(t.{} AS DOUBLE))",
            ident(lon),
            ident(lat)
        ),
        _ => {
            restore(&prev_entry);
            return err(
                StatusCode::BAD_REQUEST,
                "geometry 列を特定できません。geom_col= か lon=/lat= を指定してください",
            )
        }
    };
    let star = match &gcol {
        Some(g) => format!("* EXCLUDE({})", ident(g)),
        None => "*".to_string(),
    };
    let verb = if materialize { "TABLE" } else { "VIEW" };
    let limit = body
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| format!(" LIMIT {n}"))
        .unwrap_or_default();
    let where_clause = body
        .get("where")
        .and_then(|v| v.as_str())
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .map(|w| format!(" WHERE ({w})"))
        .unwrap_or_default();
    let table = table_name(name);
    let create = format!(
        "{PRELUDE} CREATE OR REPLACE {verb} {t} AS SELECT {star}, {geom_expr} AS geom FROM {reader} t{where_clause}{limit};",
        t = ident(&table),
    );
    if let Err(e) = run_duckdb(&create, true, 600).await {
        restore(&prev_entry);
        return err(StatusCode::BAD_GATEWAY, format!("取込みに失敗: {e}"));
    }
    let count_sql = format!("SELECT COUNT(*) AS n FROM {};", ident(&table));
    let features = match run_duckdb_read(&count_sql, 120).await {
        Ok(out) => parse_rows(&out)
            .ok()
            .and_then(|r| r.first().and_then(|x| x.get("n")).and_then(|v| v.as_u64()))
            .map(|n| json!(n)),
        Err(_) => None,
    };
    // レジストリへ記録。登録時点の鮮度情報(fresh)を併記し、reconcile の
    // stale 検出用基線とする（#65）
    let fresh = source_freshness(&src).await.unwrap_or(Value::Null);
    let mut m = load_manifest();
    let entry = json!({
        "fresh": fresh,
        "src": src,
        "kind": kind,
        "table": table,
        "geom_col": gcol,
        "materialized": materialize,
        "features": features.clone().unwrap_or(Value::Null),
        "where": body.get("where").cloned().unwrap_or(Value::Null),
        "spec": spec,
        "created_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "geojson_url": format!("/vector/geojson/{name}"),
    });
    if let Some(sources) = m.get_mut("sources").and_then(|v| v.as_object_mut()) {
        sources.insert(name.to_string(), entry);
    }
    if let Err(e) = save_manifest(&m) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "name": name,
            "kind": kind,
            "materialized": materialize,
            "features": features,
            "geojson_url": format!("/vector/geojson/{name}"),
        })),
    )
        .into_response()
}

pub async fn remove_source(Path(name): Path<String>) -> Response {
    if !valid_name(&name) {
        return err(StatusCode::BAD_REQUEST, "invalid name");
    }
    if source_entry(&name).is_none() {
        return err(StatusCode::NOT_FOUND, "source not found");
    }
    // 登録処理と競合しないよう同名ロックを取る（登録中なら完了を待つ）
    let lock = name_lock(&name);
    let _name_guard = match tokio::time::timeout(Duration::from_secs(90), lock.lock()).await {
        Ok(g) => g,
        Err(_) => {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "このソースの登録処理が継続中です。完了後に再試行してください",
            )
        }
    };
    // DuckDB v2 は DROP VIEW IF EXISTS が Table に対して型不一致エラーになる
    // （逆も同じ）ため、カタログで実際のオブジェクト種別を確認してから落とす
    let tname = table_name(&name);
    let ty_sql = format!(
        "SELECT table_type FROM information_schema.tables WHERE table_name = '{}';",
        lit(&tname)
    );
    let is_view = match run_duckdb_read(&ty_sql, 60).await {
        Ok(out) => parse_rows(&out)
            .ok()
            .and_then(|r| r.first().cloned())
            .and_then(|v| v.get("table_type").cloned())
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .map(|s| s.eq_ignore_ascii_case("view"))
            .unwrap_or(false),
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("drop 前の型確認に失敗: {e}")),
    };
    let table = ident(&tname);
    let drop = if is_view {
        format!("DROP VIEW IF EXISTS {table};")
    } else {
        format!("DROP TABLE IF EXISTS {table};")
    };
    if let Err(e) = run_duckdb(&drop, true, 60).await {
        return err(StatusCode::BAD_GATEWAY, format!("drop に失敗: {e}"));
    }
    let mut m = load_manifest();
    if let Some(sources) = m.get_mut("sources").and_then(|v| v.as_object_mut()) {
        sources.remove(&name);
    }
    let _ = save_manifest(&m);
    (StatusCode::OK, Json(json!({ "ok": true, "name": name }))).into_response()
}

fn parse_bbox(s: &str) -> Option<String> {
    let v: Vec<f64> = s
        .split(',')
        .filter_map(|p| p.trim().parse::<f64>().ok())
        .collect();
    if v.len() != 4 {
        return None;
    }
    Some(format!(
        "ST_MakeEnvelope({}, {}, {}, {})",
        v[0], v[1], v[2], v[3]
    ))
}

// SELECT ... から GeoJSON 行を取り FeatureCollection テキストを組み立てる
async fn geojson_from_select(select: &str, timeout_secs: u64) -> Result<String, String> {
    let sql = format!("{PRELUDE} SELECT ST_AsGeoJSON(t.geom) AS g, * EXCLUDE(geom) FROM ({select}) t;");
    let out = run_duckdb_read(&sql, timeout_secs).await?;
    let rows = parse_rows(&out)?;
    let mut feats = Vec::with_capacity(rows.len());
    for mut r in rows {
        let g = r.get_mut("g").map(|v| v.take()).unwrap_or(Value::Null);
        let geometry = match g {
            Value::String(s) => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
            other => other,
        };
        if let Value::Object(mut m) = r {
            m.remove("g");
            feats.push(json!({
                "type": "Feature",
                "geometry": geometry,
                "properties": Value::Object(m),
            }));
        }
    }
    let fc = json!({ "type": "FeatureCollection", "features": feats });
    Ok(serde_json::to_string(&fc).unwrap_or_else(|_| "{}".to_string()))
}

fn geojson_response(body: String) -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/geo+json")],
        body,
    )
        .into_response()
}

// 空の FeatureCollection を返す軽量プローブ。ブラウザのホスト（トップレベル）
// コンテキストから loopback への fetch を発生させ、Chrome の Local Network
// Access 許可プロンプトを出す用途（サイト許可後は iframe からのハブ接続も通る）
pub async fn probe_geojson() -> Response {
    geojson_response(r#"{"type":"FeatureCollection","features":[]}"#.to_string())
}

pub async fn geojson(
    Path(name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !valid_name(&name) {
        return err(StatusCode::BAD_REQUEST, "invalid name");
    }
    if source_entry(&name).is_none() {
        return err(StatusCode::NOT_FOUND, "source not found");
    }
    let table = ident(&table_name(&name));
    let geom = match q.get("simplify").and_then(|s| s.parse::<f64>().ok()) {
        Some(tol) if tol > 0.0 => format!("ST_Simplify(geom, {tol})"),
        _ => "geom".to_string(),
    };
    let mut conds: Vec<String> = Vec::new();
    if let Some(w) = q.get("where").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        conds.push(format!("({w})"));
    }
    if let Some(b) = q.get("bbox") {
        match parse_bbox(b) {
            Some(f) => conds.push(format!("ST_Intersects(geom, {f})")),
            None => return err(StatusCode::BAD_REQUEST, "bbox は west,south,east,north 形式です"),
        }
    }
    let where_clause = if conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conds.join(" AND "))
    };
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<u64>().ok())
        .map(|n| format!(" LIMIT {n}"))
        .unwrap_or_default();
    let cols = q
        .get("columns")
        .map(|s| {
            s.split(',')
                .map(|c| c.trim())
                .filter(|c| {
                    !c.is_empty()
                        && !c.eq_ignore_ascii_case("geom")
                        && c.chars().all(|x| x.is_ascii_alphanumeric() || x == '_')
                })
                .map(ident)
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty());
    // 内側で geom を正規化（簡略化・列選択）し、外側ラッパが t.geom を拾う
    let select = match cols {
        Some(c) => format!(
            "SELECT {geom} AS geom, {} FROM {table}{where_clause}{limit}",
            c.join(", ")
        ),
        None => format!("SELECT {geom} AS geom, * EXCLUDE(geom) FROM {table}{where_clause}{limit}"),
    };
    match geojson_from_select(&select, 120).await {
        Ok(body) => geojson_response(body),
        // manifest に残るがテーブルが消えている場合は 404（再登録で自己修復可能）
        Err(e) if e.contains("does not exist") => err(
            StatusCode::NOT_FOUND,
            format!("テーブルが見つかりません。再登録してください: {e}"),
        ),
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}

// POST /vector/query — geom 列を含む任意 SELECT を GeoJSON で返す
pub async fn query(body: Bytes) -> Response {
    let body = match parse_body(&body, 64 * 1024) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let sql = body.get("sql").and_then(|v| v.as_str()).unwrap_or("").trim();
    let sql = sql.trim_end_matches(';').trim();
    let head = sql.split_whitespace().next().unwrap_or("").to_lowercase();
    if head != "select" && head != "with" {
        return err(
            StatusCode::BAD_REQUEST,
            "SELECT / WITH クエリのみ受け付けます（単一ステートメント）",
        );
    }
    if sql.contains(';') {
        return err(StatusCode::BAD_REQUEST, "複数ステートメントは不可です");
    }
    match geojson_from_select(sql, 120).await {
        Ok(body) => geojson_response(body),
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}
