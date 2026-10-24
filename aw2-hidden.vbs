' aw2 hidden launcher (no console window)
' - locates node.exe (PATH -> Program Files)
' - runs "node src\cli.js watch" with window style 0 (fully hidden)
' - acts as a tiny supervisor: if the watchdog dies, restart it after 10s
' - if another instance is already running, the new one exits by itself (single-instance lock)

Option Explicit

Dim fso, sh, baseDir, nodeExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = FindNode()

If nodeExe = "" Then
  MsgBox "Node.js not found." & vbCrLf & _
         "Install Node.js 18+ from https://nodejs.org, then run this again.", _
         48, "Achievement Watcher NG"
  WScript.Quit 1
End If

sh.CurrentDirectory = baseDir
cmd = """" & nodeExe & """ """ & baseDir & "\src\cli.js"" watch"

Do
  sh.Run cmd, 0, True
  ' watchdog exited: if user asked to stop, the stop script also kills this supervisor,
  ' so reaching here usually means a crash -> wait a bit and bring it back.
  WScript.Sleep 10000
Loop

Function FindNode()
  Dim whereFile, f, line, candidate, candidates, i, sysRoot
  FindNode = ""

  ' 1) node.exe from PATH
  whereFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\aw2_where_node.txt"
  On Error Resume Next
  sh.Run "cmd /c where node > """ & whereFile & """ 2>nul", 0, True
  If fso.FileExists(whereFile) Then
    Set f = fso.OpenTextFile(whereFile, 1)
    If Not f.AtEndOfStream Then line = Trim(f.ReadLine())
    f.Close
    fso.DeleteFile whereFile, True
  End If
  On Error GoTo 0
  If IsUsable(line) Then
    FindNode = line
    Exit Function
  End If

  ' 2) well-known install locations
  candidates = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe" _
  )

  For i = 0 To UBound(candidates)
    candidate = candidates(i)
    If IsUsable(candidate) Then
      FindNode = candidate
      Exit Function
    End If
  Next
End Function

Function IsUsable(p)
  IsUsable = False
  If p = "" Then Exit Function
  If fso.FileExists(p) Then IsUsable = True
End Function
