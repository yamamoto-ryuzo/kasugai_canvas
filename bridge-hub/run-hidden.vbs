' KASUGAI Canvas ブリッジハブをコンソール非表示で起動するランチャー。
' 手動のダブルクリック起動・タスクスケジューラ登録の双方から使う。
' Rust 製 bridge-hub.exe を起動する（Node.js 不要）
'
' ポート: ハブはアプリ版・ブラウザ WebGIS 共通で 8511 に一本化。
' （旧ブラウザ WebGIS 用の 8512 は廃止。アプリはハブを内蔵せず、
'   インストール済みのこのハブをアプリ起動時に自動起動する）
Dim fso, shell, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = dir
shell.Environment("PROCESS").Item("BRIDGE_HUB_PORT") = "8511"
' bridge-hub.exe をフルパスで起動（停止スクリプトが実行ファイルパスから特定できるように）
shell.Run """" & dir & "\bridge-hub.exe""", 0, False
