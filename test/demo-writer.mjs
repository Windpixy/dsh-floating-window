/**
 * test/demo-writer.mjs -- M1 验证工具
 *
 * 用真实的 demo.js + writer.js + state.js 模块，把假数据写进指定目录，
 * 用来验证「插件写出来的 state.json 卡片到底能不能正常显示」。
 *
 * 用法：
 *   node test/demo-writer.mjs <输出目录>
 *
 * 它和插件走的是同一套代码，所以能证明格式兼容性。
 */

import { CardState } from '../lib/state.js'
import { StateWriter } from '../lib/writer.js'
import { startDemo } from '../lib/demo.js'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const outDir = process.argv[2]
if (!outDir) {
  console.error('用法: node test/demo-writer.mjs <输出目录>')
  process.exit(1)
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const log = (msg, extra) => {
  const t = new Date().toISOString().slice(11, 19)
  console.log(`[${t}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`)
}

const state = new CardState({ showSubagentSessions: false })
const writer = new StateWriter({ dir: outDir, throttleMs: 300, log })

const push = (urgent = false) => {
  const snap = state.snapshot()
  writer.write(snap, { urgent })
  return snap
}

// 演示循环
const demo = startDemo(state, {
  log,
  onChange: () => push(true),
})

// 每秒补推一次（和插件里的 tick 行为一致）
const tick = setInterval(() => push(false), 1000)

// 每 10 秒打一份快照细节，方便核对
const report = setInterval(() => {
  const snap = push(false)
  log('当前状态', {
    step: demo.current(),
    running: snap.tasks.running,
    approval: snap.approval.pending,
    tokens: snap.tokens.today,
    lastFinished: snap.lastFinished,
    firstTitle: snap.tasks.sessions[0]?.title ?? null,
  })
}, 10000)

log(`演示数据开始写入 → ${join(outDir, 'state.json')}`)

const stop = () => {
  clearInterval(tick)
  clearInterval(report)
  demo.stop()
  writer.flushNow()
  log('已停止')
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

// 最多跑 3 分钟自动停
setTimeout(stop, 180000)
