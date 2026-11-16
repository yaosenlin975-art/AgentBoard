# D4 验收夹具：隔离 APPDATA + 非 8787 端口 + 精确 PID 追踪
#
# 纪律（本文件强制）：
#  - 只用临时 APPDATA（%TEMP%\ab-d4-<guid>\appdata），绝不碰真实 %APPDATA%\AgentBoard；
#  - 只用 18xxx 私有端口，绝不碰 8787；
#  - 进程清理只按本文件 Start-AbProcess 返回的精确 PID，禁止 taskkill /IM 模糊匹配。
#
# 用法：在 PowerShell 里 `. .\d4-fixture.ps1` 点源引入。

$script:AbTracked = New-Object System.Collections.ArrayList

# 现网哨兵：8787 的 PID，任何测试前后都必须保持不变
$script:AbLivePid = 31344

function New-AbSandbox {
    param(
        [int]$Port = 18801,
        [string]$Label = 'd4',
        [int]$MaxConcurrentTurns = 3
    )
    $root = Join-Path $env:TEMP ("ab-d4-{0}-{1}" -f $Label, [guid]::NewGuid().ToString('N').Substring(0, 8))
    $appdata = Join-Path $root 'appdata'
    $cfg = Join-Path $appdata 'AgentBoard'
    New-Item -ItemType Directory -Force -Path $cfg | Out-Null
    $config = [ordered]@{ port = $Port; maxConcurrentTurns = $MaxConcurrentTurns }
    ($config | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $cfg 'config.json') -Encoding utf8 -NoNewline
    [pscustomobject]@{
        Root      = $root
        AppData   = $appdata
        ConfigDir = $cfg
        Port      = $Port
        LogDir    = Join-Path $cfg 'logs'
        ServerLog = Join-Path $cfg 'logs\server.log'
        LockFile  = Join-Path $cfg 'server.lock'
    }
}

# 启动壳 exe：返回精确 PID，并把进程登记进追踪表
function Start-AbShell {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string]$AppData,
        [string[]]$ExtraArgs = @()
    )
    $saved = $env:APPDATA
    try {
        $env:APPDATA = $AppData
        $argList = @()
        if ($ExtraArgs.Count -gt 0) { $argList = $ExtraArgs }
        $p = Start-Process -FilePath $Exe -ArgumentList $argList -PassThru
        [void]$script:AbTracked.Add($p.Id)
        return $p
    } finally {
        $env:APPDATA = $saved
    }
}

# 等端口出现监听者，返回 PID（超时返回 $null）
function Wait-AbListening {
    param([Parameter(Mandatory)][int]$Port, [int]$TimeoutSec = 70)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        # 注意：不能用 $pid —— 它是 PowerShell 只读自动变量
        $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -EA SilentlyContinue |
                  Select-Object -First 1 -ExpandProperty OwningProcess)
        if ($owner) { return [int]$owner }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

# 等端口释放
function Wait-AbPortFree {
    param([Parameter(Mandatory)][int]$Port, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -EA SilentlyContinue
        if (-not $c) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

# 健康探针：/api/version 200 且 name=agentboard-server
function Test-AbHealthy {
    param([Parameter(Mandatory)][int]$Port, [int]$TimeoutSec = 3)
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/version" -TimeoutSec $TimeoutSec -UseBasicParsing -SkipHttpErrorCheck
        if ($r.StatusCode -ne 200) { return $null }
        $j = $r.Content | ConvertFrom-Json
        if ($j.name -ne 'agentboard-server') { return $null }
        return $j
    } catch {
        return $null
    }
}

# 进程树（按 ParentProcessId 递归）
#
# 关键：CIM 的 ProcessId/ParentProcessId 是 UInt32，而队列里的值是 Int32。
# PowerShell 哈希表按对象相等+哈希查找，[uint32]5 与 [int]5 不是同一个键 →
# 必须先统一 cast 成 [int]，否则 byParent 永远查不到子进程（本项目踩过）。
function Get-AbProcessTree {
    param([Parameter(Mandatory)][int]$RootPid)
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $byParent = @{}
    foreach ($p in $all) {
        $key = [int]$p.ParentProcessId
        if (-not $byParent.ContainsKey($key)) { $byParent[$key] = @() }
        $byParent[$key] += $p
    }
    $result = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([int]$RootPid)
    $seen = @{}
    while ($queue.Count -gt 0) {
        $cur = [int]$queue.Dequeue()
        if ($seen.ContainsKey($cur)) { continue }
        $seen[$cur] = $true
        $self = $all | Where-Object { [int]$_.ProcessId -eq $cur }
        if ($self) { [void]$result.Add($self) }
        if ($byParent.ContainsKey($cur)) {
            foreach ($child in $byParent[$cur]) { $queue.Enqueue([int]$child.ProcessId) }
        }
    }
    return $result
}

# 只结束自己登记过的 PID（含其子树），并复核
function Stop-AbTracked {
    param([int[]]$ExtraPids = @())
    $pids = @($script:AbTracked) + @($ExtraPids)
    $unique = $pids | Where-Object { $_ -and $_ -gt 0 } | Select-Object -Unique
    foreach ($procId in $unique) {
        $p = Get-Process -Id $procId -EA SilentlyContinue
        if ($p) {
            # 只对确认是本测试起的进程下手：按精确 PID + /T 收子树
            $out = & taskkill /PID $procId /T /F 2>&1
            Write-Output ("  kill {0}: {1}" -f $procId, ($out -join ' '))
        } else {
            Write-Output ("  {0}: already gone" -f $procId)
        }
    }
    $script:AbTracked.Clear()
}

# 现网哨兵校验：8787 的 PID 必须仍是原值
function Assert-AbLiveUntouched {
    $now = (Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue |
            Select-Object -First 1 -ExpandProperty OwningProcess)
    if ($now -ne $script:AbLivePid) {
        throw "现网 8787 监听者变了！期望 $script:AbLivePid，实际 $now"
    }
    return $true
}

# 读 server.lock（不存在返回 $null）
function Get-AbLock {
    param([Parameter(Mandatory)][string]$LockFile)
    if (-not (Test-Path $LockFile)) { return $null }
    try { return (Get-Content $LockFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-AbStep {
    param([string]$Tag, [string]$Message)
    Write-Output ("[{0}] {1}" -f $Tag, $Message)
}
