# install-autostart.ps1 で登録した自動起動を解除し、起動中のハブも停止する。
# 使い方: powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1
$ErrorActionPreference = "Stop"
$hub = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "KasugaiCanvasBridgeHub"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "タスクを削除しました: $taskName"

# このフォルダの server.mjs を実行中の node を特定してツリーごと停止する
# （子ブリッジ・その孫プロセスも /T でまとめて落とす）
$escaped = [regex]::Escape($hub)
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped }
foreach ($p in $procs) {
  taskkill /PID $p.ProcessId /T /F | Out-Null
  Write-Host "ハブを停止しました (pid $($p.ProcessId))"
}
if (-not $procs) { Write-Host "起動中のハブは見つかりませんでした" }
