// 最贴近现实的一测：让真实卡片崩一次，看它能否自己回来
//
// 前面 revive-e2e.mjs 测的是"插件判断对了、进程拉起来了"，
// 但用的是假卡片。这里用**真卡片 Panel.ps1** 走完整流程：
//
//   1. 起一张真卡片（独立数据目录，不影响用户那张）
//   2. 强杀它 —— 模拟崩溃。
//      注意不能用"右键退出"，那是正常退出，本来就不该重开。
//      强杀不会走到 $app.Add_Exit，所以心跳会停在 alive=true，
//      这正是崩溃现场的样子。
//   3. 跑一段和 index.js 里心跳监控等价的循环
//   4. 检查卡片是否自己回来了
//
// 跑法：node test/revive-real-card.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, copyFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { checkHeartbeat, shouldReviveCard, ensureCardRunning } from '../lib/launcher.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const PANEL_DIR = join(ROOT, 'panel')

const TMP = join(tmpdir(), 'dsh-revive-real')
const DATA = join(TMP, 'data')

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

const nowSec = () => Math.floor(Date.now() / 1000)

function writeState() {
  const o = {
    updatedAt: nowSec(),
    tasks: { running: 1, sessions: [{ title: '任务', elapsedSec: 100, activity: '处理中' }] },
    approval: { pending: 0, items: [] },
    lastFinished: null,
    tokens: { today: 16900000 },
    valley: { inValley: true, remainingSec: 1800, reason: 'off-window' },
  }
  const tmp = join(DATA, 'state.json.tmp')
  writeFileSync(tmp, JSON.stringify(o, null, 2), 'utf8')
  copyFileSync(tmp, join(DATA, 'state.json'))
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log('='.repeat(58))
console.log('真卡片崩溃后能否自动恢复')
console.log('='.repeat(58))

try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
mkdirSync(DATA, { recursive: true })
copyFileSync(join(PANEL_DIR, 'settings.json'), join(DATA, 'settings.json'))
writeState()

process.env.DSH_CARD_DATA_DIR = DATA

// ---------------------------------------------------------------- 1. 起真卡片
console.log('\n--- 1. 启动一张真卡片 ---')
const launch1 = await ensureCardRunning({
  panelDir: PANEL_DIR, dataDir: DATA, log: () => {}, waitMs: 12000, staleMs: 8000,
})
const hb1 = checkHeartbeat(DATA, { staleMs: 8000 })
check('真卡片启动成功', hb1.alive === true, `pid=${hb1.pid} mode=${launch1.mode}`)
if (!hb1.alive) {
  console.log('\n卡片没起来，后面的测试没法进行。先手动跑 panel\\run-panel.bat 看报错。')
  process.exit(1)
}
const firstPid = hb1.pid

// 让它多跑两秒，确认稳定（也能观察它不是"起来就崩"）
await sleep(2200)
const hbStable = checkHeartbeat(DATA, { staleMs: 8000 })
check('卡片稳定运行（不是起来就崩）', hbStable.alive === true, `pid=${hbStable.pid}`)

// ---------------------------------------------------------------- 2. 强杀 = 模拟崩溃
console.log('\n--- 2. 强杀卡片（等价于 v0.5.1 那次异常退出）---')
try { process.kill(firstPid) } catch (e) { console.log('  kill 失败: ' + e.message) }

// 【为什么必须等 9 秒以上】
//   插件的判据是"心跳超过 8 秒没更新才算没了"。
//   进程被杀之后，磁盘上那份心跳还写着 alive=true、时间戳停在死亡瞬间，
//   要等它自然过期（>8s）才能判定。等 1.5 秒去查，结论一定是"心跳正常"——
//   第一版就是这么写的，白报了 3 个假失败。
console.log('  （等待心跳过期，需 >8 秒）')
await sleep(9500)

const hbDead = checkHeartbeat(DATA, { staleMs: 8000 })
check('心跳检测到卡片没了', hbDead.alive === false, hbDead.reason)
check('判定为崩溃而不是正常退出', hbDead.crashed === true, '（alive=true 但心跳停了 = 被硬杀）')

// ---------------------------------------------------------------- 3. 模拟插件的心跳监控
console.log('\n--- 3. 跑插件那套心跳监控逻辑 ---')
let wasAlive = true
let lastCrashedAt = Date.now() - 120000   // 插件启动时间
let reviveCount = 0
let reviving = false
let revived = false

// 和 index.js 里那个 setInterval 一模一样的判断顺序
for (let round = 0; round < 12; round++) {
  const hb = checkHeartbeat(DATA, { staleMs: 8000 })
  const verdict = shouldReviveCard(hb, {
    wasAlive, lastCrashedAt, reviveCount, maxRevive: 3, autoLaunch: true, reviving,
  })
  if (verdict.log) console.log(`     [插件日志] ${verdict.log}`)
  if (verdict.revive) {
    lastCrashedAt = verdict.stamp
    reviveCount++
    reviving = true
    console.log(`     [插件日志] 正在自动恢复卡片（第 ${reviveCount} 次）…`)
    const r = await ensureCardRunning({
      panelDir: PANEL_DIR, dataDir: DATA, log: () => {}, waitMs: 12000, staleMs: 8000,
    })
    console.log(`     [插件日志] 自动恢复结果: ${JSON.stringify({ ok: r.ok, launched: r.launched, reason: r.reason })}`)
    if (!r.ok) { lastCrashedAt = 0; reviveCount = Math.max(0, reviveCount - 1) }
    reviving = false
    if (r.ok && r.launched) { revived = true; break }
  }
  wasAlive = hb.alive
  await sleep(1000)
}

check('插件把卡片自动救回来了', revived === true, `恢复尝试 ${reviveCount} 次`)

const hb2 = checkHeartbeat(DATA, { staleMs: 8000 })
check('恢复后心跳正常', hb2.alive === true, `pid=${hb2.pid}`)
check('恢复后是新进程（不是原来那个）', hb2.pid !== firstPid, `old=${firstPid} new=${hb2.pid}`)

// ---------------------------------------------------------------- 4. 恢复后的卡片窗口真的在
console.log('\n--- 4. 恢复后的卡片窗口确实存在 ---')
// 卡片写心跳时是先写 hwnd=0，等窗口创建出来（约 2~4 秒）才写真实句柄，
// 所以要轮询等，不能睡一个固定值就断言。
let hwnd = 0
for (let i = 0; i < 15; i++) {
  await sleep(700)
  const h = checkHeartbeat(DATA, { staleMs: 8000 })
  hwnd = Number(h.hwnd ?? 0)
  if (hwnd > 0) break
}
check('恢复后写入了窗口句柄', hwnd > 0, `hwnd=${hwnd}`)

// 用 PS 检查这个 hwnd 是否真是一个可见窗口
if (hwnd > 0) {
  const ps = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CK { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }
'@
$h = [IntPtr]${hwnd}
"isWindow=$([CK]::IsWindow($h)) visible=$([CK]::IsWindowVisible($h))"
`
  const out = await new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] })
    let s = ''
    p.stdout.on('data', d => { s += d.toString() })
    p.on('close', () => resolve(s.trim()))
    p.on('error', () => resolve('ERR'))
  })
  check('恢复后的窗口真的可见', out.includes('isWindow=True') && out.includes('visible=True'), out)
}

// ---------------------------------------------------------------- 5. 收尾：正常退出不该重开
console.log('\n--- 5. 对照：正常退出不该被重开 ---')
const hb3 = checkHeartbeat(DATA, { staleMs: 8000 })
try { process.kill(hb3.pid) } catch { /* ignore */ }
await sleep(800)
// 手工把心跳改成"正常退出"的样子（真实场景里 $app.Add_Exit 会这么写）
writeFileSync(join(DATA, 'heartbeat.json'), JSON.stringify({
  pid: hb3.pid, hwnd: 0, alive: false, dataDir: DATA, updatedAtMs: Date.now(),
}), 'utf8')
const hbClosed = checkHeartbeat(DATA, { staleMs: 8000 })
const v = shouldReviveCard(hbClosed, {
  wasAlive: true, lastCrashedAt: 0, reviveCount: 0, autoLaunch: true, reviving: false,
})
check('正常退出判定为不该重开', v.revive === false, v.reason)

try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

console.log('')
console.log('='.repeat(58))
const pass = results.filter(r => r.pass).length
const fail = results.length - pass
console.log(`通过 ${pass}   失败 ${fail}`)
if (fail === 0) {
  console.log('全部通过 ✅')
} else {
  console.log('有失败项')
  process.exitCode = 1
}
console.log('='.repeat(58))
