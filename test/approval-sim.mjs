/**
 * test/approval-sim.mjs -- 验证审批处理链路（不依赖真人点审批）
 *
 * 为什么要这个：
 *   真实审批从出现到被允许只隔几秒，用肉眼观察卡片来不及。
 *   而 approval/asked → approval/decided 之间那一段才是卡片该变红的时候。
 *
 * 这个脚本直接驱动 CardState + StateWriter，模拟"审批出现后停留 3 秒"，
 * 验证 state.json 里 approval.pending 确实会变成 1，然后归 0。
 *
 * 跑法：node test/approval-sim.mjs [输出目录]
 */

import { CardState } from '../lib/state.js'
import { StateWriter } from '../lib/writer.js'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const outDir = process.argv[2] || join(tmpdir(), 'dsh-card-approval-test')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const log = (m, e) => console.log(`  ${m}${e ? ' ' + JSON.stringify(e) : ''}`)

console.log('='.repeat(60))
console.log('审批链路验证')
console.log('='.repeat(60))
console.log('输出目录:', outDir, '\n')

const state = new CardState()
const writer = new StateWriter({ dir: outDir, throttleMs: 100, log })
const readState = () => JSON.parse(readFileSync(join(outDir, 'state.json'), 'utf8'))

let failed = 0
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    console.log(`  ❌ ${name}  ${detail ?? ''}`)
    failed++
  }
}

// ---------------- 场景：一个任务在跑，然后出现审批

console.log('\n[1] 建立运行中的任务')
state.sessionAdded({ sessionId: 'sess-A', running: true, blank: false, cwd: 'C:\\proj\\app' })
state.sessionTitle('sess-A', '重构登录模块')
state.toolCall('sess-A', 'pwsh', '{"command":"rm -rf ./tmp"}')
writer.write(state.snapshot(), { urgent: true })

let s = readState()
check('running = 1', s.tasks.running === 1, `实际 ${s.tasks.running}`)
check('标题正确', s.tasks.sessions[0].title === '重构登录模块', `实际 ${s.tasks.sessions[0].title}`)
check('无待审批', s.approval.pending === 0, `实际 ${s.approval.pending}`)

console.log('\n[2] 审批出现（模拟 approval/asked）')
state.approvalAsked({
  id: 'ap-001',
  sessionId: 'sess-A',
  toolName: 'pwsh',
  reason: '删除 3 个临时文件',
})
// 审批是急事，插件里用的是 urgent 立刻写盘
writer.write(state.snapshot(), { urgent: true })

s = readState()
check('待审批 = 1', s.approval.pending === 1, `实际 ${s.approval.pending}`)
check('有审批文字', typeof s.approval.items[0]?.title === 'string' && s.approval.items[0].title.length > 0,
  `实际 ${JSON.stringify(s.approval.items)}`)
console.log(`     审批文字: 「${s.approval.items[0]?.title}」`)

console.log('\n[3] 保持 3 秒（卡片这段时间应该是红点状态）')
const snapshotDuringApproval = readState()
console.log(`     approval.pending = ${snapshotDuringApproval.approval.pending}（卡片应显示红点）`)
console.log('     ^ 这就是"待审批"状态在 state.json 里的样子')

console.log('\n[4] 审批被允许（模拟 approval/decided）')
state.approvalDecided('ap-001')
writer.write(state.snapshot(), { urgent: true })

s = readState()
check('待审批归零', s.approval.pending === 0, `实际 ${s.approval.pending}`)
check('审批列表清空', s.approval.items.length === 0)

console.log('\n[5] 任务跑完后，卡片应显示"已完成"绿点 8 秒')
state.sessionStatus('sess-A', false)
writer.write(state.snapshot(), { urgent: true })

s = readState()
check('running 归零', s.tasks.running === 0, `实际 ${s.tasks.running}`)
check('lastFinished 有值（触发绿点）', s.lastFinished !== null, `实际 ${s.lastFinished}`)
console.log(`     lastFinished = ${s.lastFinished}`)

// ---------------- 最终文件内容
console.log('\n' + '='.repeat(60))
console.log('最终 state.json：')
console.log(readFileSync(join(outDir, 'state.json'), 'utf8'))

console.log('='.repeat(60))
if (failed === 0) {
  console.log('✅ 审批链路全部通过')
} else {
  console.log(`❌ ${failed} 项失败`)
  process.exitCode = 1
}
writer.dispose()
