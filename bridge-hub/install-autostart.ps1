# KASUGAI Canvas ブリッジハブを「ログイン時に自動起動」で登録する。
# 使い方: powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#
# 常駐するのはハブ（127.0.0.1:8512・Rust 製 bridge-hub.exe）だけで、
# copilot 等の各 CLI はプロバイダが実際に使われた時点で遅延起動される
# （アプリ版と同じ動作。Node.js 不要）。
# ポートはアプリ版（kasugai_canvas.exe :8511）とは別の 8512 を使う。
# 新版アプリは 8512 のハブを掃除対象から外すため同時稼働しても潰されない
# （旧版アプリは 8512 のハブを旧ブリッジ掃除対象として落とす点に注意）。
$ErrorActionPreference = "Stop"
$hub = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $hub "run-hidden.vbs"
$taskName = "KasugaiCanvasBridgeHub"

if (-not (Test-Path (Join-Path $hub "bridge-hub.exe"))) {
  Write-Error "bridge-hub.exe が見つかりません: $hub"
}
if (-not (Test-Path $vbs)) {
  Write-Error "run-hidden.vbs が見つかりません: $hub"
}

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description "KASUGAI Canvas AI bridge hub (http://127.0.0.1:8512/agent)" | Out-Null
Write-Host "タスクを登録しました: $taskName（ログイン時に自動起動）"

# 未起動なら今すぐ起動する（ブラウザ WebGIS 用既定ポートは 8512）
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:8512/health" -TimeoutSec 2
  Write-Host "ハブは既に起動中です (providers: $(($r.providers.PSObject.Properties.Name) -join ', '))"
} catch {
  Start-ScheduledTask -TaskName $taskName
  Write-Host "ハブを起動しました。確認: http://127.0.0.1:8512/health"
}
