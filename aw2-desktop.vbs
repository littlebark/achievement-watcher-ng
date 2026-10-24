' aw2 desktop launcher (hidden window, no console)
' Built-in watchdog + custom achievement popup (Xbox style card)
' Note: run this OR aw2-hidden.vbs, not both required. Single-instance lock dedupes.
Option Explicit

Dim fso, sh, root, electron, profile
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electron = root & "\electron\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electron) Then
  MsgBox "Electron runtime not found." & vbCrLf & vbCrLf & _
         "Run this first:" & vbCrLf & "  cd electron" & vbCrLf & "  npm install", 16, "aw2 desktop"
  WScript.Quit 1
End If

' app mode: pass the electron/ folder (it has package.json -> main.js)
sh.CurrentDirectory = root
sh.Run """" & electron & """ """ & root & "\electron""", 0, False
