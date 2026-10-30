# 校验插件包的所有"文件外形"约束
#
# 为什么需要这个脚本：
#   2026-10-28 出过一次很贵的事故 —— 我改版本号时用了
#       (Get-Content package.json -Raw) -replace ... | Set-Content package.json -Encoding UTF8
#   PowerShell 5.1 的 -Encoding UTF8 会**写入 BOM**（EF BB BF 三个字节）。
#   JSON 标准不允许 BOM，DSH 读 package.json 时直接抛
#       Unexpected token '', "{" ... is not valid JSON
#   结果：整个插件从 DSH 的 bundle 列表里消失，卡片再也拉不起来，
#   而且 DSH 界面上没有任何明显提示 —— 用户只看到"卡片不出现"。
#
# 这类问题的共同特征：**文件内容看起来完全正确，坏在字节层面**。
# 编辑器、PowerShell 语法检查、node --check 全都发现不了。
# 所以必须专门有一个脚本，只看字节。
#
# 跑法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-package.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$fails = @()
$warns = @()

function Ok($msg)   { Write-Host ("  OK    " + $msg) }
function Bad($msg)  { Write-Host ("  FAIL  " + $msg) -ForegroundColor Red; $script:fails += $msg }
function Warn($msg) { Write-Host ("  WARN  " + $msg) -ForegroundColor Yellow; $script:warns += $msg }

function Get-BomStatus {
    param([string]$Path)
    $b = [System.IO.File]::ReadAllBytes($Path)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { return $true }
    return $false
}

Write-Host ('=' * 62)
Write-Host '插件包外形校验'
Write-Host ('=' * 62)
Write-Host "package root: $Root"
Write-Host ''

# ---------------------------------------------------------------- 1. JSON 文件绝不能有 BOM
Write-Host '--- 1. JSON 文件不能有 BOM（BOM 会让 JSON.parse 直接失败）---'
$jsonFiles = Get-ChildItem $Root -Recurse -File -Filter *.json |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\test\\_' }
if ($jsonFiles.Count -eq 0) {
    Warn '没找到任何 json 文件'
}
foreach ($f in $jsonFiles) {
    $rel = $f.FullName.Substring($Root.Length + 1)
    if (Get-BomStatus $f.FullName) {
        Bad "$rel 带 BOM —— 必须去掉（.NET 写入时用 UTF8Encoding($false)）"
    } else {
        Ok "$rel 无 BOM"
    }
}

# ---------------------------------------------------------------- 2. package.json 必须是合法 JSON
Write-Host ''
Write-Host '--- 2. package.json 能被严格解析 ---'
$pkgPath = Join-Path $Root 'package.json'
if (-not (Test-Path $pkgPath)) {
    Bad 'package.json 不存在'
} else {
    try {
        # 用 node 解析，和 DSH 用的是同一个 JSON.parse
        $out = & node -e "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');const j=JSON.parse(t);console.log('OK '+j.name+'@'+j.version);" $pkgPath 2>&1
        if ($LASTEXITCODE -eq 0) {
            Ok "JSON 解析通过：$out"
        } else {
            Bad "JSON 解析失败：$out"
        }
    } catch {
        Bad "调用 node 失败：$($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------- 3. bundle 声明必须齐全
Write-Host ''
Write-Host '--- 3. bundle 声明（DSH 靠这几个字段找到插件）---'
if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if ($null -eq $pkg.dsh -or $null -eq $pkg.dsh.bundle -or $null -eq $pkg.dsh.bundle.patch) {
        Bad 'package.json 缺少 dsh.bundle.patch'
    } else {
        Ok "dsh.bundle.patch = $($pkg.dsh.bundle.patch)"
        $patchFile = Join-Path $Root ($pkg.dsh.bundle.patch -replace '^\./', '')
        if (Test-Path $patchFile) {
            Ok "patch 文件存在（$((Get-Item $patchFile).Length) 字节）"
        } else {
            Bad "patch 文件不存在：$patchFile"
        }
    }

    if ($null -eq $pkg.main) { Warn 'package.json 没有 main（通常应该是 index.js）' }
    else { Ok "main = $($pkg.main)" }

    # exports 里要暴露 package.json 和 patch 文件。
    # 这不是"可选优化"：DSH 有多个地方要走模块解析才能读到这两个文件，
    # 一旦 exports 没写，`require('pkg/package.json')` 会报
    # ERR_PACKAGE_PATH_NOT_EXPORTED，表现为"插件莫名不加载"。
    if ($null -eq $pkg.exports) {
        Warn 'package.json 没有 exports 字段（没有 exports 时子路径可直接访问，通常没问题）'
    } else {
        $keys = @($pkg.exports.PSObject.Properties.Name)
        if ($keys -contains './package.json') { Ok 'exports 暴露了 ./package.json' }
        else { Bad 'exports 缺 ./package.json（会导致 ERR_PACKAGE_PATH_NOT_EXPORTED）' }

        if ($keys -contains './cordis.patch.yml') { Ok 'exports 暴露了 ./cordis.patch.yml' }
        else { Warn 'exports 缺 ./cordis.patch.yml（建议补上，与其他插件一致）' }
    }
}

# ---------------------------------------------------------------- 4. cordis.patch.yml 结构
Write-Host ''
Write-Host '--- 4. cordis.patch.yml 能插进一个 entry ---'
$patchPath = Join-Path $Root 'cordis.patch.yml'
if (-not (Test-Path $patchPath)) {
    Bad 'cordis.patch.yml 不存在'
} else {
    $ptxt = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
    if ($ptxt -match '(?m)^\s*-\s*insert:') {
        Ok '有 insert 段'
    } else {
        Bad '没有 insert 段 —— 插件不会被挂载'
    }
    if ($ptxt -match '(?m)^\s*-\s*id:\s*dsh-floating-window') {
        Ok '插入了 id: dsh-floating-window'
    } else {
        Bad 'insert 里没有 id: dsh-floating-window'
    }
    if ($ptxt -match '(?m)^\s*name:\s*dsh-floating-window\s*$') {
        Ok '模块名指向 dsh-floating-window'
    } else {
        Bad 'insert 里没有 name: dsh-floating-window'
    }
}

# ---------------------------------------------------------------- 5. PS1 必须有 BOM
Write-Host ''
Write-Host '--- 5. PowerShell 脚本必须有 BOM（否则中文乱码甚至语法错误）---'
$ps1Files = @(Get-ChildItem (Join-Path $Root 'panel') -File -Filter *.ps1 -ErrorAction SilentlyContinue)
$ps1Files += @(Get-ChildItem (Join-Path $Root 'scripts') -File -Filter *.ps1 -ErrorAction SilentlyContinue)
$ps1Files += @(Get-ChildItem (Join-Path $Root 'test') -File -Filter *.ps1 -ErrorAction SilentlyContinue)
if ($ps1Files.Count -eq 0) {
    Warn '没找到任何 ps1 文件'
}
foreach ($f in $ps1Files) {
    $rel = $f.FullName.Substring($Root.Length + 1)
    if (Get-BomStatus $f.FullName) {
        Ok "$rel 有 BOM"
    } else {
        Bad "$rel 缺 BOM —— 跑 scripts\fix-bom.ps1 修复"
    }
}

# ---------------------------------------------------------------- 6. 入口能 import
Write-Host ''
Write-Host '--- 6. index.js 能被 import 并导出 apply ---'
Push-Location $Root
try {
    $out = & node -e "import('./index.js').then(m=>{const ok=typeof m.apply==='function';console.log((ok?'OK':'FAIL')+' exports: '+Object.keys(m).join(','));process.exit(ok?0:1);}).catch(e=>{console.log('FAIL '+e.message);process.exit(1);});" 2>&1
    if ($LASTEXITCODE -eq 0) { Ok $out } else { Bad "import 失败：$out" }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- 7. 本次会话踩过的那些坑，逐条防回归
Write-Host ''
Write-Host '--- 7. 历史事故防回归 ---'
$panel = Join-Path $Root 'panel\Panel.ps1'
if (Test-Path $panel) {
    $txt = [System.IO.File]::ReadAllText($panel, [System.Text.Encoding]::UTF8)
    $txtLines = [System.IO.File]::ReadAllLines($panel, [System.Text.Encoding]::UTF8)

    # 事故 A：函数内局部变量的定时器，Tick 里读不到 -> 崩掉整个卡片
    #
    # 判据必须精确到"**函数体内**创建 DispatcherTimer"，不能全局 grep：
    #   脚本顶层创建的 $startupTimer 本身就是脚本作用域，Tick 里读得到，完全正常。
    #   第一版写成全局匹配，把 $startupTimer 误报成 bug ——
    #   检查脚本误报比不检查更糟：会让人开始忽略它的输出。
    $badTimers = @()
    $inFunc = $false
    $depth = 0
    for ($i = 0; $i -lt $txtLines.Count; $i++) {
        $ln = $txtLines[$i]
        if (-not $inFunc -and $ln -match '^\s*function\s+([A-Za-z_][\w\-]*)') {
            $inFunc = $true
            $depth = 0
        }
        if ($inFunc) {
            if ($ln -match '\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*New-Object\s+System\.Windows\.Threading\.DispatcherTimer') {
                $badTimers += "line $($i + 1): `$$($Matches[1])"
            }
            $depth += ([regex]::Matches($ln, '\{')).Count - ([regex]::Matches($ln, '\}')).Count
            if ($depth -le 0) { $inFunc = $false }
        }
    }

    if ($badTimers.Count -eq 0) {
        Ok '没有函数体内的 DispatcherTimer'
    } else {
        foreach ($bt in $badTimers) {
            Bad "函数体内创建了 DispatcherTimer（$bt）—— Tick 里读不到，会崩掉卡片；应改用 `$script:xxx"
        }
    }

    if ($txt -match 'Add_DispatcherUnhandledException') {
        Ok '有未捕获异常兜底网'
    } else {
        Warn '没有 Add_DispatcherUnhandledException：任一回调抛异常都会让卡片消失'
    }

    if ($txt -match '\$script:restoreTopmostTimer') {
        Ok '恢复置顶的定时器在 $script: 作用域'
    } else {
        Warn '没找到 $script:restoreTopmostTimer'
    }
}

# ---------------------------------------------------------------- 汇总
Write-Host ''
Write-Host ('=' * 62)
if ($fails.Count -eq 0) {
    Write-Host ("全部通过 ✅" + $(if ($warns.Count -gt 0) { "（$($warns.Count) 条提醒）" } else { '' }))
    Write-Host ('=' * 62)
    exit 0
} else {
    Write-Host ("失败 $($fails.Count) 项：") -ForegroundColor Red
    foreach ($f in $fails) { Write-Host ("  - " + $f) -ForegroundColor Red }
    Write-Host ('=' * 62)
    exit 1
}
