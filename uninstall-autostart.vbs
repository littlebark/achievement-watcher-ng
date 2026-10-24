' Remove the login autostart shortcut created by install-autostart.vbs
Option Explicit

Dim fso, sh, startupDir, lnkPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

startupDir = sh.SpecialFolders("Startup")
lnkPath = startupDir & "\Achievement Watcher NG.lnk"

If fso.FileExists(lnkPath) Then
  fso.DeleteFile lnkPath, True
  MsgBox "Autostart removed." & vbCrLf & "aw2 will no longer start at login.", 64, "Achievement Watcher NG"
Else
  MsgBox "Autostart was not enabled.", 64, "Achievement Watcher NG"
End If
