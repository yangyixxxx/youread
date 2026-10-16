param(
    [ValidateSet('Enable', 'Disable', 'Start', 'Stop', 'Status')]
    [string]$Action = 'Status',
    [string]$DataDir = 'C:\Users\admin\.newmax\app-data\app-f73ecc67-75cb-4381-b4ea-e829470dba1b',
    [string]$StartupDirectory = [Environment]::GetFolderPath('Startup')
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Python = Join-Path $PSScriptRoot 'connector\.venv\Scripts\python.exe'
$Pythonw = Join-Path $PSScriptRoot 'connector\.venv\Scripts\pythonw.exe'
$Entry = Join-Path $PSScriptRoot 'connector\background.py'
$LinkPath = Join-Path $StartupDirectory 'Yingdu-Connector-app-f73ecc67.lnk'
$Arguments = '-I -X utf8 "' + $Entry + '" --data-dir "' + $DataDir + '"'
$ConnectionPath = Join-Path $DataDir 'connector\connection.json'

function Get-Connection {
    if (-not (Test-Path -LiteralPath $ConnectionPath)) { return $null }
    $c = Get-Content -LiteralPath $ConnectionPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($c.url -ne 'http://127.0.0.1:18743' -or $c.token -notmatch '^[A-Za-z0-9_-]{43,128}$') {
        throw '连接配置无效；已有文件保留，请查看连接器说明。'
    }
    return $c
}
function Get-Health {
    $c = Get-Connection
    if (-not $c) { return $null }
    try {
        return Invoke-RestMethod -Uri ($c.url + '/health') -Headers @{Authorization=('Bearer ' + $c.token)} -TimeoutSec 2
    } catch { return $null }
}
function Test-OwnLink {
    if (-not (Test-Path -LiteralPath $LinkPath)) { return $false }
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath)
    if ($link.TargetPath -ne $Pythonw -or $link.Arguments -ne $Arguments) {
        throw '同名启动项不是当前应用的入口，未覆盖或删除它。'
    }
    return $true
}
function Assert-Environment {
    foreach ($path in @($Python, $Pythonw, $Entry)) {
        if (-not (Test-Path -LiteralPath $path)) { throw '缺少运行环境，请先运行 start-connector.cmd 修复。' }
    }
    & $Python -I -c "import yt_dlp, yt_dlp_ejs"
    if ($LASTEXITCODE -ne 0) { throw '连接器依赖不完整，请运行 start-connector.cmd 修复。' }
}
function Start-Background {
    $health = Get-Health
    if ($health -and $health.ok -and $health.workerRunning) {
        Write-Host '连接器已在线；没有重复启动。'
        return
    }
    Assert-Environment
    # pythonw 没有控制台；进程与当前终端独立，不继承可见窗口。
    $process = Start-Process -FilePath $Pythonw -ArgumentList $Arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 300
        $health = Get-Health
        if ($health -and $health.ok -and $health.workerRunning -and $health.background) {
            Write-Host '连接器已静默启动，后台检查已恢复。'
            return
        }
        if ($process.HasExited) { break }
    }
    throw '静默启动未就绪；请查看 app-data 下 connector/background.log。不会结束未知端口占用程序。'
}
try {
    switch ($Action) {
        'Enable' {
            Assert-Environment
            if (-not (Test-OwnLink)) {
                if (-not (Test-Path -LiteralPath $StartupDirectory)) { throw 'Windows 用户启动目录不存在。' }
                $link = (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath)
                $link.TargetPath = $Pythonw
                $link.Arguments = $Arguments
                $link.WorkingDirectory = $PSScriptRoot
                $link.WindowStyle = 7
                $link.Description = '映读：登录后静默检查已订阅频道，不自动调用 AI'
                $link.Save()
                if (-not (Test-OwnLink)) { throw '启动项写入校验失败。' }
            }
            Write-Host '已配置当前用户登录启动项（不是未登录时运行的系统服务）。'
            Start-Background
        }
        'Disable' {
            if (Test-OwnLink) { Remove-Item -LiteralPath $LinkPath }
            Write-Host '已取消登录自启；当前连接器不会被强行停止，已有资料保留。'
        }
        'Start' { Start-Background }
        'Stop' {
            $health = Get-Health
            if (-not $health) { Write-Host '连接器未在线，无需停止。'; break }
            $c = Get-Connection
            $null = Invoke-RestMethod -Uri ($c.url + '/shutdown') -Method Post -Headers @{Authorization=('Bearer ' + $c.token)} -ContentType 'application/json' -Body '{}' -TimeoutSec 5
            for ($i = 0; $i -lt 30; $i++) {
                Start-Sleep -Milliseconds 300
                if (-not (Get-Health)) { Write-Host '连接器已停止；下次登录仍会启动，除非取消自启。'; break }
            }
            if (Get-Health) { throw '连接器尚未停止；没有强制终止任何进程。' }
        }
        'Status' {
            $health = Get-Health
            [pscustomobject]@{startupConfigured=(Test-OwnLink);online=[bool]($health -and $health.ok -and $health.workerRunning);background=[bool]$health.background;processId=$health.pid} | ConvertTo-Json -Compress
        }
    }
    exit 0
} catch {
    # 不打印 HTTP 请求头、配置对象或底层异常，避免泄露本地令牌。
    Write-Host ('操作未完成：' + $(if ($_.Exception.Message -match '^(连接|同名|缺少|Windows|静默|启动项)') { $_.Exception.Message } else { '请检查本地环境、启动目录权限及连接器日志。' }))
    exit 1
}
