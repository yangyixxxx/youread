Option Explicit
Dim shell, fs, root, pythonw, entry
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
pythonw = fs.BuildPath(root, "connector\.venv\Scripts\pythonw.exe")
entry = fs.BuildPath(root, "connector\background.py")
If Not fs.FileExists(pythonw) Or Not fs.FileExists(entry) Then
  MsgBox "Connector environment missing. Run start-connector.cmd to repair.", 16, "Yingdu"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & pythonw & Chr(34) & " -I -X utf8 " & Chr(34) & entry & Chr(34), 0, False
