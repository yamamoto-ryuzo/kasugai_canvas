' KASUGAI Canvas ブリッジハブをコンソール非表示で起動するランチャー。
' 手動のダブルクリック起動・タスクスケジューラ登録の双方から使う。
' Rust 製 bridge-hub.exe を起動する（Node.js 不要）
'
' ポート: アプリ版（kasugai_canvas.exe）が 8511 を占有・掃除するため、
' ブラウザ WebGIS 用は 8512 を使う（新版アプリは 8512 のハブを潰さない）。
Dim fso, shell, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = dir
shell.Environment("PROCESS").Item("BRIDGE_HUB_PORT") = "8512"
' bridge-hub.exe をフルパスで起動（停止スクリプトが実行ファイルパスから特定できるように）
shell.Run """" & dir & "\bridge-hub.exe""", 0, False
