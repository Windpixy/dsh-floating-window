// 测量：卡片从进程启动到写出第一份心跳，到底要多久
//
// 为什么需要这个数：
//   plugin.log 里出现过"两种启动策略都没成功"，但卡片其实是活的。
//   怀疑是 launcher.js 里 `waitMs: 6000`（等 6 秒看心跳）太短，
//   而卡片启动要先 Add-Type 加载 WPF 程序集 + 编译内嵌 C#（DshWin 类），
//   这些都挺慢。如果真实耗时 > 6 秒，插件就会误判"没启动"。
//
// 这个脚本重复起 3 次卡片，每次都精确记录：
//   进程创建时间 -> 心跳文件第一次出现的时间
//
// 跑法：node test/measure-startup.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const PANEL_DIR = join(ROOT, 'panel')
const PANEL = join(PANEL_DIR, 'Panel.ps1')

const TMP = join(tmpdir(), 'dsh-measure-startup')
const DATA = join(TMP, 'data')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log('='.repeat(60))
console.log('卡片启动耗时测量（进程创建 -> 首份心跳）')
console.log('='.repeat(60))

const samples = []

for (let round = 1; round <= 3; round++) {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(DATA, { recursive: true })
  copyFileSync(join(PANEL_DIR, 'settings.json'), join(DATA, 'settings.json'))

  // 写一份能显示"运行中"的 state，让卡片走正常渲染路径
  const o = {
    updatedAt: Math.floor(Date.now() / 1000),
    tasks: { running: 1, sessions: [{ title: '测量', elapsedSec: 10, activity: '处理中' }] },
    approval: { pending: 0, items: [] },
    lastFinished: null,
    tokens: { today: 16900000 },
    valley: { inValley: true, remainingSec: 1800, reason: 'off-window' },
  }
  writeFileSync(join(DATA, 'state.json'), JSON.stringify(o, null, 2), 'utf8')

  const hbPath = join(DATA, 'heartbeat.json')
  if (existsSync(hbPath)) rmSync(hbPath)

  const args = [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-File', PANEL,
  ]
  const t0 = Date.now()
  const child = spawn('powershell.exe', args, {
    cwd: PANEL_DIR,
    env: { ...process.env, DSH_CARD_DATA_DIR: DATA },
    stdio: 'ignore',
    windowsHide: false,
    detached: false,
  })

  // 轮询等心跳出现
  let firstSeenAt = null
  let firstContent = null
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await sleep(50)
    if (existsSync(hbPath)) {
      try {
        const j = JSON.parse(readFileSync(hbPath, 'utf8'))
        // 必须是这个进程写的（pid 对得上），排除上个残留
        if (j && j.pid === child.pid) {
          firstSeenAt = Date.now()
          firstContent = j
          break
        }
      } catch { /* 正在写，下一轮再试 */ }
    }
  }

  const elapsed = firstSeenAt ? firstSeenAt - t0 : null
  console.log(`\n第 ${round} 次：`)
  console.log(`  进程 pid = ${child.pid}`)
  console.log(`  首份心跳耗时 = ${elapsed === null ? '30 秒内没出现！' : elapsed + ' ms'}`)
  if (firstContent) console.log(`  心跳内容 = alive=${firstContent.alive} hwnd=${firstContent.hwnd}`)
  if (elapsed !== null) samples.push(elapsed)

  try { process.kill(child.pid) } catch { /* ignore */ }
  await sleep(1200)
}

try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

console.log('')
console.log('='.repeat(60))
if (samples.length > 0) {
  const max = Math.max(...samples)
  const min = Math.min(...samples)
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  console.log(`样本 ${samples.length} 个：${samples.join(' / ')} ms`)
  console.log(`最短 ${min} ms   最长 ${max} ms   平均 ${avg} ms`)
  console.log('')
  const WAIT_MS = 6000
  if (max >= WAIT_MS) {
    console.log(`⚠️  最长 ${max} ms >= 当前等待上限 ${WAIT_MS} ms —— 会误报"启动失败"`)
  } else {
    console.log(`当前等待上限 ${WAIT_MS} ms 够用（最长才 ${max} ms）`)
  }
  console.log(`建议等待上限至少设为 ${max * 2} ms（留一倍余量）`)
} else {
  console.log('三次都没测到心跳，说明卡片根本没起来')
}
console.log('='.repeat(60))
