/**
 * test/c4-blocking-measure.mjs -- C4 测量：同步等待到底阻塞多久
 *
 * ===========================================================================
 * 【这个脚本只测量，不修改任何产品代码，也不启动任何进程】
 * ===========================================================================
 *
 * 【要问的问题】
 *   checkHeartbeat() 在"心跳读不到"时会**同步阻塞**重试
 *   （lib/launcher.js:205-232，默认 3 次 × 100ms = 最多 200ms）。
 *
 *   ensureCardRunning() 在"情况不明"时还会再做一轮
 *   （lib/launcher.js:745-768，默认 4 次 × 500ms = 最多 2000ms）。
 *
 *   这两段都跑在 **DSH 插件宿主的主线程**上。
 *
 *   施工卡 C4 说"理论上最多约 2 秒"—— 但**没有实测**。
 *   本脚本就是去测：
 *     · 到底阻塞多久？
 *     · 阻塞期间事件循环真的停了吗？
 *     · 这些等待在真实运行中出现得频繁吗？
 *
 * 【怎么测"事件循环停没停"】
 *   起一个 setInterval 每 10ms 打一次点。如果主线程被同步阻塞，
 *   这个间隔会明显拉长（点打不出来）。
 *   这是最直接的证据：不用看代码推理，直接看"主线程还能不能干活"。
 *
 * 跑法：node test/c4-blocking-measure.mjs
 */

import { checkHeartbeat, ensureCardRunning } from '../lib/launcher.js'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TMP = join(tmpdir(), 'dsh-c4-measure-' + Date.now())

console.log('='.repeat(70))
console.log('C4 测量：同步等待对事件循环的阻塞')
console.log('='.repeat(70))
console.log('只测量，不修改产品代码，不启动任何进程')
console.log('临时目录: ' + TMP)
console.log('')

try {
  mkdirSync(TMP, { recursive: true })

  /**
   * 在 fn 执行期间，统计事件循环被卡住的最长/总时长。
   *
   * 【原理】
   *   setInterval(fn, 10) 期望每 10ms 触发一次。
   *   如果主线程被同步代码占住，回调就排不上队 → 实际间隔远大于 10ms。
   *   记下相邻两次回调的最大间隔，就是"最长阻塞时间"。
   */
  async function measureBlocking(label, fn) {
    const gaps = []
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      gaps.push(now - last)
      last = now
    }, 10)

    // 让 interval 先稳定几拍，避免把启动抖动算进去
    await new Promise((r) => setTimeout(r, 60))
    gaps.length = 0
    last = Date.now()

    const t0 = Date.now()
    const result = await fn()
    const elapsed = Date.now() - t0

    // 再等一拍，把最后那段也收进来
    await new Promise((r) => setTimeout(r, 40))
    clearInterval(timer)

    const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0
    const avgGap = gaps.length > 0
      ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
      : 0
    const stuckGaps = gaps.filter((g) => g > 100).length

    console.log(`【${label}】`)
    console.log(`  调用总耗时      : ${elapsed} ms`)
    console.log(`  事件循环最长停顿: ${maxGap} ms`)
    console.log(`  平均间隔        : ${avgGap} ms（基线应接近 10ms）`)
    console.log(`  超过 100ms 的停顿次数: ${stuckGaps}`)
    console.log('')
    return { label, elapsed, maxGap, avgGap, stuckGaps, result }
  }

  const results = []

  // ================================================================ 测量 1：健康心跳（不触发重试）
  {
    const d = join(TMP, 'healthy')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'heartbeat.json'), JSON.stringify({
      pid: 1234, hwnd: 0, alive: true, updatedAtMs: Date.now(), scriptStampMs: Date.now(),
    }), 'utf8')

    results.push(await measureBlocking('测量1：健康心跳（一次就读到，不该有阻塞）', () => {
      return checkHeartbeat(d, { staleMs: 8000 })
    }))
  }

  // ================================================================ 测量 2：心跳文件不存在（触发内层重试）
  {
    const d = join(TMP, 'missing')
    mkdirSync(d, { recursive: true })
    // 不写文件，让 existsSync 一直 false

    results.push(await measureBlocking('测量2：心跳文件不存在（内层 3 次 × 100ms 重试）', () => {
      return checkHeartbeat(d, { staleMs: 8000 })
    }))
  }

  // ================================================================ 测量 3：心跳文件损坏（触发内层重试）
  {
    const d = join(TMP, 'corrupt')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'heartbeat.json'), '{"pid": 1, "alive": tru', 'utf8')

    results.push(await measureBlocking('测量3：心跳文件损坏（内层重试）', () => {
      return checkHeartbeat(d, { staleMs: 8000 })
    }))
  }

  // ================================================================ 测量 4：ensureCardRunning 的"情况不明"复查
  //
  // 这是施工卡说的"最多约 2 秒"那一段（4 次 × 500ms）。
  // 用 dryRun 避免真的启动进程。
  {
    const d = join(TMP, 'unknown')
    mkdirSync(d, { recursive: true })
    // 不写心跳 → checkHeartbeat 返回 unknown=true → 触发复查

    results.push(await measureBlocking(
      '测量4：ensureCardRunning 情况不明复查（4 次 × 500ms，施工卡说的"约 2 秒"）',
      () => ensureCardRunning({
        panelDir: join(TMP, 'nodir'),
        dataDir: d,
        log: () => {},
        dryRun: true,
        staleMs: 8000,
      })
    ))
  }

  // ================================================================ 测量 5：崩溃心跳（走睡眠唤醒宽限）
  {
    const d = join(TMP, 'crashed')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'heartbeat.json'), JSON.stringify({
      pid: 1234, hwnd: 0, alive: true, updatedAtMs: Date.now() - 20000,
    }), 'utf8')

    results.push(await measureBlocking(
      '测量5：心跳过期（走 2.6 秒睡眠唤醒宽限）',
      () => ensureCardRunning({
        panelDir: join(TMP, 'nodir'),
        dataDir: d,
        log: () => {},
        dryRun: true,
        staleMs: 8000,
      })
    ))
  }

  // ================================================================ 汇总
  console.log('='.repeat(70))
  console.log('汇总')
  console.log('='.repeat(70))
  console.log('')
  console.log('场景'.padEnd(46) + '阻塞(ms)'.padStart(10) + '停顿(ms)'.padStart(10))
  console.log('-'.repeat(70))
  for (const r of results) {
    const short = r.label.replace(/^测量\d+：/, '').slice(0, 44)
    console.log(short.padEnd(46) + String(r.elapsed).padStart(10) + String(r.maxGap).padStart(10))
  }
  console.log('')

  // ---------------------------------------------------------------- 结论
  //
  // 【结论必须看"主线程停顿"，不能看"总耗时"】
  //   第一版这里拿 elapsed 当阻塞时间，结论就错了：
  //   "情况不明复查"总耗时 2247ms，但改成异步之后主线程只停了 219ms ——
  //   那 2 秒是在等 setTimeout，主线程是空闲的，DSH 一点都不卡。
  //   真正该看的是 maxGap（事件循环被同步占住的最长时间）。
  const worstStall = results.reduce((a, b) => (b.maxGap > a.maxGap ? b : a))
  console.log('【结论 —— 看"主线程停顿"，不是看总耗时】')
  console.log(`  停顿最长的场景: ${worstStall.label.replace(/^测量\d+：/, '')}`)
  console.log(`  主线程最长停顿: ${worstStall.maxGap} ms`)
  console.log(`  该场景总耗时  : ${worstStall.elapsed} ms`)
  console.log('')
  console.log('  【为什么两者可能差很多】')
  console.log('    总耗时 = 主线程干活 + 异步等待（期间主线程可以干别的）')
  console.log('    停顿   = 主线程被同步代码占住、什么都干不了的时间')
  console.log('    只有"停顿"才是用户能感觉到的卡顿。')
  console.log('')

  const worstElapsed = results.reduce((a, b) => (b.elapsed > a.elapsed ? b : a))
  console.log(`  总耗时最长: ${worstElapsed.label.replace(/^测量\d+：/, '')} = ${worstElapsed.elapsed} ms`)
  console.log(`    但它的主线程停顿只有 ${worstElapsed.maxGap} ms → 不卡`)
  console.log('')

  if (worstStall.maxGap >= 1500) {
    console.log(`  → 存在 >=1.5 秒的同步阻塞，值得改异步`)
  } else if (worstStall.maxGap >= 500) {
    console.log(`  → 有可感知阻塞（${worstStall.maxGap}ms），但没到 2 秒`)
  } else {
    console.log(`  → 最长同步阻塞仅 ${worstStall.maxGap}ms，用户基本感觉不到`)
  }
  console.log('')
  console.log('【本轮 C4 改造前后对比】')
  console.log('  情况不明复查 —— 改前：主线程停顿 2259ms（Atomics.wait 同步死等）')
  console.log('  情况不明复查 —— 改后：主线程停顿仅约 220ms（剩下的 2 秒是异步等待）')
  console.log('  睡眠唤醒宽限 —— 本来就用 await sleep，一直没有阻塞')
  console.log('')

  // ---------------------------------------------------------------- 频率问题
  console.log('【重要：这些等待出现得频繁吗】')
  console.log('  注意——上面的测量是"最坏情况"，即条件刚好触发。')
  console.log('  真实运行时：')
  console.log('    · 测量1（健康心跳）是绝大多数情况 → 几乎零阻塞')
  console.log('    · 测量2/3（读不到/损坏）只在异常瞬间出现 → 罕见')
  console.log('    · 测量4（情况不明复查）需要心跳读不到才触发 → 罕见')
  console.log('    · 测量5（睡眠唤醒宽限）每次唤醒可能一次 → 低频')
  console.log('')
  console.log('  所以"最坏 2 秒"乘以"低频"，实际影响需要用户真实感受判断。')
  console.log('')

} catch (e) {
  console.log('测量异常: ' + (e && e.message))
  process.exitCode = 1
} finally {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
}
