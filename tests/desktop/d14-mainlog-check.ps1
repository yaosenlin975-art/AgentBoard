# D14 main.log 断言验证
#
# 判据来源：lead 2026-11-13 给出的五条口径，已与源码核对一致
#   desktop/src-tauri/src/main.rs:431-455  启动序列
#   desktop/src-tauri/src/server_process.rs:240/248/252  端口探测三态
#   desktop/src-tauri/src/server_process.rs:265-266  entry/node/cwd
#   desktop/src-tauri/src/server_process.rs:130/181/187  停服结果
#
# 用法：pwsh -NoProfile -File .\tests\desktop\d14-mainlog-check.ps1
# 退出码：0 全部通过；1 有断言失败

param(
    [int]$BasePort = 18901,
    [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'd4-fixture.ps1')

$repoRoot = Split-Path -Parent (Split-Path -Parent $here)
$shellExe = Join-Path $repoRoot 'desktop\src-tauri\target\release\agentboard-desktop.exe'
$results = New-Object System.Collections.ArrayList

function Add-Check {
    param([string]$Id, [string]$Title, [bool]$Ok, [string]$Evidence)
    [void]$results.Add([pscustomobject]@{ Id = $Id; Title = $Title; Ok = $Ok; Evidence = $Evidence })
    Write-Output ("::{0}::{1}::{2}" -f $Id, $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Evidence)
}

# ---------- 场景 A：free → spawn → 停服 StoppedChild ----------
# 注意：必须用**同一个实例**走完「启动→spawn→停服」全生命周期。
# 早先版本犯过这个错：先起一个常驻实例，再起第二个带 --quit-after-ms 的实例去触发停服 ——
# 第二实例被 single-instance 插件直接拦掉退出，根本不走 shutdown()，main.log 里自然没有停服记录。
$sb = New-AbSandbox -Port $BasePort -Label 'd14-mainlog'
$shell = $null; $srvPid = $null
$mainLog = Join-Path $sb.ConfigDir 'logs\main.log'
try {
    $shell = Start-AbShell -Exe $shellExe -AppData $sb.AppData -ExtraArgs @('--quit-after-ms', '10000')
    $srvPid = Wait-AbListening -Port $sb.Port -TimeoutSec 80
    Start-Sleep -Seconds 1

    # 等它自己走完 shutdown（预算 8s 停服 + 余量）
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
        $alive = Get-Process -Id $shell.Id -EA SilentlyContinue
        $listening = Get-NetTCPConnection -LocalPort $sb.Port -State Listen -EA SilentlyContinue
        if (-not $alive -and -not $listening) { break }
        Start-Sleep -Milliseconds 400
    }
    Write-Output ("[场景A] shellExited={0} portFree={1}" -f (-not (Get-Process -Id $shell.Id -EA SilentlyContinue)), (-not (Get-NetTCPConnection -LocalPort $sb.Port -State Listen -EA SilentlyContinue)))

    Add-Check 'M0' 'main.log 已生成' (Test-Path $mainLog) "path=$mainLog exists=$(Test-Path $mainLog)"

    if (Test-Path $mainLog) {
        $text = Get-Content $mainLog -Raw
        $lines = Get-Content $mainLog

        # 1. 启动头
        Add-Check 'M1' '含启动头 ==== 启动 mode=' ($text -match '====\s*启动 mode=') (
            ($lines | Where-Object { $_ -match '启动 mode=' } | Select-Object -First 1)
        )

        # 2. 三个字段
        foreach ($f in @('exe_dir=', 'config_dir=', 'layout=')) {
            $hit = ($text -match [regex]::Escape($f))
            Add-Check ("M2-" + $f.TrimEnd('=')) "含字段 $f" $hit (
                ($lines | Where-Object { $_ -like "*$f*" } | Select-Object -First 1)
            )
        }

        # 3. layout 取值必须是 installed|portable|dev 之一
        $layoutLine = ($lines | Where-Object { $_ -match 'layout=' } | Select-Object -First 1)
        $layoutVal = if ($layoutLine -match 'layout=([A-Za-z]+)') { $matches[1] } else { '' }
        Add-Check 'M3' 'layout 取值为 installed|portable|dev' ($layoutVal -in @('installed', 'portable', 'dev')) (
            "layout=$layoutVal"
        )

        # 4. port 带来源
        Add-Check 'M4' 'port= 带来源说明' ($text -match 'port=\d+（来源') (
            ($lines | Where-Object { $_ -match 'port=' } | Select-Object -First 1)
        )

        # 5. 端口探测三态之一（本场景应为 free → 进入 spawn）
        $probe = @('端口探测：agentboard', '端口探测：free', '端口探测：foreign') | Where-Object { $text -match [regex]::Escape($_) }
        Add-Check 'M5' '含端口探测三态之一' ($probe.Count -ge 1) ("命中=" + ($probe -join ','))
        Add-Check 'M5b' '本场景应为 free → 进入 spawn' ($text -match '端口探测：free') (
            ($lines | Where-Object { $_ -match '端口探测' } | Select-Object -First 1)
        )

        # 6. 子进程三行
        foreach ($f in @('entry=', 'node=', 'cwd=')) {
            Add-Check ("M6-" + $f.TrimEnd('=')) "含子进程字段 $f" ($text -match [regex]::Escape($f)) (
                ($lines | Where-Object { $_ -like "*$f*" } | Select-Object -First 1)
            )
        }

        # 7. 不该含旧字段
        $oldUserData = ($lines | Where-Object { $_ -match 'userData=' } | Select-Object -First 1)
        Add-Check 'M7' '不含旧字段 userData=' (-not ($text -match 'userData=')) (
            $(if ($oldUserData) { $oldUserData } else { '未出现（正确）' })
        )
        $oldLogs = ($lines | Where-Object { $_ -match '(?m)^\[\S+\]\s*\[info\]\s*logs=' } | Select-Object -First 1)
        Add-Check 'M7b' '不含旧字段 logs=（应为 日志=）' (-not ($text -match '(?m)^\[\S+\]\s*\[info\]\s*logs=')) (
            $(if ($oldLogs) { $oldLogs } else { '未出现（正确）' })
        )
    }
} finally {
    Stop-AbTracked
    if ($srvPid -and (Get-Process -Id $srvPid -EA SilentlyContinue)) { $null = & taskkill /PID $srvPid /T /F 2>&1 | Out-Null }
    if ($shell -and (Get-Process -Id $shell.Id -EA SilentlyContinue)) { $null = & taskkill /PID $shell.Id /T /F 2>&1 | Out-Null }

    # 8. 停服结果（在 shell 生命周期结束后读）
    if (Test-Path $mainLog) {
        $text = Get-Content $mainLog -Raw
        $stop = @('StoppedChild', 'StoppedTakeover', 'NothingToStop') | Where-Object { $text -match [regex]::Escape($_) }
        Add-Check 'M8' '停服后含 Stopped*/NothingToStop' ($stop.Count -ge 1) ("命中=" + ($stop -join ','))
        Add-Check 'M9' '停服行有实际内容（非空）' (
            ($text -match '停服：StoppedChild') -or ($text -match '停服：StoppedTakeover') -or ($text -match '停服：NothingToStop')
        ) (
            (Get-Content $mainLog | Where-Object { $_ -match '停服' } | Select-Object -First 1)
        )
    }

    $null = Wait-AbPortFree -Port $sb.Port -TimeoutSec 20
    if (-not $KeepSandbox -and (Test-Path $sb.Root)) {
        # 保留 main.log 副本供人工查看
        $copy = Join-Path $env:TEMP ("d14-mainlog-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + ".log")
        if (Test-Path $mainLog) { Copy-Item $mainLog $copy -Force }
        Remove-Item -Recurse -Force $sb.Root -EA SilentlyContinue
        Write-Output ''
        Write-Output "main.log 副本：$copy"
    }
}

Write-Output ''
Write-Output '==== D14 main.log 断言汇总 ===='
$results | ForEach-Object { "{0,-10} {1,-6} {2}" -f $_.Id, $(if ($_.Ok) { 'PASS' } else { 'FAIL' }), $_.Title }
$fail = @($results | Where-Object { -not $_.Ok }).Count
Write-Output ''
Write-Output ("失败 $fail / 共 $($results.Count)")
exit $(if ($fail -eq 0) { 0 } else { 1 })
