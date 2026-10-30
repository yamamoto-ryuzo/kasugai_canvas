@echo off
rem KASUGAI Canvas bridge-hub 一発セットアップ
rem   ZIP解凍後にダブルクリックするだけで、ブロック解除 → 自動起動登録
rem   → ブリッジ用CLIの導入状況確認・自動インストールまで行います。
rem   エージェント・スクリプトからの無人実行は末尾の pause を省略できます:
rem     setup.cmd --nopause   （CI 環境変数が定義済みの場合も自動で省略）
setlocal
cd /d "%~dp0"

echo === KASUGAI Canvas bridge-hub setup ===
echo.

rem ダウンロードZIP由来のブロック属性(MOTW)を解除
powershell -NoProfile -Command "Get-ChildItem -Recurse '%~dp0' -File | Unblock-File" >nul 2>&1

rem ログイン時自動起動の登録＋ハブ起動(ポート8512)
if exist "%~dp0install-autostart.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
)

echo.
rem ブリッジ用CLI(copilot/devin)の導入状況確認＋未導入分の自動インストール
rem （install-autostart.ps1 が %LOCALAPPDATA% へ自己配置済みなので本体側を使う）
if exist "%LOCALAPPDATA%\kasugai\bridge-hub\bridge-hub.exe" (
  "%LOCALAPPDATA%\kasugai\bridge-hub\bridge-hub.exe" --setup all
) else (
  "%~dp0bridge-hub.exe" --setup all
)

echo.
echo 確認: http://127.0.0.1:8512/health
if /i "%~1"=="--nopause" exit /b 0
if /i "%~1"=="--quiet" exit /b 0
if defined CI exit /b 0
pause
