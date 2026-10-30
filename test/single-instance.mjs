/**
 * test/single-instance.mjs -- 验证单实例保护
 *
 * 要证明两件事：
 *   1. 启动第一个卡片 -> 出现窗口、写心跳
 *   2. 立刻再启动第二个 -> 它应该自己安静退出，不出现第二个窗口
 *
 * 还要证明「僵尸不阻塞」：
 *   把心跳伪造成一个不存在的进程，再启动 —— 应该能正常起来
 *   （这正是命名 Mutex 方案会永久卡死的场景）
 *
 * 跑法：node test/single-instance.mjs
 */

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { checkHeartbeat } from '../lib/launcher.js'

const here = dirname(fileURLToPath(import.meta.url))
const PANEL_DIR = join(here, '..', 'panel')
const DATA_DIR = join(here, '_single-data')
const SCRIPT = join(PANEL_DIR, 'Panel.ps1')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function clean() {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(DATA_DIR, { recursive: true })
}

/** 启动一个卡片进程，返回 child（不 detached，方便我们控制） */
function startCard() {
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCRIPT]
  const child = spawn('powershell.exe', args, {
    cwd: PANEL_DIR,
    env: { ...process.env, DSH_CARD_DATA_DIR: DATA_DIR },
    stdio: 'ignore',
    windowsHide: false,
    detached: false,
  })
  child.on('error', () => {})
  return child
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

let failed = 0
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✅ ${name}`)
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

console.log('='.repeat(60))
console.log('单实例保护测试')
console.log('='.repeat(60))
console.log('dataDir:', DATA_DIR)
console.log('')

// ---------------- 1. 第一个实例
console.log('[1] 启动第一个卡片')
clean()
const c1 = startCard()
await sleep(7000)
const hb1 = checkHeartbeat(DATA_DIR)
check('第一个实例写出心跳', hb1.alive === true, hb1.reason)
if (hb1.alive) console.log(`     pid=${hb1.pid} hwnd=${hb1.hwnd}`)

// ---------------- 2. 第二个实例应该自己退出
console.log('\n[2] 心跳新鲜时再启动第二个（应自己退出）')
const c2 = startCard()
await sleep(5000)
check('第二个进程已退出', alive(c2.pid) === false, `仍然活着 pid=${c2.pid}`)

const hb2 = checkHeartbeat(DATA_DIR)
check('心跳还是第一个实例的', hb2.alive === true && hb2.pid === hb1.pid,
  `hb1.pid=${hb1.pid} hb2.pid=${hb2.pid}`)

// ---------------- 3. 僵尸心跳不阻塞
console.log('\n[3] 伪造成"僵尸心跳"（进程号不存在 + 心跳已过期 30 秒），再启动')
try { process.kill(c1.pid) } catch { /* ignore */ }
await sleep(2500)

// 关键：陈旧的心跳 —— 模拟"进程被强杀，心跳文件留在那儿没更新"
// 命名 Mutex 方案在这个场景下会永久卡死，心跳方案能自愈
const fakePid = 999999
writeFileSync(join(DATA_DIR, 'heartbeat.json'), JSON.stringify({
  pid: fakePid, hwnd: 0, alive: true, updatedAtMs: Date.now() - 30000,
}), 'utf8')
check('假心跳按 8 秒标准判定为已退出',
  checkHeartbeat(DATA_DIR, { staleMs: 8000 }).alive === false)

const c3 = startCard()
await sleep(7000)
const hb3 = checkHeartbeat(DATA_DIR, { staleMs: 8000 })
check('僵尸心跳过期后新实例能起来', hb3.alive === true && hb3.pid !== fakePid,
  `hb3.pid=${hb3.pid}`)

// ---------------- 清理
console.log('\n[清理]')
for (const c of [c1, c2, c3]) {
  try { process.kill(c.pid) } catch { /* ignore */ }
}
await sleep(1000)
try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }

console.log('\n' + '='.repeat(60))
if (failed === 0) { console.log('✅ 单实例保护全部通过'); process.exitCode = 0 }
else { console.log(`❌ ${failed} 项失败`); process.exitCode = 1 }
