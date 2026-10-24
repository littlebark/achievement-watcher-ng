' aw2 桌面版启动器：隐藏窗口启动 Electron 应用（内置 watchdog + 自绘成就弹窗）
' 注意：与 aw2-hidden.vbs 二选一即可，不必同时开（同时开也不冲突，单实例锁会自动去重）
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

Dim root
root = fso.GetParentFolderName(WScript.ScriptFullName) ' 项目根目录

Dim electron
electron = root & "\electron\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electron) Then
  MsgBox "未找到 Electron 运行时。" & vbCrLf & "请先在 electron 目录执行: npm install", 16, "aw2 桌面版"
  WScript.Quit 1
End If

' 传 electron/ 目录（读它的 package.json -> main.js）
sh.CurrentDirectory = root
sh.Run """" & electron & """ """ & root & "\electron""", 0, False
