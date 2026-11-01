/**
 * test/c4-async.mjs -- C4：情况不明复查不阻塞主线程
 *
 * ===========================================================================
 * 【这个测试守的是什么】
 * ===========================================================================
 *
 * 【改前的真实测量数据（test/c4-blocking-measure.mjs 实测）】
 *
 *   场景                          总耗时    主线程停顿
 *   --------------------------------------------------
 *   健康心跳（绝大多数情况）          1ms       16ms  ✅
 *   心跳文件不存在                 218ms      218ms  ⚠️
 *   心跳文件损坏                   215ms      215ms  ⚠️
 *   情况不明复查                  2258ms     2259ms  ❌ 卡死
 *   睡眠唤醒宽限 2.6秒            2609ms       17ms  ✅ 不卡
 *
 * 【关键对照：同一个文件里两种写法】
 *   睡眠唤醒宽限用的是 **await sleep()**（launcher.js:409）→ 不阻塞 ✅
 *   情况不明复查用的是 **syncSleep (Atomics.wait)**（launcher.js:764）→ 阻塞 ❌
 *
 *   这两个功能性质相似，写法却不同。C4 就是把后者改成前者的写法。
 *
 * 【为什么必须改】
 *   这段代码跑在 **DSH 插件宿主的主线程**上。
 *   Atomics.wait 会让整个主线程停住 —— 期间 DSH 的界面、其它插件、
 *   正在进行的对话全部卡住。2.3 秒的卡顿用户是能感觉到的。
 *
 * 【为什么不能直接删掉复查】
 *   复查存在的理由是：心跳文件一瞬间读不到，不代表卡片没了。
 *   直接去拉起会**叠出第二张卡片**（2026-10-31 修过这个风险）。
 *   所以复查必须保留，只是要改成"不占用主线程"的等待。
 *
 * 跑法：node test/c4-async.mjs
 */

import { ensureCardRunning, checkHeartbeat } from '../lib/launcher.js'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let failed = 0
let passed = 0
const group = (n) => console.log(`\n=== ${n} ===`)
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

const here = dirname(fileURLToPath(import.meta.url))
const launcherPath = join(here, '..', 'lib', 'launcher.js')
const launcherSrc = readFileSync(launcherPath, 'utf8')

const TMP = join(tmpdir(), 'dsh-c4-async-' + Date.now())

console.log('='.repeat(70))
console.log('C4：情况不明复查不得阻塞主线程')
console.log('='.repeat(70))

/**
 * 测量 fn 执行期间事件循环被同步阻塞的最长时间。
 * 原理与 c4-blocking-measure.mjs 相同：看 setInterval(10ms) 的实际间隔。
 */
async function measureBlocking(fn) {
  const gaps = []
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    gaps.push(now - last)
    last = now
  }, 10)

  await new Promise((r) => setTimeout(r, 60))
  gaps.length = 0
  last = Date.now()

  const t0 = Date.now()
  const result = await fn()
  const elapsed = Date.now() - t0

  await new Promise((r) => setTimeout(r, 40))
  clearInterval(timer)

  const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0
  return { elapsed, maxGap, result }
}

try {
  mkdirSync(TMP, { recursive: true })

  // ================================================================ 1. 源码检查
  group('1. 源码：情况不明复查不再用 Atomics.wait')

  // 定位「情况不明复查」那一段
  const unknownRecheckBlock = (() => {
    const start = launcherSrc.indexOf('hbUsed.unknown === true')
    if (start < 0) return ''
    // 往后取 1800 字符足够覆盖整个复查循环
    return launcherSrc.slice(start, start + 1800)
  })()

  check('找到了情况不明复查那段代码', unknownRecheckBlock.length > 0)

  // 【判断标准要精确】
  //   我们**允许**保留 options.syncSleep 这个注入口（测试要用它跳过等待），
  //   但**不允许**把它当默认等待方式。
  //   换句话说：不能出现 `const syncSleep = options.syncSleep ?? syncSleepMs`
  //   这种"默认退回 Atomics.wait"的写法。
  check('【核心】复查不把 syncSleep 当默认等待方式',
    !/options\.syncSleep\s*\?\?\s*syncSleepMs/.test(unknownRecheckBlock),
    '默认必须是异步 sleep，不能退回 Atomics.wait')

  check('复查里用了 await asyncSleep（真正的异步等待）',
    /await\s+asyncSleep\s*\(/.test(unknownRecheckBlock),
    '与睡眠唤醒宽限保持同一种写法')

  check('默认等待实现是 Promise + setTimeout（不是 Atomics.wait）',
    /const asyncSleep = options\.sleep \?\? \(\(ms\) => new Promise/.test(unknownRecheckBlock),
    'asyncSleep 的默认值必须是 Promise 版本')

  check('syncSleep 只在显式注入时使用（不再是默认路径）',
    /useInjectedSync/.test(unknownRecheckBlock) &&
    /if \(useInjectedSync\)/.test(unknownRecheckBlock),
    '保留注入口但不当默认')

  // 内层读重试（checkHeartbeat 里的 3×100ms）也应该是可注入的
  // —— 这个不强制改，因为只有 200ms，但确认它有 syncSleep 注入口
  check('checkHeartbeat 的读重试仍保留 syncSleep 注入口（便于测试可控）',
    /options\.syncSleep \?\? syncSleepMs/.test(launcherSrc))

  // ================================================================ 2. 实测：不再阻塞
  group('2. 实测：情况不明时，主线程不再被卡住')

  {
    const d = join(TMP, 'unknown')
    mkdirSync(d, { recursive: true })
    // 故意不写心跳 → checkHeartbeat 返回 unknown → 触发复查。
    // 需要一个真实存在的 Panel.ps1，否则 ensureCardRunning 会在
    // "找不到卡片主程序"处提前返回，测不到复查那一段。
    const fakePanelDir = join(TMP, 'unknownpanel')
    mkdirSync(fakePanelDir, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(fakePanelDir, 'Panel.ps1'), '# fake for test\r\n', 'utf8')

    const m = await measureBlocking(() => ensureCardRunning({
      panelDir: fakePanelDir,
      dataDir: d,
      log: () => {},
      dryRun: true,
      staleMs: 8000,
      // 缩短复查次数，让测试跑得快些；不改默认值
      unknownRecheckTimes: 3,
      unknownRecheckMs: 300,
    }))

    console.log(`     实测：总耗时 ${m.elapsed}ms，主线程最长停顿 ${m.maxGap}ms`)

    // 【阈值怎么定的】
    //   改前实测停顿 2259ms（4×500ms 全同步）。
    //   改成异步后，主线程应该只在每次"读文件"上花几毫秒。
    //   留 300ms 余量（CI 抖动、GC、文件系统慢）。
    check('【关键】主线程停顿 < 300ms（改前是 2259ms）',
      m.maxGap < 300,
      `实际 ${m.maxGap}ms`)

    check('总耗时仍在预期范围（复查确实执行了，约 900ms）',
      m.elapsed >= 600 && m.elapsed < 3000,
      `实际 ${m.elapsed}ms`)

    check('复查完仍然得出"按卡片不在处理"的正确结论',
      m.result && m.result.ok === true,
      JSON.stringify(m.result && { ok: m.result.ok, reason: m.result.reason }))
  }

  // ================================================================ 3. 语义不能退化
  group('3. 语义不退化：复查期间卡片活过来 → 不重复启动')

  {
    const d = join(TMP, 'recovers')
    mkdirSync(d, { recursive: true })
    // 造一个**真实存在**的假 Panel.ps1，否则 ensureCardRunning 会在
    // "找不到卡片主程序"这里提前返回，测试就测不到复查逻辑了。
    const fakePanelDir = join(TMP, 'fakepanel')
    mkdirSync(fakePanelDir, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(fakePanelDir, 'Panel.ps1'), '# fake for test\r\n', 'utf8')

    // 一开始没有心跳；故意在复查期间写一份进去，
    // 验证"复查中卡片恢复 → 不再启动第二张"
    const p = ensureCardRunning({
      panelDir: fakePanelDir,
      dataDir: d,
      log: () => {},
      dryRun: true,
      staleMs: 8000,
      unknownRecheckTimes: 5,
      unknownRecheckMs: 200,
    })

    // 200ms 后写一份新鲜心跳（模拟"读不到只是暂时的，卡片其实活着"）
    setTimeout(() => {
      try {
        writeFileSync(join(d, 'heartbeat.json'), JSON.stringify({
          pid: 4321, hwnd: 0, alive: true, updatedAtMs: Date.now(),
        }), 'utf8')
      } catch { /* ignore */ }
    }, 200)

    const r = await p
    check('复查期间读到心跳 → 判为 already-running（不重复启动）',
      r.reason === 'already-running',
      r.reason)
    check('  没有真的启动进程', r.launched === false, String(r.launched))
  }

  // ================================================================ 4. 正常路径不受影响
  group('4. 正常路径仍快速返回（异步改造没有拖慢正常情况）')

  {
    const d = join(TMP, 'healthy')
    mkdirSync(d, { recursive: true })
    const healthyPanel = join(TMP, 'healthypanel')
    mkdirSync(healthyPanel, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(healthyPanel, 'Panel.ps1'), '# fake\r\n', 'utf8')
    writeFileSync(join(d, 'heartbeat.json'), JSON.stringify({
      pid: 5555, hwnd: 0, alive: true, updatedAtMs: Date.now(),
    }), 'utf8')

    const t0 = Date.now()
    const r = await ensureCardRunning({
      panelDir: healthyPanel,
      dataDir: d,
      log: () => {},
      dryRun: true,
      staleMs: 8000,
    })
    const elapsed = Date.now() - t0

    check('心跳健康 → 立即判 already-running', r.reason === 'already-running', r.reason)
    check('  耗时 < 100ms（不因为改异步而变慢）', elapsed < 100, `${elapsed}ms`)
  }

} catch (e) {
  console.log('\n❌ 测试异常: ' + (e && e.message))
  failed++
} finally {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('')
console.log('='.repeat(70))
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) console.log('全部通过 ✅')
else process.exitCode = 1
console.log('='.repeat(70))
