# KASUGAI Canvas ブリッジハブを「ログイン時に自動起動」で登録する。
# 使い方: powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#
# bridge-hub.exe --install と同じ動作をスクリプトで行う版。
# 常駐するのはハブ（127.0.0.1:8511・Rust 製 bridge-hub.exe）だけで、
# copilot 等の各 CLI はプロバイダが実際に使われた時点で遅延起動される
# （Node.js 不要）。
# ポートは 8511 に一本化（アプリ版・ブラウザ WebGIS 共通の唯一のハブ。
# アプリはハブを内蔵せず、インストール済みのこのハブをアプリ起動時に
# 自動起動する。旧ブラウザ WebGIS 用の 8512 常駐ハブは廃止）。
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA "kasugai\bridge-hub"

# ---- ポータブルインストール ----
# ZIP展開先・Downloads 等、インストール先以外から実行されたら:
#   1) ポート8511の占有者が bridge-hub.exe なら停止（イメージ名判定でハング中も拾う）
#      ※旧8512常駐ハブも同時に掃除（イメージ名一致のみ。kasugai_canvas.exe は対象外）
#   2) 旧インストールを削除して新しい一式を配置
#   3) インストール先の自分を再起動して登録・起動フェーズへ進む
if ($src -ne $installDir) {
  Get-NetTCPConnection -LocalPort 8512 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      try {
        $p = Get-Process -Id $_.OwningProcess -ErrorAction Stop
        if ($p.ProcessName -match "bridge-hub") {
          Stop-Process -Id $p.Id -Force -ErrorAction Stop
          Write-Host "旧ポート8512のハブを停止しました (PID $($p.Id))"
        }
      } catch {}
    }
  Get-NetTCPConnection -LocalPort 8511 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      try {
        $p = Get-Process -Id $_.OwningProcess -ErrorAction Stop
        if ($p.ProcessName -match "bridge-hub") {
          Stop-Process -Id $p.Id -Force -ErrorAction Stop
          Write-Host "ポート8511の既存ハブを停止しました (PID $($p.Id))"
        }
      } catch {}
    }
  Get-Process bridge-hub -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($installDir) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Copy-Item (Join-Path $src "*") $installDir -Recurse -Force
  Get-ChildItem -Recurse $installDir -File | Unblock-File -ErrorAction SilentlyContinue
  Write-Host "インストールしました: $installDir"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installDir "install-autostart.ps1")
  exit $LASTEXITCODE
}
# ここから先はインストール先での実行（登録＋起動フェーズ）
$hub = $installDir
$vbs = Join-Path $hub "run-hidden.vbs"
$taskName = "KasugaiCanvasBridgeHub"
$startupVbs = Join-Path ([Environment]::GetFolderPath("Startup")) "$taskName.vbs"

if (-not (Test-Path (Join-Path $hub "bridge-hub.exe"))) {
  Write-Error "bridge-hub.exe が見つかりません: $hub"
}
if (-not (Test-Path $vbs)) {
  Write-Error "run-hidden.vbs が見つかりません: $hub"
}

# 1) タスクスケジューラで登録（ユーザー自身のタスク・管理者権限不要）
$taskRegistered = $false
try {
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force `
    -Description "KASUGAI Canvas AI bridge hub (http://127.0.0.1:8511/agent)" -ErrorAction Stop | Out-Null
  $taskRegistered = $true
  Write-Host "タスクを登録しました: $taskName（ログイン時に自動起動）"
} catch {
  # 2) タスク登録が拒否される環境ではスタートアップフォルダへ vbs を配置
  Copy-Item $vbs $startupVbs -Force
  Write-Host "スタートアップフォルダに登録しました: $startupVbs（ログイン時に自動起動）"
}

# 未起動なら今すぐ起動する（ハブの統一ポートは 8511）
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:8511/health" -TimeoutSec 2
  Write-Host "ハブは既に起動中です (providers: $(($r.providers.PSObject.Properties.Name) -join ', '))"
} catch {
  if ($taskRegistered) {
    Start-ScheduledTask -TaskName $taskName
  } else {
    & wscript.exe "$startupVbs"
  }
  Write-Host "ハブを起動しました。確認: http://127.0.0.1:8511/health"
}
