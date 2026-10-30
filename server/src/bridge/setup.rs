// ブリッジ用CLIの導入状況確認・自動インストール(/setup)。
//
// 「copilot/devin/agy が見つかりません」系の導入エラーを減らすための補助面。
//   GET  /setup          → 各プロバイダの CLI 検出状況と自動化可否
//   POST /setup          → {provider, action:"install", confirm:true} で
//                          固定のインストール手順をジョブ実行(任意コマンド不可)
//   GET  /setup/job/{id} → ジョブの状態・ログ末尾・結果
// 同じロジックは bridge-hub.exe --setup <target> の CLI 入口からも呼べる。
//
// 実行するのは各プロバイダ公式の導入手順のみ(ホワイトリスト):
//   copilot: winget install GitHub.Copilot → npm i -g @github/copilot
//            → GitHub Releases の zip 直接DL(ハブ管理ディレクトリへ)
//   devin:   公式 setup.ps1 (irm https://static.devin.ai/cli/setup.ps1 | iex)
//            / unix は install.sh
//   antigravity: 自動化不可(IDE インストーラ+対話ログイン)のため案内のみ
//
// ブラウザ経由の踏み台(install を他サイトから叩かれる)を防ぐため、
// POST は Origin ヘッダがある場合に loopback/既知デプロイホストのみ許可する
// (非ブラウザ=ローカルコードはもともと同等のことができるため制限しない)。
use super::common;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub const SETUP_PROVIDERS: &[&str] = &["copilot", "devin", "antigravity"];

// /setup の追加 Bearer トークン(任意・未設定なら Origin チェックのみ)
pub fn token() -> String {
    std::env::var("KASUGAI_SETUP_TOKEN").unwrap_or_default()
}

// ブラウザ発の要求かを Origin で判定し、許可対象のデプロイ元のみ通す。
// Origin 無し(curl/スクリプト/エージェント=ローカルコード)は許可。
pub fn origin_allowed(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    else {
        return true;
    };
    let after_scheme = origin.split("://").nth(1).unwrap_or(origin);
    let authority = after_scheme.split('/').next().unwrap_or("");
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or("").to_lowercase()
    } else {
        authority.split(':').next().unwrap_or("").to_lowercase()
    };
    if host.is_empty() {
        return false;
    }
    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return true;
    }
    // Canvas の既知デプロイ形態(GitHub Pages CDN / Cloud Run / Cloudflare Pages)
    for suf in [".github.io", ".run.app", ".pages.dev"] {
        if host.ends_with(suf) {
            return true;
        }
    }
    if let Ok(extra) = std::env::var("BRIDGE_SETUP_ORIGINS") {
        for h in extra.split(',') {
            if h.trim().eq_ignore_ascii_case(&host) {
                return true;
            }
        }
    }
    false
}

// ---- CLI 検出 ----
// プロバイダ側の *_candidates() と同じ順序で「実在するパス」を返す。
// 常駐プロセスの古い PATH に頼らず、レジストリの最新 PATH も見る
// (common::find_executable)ため、直後インストールも検出できる。
pub fn detect(provider: &str) -> Option<String> {
    let env_key = match provider {
        "copilot" => "COPILOT_CLI_PATH",
        "devin" => "DEVIN_CLI_PATH",
        "antigravity" => "AGY_CLI_PATH",
        _ => return None,
    };
    if let Ok(p) = std::env::var(env_key) {
        if !p.is_empty() && Path::new(&p).is_file() {
            return Some(p);
        }
    }
    let managed = common::managed_cli(provider);
    if managed.is_file() {
        return Some(managed.to_string_lossy().to_string());
    }
    let found = |name: &str| common::find_executable(name);
    match provider {
        "copilot" => {
            if let Some(p) = found("copilot") {
                return Some(p.to_string_lossy().to_string());
            }
            #[cfg(windows)]
            {
                if let Ok(local) = std::env::var("LOCALAPPDATA") {
                    // winget install GitHub.Copilot の shim 置き場
                    let p = PathBuf::from(&local)
                        .join("Microsoft")
                        .join("WinGet")
                        .join("Links")
                        .join("copilot.exe");
                    if p.is_file() {
                        return Some(p.to_string_lossy().to_string());
                    }
                }
                if let Ok(appdata) = std::env::var("APPDATA") {
                    // npm i -g @github/copilot の shim
                    let p = PathBuf::from(&appdata).join("npm").join("copilot.cmd");
                    if p.is_file() {
                        return Some(p.to_string_lossy().to_string());
                    }
                }
            }
            #[cfg(not(windows))]
            for p in unix_bin_candidates("copilot") {
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
        "devin" => {
            // 前回起動に成功したパスのキャッシュ
            let cache = common::workdir("devin").join("acp-bin.txt");
            if let Ok(p) = std::fs::read_to_string(&cache) {
                let p = p.trim().to_string();
                if !p.is_empty() && Path::new(&p).is_file() {
                    return Some(p);
                }
            }
            if let Some(p) = found("devin") {
                return Some(p.to_string_lossy().to_string());
            }
            #[cfg(windows)]
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                // Devin Desktop 同梱の devin.exe
                let p = PathBuf::from(&local)
                    .join("Programs")
                    .join("Devin")
                    .join("resources")
                    .join("app")
                    .join("extensions")
                    .join("windsurf")
                    .join("devin")
                    .join("bin")
                    .join("devin.exe");
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
            #[cfg(not(windows))]
            for p in unix_bin_candidates("devin") {
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
        "antigravity" => {
            #[cfg(windows)]
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let p = PathBuf::from(&local).join("agy").join("bin").join("agy.exe");
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
            if let Some(p) = found("agy") {
                return Some(p.to_string_lossy().to_string());
            }
            #[cfg(not(windows))]
            for p in unix_bin_candidates("agy") {
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
        _ => {}
    }
    None
}

#[cfg(not(windows))]
fn unix_bin_candidates(name: &str) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        list.push(PathBuf::from(home).join(".local").join("bin").join(name));
    }
    list.push(PathBuf::from("/usr/local/bin").join(name));
    list.push(PathBuf::from("/opt/homebrew/bin").join(name));
    list
}

// ---- ステータス(GET /setup) ----

fn provider_methods(provider: &str) -> Vec<&'static str> {
    match provider {
        "copilot" => {
            #[cfg(windows)]
            {
                let mut m = Vec::new();
                if common::find_executable("winget").is_some() {
                    m.push("winget");
                }
                if common::find_executable("npm").is_some() {
                    m.push("npm");
                }
                m.push("download");
                m
            }
            #[cfg(not(windows))]
            {
                vec!["install-script"]
            }
        }
        "devin" => {
            if cfg!(windows) {
                vec!["setup.ps1"]
            } else {
                vec!["install.sh"]
            }
        }
        _ => Vec::new(),
    }
}

fn provider_status(provider: &str) -> Value {
    let cli_path = detect(provider);
    let methods = provider_methods(provider);
    let note = match provider {
        "copilot" => "認証: 初回のみ `copilot` を一度起動して /login するか、GH_TOKEN / COPILOT_GITHUB_TOKEN を設定",
        "devin" => "認証: 初回接続時のブラウザ PKCE ログイン、または DEVIN_API_KEY(cog_...) を設定",
        "antigravity" => "自動インストール非対応。Antigravity(IDE) を導入し agy で Google ログイン",
        _ => "",
    };
    json!({
        "cli_found": cli_path.is_some(),
        "cli_path": cli_path,
        "auto_install": !methods.is_empty(),
        "methods": methods,
        "note": note,
    })
}

pub fn status_all() -> Value {
    let mut providers = serde_json::Map::new();
    for p in SETUP_PROVIDERS {
        providers.insert(p.to_string(), provider_status(p));
    }
    json!({
        "hub": true,
        "store_dir": common::setup_store_dir().to_string_lossy(),
        "providers": providers,
    })
}

// ---- インストール実行 ----

fn push_log(log: &StdMutex<Vec<String>>, line: impl Into<String>) {
    if let Ok(mut l) = log.lock() {
        l.push(line.into());
        if l.len() > 400 {
            let drop = l.len() - 400;
            l.drain(0..drop);
        }
    }
}

// 子プロセスを実行して終了コードを返す。stdout/stderr の末尾をログへ残す
async fn run_capture(
    program: &str,
    args: &[&str],
    timeout_secs: u64,
    log: &StdMutex<Vec<String>>,
) -> Result<i32, String> {
    push_log(log, format!("$ {program} {}", args.join(" ")));
    let mut cmd = common::new_command(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = match tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        cmd.output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            let m = format!("{program} の起動に失敗: {e}");
            push_log(log, m.clone());
            return Err(m);
        }
        Err(_) => {
            let m = format!("{program} がタイムアウト ({timeout_secs}s)");
            push_log(log, m.clone());
            return Err(m);
        }
    };
    for buf in [&out.stdout, &out.stderr] {
        let text = String::from_utf8_lossy(buf);
        let tail: String = text.chars().take(3000).collect();
        for line in tail.lines() {
            push_log(log, format!("  {line}"));
        }
    }
    Ok(out.status.code().unwrap_or(-1))
}

fn done_result(provider: &str, path: &str, method: &str) -> Value {
    let next = match provider {
        "copilot" => "あと1ステップ: `copilot` を一度起動して /login するか、GH_TOKEN / COPILOT_GITHUB_TOKEN を設定してください",
        "devin" => "認証: 初回接続時にブラウザ PKCE ログインが開きます(DEVIN_API_KEY=cog_... でも可)",
        _ => "設定画面でプロバイダを選び直してください",
    };
    json!({
        "ok": true,
        "provider": provider,
        "method": method,
        "cli_path": path,
        "next": next,
    })
}

pub async fn install_provider(
    provider: &str,
    log: &StdMutex<Vec<String>>,
) -> Result<Value, String> {
    match provider {
        "copilot" => install_copilot(log).await,
        "devin" => install_devin(log).await,
        "antigravity" => Err(
            "antigravity は自動インストール非対応です。Antigravity(IDE) を導入し、agy で Google ログインしてください"
                .to_string(),
        ),
        _ => Err(format!("unknown provider: {provider}")),
    }
}

async fn install_copilot(log: &StdMutex<Vec<String>>) -> Result<Value, String> {
    if let Some(p) = detect("copilot") {
        push_log(log, format!("copilot CLI は検出済みです: {p}"));
        return Ok(done_result("copilot", &p, "already"));
    }
    #[cfg(windows)]
    {
        // 1) winget(公式推奨・Node 不要)
        if common::find_executable("winget").is_some() {
            push_log(log, "winget で GitHub.Copilot をインストールします…");
            match run_capture(
                "winget",
                &[
                    "install",
                    "--id",
                    "GitHub.Copilot",
                    "-e",
                    "--silent",
                    "--accept-source-agreements",
                    "--accept-package-agreements",
                    "--disable-interactivity",
                ],
                900,
                log,
            )
            .await
            {
                Ok(0) => {
                    if let Some(p) = detect("copilot") {
                        return Ok(done_result("copilot", &p, "winget"));
                    }
                    push_log(log, "winget は成功しましたが CLI を検出できません。npm 経路を試します");
                }
                Ok(c) => {
                    push_log(log, format!("winget がコード {c} で終了。npm 経路を試します"));
                }
                Err(e) => {
                    push_log(log, format!("winget 実行失敗({e})。npm 経路を試します"));
                }
            }
        } else {
            push_log(log, "winget が見つかりません。npm 経路を試します");
        }
        // 2) npm(Node 22+ が必要)
        if common::find_executable("npm").is_some() {
            push_log(log, "npm install -g @github/copilot を実行します…");
            match run_capture(
                "cmd",
                &["/c", "npm", "install", "-g", "@github/copilot"],
                900,
                log,
            )
            .await
            {
                Ok(0) => {
                    if let Some(p) = detect("copilot") {
                        return Ok(done_result("copilot", &p, "npm"));
                    }
                    push_log(log, "npm は成功しましたが CLI を検出できません。直接ダウンロードを試します");
                }
                Ok(c) => {
                    push_log(log, format!("npm がコード {c} で終了。直接ダウンロードを試します"));
                }
                Err(e) => {
                    push_log(log, format!("npm 実行失敗({e})。直接ダウンロードを試します"));
                }
            }
        } else {
            push_log(log, "npm が見つかりません。直接ダウンロードを試します");
        }
        // 3) GitHub Releases から直接DL(外部ツール不要の最終経路)
        push_log(log, "GitHub Releases から copilot CLI をダウンロードします…");
        return download_copilot(log).await;
    }
    #[cfg(not(windows))]
    {
        push_log(log, "公式インストールスクリプトを実行します…");
        let code = run_capture(
            "sh",
            &["-c", "curl -fsSL https://gh.io/copilot-install | bash"],
            900,
            log,
        )
        .await?;
        if code == 0 {
            if let Some(p) = detect("copilot") {
                return Ok(done_result("copilot", &p, "install-script"));
            }
            return Err("インストールは完了しましたが copilot CLI を検出できません".to_string());
        }
        Err(format!("インストールスクリプトがコード {code} で失敗しました"))
    }
}

#[cfg(windows)]
async fn download_copilot(log: &StdMutex<Vec<String>>) -> Result<Value, String> {
    let asset = if cfg!(target_arch = "x86_64") {
        "copilot-win32-x64.zip"
    } else {
        "copilot-win32-arm64.zip"
    };
    let client = reqwest::Client::new();
    let rel: Value = client
        .get("https://api.github.com/repos/github/copilot-cli/releases/latest")
        .header("User-Agent", "kasugai-canvas-bridge-hub")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("リリース情報の取得に失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("リリース情報の解析に失敗: {e}"))?;
    let url = rel
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            arr.iter().find(|a| {
                a.get("name").and_then(|n| n.as_str()) == Some(asset)
            })
        })
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("最新リリースに {asset} が見つかりません"))?;
    push_log(log, format!("downloading: {url}"));
    let mut resp = client
        .get(&url)
        .header("User-Agent", "kasugai-canvas-bridge-hub")
        .send()
        .await
        .map_err(|e| format!("ダウンロードに失敗: {e}"))?;
    let tmp = std::env::temp_dir().join(format!("kasugai-{asset}"));
    {
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("一時ファイルを作れません: {e}"))?;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("ダウンロード中断: {e}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("書き込みに失敗: {e}"))?;
        }
    }
    // zip から copilot.exe を取り出しハブ管理ディレクトリへ置く
    let dest = common::managed_cli("copilot");
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("配置ディレクトリを作れません: {e}"))?;
    }
    let zf = std::fs::File::open(&tmp)
        .map_err(|e| format!("ZIP を開けません: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(zf).map_err(|e| format!("ZIP 解析に失敗: {e}"))?;
    let mut extracted = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("ZIP 解析に失敗: {e}"))?;
        let is_cli = entry
            .enclosed_name()
            .and_then(|n| n.file_name().map(|f| f.to_string_lossy().to_string()))
            .map(|n| n.eq_ignore_ascii_case("copilot.exe"))
            .unwrap_or(false);
        if !is_cli {
            continue;
        }
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("配置に失敗: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("配置に失敗: {e}"))?;
        extracted = true;
        break;
    }
    let _ = std::fs::remove_file(&tmp);
    if !extracted {
        return Err(format!("{asset} 内に copilot.exe が見つかりません"));
    }
    push_log(log, format!("配置しました: {}", dest.to_string_lossy()));
    match detect("copilot") {
        Some(p) => Ok(done_result("copilot", &p, "download")),
        None => Err("配置しましたが copilot CLI を検出できません".to_string()),
    }
}

async fn install_devin(log: &StdMutex<Vec<String>>) -> Result<Value, String> {
    if let Some(p) = detect("devin") {
        push_log(log, format!("devin CLI は検出済みです: {p}"));
        return Ok(done_result("devin", &p, "already"));
    }
    #[cfg(windows)]
    let code = run_capture(
        "powershell",
        &[
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://static.devin.ai/cli/setup.ps1 | iex",
        ],
        900,
        log,
    )
    .await?;
    #[cfg(not(windows))]
    let code = run_capture(
        "sh",
        &["-c", "curl -fsSL https://cli.devin.ai/install.sh | bash"],
        900,
        log,
    )
    .await?;
    if code != 0 {
        return Err(format!("インストーラがコード {code} で失敗しました"));
    }
    match detect("devin") {
        Some(p) => Ok(done_result("devin", &p, "installer")),
        None => Err(
            "インストールは完了しましたが devin CLI を検出できません。ハブを再起動するか DEVIN_CLI_PATH で場所を指定してください"
                .to_string(),
        ),
    }
}

// ---- ジョブ管理 ----

struct JobState {
    provider: String,
    status: StdMutex<String>, // running / done / failed
    log: StdMutex<Vec<String>>,
    result: StdMutex<Option<Value>>,
}

#[derive(Clone, Default)]
pub struct SetupJobs {
    inner: Arc<StdMutex<HashMap<String, Arc<JobState>>>>,
}

static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

impl SetupJobs {
    // install ジョブを開始して id を返す。同プロバイダが実行中ならその id を返す
    pub fn start(&self, provider: &str) -> Result<String, String> {
        if !SETUP_PROVIDERS.contains(&provider) {
            return Err(format!("unknown provider: {provider}"));
        }
        if let Ok(map) = self.inner.lock() {
            for (id, j) in map.iter() {
                let running = j
                    .status
                    .lock()
                    .map(|s| s.as_str() == "running")
                    .unwrap_or(false);
                if j.provider == provider && running {
                    return Ok(id.clone());
                }
            }
        }
        let id = format!("{provider}-{}", JOB_SEQ.fetch_add(1, Ordering::SeqCst));
        let job = Arc::new(JobState {
            provider: provider.to_string(),
            status: StdMutex::new("running".to_string()),
            log: StdMutex::new(Vec::new()),
            result: StdMutex::new(None),
        });
        if let Ok(mut map) = self.inner.lock() {
            map.insert(id.clone(), job.clone());
            // 肥大化防止: 終了済みジョブを古い順に間引く
            let done_ids: Vec<String> = map
                .iter()
                .filter(|(_, j)| {
                    j.status
                        .lock()
                        .map(|s| s.as_str() != "running")
                        .unwrap_or(false)
                })
                .map(|(i, _)| i.clone())
                .collect();
            for old in done_ids.iter().take(done_ids.len().saturating_sub(32)) {
                map.remove(old);
            }
        }
        tokio::spawn(async move {
            let res = install_provider(&job.provider, &job.log).await;
            match res {
                Ok(v) => {
                    if let Ok(mut r) = job.result.lock() {
                        *r = Some(v);
                    }
                    if let Ok(mut s) = job.status.lock() {
                        *s = "done".to_string();
                    }
                }
                Err(e) => {
                    push_log(&job.log, format!("error: {e}"));
                    if let Ok(mut r) = job.result.lock() {
                        *r = Some(json!({ "ok": false, "error": e }));
                    }
                    if let Ok(mut s) = job.status.lock() {
                        *s = "failed".to_string();
                    }
                }
            }
        });
        Ok(id)
    }

    pub fn describe(&self, id: &str) -> Option<Value> {
        let map = self.inner.lock().ok()?;
        let job = map.get(id)?;
        let status = job.status.lock().map(|s| s.clone()).unwrap_or_default();
        let log = job.log.lock().map(|l| l.clone()).unwrap_or_default();
        let result = job.result.lock().ok().and_then(|r| r.clone());
        Some(json!({
            "job": id,
            "provider": job.provider,
            "status": status,
            "log": log,
            "result": result,
        }))
    }
}

// ---- bridge-hub.exe --setup 用の CLI 入口 ----

fn print_status() {
    for p in SETUP_PROVIDERS {
        let s = provider_status(p);
        let path = s
            .get("cli_path")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let found = s
            .get("cli_found")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let methods = s
            .get("methods")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.as_str())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_else(|| "-".to_string());
        if found {
            println!("[{p}] CLI: {path}");
        } else {
            println!("[{p}] CLI 未検出（自動導入: {methods}）");
        }
        if let Some(note) = s.get("note").and_then(|v| v.as_str()) {
            println!("       {note}");
        }
    }
}

pub async fn cli_main(target: &str) -> std::process::ExitCode {
    let target = target.trim();
    if target.is_empty() || target == "status" {
        println!("== ブリッジプロバイダ導入状況 ==");
        print_status();
        return std::process::ExitCode::SUCCESS;
    }
    let targets: Vec<&str> = if target == "all" {
        vec!["copilot", "devin"]
    } else if SETUP_PROVIDERS.contains(&target) {
        vec![target]
    } else {
        eprintln!("usage: bridge-hub.exe --setup [status|all|copilot|devin|antigravity]");
        return std::process::ExitCode::FAILURE;
    };
    let mut failed = false;
    for p in targets {
        if let Some(found) = detect(p) {
            println!("[{p}] CLI 検出済み: {found}");
            continue;
        }
        if p == "antigravity" {
            println!("[{p}] 自動インストール非対応です。Antigravity(IDE) を導入し agy で Google ログインしてください");
            continue;
        }
        println!("[{p}] インストールを開始します…");
        let log = StdMutex::new(Vec::new());
        match install_provider(p, &log).await {
            Ok(v) => {
                for line in log.lock().map(|l| l.clone()).unwrap_or_default() {
                    println!("  {line}");
                }
                println!(
                    "[{p}] 完了: {}",
                    v.get("cli_path").and_then(|x| x.as_str()).unwrap_or("")
                );
                if let Some(next) = v.get("next").and_then(|x| x.as_str()) {
                    println!("       {next}");
                }
            }
            Err(e) => {
                for line in log.lock().map(|l| l.clone()).unwrap_or_default() {
                    println!("  {line}");
                }
                eprintln!("[{p}] 失敗: {e}");
                failed = true;
            }
        }
    }
    println!("\n== ブリッジプロバイダ導入状況 ==");
    print_status();
    if failed {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

// 対話ログイン用に CLI を別コンソールで起動する。
// copilot は TUI 内で /login（デバイスフロー・コンソールに URL/コードが出る）、
// devin は `devin login`（CLI がブラウザ PKCE を開く）。
// 非表示起動のハブ（wscript/アプリ内蔵）からのウィンドウ生成は
// PowerShell Start-Process（ShellExecute 相当）が最も確実
// （.cmd/exe を既定動作で開くと新規コンソールウィンドウになる）。
// antigravity は IDE の GUI ログインのため対象外（呼び出し側で弾く）
#[cfg(windows)]
pub fn spawn_login(provider: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let path = detect(provider)
        .ok_or_else(|| "CLI が検出できません（先にインストールしてください）".to_string())?;
    let ps = if provider == "devin" {
        format!("Start-Process -FilePath \"{path}\" -ArgumentList \"login\"")
    } else {
        format!("Start-Process -FilePath \"{path}\"")
    };
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("ログインコンソールの起動に失敗: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
pub fn spawn_login(_provider: &str) -> Result<(), String> {
    Err("この OS ではログインコンソールの自動起動に未対応です。ターミナルで手動実行してください"
        .to_string())
}
