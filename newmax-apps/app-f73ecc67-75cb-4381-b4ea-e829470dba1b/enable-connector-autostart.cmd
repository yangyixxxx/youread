@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-connector.ps1" -Action Enable
if errorlevel 1 pause
