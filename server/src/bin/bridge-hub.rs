// KASUGAI Canvas ブリッジハブ — ブラウザ WebGIS 用（Rust 実装・Node.js 不要）。
// アプリ版（kasugai_canvas.exe）を持たない環境で、ブラウザ WebGIS
//（CDN・静的配信）からブリッジ系プロバイダ（copilot / devin / antigravity）
// を使うための常駐プロセス。本体のアプリ内モジュール bridge/ と同一実装を
// 127.0.0.1 で待受させる（各プロバイダは利用時に外部 CLI を子プロセス起動）。
//
// 起動:
//   bridge-hub.exe            （コンソール表示あり・既定 8511）
//   BRIDGE_HUB_PORT=8512 で変更（run-hidden.vbs / install-autostart.ps1 が設定）
// 停止:
//   Ctrl+C / プロセス終了（uninstall-autostart.ps1 は自動起動解除＋停止）
use kasugai_canvas::bridge::{self, BridgeState};
use std::sync::Arc;
use tokio::net::TcpListener;

// 既定はアプリのハブと同じ 8511。併用時は同梱スクリプトが 8512 を設定する
const DEFAULT_PORT: u16 = 8511;

fn hub_port() -> u16 {
    std::env::var("BRIDGE_HUB_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
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
