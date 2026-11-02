# CodeBuddy Desktop 只读探测（ACC-06 / ACC-02 复测入口）
#
# 用途：判断本机是否安装了独立的 CodeBuddy Desktop 实例。只读：不启动客户端、不读凭据内容、
#       不枚举命令行、不杀进程、不修改注册表或 PATH。用户安装 Desktop 后重跑本脚本即可取得复测证据。
# 运行：powershell -NoProfile -File apps/server/test/fixtures/codebuddy-desktop-recon.ps1
#       （需要真实 Windows 主机；在 CI/容器中运行结果无意义）

$ErrorActionPreference = 'Continue'
$report = [ordered]@{
  generated_at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
  host         = $env:COMPUTERNAME
  user         = $env:USERNAME
}

# 1. 卸载注册表（4 棵）
$hives = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$apps = @()
foreach ($hive in $hives) {
  Get-ChildItem $hive -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($props.DisplayName) {
      $apps += [pscustomobject]@{
        name    = $props.DisplayName
        version = $props.DisplayVersion
        path    = $props.InstallLocation
        hive    = $hive.Split('\')[0]
      }
    }
  }
}
$report.uninstall_total = $apps.Count
$report.codebuddy_uninstall = @($apps | Where-Object { $_.name -match 'codebuddy|code buddy|代码助手' })
$report.reference_uninstall = @($apps | Where-Object { $_.name -match 'WorkBuddy|腾讯|Tencent' } | Select-Object -First 12)

# 2. 开始菜单快捷方式（只匹配名称）
$startMenus = @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs')
$report.codebuddy_shortcuts = @(
  foreach ($menu in $startMenus) {
    Get-ChildItem $menu -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'codebuddy|代码助手' } |
      ForEach-Object { $_.FullName }
  }
)

# 3. 安装目录清单
$report.local_appdata_programs = @(Get-ChildItem "$env:LOCALAPPDATA\Programs" -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$allInstallHits = @(
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, 'D:\Program Files', 'D:\')) {
    Get-ChildItem $base -Directory -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'codebuddy|code buddy' } |
      ForEach-Object { $_.FullName }
  }
)
# CLI/工具/工作目录不是 Desktop 实例证据：排除 tools/tmp/npm/node_modules 下的同名目录
$desktopInstallHits = @($allInstallHits | Where-Object { $_ -notmatch '\\(tools|tmp|npm|node_modules)\\' })
$report.install_dir_hits = $allInstallHits
$report.desktop_install_hits = $desktopInstallHits
$report.desktop_like_exes = @(
  foreach ($dir in @("$env:LOCALAPPDATA\Programs", $env:ProgramFiles, ${env:ProgramFiles(x86)}, 'D:\Program Files') + $desktopInstallHits) {
    Get-ChildItem $dir -Filter '*CodeBuddy*.exe' -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  }
)

# 4. 进程（仅名称/路径）
$report.running_processes = @(
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match 'codebuddy|code-buddy' } |
    ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; id = $_.Id; path = $_.Path } }
)

# 5. 商店应用
$report.appx = @(
  Get-AppxPackage -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'codebuddy' } |
    ForEach-Object { [pscustomobject]@{ name = $_.Name; version = $_.Version } }
)

# 6. 候选数据目录（只记存在性/文件数/最新时间/exe 名，不读内容）
$candidates = @(
  "$env:USERPROFILE\.codebuddy",
  "$env:USERPROFILE\.codebuddycn",
  "$env:APPDATA\CodeBuddy CN",
  "$env:APPDATA\CodeBuddy",
  "$env:LOCALAPPDATA\CodeBuddyExtension",
  "$env:LOCALAPPDATA\CodeBuddy",
  "$env:LOCALAPPDATA\Programs\CodeBuddy",
  'D:\tools\codebuddy-cli',
  'D:\tools\codebuddy-official'
)
$report.data_dirs = @(
  foreach ($path in $candidates) {
    if (Test-Path $path) {
      $files = Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue
      [pscustomobject]@{
        path   = $path
        files  = $files.Count
        newest = (Get-Item $path).LastWriteTime.ToString('yyyy-MM-dd HH:mm')
        exes   = @($files | Where-Object { $_.Extension -eq '.exe' } | Select-Object -First 3 | ForEach-Object { $_.Name }) -join ','
      }
    } else {
      [pscustomobject]@{ path = $path; files = $null; newest = $null; exes = $null; missing = $true }
    }
  }
)

# 7. CLI（隔离参照；只打印版本，不登录、不读 profile 内容）
$cli = Get-Command codebuddy -ErrorAction SilentlyContinue | Select-Object -First 1
$report.cli = [pscustomobject]@{
  resolved = if ($cli) { $cli.Source } else { $null }
  version  = if ($cli) { (codebuddy --version 2>$null | Select-Object -First 1) } else { $null }
}

# 8. 结论判定：卸载项 / 快捷方式 / 非工具目录安装点 / 进程 / 商店包 / 产品可执行文件，任一出现才算 Desktop 候选
$hasDesktop = (
  @($report.codebuddy_uninstall).Count -gt 0 -or
  @($report.codebuddy_shortcuts).Count -gt 0 -or
  @($report.desktop_install_hits).Count -gt 0 -or
  @($report.running_processes).Count -gt 0 -or
  @($report.appx).Count -gt 0 -or
  @($report.desktop_like_exes).Count -gt 0
)
$report.desktop_instance_evidence = $hasDesktop
$report.verdict = if ($hasDesktop) {
  'DESKTOP_CANDIDATE_FOUND：需人工按 ACC-02 契约补齐版本/身份/快照/退出字段后再评估 ACC-06'
} else {
  'NO_DESKTOP_INSTANCE：codebuddy_desktop provider 保持 unavailable，ACC-06 继续阻塞'
}

$report | ConvertTo-Json -Depth 6
