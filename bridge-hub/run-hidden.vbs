' KASUGAI Canvas ブリッジハブをコンソール非表示で起動するランチャー。
' 手動のダブルクリック起動・タスクスケジューラ登録の双方から使う。
' 前提: node.exe が PATH 上にあること（Node.js 20.19+）
'
' ポート: アプリ版（kasugai_canvas.exe）が 8511 を占有・掃除するため、
' スタンドアロンは 8512 を使う（新版アプリは 8512 のハブを潰さない）。
Dim fso, shell, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = dir
shell.Environment("PROCESS").Item("BRIDGE_HUB_PORT") = "8512"
' server.mjs をフルパスで起動（停止スクリプトがコマンドラインから特定できるように）
shell.Run "node """ & dir & "\server.mjs""", 0, False
