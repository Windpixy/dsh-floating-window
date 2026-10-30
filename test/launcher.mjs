/**
 * test/launcher.mjs -- 拉起逻辑单测
 *
 * 重点是 checkHeartbeat："卡片到底在不在跑"这个判断。
 * 判断错了有两种后果，都很难受：
 *   说在跑其实没跑 -> 卡片永远不出来
 *   说没跑其实在跑 -> 起一个进程然后它自己退出（还好，有 Mutex 兜底）
 *
 * 跑法：node test/launcher.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkHeartbeat, panelScriptPath, launchCard, ensureCardRunning, shouldReviveCard } from '../lib/launcher.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const group = (n) => tests.push({ isGroup: true, name: n })

const TMP = join(tmpdir(), 'dsh-card-launcher-test')
function freshDir() {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(TMP, { recursive: true })
  return TMP
}
function writeHb(dir, obj) {
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify(obj), 'utf8')
}

const NOW = new Date('2026-10-27T22:00:00+08:00').getTime()

// ================================================================ 心跳判断
group('心跳判断：卡片到底在不在跑')

test('没有心跳文件 -> 没在跑', () => {
  const d = freshDir()
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.match(r.reason, /不存在/)
})

test('心跳新鲜 -> 在跑', () => {
  const d = freshDir()
  writeHb(d, { pid: 1234, hwnd: 99, alive: true, updatedAtMs: NOW - 1000 })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, true)
  assert.equal(r.pid, 1234)
  assert.equal(r.hwnd, 99)
  assert.equal(r.ageMs, 1000)
})

test('心跳过期 -> 没在跑', () => {
  const d = freshDir()
  writeHb(d, { pid: 1234, alive: true, updatedAtMs: NOW - 20000 })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.match(r.reason, /过期/)
})

// ---------------------------------------------------------------- 崩溃识别
//
// 【为什么必须有这一组】
//   v0.5.1 的事故：点一下卡片 -> 激活 DSH 成功 -> 700ms 后恢复置顶的定时器
//   抛出空引用异常 -> 整个 WPF 应用退出 -> 卡片凭空消失，等多久都不回来。
//
//   旧逻辑把所有"没心跳"一视同仁，插件的结论只是"卡片已退出，不重开"。
//   但"用户主动关掉"和"崩掉了"完全是两件事：
//     主动关掉 -> 卡片会把 alive 写成 false，用户不想要了，不该重开
//     崩掉了   -> alive 还是 true，只是时间戳停了，用户什么都没做，应当救回来
//   所以 checkHeartbeat 必须把这两者区分开，crashed 字段就是那个信号。
group('崩溃识别：区分「用户关掉」和「崩掉了」')

test('正常情况下 crashed 不应为真', () => {
  const d = freshDir()
  writeHb(d, { pid: 1234, alive: true, updatedAtMs: NOW - 1000 })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, true)
  assert.ok(!r.crashed, '活着的时候不能说它崩了')
})

test('用户主动退出（alive=false）-> 不算崩溃', () => {
  const d = freshDir()
  writeHb(d, { pid: 1234, alive: false, updatedAtMs: NOW - 100 })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.ok(!r.crashed, '主动退出绝不能当成崩溃，否则会违背用户意愿重开')
})

test('心跳过期但 alive=true -> 判定为崩溃', () => {
  const d = freshDir()
  // 这正是事故现场的样子：alive 仍是 true，时间戳停在崩溃那一刻
  writeHb(d, { pid: 12636, hwnd: 1509676, alive: true, updatedAtMs: NOW - 30000 })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.equal(r.crashed, true, '过期且 alive=true 就是崩溃')
  assert.match(r.reason, /未正常退出/)
})

test('崩溃时要把时间戳带出来（用来去重，避免反复重开）', () => {
  const d = freshDir()
  const stamp = NOW - 30000
  writeHb(d, { pid: 1, alive: true, updatedAtMs: stamp })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.crashed, true)
  assert.equal(r.updatedAtMs, stamp)
})

test('从来没启动过 -> 不算崩溃（没东西可崩）', () => {
  const d = freshDir()
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.ok(!r.crashed)
})

test('心跳文件坏掉 -> 不算崩溃（宁可不动）', () => {
  const d = freshDir()
  writeFileSync(join(d, 'heartbeat.json'), '{ 坏', 'utf8')
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.ok(!r.crashed)
})

test('alive=false -> 没在跑（卡片正常退出了）', () => {
  const d = freshDir()
  writeHb(d, { pid: 1234, alive: false, updatedAtMs: NOW - 100 })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.match(r.reason, /正常退出/)
})

test('刚好卡在阈值上 -> 算过期（宁可多起一个）', () => {
  const d = freshDir()
  writeHb(d, { pid: 1, alive: true, updatedAtMs: NOW - 8000 })
  const r = checkHeartbeat(d, { now: () => NOW, staleMs: 8000 })
  assert.equal(r.alive, false)
})

test('心跳文件是坏 JSON -> 当作没在跑，不抛错', () => {
  const d = freshDir()
  writeFileSync(join(d, 'heartbeat.json'), '{ 这不是 json', 'utf8')
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.equal(typeof r.reason, 'string')
})

test('心跳时间戳在未来 -> 保守当作没在跑', () => {
  const d = freshDir()
  writeHb(d, { pid: 1, alive: true, updatedAtMs: NOW + 60000 })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
  assert.match(r.reason, /未来/)
})

test('缺时间戳 -> 没在跑', () => {
  const d = freshDir()
  writeHb(d, { pid: 1, alive: true })
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
})

test('空对象 -> 没在跑', () => {
  const d = freshDir()
  writeHb(d, {})
  const r = checkHeartbeat(d, { now: () => NOW })
  assert.equal(r.alive, false)
})

test('目录不存在也不抛错', () => {
  const r = checkHeartbeat(join(tmpdir(), 'no-such-dir-' + Date.now()), { now: () => NOW })
  assert.equal(r.alive, false)
})

// ================================================================ 路径
group('卡片程序路径')

test('panelScriptPath 拼出 Panel.ps1', () => {
  const p = panelScriptPath('C:\\some where\\panel')
  assert.ok(p.endsWith('Panel.ps1'))
  assert.ok(p.includes('panel'))
})

// ================================================================ 启动判断
group('启动判断')

test('脚本不存在 -> 不启动，但说清原因', () => {
  const d = freshDir()
  const logs = []
  const r = launchCard({
    panelDir: join(TMP, 'no-such-panel'),
    dataDir: d,
    log: (m) => logs.push(m),
  })
  assert.equal(r.launched, false)
  assert.match(r.reason, /找不到/)
  assert.ok(logs.length > 0)
})

test('dryRun 不真的启动', () => {
  const d = freshDir()
  const pd = join(d, 'panel')
  mkdirSync(pd, { recursive: true })
  writeFileSync(join(pd, 'Panel.ps1'), '# fake', 'utf8')

  const r = launchCard({ panelDir: pd, dataDir: d, log: () => {}, dryRun: true })
  assert.equal(r.launched, false)
  assert.equal(r.dryRun, true)
})

test('launchCard 会带上启动策略标记', () => {
  const d = freshDir()
  const pd = join(d, 'panel')
  mkdirSync(pd, { recursive: true })
  writeFileSync(join(pd, 'Panel.ps1'), '# fake', 'utf8')

  const a = launchCard({ panelDir: pd, dataDir: d, log: () => {}, dryRun: true, mode: 'detached' })
  const b = launchCard({ panelDir: pd, dataDir: d, log: () => {}, dryRun: true, mode: 'attached' })
  assert.equal(a.mode, 'detached')
  assert.equal(b.mode, 'attached')
})

test('已经有心跳 -> ensureCardRunning 不重复启动', async () => {
  const d = freshDir()
  writeHb(d, { pid: 999, alive: true, updatedAtMs: Date.now() })
  const logs = []
  const r = await ensureCardRunning({
    panelDir: join(TMP, 'whatever'),
    dataDir: d,
    log: (m) => logs.push(m),
  })
  assert.equal(r.launched, false)
  assert.equal(r.reason, 'already-running')
  assert.equal(r.ok, true)
  assert.ok(logs.some(m => m.includes('已在运行')))
})

test('没心跳时 ensureCardRunning 会尝试启动（dryRun 验证意图）', async () => {
  const d = freshDir()
  const pd = join(d, 'panel')
  mkdirSync(pd, { recursive: true })
  writeFileSync(join(pd, 'Panel.ps1'), '# fake', 'utf8')

  const r = await ensureCardRunning({
    panelDir: pd,
    dataDir: d,
    log: () => {},
    dryRun: true,
  })
  assert.equal(r.ok, true, 'dryRun 下应视为成功')
  assert.equal(r.launched, false, 'dryRun 不真的启动')
})

// ================================================================ 自动恢复判断
//
// 【为什么把这套判断抽成 shouldReviveCard 单独测】
//   v0.5.1 的崩溃事故里，"卡片崩了"和"用户关掉"被当成一回事，
//   结果卡片消失后永远不回来。修复要处理三种情况互相纠缠：
//     用户主动关 -> 不能重开（违背意愿）
//     崩了       -> 必须重开（用户什么都没做）
//     开机残留的旧心跳 -> 不能算新崩溃（否则会和 autoLaunch 重复启两次）
//   这种判断写在 setInterval 回调里没法单独验证，只能靠人工复现故障 ——
//   而人工复现恰恰是最不可靠的环节。
group('自动恢复判断：什么时候该把卡片救回来')

const HB = (o) => ({ alive: false, crashed: false, updatedAtMs: 1000, reason: 'x', ...o })
const ST = (o) => ({ wasAlive: true, lastCrashedAt: 0, reviveCount: 0, autoLaunch: true, reviving: false, ...o })

test('用户主动关掉 -> 不重开（尊重用户意愿）', () => {
  const v = shouldReviveCard(HB({ alive: false, crashed: false }), ST({ wasAlive: true }))
  assert.equal(v.revive, false)
  assert.equal(v.reason, 'user-closed')
  assert.match(v.log, /不会自动重开/)
})

test('崩掉了 -> 必须自动重开', () => {
  const v = shouldReviveCard(HB({ crashed: true, updatedAtMs: 5000 }), ST({}))
  assert.equal(v.revive, true, '崩溃后不重开，用户就永远看不到卡片了')
  assert.equal(v.reason, 'crashed')
  assert.equal(v.stamp, 5000)
  assert.match(v.log, /异常退出/)
})

test('同一个崩溃只处理一次（5 秒一轮，不能每轮都启一次）', () => {
  const v = shouldReviveCard(HB({ crashed: true, updatedAtMs: 5000 }), ST({ lastCrashedAt: 5000 }))
  assert.equal(v.revive, false)
  assert.equal(v.reason, 'already-handled')
})

test('新的崩溃（时间戳更晚）要处理', () => {
  const v = shouldReviveCard(HB({ crashed: true, updatedAtMs: 9000 }), ST({ lastCrashedAt: 5000 }))
  assert.equal(v.revive, true)
})

test('正在恢复中 -> 不叠加第二次', () => {
  const v = shouldReviveCard(HB({ crashed: true, updatedAtMs: 9000 }), ST({ reviving: true }))
  assert.equal(v.revive, false)
  assert.equal(v.reason, 'reviving-in-progress')
})

test('连续崩到上限 -> 停手并说清怎么办', () => {
  const v = shouldReviveCard(HB({ crashed: true, updatedAtMs: 9000 }), ST({ reviveCount: 3, maxRevive: 3 }))
  assert.equal(v.revive, false)
  assert.equal(v.reason, 'gave-up')
  assert.match(v.log, /run-panel\.bat/)
})

test('用户关了自动拉起 -> 即使崩了也不动', () => {
  const v = shouldReviveCard(HB({ crashed: true, updatedAtMs: 9000 }), ST({ autoLaunch: false }))
  assert.equal(v.revive, false)
})

test('卡片活着 -> 什么都不做', () => {
  const v = shouldReviveCard({ alive: true, reason: '心跳正常' }, ST({}))
  assert.equal(v.revive, false)
  assert.equal(v.reason, 'nothing-to-do')
})

test('开机残留的旧心跳不当成新崩溃（否则和 autoLaunch 重复启两次）', () => {
  // 插件刚起时 lastCrashedAt = Date.now()，旧心跳的时间戳必然更早
  const pluginStart = 1793152423769
  const oldHb = HB({ crashed: true, updatedAtMs: pluginStart - 60000 })
  const v = shouldReviveCard(oldHb, ST({ wasAlive: false, lastCrashedAt: pluginStart }))
  assert.equal(v.revive, false, '这是上一次运行留下的，autoLaunch 已经处理过了')
})

test('恢复失败后必须能重试（failedToRevive 会清掉去重标记）', () => {
  // 场景：崩溃时间戳 5000，第一轮尝试恢复但失败了。
  // 失败时 index.js 把 lastCrashedAt 退回 0，所以下一轮同一个崩溃还要能再试。
  // 如果忘了退回，卡片就真的永远回不来了 —— 和没修一样。
  const hb = HB({ crashed: true, updatedAtMs: 5000 })
  const firstTry = shouldReviveCard(hb, ST({ lastCrashedAt: 0 }))
  assert.equal(firstTry.revive, true, '第一轮应该尝试')

  // 失败后 lastCrashedAt 被退回 0，而不是被设成 5000
  const secondTry = shouldReviveCard(hb, ST({ lastCrashedAt: 0 }))
  assert.equal(secondTry.revive, true, '失败后同一个崩溃必须还能再试一次')

  // 对照：成功的话 lastCrashedAt 就是 5000，下一轮不再重复
  const afterSuccess = shouldReviveCard(hb, ST({ lastCrashedAt: 5000 }))
  assert.equal(afterSuccess.revive, false, '成功恢复后不应再重复拉起')
})

// ================================================================ 执行
let passed = 0
let failed = 0
const failures = []

for (const t of tests) {
  if (t.isGroup) {
    process.stdout.write(`\n${t.name}\n`)
    continue
  }
  try {
    await t.fn()
    passed++
    process.stdout.write(`  ✅ ${t.name}\n`)
  } catch (e) {
    failed++
    failures.push({ name: t.name, error: e })
    process.stdout.write(`  ❌ ${t.name}\n     ${e && e.message}\n`)
  }
}

try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

process.stdout.write(`\n${'='.repeat(50)}\n通过 ${passed}   失败 ${failed}\n`)
if (failed > 0) {
  process.stdout.write('\n失败详情：\n')
  for (const f of failures) process.stdout.write(`\n  ${f.name}\n  ${f.error && f.error.stack}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('全部通过 ✅\n')
}
