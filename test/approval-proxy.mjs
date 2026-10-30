/**
 * test/approval-proxy.mjs -- 悬浮窗审批代理的单测（v0.8.0）
 *
 * 【为什么这些测试一条都不需要 DSH 开着】
 *   这是这个项目最大的工程优势（交接文档 1.3：236 项测试全部离线）。
 *   ApprovalProxy 的所有 I/O 都是构造时注入的：
 *     · 文件系统用真实临时目录（不碰用户数据）
 *     · 时钟用注入的 now()
 *     · 心跳用注入的 liveness 对象
 *     · 瀑布用假的 ctx.on 捕获 handler，再手工调用
 *   所以下面每条测试都是确定性的，不会因为"卡片没开"而漂移。
 *
 * 跑法：node test\approval-proxy.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CardState } from '../lib/state.js'
import { ApprovalProxy } from '../lib/approval-proxy.js'

// ================================================================ 测试框架（与 unit.mjs 同风格）

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${detail ? '  (' + detail + ')' : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? '  (' + detail + ')' : ''}`)
  }
}

function group(title) {
  console.log(`\n=== ${title} ===`)
}

// ================================================================ 夹具

/** 造一个假的 Cordis ctx，捕获 approval/request 的 handler */
function makeCtx() {
  const captured = { handler: null, options: null, offCalled: 0 }
  return {
    captured,
    on(event, handler, options) {
      if (event === 'approval/request') {
        captured.handler = handler
        captured.options = options ?? null
      }
      return () => { captured.offCalled++ }
    },
  }
}

/** 临时目录（每个测试一套，互不干扰） */
function makeDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-approval-'))
}

/**
 * 造一个完整的测试装置。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.inline] 开关默认值
 * @param {boolean} [opts.cardAlive] 卡片心跳默认值
 * @param {() => number} [opts.now] 注入时钟
 */
function setup(opts = {}) {
  const dir = makeDir()
  const ctx = makeCtx()
  const state = new CardState({ now: opts.now ?? (() => 1793190000000) })
  const logs = []
  const changes = []
  const liveness = { alive: opts.cardAlive !== false }
  let inline = opts.inline === true

  const proxy = new ApprovalProxy({
    ctx,
    state,
    onChange: (reason, urgent) => changes.push({ reason, urgent }),
    log: (m) => logs.push(String(m)),
    decisionsDir: join(dir, 'decisions'),
    liveness,
    inlineEnabled: () => inline,
    decisionTtlMs: 60000,
    pollMs: 250,
    now: opts.now ?? (() => 1793190000000),
  })

  return {
    dir, ctx, state, proxy, logs, changes, liveness,
    setInline: (v) => { inline = v },
    cleanup: () => { try { proxy.dispose() } catch {} ; try { rmSync(dir, { recursive: true, force: true }) } catch {} },
  }
}

/** 造一条审批请求（ApprovalRequestEvent） */
function req(callId, toolName = 'pwsh', sessionId = 'sess-1') {
  return { agent: { id: sessionId }, toolName, callId, reason: '测试原因' }
}

/** 让 state 里先有一条 approval/asked（模拟 sources.js 收过事件） */
function seedAsked(state, { id = 'ap-1', sessionId = 'sess-1', callId = 'call-1', toolName = 'pwsh' } = {}) {
  state.sessionAdded({ sessionId, running: true })
  state.approvalAsked({ id, sessionId, toolName, reason: '测试原因', callId })
  return id
}

/** 写一个决定文件（目录不存在就先建，模拟卡片自己 ensure 的行为） */
function writeDecision(dir, filename, obj) {
  const d = join(dir, 'decisions')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, filename), JSON.stringify(obj), 'utf8')
}

// ================================================================ 1. 注册

group('1. 常驻注册（task-9 硬性要求）')
{
  const t = setup()
  t.proxy.install()
  check('注册到了 approval/request', typeof t.ctx.captured.handler === 'function')
  check('是 global 注册', t.ctx.captured.options?.global === true)
  check('【关键】没有 prepend（不能抢 dsh-im）', t.ctx.captured.options?.prepend !== true,
    'options=' + JSON.stringify(t.ctx.captured.options))

  // 注册之后改开关，handler 必须还在（不动态反注册）
  t.setInline(true)
  check('开关变化后 handler 仍然注册着', typeof t.ctx.captured.handler === 'function')
  t.setInline(false)
  check('再改回来 handler 还在', typeof t.ctx.captured.handler === 'function')
  t.cleanup()
}

// ================================================================ 2. 开关关：完全让路

group('2. 开关关（默认）→ 立刻 next() 让路')
{
  const t = setup({ inline: false })
  t.proxy.install()
  seedAsked(t.state)

  let nextCalled = 0
  const out = await t.ctx.captured.handler(req('call-1'), async () => { nextCalled++; return 'unavailable' })
  check('调用了 next()', nextCalled === 1)
  check('返回值透传', out === 'unavailable')
  check('没有攥住任何审批', t.proxy.held.size === 0)
  check('snapshot 里没有 answerable 字段',
    !('answerable' in t.state.snapshot({ approvalInline: false }).approval.items[0]))
  check('snapshot 里没有 id 字段',
    !('id' in t.state.snapshot({ approvalInline: false }).approval.items[0]))
  t.cleanup()
}

// ================================================================ 3. C1a：callId 缺失

group('3. C1a：callId 缺失 → 立刻 next()（不能盲批）')
{
  const t = setup({ inline: true })
  t.proxy.install()
  seedAsked(t.state)

  let nextCalled = 0
  // 故意不传 callId
  const out = await t.ctx.captured.handler(
    { agent: { id: 'sess-1' }, toolName: 'pwsh', reason: 'x' },
    async () => { nextCalled++; return 'unavailable' },
  )
  check('调用了 next()', nextCalled === 1)
  check('没有攥住', t.proxy.held.size === 0)
  check('C1a 计数器 +1', t.proxy.stats.passC1a === 1)
  check('返回值是 next 的结果（不是我们的决定）', out === 'unavailable')
  t.cleanup()
}

// ================================================================ 4. C2：卡片心跳死了

group('4. C2：卡片心跳死了 → 立刻 next()（让路，不是 unavailable）')
{
  const t = setup({ inline: true, cardAlive: false })
  t.proxy.install()
  seedAsked(t.state)

  let nextCalled = 0
  const out = await t.ctx.captured.handler(req('call-1'), async () => {
    nextCalled++
    return 'allowed-once'          // 让下一家（官网/IM）去处理，返回什么都行
  })
  check('调用了 next()', nextCalled === 1)
  check('没有攥住', t.proxy.held.size === 0)
  check('C2 计数器 +1', t.proxy.stats.passC2 === 1)
  check('【关键】是让路，不是返回 unavailable', out === 'allowed-once',
    '拿到了 ' + out)
  t.cleanup()
}

// ================================================================ 5. C1b：会话被淘汰

group('5. C1b：会话已被 _trim() 淘汰 → 立刻 next()')
{
  const t = setup({ inline: true })
  t.proxy.install()
  // 造一条审批，但**不**在 state.sessions 里登记这个会话
  t.state.approvalAsked({ id: 'ap-x', sessionId: 'ghost-session', toolName: 'pwsh', reason: 'x', callId: 'call-ghost' })

  let nextCalled = 0
  await t.ctx.captured.handler(
    req('call-ghost', 'pwsh', 'ghost-session'),
    async () => { nextCalled++; return 'unavailable' },
  )
  check('调用了 next()', nextCalled === 1)
  check('没有攥住', t.proxy.held.size === 0)
  check('C1b 计数器 +1', t.proxy.stats.passC1b === 1)
  t.cleanup()
}

// ================================================================ 6. 配对失败

group('6. 配不上对 → 让路（不能拿假 id 去骗用户点）')
{
  const t = setup({ inline: true })
  t.proxy.install()
  t.state.sessionAdded({ sessionId: 'sess-1', running: true })
  // state 里没有任何 approval/asked

  let nextCalled = 0
  await t.ctx.captured.handler(req('call-nomatch'), async () => { nextCalled++; return 'unavailable' })
  check('调用了 next()', nextCalled === 1)
  check('没有攥住', t.proxy.held.size === 0)
  t.cleanup()
}

// ================================================================ 7. 正常攥住 + 配对

group('7. 开关开 + 全部判据通过 → 攥住')
{
  const t = setup({ inline: true })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })

  let nextCalled = 0
  const promise = t.ctx.captured.handler(req('call-1'), async () => { nextCalled++; return 'unavailable' })

  check('没有调 next()（攥住了）', nextCalled === 0)
  check('攥住表里有 1 条', t.proxy.held.size === 1)
  check('攥住的是正确的 approvalId', t.proxy.held.has(apId))

  // state 里应该已经回填了 nonce / expiresAtMs / held
  const snap = t.state.snapshot({ approvalInline: true, cardAlive: true })
  const item = snap.approval.items[0]
  check('snapshot 输出了 id', item.id === apId, item.id)
  check('snapshot 输出了 nonce', typeof item.nonce === 'string' && item.nonce.length === 32, 'len=' + (item.nonce ?? '').length)
  check('snapshot 输出了 expiresAtMs', Number.isFinite(item.expiresAtMs))
  check('answerable = true', item.answerable === true)
  check('没有 blockReason', item.blockReason === undefined)

  // 通过决定文件作答
  writeDecision(t.dir, apId + '.json', {
    approvalId: apId,
    outcome: 'allowed-once',
    nonce: item.nonce,
    ts: 1793190000000,
    requestId: 'req-abc12345',
    source: 'desktop-card',
  })
  t.proxy._poll()

  const outcome = await promise
  check('【核心】Promise 落地为 allowed-once', outcome === 'allowed-once', outcome)
  check('攥住表已清空', t.proxy.held.size === 0)
  check('决定文件已归档', !existsSync(join(t.dir, 'decisions', apId + '.json')))
  check('回执写进了 state', t.state.snapshot({ approvalInline: true }).approval.lastDecision?.accepted === true)
  t.cleanup()
}

// ================================================================ 8. nonce 校验

group('8. nonce 不匹配 → 丢弃（防伪造/防串号）')
{
  const t = setup({ inline: true })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  const promise = t.ctx.captured.handler(req('call-1'), async () => 'x')

  const nonce = t.state.pendingApprovals.get(apId).nonce
  writeDecision(t.dir, apId + '.json', {
    approvalId: apId,
    outcome: 'allowed-once',
    nonce: 'wrong-nonce-000000000000000000',
    ts: 1793190000000,
  })
  t.proxy._poll()

  check('审批仍挂着（没被错误放行）', t.proxy.held.size === 1)
  check('文件被丢掉', !existsSync(join(t.dir, 'decisions', apId + '.json')))
  check('丢弃计数 +1', t.proxy.stats.filesDropped === 1)
  check('正确的 nonce 仍然可用', typeof nonce === 'string' && nonce.length === 32)

  // 用完清场
  writeDecision(t.dir, apId + '.json', {
    approvalId: apId, outcome: 'rejected', nonce, ts: 1793190000000,
  })
  t.proxy._poll()
  const out = await promise
  check('正确 nonce 的 rejected 生效', out === 'rejected')
  t.cleanup()
}

// ================================================================ 9. 时间戳过期

group('9. 决定文件时间戳超出有效期 → 丢弃')
{
  const t = setup({ inline: true })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  const promise = t.ctx.captured.handler(req('call-1'), async () => 'x')
  const nonce = t.state.pendingApprovals.get(apId).nonce

  // ts 比 now() 早了 5 分钟（TTL 是 60 秒）
  writeDecision(t.dir, apId + '.json', {
    approvalId: apId, outcome: 'allowed-once', nonce, ts: 1793190000000 - 300000,
  })
  t.proxy._poll()

  check('审批仍挂着', t.proxy.held.size === 1)
  check('文件被丢掉', !existsSync(join(t.dir, 'decisions', apId + '.json')))
  t.proxy.dispose()
  const out = await promise
  check('dispose 后落地为 unavailable', out === 'unavailable')
  t.cleanup()
}

// ================================================================ 10. 一次性消费

group('10. 一次性消费：同一 approvalId 只认第一次')
{
  const t = setup({ inline: true })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  const promise = t.ctx.captured.handler(req('call-1'), async () => 'x')
  const nonce = t.state.pendingApprovals.get(apId).nonce

  writeDecision(t.dir, apId + '.json', { approvalId: apId, outcome: 'allowed-once', nonce, ts: 1793190000000 })
  t.proxy._poll()
  const first = await promise
  check('第一次生效', first === 'allowed-once')

  // 再写一次同 approvalId（模拟用户连点两次 / 陈旧文件复活）。
  //
  // 【这里要验的是什么】
  //   不是"文件立刻消失" —— 那一刻攥住表已经空了，_poll() 会提前返回
  //   （"没待审批就不扫目录"是有意的性能设计），文件会留到下次空闲清理。
  //   真正要保证的是：**它绝不能改写已经生效的结果**。
  writeDecision(t.dir, apId + '.json', { approvalId: apId, outcome: 'rejected', nonce, ts: 1793190000000 })
  t.proxy._poll()
  check('第二次没有重新攥住', t.proxy.held.size === 0)
  check('决定结果没被改写成 rejected', t.proxy.lastDecision?.outcome === 'allowed-once',
    String(t.proxy.lastDecision?.outcome))
  check('回执仍是第一次的 allowed-once',
    t.state.lastApprovalDecision?.outcome === 'allowed-once',
    String(t.state.lastApprovalDecision?.outcome))

  // 空闲清理：审批一结束（DSH 会发 approval/decided，sources.js 转成
  // state.approvalDecided），残留文件就成了孤儿，该被收掉。
  t.state.approvalDecided(apId)
  t.proxy._sweepStale()
  check('空闲清理把残留文件收掉了', !existsSync(join(t.dir, 'decisions', apId + '.json')))
  t.cleanup()
}

// ================================================================ 11. 值非法

group('11. 结果值非法 → 丢弃')
{
  const t = setup({ inline: true })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  const promise = t.ctx.captured.handler(req('call-1'), async () => 'x')
  const nonce = t.state.pendingApprovals.get(apId).nonce

  writeDecision(t.dir, apId + '.json', { approvalId: apId, outcome: 'allow-always', nonce, ts: 1793190000000 })
  t.proxy._poll()
  check('"allow-always" 被拒绝（DSH 没有这个值）', t.proxy.held.size === 1)
  check('文件被丢掉', !existsSync(join(t.dir, 'decisions', apId + '.json')))

  t.proxy.dispose()
  await promise
  t.cleanup()
}

// ================================================================ 12. 坏 JSON

group('12. 坏 JSON / 缺字段 → 丢弃不崩')
{
  const t = setup({ inline: true })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  const promise = t.ctx.captured.handler(req('call-1'), async () => 'x')

  const p = join(t.dir, 'decisions', 'broken.json')
  mkdirSync(join(t.dir, 'decisions'), { recursive: true })
  writeFileSync(p, '{ 这不是 json', 'utf8')
  let threw = false
  try { t.proxy._poll() } catch { threw = true }
  check('坏 JSON 不会抛出来', threw === false)
  check('坏文件被丢掉', !existsSync(p))

  // 缺 approvalId
  writeDecision(t.dir, 'noid.json', { outcome: 'allowed-once' })
  t.proxy._poll()
  check('缺 approvalId 被丢掉', !existsSync(join(t.dir, 'decisions', 'noid.json')))

  t.proxy.dispose()
  await promise
  t.cleanup()
}

// ================================================================ 13. 卸载清理（最危险）

group('13. 【最危险】卸载时必须把所有挂住的 Promise 落地为 unavailable')
{
  const t = setup({ inline: true })
  t.proxy.install()

  // 攥住三条
  const ids = []
  const promises = []
  for (let i = 1; i <= 3; i++) {
    const id = seedAsked(t.state, { id: 'ap-' + i, sessionId: 'sess-1', callId: 'call-' + i })
    ids.push(id)
    promises.push(t.ctx.captured.handler(req('call-' + i), async () => 'x'))
  }
  check('攥住了 3 条', t.proxy.held.size === 3)

  t.proxy.dispose()

  const results = await Promise.all(promises)
  check('3 条全部落地', results.length === 3)
  check('全部是 unavailable', results.every(r => r === 'unavailable'), results.join(','))
  check('攥住表已空', t.proxy.held.size === 0)
  check('监听者已摘掉', t.ctx.captured.offCalled >= 1)

  // 二次 dispose 不能崩、不能重复 resolve
  let threw = false
  try { t.proxy.dispose() } catch { threw = true }
  check('重复 dispose 不崩', threw === false)
  t.cleanup()
}

// ================================================================ 14. DSH 的 signal abort

group('14. DSH 的 signal abort → 跟着撤（cancelled）')
{
  const t = setup({ inline: true })
  t.proxy.install()
  seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })

  const ac = new AbortController()
  const request = { ...req('call-1'), signal: ac.signal }
  const promise = t.ctx.captured.handler(request, async () => 'x')

  check('先攥住', t.proxy.held.size === 1)
  ac.abort()
  const out = await promise
  check('abort 后落地为 cancelled', out === 'cancelled', out)
  check('攥住表已清空', t.proxy.held.size === 0)
  t.cleanup()
}

// ================================================================ 15. 配对的备路（翻 session 事件）

group('15. 备路配对：state 里没有时翻 session 事件快照')
{
  const t = setup({ inline: true })
  t.proxy.install()
  // 故意**不**往 state.pendingApprovals 里放，只放 session
  t.state.sessionAdded({ sessionId: 'sess-1', running: true })
  t.state.pendingApprovals.clear()

  const session = {
    snapshotEvents: () => [
      { type: 'turn/start', data: {} },
      { type: 'tool/call', data: { callId: 'call-9', name: 'pwsh', arguments: '{}' } },
      { type: 'approval/asked', data: { id: 'ap-from-log', toolName: 'pwsh', callId: 'call-9' } },
    ],
  }
  const request = { agent: { id: 'sess-1', session }, toolName: 'pwsh', callId: 'call-9', reason: 'x' }

  // 主路空、备路应命中
  const found = t.proxy._findApprovalId(request)
  check('备路找到了 approvalId', found === 'ap-from-log', String(found))

  // 已 decided 的不能被选中
  const session2 = {
    snapshotEvents: () => [
      { type: 'approval/asked', data: { id: 'ap-done', toolName: 'pwsh', callId: 'call-9' } },
      { type: 'approval/decided', data: { id: 'ap-done', outcome: 'allowed-once' } },
    ],
  }
  const r2 = { agent: { id: 'sess-1', session: session2 }, toolName: 'pwsh', callId: 'call-9' }
  check('已 decided 的不被选中', t.proxy._findApprovalId(r2) === null)
  t.cleanup()
}

// ================================================================ 16. answerable 四条件

group('16. answerable 的四条件（开关开时）')
{
  const t = setup({ inline: true, cardAlive: true })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  const promise = t.ctx.captured.handler(req('call-1'), async () => 'x')

  // 条件全满足
  let item = t.state.snapshot({ approvalInline: true, cardAlive: true }).approval.items[0]
  check('四条件全满足 → true', item.answerable === true)

  // 条件④ 失效：卡片心跳死
  item = t.state.snapshot({ approvalInline: true, cardAlive: false }).approval.items[0]
  check('卡片死了 → false', item.answerable === false)
  check('给出了原因', item.blockReason === '卡片状态异常', item.blockReason)

  // 条件③ 失效：会话被淘汰
  t.state.sessions.delete('sess-1')
  item = t.state.snapshot({ approvalInline: true, cardAlive: true }).approval.items[0]
  check('会话淘汰 → false', item.answerable === false)
  check('原因是会话已结束', item.blockReason === '会话已结束', item.blockReason)

  // 条件② 失效：held 被清掉
  t.state.sessions.set('sess-1', { sessionId: 'sess-1', running: true, blank: false })
  t.state.markHeld(apId, false)
  item = t.state.snapshot({ approvalInline: true, cardAlive: true }).approval.items[0]
  check('没攥住 → false', item.answerable === false)
  check('原因写清了', item.blockReason === '此条暂不支持直接审批', item.blockReason)

  t.proxy.dispose()
  await promise
  t.cleanup()
}

// ================================================================ 17. 开关关时不输出字段

group('17. 开关关时 snapshot 不输出 answerable/id/nonce（字段最小化）')
{
  const t = setup({ inline: false })
  t.proxy.install()
  const apId = seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  // 就算 state 里有 nonce，开关关时也不该输出
  t.state.annotateApproval(apId, { nonce: 'should-not-leak', expiresAtMs: 1793190060000, held: true })

  const item = t.state.snapshot({ approvalInline: false }).approval.items[0]
  check('没有 answerable', !('answerable' in item))
  check('没有 id', !('id' in item))
  check('没有 nonce（不泄露）', !('nonce' in item))
  check('没有 expiresAtMs', !('expiresAtMs' in item))
  check('title 仍在（老契约不破）', typeof item.title === 'string' && item.title.length > 0, item.title)
  t.cleanup()
}

// ================================================================ 18. 老契约向后兼容

group('18. 向后兼容：老 state.json / 老调用方')
{
  const t = setup()
  // 完全不带 v0.8.0 的新字段调用
  t.state.sessionAdded({ sessionId: 'sess-1', running: true })
  t.state.approvalAsked({ id: 'old-1', sessionId: 'sess-1', toolName: 'pwsh', reason: '老式调用' })

  // 默认（不带 approvalInline 选项）应该和老行为完全一致
  const snap = t.state.snapshot()
  check('items 里只有 title', Object.keys(snap.approval.items[0]).join(',') === 'title',
    Object.keys(snap.approval.items[0]).join(','))
  check('pending 计数正确', snap.approval.pending === 1)
  check('没有 lastDecision（没处理过决定）', !('lastDecision' in snap.approval))
  check('tasks 仍有 subagentCount（第一批成果不破）', 'subagentCount' in snap.tasks)
  t.cleanup()
}

// ================================================================ 19. decisions 目录不存在时不崩

group('19. decisions 目录不存在 / 空目录时安静退出')
{
  const t = setup({ inline: true })
  t.proxy.install()
  // 不建目录直接 poll
  let threw = false
  try { t.proxy._poll() } catch { threw = true }
  check('目录不存在时 poll 不抛', threw === false)
  check('ensureDir 能建出来', t.proxy.ensureDir() === true)
  check('空目录 poll 不抛', (() => { try { t.proxy._poll(); return true } catch { return false } })())
  t.cleanup()
}

// ================================================================ 20. 计时器不会挂住

group('20. 保险丝：到点自动放开（不会永久占着 Promise）')
{
  let nowMs = 1793190000000
  const t = setup({ inline: true, now: () => nowMs })
  t.proxy.install()
  seedAsked(t.state, { id: 'ap-1', callId: 'call-1' })
  t.ctx.captured.handler(req('call-1'), async () => 'x')
  check('先攥住', t.proxy.held.size === 1)

  // 直接调内部的到点逻辑（不等真定时器，测试要快且确定）
  const entry = t.proxy.held.get('ap-1')
  nowMs += 61000
  t.proxy._settle(entry, 'unavailable', 'expired')
  check('到点后自动放开', t.proxy.held.size === 0)
  t.cleanup()
}

// ================================================================ 汇总

console.log('\n' + '='.repeat(50))
console.log(`通过 ${pass}   失败 ${fail}`)
if (fail === 0) {
  console.log('全部通过 ✅')
} else {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
