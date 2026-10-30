/**
 * test/launch-live.mjs -- 真实启动一次卡片，验证拉起逻辑
 *
 * 为什么单独测：拉起这件事「说成功」很容易，「真的出现窗口 + 写出心跳」才是成功。
 * 之前踩过两个坑（路径空格、子进程被连带杀掉），必须眼见为实。
 *
 * 两个容易误判的地方：
 *   1. 卡片启动要 2~5 秒才写第一次心跳，不能刚 spawn 完就查
 *   2. 带沙箱的终端启动的子进程写不了工作区外的路径，
 *      所以默认用工作区里的临时目录测（加 --real 用真实目录）
 *
 * 跑法：node test/launch-live.mjs
 */

import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureCardRunning, checkHeartbeat, panelScriptPath } from '../lib/launcher.js'

const USE_REAL = process.argv.includes('--real')
const here = dirname(fileURLToPath(import.meta.url))

const DATA_DIR = USE_REAL
  ? join(homedir(), '.dsh', 'desktop-card')
  : join(here, '_cardtest-data')
const PANEL_DIR = join(here, '..', 'panel')

// 干净起步
if (!USE_REAL) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const ts = () => new Date().toLocaleTimeString('zh-CN')
const log = (msg, extra) => console.log(`[${ts()}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 轮询等心跳出现 */
async function waitHeartbeat(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hb = checkHeartbeat(DATA_DIR)
    if (hb.alive) return hb
    await sleep(300)
  }
  return checkHeartbeat(DATA_DIR)
}

let failed = 0
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✅ ${name}`)
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

console.log('='.repeat(60))
console.log('真实拉起测试')
console.log('='.repeat(60))
console.log('panelDir:', PANEL_DIR)
console.log('dataDir :', DATA_DIR)
console.log('Panel.ps1 存在:', existsSync(panelScriptPath(PANEL_DIR)))
console.log('')

// ---------------- 1. 第一次拉起
console.log('[1] 第一次拉起（此时卡片没在跑）')
const before = checkHeartbeat(DATA_DIR)
console.log('     拉起前:', before.reason)

const r1 = await ensureCardRunning({
  panelDir: PANEL_DIR,
  dataDir: DATA_DIR,
  log,
  waitMs: 6000,
})
console.log('     用了策略:', r1.mode ?? '(未启动)')
console.log('     尝试记录:', JSON.stringify(r1.tries.map(t => ({ mode: t.mode, launched: t.launched }))))
check('最终启动成功', r1.launched === true, JSON.stringify(r1))

console.log('\n[2] 确认心跳')
const hb1 = checkHeartbeat(DATA_DIR)
check('心跳出现', hb1.alive === true, hb1.reason)
if (hb1.alive) {
  console.log(`     pid=${hb1.pid} hwnd=${hb1.hwnd} 心跳龄=${hb1.ageMs}ms`)
}

// ---------------- 3. 幂等性：再调 4 次，不应重复启动
console.log('\n[3] 已有心跳时再调用 4 次（不应重复启动）')
const results = []
for (let i = 0; i < 4; i++) {
  const r = await ensureCardRunning({ panelDir: PANEL_DIR, dataDir: DATA_DIR, log: () => {}, waitMs: 2000 })
  results.push(r)
  console.log(`     第 ${i + 2} 次 -> launched=${r.launched} reason=${r.reason}`)
}
check('4 次都是 already-running', results.every(r => r.reason === 'already-running'),
  JSON.stringify(results.map(r => r.reason)))

// ---------------- 4. 心跳持续更新
console.log('\n[4] 等 3 秒，确认心跳在持续更新')
const ageBefore = checkHeartbeat(DATA_DIR).ageMs
await sleep(3000)
const hb2 = checkHeartbeat(DATA_DIR)
check('心跳仍然新鲜', hb2.alive === true, hb2.reason)
check('心跳时间在往前走（说明卡片活着）', hb2.ageMs < ageBefore + 1500,
  `之前 ${ageBefore}ms 之后 ${hb2.ageMs}ms`)

console.log('\n[5] 数据目录里应该出现这些文件')
for (const f of ['heartbeat.json', 'settings.json']) {
  const p = join(DATA_DIR, f)
  check(f, existsSync(p), '不存在')
}

console.log('\n' + '='.repeat(60))
if (failed === 0) {
  console.log('✅ 拉起逻辑全部通过')
  console.log('   注意：卡片窗口现在还开着，测完可以手动关掉，或放着不管')
  process.exitCode = 0
} else {
  console.log(`❌ ${failed} 项失败`)
  process.exitCode = 1
}
