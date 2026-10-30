// KASUGAI Canvas ブリッジハブ — ブラウザ WebGIS 用（Rust 実装・Node.js 不要）。
// アプリ版（kasugai_canvas.exe）を持たない環境で、ブラウザ WebGIS
//（CDN・静的配信）からブリッジ系プロバイダ（copilot / devin / antigravity）
// を使うための常駐プロセス。本体のアプリ内モジュール bridge/ と同一実装を
// 127.0.0.1 で待受させる（各プロバイダは利用時に外部 CLI を子プロセス起動）。
//
// 起動:
//   bridge-hub.exe            （インストール先以外からの実行 = 自己インストール。
//                              ダウンロード直後に実行するだけで
//                              %LOCALAPPDATA%\kasugai\bridge-hub\ へコピー →
//                              ログイン時自動起動タスク登録 → 8512 で起動）
//   bridge-hub.exe --serve    （インストールせずその場でハブ起動・既定 8511）
//   bridge-hub.exe --install  （自己インストールを明示実行）
//   bridge-hub.exe --uninstall（自動起動解除＋停止＋インストール先の削除）
//   bridge-hub.exe --setup …  （CLI 導入状況確認・自動インストールのみ）
//   BRIDGE_HUB_PORT=<port>    （待受ポート指定。指定時は裸実行でもインストールせず起動）
// 停止:
//   Ctrl+C / プロセス終了（--uninstall は自動起動解除＋停止＋削除）
use kasugai_canvas::bridge::{self, BridgeState};
use std::sync::Arc;
use tokio::net::TcpListener;

// 既定はアプリのハブと同じ 8511。ブラウザ WebGIS 用の自動起動は 8512
const DEFAULT_PORT: u16 = 8511;
#[cfg(windows)]
const WEBGIS_PORT: u16 = 8512;
// 自動起動タスク名（install-autostart.ps1 と同じ名前を使い互換にする）
#[cfg(windows)]
const TASK_NAME: &str = "KasugaiCanvasBridgeHub";
// タスク登録用の非表示起動ランチャー（インストール先へ書き出す）
#[cfg(windows)]
const RUN_HIDDEN_VBS: &str = "\
Dim fso, shell, dir
Set fso = CreateObject(\"Scripting.FileSystemObject\")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject(\"WScript.Shell\")
shell.CurrentDirectory = dir
shell.Environment(\"PROCESS\").Item(\"BRIDGE_HUB_PORT\") = \"8512\"
shell.Run \"\"\"\" & dir & \"\\bridge-hub.exe\"\"\", 0, False
";

fn hub_port() -> u16 {
    std::env::var("BRIDGE_HUB_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

// インストール先（%LOCALAPPDATA%\kasugai\bridge-hub）
#[cfg(windows)]
fn install_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .map(|p| p.join("kasugai").join("bridge-hub"))
}

// 裸実行（引数なし）を自己インストールとみなすか。
// インストール先・cargo ビルドツリー内の exe、および BRIDGE_HUB_PORT 指定起動
// （run-hidden.vbs 等のスクリプト経由 = 起動意図）は対象外にして、
// 「ダウンロードして実行した」ケースだけを自己インストールに流す
#[cfg(windows)]
fn should_self_install() -> bool {
    if std::env::var_os("BRIDGE_HUB_PORT").is_some() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(dir) = install_dir() else {
        return false;
    };
    if exe.starts_with(&dir) {
        return false;
    }
    if exe.components().any(|c| c.as_os_str() == "target") {
        return false;
    }
    true
}

// インストール先の bridge-hub.exe を実行中のプロセスだけを停止する
// （他フォルダのコピーや手動起動分は止めない。
//   --uninstall をインストール先の exe から実行した場合に自分自身を
//   殺さないよう、自 PID は除外する）
#[cfg(windows)]
fn kill_installed_hub(dir: &std::path::Path) {
    let exe = dir.join("bridge-hub.exe");
    let self_pid = std::process::id();
    let ps = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='bridge-hub.exe'\" \
         | Where-Object {{ $_.ExecutablePath -eq '{}' -and $_.ProcessId -ne {} }} \
         | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
        exe.display(),
        self_pid
    );
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .output();
}

// bridge-hub.exe プロセス全般を停止する（ポート占有の旧ハブ置き換え用。
// 呼び出し側で /health が hub:true を確認してから使うこと —
// hub:true を返すのは本製品のハブだけなので、名前一致の kill で安全。
// 自 PID は除外する）
#[cfg(windows)]
fn kill_all_hub_processes() {
    let self_pid = std::process::id();
    let ps = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='bridge-hub.exe'\" \
         | Where-Object {{ $_.ProcessId -ne {} }} \
         | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
        self_pid
    );
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .output();
}

// 自己インストール: インストール先へ自己コピー → run-hidden.vbs 書出し →
// ログイン時自動起動タスク登録 → 8512 で非表示起動。
// 管理者権限は不要（%LOCALAPPDATA%・ユーザー自身のタスクのみ触る）
#[cfg(windows)]
async fn self_install() -> std::process::ExitCode {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let Ok(src) = std::env::current_exe() else {
        eprintln!("bridge-hub: 実行ファイルパスを取得できません");
        return std::process::ExitCode::FAILURE;
    };
    let Some(dir) = install_dir() else {
        eprintln!("bridge-hub: %LOCALAPPDATA% を取得できません");
        return std::process::ExitCode::FAILURE;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("bridge-hub: インストール先を作成できません: {e}");
        return std::process::ExitCode::FAILURE;
    }
    let dst = dir.join("bridge-hub.exe");
    if src != dst {
        // 実行中でロックされている場合は同パスのプロセスを停止して再試行
        if std::fs::copy(&src, &dst).is_err() {
            kill_installed_hub(&dir);
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Err(e) = std::fs::copy(&src, &dst) {
                eprintln!("bridge-hub: コピーに失敗しました {} -> {}: {e}", src.display(), dst.display());
                return std::process::ExitCode::FAILURE;
            }
        }
    }
    let vbs = dir.join("run-hidden.vbs");
    if let Err(e) = std::fs::write(&vbs, RUN_HIDDEN_VBS) {
        eprintln!("bridge-hub: run-hidden.vbs を書き出せません: {e}");
        return std::process::ExitCode::FAILURE;
    }
    // ログイン時自動起動（ユーザー自身の登録・管理者権限不要）。
    // 1) install-autostart.ps1 と同じ Register-ScheduledTask 経路を試し、
    //    タスクスケジューラが拒否される環境では 2) スタートアップフォルダに
    //    run-hidden.vbs を置く方式へフォールバックする
    let ps = format!(
        "$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '\"{}\"'; \
         $t = New-ScheduledTaskTrigger -AtLogOn; \
         $p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited; \
         $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero); \
         try {{ Register-ScheduledTask -TaskName '{}' -Action $a -Trigger $t -Principal $p -Settings $s -Force \
           -Description 'KASUGAI Canvas AI bridge hub (http://127.0.0.1:8512/agent)' -ErrorAction Stop | Out-Null; exit 0 }} \
         catch {{ exit 1 }}",
        vbs.display(),
        TASK_NAME
    );
    let task_ok = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let mut autostart_via = "task";
    if !task_ok {
        autostart_via = "startup";
        let startup_ok = std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("Startup"))
            .and_then(|d| {
                std::fs::copy(&vbs, d.join(format!("{TASK_NAME}.vbs"))).ok()
            })
            .is_some();
        if !startup_ok {
            eprintln!("bridge-hub: 自動起動の登録に失敗しました（タスク登録・スタートアップフォルダの両方）");
            return std::process::ExitCode::FAILURE;
        }
    }
    // 8512 の占有者を整理してから起動する:
    // - 占有者がハブ（/health が hub:true）なら旧版とみなして停止し新版へ置き換える
    // - 無関係な別プロセスなら kill せず警告だけ出す（アプリ本体の更新ポリシーと同じ）
    if occupied_by_hub(WEBGIS_PORT).await {
        eprintln!("bridge-hub: 8512 の既存ハブを停止して新版へ置き換えます");
        kill_all_hub_processes();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    } else {
        // ポートがハブ以外に占有されているかを bind で確かめる
        match TcpListener::bind(("127.0.0.1", WEBGIS_PORT)).await {
            Ok(l) => drop(l),
            Err(_) => {
                eprintln!("bridge-hub: 警告: 127.0.0.1:{WEBGIS_PORT} は別プロセスが使用中です。起動は次回以降に再試行されます");
            }
        }
    }
    // いま起動（コンソール非表示）。wscript 経由にするのは、
    // 直接 spawn すると呼び出し元のパイプ等の継承可能ハンドルが
    // ハブへ引き継がれ親シェルが返らなくなるため
    // （vbs の shell.Run はハンドル非継承で起動し、wscript 自身は即終了する）
    let out = std::process::Command::new(r"C:\Windows\System32\wscript.exe")
        .arg(&vbs)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .and_then(|mut c| c.wait());
    if out.is_err() {
        eprintln!("bridge-hub: 起動に失敗しました: {}", dst.display());
        return std::process::ExitCode::FAILURE;
    }
    eprintln!("bridge-hub: インストールしました -> {} （自動起動: {autostart_via}）", dir.display());
    eprintln!("bridge-hub: http://127.0.0.1:{WEBGIS_PORT}/health で起動中（ログイン時に自動起動）");
    eprintln!("bridge-hub: 解除は bridge-hub.exe --uninstall");
    std::process::ExitCode::SUCCESS
}

// 自動起動の解除＋起動中ハブの停止＋インストール先の削除
#[cfg(windows)]
fn self_uninstall() -> std::process::ExitCode {
    let _ = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "Unregister-ScheduledTask -TaskName '{}' -Confirm:$false -ErrorAction SilentlyContinue",
                TASK_NAME
            ),
        ])
        .output();
    // スタートアップフォルダ経由の登録も解除
    if let Some(startup_vbs) = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|p| p.join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("Startup")
            .join(format!("{TASK_NAME}.vbs")))
    {
        let _ = std::fs::remove_file(startup_vbs);
    }
    if let Some(dir) = install_dir() {
        kill_installed_hub(&dir);
        if std::env::current_exe()
            .map(|e| !e.starts_with(&dir))
            .unwrap_or(true)
        {
            let _ = std::fs::remove_dir_all(&dir);
        } else {
            // 自分自身がインストール先の exe なら自身は消せないため、
            // それ以外のファイル（run-hidden.vbs 等）だけ削除する
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.file_name().map(|n| n != "bridge-hub.exe").unwrap_or(true) {
                        let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                    }
                }
            }
        }
    }
    eprintln!("bridge-hub: 自動起動を解除し、ハブを停止しました");
    std::process::ExitCode::SUCCESS
}

// 指定ポートの占有者がブリッジハブかを /health で確認する
async fn occupied_by_hub(port: u16) -> bool {
    let res = match reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/health"))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return false,
    };
    res.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("hub").and_then(|h| h.as_bool()))
        .unwrap_or(false)
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    // bridge-hub.exe --setup [status|all|copilot|devin|antigravity]
    // ハブを起動せず CLI 導入状況の確認・自動インストールだけを行う
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Some(pos) = argv.iter().position(|a| a == "--setup") {
        let target = argv.get(pos + 1).map(|s| s.as_str()).unwrap_or("status");
        return kasugai_canvas::bridge::setup::cli_main(target).await;
    }
    // インストール系（Windows 専用。それ以外の OS では --serve として扱う）
    #[cfg(windows)]
    {
        if argv.iter().any(|a| a == "--uninstall") {
            return self_uninstall();
        }
        if argv.iter().any(|a| a == "--install")
            || (!argv.iter().any(|a| a == "--serve") && should_self_install())
        {
            return self_install().await;
        }
    }
    let port = hub_port();
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            if occupied_by_hub(port).await {
                eprintln!("bridge-hub: 既に起動中です (http://127.0.0.1:{port}/health)");
                return std::process::ExitCode::SUCCESS;
            }
            eprintln!("bridge-hub: 127.0.0.1:{port} は別プロセスが使用中です: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let state = Arc::new(BridgeState::new(port));
    eprintln!("bridge-hub: listening http://127.0.0.1:{port}/agent");
    eprintln!("bridge-hub: providers: copilot / devin / antigravity（使用時に各 CLI を起動）");
    // Ctrl+C でハブ自身の子プロセス（CLI 等）も停止してから終了する
    let shutdown_state = state.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown_state.shutdown().await;
        std::process::exit(0);
    });
    bridge::serve(state, listener).await;
    std::process::ExitCode::SUCCESS
}
