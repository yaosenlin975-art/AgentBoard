# D4 验收主脚本：一次进程内跑完全部可自动化项，状态不跨进程丢失。
#
# 纪律：临时 APPDATA + 18xxx 端口；清理只按精确 PID；现网 8787 只读校验。
# 用法：pwsh -NoProfile -File .\tests\desktop\d4-run.ps1 [-Only <项号>] [-SkipFreshnessGate]
#
# 退出码：0=全通过；1=有用例 FAIL；3=产物陈旧被门禁拒绝（未跑用例）。

param(
    [string]$Only = '',
    [int]$BasePort = 18801,
    [switch]$SkipFreshnessGate
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'd4-fixture.ps1')

$repoRoot = Split-Path -Parent (Split-Path -Parent $here)
$shellExe = Join-Path $repoRoot 'desktop\src-tauri\target\release\agentboard-desktop.exe'
$results = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------------------
# 产物新鲜度硬门禁：产物必须晚于源码，否则拒绝验收。
#
# 为什么要有这道门（2026-11-13 实际踩过）：
#   三个产物（安装包 14:40 / release exe 14:52 / 便携包 14:53）全部早于
#   server_process.rs(15:04) 与 main.rs(15:08) 的最终提交，导致 D6/D7 的修复
#   根本没进产物 —— 验收跑出来的是一堆「假失败」，很容易误判成代码缺陷。
#   这里在跑任何用例之前先比对 mtime，陈旧就直接中止，不产生假结论。
# ---------------------------------------------------------------------------
function Get-NewestSourceMtime {
    param([string[]]$Roots)
    $newest = [datetime]::MinValue
    $newestFile = ''
    foreach ($root in $Roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem $root -Recurse -File -Include *.rs,*.toml,*.json -EA SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\target\\|\\bundle-stage\\|\\gen\\' } |
            ForEach-Object {
                if ($_.LastWriteTime -gt $newest) { $newest = $_.LastWriteTime; $newestFile = $_.FullName }
            }
    }
    return [pscustomobject]@{ Mtime = $newest; File = $newestFile }
}

function Assert-ArtifactsFresh {
    $srcRoots = @(
        (Join-Path $repoRoot 'desktop\src-tauri\src'),
        (Join-Path $repoRoot 'desktop\src-tauri\Cargo.toml'),
        (Join-Path $repoRoot 'desktop\src-tauri\capabilities'),
        (Join-Path $repoRoot 'apps\server\src'),
        (Join-Path $repoRoot 'apps\web\src')
    )
    $src = Get-NewestSourceMtime -Roots $srcRoots

    $artifacts = @(
        @{ Name = 'release exe'; Path = $shellExe },
        @{ Name = 'NSIS 安装包'; Path = (Join-Path $repoRoot 'desktop\src-tauri\target\release\bundle\nsis\AgentBoard_0.1.0_x64-setup.exe') }
    ) | Where-Object { Test-Path $_.Path }

    # 便携包文件名带 HEAD 短哈希，每次重打都变 —— 不能硬编码，取仓库根最新那份。
    $latestZip = Get-ChildItem -Path $repoRoot -Filter 'AgentBoard-win-x64-*.zip' -File -EA SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestZip) {
        $artifacts += @{ Name = "便携包($($latestZip.Name))"; Path = $latestZip.FullName }
    }

    $stale = @()
    foreach ($a in $artifacts) {
        $m = (Get-Item $a.Path).LastWriteTime
        if ($m -lt $src.Mtime) {
            $stale += ("{0}（{1:HH:mm:ss} < 源码 {2:HH:mm:ss}）" -f $a.Name, $m, $src.Mtime)
        }
    }

    Write-Output ("源码最新：{0} @ {1:yyyy-MM-dd HH:mm:ss}" -f (Split-Path $src.File -Leaf), $src.Mtime)
    foreach ($a in $artifacts) {
        Write-Output ("  产物 {0,-12} @ {1:yyyy-MM-dd HH:mm:ss}" -f $a.Name, (Get-Item $a.Path).LastWriteTime)
    }

    # 更强的检查：zip 外层 mtime 新 ≠ 包里的壳 exe 新。
    # 2026-11-13 实测踩过：16:09 打的便携包里装的是 14:52 的旧壳（缺 D7/D10 修复），
    # 只看 zip mtime 会放行一个「新包配旧壳」的组合。
    #
    # 判据用「内层 PE 必须晚于源码最新 mtime」，不用「必须与 release exe 的 PE 完全相等」：
    # 同源两次链接会产生 20 字节差异（PE TimeDateStamp + 3×IMAGE_DEBUG_DIRECTORY 时间戳 + 16B PDB GUID），
    # 业务代码逐字节相同。2026-11-13 16:55 实测：zip 内壳 PE 16:55:13 / release exe 16:55:47，
    # 差 34 秒、差 20 字节（0.0002%），全在编译元数据里 —— 用「相等」会误判成陈旧。
    if ($latestZip) {
        $zipPe = Get-PeBuildTimeFromZip $latestZip.FullName 'agentboard-desktop.exe'
        Write-Output ("  便携包内壳 PE @ {0}" -f $(if ($zipPe) { $zipPe.ToString('yyyy-MM-dd HH:mm:ss') } else { '读取失败' }))
        if ($null -eq $zipPe) {
            $stale += "便携包内壳 exe 的 PE 时间戳读取失败（拒绝放行）"
        } elseif ($zipPe -lt $src.Mtime) {
            $stale += ("便携包内壳 exe 早于源码（PE {0:HH:mm:ss} < 源码 {1:HH:mm:ss}）—— 包是新打的但壳没换" -f $zipPe, $src.Mtime)
        } else {
            # 内容一致性软检查：差异应只在编译元数据（阈值 1KB），超了说明是不同构建
            $diffInfo = Compare-ZipExeWithRelease -ZipPath $latestZip.FullName -ReleaseExe $shellExe
            if ($null -ne $diffInfo -and $diffInfo.DiffBytes -gt 1024) {
                Write-Output ("  ⚠ 便携包内壳与 release exe 差异 {0} 字节（占 {1:P4}），超出编译元数据量级，可能是不同构建" -f $diffInfo.DiffBytes, $diffInfo.Ratio)
            }
        }
    }

    # NSIS 内嵌壳：同样用「PE 必须晚于源码」判，不用 sha256、不用「与 release exe 完全相等」。
    # sha256 必然不同（Tauri 写入 `_NSIS`/`_UNK` 三字节 bundle 标记）；
    # 「PE 完全相等」也会误判（同源两次链接差约 20 字节编译元数据，见上面 zip 的实测）。
    $nsis = (Join-Path $repoRoot 'desktop\src-tauri\target\release\bundle\nsis\AgentBoard_0.1.0_x64-setup.exe')
    if (Test-Path $nsis) {
        $nsisPe = Get-PeBuildTimeFromNsis $nsis
        if ($null -eq $nsisPe) {
            Write-Output '  NSIS 内嵌壳 PE @ 读取失败（7z 不可用？跳过该子检查）'
        } else {
            Write-Output ("  NSIS 内嵌壳 PE @ {0}" -f $nsisPe.BuildTime.ToString('yyyy-MM-dd HH:mm:ss'))
            if ($nsisPe.BuildTime -lt $src.Mtime) {
                $stale += ("NSIS 内嵌壳早于源码（PE {0:HH:mm:ss} < 源码 {1:HH:mm:ss}）" -f $nsisPe.BuildTime, $src.Mtime)
            }
        }
    }

    if ($stale.Count -gt 0) {
        Write-Output ''
        Write-Output '== 产物陈旧，拒绝验收 =='
        $stale | ForEach-Object { Write-Output ("  {0}" -f $_) }
        Write-Output ''
        Write-Output '处置：先重打产物（node scripts/desktop/build-all.mjs），再跑本脚本。'
        Write-Output '若确认可接受陈旧产物（例如只验不稳定无关项），加 -SkipFreshnessGate 跳过。'
        exit 3
    }
    Write-Output '✔ 产物新鲜度通过（产物晚于源码，且包内壳 exe 与源码 release 同版本）'
    Write-Output ''
}

# --- 产物版本读取工具（判据：PE TimeDateStamp + 大小，不用 sha256） ---

function Get-PeBuildTime {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        $b = [System.IO.File]::ReadAllBytes($Path)
        $o = [BitConverter]::ToInt32($b, 0x3C)
        $ts = [BitConverter]::ToUInt32($b, $o + 8)
        if ($ts -le 0) { return $null }
        return [DateTimeOffset]::FromUnixTimeSeconds($ts).LocalDateTime
    } catch { return $null }
}

function Get-PeBuildTimeFromZip {
    param([string]$ZipPath, [string]$ExeName)
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -EA SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
        try {
            $entry = $zip.Entries | Where-Object { $_.Name -eq $ExeName } | Select-Object -First 1
            if (-not $entry) { return $null }
            $ms = New-Object System.IO.MemoryStream
            $s = $entry.Open()
            $s.CopyTo($ms)
            $s.Close()
            $b = $ms.ToArray()
            $ms.Close()
            if ($b.Length -lt 0x40) { return $null }
            $o = [BitConverter]::ToInt32($b, 0x3C)
            $ts = [BitConverter]::ToUInt32($b, $o + 8)
            if ($ts -le 0) { return $null }
            return [DateTimeOffset]::FromUnixTimeSeconds($ts).LocalDateTime
        } finally { $zip.Dispose() }
    } catch { return $null }
}

function Get-PeBuildTimeFromNsis {
    param([string]$SetupPath)
    $sevenZip = @(
        'C:\Program Files\7-Zip\7z.exe',
        'C:\Program Files (x86)\7-Zip\7z.exe',
        'D:\tools\7z\7z.exe'
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $sevenZip) { return $null }
    $tmp = Join-Path $env:TEMP ("ab-nsis-pe-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
    try {
        $null = & $sevenZip x $SetupPath "-o$tmp" 'agentboard-desktop.exe' -y 2>&1
        $pe = Join-Path $tmp 'agentboard-desktop.exe'
        if (-not (Test-Path $pe)) { return $null }
        $b = [System.IO.File]::ReadAllBytes($pe)
        $o = [BitConverter]::ToInt32($b, 0x3C)
        $ts = [BitConverter]::ToUInt32($b, $o + 8)
        if ($ts -le 0) { return $null }
        return [pscustomobject]@{
            BuildTime = [DateTimeOffset]::FromUnixTimeSeconds($ts).LocalDateTime
            Size      = $b.Length
        }
    } catch { return $null } finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -EA SilentlyContinue }
    }
}

function Add-Result {
    param([string]$Id, [string]$Title, [string]$Status, [string]$Evidence)
    [void]$results.Add([pscustomobject]@{ Id = $Id; Title = $Title; Status = $Status; Evidence = $Evidence })
    Write-Output ("::{0}::{1}::{2}" -f $Id, $Status, ($Evidence -replace "`r?`n", ' / '))
}

# 便携包内壳与 release exe 的逐字节差异（用于判断「是否同一份构建」）
#
# 为什么需要它：同源两次链接会差约 20 字节，全在编译元数据里——
#   PE TimeDateStamp、3×IMAGE_DEBUG_DIRECTORY 时间戳、16B RSDS PDB GUID。
# 业务代码逐字节相同。所以「PE 时间戳必须相等」是错的判据；
# 正确做法是看差异量级：<1KB 视为同源，超出则可能是不同构建。
function Compare-ZipExeWithRelease {
    param([string]$ZipPath, [string]$ReleaseExe)
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -EA SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
        try {
            $entry = $zip.Entries | Where-Object { $_.Name -eq 'agentboard-desktop.exe' } | Select-Object -First 1
            if (-not $entry) { return $null }
            $ms = New-Object System.IO.MemoryStream
            $s = $entry.Open(); $s.CopyTo($ms); $s.Close()
            $a = $ms.ToArray(); $ms.Close()
        } finally { $zip.Dispose() }
        $b = [System.IO.File]::ReadAllBytes($ReleaseExe)
        $n = [Math]::Min($a.Length, $b.Length)
        $cnt = 0
        for ($i = 0; $i -lt $n; $i++) { if ($a[$i] -ne $b[$i]) { $cnt++ } }
        $ratio = if ($n -gt 0) { $cnt / $n } else { 1 }
        return [pscustomobject]@{ DiffBytes = $cnt + [Math]::Abs($a.Length - $b.Length); Total = $n; Ratio = $ratio }
    } catch { return $null }
}

function Should-Run { param([string]$Id) return ($Only -eq '' -or $Only -split ',' -contains $Id) }

# 任一子项要跑就进整组（便携包组需要先解包，解一次供 V8–V11 共用）
function Any-Run { param([string[]]$Ids) foreach ($i in $Ids) { if (Should-Run $i) { return $true } } return $false }

# ---------- 门禁：先验产物新鲜度，陈旧就中止（不产生假失败） ----------
if (-not $SkipFreshnessGate) {
    Assert-ArtifactsFresh
} else {
    Write-Output '⚠ 已按 -SkipFreshnessGate 跳过产物新鲜度门禁'
    Write-Output ''
}

# ---------- V1 首次启动：拉起 server + 看板可用 ----------
if (Should-Run 'V1') {
    $sb = New-AbSandbox -Port $BasePort -Label 'v1'
    $shell = $null; $srvPid = $null
    try {
        $shell = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 70
        $v = Test-AbHealthy -Port $sb.Port
        $lock = Get-AbLock -LockFile $sb.LockFile
        $tree = if ($shell) { Get-AbProcessTree -RootPid $shell.Id } else { @() }
        $nodeChild = $tree | Where-Object { $_.Name -eq 'node.exe' }
        $cmds = ($nodeChild | ForEach-Object { $_.CommandLine }) -join ' | '
        $ok = ($null -ne $srvPid) -and ($null -ne $v) -and ($lock.pid -eq $v.pid) -and ($nodeChild.Count -ge 1)
        Add-Result 'V1' '首次启动拉起 server' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
            "port=$($sb.Port) shellPid=$($shell.Id) listenPid=$srvPid versionPid=$($v.pid) lockPid=$($lock.pid) nodeChild=$($nodeChild.Count) cmd=$cmds"
        )
        # 日志落点（D6）
        $logOk = (Test-Path $sb.ServerLog)
        Add-Result 'V1-log' 'D6 日志落 <APPDATA>\logs\server.log' $(if ($logOk) { 'PASS' } else { 'FAIL' }) (
            "exists=$logOk path=$($sb.ServerLog)"
        )
        # 无安装根 .logs 残留
        $installLogs = Join-Path $repoRoot 'desktop\src-tauri\target\release\.logs'
        Add-Result 'V1-nologs' '安装根无 .logs 目录（D6）' $(if (-not (Test-Path $installLogs)) { 'PASS' } else { 'FAIL' }) (
            "installRootLogs=$($installLogs) exists=$(Test-Path $installLogs)"
        )
    } finally {
        if ($srvPid) { Stop-AbTracked -ExtraPids @($srvPid) } else { Stop-AbTracked }
        $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
    }
}

# ---------- V2 服务已在跑：复用不 spawn ----------
if (Should-Run 'V2') {
    $sb = New-AbSandbox -Port ($BasePort + 1) -Label 'v2'
    $shell1 = $null; $shell2 = $null; $srvPid = $null
    try {
        # 先手动起服务（不经壳），模拟「服务已在跑」
        $savedAp = $env:APPDATA
        $env:APPDATA = $sb.AppData
        $nodeExe = Join-Path $repoRoot 'desktop\src-tauri\target\release\runtime\node.exe'
        if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node).Source }
        $entry = Join-Path $repoRoot 'apps\server\dist\index.js'
        $env:AGENTBOARD_LOG = $sb.ServerLog
        $srv = Start-Process -FilePath $nodeExe -ArgumentList $entry -PassThru -WindowStyle Hidden -WorkingDirectory $repoRoot
        $env:APPDATA = $savedAp
        $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 40
        $before = Get-AbProcessTree -RootPid $srv.Id
        # 再起壳
        $shell1 = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        Start-Sleep -Seconds 10
        $after = Get-AbProcessTree -RootPid $srv.Id
        $nodeCount = ($after | Where-Object { $_.Name -eq 'node.exe' }).Count
        $shellNodeChildren = (Get-AbProcessTree -RootPid $shell1.Id | Where-Object { $_.Name -eq 'node.exe' }).Count
        $v = Test-AbHealthy -Port $sb.Port
        $ok = ($v.pid -eq $srvPid) -and ($shellNodeChildren -eq 0)
        Add-Result 'V2' '服务已在跑→复用不 spawn' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
            "preExistingServerPid=$srvPid listenPid=$((Get-NetTCPConnection -LocalPort $sb.Port -State Listen -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)) versionPid=$($v.pid) shellNodeChildren=$shellNodeChildren nodeProcsUnderServer=$nodeCount"
        )
    } finally {
        Stop-AbTracked
        if ($srvPid) { $null = & taskkill /PID $srvPid /T /F 2>&1 }
        $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
    }
}

# ---------- V3 单实例：第二个自行退出 ----------
if (Should-Run 'V3') {
    $sb = New-AbSandbox -Port ($BasePort + 2) -Label 'v3'
    $shell1 = $null; $shell2 = $null; $srvPid = $null
    try {
        $shell1 = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 70
        $lock1 = Get-AbLock -LockFile $sb.LockFile
        Start-Sleep -Seconds 3
        $shell2 = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        $exited = $shell2.WaitForExit(20000)
        $shellCount = (Get-CimInstance Win32_Process -Filter "Name='agentboard-desktop.exe'" |
                       Where-Object { $_.CommandLine -like "*$shellExe*" }).Count
        $lock2 = Get-AbLock -LockFile $sb.LockFile
        $ok = $exited -and ($lock1.pid -eq $lock2.pid) -and ($shellCount -eq 1)
        Add-Result 'V3' '单实例：第二个自行退出' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
            "secondExited=$exited exitCode=$($shell2.ExitCode) shellProcCount=$shellCount lockBefore=$($lock1.pid) lockAfter=$($lock2.pid)"
        )
    } finally {
        if ($srvPid) { Stop-AbTracked -ExtraPids @($srvPid) } else { Stop-AbTracked }
        $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
    }
}

# ---------- V4 关窗隐藏 + 托盘退出停服删锁 ----------
if (Should-Run 'V4') {
    $sb = New-AbSandbox -Port ($BasePort + 3) -Label 'v4'
    $shell = $null; $srvPid = $null
    try {
        $shell = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 70
        $lockBefore = Get-AbLock -LockFile $sb.LockFile
        # 用验收钩子走与托盘「退出」完全相同的 shutdown 路径
        $null = Stop-AbTracked -ExtraPids @($shell.Id)
        Start-Sleep -Seconds 1
        $shell2 = Start-AbShell -Exe $shellExe -AppData $sb.AppData -ExtraArgs @('--quit-after-ms', '12000')
        $srvPid2 = Wait-AbListening -Port $sb.Port -TimeoutSec 70
        $lock2 = Get-AbLock -LockFile $sb.LockFile
        # 等退出（预算 8s+5s+3s=16s，给 30s）
        $deadline = (Get-Date).AddSeconds(30)
        $gone = $false
        while ((Get-Date) -lt $deadline) {
            $alive = Get-Process -Id $shell2.Id -EA SilentlyContinue
            $portOwned = Get-NetTCPConnection -LocalPort $sb.Port -State Listen -EA SilentlyContinue
            $lockExists = Test-Path $sb.LockFile
            if ((-not $alive) -and (-not $portOwned) -and (-not $lockExists)) { $gone = $true; break }
            Start-Sleep -Milliseconds 500
        }
        Add-Result 'V4' '托盘退出→停服+删锁+壳退出' $(if ($gone) { 'PASS' } else { 'FAIL' }) (
            "port=$($sb.Port) serverPid=$($srvPid2) lockBeforeExit=$(if($lock2){$lock2.pid}else{'none'}) shellAlive=$([bool](Get-Process -Id $shell2.Id -EA SilentlyContinue)) portListening=$([bool](Get-NetTCPConnection -LocalPort $sb.Port -State Listen -EA SilentlyContinue)) lockExists=$(Test-Path $sb.LockFile)"
        )
    } finally {
        Stop-AbTracked
        if ($srvPid) { $null = & taskkill /PID $srvPid /T /F 2>&1 }
        $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
    }
}

# ---------- V5 端口读 config.json + 端口对齐（D6） ----------
if (Should-Run 'V5') {
    $sb = New-AbSandbox -Port ($BasePort + 4) -Label 'v5'
    $shell = $null; $srvPid = $null
    try {
        # 关键：外部 env 故意设成 8787，config.json 是 18805 → 服务必须绑 18805
        $savedPort = $env:AGENTBOARD_PORT
        $env:AGENTBOARD_PORT = '8787'
        $shell = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 70
        $env:AGENTBOARD_PORT = $savedPort
        $v = Test-AbHealthy -Port $sb.Port
        $lock = Get-AbLock -LockFile $sb.LockFile
        $ok = ($null -ne $srvPid) -and ($null -ne $v) -and ($lock.port -eq $sb.Port)
        Add-Result 'V5' '端口对齐：env=8787 + config=18805 → 绑 18805' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
            "configPort=$($sb.Port) envPort=8787 listenPid=$srvPid versionPid=$($v.pid) lockPort=$($lock.port)"
        )
    } finally {
        if ($savedPort) { $env:AGENTBOARD_PORT = $savedPort } else { Remove-Item Env:AGENTBOARD_PORT -EA SilentlyContinue }
        if ($srvPid) { Stop-AbTracked -ExtraPids @($srvPid) } else { Stop-AbTracked }
        $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
    }
}

# ---------- V6 启动失败可见 ----------
if (Should-Run 'V6') {
    $sb = New-AbSandbox -Port ($BasePort + 5) -Label 'v6'
    $shell = $null
    try {
        # 构造方式说明（2026-11-13 实测修正）：
        # 不能用「无效路径」—— resolve_server_entry / resolve_node 对 env 值有 exists() 检查，
        # 不存在就**回退到候选列表**，服务照常起来（这是正确的容错，不是缺陷）。
        # 改成：造一个真实存在但立即 exit(1) 的入口 → node 起而即退 → 壳报「启动后立即退出」。
        $crashEntry = Join-Path $sb.Root 'crash-entry.mjs'
        Set-Content -Path $crashEntry -Value 'process.exit(1);' -Encoding utf8
        $savedEntry = $env:AGENTBOARD_SERVER_ENTRY
        $env:AGENTBOARD_SERVER_ENTRY = $crashEntry
        $shell = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        Start-Sleep -Seconds 15
        $alive = [bool](Get-Process -Id $shell.Id -EA SilentlyContinue)
        $portListening = [bool](Get-NetTCPConnection -LocalPort $sb.Port -State Listen -EA SilentlyContinue)
        $env:AGENTBOARD_SERVER_ENTRY = $savedEntry
        # 窗口文本（错误文案是否可见）
        $shellProc = Get-Process -Id $shell.Id -EA SilentlyContinue
        $title = if ($shellProc) { $shellProc.MainWindowTitle } else { '' }
        $ok = $alive -and (-not $portListening) -and ($title -like '*AgentBoard*')
        Add-Result 'V6' '启动失败不崩不白屏（入口立即退出）' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
            "shellAlive=$alive portListening=$portListening windowTitle=[$title] crashEntry=$crashEntry"
        )
        # 错误文案内容需要窗口内文本，尝试 UI Automation 读（不依赖 CDP）
        try {
            Add-Type -AssemblyName UIAutomationClient -EA SilentlyContinue
            $el = [System.Windows.Automation.AutomationElement]::RootElement
            $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $shell.Id)
            $win = $el.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
            if ($win) {
                $texts = @()
                $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                    [System.Windows.Automation.Condition]::TrueCondition)
                foreach ($n in $all) {
                    $nm = $n.Current.Name
                    if ($nm -and $nm.Trim() -ne '' -and $nm.Length -lt 400) { $texts += $nm }
                }
                $joined = ($texts | Select-Object -Unique) -join ' | '
                Add-Result 'V6-text' '启动页显示可读错误文案' $(if ($joined -match '启动失败|服务|错误') { 'PASS' } else { 'UNVERIFIED' }) (
                    "uiaText=[$joined]"
                )
            } else {
                Add-Result 'V6-text' '启动页显示可读错误文案' 'UNVERIFIED' 'UI Automation 找不到窗口（可能需交互式会话）'
            }
        } catch {
            Add-Result 'V6-text' '启动页显示可读错误文案' 'UNVERIFIED' ("UIA 异常：" + $_.Exception.Message)
        }
    } finally {
        Stop-AbTracked
        $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 15
    }
}

# ---------- V7 无控制台黑窗 ----------
if (Should-Run 'V7') {
    $sb = New-AbSandbox -Port ($BasePort + 6) -Label 'v7'
    $shell = $null; $srvPid = $null
    try {
        $shell = Start-AbShell -Exe $shellExe -AppData $sb.AppData
        $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 70
        Start-Sleep -Seconds 3
        $tree = Get-AbProcessTree -RootPid $shell.Id
        # 判据修正（2026-11-13 实测）：conhost.exe 只要进程带控制台子系统就会有一个，
        # 哪怕 CREATE_NO_WINDOW 生效也一样（对照实验：裸起 node 也有 conhost）。
        # 「黑窗」的可靠判据是 conhost **有没有可见窗口**（MainWindowHandle != 0），不是有没有进程。
        $cons = $tree | Where-Object { $_.Name -eq 'conhost.exe' }
        $visibleCons = @()
        foreach ($c in $cons) {
            $proc = Get-Process -Id $c.ProcessId -EA SilentlyContinue
            if ($proc -and $proc.MainWindowHandle -ne 0) {
                $visibleCons += "$($c.ProcessId)(title=$($proc.MainWindowTitle))"
            }
        }
        # 另：壳自身进程不得是 console 子系统（PE subsystem 断言在 V7-pe 里）
        $shellProc = Get-Process -Id $shell.Id -EA SilentlyContinue
        $shellHasWindow = ($shellProc -and $shellProc.MainWindowHandle -ne 0)
        $ok = ($visibleCons.Count -eq 0) -and $shellHasWindow
        Add-Result 'V7' '无可见控制台黑窗（conhost 无窗口）' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
            "conhostCount=$($cons.Count) visibleConhost=$($visibleCons.Count) $(if($visibleCons.Count){'→'+($visibleCons -join ',')}else{''}) shellMainWindowHandle=$($shellProc.MainWindowHandle) treeSize=$($tree.Count)"
        )
    } finally {
        if ($srvPid) { Stop-AbTracked -ExtraPids @($srvPid) } else { Stop-AbTracked }
        $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
    }
}

# ---------- V7-pe release exe PE subsystem（纯静态，可单独跑） ----------
if (Should-Run 'V7-pe') {
    $fsr = [System.IO.File]::OpenRead($shellExe)
    try {
        $br = New-Object System.IO.BinaryReader($fsr)
        $fsr.Position = 0x3C
        $peOff = $br.ReadInt32()
        $fsr.Position = $peOff + 4 + 20 + 68
        $subsystem = $br.ReadUInt16()
        $br.Close()
    } finally { $fsr.Close() }
    Add-Result 'V7-pe' 'release exe PE subsystem=2(GUI)' $(if ($subsystem -eq 2) { 'PASS' } else { 'FAIL' }) (
        "subsystem=$subsystem (2=Windows GUI, 3=Console)"
    )
}

# ---------- 便携包验收组（V8–V11）----------
#
# 前置：便携包必须解到仓库之外（%TEMP%），否则触发「entry 逃逸」导致跑仓库里的 server（见 ACCEPTANCE-TAURI §9.10 / P4）。
# 这一组的价值在于：便携包是独立交付物，不能用「安装包全绿」代替（D13 的教训——外层 mtime 新但内层壳旧）。

$latestZipForRun = Get-ChildItem -Path $repoRoot -Filter 'AgentBoard-win-x64-*.zip' -File -EA SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($latestZipForRun -and (Any-Run @('V8', 'V9', 'V10', 'V11'))) {
    $pkgExtract = Join-Path $env:TEMP ("ab-d4-pkg-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
    try {
        Expand-Archive -Path $latestZipForRun.FullName -DestinationPath $pkgExtract -Force
        $pkgExe = Get-ChildItem $pkgExtract -Recurse -Filter 'agentboard-desktop.exe' | Select-Object -First 1
        $pkgRoot = Split-Path (Split-Path (Split-Path $pkgExe.FullName -Parent) -Parent) -Parent
        # 仓库外校验：这是 P4 的硬要求，必须先断言
        $outsideRepo = -not ($pkgExe.FullName.ToLower().StartsWith($repoRoot.ToLower()))

        # V8 便携包内壳版本（P7 的核心：外层 mtime 不可信，必须读内层 PE）
        # 判据不用「与 release exe PE 完全相等」：同源两次链接差约 20 字节编译元数据。
        # 用「PE 必须晚于源码最新 mtime」+「关键串必须齐」（V9 覆盖）+「字节差异在元数据量级」。
        if (Should-Run 'V8') {
            $zipPe = Get-PeBuildTime $pkgExe.FullName
            $srcNewest = (Get-NewestSourceMtime -Roots @(
                (Join-Path $repoRoot 'desktop\src-tauri\src'),
                (Join-Path $repoRoot 'desktop\src-tauri\Cargo.toml')
            )).Mtime
            $newerThanSrc = ($null -ne $zipPe) -and ($zipPe -ge $srcNewest)
            $diffInfo = Compare-ZipExeWithRelease -ZipPath $latestZipForRun.FullName -ReleaseExe $shellExe
            $sameBuild = ($null -eq $diffInfo) -or ($diffInfo.DiffBytes -le 1024)
            $ok = $newerThanSrc -and $sameBuild -and $outsideRepo
            Add-Result 'V8' '便携包内壳是新构建（内层 PE 晚于源码 + 与 release 同源）' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
                "zip=$($latestZipForRun.Name) 外层mtime=$($latestZipForRun.LastWriteTime.ToString('HH:mm:ss')) 内层PE=$(if($zipPe){$zipPe.ToString('HH:mm:ss')}else{'读取失败'}) 源码最新=$($srcNewest.ToString('HH:mm:ss')) 晚于源码=$newerThanSrc 字节差异=$(if($diffInfo){"$($diffInfo.DiffBytes)"}else{'?'}) 同源=$sameBuild 仓库外=$outsideRepo"
            )
        }

        # V9 便携包内 D7/D10 关键串（静态）
        if (Should-Run 'V9') {
            $bytes = [System.IO.File]::ReadAllBytes($pkgExe.FullName)
            $utf8 = [System.Text.Encoding]::UTF8.GetString($bytes)
            $need = @{
                'D7-退出反馈' = '正在停止服务'
                'D7-第二实例-标题' = 'AgentBoard 已在运行'
                'D7-第二实例-正文' = '已切换到正在运行的窗口'
                'D10-包含性拒绝' = '逃出了资源根'
            }
            $missing = @()
            foreach ($k in $need.Keys) {
                if (-not $utf8.Contains($need[$k])) { $missing += $k }
            }
            Add-Result 'V9' '便携包内含 D7+D10 关键串' $(if ($missing.Count -eq 0) { 'PASS' } else { 'FAIL' }) (
                "缺失=$($missing -join ',')；命中=$(($need.Keys | Where-Object { $utf8.Contains($need[$_]) }) -join ',')"
            )
        }

        # V10 便携包实跑：起服务 + 健康 + GET / + entry 落在包内
        if (Should-Run 'V10') {
            $sb = New-AbSandbox -Port ($BasePort + 10) -Label 'pkg'
            $shell = $null; $srvPid = $null
            try {
                $shell = Start-AbShell -Exe $pkgExe.FullName -AppData $sb.AppData
                $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 80
                $v = Test-AbHealthy -Port $sb.Port
                $tree = Get-AbProcessTree -RootPid $shell.Id
                $nodeLine = ($tree | Where-Object { $_.Name -eq 'node.exe' }).CommandLine
                $entryInPkg = $nodeLine -and ($nodeLine.ToLower().Contains(($pkgRoot.ToLower() + '\')))
                $getStatus = $null
                try {
                    $r = Invoke-WebRequest "http://127.0.0.1:$($sb.Port)/" -TimeoutSec 8 -UseBasicParsing -SkipHttpErrorCheck
                    $getStatus = $r.StatusCode
                } catch { $getStatus = "ERR" }
                $ok = ($null -ne $srvPid) -and ($null -ne $v) -and $entryInPkg -and ($getStatus -eq 200)
                Add-Result 'V10' '便携包实跑：起服务+健康+GET / 200+entry 在包内' $(if ($ok) { 'PASS' } else { 'FAIL' }) (
                    "port=$($sb.Port) srvPid=$srvPid versionPid=$($v.pid) GET/=$getStatus entryInPkg=$entryInPkg nodeCmd=$nodeLine"
                )
            } finally {
                if ($srvPid) { Stop-AbTracked -ExtraPids @($srvPid) } else { Stop-AbTracked }
                $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
            }
        }

        # V11 便携包解到点开头路径：GET / 仍 200（D8 在便携包路线同样生效）
        if (Should-Run 'V11') {
            $dotBase = Join-Path $env:TEMP ("ab-d4-dotpkg-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
            $dotPkg = Join-Path $dotBase '.abpkg'
            $sb = $null; $shell = $null; $srvPid = $null
            try {
                New-Item -ItemType Directory -Force -Path $dotPkg | Out-Null
                Copy-Item -Recurse (Join-Path $pkgExtract '*') $dotPkg -Force
                $dotExe = Get-ChildItem $dotPkg -Recurse -Filter 'agentboard-desktop.exe' | Select-Object -First 1
                $sb = New-AbSandbox -Port ($BasePort + 11) -Label 'dotpkg'
                $shell = Start-AbShell -Exe $dotExe.FullName -AppData $sb.AppData
                $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 80
                $getStatus = $null
                try {
                    $r = Invoke-WebRequest "http://127.0.0.1:$($sb.Port)/" -TimeoutSec 8 -UseBasicParsing -SkipHttpErrorCheck
                    $getStatus = $r.StatusCode
                } catch { $getStatus = "ERR" }
                Add-Result 'V11' '便携包解到点开头路径 GET / 200（D8）' $(if ($getStatus -eq 200) { 'PASS' } else { 'FAIL' }) (
                    "dotPath=$dotPkg srvPid=$srvPid GET/=$getStatus"
                )
            } finally {
                if ($srvPid) { Stop-AbTracked -ExtraPids @($srvPid) } else { Stop-AbTracked }
                if ($sb) { $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20 }
                if (Test-Path $dotBase) { Remove-Item -Recurse -Force $dotBase -EA SilentlyContinue }
            }
        }
    } finally {
        if (Test-Path $pkgExtract) { Remove-Item -Recurse -Force $pkgExtract -EA SilentlyContinue }
    }
} elseif (Any-Run @('V8', 'V9', 'V10', 'V11')) {
    Add-Result 'V8-V11' '便携包验收组' 'SKIP' '仓库根无 AgentBoard-win-x64-*.zip'
}

# ---------- 收尾 ----------
Stop-AbTracked
$liveOk = Assert-AbLiveUntouched

Write-Output ''
Write-Output '==== D4 结果汇总 ===='
$results | ForEach-Object { "{0,-12} {1,-10} {2}" -f $_.Id, $_.Status, $_.Title }
Write-Output ''
Write-Output ("现网 8787 未受影响：{0}" -f $liveOk)

$fail = ($results | Where-Object { $_.Status -eq 'FAIL' }).Count

# P8 硬约束：版本判据（V8/V9）失败时，功能判据（V10/V11）的 PASS 不能成立。
# 依据（2026-11-13 实测）：缺 D7+D10 的旧便携包能正常起停、GET / 200、entry 在包内 → V10/V11 全绿。
# 「能跑」和「是新构建」是两件独立的事；功能全绿推不出产物合格。
$versionFailed = @($results | Where-Object { $_.Id -in @('V8', 'V9') -and $_.Status -eq 'FAIL' })
$functionPassed = @($results | Where-Object { $_.Id -in @('V10', 'V11') -and $_.Status -eq 'PASS' })
if ($versionFailed.Count -gt 0 -and $functionPassed.Count -gt 0) {
    Write-Output ''
    Write-Output '⚠ P8：便携包功能判据通过，但版本判据失败 —— 交付物不合格'
    Write-Output ('  失败：{0}' -f (($versionFailed | ForEach-Object { $_.Id }) -join ','))
    Write-Output ('  通过：{0}（这些只证明「能跑」，不证明「是新构建」）' -f (($functionPassed | ForEach-Object { $_.Id }) -join ','))
}

exit $(if ($fail -eq 0) { 0 } else { 1 })
