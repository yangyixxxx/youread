@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-connector.ps1"
set "CONNECTOR_EXIT=%ERRORLEVEL%"
if not "%CONNECTOR_EXIT%"=="0" (
  echo Connector stopped with an error. See connector\README.md for help.
  pause
)
exit /b %CONNECTOR_EXIT%
