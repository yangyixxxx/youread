$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Root = Split-Path $PSScriptRoot -Parent
$Manager = Join-Path $Root 'manage-connector.ps1'
$Temporary = Join-Path ([IO.Path]::GetTempPath()) ('yingdu-静默验收-' + [guid]::NewGuid().ToString('N'))
$Startup = Join-Path $Temporary 'Startup'
$Data = Join-Path $Temporary 'Data'
$null = New-Item -ItemType Directory -Path $Startup -Force
function Invoke-Manager([string]$Action) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Manager -Action $Action -DataDir $Data -StartupDirectory $Startup
    if ($LASTEXITCODE -ne 0) { throw "管理操作失败：$Action" }
}
try {
    Invoke-Manager 'Enable'
    $first = (Invoke-Manager 'Status') | ConvertFrom-Json
    if (-not ($first.startupConfigured -and $first.online -and $first.background)) { throw '启动状态错误' }
    $process = Get-Process -Id $first.processId
    if ($process.ProcessName -ne 'pythonw' -or $process.MainWindowHandle -ne 0) { throw '出现可见控制台' }
    Invoke-Manager 'Start'
    $second = (Invoke-Manager 'Status') | ConvertFrom-Json
    if ($first.processId -ne $second.processId) { throw '重复启动产生新实例' }
    # 直接重复启动同一后台入口，验证进程级锁而非仅脚本健康检查。
    $shell = New-Object -ComObject WScript.Shell
    $link = Join-Path $Startup 'Yingdu-Connector-app-f73ecc67.lnk'
    $null = $shell.Run(('"' + $link + '"'), 0, $false)
    Start-Sleep -Milliseconds 700
    $third = (Invoke-Manager 'Status') | ConvertFrom-Json
    if ($first.processId -ne $third.processId) { throw '启动快捷方式绕过单实例保护' }
    Invoke-Manager 'Stop'
    Wait-Process -Id $first.processId -Timeout 10 -ErrorAction SilentlyContinue
    # 与实际登录启动完全相同的 .lnk 入口，不模拟注销或重启电脑。
    $null = $shell.Run(('"' + $link + '"'), 0, $false)
    $restarted = $null
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 400
        $restarted = (Invoke-Manager 'Status') | ConvertFrom-Json
        if ($restarted.online) { break }
    }
    if (-not ($restarted.online -and $restarted.background)) { throw '启动项入口未能恢复服务' }
    if ($restarted.processId -eq $first.processId) { throw '旧进程未退出' }
    Invoke-Manager 'Disable'
    $disabled = (Invoke-Manager 'Status') | ConvertFrom-Json
    if ($disabled.startupConfigured -or -not $disabled.online) { throw '取消自启意外停止服务或删除失败' }
    Write-Host 'PASS：隔离自启安装、无窗口、双重单实例、认证停止、同一快捷方式重启、独立取消自启。'
} finally {
    try { Invoke-Manager 'Stop' } catch { Write-Host '临时连接器清理需检查。' }
    Set-Location $Root
    Start-Sleep -Milliseconds 500
    try { Remove-Item -LiteralPath $Temporary -Recurse -Force } catch { Write-Host '临时目录清理未完成，不影响源码。' }
}
