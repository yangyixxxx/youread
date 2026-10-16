# Diagnostic foreground launcher; normal login startup uses pythonw and background.py.
$ErrorActionPreference = 'Stop'
$Connector = Join-Path $PSScriptRoot 'connector'
$Python = Join-Path $Connector '.venv\Scripts\python.exe'
$env:PYTHONUTF8 = '1'

try {
    if (-not (Test-Path -LiteralPath $Python)) {
        Write-Host 'Creating an isolated Python environment for the local connector...'
        if (Get-Command python.exe -ErrorAction SilentlyContinue) {
            & python.exe -m venv (Join-Path $Connector '.venv')
        } elseif (Get-Command py.exe -ErrorAction SilentlyContinue) {
            & py.exe -3.12 -m venv (Join-Path $Connector '.venv')
        } else {
            throw 'Python 3.12 is required. Install Python and run this script again.'
        }
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python virtual environment.' }
    }

    & $Python -I -c "import sys, importlib.util as u; from importlib.metadata import version; sys.exit(0 if u.find_spec('yt_dlp') and u.find_spec('yt_dlp_ejs') and version('yt-dlp') == '2026.8.19' else 1)"
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing the pinned yt-dlp dependency into the connector environment...'
        & $Python -I -m pip install --disable-pip-version-check -r (Join-Path $Connector 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network and retry.' }
    }

    Write-Host 'Local connector: http://127.0.0.1:18743 . Keep this window open. Press Ctrl+C to stop.'
    Write-Host 'Diagnostic foreground mode. Normal silent startup: start-connector-silent.vbs. Credentials are never printed.'
    & $Python -I -X utf8 (Join-Path $Connector 'server.py')
    exit $LASTEXITCODE
} catch {
    Write-Host 'Connector could not start. Check Python, dependency installation, and local file permissions.'
    Write-Host 'Your existing library has not been deleted. See connector/README.md for recovery steps.'
    exit 1
}
