/**
 * test/staleness-chain.mjs -- C1：旧代码检测的「整条链路」测试
 *
 * ---------------------------------------------------------------------------
 * 【为什么不复用 freshness.mjs】
 * ---------------------------------------------------------------------------
 * `freshness.mjs` 测的是 judgeCardStaleness 的**判断逻辑**，
 * 但它传给函数的永远是**手工构造的理想对象**，例如：
 *
 *     judgeCardStaleness({ alive: true, pid: 1, scriptStampMs: DISK }, ...)
 *
 * 这种写法有个致命的盲区：它假设 checkHeartbeat 的返回值里**有** scriptStampMs。
 * 而实际上从 v0.9.12 到 v0.10.6，checkHeartbeat 一直没把这个字段传出来。
 * 于是：
 *
 *     单测：✅ 全绿（喂的是理想对象）
 *     线上：❌ 永远 no-loaded-stamp，自动更新从未工作过
 *
 * 这是本项目最贵的一类 bug —— **测试通过了，但测的不是真实链路**。
 *
 * ---------------------------------------------------------------------------
 * 【这个测试怎么堵住缝隙】
 * ---------------------------------------------------------------------------
 * 全程只碰真实文件，不手工构造中间对象：
 *
 *   1. 在临时目录里**写一份真的 heartbeat.json**（和 Panel.ps1 的格式一致）
 *   2. 在临时目录里**造一个真的 Panel.ps1**，用 utimes 把 mtime 设成指定值
 *   3. 调用**真实的** checkHeartbeat() 读它
 *   4. 把它的返回值**原样**交给 judgeCardStaleness()
 *   5. 断言最终结论
 *
 * 也就是说：和 index.js:648-657 走的是完全同一条路径。
 *
 * 跑法：node test/staleness-chain.mjs
 */

import { checkHeartbeat, judgeCardStaleness, shouldRestartForUpdate, readPanelStampMs }
  from '../lib/launcher.js'
import { join } from 'node:path'
import { writeFileSync, utimesSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

let failed = 0
let passed = 0
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

const now = Date.now()
const TMPROOT = join(tmpdir(), 'dsh-staleness-chain-' + now)
rmSync(TMPROOT, { recursive: true, force: true })
mkdirSync(TMPROOT, { recursive: true })

console.log('='.repeat(66))
console.log('C1 整链：真实 heartbeat.json → checkHeartbeat → judgeCardStaleness')
console.log('='.repeat(66))

/**
 * 造一个"真实场景"：数据目录里有 heartbeat.json，旁边有一个 Panel.ps1，
 * 它的 mtime 被设成 diskStampMs。
 *
 * @param {string} name 子目录名，每个用例一个，互不干扰
 * @param {object} hb 要写进 heartbeat.json 的对象
 * @param {number} diskStampMs 磁盘上 Panel.ps1 的修改时间
 * @returns {{dataDir: string, panelDir: string, panelFile: string}}
 */
function scenario(name, hb, diskStampMs) {
  const root = join(TMPROOT, name)
  const dataDir = join(root, 'data')
  const panelDir = join(root, 'panel')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(panelDir, { recursive: true })

  // 真的写一份心跳文件（格式与 Panel.ps1:162-179 保持一致）
  writeFileSync(join(dataDir, 'heartbeat.json'), JSON.stringify(hb), 'utf8')

  // 真的造一个 Panel.ps1，并把 mtime 精确设成 diskStampMs。
  // 【为什么要真的文件】readPanelStampMs() 读的是磁盘 mtime，
  //   用真实文件才能覆盖"读不到 mtime"以外的全部真实路径。
  const panelFile = join(panelDir, 'Panel.ps1')
  writeFileSync(panelFile, '# fake panel for test\n', 'utf8')
  const sec = diskStampMs / 1000
  utimesSync(panelFile, sec, sec)

  return { dataDir, panelDir, panelFile }
}

/**
 * 走完整条链：真实文件 → checkHeartbeat → judgeCardStaleness。
 * 这一段的顺序和 index.js:648-657 一模一样。
 */
function runChain(dataDir, panelFile, extra = {}) {
  const hb = checkHeartbeat(dataDir, extra)
  const diskStampMs = readPanelStampMs(panelFile)
  const staleness = judgeCardStaleness(hb, { diskStampMs })
  return { hb, diskStampMs, staleness }
}

// ================================================================ 1. 磁盘比进程新 → 判旧
console.log('\n=== 1. 核心场景：改完代码没重启卡片（真实事故的样子）===')

{
  const disk = now - 1000
  // 卡片加载的是 1109 分钟前（≈18.5 小时）的代码 —— 就是 2026-11-01 的真实数值
  const loaded = disk - 1109 * 60 * 1000
  const s = scenario('core-stale', {
    pid: 7644, hwnd: 198292, alive: true,
    dataDir: '',
    updatedAtMs: now - 1000,      // 心跳很新鲜（卡片活着）
    scriptStampMs: loaded,        // 但它加载的是旧代码
  }, disk)

  const r = runChain(s.dataDir, s.panelFile)

  check('真实心跳能读到（alive + ageMs 正常）', r.hb.alive === true && Number.isFinite(r.hb.ageMs),
    `alive=${r.hb.alive} ageMs=${r.hb.ageMs}`)
  check('readPanelStampMs 能读到磁盘 mtime', r.diskStampMs > 0, String(r.diskStampMs))
  check('【关键】checkHeartbeat 把 scriptStampMs 传出来了',
    r.hb.scriptStampMs === loaded,
    `期望 ${loaded}，实际 ${r.hb.scriptStampMs}（undefined 就是断链没修好）`)
  check('【整链】最终判为旧代码', r.staleness.stale === true, r.staleness.reason)
  check('  落后毫秒数正确（1109 分钟）',
    Math.abs(r.staleness.behindMs - 1109 * 60 * 1000) < 2000, String(r.staleness.behindMs))
  check('  给出人话说明', typeof r.staleness.detail === 'string' && r.staleness.detail.includes('旧代码'),
    r.staleness.detail)
}

// ================================================================ 2. 同版 → 不判旧
console.log('\n=== 2. 卡片跑的就是磁盘上这版 → 不能误杀 ===')

{
  const disk = now - 60000
  const s = scenario('core-same', {
    pid: 111, hwnd: 222, alive: true,
    updatedAtMs: now - 1000,
    scriptStampMs: disk,          // 完全一致
  }, disk)

  const r = runChain(s.dataDir, s.panelFile)
  check('同一版 → up-to-date', r.staleness.stale === false && r.staleness.reason === 'up-to-date',
    r.staleness.reason)
}

{
  // ---- 容差：文件系统精度导致的 1~2 秒差不能算旧
  const disk = now - 60000
  const s = scenario('core-tolerance', {
    pid: 1, alive: true, updatedAtMs: now - 1000,
    scriptStampMs: disk - 1500,   // 落后 1.5 秒，在 2 秒容差内
  }, disk)

  const r = runChain(s.dataDir, s.panelFile)
  check('落后 1.5 秒（容差内）→ 不算旧代码', r.staleness.stale === false, r.staleness.reason)
}

// ================================================================ 3. 老卡片 → 绝不误杀
console.log('\n=== 3. 老版本卡片（心跳没有 scriptStampMs）→ 不误杀 ===')

{
  const disk = now - 60000
  const s = scenario('core-legacy', {
    pid: 333, alive: true, updatedAtMs: now - 1000,
    // 刻意不给 scriptStampMs —— 模拟升级到新版时，正在跑的仍是老卡片
  }, disk)

  const r = runChain(s.dataDir, s.panelFile)
  check('checkHeartbeat 不伪造该字段', r.hb.scriptStampMs === undefined, String(r.hb.scriptStampMs))
  check('【安全】判为 no-loaded-stamp，不做旧代码重启',
    r.staleness.stale === false && r.staleness.reason === 'no-loaded-stamp', r.staleness.reason)
}

// ================================================================ 4. 磁盘时间读不到 → 不猜
console.log('\n=== 4. 磁盘 mtime 读不到 → 宁可不动，也不凭猜杀进程 ===')

{
  const s = scenario('core-nodisk', {
    pid: 444, alive: true, updatedAtMs: now - 1000, scriptStampMs: now - 999999,
  }, now - 60000)
  const hb = checkHeartbeat(s.dataDir)
  // 传一个不存在的路径，模拟"读不到磁盘时间"
  const diskStampMs = readPanelStampMs(join(TMPROOT, 'no-such-file.ps1'))
  const staleness = judgeCardStaleness(hb, { diskStampMs })

  check('读不到 mtime 时返回 0 或非正数', !(diskStampMs > 0), String(diskStampMs))
  check('不判断（no-disk-stamp）',
    staleness.stale === false && staleness.reason === 'no-disk-stamp', staleness.reason)
}

// ================================================================ 5. 卡片没在跑 → 交给恢复逻辑
console.log('\n=== 5. 卡片没在跑 → 不做旧代码判断 ===')

{
  const disk = now - 60000
  const s = scenario('core-dead', {
    pid: 555, alive: false, updatedAtMs: now - 1000, scriptStampMs: disk - 99999,
  }, disk)

  const r = runChain(s.dataDir, s.panelFile)
  check('心跳判为正常退出', r.hb.alive === false && r.hb.cleanExit === true, r.hb.reason)
  check('不做旧代码判断（card-not-running）',
    r.staleness.stale === false && r.staleness.reason === 'card-not-running', r.staleness.reason)
}

// ================================================================ 6. 判旧之后：策略层
console.log('\n=== 6. 判旧 + 策略：真的会去重启它吗 ===')

{
  const disk = now - 1000
  const loaded = disk - 3600 * 1000
  const s = scenario('policy-restart', {
    pid: 666, hwnd: 1, alive: true, updatedAtMs: now - 1000, scriptStampMs: loaded,
  }, disk)

  const { staleness } = runChain(s.dataDir, s.panelFile)
  const v1 = shouldRestartForUpdate(staleness, { autoLaunch: true })
  check('自动拉起开启 → 应该重启', v1.restart === true && v1.reason === 'code-updated', v1.reason)

  const v2 = shouldRestartForUpdate(staleness, { autoLaunch: false })
  check('【安全】自动拉起关闭 → 绝不重启', v2.restart === false && v2.reason === 'auto-launch-off', v2.reason)

  const v3 = shouldRestartForUpdate(staleness, { autoLaunch: true, restarting: true })
  check('正在重启中 → 不重复触发', v3.restart === false, v3.reason)

  const v4 = shouldRestartForUpdate(staleness, { autoLaunch: true, restartCount: 2, maxRestart: 2 })
  check('【防死循环】已达重启上限 → 放弃，不再杀', v4.restart === false && v4.reason === 'gave-up', v4.reason)
}

// ================================================================ 7. 心跳文件损坏
console.log('\n=== 7. 心跳文件坏掉 → 不能当成"有字段" ===')

{
  const root = join(TMPROOT, 'core-broken')
  const dataDir = join(root, 'data')
  const panelDir = join(root, 'panel')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(panelDir, { recursive: true })
  writeFileSync(join(dataDir, 'heartbeat.json'), '{"pid": 1, "alive": tru', 'utf8')
  const panelFile = join(panelDir, 'Panel.ps1')
  writeFileSync(panelFile, '# fake\n', 'utf8')
  utimesSync(panelFile, (now - 60000) / 1000, (now - 60000) / 1000)

  const hb = checkHeartbeat(dataDir, { readAttempts: 1 })
  const staleness = judgeCardStaleness(hb, { diskStampMs: readPanelStampMs(panelFile) })
  check('坏 JSON 判为情况不明', hb.unknown === true, hb.reason)
  check('不因此误判成旧代码', staleness.stale === false, staleness.reason)
}

// ================================================================ 收尾
rmSync(TMPROOT, { recursive: true, force: true })

console.log('')
console.log('='.repeat(66))
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) console.log('全部通过 ✅')
else process.exitCode = 1
console.log('='.repeat(66))
