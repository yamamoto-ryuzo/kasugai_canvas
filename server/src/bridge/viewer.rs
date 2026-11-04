// KASUGAI シーンビューア — `bridge-hub.exe --view <url>` で起動する
// WebView2 内蔵ブラウザウィンドウ。
//
// 目的: Chrome 142+ の Local Network Access (LNA) チェックと、公開
// Re:Earth シーン（*.visualizer.reearth.io）の AssetSecurity Service
// Worker（全 fetch を respondWith(fetch(e)) で仲介）の組合せにより、
// 通常ブラウザでは 127.0.0.1 の bridge-hub へ一切到達できない
// （プロンプトも出せず即座に ERR_FAILED）。このビューアはブラウザ引数で
// LNA チェックを無効化した専用 WebView2 を開き、その中では
// 127.0.0.1:8511 のハブが既定のまま全機能使える。
//
// 無効化はこの WebView2 の user-data-folder（専用プロファイル）内だけで
// 効くため、ユーザーの通常ブラウザのセキュリティ設定には影響しない。
//
// 呼び出し元: カスタムプロトコル kasugai-hub://open?url=<pct-encoded>。
// geo_suite の Ext 導線から window.open される（OS レベルの起動なので
// LNA/CORS/SW の影響を受けない）。
//
// KASUGAI_VIEW_DEBUG_PORT=<port> を設定すると
// --remote-debugging-port を付与して CDP 検証できる。
use std::cell::RefCell;
use std::sync::mpsc;

use webview2_com::{
    wait_with_pump, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, Error as WvError,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2Environment, ICoreWebView2Controller,
};

use windows::core::{Error as WinError, PCWSTR};
use windows::Win32::Foundation::{E_POINTER, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

const CLASS_NAME: &str = "KasugaiHubViewer";
const DEFAULT_URL: &str = "http://127.0.0.1:8511/";

// COM ポインタは Send でないためスレッドローカルに保持（UI スレッド固定）
thread_local! {
    static CONTROLLER: RefCell<Option<ICoreWebView2Controller>> =
        const { RefCell::new(None) };
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// kasugai-hub://open?url=<pct> 形式と生 URL の両方を受け取る。
// セキュリティのため http(s):// のみ許可（file: や javascript: は拒否）
fn parse_target(arg: &str) -> Result<String, String> {
    let arg = arg.trim().trim_matches('"');
    if arg.is_empty() {
        return Ok(DEFAULT_URL.to_string());
    }
    let url = if let Some(rest) = arg.strip_prefix("kasugai-hub://") {
        let query = rest.split_once('?').map(|(_, q)| q).unwrap_or("");
        query
            .split('&')
            .find_map(|kv| kv.strip_prefix("url="))
            .map(percent_decode)
            .ok_or_else(|| "kasugai-hub:// に url= パラメータがありません".to_string())?
    } else {
        arg.to_string()
    };
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(url)
    } else {
        Err(format!("URL は http(s):// のみ開けます: {url}"))
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_SIZE => {
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            CONTROLLER.with(|g| {
                if let Some(c) = g.borrow().as_ref() {
                    let _ = c.SetBounds(RECT {
                        left: 0,
                        top: 0,
                        right: rc.right,
                        bottom: rc.bottom,
                    });
                }
            });
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn user_data_dir() -> String {
    std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir())
        .join("kasugai")
        .join("bridge-hub-webview")
        .to_string_lossy()
        .into_owned()
}

// --view エントリ。WebView2 を生成して url を開き、窓が閉じられるまで
// メッセージループを回す。失敗時はエラーメッセージを返す
pub fn open(target: &str) -> Result<(), String> {
    let url = parse_target(target)?;
    // WebView2 ランタイムが読む公式の環境変数。LNA チェックをこの
    // ビューアの user-data-folder 内だけで無効化する
    let mut args = String::from("--disable-features=LocalNetworkAccessChecks");
    if let Ok(port) = std::env::var("KASUGAI_VIEW_DEBUG_PORT") {
        if !port.trim().is_empty() {
            args.push_str(&format!(" --remote-debugging-port={}", port.trim()));
        }
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &args);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", user_data_dir());

    // --- ウィンドウ作成 ---
    let hmodule =
        unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {e}"))?;
    let class = wide(CLASS_NAME);
    let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }
        .map_err(|e| format!("LoadCursorW: {e}"))?;
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: windows::Win32::Foundation::HINSTANCE(hmodule.0),
        lpszClassName: PCWSTR(class.as_ptr()),
        hCursor: cursor,
        ..Default::default()
    };
    if unsafe { RegisterClassW(&wc) } == 0 {
        return Err("RegisterClassW failed".to_string());
    }
    let title = wide(&format!("KASUGAI Viewer — {url}"));
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_OVERLAPPEDWINDOW,
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1366,
            850,
            None,
            None,
            Some(windows::Win32::Foundation::HINSTANCE(hmodule.0)),
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW: {e}"))?;
    let _ = WinError::from_thread(); // (lint) keep import used on all paths

    // --- WebView2 環境 → コントローラ ---
    let environment = {
        let (tx, rx) = mpsc::channel();
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(|handler| unsafe {
                CreateCoreWebView2Environment(&handler).map_err(WvError::WindowsError)
            }),
            Box::new(move |code, env| {
                code?;
                tx.send(env.ok_or_else(|| WinError::from(E_POINTER)))
                    .expect("send env");
                Ok(())
            }),
        )
        .map_err(|e| format!("CreateCoreWebView2Environment: {e:?}"))?;
        wait_with_pump(rx)
            .map_err(|e| format!("env wait: {e:?}"))?
            .map_err(|e| format!("env: {e}"))?
    };

    let controller = {
        let (tx, rx) = mpsc::channel();
        CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                environment
                    .CreateCoreWebView2Controller(hwnd, &handler)
                    .map_err(WvError::WindowsError)
            }),
            Box::new(move |code, ctrl| {
                code?;
                tx.send(ctrl.ok_or_else(|| WinError::from(E_POINTER)))
                    .expect("send ctrl");
                Ok(())
            }),
        )
        .map_err(|e| format!("CreateCoreWebView2Controller: {e:?}"))?;
        wait_with_pump(rx)
            .map_err(|e| format!("controller wait: {e:?}"))?
            .map_err(|e| format!("controller: {e}"))?
    };

    unsafe {
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        controller
            .SetBounds(RECT {
                left: 0,
                top: 0,
                right: rc.right,
                bottom: rc.bottom,
            })
            .map_err(|e| format!("SetBounds: {e}"))?;
        controller
            .SetIsVisible(true)
            .map_err(|e| format!("SetIsVisible: {e}"))?;
        let webview = controller
            .CoreWebView2()
            .map_err(|e| format!("CoreWebView2: {e}"))?;
        let w = wide(&url);
        webview
            .Navigate(PCWSTR(w.as_ptr()))
            .map_err(|e| format!("Navigate: {e}"))?;
    }
    CONTROLLER.with(|g| {
        *g.borrow_mut() = Some(controller);
    });

    // --- メッセージループ（窓が閉じられるまで）---
    unsafe {
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    CONTROLLER.with(|g| {
        if let Some(c) = g.borrow_mut().take() {
            unsafe {
                let _ = c.Close();
            }
        }
    });
    Ok(())
}
