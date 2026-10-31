#![cfg_attr(windows, windows_subsystem = "windows")]
// KASUGAI Canvas ブリッジハブ — 唯一の常駐ハブ（Rust 実装・Node.js 不要）。
// ブリッジ系プロバイダ（copilot / devin / antigravity）を使うための常駐
// プロセスで、アプリ版・ブラウザ WebGIS（CDN・静的配信）のどちらからも
// この1本を共有する（アプリはハブを内蔵しない。アプリ起動時に未起動なら
// 本体がこの exe を自動起動する）。実装は bridge/ モジュールを 127.0.0.1
// で待受させるだけ（各プロバイダは利用時に外部 CLI を子プロセス起動）。
//
// スクリプトレス設計: 本 exe は windows_subsystem（GUI）ビルドのため
// コンソールウィンドウを持たず、旧来の run-hidden.vbs / install-autostart.ps1
// / setup.cmd は不要。自動起動登録・プロセス停止・ポート調査も全て
// schtasks/reg/netstat/sysinfo のネイティブ経路で行い、PowerShell・
// VBScript を一切生成・起動しない（ウイルス誤検知対策）。
// 端末から引数付き実行した場合は AttachConsole で親コンソールへ出力を戻す。
//
// 起動:
//   bridge-hub.exe            （インストール先以外からの実行 = 自己インストール。
//                              ダウンロード直後に実行するだけで
//                              %LOCALAPPDATA%\kasugai\bridge-hub\ へコピー →
//                              ログイン時自動起動タスク登録 → 8511 で起動。
//                              結果はメッセージボックスで通知）
//   bridge-hub.exe --serve    （インストールせずその場でハブ起動・既定 8511）
//   bridge-hub.exe --install  （自己インストールを明示実行。
//                              既定ではブリッジ用 CLI の未導入分も
//                              --setup all 相当で自動導入する。
//                              --no-cli-setup で CLI 導入を省略）
//   bridge-hub.exe --uninstall（自動起動解除＋停止＋インストール先の削除）
//   bridge-hub.exe --setup …  （CLI 導入状況確認・自動インストールのみ）
//   BRIDGE_HUB_PORT=<port>    （待受ポート指定。指定時は裸実行でもインストールせず起動）
// 停止:
//   タスクマネージャー / --uninstall（自動起動解除＋停止＋削除）
use kasugai_canvas::bridge::{self, BridgeState};
use std::sync::Arc;
use tokio::net::TcpListener;

// 待受ポート。ハブは全環境で 8511 に一本化（旧ブラウザ WebGIS 用の 8512 は廃止）
const DEFAULT_PORT: u16 = 8511;
#[cfg(windows)]
const WEBGIS_PORT: u16 = 8511;
// 旧ブラウザ WebGIS 用ハブの常駐ポート。移行時に残存していれば掃除する
#[cfg(windows)]
const LEGACY_WEBGIS_PORT: u16 = 8512;
// 自動起動の登録名（タスクスケジューラ / HKCU Run キーの値名に共用。
// 旧 run-hidden.vbs 版と同じ名前を使い互換にする）
#[cfg(windows)]
const TASK_NAME: &str = "KasugaiCanvasBridgeHub";
// タスク登録が拒否される環境向けフォールバック（HKCU Run キー）
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

// 端末からの実行で親コンソールへ接続できたか（未接続の対話実行のみ MessageBox を出す）
#[cfg(windows)]
static CONSOLE_ATTACHED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
// 引数なしの実行（エクスプローラからのダブルクリック相当）。
// このときだけ成否をメッセージボックスで通知する（--install 等の明示実行は
// スクリプト・NSIS 経由を想定し箱を出さない）
#[cfg(windows)]
static INTERACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
// （アプリからの自動起動 = 起動意図）は対象外にして、
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

// 親プロセスのコンソールへ接続して std 出力を戻す。
// GUI subsystem ビルドのため std ハンドルは初期状態では無効だが、
// 端末（cmd/PowerShell）から実行された場合は AttachConsole で親の
// コンソールを共有できる。既にリダイレクト済み（パイプ・ファイル）の
// std ハンドルは上書きしない。コンソールが無い常駐起動（タスク等）では
// 何もせず false を返す
#[cfg(windows)]
fn attach_parent_console() -> bool {
    use std::os::windows::io::IntoRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
        STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            return false;
        }
        // 未設定の std ハンドルだけ CONIN$/CONOUT$ へ繋ぐ
        if GetStdHandle(STD_INPUT_HANDLE)
            .map(|h| h.is_invalid() || h.0.is_null())
            .unwrap_or(true)
        {
            if let Ok(f) = std::fs::OpenOptions::new().read(true).open("CONIN$") {
                let _ = SetStdHandle(STD_INPUT_HANDLE, HANDLE(f.into_raw_handle()));
            }
        }
        for h in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            if GetStdHandle(h)
                .map(|h| h.is_invalid() || h.0.is_null())
                .unwrap_or(true)
            {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
                    let _ = SetStdHandle(h, HANDLE(f.into_raw_handle()));
                }
            }
        }
        true
    }
}

// ユーザーへの通知。stderr へ出し、さらに「引数なし実行かつコンソール無し」
// の場合だけメッセージボックスも表示する（ダブルクリックで何も見えない
// 状態を防ぐ。端末実行・明示オプション実行・常駐起動では箱を出さない）
#[cfg(windows)]
fn notify(msg: &str, is_error: bool) {
    eprintln!("{msg}");
    if !INTERACTIVE.load(std::sync::atomic::Ordering::Relaxed)
        || CONSOLE_ATTACHED.load(std::sync::atomic::Ordering::Relaxed)
    {
        return;
    }
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_TOPMOST,
    };
    let text: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = "KASUGAI Canvas bridge-hub"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MessageBoxW(
            None,
            windows::core::PCWSTR(text.as_ptr()),
            windows::core::PCWSTR(title.as_ptr()),
            MB_OK | MB_TOPMOST | if is_error { MB_ICONERROR } else { MB_ICONINFORMATION },
        );
    }
}

// bridge-hub.exe プロセスを停止する。exe が Some ならそのパスに一致する
// プロセスだけを止める（kill_installed_hub 用）、None ならイメージ名一致の
// 全プロセス（kill_all_hub_processes 用）。sysinfo の TerminateProcess 経由で
// PowerShell/taskkill の子プロセスを生成しない。自 PID は常に除外する
#[cfg(windows)]
fn kill_hub_processes(exe: Option<&std::path::Path>) {
    let Ok(mut sys) = sysinfo::System::new() else {
        return;
    };
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let self_pid = std::process::id();
    for p in sys.processes().values() {
        if p.pid().as_u32() == self_pid {
            continue;
        }
        if !p.name().to_string_lossy().eq_ignore_ascii_case("bridge-hub.exe") {
            continue;
        }
        if let Some(exe) = exe {
            if p.exe() != Some(exe) {
                continue;
            }
        }
        let _ = p.kill();
    }
}

// インストール先の bridge-hub.exe を実行中のプロセスだけを停止する
// （他フォルダのコピーや手動起動分は止めない。
//   --uninstall をインストール先の exe から実行した場合に自分自身を
//   殺さないよう、自 PID は kill_hub_processes 内で除外する）
#[cfg(windows)]
fn kill_installed_hub(dir: &std::path::Path) {
    kill_hub_processes(Some(&dir.join("bridge-hub.exe")));
}

// bridge-hub.exe プロセス全般を停止する（ポート占有の旧ハブ置き換え用。
// 呼び出し側で /health が hub:true を確認してから使うこと —
// hub:true を返すのは本製品のハブだけなので、名前一致の kill で安全）
#[cfg(windows)]
fn kill_all_hub_processes() {
    kill_hub_processes(None);
}

// スタートアップフォルダの旧 run-hidden.vbs 登録（KasugaiCanvasBridgeHub.vbs）
// のパス。旧方式の残骸を掃除するために使う
#[cfg(windows)]
fn legacy_startup_vbs() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|p| {
            p.join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Startup")
                .join(format!("{TASK_NAME}.vbs"))
        })
}

// タスク登録用 XML（schtasks /Create /XML 用）。
// schtasks の /SC ONLOGON は「全ユーザーのログオン時」トリガーで
// 管理者権限が必要かつ実行ユーザーを限定できないため、
// <LogonTrigger><UserId> で登録者本人のログオン時だけに限定する
#[cfg(windows)]
fn task_xml(exe: &std::path::Path, user: &str) -> String {
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         \x20 <RegistrationInfo><Description>KASUGAI Canvas AI bridge hub (http://127.0.0.1:8511/agent)</Description></RegistrationInfo>\n\
         \x20 <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{}</UserId></LogonTrigger></Triggers>\n\
         \x20 <Principals><Principal id=\"Author\"><UserId>{}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n\
         \x20 <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>\n\
         \x20 <Actions Context=\"Author\"><Exec><Command>{}</Command><Arguments>--serve</Arguments></Exec></Actions>\n\
         </Task>",
        esc(user),
        esc(user),
        esc(&exe.display().to_string())
    )
}

// ログイン時自動起動を登録する。exe は GUI subsystem でコンソールを
// 持たないため wscript/vbs 経由の非表示起動は不要で、タスクは exe を
// --serve 指定で直接実行させる。
// 1) schtasks /Create /XML（旧 run-hidden.vbs 版と同じタスク名で /F 上書き →
//    旧登録は新形式へ自動移行される）
// 2) タスク登録が拒否される環境（標準ユーザーではログオントリガー登録が
//    拒否されることがある）では HKCU Run キーへフォールバック
// 登録方式（"task" / "registry"）を返す。両方失敗なら None
#[cfg(windows)]
fn register_autostart(exe: &std::path::Path) -> Option<&'static str> {
    let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(d), Ok(u)) => format!("{d}\\{u}"),
        (_, Ok(u)) => u,
        _ => String::new(),
    };
    let xml_path = std::env::temp_dir().join(format!("kasugai_bridge_task_{}.xml", std::process::id()));
    let mut bytes = vec![0xFFu8, 0xFE];
    for u in task_xml(exe, &user).encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    let task_ok = std::fs::write(&xml_path, &bytes).is_ok()
        && std::process::Command::new("schtasks")
            .args(["/Create", "/TN", TASK_NAME, "/XML"])
            .arg(&xml_path)
            .arg("/F")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    let _ = std::fs::remove_file(&xml_path);
    if task_ok {
        return Some("task");
    }
    let tr = format!("\"{}\" --serve", exe.display());
    let reg_ok = std::process::Command::new("reg")
        .args(["add", RUN_KEY, "/v", TASK_NAME, "/t", "REG_SZ", "/d", &tr, "/f"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    reg_ok.then_some("registry")
}

// 自動起動登録の解除（タスク・Run キー・旧スタートアップ vbs の全経路）
#[cfg(windows)]
fn unregister_autostart() {
    let _ = std::process::Command::new("schtasks")
        .args(["/Delete", "/TN", TASK_NAME, "/F"])
        .output();
    let _ = std::process::Command::new("reg")
        .args(["delete", RUN_KEY, "/v", TASK_NAME, "/f"])
        .output();
    if let Some(vbs) = legacy_startup_vbs() {
        let _ = std::fs::remove_file(vbs);
    }
}

// 自己インストール: インストール先へ自己コピー → 旧方式の残骸掃除 →
// ログイン時自動起動登録 → 8511 で起動 → ブリッジ用 CLI 導入。
// 管理者権限は不要（%LOCALAPPDATA%・ユーザー自身の登録のみ触る）。
// install_cli=false（--no-cli-setup）なら CLI 導入を省略する
#[cfg(windows)]
async fn self_install(install_cli: bool) -> std::process::ExitCode {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let Ok(src) = std::env::current_exe() else {
        notify("bridge-hub: 実行ファイルパスを取得できません", true);
        return std::process::ExitCode::FAILURE;
    };
    let Some(dir) = install_dir() else {
        notify("bridge-hub: %LOCALAPPDATA% を取得できません", true);
        return std::process::ExitCode::FAILURE;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        notify(&format!("bridge-hub: インストール先を作成できません: {e}"), true);
        return std::process::ExitCode::FAILURE;
    }
    let dst = dir.join("bridge-hub.exe");
    if src != dst {
        // 実行中でロックされている場合は旧ハブを停止してから再試行する。
        // イメージ名一致の kill_all_hub_processes を使う（kill_installed_hub より
        // 確実 — 自 PID は関数内で除外済み。旧ハブのロック解放待ちも取る）
        let mut copied = false;
        for _ in 0..4 {
            if std::fs::copy(&src, &dst).is_ok() {
                copied = true;
                break;
            }
            kill_all_hub_processes();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if !copied {
            if let Err(e) = std::fs::copy(&src, &dst) {
                notify(
                    &format!("bridge-hub: コピーに失敗しました {} -> {}: {e}", src.display(), dst.display()),
                    true,
                );
                return std::process::ExitCode::FAILURE;
            }
        }
    }
    // 旧方式（run-hidden.vbs 起動）の残骸を掃除する。
    // 新方式は GUI subsystem の exe をタスクから直接実行するため vbs は不要
    let _ = std::fs::remove_file(dir.join("run-hidden.vbs"));
    if let Some(vbs) = legacy_startup_vbs() {
        let _ = std::fs::remove_file(vbs);
    }
    let Some(autostart_via) = register_autostart(&dst) else {
        notify(
            "bridge-hub: 自動起動の登録に失敗しました（タスク登録・Run キーの両方）",
            true,
        );
        return std::process::ExitCode::FAILURE;
    };
    // 旧ブラウザ WebGIS 用ハブ（8512 常駐）が残っていれば掃除する。
    // 8511 への一本化で 8512 のハブは全て旧版なので問答無用で停止する
    if occupied_by_hub(LEGACY_WEBGIS_PORT).await || port_owner_image_is_hub(LEGACY_WEBGIS_PORT) {
        eprintln!("bridge-hub: 旧ポート 8512 のハブを停止します（8511 へ一本化）");
        kill_all_hub_processes();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
    // {WEBGIS_PORT} の占有者を整理してから起動する:
    // - 占有者がハブ（/health が hub:true）なら旧版とみなして停止し新版へ置き換える
    // - 無関係な別プロセスなら kill せず警告だけ出す（アプリ本体の更新ポリシーと同じ）
    if occupied_by_hub(WEBGIS_PORT).await {
        eprintln!("bridge-hub: {WEBGIS_PORT} の既存ハブを停止して新版へ置き換えます");
        kill_all_hub_processes();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    } else {
        // ポートがハブ以外に占有されているかを bind で確かめる
        match TcpListener::bind(("127.0.0.1", WEBGIS_PORT)).await {
            Ok(l) => drop(l),
            Err(_) => {
                // /health が応答しない = ハング中の旧ハブ等。占有者のイメージ名が
                // bridge-hub.exe なら本製品のハブとみなして停止・置き換える。
                // それ以外のプロセスは kill しない（アプリ本体の更新ポリシーと同じ）
                if port_owner_image_is_hub(WEBGIS_PORT) {
                    eprintln!("bridge-hub: 応答しない既存ハブを停止して新版へ置き換えます");
                    kill_all_hub_processes();
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                } else {
                    eprintln!("bridge-hub: 警告: 127.0.0.1:{WEBGIS_PORT} は別プロセスが使用中です。起動は次回以降に再試行されます");
                }
            }
        }
    }
    // いま起動。GUI subsystem のため wscript 経由は不要で、インストール先の
    // exe を --serve で切り離して spawn するだけで非表示常駐になる
    // （std ハンドルは null 化し親のパイプ等を引き継がない。wait はしない —
    // 常駐プロセスなので待つとここで止まる）
    let spawned = std::process::Command::new(&dst)
        .arg("--serve")
        .env("BRIDGE_HUB_PORT", WEBGIS_PORT.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn();
    if let Err(e) = spawned {
        notify(
            &format!("bridge-hub: 起動に失敗しました: {e}"),
            true,
        );
        return std::process::ExitCode::FAILURE;
    }
    // 起動確認（常駐ハブの待受開始を /health で最大5秒ポーリング）
    let mut started = false;
    for _ in 0..5 {
        if occupied_by_hub(WEBGIS_PORT).await {
            started = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    // ブリッジ用 CLI（copilot/devin）の未導入分も自動導入する。
    // 「exe 実行1回でハブ＋CLI まで」を既定にする（無人導入前提）。
    // winget/npm の DL で数分かかることがある。--no-cli-setup で省略可
    if install_cli {
        eprintln!("bridge-hub: ブリッジ用 CLI の導入状況を確認します…");
        if kasugai_canvas::bridge::setup::cli_main("all").await
            != std::process::ExitCode::SUCCESS
        {
            eprintln!("bridge-hub: 一部の CLI 導入に失敗しました（後で bridge-hub.exe --setup all で再試行できます）");
        }
    }
    eprintln!("bridge-hub: インストールしました -> {} （自動起動: {autostart_via}）", dir.display());
    if started {
        notify(
            &format!(
                "bridge-hub: インストールしました -> {}\n自動起動: {autostart_via}・http://127.0.0.1:{WEBGIS_PORT}/health で起動中\n解除は bridge-hub.exe --uninstall",
                dir.display()
            ),
            false,
        );
    } else {
        notify(
            "bridge-hub: インストールしましたがハブの起動確認が取れませんでした。次回ログイン時の自動起動では再試行されます",
            true,
        );
    }
    eprintln!("bridge-hub: http://127.0.0.1:{WEBGIS_PORT}/health で起動中（ログイン時に自動起動）");
    eprintln!("bridge-hub: 解除は bridge-hub.exe --uninstall");
    // ハブ自体は起動済みなので、CLI 失敗があっても SUCCESS は維持する
    std::process::ExitCode::SUCCESS
}

// 自動起動の解除＋起動中ハブの停止＋インストール先の削除
#[cfg(windows)]
fn self_uninstall() -> std::process::ExitCode {
    unregister_autostart();
    if let Some(dir) = install_dir() {
        kill_installed_hub(&dir);
        if std::env::current_exe()
            .map(|e| !e.starts_with(&dir))
            .unwrap_or(true)
        {
            let _ = std::fs::remove_dir_all(&dir);
        } else {
            // 自分自身がインストール先の exe なら自身は消せないため、
            // それ以外のファイルだけ削除する
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

// /health が応答しない場合の識別補助: ポート占有者のイメージ名が
// bridge-hub.exe なら true。ハング中の旧ハブ（応答不能）はこれで拾う。
// netstat でポート占有 PID を取得し sysinfo でイメージ名を照合する
// （PowerShell 不使用）
#[cfg(windows)]
fn port_owner_image_is_hub(port: u16) -> bool {
    let out = std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output();
    let Ok(out) = out else { return false };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut pids = std::collections::HashSet::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 5
            && cols[3].eq_ignore_ascii_case("LISTENING")
            && cols[1]
                .rsplit(':')
                .next()
                .and_then(|p| p.parse::<u16>().ok())
                == Some(port)
        {
            if let Ok(pid) = cols[4].parse::<u32>() {
                pids.insert(pid);
            }
        }
    }
    if pids.is_empty() {
        return false;
    }
    let Ok(mut sys) = sysinfo::System::new() else {
        return false;
    };
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    pids.iter().any(|pid| {
        sys.process(sysinfo::Pid::from_u32(*pid))
            .map(|p| p.name().to_string_lossy().eq_ignore_ascii_case("bridge-hub.exe"))
            .unwrap_or(false)
    })
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
    #[cfg(windows)]
    {
        // 引数付き実行（--install/--setup 等の CLI 用途）と、端末からの
        // 裸実行（自己インストール）では親コンソールへ接続して出力を見せる。
        // 常駐起動（タスク・アプリからの BRIDGE_HUB_PORT 指定起動）では
        // 親にコンソールが無いため attach は失敗し無出力のままになる
        INTERACTIVE.store(argv.is_empty(), std::sync::atomic::Ordering::Relaxed);
        if !argv.is_empty() || should_self_install() {
            let ok = attach_parent_console();
            CONSOLE_ATTACHED.store(ok, std::sync::atomic::Ordering::Relaxed);
        }
    }
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
            return self_install(!argv.iter().any(|a| a == "--no-cli-setup")).await;
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
            notify(
                &format!("bridge-hub: 127.0.0.1:{port} は別プロセスが使用中です: {e}"),
                true,
            );
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
