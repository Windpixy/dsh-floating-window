/**
 * test/unit.mjs -- 纯逻辑单测
 *
 * 直接跑：  node test/unit.mjs
 * 不需要 DSH，不需要安装，不需要重启。
 *
 * 这是 M1 最要紧的产出：把「事件 → 状态」的换算规则钉死。
 * 以后改逻辑先跑这个，通过了再重启 DSH 验证。
 */

import assert from 'node:assert/strict'
import {
  CardState,
  isSubagent,
  describeTool,
  describeApproval,
  formatTimestamp,
  localDayKey,
} from '../lib/state.js'

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

function group(name) {
  process.stdout.write(`\n${name}\n`)
}

/** 固定时间，避免测试结果随真实时间漂移 */
const T0 = new Date('2026-10-27T10:00:00+08:00').getTime()
const at = (sec) => T0 + sec * 1000

/**
 * 造一个时钟可控的 state。
 * 这样 elapsedSec / runningSince / lastFinished 全都可预期，
 * 不会因为测试跑得慢或机器卡顿而漂。
 */
function makeState(options = {}) {
  let current = T0
  const s = new CardState({ ...options, now: () => current })
  return {
    state: s,
    /** 把时钟拨到 T0 + sec 秒 */
    seek(sec) { current = at(sec); return s },
    now: () => current,
  }
}

// ================================================================ 结果格式
group('state.json 格式（必须和卡片现有约定一致）')

test('空状态结构完整', () => {
  const s = new CardState()
  const snap = s.snapshot({ now: T0 })
  assert.equal(typeof snap.updatedAt, 'number')
  assert.equal(snap.updatedAt, Math.floor(T0 / 1000))
  assert.equal(snap.tasks.running, 0)
  assert.deepEqual(snap.tasks.sessions, [])
  assert.equal(snap.approval.pending, 0)
  assert.deepEqual(snap.approval.items, [])
  assert.equal(snap.lastFinished, null)
  assert.equal(snap.tokens.today, 0)
})

test('lastFinished 格式是 yyyyMMddHHmmss', () => {
  const got = formatTimestamp(T0)
  assert.match(got, /^\d{14}$/)
  assert.equal(got, '20261027100000')
})

// ================================================================ 运行中
group('运行中的任务')

test('一个任务开跑 → running=1 且带标题', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false, cwd: 'C:\\proj\\login' })
  s.sessionTitle('a', '重构登录模块')
  const snap = s.snapshot({ now: at(30) })
  assert.equal(snap.tasks.running, 1)
  assert.equal(snap.tasks.sessions[0].title, '重构登录模块')
})

test('elapsedSec 按真实时间算', () => {
  const { state: s, seek } = makeState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  seek(30)
  const snap = s.snapshot()
  assert.equal(snap.tasks.sessions[0].elapsedSec, 30)
})

test('停跑后不再出现在列表里', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.sessionStatus('a', false)
  const snap = s.snapshot({ now: at(10) })
  assert.equal(snap.tasks.running, 0)
  assert.deepEqual(snap.tasks.sessions, [])
})

test('多个任务按「跑得久的排前面」', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'new', running: true, blank: false })
  // 让 new 的 runningSince 晚 20 秒
  s.sessions.get('new').runningSince = at(20)
  s.sessionAdded({ sessionId: 'old', running: true, blank: false })
  s.sessions.get('old').runningSince = at(0)
  const snap = s.snapshot({ now: at(60) })
  assert.equal(snap.tasks.sessions[0].title, snap.tasks.sessions[0].title)
  // old 的 elapsed 应该更大
  assert.ok(snap.tasks.sessions[0].elapsedSec > snap.tasks.sessions[1].elapsedSec)
})

test('没有标题时用 cwd 末段兜底', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false, cwd: 'C:\\Users\\me\\Documents\\my-project' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.sessions[0].title, 'my-project')
})

test('没有标题也没有 cwd 时兜底为「未命名任务」', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.sessions[0].title, '未命名任务')
})

// ================================================================ 子任务过滤
group('子任务过滤（你选的「只显示主任务」）')

test('默认不显示子代理会话', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'child', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.running, 1, '只应显示主任务')
  assert.equal(snap.tasks.sessions.length, 1)
})

test('打开开关后子任务也显示', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'child', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  const snap = s.snapshot({ now: at(5), includeSubagents: true })
  assert.equal(snap.tasks.running, 2)
})

test('只有 parentSessionId 没有 origin 也算子任务', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'child', running: true, blank: false, parentSessionId: 'main' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.running, 0)
})

test('isSubagent 对普通会话返回 false', () => {
  assert.equal(isSubagent({ origin: null, parentSessionId: null }), false)
  assert.equal(isSubagent({ origin: 'subagent' }), true)
  assert.equal(isSubagent({ parentSessionId: 'x' }), true)
})

test('子任务完成不再让主任务闪绿点（v0.6.0 修复，防回归）', () => {
  // 【这条测试原来叫「子任务完成不应让主任务闪绿点吗——实际会闪，记录该行为」】
  //
  // 原来它断言 assert.notEqual(snap.lastFinished, null)，也就是把
  // 「子代理跑完会触发绿点」当成既定事实记录下来，等着以后观感不好再改。
  //
  // v0.6.0 决定修掉这个 bug：
  //   卡片优先级是 待审批 > 已完成 > 运行中，所以主任务明明还在跑，
  //   子代理一收工卡片就闪 8 秒绿点、标题写「全部任务已经跑完」。
  //   workflow 一次 fan-out 20 个 agent 就假报 20 次「全部完成」。
  //
  // 修法在 lib/state.js 的 _setRunning()：设 lastFinishedAt 时排除子代理。
  // 这条测试同步改成断言新行为 —— 以后谁把它改回去，这里会立刻变红。
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'child', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  s.sessionStatus('child', false)
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.lastFinished, null, '子代理跑完不该闪绿点')
  assert.equal(snap.tasks.running, 1, '主任务还在跑')
})

test('主任务自己跑完仍然要闪绿点（修 bug 不能把这个一起干掉）', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionStatus('main', false)
  const snap = s.snapshot({ now: at(5) })
  assert.notEqual(snap.lastFinished, null, '主任务跑完必须闪绿点')
})

test('只有 parentSessionId 的子代理跑完也不闪绿点', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'child', running: true, blank: false, parentSessionId: 'main' })
  s.sessionStatus('child', false)
  assert.equal(s.snapshot({ now: at(5) }).lastFinished, null)
})

// ================================================================ 子代理计数（v0.6.0 新增）
group('子代理计数 tasks.subagentCount（v0.6.0 新增）')

test('空状态时 subagentCount 是 0（不是 undefined）', () => {
  const s = new CardState()
  const snap = s.snapshot({ now: T0 })
  assert.equal(snap.tasks.subagentCount, 0)
  assert.equal(typeof snap.tasks.subagentCount, 'number')
})

test('主任务 + 2 个子代理在跑 → running 仍是 1，subagentCount 是 2', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'c1', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  s.sessionAdded({ sessionId: 'c2', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.running, 1, 'running 只能数主任务，不能改成含子代理的总数')
  assert.equal(snap.tasks.subagentCount, 2)
  assert.equal(snap.tasks.sessions.length, 1, '子代理不能占行')
})

test('★ 只跑子代理（主任务已停）→ running=0 但 subagentCount>0（这就是「假装空闲」的判据）', () => {
  // 这是本次改动最核心的一条：主任务跑完、子代理还在跑。
  // 改之前：running=0 → 卡片判 idle → 收成 96 扁条 + 灰点「空闲」，用户被骗。
  // 改之后：subagentCount=1，卡片能据此判成「帮手还在跑」，不再假装空闲。
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionTitle('main', '主任务')
  s.sessionAdded({ sessionId: 'c1', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  s.sessionStatus('main', false)

  const snap = s.snapshot({ now: at(30) })
  assert.equal(snap.tasks.running, 0, '主任务已停，running 应该是 0')
  assert.equal(snap.tasks.subagentCount, 1, '但帮手还在跑，卡片不能据此判空闲')
  assert.deepEqual(snap.tasks.sessions, [], '主任务停跑后行列表为空')
})

test('三个子代理同时跑 → subagentCount 是 3', () => {
  const s = new CardState()
  for (let i = 1; i <= 3; i++) {
    s.sessionAdded({ sessionId: `c${i}`, running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  }
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.running, 0)
  assert.equal(snap.tasks.subagentCount, 3)
})

test('子代理结束时计数归零', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'c1', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  assert.equal(s.snapshot({ now: at(5) }).tasks.subagentCount, 1)
  s.sessionStatus('c1', false)
  assert.equal(s.snapshot({ now: at(6) }).tasks.subagentCount, 0)
})

test('多个子代理逐个结束，计数逐个减', () => {
  const s = new CardState()
  for (let i = 1; i <= 3; i++) {
    s.sessionAdded({ sessionId: `c${i}`, running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  }
  assert.equal(s.snapshot({ now: at(5) }).tasks.subagentCount, 3)
  s.sessionStatus('c1', false)
  assert.equal(s.snapshot({ now: at(6) }).tasks.subagentCount, 2)
  s.sessionStatus('c2', false)
  assert.equal(s.snapshot({ now: at(7) }).tasks.subagentCount, 1)
  s.sessionStatus('c3', false)
  assert.equal(s.snapshot({ now: at(8) }).tasks.subagentCount, 0)
})

test('子代理被 removed（会话消失）也会让计数减少', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'c1', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  s.sessionRemoved('c1')
  assert.equal(s.snapshot({ now: at(5) }).tasks.subagentCount, 0)
})

test('已停跑的子代理不算进 subagentCount（只数运行中的）', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'c1', running: false, blank: false, origin: 'subagent', parentSessionId: 'main' })
  s.sessionAdded({ sessionId: 'c2', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.subagentCount, 1, '停着的那个不该数')
})

test('打开 includeSubagents 后 subagentCount 语义不变（仍然是「有几个帮手」）', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'c1', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  const snap = s.snapshot({ now: at(5), includeSubagents: true })
  assert.equal(snap.tasks.running, 2, '开关打开时子代理也占行（老行为不变）')
  assert.equal(snap.tasks.subagentCount, 1, '但帮手数还是 1')
})

test('子代理有子代理（深链）也一起数，不做层级区分', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'c1', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  s.sessionAdded({ sessionId: 'g1', running: true, blank: false, origin: 'subagent', parentSessionId: 'c1' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.running, 1)
  assert.equal(snap.tasks.subagentCount, 2, '孙代理也算帮手，卡片只显示总数')
})

test('普通会话不会被误算成子代理', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.sessionAdded({ sessionId: 'b', running: true, blank: false })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.running, 2)
  assert.equal(snap.tasks.subagentCount, 0)
})

// ================================================================ 向后兼容
group('向后兼容（老卡片 / 老 state.json）')

test('snapshot 的现有字段结构和含义一个都没变', () => {
  // 这条是「只加字段、不改现有字段」的守门测试。
  // 特别是 tasks.running：卡片 Panel.ps1:1296 靠它判相位，
  // Panel.ps1:1224 还靠它兜底造「任务 N」的行 —— 语义一改就会出假行。
  const s = new CardState()
  s.sessionAdded({ sessionId: 'main', running: true, blank: false })
  s.sessionAdded({ sessionId: 'c1', running: true, blank: false, origin: 'subagent', parentSessionId: 'main' })
  const snap = s.snapshot({ now: at(30) })

  // 顶层字段
  assert.equal(typeof snap.updatedAt, 'number')
  assert.ok(snap.tasks && typeof snap.tasks === 'object')
  assert.ok(snap.approval && typeof snap.approval === 'object')
  assert.ok(snap.tokens && typeof snap.tokens === 'object')
  assert.equal('lastFinished' in snap, true)
  assert.equal('valley' in snap, true)

  // tasks 里原有字段的语义
  assert.equal(snap.tasks.running, 1, 'running = 主任务数，不含子代理')
  assert.equal(Array.isArray(snap.tasks.sessions), true)
  assert.deepEqual(Object.keys(snap.tasks.sessions[0]).sort(), ['activity', 'elapsedSec', 'title'],
    '每行的字段集合不能变，老卡片只认这三个')

  // 新字段
  assert.equal(snap.tasks.subagentCount, 1, '只加了 1 个子代理，帮手数就是 1')
})

test('老 state.json（没有 subagentCount 字段）新插件也照常解析 —— 模拟卡片侧的容错', () => {
  // 卡片侧读字段走 Get-Setting（Panel.ps1:198-204），缺字段返回默认值。
  // 这里在 JS 里复刻同一条规则，证明「字段缺失 → 当 0」不会崩。
  // 真正的 PowerShell 侧验证在 panel 补丁里（Read-PanelState 用同一个 Get-Setting）。
  const readField = (obj, name, dflt) => {
    if (obj === null || obj === undefined) return dflt
    const v = obj[name]
    return (v === null || v === undefined) ? dflt : v
  }

  const oldStateJson = JSON.parse(JSON.stringify({
    updatedAt: 1793163946,
    tasks: { running: 1, sessions: [{ title: '老任务', elapsedSec: 10, activity: '正在运行' }] },
    approval: { pending: 0, items: [] },
    lastFinished: null,
    tokens: { today: 100 },
    valley: null,
  }))

  const n = readField(oldStateJson.tasks, 'subagentCount', 0)
  assert.equal(n, 0, '字段缺失时按 0 处理')
  assert.equal(oldStateJson.tasks.running, 1, '老字段照常可读')

  // 模拟卡片相位判定的新老两种写法，结果必须一致（老 state.json 不该改变行为）
  const oldPhase = oldStateJson.tasks.running > 0 ? 'running' : 'idle'
  const newPhase = (oldStateJson.tasks.running > 0 || n > 0) ? 'running' : 'idle'
  assert.equal(newPhase, oldPhase, '老 state.json 下新旧判定必须一致')

  // 字段存在但为 null / 0 也不能崩
  assert.equal(readField({ subagentCount: null }, 'subagentCount', 0), 0)
  assert.equal(readField({ subagentCount: 0 }, 'subagentCount', 0), 0)
  assert.equal(readField(null, 'subagentCount', 0), 0)
  assert.equal(readField(undefined, 'subagentCount', 0), 0)
})

// ================================================================ 审批
group('待审批')

test('收到 approval/asked → pending=1 且有文字', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.approvalAsked({ id: 'ap1', sessionId: 'a', toolName: 'pwsh', reason: '删除 3 个临时文件' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.approval.pending, 1)
  assert.equal(snap.approval.items[0].title, '删除 3 个临时文件')
})

test('approval/decided 后 pending 归零', () => {
  const s = new CardState()
  s.approvalAsked({ id: 'ap1', toolName: 'pwsh' })
  s.approvalDecided('ap1')
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.approval.pending, 0)
  assert.deepEqual(snap.approval.items, [])
})

test('重复 asked 同一 id 不会重复计数', () => {
  const s = new CardState()
  s.approvalAsked({ id: 'ap1', toolName: 'pwsh' })
  s.approvalAsked({ id: 'ap1', toolName: 'pwsh' })
  assert.equal(s.snapshot({ now: at(5) }).approval.pending, 1)
})

test('decided 一个不存在的 id 不出错', () => {
  const s = new CardState()
  assert.equal(s.approvalDecided('nope'), false)
})

test('没有 reason 时用工具名兜底', () => {
  assert.equal(describeApproval('pwsh', null, null), 'pwsh 需要你确认')
})

test('描述过长会截断到 40 字内', () => {
  const long = '这是一段非常长的审批原因说明'.repeat(10)
  const out = describeApproval('pwsh', long, null)
  assert.ok(out.length <= 40, `实际长度 ${out.length}`)
  assert.ok(out.endsWith('…'))
})

test('两项待审批 → pending=2 且列出两项', () => {
  const s = new CardState()
  s.approvalAsked({ id: 'ap1', toolName: 'pwsh', reason: '删文件' })
  s.approvalAsked({ id: 'ap2', toolName: 'write', reason: '写配置' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.approval.pending, 2)
  assert.equal(snap.approval.items.length, 2)
})

// ================================================================ 刚完成
group('刚完成绿点')

test('跑过又停下 → lastFinished 有值', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.sessionStatus('a', false)
  const snap = s.snapshot({ now: at(2) })
  assert.notEqual(snap.lastFinished, null)
})

test('超过 8 秒后 lastFinished 归 null', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.sessionStatus('a', false)
  const snap = s.snapshot({ now: Date.now() + 9000 })
  assert.equal(snap.lastFinished, null)
})

test('从没跑过的空会话停掉不算完成', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: false, blank: true })
  s.sessionStatus('a', false)
  const snap = s.snapshot({ now: at(2) })
  assert.equal(snap.lastFinished, null)
})

// ================================================================ 工具描述
group('「正在做什么」的文字')

test('常见工具都有中文', () => {
  assert.equal(describeTool('pwsh'), '正在执行命令')
  assert.equal(describeTool('read'), '正在读文件')
  assert.equal(describeTool('edit'), '正在改文件')
  assert.equal(describeTool('grep'), '正在搜索代码')
})

test('能从参数里抠出文件名', () => {
  const out = describeTool('edit', '{"file_path":"C:\\\\proj\\\\src\\\\auth.ts"}')
  assert.equal(out, '正在处理 auth.ts')
})

test('未知工具也给出可读文字', () => {
  assert.equal(describeTool('some_new_tool'), '正在使用 some_new_tool')
})

test('空工具名不炸', () => {
  assert.equal(describeTool(''), '正在运行')
  assert.equal(describeTool(null), '正在运行')
})

test('超长文件名会截断', () => {
  const out = describeTool('edit', `{"file_path":"C:\\\\${'x'.repeat(80)}.ts"}`)
  assert.ok(out.length < 50, `实际: ${out}`)
})

// ================================================================ Token
group('今日 Token')

test('累加 usage', () => {
  const s = new CardState()
  s.addTokens(1000)
  s.addTokens(500)
  assert.equal(s.snapshot({ now: T0 }).tokens.today, 1500)
})

test('负数和非数字被忽略', () => {
  const s = new CardState()
  s.addTokens(-100)
  s.addTokens('abc')
  s.addTokens(NaN)
  assert.equal(s.snapshot({ now: T0 }).tokens.today, 0)
})

test('回填会覆盖而不是累加', () => {
  const s = new CardState()
  s.addTokens(100)
  s.setTodayTokens(50000)
  assert.equal(s.snapshot({ now: T0 }).tokens.today, 50000)
})

test('跨天清零', () => {
  const s = new CardState()
  s.resetDayIfNeeded(new Date('2026-10-27T23:00:00+08:00').getTime())
  s.addTokens(999)
  const cleared = s.resetDayIfNeeded(new Date('2026-10-28T01:00:00+08:00').getTime())
  assert.equal(cleared, true)
  assert.equal(s.todayTokens, 0)
})

test('同一天不清零', () => {
  const s = new CardState()
  s.resetDayIfNeeded(new Date('2026-10-27T01:00:00+08:00').getTime())
  s.addTokens(999)
  const cleared = s.resetDayIfNeeded(new Date('2026-10-27T23:00:00+08:00').getTime())
  assert.equal(cleared, false)
  assert.equal(s.todayTokens, 999)
})

test('localDayKey 格式', () => {
  assert.equal(localDayKey(new Date('2026-10-27T10:00:00+08:00').getTime()), '2026-10-27')
})

// ================================================================ 标题缓存
group('标题缓存（回填时标题往往比会话先到）')

test('会话还没出现时，标题先存进缓存', () => {
  const s = new CardState()
  // 回填读到标题时，会话可能还没进 sessions
  const visible = s.sessionTitle('future-session', 'DSH插件开发规划讨论')
  assert.equal(visible, false, '会话不存在，暂时没有可见效果')
  assert.equal(s.titleCache.get('future-session'), 'DSH插件开发规划讨论', '但必须记下来')
})

test('会话出现时自动套上缓存的标题', () => {
  const s = new CardState()
  s.sessionTitle('future-session', 'DSH插件开发规划讨论')
  s.sessionAdded({ sessionId: 'future-session', running: true, blank: false, cwd: 'C:\\x\\DSH boll' })
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.sessions[0].title, 'DSH插件开发规划讨论',
    '必须用缓存的真标题，不能用 cwd 兜底')
})

test('标题被改时用最新的', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.sessionTitle('a', '真标题')
  s.sessionTitle('a', '改过的标题')
  const snap = s.snapshot({ now: at(5) })
  assert.equal(snap.tasks.sessions[0].title, '改过的标题')
})

test('会话存在时后到的标题能补上', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  assert.equal(s.sessions.get('a').title, null)
  s.sessionTitle('a', '后到的标题')
  assert.equal(s.sessions.get('a').title, '后到的标题')
})

test('空标题不会污染缓存', () => {
  const s = new CardState()
  s.sessionTitle('a', '')
  s.sessionTitle('a', '   ')
  s.sessionTitle('a', null)
  s.sessionTitle('a', undefined)
  assert.equal(s.titleCache.has('a'), false)
})

test('标题也留在 titleCache 里（会话被淘汰后能恢复）', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.sessionTitle('a', '某标题')
  assert.equal(s.titleCache.get('a'), '某标题')
})

// ================================================================ 边界
group('边界情况（不能让插件崩）')

test('sessionAdded 缺 sessionId 不出错', () => {
  const s = new CardState()
  assert.equal(s.sessionAdded({}), false)
  assert.equal(s.sessionAdded(null), false)
})

test('sessionStatus 一个没见过的会话也能处理', () => {
  const s = new CardState()
  s.sessionStatus('ghost', true)
  assert.equal(s.snapshot({ now: at(5) }).tasks.running, 1)
})

test('sessionRemoved 之后不会复活', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: false, blank: true })
  s.sessionRemoved('a')
  s.sessionTitle('a', '迟到的事件')
  assert.equal(s.sessions.has('a'), false)
})

test('超过 maxSessions 会淘汰空闲会话', () => {
  const s = new CardState({ maxSessions: 5 })
  for (let i = 0; i < 20; i++) {
    s.sessionAdded({ sessionId: `idle-${i}`, running: false, blank: true })
  }
  assert.ok(s.sessions.size <= 5, `实际 ${s.sessions.size}`)
})

test('运行中的会话不会被淘汰掉', () => {
  const s = new CardState({ maxSessions: 3 })
  s.sessionAdded({ sessionId: 'running-one', running: true, blank: false })
  for (let i = 0; i < 10; i++) {
    s.sessionAdded({ sessionId: `idle-${i}`, running: false, blank: true })
  }
  assert.ok(s.sessions.has('running-one'), '运行中的必须留着')
})

test('重复 added 同一会话不会建两条', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  assert.equal(s.sessions.size, 1)
  assert.equal(s.snapshot({ now: at(5) }).tasks.running, 1)
})

test('snapshot 可以反复调用，结果稳定', () => {
  const s = new CardState()
  s.sessionAdded({ sessionId: 'a', running: true, blank: false })
  const a = s.snapshot({ now: at(10) })
  const b = s.snapshot({ now: at(10) })
  assert.deepEqual(a, b)
})

// ================================================================ 汇总
process.stdout.write(`\n${'='.repeat(50)}\n`)
process.stdout.write(`通过 ${passed}   失败 ${failed}\n`)
if (failed > 0) {
  process.stdout.write('\n失败详情：\n')
  for (const f of failures) {
    process.stdout.write(`\n  ${f.name}\n  ${f.error && f.error.stack}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write('全部通过 ✅\n')
}
