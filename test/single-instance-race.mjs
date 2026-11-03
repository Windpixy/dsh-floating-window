/**
 * test/single-instance-race.mjs -- 单实例保护的**并发竞态**验证
 *
 * 【这张测试守的是什么 —— 2026-11-03 真实事故】
 *   本机有 **3 张卡片同时运行**（pid 25260 / 14268 / 29172），
 *   心跳文件每 2 秒被其中一个覆盖一次，桌面上叠着多张卡。
 *
 *   根因是两个问题**叠加**：
 *
 *     ① 心跳临时文件名是**写死的固定名** `heartbeat.json.tmp`
 *        （Panel.ps1:177）。两个进程同时写时共用同一个临时文件，
 *        互相覆盖对方写到一半的内容。
 *        ——这跟 D1 第二步给 settings.json 修的是同一个问题，
 *          但当时只修了 settings.json，心跳漏了。
 *
 *     ② 单实例判断读到解析失败时 `catch { return $false }`
 *        （Panel.ps1:111-114），即"读不懂 = 没有别的实例" = 放行。
 *
 *   叠加后果：A 正在写 tmp → B 启动来读心跳 → 读到半截 JSON →
 *   解析失败 → 判定"没有实例" → B 也起来了。
 *
 * 【为什么原有 single-instance.mjs 没抓到这个】
 *   它是**串行**的：起第一个 → 等它稳定 → 起第二个 → 看第二个是否退出。
 *   而真正出事的是**同时**读写的那一刻。串行测试永远碰不到那个时间窗。
 *
 *   所以这张测试要做的是一件很具体的事：
 *   在"心跳文件正处于半截状态"时，问单实例判断该不该放行。
 *   正确答案是**不该放行**（宁可多挡一次，也不能叠卡片）。
 *
 * 跑法：node test/single-instance-race.mjs
 * 退出码 0 = 全通过，1 = 有失败。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const bad = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  (${detail})` : ''}`)
  } else {
    fail++
    bad.push(name)
    console.log(`  ❌ ${name}${detail ? `  (${detail})` : ''}`)
  }
}

const panelSrc = readFileSync(new URL('../panel/Panel.ps1', import.meta.url), 'utf8')

const stripPsComments = (src) =>
  src.split(/\r?\n/).filter((ln) => !/^\s*#/.test(ln)).join('\n')
const panelCode = stripPsComments(panelSrc)

const psFunc = (src, name) => {
  const m = src.match(new RegExp(`function\\s+${name}\\s*\\{[\\s\\S]*?\\r?\\n\\}`))
  return m ? m[0] : ''
}

const root = mkdtempSync(join(tmpdir(), 'dshsi-'))

try {
  // ================================================================
  // 1. 心跳临时文件名必须是**每进程唯一**
  // ================================================================
  console.log('\n=== 1. 心跳临时文件名必须唯一（不能写死） ===')

  {
    const hbFn = psFunc(panelCode, 'Write-Heartbeat')
    ok('抓到了 Write-Heartbeat 函数', hbFn.length > 0)

    // 【核心断言】不能再用 "$HeartbeatPath.tmp" 这种固定名
    ok('【关键】心跳临时文件名不再写死为 heartbeat.json.tmp',
      !/\$tmp\s*=\s*"\$HeartbeatPath\.tmp"/.test(hbFn),
      hbFn.match(/\$tmp\s*=\s*[^\r\n]*/)?.[0] || '没找到 tmp 赋值')

    // 新名字必须带进程号（不同进程不会撞）
    ok('【关键】临时文件名里带进程号（pid）',
      /\$PID/.test(hbFn),
      hbFn ? (hbFn.includes('$PID') ? '含 $PID' : '没有 $PID') : '无函数')

    // 还应带随机串，防止同进程内快速重入撞名
    ok('临时文件名里带随机成分（同进程重入也不撞）',
      /NewGuid|Guid|random|Random/.test(hbFn),
      hbFn ? '含随机成分' : '无函数')

    // 写规则必须是"写 tmp → 原子改名"，不能直接写正式文件
    ok('【关键】仍是"写 tmp → 改名"的原子写法（不能直接写心跳正本）',
      /Move-Item|Move\(/.test(hbFn),
      hbFn ? '有 Move' : '无函数')
  }

  // ================================================================
  // 2. 读到半截心跳时，单实例判断必须**保守放行 = 挡住**
  // ================================================================
  console.log('\n=== 2. 半截心跳不能当成"没有实例" ===')

  {
    const testFn = psFunc(panelCode, 'Test-AnotherInstanceAlive')
    ok('抓到了 Test-AnotherInstanceAlive 函数', testFn.length > 0)

    // 【核心断言】catch 里不能直接 return $false
    //   注意：要区分"文件读不到"和"文件在读但内容半截"两种情况。
    //   前者可以放行（真的可能没卡片）；后者必须挡住。
    const catchBlocks = testFn.match(/catch\s*\{[\s\S]*?\}/g) || []
    ok('函数里有 catch 块', catchBlocks.length > 0, `${catchBlocks.length} 个`)

    const badCatch = catchBlocks.filter((c) => /return\s+\$false/.test(c))
    ok('【关键】catch 里不再无条件 return $false（那等于"读不懂就放行"）',
      badCatch.length === 0,
      badCatch.length ? `${badCatch.length} 个 catch 仍直接放行` : '都不是无条件放行')

    // 必须有"重试读取"或"保守判为有实例"的兜底
    ok('【关键】解析失败会重试读取（等到写完整）',
      /Start-Sleep|Retry|重试|attempt/i.test(testFn),
      testFn ? (/Start-Sleep|Retry|重试|attempt/i.test(testFn) ? '有重试' : '没有重试') : '无函数')

    ok('【关键】重试后仍读不到半截内容时，保守判为"有实例"（挡住第二个）',
      /return\s+\$true/.test(testFn),
      testFn ? (/return\s+\$true/.test(testFn) ? '有保守放行分支' : '没有保守分支') : '无函数')
  }

  // ================================================================
  // 3. 真实的半截文件：判断函数应该挡住（在隔离目录里真跑）
  // ================================================================
  console.log('\n=== 3. 真实造一个半截心跳文件 ===')

  {
    // 造半截 JSON（模拟另一个进程写到一半）
    const dir = join(root, 'half')
    mkdirSync(dir, { recursive: true })
    const hbPath = join(dir, 'heartbeat.json')
    writeFileSync(hbPath, '{"pid":12345,"hwnd":99,"alive":tr')

    // 【为什么不把 PowerShell 代码写成 -Command 的 inline 字符串】
    //   试过一次，失败了：Panel.ps1 的路径里有中文和空格，
    //   再叠上 JS → PowerShell 两层转义（`\` 和 `'` 和 `"`），
    //   拼出来的脚本几乎必然在某一层出错，而且报错信息还看不出错在哪。
    //   正确做法：把探针写成一个独立的 .ps1 文件，路径当参数传进去。
    //   这样只有一层转义（写文件），出问题也容易看。
    const probePath = join(root, 'probe.ps1')
    const probe = [
      // 【param() 必须在第一行】PowerShell 只认脚本最开头的 param 块，
      //   前面放任何语句都会变成"param 出现在不合法位置"的语法错误。
      'param()',
      "$ErrorActionPreference = 'Stop'",
      '',
      '$panelFile = $env:DSH_PROBE_PANEL',
      '$hbFile    = $env:DSH_PROBE_HB',
      '',
      '$src = [System.IO.File]::ReadAllText($panelFile)',
      '',
      '# 从源码里抠出 Test-AnotherInstanceAlive（只切函数，不加载整个 WPF 应用）',
      "$m = [regex]::Match($src, '(?m)^function\\s+Test-AnotherInstanceAlive\\s*\\{[\\s\\S]*?\\r?\\n\\}')",
      "if (-not $m.Success) { Write-Output 'NOFN'; exit 0 }",
      'Invoke-Expression ($m.Value + "`r`n")',
      '',
      '$r = Test-AnotherInstanceAlive -HbPath $hbFile -StaleMs 8000',
      "Write-Output ('RESULT=' + $r)",
    ].join('\r\n')
    writeFileSync(probePath, probe, 'utf8')

    const { spawnSync } = await import('node:child_process')
    // 【路径必须用 fileURLToPath】
    //   踩过：用 new URL(...).pathname 得到的是 `.../DSH%20boll/...`，
    //   空格被编码成 %20，PowerShell 拿着这个路径当然找不到文件。
    //   fileURLToPath 才是"URL → 本地真实路径"的正确转换。
    const { fileURLToPath } = await import('node:url')
    const panelAbsPath = fileURLToPath(new URL('../panel/Panel.ps1', import.meta.url))

    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probePath],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          DSH_PROBE_PANEL: panelAbsPath,
          DSH_PROBE_HB: hbPath,
        },
      })

    const out = (r.stdout || '') + (r.stderr || '')
    if (out.includes('NOFN')) {
      ok('能加载到 Test-AnotherInstanceAlive', false, '函数没抠出来')
    } else {
      const m = out.match(/RESULT=(True|False)/i)
      ok('真实跑一遍拿到了结论', m !== null, m ? m[0] : out.slice(0, 200))
      if (m) {
        // 【核心断言】半截文件 -> 应该判"有实例"（True），挡住第二个
        ok('【关键】心跳是半截内容时，判定"已有实例"（挡住第二个卡片，不叠卡）',
          /True/i.test(m[1]),
          `实际返回 ${m[1]}（False = 会叠出第二张卡）`)
      }
    }
  }

  // ================================================================
  // 4. 正常心跳仍要能正确识别（不能为了保守而永远挡住）
  // ================================================================
  console.log('\n=== 4. 正常心跳不能被误挡（防过度保守） ===')

  {
    const testFn = psFunc(panelCode, 'Test-AnotherInstanceAlive')
    // 新鲜心跳 -> true
    ok('函数里有"新鲜就判定有实例"的路径',
      /age\s*>=?\s*\$StaleMs/.test(testFn) || /\$age/.test(testFn),
      testFn ? '有 age 判断' : '无函数')
    // alive=false -> false（用户主动关掉，应该允许新开）
    ok('alive=false 时会放行（用户主动关闭后能重新打开）',
      /alive\s*-ne\s*\$true/.test(testFn) || /alive\s*-eq\s*\$false/.test(testFn),
      testFn ? '有 alive 判断' : '无函数')
    // 过期心跳 -> 先查 pid，pid 没了才放行
    //
    // 【这条断言的语义在 D6（2026-11-03）改了，必须同步改】
    //   原来是：过期 -> 直接 return $false（放行）。
    //   那张卡修的是"读到半截别放行"，但"过期就放行"这条被沿用了。
    //
    //   后来的真实事故证明这条太粗糙：旧卡片进程还活着、只是有段时间没写心跳，
    //   而"过期就放行"让新卡片误以为自己可以接管 -> 3 张卡片叠在一起。
    //   D6 把它改成：过期之后先问系统"那个 pid 还在不在"，
    //   只有**确认进程没了**才放行。
    //
    //   所以现在正确的断言不是"过期就 return false"（那已经是错的），
    //   而是"过期分支里必须先查 pid，并且只有确认没了才放行"。
    ok('【D6 后语义】心跳过期时会先核对 pid，确认进程没了才放行',
      /\$age\s*-ge\s*\$StaleMs/.test(testFn) &&
      /Get-Process\s+-Id|System\.Diagnostics\.Process/.test(testFn),
      testFn
        ? (/Get-Process\s+-Id/.test(testFn) ? '过期分支里有 pid 核对' : '过期分支没查 pid')
        : '无函数')

    ok('【D6 后语义】过期时若进程还活着，不放行（这是挡叠卡的关键）',
      /\$stillAlive/.test(testFn),
      testFn ? (/\$stillAlive/.test(testFn) ? '有 $stillAlive 分支' : '没有') : '无函数')
  }

  // ================================================================
  // 5. 清理残留的 tmp 文件（多进程时代可能已经堆了）
  // ================================================================
  console.log('\n=== 5. 清理历史残留的 heartbeat tmp ===')

  {
    // 【断言必须精确】
    //   最初写的是 /heartbeat\.json\.tmp|残留|清理.*tmp/i —— 太宽，
    //   而且我实现时用的是 $legacyTmp 变量名，字面上没有 "heartbeat.json.tmp"
    //   那几个字连在一起，于是断言匹配不到、误报失败。
    //   真正要证明的是：代码里有一段**会删掉旧固定名 tmp** 的逻辑。
    //   所以直接查那三件事：变量、判存在、删除。
    // 【注意 .length 要先兜底】
    //   踩过：改前代码里没有这个变量，match 返回 null，
    //   直接取 [0] 得到 undefined，再 .length 就抛异常，
    //   整个测试以"自身异常"收场 —— 那样就看不到后面几项的真实结论了。
    //   测试要在"代码还没改"的情况下也能完整跑完并如实报失败。
    const legacyVar = (panelCode.match(/\$legacyTmp\s*=\s*"\$HeartbeatPath\.tmp"/) || [''])[0] || ''
    ok('【关键】有指向旧固定名 tmp 的变量', legacyVar.length > 0,
      legacyVar || '没找到 $legacyTmp 赋值')

    const hasRemove = /Remove-Item\s+-LiteralPath\s+\$legacyTmp/.test(panelCode)
    ok('【关键】启动时会删掉旧固定名 tmp（不留垃圾）', hasRemove,
      hasRemove ? '有 Remove-Item' : '没看到删除')

    // 【安全断言】只能删这一个精确名字，不能按 *.tmp 通配
    const legacyBlock = (panelCode.match(/\$legacyTmp[\s\S]{0,400}?\n\s*\}\s*\n\s*\}\s*\n\s*catch/) || [''])[0]
    ok('【关键】只删精确名字，不按 *.tmp 通配（避免误删别人的临时文件）',
      !/Remove-Item[^\n]*\*\.tmp/.test(legacyBlock || panelCode),
      legacyBlock ? '只删精确名' : '没抓到代码块')
  }
} catch (e) {
  fail++
  bad.push('测试自身异常: ' + (e && e.message))
  console.log('\n❌ 测试自身抛异常: ' + (e && e.stack))
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('\n' + '='.repeat(60))
console.log(`通过 ${pass}   失败 ${fail}`)
if (fail === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
} else {
  console.log('有失败项')
  if (bad.length) console.log('失败清单:\n  · ' + bad.join('\n  · '))
  process.exit(1)
}
