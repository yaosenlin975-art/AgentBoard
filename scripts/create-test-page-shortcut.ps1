<#
.SYNOPSIS
  在桌面创建「AgentBoard 测试页」快捷方式（TEST-PAGE）。

.DESCRIPTION
  双击即用默认浏览器打开测试页 http://127.0.0.1:<端口>。
  测试页由 scripts/dev-page.mjs（pnpm dev:test-page）拉起，固定端口 5174，幂等复用。
  重装/换机后重新执行本脚本即可。

.PARAMETER Port
  测试页端口，默认 5174（与 scripts/dev-page.mjs 的 DEFAULT_PORT 一致）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/create-test-page-shortcut.ps1
#>
param(
  [int]$Port = 5174
)

$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$Port/"
$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop)) { throw '无法定位桌面目录' }
$lnkPath = Join-Path $desktop 'AgentBoard 测试页.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
# 目标直接写 URL：Windows 会交给默认浏览器打开，不需要额外的启动器脚本
$shortcut.TargetPath = $url
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
$shortcut.Description = "AgentBoard 测试页（$url）—— 界面验证用；正式页 http://127.0.0.1:8787 只在任务关闭后重建"
$shortcut.Save()

# 同时落一份 .url（Internet Shortcut）兜底：某些策略下 .lnk 的 URL 目标会被拦住
$urlPath = Join-Path $desktop 'AgentBoard 测试页.url'
$content = @(
  '[InternetShortcut]',
  "URL=$url",
  'IconIndex=13',
  "IconFile=$env:SystemRoot\System32\SHELL32.dll"
) -join "`r`n"
[System.IO.File]::WriteAllText($urlPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Output "已创建快捷方式：$lnkPath"
Write-Output "  目标：$url"
Write-Output "已创建兜底 Internet 快捷方式：$urlPath"
Write-Output "若测试页未启动，先运行：pnpm dev:test-page"
