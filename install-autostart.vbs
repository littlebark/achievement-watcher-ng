' Register aw2 to start hidden at login (current user, no admin required).
' Creates a shortcut in the Startup folder that runs aw2-hidden.vbs via wscript.exe.
Option Explicit

Dim fso, sh, baseDir, startupDir, lnkPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
startupDir = sh.SpecialFolders("Startup")
lnkPath = startupDir & "\Achievement Watcher NG.lnk"

Dim lnk
Set lnk = sh.CreateShortcut(lnkPath)
lnk.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
lnk.Arguments = """" & baseDir & "\aw2-hidden.vbs"""
lnk.WorkingDirectory = baseDir
lnk.WindowStyle = 7
lnk.Description = "Achievement Watcher NG - achievement unlock toasts (runs hidden)"
lnk.Save

MsgBox "Autostart enabled." & vbCrLf & vbCrLf & _
       "aw2 will run hidden in background at every login, no window." & vbCrLf & _
       "Shortcut: " & lnkPath & vbCrLf & vbCrLf & _
       "To remove: run uninstall-autostart.vbs", _
       64, "Achievement Watcher NG"
