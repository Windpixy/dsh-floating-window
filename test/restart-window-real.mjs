/**
 * test/restart-window-real.mjs -- C3 真实进程验证：等旧卡片退出，再起新的
 *
 * ===========================================================================
 * ⚠️ 这个测试会**创建真实 PowerShell 进程并强杀它**
 * ===========================================================================
 *
 * 【它做什么】
 *   1. 在 %TEMP%\dsh-c3-real\ 造一个隔离数据目录
 *   2. 起一个**假的"旧卡片"**：一个只写心跳、不建窗口的 PowerShell 进程
 *      （不是真卡片 —— 不碰你的桌面，不弹窗）
 *   3. 强杀它（模拟"代码更新时杀掉旧卡片"）
 *   4. 用 waitForPreviousCardExit 等它退出
 *   5. 测量等待时长，验证：
 *      · 旧进程真的没了才放行
 *      · 不会无限等（有超时）
 *      · 心跳过期路径也走得通
 *
 * 【它不做什么（重要）】
 *   · **不启动真卡片**（不弹窗、不碰你的悬浮窗）
 *   · **不碰真实数据目录**（全程 %TEMP%）
 *   · **不杀任何不是自己起的进程**（只 kill 自己 spawn 的 PID）
 *
 * 【为什么要用"假卡片"而不是真卡片】
 *   真卡片会弹窗、会抢焦点、会写真实位置文件。
 *   而 C3 要验证的是"等待逻辑对不对"，不是"卡片能不能显示"。
 *   用一个只写心跳的最小 PowerShell 进程，既真实（真进程、真 PID、真 kill）
 *   又不打扰用户。
 *
 * 跑法：node test/restart-window-real.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  waitForPreviousCardExit,
  judgePreviousCardGone,
  isProcessAlive,
  checkHeartbeat,
  DEFAULT_EXIT_WAIT_MS,
} from '../lib/launcher.js'

let failed = 0
let passed = 0
const group = (n) => console.log(`\n=== ${n} ===`)
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

const TMP = join(tmpdir(), 'dsh-c3-real')
const DATA = join(TMP, 'data')

console.log('='.repeat(70))
console.log('C3 真实进程验证：等待旧卡片退出')
console.log('='.repeat(70))
console.log('⚠️  会创建并强杀一个假的"旧卡片"进程（只写心跳，不弹窗）')
console.log('  数据目录: ' + DATA)
console.log('  不会碰你的真实数据目录，不会启动真卡片')

// ---------------------------------------------------------------- 环境准备
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
mkdirSync(DATA, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 起一个"假卡片"：只写心跳，然后一直活着。
 * 心跳格式与 Panel.ps1 的 Write-Heartbeat 一致。
 */
function spawnFakeCard(dataDir) {
  const ps = `
$dir = '${dataDir.replace(/\\/g, '\\\\')}'
$stamp = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
while ($true) {
    $o = [ordered]@{
        pid = $PID
        hwnd = 0
        alive = $true
        dataDir = $dir
        updatedAtMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        scriptStampMs = $stamp
    }
    $json = ($o | ConvertTo-Json -Compress)
    $tmp = Join-Path $dir 'heartbeat.json.tmp'
    $dst = Join-Path $dir 'heartbeat.json'
    try {
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -Force $tmp $dst
    } catch { }
    Start-Sleep -Milliseconds 300
}
`
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    stdio: 'ignore',
    windowsHide: true,
  })
  return child
}

/** 等心跳文件出现（最多等 timeoutMs） */
async function waitForHeartbeatFile(dataDir, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(join(dataDir, 'heartbeat.json'))) {
      const hb = checkHeartbeat(dataDir, { staleMs: 60000 })
      if (hb.alive === true && hb.pid) return hb
    }
    await sleep(150)
  }
  return null
}

let fakePid = null
let child = null

try {
  // ================================================================ 1. 起假卡片
  group('1. 起一个假的"旧卡片"进程')

  child = spawnFakeCard(DATA)
  const hb0 = await waitForHeartbeatFile(DATA)
  check('假卡片写出了心跳', hb0 !== null, hb0 ? `pid=${hb0.pid}` : '超时')
  if (!hb0) throw new Error('假卡片没能启动，后面测不了')

  fakePid = hb0.pid
  check('心跳里的 pid 与 spawn 的进程一致', Number(fakePid) === Number(child.pid),
    `心跳=${fakePid} spawn=${child.pid}`)
  check('心跳写着 alive=true', hb0.alive === true)
  check('isProcessAlive 确认它活着', isProcessAlive(fakePid) === true)

  // ================================================================ 2. 强杀它
  group('2. 强杀它（模拟代码更新时停止旧卡片）')

  const killedAt = Date.now()
  try {
    process.kill(Number(fakePid))
  } catch (e) {
    check('强杀成功', false, e.message)
  }
  check('强杀调用完成', true)

  // 等它真的消失（进程退出有延迟）
  let goneAt = null
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    if (isProcessAlive(Number(fakePid)) === false) { goneAt = Date.now(); break }
  }
  check('旧进程确实退出了', goneAt !== null, goneAt ? `耗时 ${goneAt - killedAt}ms` : '仍在')
  check('进程退出很快（<3 秒）', goneAt !== null && (goneAt - killedAt) < 3000,
    goneAt ? `${goneAt - killedAt}ms` : 'n/a')

  // ---------------------------------------------------------------- 关键：此刻心跳是什么状态？
  const hbAfterKill = checkHeartbeat(DATA, { staleMs: 8000 })
  console.log(`     强杀后心跳：alive=${hbAfterKill.alive} reason=${hbAfterKill.reason}`)

  const verdictNow = judgePreviousCardGone({
    pidAlive: isProcessAlive(Number(fakePid)),
    hb: hbAfterKill,
    oldPid: Number(fakePid),
    now: Date.now(),
    staleMs: 8000,
  })
  console.log(`     当前判断：ready=${verdictNow.ready} —— ${verdictNow.reason}`)

  // ================================================================ 3. 等待逻辑
  group('3. waitForPreviousCardExit 真实等待')

  const waitStart = Date.now()
  const exit = await waitForPreviousCardExit({
    oldPid: Number(fakePid),
    dataDir: DATA,
    staleMs: 8000,
    timeoutMs: 12000,
    pollMs: 200,
    log: (m) => console.log('     [log] ' + m),
  })
  const waitElapsed = Date.now() - waitStart

  check('最终 ready=true（允许启动新卡片）', exit.ready === true, exit.reason)
  check('等待时长在合理范围（>0 且 < 12 秒）',
    waitElapsed >= 0 && waitElapsed < 12000, `${waitElapsed}ms`)
  check('没有触发超时', exit.timedOut === false, String(exit.timedOut))

  console.log(`     实测等待：${waitElapsed}ms`)

  // 【这个数字是本卡最重要的观测值】
  //   老流程固定等 1200ms，但那时心跳还是新鲜的 alive=true，
  //   新卡片会被挡住。新流程等到心跳过期（约 8 秒）才放行。
  //   所以"等待变长了"是**预期行为**，换来的是"不用再等 13 秒空窗"。
  check('等待时长覆盖了心跳过期门槛（≥7 秒，说明确实等到了心跳失效）',
    waitElapsed >= 7000,
    `实际 ${waitElapsed}ms（老流程固定 1200ms 是不够的，正是问题所在）`)

  // ================================================================ 4. 心跳失效后判断
  group('4. 心跳失效后，判断应当明确放行')

  const hbFinal = checkHeartbeat(DATA, { staleMs: 8000 })
  const verdictFinal = judgePreviousCardGone({
    pidAlive: isProcessAlive(Number(fakePid)),
    hb: hbFinal,
    oldPid: Number(fakePid),
    now: Date.now(),
    staleMs: 8000,
  })
  check('最终判断 ready=true', verdictFinal.ready === true, verdictFinal.reason)
  check('  原因写明心跳已过期或进程已退出', /过期|退出|替换|正常退出/.test(verdictFinal.reason),
    verdictFinal.reason)

  // ================================================================ 5. 超时兜底
  group('5. 超时兜底：进程假装还活着时必须能放弃')

  // 用一个"永远返回活着"的探针，验证不会无限等
  const t0 = Date.now()
  const timeoutResult = await waitForPreviousCardExit({
    oldPid: 12345,
    probePid: () => true,                       // 假装永远活着
    readHeartbeat: () => ({ alive: true, pid: 12345, updatedAtMs: Date.now() }),
    staleMs: 8000,
    timeoutMs: 1000,                            // 1 秒超时
    pollMs: 100,
  })
  const timeoutElapsed = Date.now() - t0
  check('超时后返回 ready=false', timeoutResult.ready === false, timeoutResult.reason)
  check('标记 timedOut', timeoutResult.timedOut === true)
  check('实际耗时接近超时值（1~2 秒）', timeoutElapsed >= 900 && timeoutElapsed < 2500,
    `${timeoutElapsed}ms`)

} catch (e) {
  console.log('\n❌ 测试过程异常: ' + (e && e.message))
  failed++
} finally {
  // ---------------------------------------------------------------- 清理
  group('清理')
  try {
    if (child && child.pid) {
      // 只杀自己起的进程；它可能已经被前面强杀了
      try { process.kill(child.pid) } catch { /* 已经没了 */ }
      console.log(`  · 已确保假卡片进程 ${child.pid} 结束`)
    }
  } catch { }
  try {
    rmSync(TMP, { recursive: true, force: true })
    console.log('  · 已删除临时目录 ' + TMP)
  } catch { }
  console.log('  · 未触碰真实数据目录')
}

console.log('')
console.log('='.repeat(70))
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) console.log('全部通过 ✅')
else process.exitCode = 1
console.log('='.repeat(70))
