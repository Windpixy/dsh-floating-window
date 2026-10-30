// 端到端验证：卡片崩掉后，插件会不会把它自动救回来
//
// 为什么必须端到端测：
//   单测只能证明 shouldReviveCard 的返回值对，
//   证明不了"心跳监控那个 setInterval 真的接上了它、真的去拉了进程"。
//   接线错了单测全绿、用户还是看不到卡片 —— 这类错误只有跑真的才能抓到。
//
// 怎么做：
//   1. 用**真实数据目录**起一份插件逻辑不现实（要 DSH 进程），
//      所以这里直接模拟"插件那一侧的判断 + 拉起"，走同一份 lib/launcher.js。
//   2. 造一个能"正常退出"的假卡片和一个会"崩溃"的假卡片，分别验证：
//        正常退出 -> 不重启
//        崩溃     -> 真的把进程拉起来
//
// 跑法：node test/revive-e2e.mjs

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkHeartbeat, shouldReviveCard, ensureCardRunning } from '../lib/launcher.js'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

const TMP = join(tmpdir(), 'dsh-revive-e2e')
const PANEL = join(TMP, 'panel')
const DATA = join(TMP, 'data')

function fresh() {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(PANEL, { recursive: true })
  mkdirSync(DATA, { recursive: true })
}

/** 一个真的会跑起来的"假卡片"：写心跳然后一直活着 */
const FAKE_ALIVE = `
$hb = Join-Path $env:DSH_CARD_DATA_DIR 'heartbeat.json'
for ($i = 0; $i -lt 120; $i++) {
  $o = [ordered]@{ pid = $PID; hwnd = 0; alive = $true; dataDir = $env:DSH_CARD_DATA_DIR;
                   updatedAtMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
  [System.IO.File]::WriteAllText($hb, ($o | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Start-Sleep -Milliseconds 300
}
`

console.log('='.repeat(58))
console.log('端到端：卡片崩掉后能否自动救回来')
console.log('='.repeat(58))

// ---------------------------------------------------------------- 场景 1：崩溃 -> 重开
console.log('\n--- 场景 1：卡片崩掉（alive=true 但心跳停了）---')
{
  fresh()
  writeFileSync(join(PANEL, 'Panel.ps1'), FAKE_ALIVE, 'utf8')
  // 伪造一份"崩溃现场"：alive 仍是 true，时间戳停在 30 秒前。
  // 这正是 v0.5.1 事故留在磁盘上的样子。
  const crashStamp = Date.now() - 30000
  writeFileSync(join(DATA, 'heartbeat.json'), JSON.stringify({
    pid: 999999, hwnd: 12345, alive: true, dataDir: DATA, updatedAtMs: crashStamp,
  }), 'utf8')

  const hb = checkHeartbeat(DATA, { staleMs: 8000 })
  check('识别出崩溃', hb.crashed === true, hb.reason)

  const verdict = shouldReviveCard(hb, {
    wasAlive: true, lastCrashedAt: 0, reviveCount: 0, autoLaunch: true, reviving: false,
  })
  check('判断出应该重开', verdict.revive === true, verdict.reason)

  if (verdict.revive) {
    const r = await ensureCardRunning({ panelDir: PANEL, dataDir: DATA, log: () => {}, waitMs: 6000, staleMs: 8000 })
    check('真的把卡片拉起来了', r.launched === true, JSON.stringify({ reason: r.reason, mode: r.mode }))
    const hb2 = checkHeartbeat(DATA, { staleMs: 8000 })
    check('拉起后心跳恢复正常', hb2.alive === true, `pid=${hb2.pid}`)
    check('新心跳的 pid 和崩溃前那个不同', hb2.pid !== 999999, `old=999999 new=${hb2.pid}`)

    // 收尾：杀掉这个假卡片
    try { process.kill(hb2.pid) } catch { /* ignore */ }
    await new Promise(r2 => setTimeout(r2, 400))
  }
}

// ---------------------------------------------------------------- 场景 2：正常退出 -> 不重开
console.log('\n--- 场景 2：用户右键「退出」（alive=false）---')
{
  fresh()
  writeFileSync(join(PANEL, 'Panel.ps1'), FAKE_ALIVE, 'utf8')
  writeFileSync(join(DATA, 'heartbeat.json'), JSON.stringify({
    pid: 999998, hwnd: 0, alive: false, dataDir: DATA, updatedAtMs: Date.now() - 500,
  }), 'utf8')

  const hb = checkHeartbeat(DATA, { staleMs: 8000 })
  check('识别为正常退出，不是崩溃', hb.crashed === undefined || hb.crashed === false, hb.reason)

  const verdict = shouldReviveCard(hb, {
    wasAlive: true, lastCrashedAt: 0, reviveCount: 0, autoLaunch: true, reviving: false,
  })
  check('判断出不该重开（尊重用户意愿）', verdict.revive === false, verdict.reason)

  // 等一会儿确认真的没有新进程冒出来
  await new Promise(r2 => setTimeout(r2, 1500))
  const hb2 = checkHeartbeat(DATA, { staleMs: 8000 })
  check('确实没有把卡片重新拉起来', hb2.alive === false, hb2.reason)
}

// ---------------------------------------------------------------- 场景 3：崩溃后恢复上限
console.log('\n--- 场景 3：反复崩溃不会无限刷进程 ---')
{
  fresh()
  const stamps = []
  let lastCrashedAt = 0
  let reviveCount = 0
  // 模拟：卡片每崩一次，插件救一次；救起来又崩。看会不会停手。
  for (let i = 0; i < 6; i++) {
    const stamp = Date.now() - 30000 + i * 1000
    const hb = { alive: false, crashed: true, updatedAtMs: stamp, reason: '崩' }
    const v = shouldReviveCard(hb, { wasAlive: true, lastCrashedAt, reviveCount, autoLaunch: true, reviving: false })
    if (v.revive) { reviveCount++; lastCrashedAt = v.stamp; stamps.push(i) }
  }
  check('连续崩溃最多只救 3 次', reviveCount === 3, `实际救了 ${reviveCount} 次`)
  check('第 4 次起停手', stamps.length === 3, `救了第 ${stamps.join(',')} 次`)
}

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
