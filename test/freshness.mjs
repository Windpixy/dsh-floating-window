/**
 * test/freshness.mjs -- 旧代码检测与自动重启的判断逻辑
 *
 * ---------------------------------------------------------------------------
 * 【这个测试守的是什么事故】
 * ---------------------------------------------------------------------------
 * 2026-10-29：`Panel.ps1` 改于 14:43:30，卡片进程起于 13:51:29。
 * 用户反馈"柱状图没有看到蓝色的闪动"，
 * 实际情况是**运行中的进程是 52 分钟前的旧代码，压根没有那段功能**。
 *
 * 旧代码本身完好 —— 没有报错、没有异常、日志一切正常。
 * 用户看到的现象和"新功能写错了"一模一样，排查成本极高。
 *
 * 根因：`.ps1` 是进程启动时一次性读进内存的，之后改文件不会重新加载；
 * 而卡片脱离 DSH 进程树，DSH 重启不会连带重启卡片。
 *
 * 【这里测的是判断逻辑，不是"能不能杀进程"】
 *   判断一旦出错，后果是"误杀一个正常的卡片"——用户的悬浮窗突然闪一下。
 *   所以判据必须能脱离进程环境单独测。
 *   真正的杀/拉由 index.js 调用，带节流和重试上限。
 *
 * 跑法：node test/freshness.mjs
 */

import { judgeCardStaleness, shouldRestartForUpdate, readPanelStampMs, STALE_TOLERANCE_MS }
  from '../lib/launcher.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, utimesSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

const group = (n) => console.log(`\n=== ${n} ===`)

// 固定一个基准时间戳，不用 Date.now()：测试必须可重复
const DISK = 1793258349692

console.log('='.repeat(60))
console.log('旧代码检测（v0.9.12）')
console.log('='.repeat(60))

// ================================================================ 1. 是不是旧代码
group('1. judgeCardStaleness：判断卡片跑的是不是旧代码')

{
  // ---- 核心场景：真实事故复现
  const r = judgeCardStaleness(
    { alive: true, pid: 10872, scriptStampMs: DISK - 52 * 60 * 1000 },
    { diskStampMs: DISK }
  )
  check('【真实事故】代码更新 52 分钟后，判为旧代码', r.stale === true, r.reason)
  check('  给出的落后毫秒数正确（52 分钟）',
    Math.abs(r.behindMs - 52 * 60 * 1000) < 1000, `实际 ${r.behindMs}`)
  check('  附带了人话说明（给日志用）',
    typeof r.detail === 'string' && r.detail.includes('旧代码'), r.detail)
}

{
  const r = judgeCardStaleness({ alive: true, pid: 1, scriptStampMs: DISK }, { diskStampMs: DISK })
  check('同一版代码 → 不是旧代码', r.stale === false && r.reason === 'up-to-date', r.reason)
}

{
  // ---- 容差：文件系统精度 / 读写时序差一点点不能算旧
  const r = judgeCardStaleness(
    { alive: true, pid: 1, scriptStampMs: DISK - 1000 },
    { diskStampMs: DISK }
  )
  check('落后 1 秒（在 2 秒容差内）→ 不算旧代码', r.stale === false, r.reason)
  check('  容差常量是 2000ms', STALE_TOLERANCE_MS === 2000, String(STALE_TOLERANCE_MS))
}

{
  const r = judgeCardStaleness(
    { alive: true, pid: 1, scriptStampMs: DISK - 3000 },
    { diskStampMs: DISK }
  )
  check('落后 3 秒（超出容差）→ 算旧代码', r.stale === true, r.reason)
}

{
  // ---- 关键分支：老版本卡片没有这个字段
  //
  //   【为什么这条最重要】
  //     升级到带此功能的新版之后，**当前正在跑的卡片仍是老版本**，
  //     心跳里没有 scriptStampMs。
  //     如果把它当成"陈旧"，会在升级瞬间误杀每个用户的卡片。
  const r = judgeCardStaleness({ alive: true, pid: 1 }, { diskStampMs: DISK })
  check('【关键】老版本卡片（心跳无 scriptStampMs）→ 不判旧代码（不误杀）',
    r.stale === false && r.reason === 'no-loaded-stamp', r.reason)
}

{
  const r = judgeCardStaleness({ alive: false }, { diskStampMs: DISK })
  check('卡片没在跑 → 不做旧代码判断（交给恢复逻辑）',
    r.stale === false && r.reason === 'card-not-running', r.reason)
}

{
  const r = judgeCardStaleness({ alive: true, pid: 1, scriptStampMs: DISK - 60000 }, { diskStampMs: 0 })
  check('磁盘时间读不到 → 不判断（宁可不动，也不凭猜杀进程）',
    r.stale === false && r.reason === 'no-disk-stamp', r.reason)
}

{
  // 时间戳是 NaN / 乱七八糟的字符串时也不能崩
  let threw = false
  let r = null
  try {
    r = judgeCardStaleness(
      { alive: true, pid: 1, scriptStampMs: 'not-a-number' },
      { diskStampMs: DISK }
    )
  } catch { threw = true }
  check('心跳里时间戳是垃圾值 → 不崩，判不陈旧',
    threw === false && r && r.stale === false, r ? r.reason : 'threw')
}

// ================================================================ 2. 该不该动手
group('2. shouldRestartForUpdate：现在该不该重启')

{
  const stale = { stale: true, reason: 'code-newer-than-process', behindMs: 60000, loadedStampMs: DISK - 60000 }
  const r = shouldRestartForUpdate(stale, {})
  check('旧代码 + 一切正常 → 应该重启', r.restart === true && r.reason === 'code-updated', r.reason)
}

{
  const r = shouldRestartForUpdate({ stale: false, reason: 'up-to-date' }, {})
  check('不是旧代码 → 不重启', r.restart === false && r.reason === 'not-stale', r.reason)
}

{
  // ---- 用户明确关了自动拉起，就绝不动他的卡片
  const stale = { stale: true, loadedStampMs: 1 }
  const r = shouldRestartForUpdate(stale, { autoLaunch: false })
  check('【安全】用户关了 autoLaunch → 即使旧代码也不重启',
    r.restart === false && r.reason === 'auto-launch-off', r.reason)
}

{
  const stale = { stale: true, loadedStampMs: 1 }
  const r = shouldRestartForUpdate(stale, { restarting: true })
  check('正在重启中 → 不重复触发', r.restart === false && r.reason === 'restarting-in-progress', r.reason)
}

{
  // ---- 防死循环：重启后还是旧代码（比如拉起失败）不能无限杀
  const stale = { stale: true, loadedStampMs: 1 }
  const r = shouldRestartForUpdate(stale, { restartCount: 2, maxRestart: 2 })
  check('【防死循环】已重启 2 次 → 放弃，只记日志',
    r.restart === false && r.reason === 'gave-up', r.reason)
  check('  放弃时给了手动处理指引',
    typeof r.log === 'string' && r.log.includes('run-panel.bat'), r.log)
}

{
  // ---- 同一个磁盘版本只重启一次
  const stale = { stale: true, loadedStampMs: 12345 }
  const r = shouldRestartForUpdate(stale, { lastRestartAt: 12345 })
  check('【去重】同一个旧版本已经重启过 → 不重复',
    r.restart === false && r.reason === 'already-restarted-for-this-build', r.reason)
}

{
  // 换了新版本（loadedStampMs 变了）→ 允许再试
  const stale = { stale: true, loadedStampMs: 99999 }
  const r = shouldRestartForUpdate(stale, { lastRestartAt: 12345 })
  check('换了另一个旧版本 → 允许重启（去重键按版本，不按次数）',
    r.restart === true, r.reason)
}

// ================================================================ 3. 读文件时间
group('3. readPanelStampMs：读磁盘上的代码时间')

{
  const tmp = join(tmpdir(), 'dsh-freshness-test')
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(tmp, { recursive: true })
  const f = join(tmp, 'Fake.ps1')
  writeFileSync(f, '# fake', 'utf8')

  const known = new Date('2026-10-29T06:43:30Z')   // 固定时间，可重复
  utimesSync(f, known, known)

  const got = readPanelStampMs(f)
  check('读到的 mtime 与设置的一致（误差 < 1 秒）',
    Math.abs(got - known.getTime()) < 1000, `${got} vs ${known.getTime()}`)

  const missing = readPanelStampMs(join(tmp, 'NotThere.ps1'))
  check('文件不存在 → 返回 0（不抛异常）', missing === 0, String(missing))

  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}

{
  // 真实文件：仓库里的 Panel.ps1 必须读得到
  const real = join(here, '..', 'panel', 'Panel.ps1')
  const stamp = readPanelStampMs(real)
  check('真实 panel/Panel.ps1 能读到时间戳（> 0）', stamp > 0, String(stamp))
}

// ================================================================ 4. 版本号一致性
group('4. 版本号必须是真的（本轮修的坑）')

{
  const pkg = JSON.parse(
    (await import('node:fs')).readFileSync(join(here, '..', 'package.json'), 'utf8')
  )
  // 【为什么这条要在这里】
  //   改这一批之前，package.json 的 version 停在 0.9.0，
  //   而代码里已经写到 v0.9.12 —— 十二轮改动一次都没同步。
  //   后果：任何"有没有新版本"的判断（npm / git / 插件市场）
  //   第一步就是比版本号，两边都是 0.9.0 → 永远"已是最新"。
  //   这条断言守的是"版本号不能再次冻结"。
  check('package.json 的 version 不是 0.9.0（已随代码推进）',
    pkg.version !== '0.9.0', `实际 ${pkg.version}`)
  check('version 是合法 semver 形式（x.y.z）',
    /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
}

// ================================================================ 汇总
console.log('\n' + '='.repeat(60))
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) {
  console.log('全部通过 ✅')
} else {
  process.exitCode = 1
}
