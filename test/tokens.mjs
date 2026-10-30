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

// ================================================================ 会话级账本
group('会话级账本（v0.10.0：卡片每行显示自己那一份）')

test('实时累加会同时记进会话账本', () => {
  const t = mk()
  t.addLive('s1', 10, 1000)
  t.addLive('s1', 11, 500)
  assert.equal(t.sessionTotal('s1'), 1500)
  assert.equal(t.total(), 1500, '今日总额不受影响')
})

test('不同会话分开记，互不串味', () => {
  const t = mk()
  t.addLive('s1', 10, 1000)
  t.addLive('s2', 5, 300)
  t.addLive('s1', 11, 200)
  assert.equal(t.sessionTotal('s1'), 1200)
  assert.equal(t.sessionTotal('s2'), 300)
  assert.equal(t.total(), 1500, '两个会话之和 = 今日总额')
})

test('没记录过的会话返回 0（不是 undefined）', () => {
  const t = mk()
  assert.equal(t.sessionTotal('nobody'), 0)
  assert.equal(t.sessionTotal(''), 0)
  assert.equal(t.sessionTotal(null), 0)
  assert.equal(t.sessionTotal(undefined), 0)
  assert.equal(typeof t.sessionTotal('nobody'), 'number')
})

test('回填的金额也记进会话（方案 B1，用户拍板）', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)
  t.endBackfill()
  assert.equal(t.sessionTotal('s1'), 5000, '启动时补回来的钱要算进这个会话')
  assert.equal(t.total(), 5000)
})

test('回填 0 金额不会在会话账本里造出一条 0 记录', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 200, 0)
  t.endBackfill()
  assert.equal(t.sessionTotal('s1'), 0)
  assert.equal(t.debug().sessionsPriced, 0, '没有金额就不占账本条目')
  assert.equal(t.debug().sessionsTracked, 1, '但水位线还是要记（防旧事件被重复算）')
})

test('测试盲区补上：跨天时会话账本必须清空', () => {
  const t = mk()
  t.addLive('s1', 10, 1000)
  t.addLive('s2', 5, 500)
  assert.equal(t.sessionTotal('s1'), 1000)

  const nextDay = new Date('2026-10-28T01:00:00+08:00').getTime()
  assert.equal(t.rollover(nextDay), true)
  assert.equal(t.sessionTotal('s1'), 0, '跨天后不能还挂着昨天的数')
  assert.equal(t.sessionTotal('s2'), 0)
  assert.equal(t.total(), 0)
  assert.equal(t.debug().sessionsPriced, 0, '账本条目也要一起清掉')
})

test('同一天不跨天，会话账本保留', () => {
  const t = mk()
  t.addLive('s1', 10, 1000)
  assert.equal(t.rollover(DAY + 3600_000), false)
  assert.equal(t.sessionTotal('s1'), 1000)
})

test('水位线仍生效：被挡掉的实时事件不进会话账本', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)
  t.endBackfill()

  // seq=50 在回填覆盖范围内 → 必须跳过，会话账本也不能涨
  assert.equal(t.addLive('s1', 50, 800), false)
  assert.equal(t.sessionTotal('s1'), 5000, '被水位线挡下的钱不能重复记进会话')
  assert.equal(t.total(), 5000)

  // seq=101 是新的 → 要算，并且进会话
  assert.equal(t.addLive('s1', 101, 800), true)
  assert.equal(t.sessionTotal('s1'), 5800)
  assert.equal(t.total(), 5800)
})

test('缓冲期事件按水位线筛完后才进会话账本', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('s1', 100, 5000)
  t.addLive('s1', 50, 999)    // 会被挡
  t.addLive('s1', 120, 300)   // 新的
  t.addLive('brand-new', 5, 700)  // 回填时没这个会话

  const r = t.endBackfill()
  assert.equal(r.skipped, 1)
  assert.equal(r.counted, 2)

  assert.equal(t.sessionTotal('s1'), 5300, '5000 回填 + 300 新，999 被挡')
  assert.equal(t.sessionTotal('brand-new'), 700)
  assert.equal(t.total(), 6000)
})

test('每次调用 sessionTotal 不改变任何状态（纯读）', () => {
  const t = mk()
  t.addLive('s1', 10, 1000)
  const a = t.sessionTotal('s1')
  const b = t.sessionTotal('s1')
  const c = t.sessionTotal('s1')
  assert.equal(a, 1000)
  assert.equal(b, 1000)
  assert.equal(c, 1000)
  assert.equal(t.total(), 1000, '反复读不能把总额读涨')
})

test('脏金额不进会话账本', () => {
  const t = mk()
  t.addLive('s1', 1, 0)
  t.addLive('s1', 2, -100)
  t.addLive('s1', 3, NaN)
  t.addLive('s1', 4, 'abc')
  assert.equal(t.sessionTotal('s1'), 0)
})

// ================================================================ 不变量
//
// 【这组是 2026-10-31 复核后补的】
//   复核发现一个静默漏洞：会话号为空串时，addLive 会照加 _total，
//   但 _addToSession 因为 `if (!id) return` 直接跳过了 —— 于是
//   "各会话之和 = 今日总额"这条不变量被悄悄破坏，而且不报错。
//   下面这几条就是守着这条不变量的。
group('不变量：各会话之和 必须等于 今日总额')

test('正常路径：Σ 各会话 = total()', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('a', 100, 5000)
  t.addBackfill('b', 50, 3000)
  t.endBackfill()
  t.addLive('a', 101, 800)
  t.addLive('c', 10, 200)
  assert.equal(t.total(), 9000)
  assert.equal(t.sessionSum(), 9000, '账本求和必须等于总额')
})

test('空会话号不再漏账：钱记进孤儿桶，总额和账本一致', () => {
  const t = mk()
  const ret = t.addLive('', 1, 500)
  assert.equal(ret, true, '仍然算一笔真实的 Token，不能被丢弃')
  assert.equal(t.total(), 500, '今日总额必须包含它（总额是校准过的权威值）')
  assert.equal(t.sessionSum(), 500, '账本求和也必须包含它，否则不变量就破了')
  assert.equal(t.sessionTotal(''), 0, '卡片永远不会去查空会话号，所以这笔不显示')
  assert.equal(t.debug().sessionsPriced, 1, '孤儿桶算一个条目，但卡片查不到它')
})

test('回填期间空会话号走缓冲路径，同样不漏账', () => {
  const t = mk()
  t.beginBackfill()
  t.addLive('', 5, 400)
  const r = t.endBackfill()
  assert.equal(r.counted, 1)
  assert.equal(t.total(), 400)
  assert.equal(t.sessionSum(), 400, '缓冲路径也不许漏账')
})

test('孤儿桶的钱不会混进任何真实会话', () => {
  const t = mk()
  t.addLive('', 1, 500)
  t.addLive('s1', 2, 300)
  assert.equal(t.sessionTotal('s1'), 300, '真实会话只能拿到自己那 300')
  assert.equal(t.sessionSum(), 800)
  assert.equal(t.total(), 800)
})

test('跨天后孤儿桶也清空', () => {
  const t = mk()
  t.addLive('', 1, 500)
  t.addLive('s1', 2, 300)
  const nextDay = new Date('2026-10-28T01:00:00+08:00').getTime()
  assert.equal(t.rollover(nextDay), true)
  assert.equal(t.sessionSum(), 0)
  assert.equal(t.total(), 0)
})

test('debug 里 sessionSum 和 total 一致（排查时能一眼对上）', () => {
  const t = mk()
  t.beginBackfill()
  t.addBackfill('x', 10, 1111)
  t.endBackfill()
  t.addLive('y', 1, 2222)
  t.addLive('', 2, 333)
  const d = t.debug()
  assert.equal(d.sessionSum, d.total, `sessionSum=${d.sessionSum} total=${d.total}`)
})

test('debug 的两个计数没有大小关系（复核纠错：能反过来）', () => {
  // 原注释说 sessionsTracked >= sessionsPriced，实测能反过来：
  // 回填之后新建的会话只有金额、没有水位线。
  const t = mk()
  t.beginBackfill()
  t.addBackfill('old', 100, 5000)
  t.endBackfill()
  t.addLive('brand-new', 5, 700)
  const d = t.debug()
  assert.equal(d.sessionsTracked, 1, '只有 old 有水位线')
  assert.equal(d.sessionsPriced, 2, 'old 和 brand-new 都有金额')
  assert.ok(d.sessionsTracked < d.sessionsPriced,
    '确实能反过来 —— 所以注释里"前者>=后者"的说法是错的，已改')
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
