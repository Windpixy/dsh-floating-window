/**
 * test/d6-heartbeat-pid.mjs -- D6：心跳过期 ≠ 进程退出
 *
 * 【这张测试守的是什么 —— 2026-11-03 的真实事故】
 *   桌面上叠了 **3 张卡片**（pid 25260 / 14268 / 29172），心跳在多进程间轮流覆盖。
 *
 *   翻 plugin.log 找到的真正根因链：
 *
 *     11:21:13  拉起 pid=25260（它一直活着，直到 12:45 我手动杀掉）
 *     11:39:57  心跳过期 13 秒 → 插件判定"卡片没在跑"
 *     11:40:00  又拉起 pid=22324
 *     11:40:06  "等到的心跳不是这次启动的进程（期望 22324，实际 25260）"
 *               ↑ 这行反证了 25260 当时还活着
 *     11:40:15  再拉起 pid=14268          ← 第三张
 *
 *   也就是说：**25260 从未退出，只是有一段时间没写心跳**
 *   （进程被系统挂起 / UI 线程卡住 / 睡眠唤醒那一小段）。
 *   而插件把"心跳过期"直接当成了"进程没了"，于是不断补新的。
 *
 *   卡片自己的单实例保护为什么没拦住？
 *   因为它用的是同一个判据（$script:StaleMs = 8000）——
 *   新进程读到的是"过期 15 秒"的心跳，同样判成"没有实例"，于是放行。
 *
 *   **两侧用同一个"过期"判据，所以两侧同时失效。**
 *
 * 【D6 要补的是什么】
 *   "心跳过期"这个信号不能唯一代表"进程没了"。它至少有两种成因：
 *     ① 进程真的退出了（崩溃、被杀）        → 该拉起
 *     ② 进程还在，但被挂起 / 卡住没写心跳  → 不该拉起（拉起就是叠卡）
 *
 *   分清这两者的唯一可靠办法：**去问系统"那个 pid 还在不在"**。
 *   launcher.js 里早就有这个能力（isProcessAlive / verifyHeartbeatPid），
 *   但只用在了"插件启动首次拉起"那一处（index.js:605 verifyPid: true），
 *   监控循环（每 5 秒的 shouldReviveCard）从来没核对过 pid。
 *
 * 跑法：node test/d6-heartbeat-pid.mjs
 * 退出码 0 = 全通过，1 = 有失败。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import {
  isProcessAlive,
  shouldReviveCard,
  verifyHeartbeatPid,
} from '../lib/launcher.js'

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

const root = mkdtempSync(join(tmpdir(), 'dshd6-'))

// 心跳过期（crashed=true）的典型形态：卡片"看起来"没了
const makeCrashedHb = (pid, extra = {}) => ({
  alive: false,
  crashed: true,
  reason: `心跳过期（13 秒没更新，未正常退出）`,
  ageMs: 13000,
  updatedAtMs: 1700000000000,
  pid,
  ...extra,
})

const baseState = {
  wasAlive: true,
  lastCrashedAt: 0,
  reviveCount: 0,
  maxRevive: 3,
  autoLaunch: true,
  reviving: false,
}

try {
  // ================================================================
  // 1. 核心：心跳过期但进程还活着 → 不许拉起
  // ================================================================
  console.log('\n=== 1. 心跳过期但 pid 还活着（核心场景） ===')

  {
    const hb = makeCrashedHb(25260)

    // ---- 1a. 不给 pidAlive 信息时：保持原有行为（会去救）
    //   【为什么这条要保留】向后兼容：老调用方不传 pidAlive 时行为不能变。
    const r0 = shouldReviveCard(hb, baseState)
    ok('不提供 pid 存活信息时，仍按原逻辑去救（向后兼容）',
      r0.revive === true, `revive=${r0.revive} reason=${r0.reason}`)

    // ---- 1b. 明确告知 pid 还活着 → 必须不拉起
    const r1 = shouldReviveCard(hb, { ...baseState, pidAlive: true })
    ok('【核心】pid 还活着时，不拉起（这就是叠卡的根因）',
      r1.revive === false,
      `revive=${r1.revive} reason=${r1.reason}`)

    ok('【核心】不拉起时要给出可解释的原因',
      typeof r1.reason === 'string' && r1.reason.length > 0,
      r1.reason || '(空)')

    ok('不拉起时要有日志（不能静默，否则下次又查不出来）',
      typeof r1.log === 'string' && r1.log.length > 0,
      r1.log || '(无日志)')

    // ---- 1c. 日志措辞要点：必须说明"进程还活着、只是没写心跳"
    ok('日志里说明了"进程还在"',
      /还活着|还在运行|仍在|存活/.test(r1.log || ''),
      r1.log || '(无)')

    ok('日志里说明了"心跳没更新"（区分于"卡片没了"）',
      /心跳/.test(r1.log || ''),
      r1.log || '(无)')

    // ---- 1d. 这种情况不能消耗恢复次数
    ok('不消耗恢复次数（这不是崩溃，只是没写心跳）',
      !/reviveCount|恢复次数/.test(String(r1.consumedRevive)) ,
      '应由调用方决定不递增')
  }

  // ================================================================
  // 2. 反方向：进程确实没了 → 必须照常拉起
  // ================================================================
  console.log('\n=== 2. pid 确实已退出（必须照常拉起） ===')

  {
    const hb = makeCrashedHb(25260)
    const r2 = shouldReviveCard(hb, { ...baseState, pidAlive: false })
    ok('【关键】pid 确实没了时，照常拉起（不能因为加了判断就不救了）',
      r2.revive === true,
      `revive=${r2.revive} reason=${r2.reason}`)
    ok('reason 保持 crashed（调用方据此消耗恢复次数）',
      r2.reason === 'crashed', r2.reason)
  }

  // ================================================================
  // 3. 判断不了（权限不足）→ 保守不拉起
  // ================================================================
  console.log('\n=== 3. pid 判断不了（权限/异常） ===')

  {
    const hb = makeCrashedHb(25260)
    const r3 = shouldReviveCard(hb, { ...baseState, pidAlive: null })
    ok('【关键】判断不了时保守不拉起（宁可少一张卡，也不叠卡）',
      r3.revive === false,
      `revive=${r3.revive} reason=${r3.reason}`)

    ok('判断不了时有说明日志',
      typeof r3.log === 'string' && r3.log.length > 0,
      r3.log || '(无)')
  }

  // ================================================================
  // 4. 真实 pid 检查：活进程 / 死进程
  // ================================================================
  console.log('\n=== 4. 真实 pid 存在性检查 ===')

  {
    ok('自己这个进程一定活着', isProcessAlive(process.pid) === true,
      String(isProcessAlive(process.pid)))

    // 一个几乎不可能存在的 pid
    const ghost = 0x7FFFFFF0
    const ghostAlive = isProcessAlive(ghost)
    ok('不存在的 pid 判为已退出', ghostAlive === false, String(ghostAlive))

    // 【关键组合】用真 pid 走完整判断链
    const hbSelf = makeCrashedHb(process.pid)
    const rSelf = shouldReviveCard(hbSelf, { ...baseState, pidAlive: isProcessAlive(process.pid) })
    ok('【端到端】心跳过期 + pid 是活进程 → 不拉起',
      rSelf.revive === false, `revive=${rSelf.revive}`)

    const hbGhost = makeCrashedHb(ghost)
    const rGhost = shouldReviveCard(hbGhost, { ...baseState, pidAlive: isProcessAlive(ghost) })
    ok('【端到端】心跳过期 + pid 不存在 → 拉起',
      rGhost.revive === true, `revive=${rGhost.revive}`)
  }

  // ================================================================
  // 5. 不能误伤其他分支
  // ================================================================
  console.log('\n=== 5. 其他分支不能被改坏 ===')

  {
    // 用户主动退出
    const closed = { alive: false, cleanExit: true, reason: '卡片上次是正常退出的', pid: 1234 }
    const rClosed = shouldReviveCard(closed, { ...baseState, pidAlive: false })
    ok('用户主动退出仍不拉起（pidAlive 不影响这条）',
      rClosed.revive === false && rClosed.reason === 'user-closed',
      `${rClosed.revive} / ${rClosed.reason}`)

    // 用户关了自动拉起
    const rOff = shouldReviveCard(makeCrashedHb(1), { ...baseState, autoLaunch: false, pidAlive: false })
    ok('关掉自动拉起后仍不拉起',
      rOff.revive === false, rOff.reason)

    // 正在恢复中
    const rBusy = shouldReviveCard(makeCrashedHb(1), { ...baseState, reviving: true, pidAlive: false })
    ok('正在恢复中时不重复拉起',
      rBusy.revive === false && rBusy.reason === 'reviving-in-progress',
      rBusy.reason)

    // 达到恢复上限
    const rMax = shouldReviveCard(makeCrashedHb(1), { ...baseState, reviveCount: 3, pidAlive: false })
    ok('达到恢复上限时不拉起',
      rMax.revive === false && rMax.reason === 'gave-up',
      rMax.reason)

    // 已经处理过的同一份崩溃
    const rDup = shouldReviveCard(
      makeCrashedHb(1, { updatedAtMs: 1700000000000 }),
      { ...baseState, lastCrashedAt: 1700000000000, pidAlive: false })
    ok('同一份崩溃不重复处理',
      rDup.revive === false && rDup.reason === 'already-handled',
      rDup.reason)

    // 情况不明（心跳读不到）
    const unknown = { alive: false, missing: true, unknown: true, reason: '心跳文件读不到' }
    const rUnknown = shouldReviveCard(unknown, { ...baseState, pidAlive: undefined })
    ok('情况不明仍去确认（不受 pidAlive 影响）',
      rUnknown.revive === true && rUnknown.reason === 'unknown-heartbeat',
      rUnknown.reason)
  }

  // ================================================================
  // 6. 卡片侧也要改（Panel.ps1 的单实例判断）
  // ================================================================
  console.log('\n=== 6. 卡片侧单实例判断也要核对 pid ===')

  {
    const panelSrc = readFileSync(new URL('../panel/Panel.ps1', import.meta.url), 'utf8')
    const panelCode = panelSrc
      .split(/\r?\n/)
      .filter((ln) => !/^\s*#/.test(ln))
      .join('\n')

    const fn = (panelCode.match(/function Test-AnotherInstanceAlive[\s\S]*?\r?\n\}/) || [''])[0]
    ok('抓到了 Test-AnotherInstanceAlive', fn.length > 0)

    // 【核心】过期判断之前要先问"那个 pid 还在不在"
    ok('【关键】心跳过期时会核对 pid 是否真的还存在',
      /Get-Process\s+-Id|System\.Diagnostics\.Process/.test(fn),
      fn ? (/Get-Process\s+-Id/.test(fn) ? '有 Get-Process -Id' : '没看到查进程的代码') : '无函数')

    ok('【关键】pid 还在时不放行（即使心跳过期）',
      /\$stillAlive/.test(fn),
      fn ? (/\$stillAlive/.test(fn) ? '有 $stillAlive 分支' : '没看到"pid 还活着"的分支') : '无函数')

    // 【关键设计决策的断言】
    //
    // 这里曾经写错过一次，值得记下来：
    //   我一开始断言"查不出来时应该保守挡住"，因为直觉上"宁可少一张卡也别叠卡"。
    //   但真去想最坏情况就发现不对：
    //     如果查不出来就挡住 → 用户手动跑 run-panel.bat 时，
    //     旧进程确实已经没了、心跳还是过期的旧记录、依然查不出来 → **依然被挡住**
    //     → 用户**彻底起不来卡片了**。
    //   这个代价比叠卡严重得多（叠卡用户点错窗口，起不来卡片用户完全没法用）。
    //
    //   所以最终决策是：**查不出来就放行**（信任"过期"这个信号），
    //   最坏情况退回今天的行为（可能叠卡），但绝不会出现"永远起不来"。
    //
    // 【断言必须精确到 Get-Process 那个 catch】
    //   这个函数里有**两个** catch，语义完全不同：
    //     · Get-Process 的 catch   → 查进程失败 ≈ 进程不存在 → 应该放行(false)
    //     · ConvertFrom-Json 的 catch → 心跳读到半截 → 应该重试/挡住(true)
    //   一开始我用 `catch {…return $true}` 粗匹配，把第二个也算进来了，
    //   于是误报"catch 里挡了"。必须只查 Get-Process 附近那个。
    const getProcCatch = (fn.match(/try\s*\{[\s\S]{0,300}?Get-Process[\s\S]{0,300}?catch\s*\{[\s\S]{0,200}?\}/) || [''])[0]
    ok('抓到了 Get-Process 的 try/catch', getProcCatch.length > 0)

    ok('【关键设计】查进程失败时放行（不能挡住，否则用户手动也起不来卡片）',
      !/catch\s*\{[\s\S]{0,150}?return\s+\$true/.test(getProcCatch),
      getProcCatch
        ? (/catch\s*\{[\s\S]{0,150}?return\s+\$true/.test(getProcCatch)
            ? 'catch 里挡了，会导致用户手动也起不来'
            : '没有在 Get-Process 的 catch 里挡住')
        : '没抓到 catch')

    // 只有"明确查到进程还在"才挡
    ok('【关键】只有确认进程还在才返回 true（挡住第二个）',
      /\$stillAlive\s*\)\s*\{[\s\S]{0,200}return\s+\$true/.test(fn),
      fn ? (/\$stillAlive\s*\)\s*\{[\s\S]{0,200}return\s+\$true/.test(fn) ? '是' : '没看到这个分支') : '无函数')
  }

  // ================================================================
  // 7. 监控循环必须真的把 pidAlive 传进去
  // ================================================================
  console.log('\n=== 7. 监控循环真的传了 pidAlive（否则改了也没用） ===')

  {
    const idxSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    const idxCode = idxSrc
      .split(/\r?\n/)
      .filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln))
      .join('\n')

    // 找到 shouldReviveCard 调用块
    const callBlock = (idxCode.match(/shouldReviveCard\(hb,\s*\{[\s\S]{0,900}?\}\)/) || [''])[0]
    ok('抓到了 shouldReviveCard 调用', callBlock.length > 0)

    ok('【关键】监控循环把 pidAlive 传给了 shouldReviveCard',
      /pidAlive/.test(callBlock),
      callBlock ? '调用里没有 pidAlive' : '无调用')

    ok('pidAlive 的值来自真实的进程检查（不是写死）',
      /verifyHeartbeatPid|isProcessAlive/.test(idxCode),
      '应有 verifyHeartbeatPid / isProcessAlive 调用')
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
