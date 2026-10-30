/**
 * test/tokens.mjs -- Token 账本单测
 *
 * 重点验证「不能重复计算」这条规则。
 * 这是 M2 最容易出错的地方：回填和实时事件会撞车。
 *
 * 跑法：node test/tokens.mjs
 */

import assert from 'node:assert/strict'
import { TokenTracker, startOfToday } from '../lib/tokens.js'
import { usageAmount } from '../lib/sources.js'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    process.stdout.write(`  ✅ ${name}\n`)
  } catch (e) {
    failed++
    failures.push({ name, error: e })
    process.stdout.write(`  ❌ ${name}\n     ${e && e.message}\n`)
  }
}
function group(n) { process.stdout.write(`\n${n}\n`) }

const DAY = new Date('2026-10-27T10:00:00+08:00').getTime()
const mk = (opts = {}) => new TokenTracker({ dayStartMs: startOfToday(DAY), now: () => DAY, ...opts })

// ================================================================ usage 口径
group('usage 金额口径（已用真实数据校准到和官方账本 0 误差）')

test('用 input + cacheRead + output（三项之和）', () => {
  // 这条是实测校准出来的，见 sources.js usageAmount 的注释。
  // 只算 input+output 会差 45 倍，因为长对话的上下文全走 cacheRead。
  const u = { inputTokens: 1000, outputTokens: 200, totalTokens: 5000, cacheReadTokens: 3800 }
  assert.equal(usageAmount(u), 5000, '1000 + 3800 + 200')
})

test('缺字段按 0 算', () => {
  assert.equal(usageAmount({ inputTokens: 100 }), 100)
  assert.equal(usageAmount({ outputTokens: 50 }), 50)
  assert.equal(usageAmount({ cacheReadTokens: 70 }), 70)
  assert.equal(usageAmount({}), 0)
  assert.equal(usageAmount(null), 0)
  assert.equal(usageAmount(undefined), 0)
})

test('脏值不让它变 NaN', () => {
  assert.equal(usageAmount({ inputTokens: 'abc', outputTokens: 10 }), 10)
  assert.equal(usageAmount({ inputTokens: NaN, outputTokens: 10 }), 10)
})

// ================================================================ 基本累加
group('基本累加')

test('实时累加', () => {
  const t = mk()
  t.addLive('s1', 10, 1000)
  t.addLive('s1', 11, 500)
  assert.equal(t.total(), 1500)
})

test('非正数和脏值忽略', () => {
  const t = mk()
  t.addLive('s1', 1, 0)
  t.addLive('s1', 2, -100)
  t.addLive('s1', 3, NaN)
  t.addLive('s1', 4, 'abc')
  assert.equal(t.total(), 0)
})

test('小数会四舍五入', () => {
  const t = mk()
  t.addLive('s1', 1, 100.6)
  assert.equal(t.total(), 101)
})

// ================================================================ 去重（核心）
group('去重：回填与实时不能撞车')

test('回填后，水位线以内的实时事件被丢弃', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)   // 回填：这个会话读到第 100 条，共 5000 token
  t.endBackfill()
  assert.equal(t.total(), 5000)

  // 实时来一条 seq=50 的（回填已覆盖）→ 不能再算
  const counted = t.addLive('s1', 50, 800)
  assert.equal(counted, false, 'seq 小于水位线，必须跳过')
  assert.equal(t.total(), 5000, '总数不能变')
})

test('回填后，水位线之后的实时事件要算', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)
  t.endBackfill()

  const counted = t.addLive('s1', 101, 800)   // 新事件
  assert.equal(counted, true)
  assert.equal(t.total(), 5800)
})

test('回填期间来的事件先缓冲，结束时按水位线筛', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)
  // 回填过程中实时事件到了
  t.addLive('s1', 50, 999)    // 会被水位线挡掉
  t.addLive('s1', 120, 300)   // 新的，要算
  assert.equal(t.total(), 5000, '缓冲期间不加')
  const r = t.endBackfill()
  assert.equal(r.skipped, 1)
  assert.equal(r.counted, 1)
  assert.equal(t.total(), 5300)
})

test('回填期间新增的会话（水位线外）正常计入', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)
  t.addLive('brand-new', 5, 700)   // 回填时没这个会话
  t.endBackfill()
  assert.equal(t.total(), 5700)
})

test('同一会话重复回填只取最大水位线，金额不重复加', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 1000)
  t.addBackfill('s1', 50, 1000)    // 水位线更小，不应该降级
  t.endBackfill()
  assert.equal(t.total(), 2000, '金额是累加的（两次回填是不同数据），但水位线取最大的 100')
  // 验证水位线确实是 100 而不是 50
  assert.equal(t.addLive('s1', 80, 10), false, 'seq=80 仍在水位线内')
  assert.equal(t.addLive('s1', 101, 10), true, 'seq=101 在水位线外')
})

test('回填 0 金额也要记水位线（防止旧事件被实时算）', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 200, 0)     // 今天没用，但读过 200 条
  t.endBackfill()
  assert.equal(t.total(), 0)
  assert.equal(t.addLive('s1', 150, 500), false, '旧事件必须跳过')
})

// ================================================================ 跨天
group('跨天清零')

test('同一天不重置', () => {
  const t = mk()
  t.addLive('s1', 1, 1000)
  assert.equal(t.rollover(DAY + 3600_000), false)
  assert.equal(t.total(), 1000)
})

test('换天后清零并清空水位线', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)
  t.endBackfill()

  const nextDay = new Date('2026-10-28T01:00:00+08:00').getTime()
  assert.equal(t.rollover(nextDay), true)
  assert.equal(t.total(), 0, '总数清零')

  // 水位线也要清，否则新的一天里 seq 很小的新事件会被误挡
  assert.equal(t.addLive('s1', 10, 300), true, '新的一天不应用昨天的水位线')
  assert.equal(t.total(), 300)
})

test('isStale 判断正确', () => {
  const t = mk()
  assert.equal(t.isStale(DAY + 3600_000), false)
  assert.equal(t.isStale(new Date('2026-10-28T01:00:00+08:00').getTime()), true)
})

// ================================================================ 诊断
group('诊断信息')

test('debug 返回可读数据', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 500)
  t.endBackfill()
  t.addLive('s1', 101, 200)
  const d = t.debug()
  assert.equal(d.total, 700)
  assert.equal(d.backfilling, false)
  assert.equal(d.sessionsTracked, 1)
  assert.equal(d.stats.backfillAmount, 500)
  assert.equal(d.stats.liveAmount, 200)
})

test('startOfToday 是当天 00:00', () => {
  const s = startOfToday(new Date('2026-10-27T15:30:00+08:00').getTime())
  const d = new Date(s)
  assert.equal(d.getHours(), 0)
  assert.equal(d.getMinutes(), 0)
  assert.equal(d.getSeconds(), 0)
  assert.equal(d.getMilliseconds(), 0)
  assert.equal(d.getDate(), 27)
})

// ================================================================ 汇总
process.stdout.write(`\n${'='.repeat(50)}\n通过 ${passed}   失败 ${failed}\n`)
if (failed > 0) {
  process.stdout.write('\n失败详情：\n')
  for (const f of failures) process.stdout.write(`\n  ${f.name}\n  ${f.error && f.error.stack}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('全部通过 ✅\n')
}
