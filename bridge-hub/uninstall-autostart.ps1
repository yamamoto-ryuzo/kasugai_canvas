# install-autostart.ps1 で登録した自動起動を解除し、起動中のハブも停止する。
# 使い方: powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1
$ErrorActionPreference = "Stop"
$hub = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "KasugaiCanvasBridgeHub"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "タスクを削除しました: $taskName"

# このフォルダの bridge-hub.exe を実行中のプロセスを特定してツリーごと停止する
# （copilot CLI・devin acp・agy 等の子プロセスも /T でまとめて落とす）
$exe = Join-Path $hub "bridge-hub.exe"
$procs = Get-CimInstance Win32_Process -Filter "Name='bridge-hub.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $exe }
foreach ($p in $procs) {
  taskkill /PID $p.ProcessId /T /F | Out-Null
  Write-Host "ハブを停止しました (pid $($p.ProcessId))"
}
if (-not $procs) { Write-Host "起動中のハブは見つかりませんでした" }
