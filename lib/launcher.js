/**
 * lib/launcher.js -- 把卡片窗口拉起来
 *
 * ---------------------------------------------------------------------------
 * 三个已经踩过的坑（都是实测踩出来的，别改回去）
 * ---------------------------------------------------------------------------
 *
 * 【坑 1】路径里有空格
 *   实测时项目放在一个带空格的目录下（形如 `C:\Users\<用户名>\My Projects\`）。
 *   用 PowerShell 的 -ArgumentList 拼命令行时如果不给路径加引号，
 *   PowerShell 会把空格前面的部分当成文件名，
 *   卡片静默起不来、没有任何报错。
 *   → 用 Node 的 spawn + **参数数组**（每个参数单独传），不拼字符串。
 *   （这条对任何带空格的安装路径都成立，不只是开发机。）
 *
 * 【坑 2】detached: true 在某些环境里会让进程秒退
 *   实测（2026-10-27，Windows 11）：从带沙箱的终端用
 *   `spawn(..., { detached: true, stdio: 'ignore' })` 启动 PowerShell，
 *   子进程活不过 1 秒，连心跳都写不出来；
 *   同一份命令换成 `detached: false` 就完全正常。
 *   但 detached 又是"DSH 关了卡片要留着"所必需的。
 *   → 所以这里做成**双策略自适应**：先试 detached（生产环境正解），
 *     等 6 秒没心跳就退回 attached（保证至少能显示出来）。
 *     用了哪种会写进日志，排查时一眼能看到。
 *
 * 【坑 3】子进程被连带杀掉
 *   卡片是常驻进程。如果它挂在 DSH 的进程树下，DSH 一退可能被带走。
 *   → detached 策略 + unref()。万一退回 attached，也至少保证
 *     插件卸载/重载时不会因为管道断开而卡死（stdio 用的是 ignore）。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_STALE_MS = 8000
const BUILD_TAG = 'm3-adaptive-2'

/**
 * 读心跳文件，判断卡片是不是还活着。
 *
 * 为什么不用"查进程名"：
 *   卡片是 powershell.exe，用户可能还开着别的 PowerShell 窗口；
 *   而且进程可能"活着但窗口没了"。心跳能同时反映这两件事。
 *
 * @param {string} dataDir
 * @param {object} [options]
 * @param {number} [options.staleMs] 心跳超过多久算过期，默认 8000（卡片每 2 秒写一次）
 * @param {() => number} [options.now]
 * @returns {{alive: boolean, reason: string, crashed?: boolean, pid?: number, hwnd?: number, ageMs?: number}}
 */
export function checkHeartbeat(dataDir, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const now = (options.now ?? Date.now)()
  const path = join(dataDir, 'heartbeat.json')

  if (!existsSync(path)) {
    return { alive: false, reason: '心跳文件不存在（卡片从没启动过）' }
  }

  let hb
  try {
    hb = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { alive: false, reason: '心跳文件读不出来（可能正在写）' }
  }

  if (!hb || hb.alive !== true) {
    return { alive: false, reason: '卡片上次是正常退出的' }
  }

  const at = Number(hb.updatedAtMs)
  if (!Number.isFinite(at)) {
    return { alive: false, reason: '心跳文件里没有时间戳' }
  }

  const ageMs = now - at
  // 用 >= 而不是 >：这个边界上宁可误判成"没在跑"。
  // 误判成没在跑 -> 多起一个进程，它会被单实例心跳挡住自己退出，无害；
  // 误判成在跑   -> 卡片永远不出来，用户看不到东西，这才难受。
  if (ageMs >= staleMs) {
    // 【crashed：区分"用户主动关掉"和"崩掉了"】
    //   卡片正常退出时会先把 alive 写成 false（见 Panel.ps1 的 $app.Add_Exit）。
    //   所以走到这里还带着 alive=true，只有一种解释：
    //   进程没能走到退出清理就被结束了 —— 崩了、被杀进程、或断电。
    //
    //   这个区分很重要：
    //     主动关掉 -> 用户不想要了，别自作聪明再拉起来
    //     崩掉了   -> 用户什么都没做，卡片却没了，应该自动救回来
    //   （v0.5.1 的真实事故就是后者：点一下卡片，卡片崩溃消失，
    //     之后等多久都不回来，因为旧逻辑对所有"没心跳"一视同仁地不管。）
    return { alive: false, crashed: true, reason: `心跳过期（${Math.round(ageMs / 1000)} 秒没更新，未正常退出）`, ageMs, updatedAtMs: at }
  }
  // 时间戳在未来超过 10 秒，说明时钟被改过，保守当作不活着
  if (ageMs < -10000) {
    return { alive: false, reason: '心跳时间戳异常（在未来）', ageMs }
  }

  return { alive: true, reason: '心跳正常', pid: hb.pid, hwnd: hb.hwnd, ageMs }
}

/** 卡片主脚本的完整路径 */
export function panelScriptPath(panelDir) {
  return join(panelDir, 'Panel.ps1')
}

/**
 * 用指定策略启动一次卡片。
 *
 * @param {object} options
 * @param {string} options.panelDir 卡片程序目录（插件里的 panel/）
 * @param {string} options.dataDir 数据目录（通过环境变量传给卡片）
 * @param {'detached'|'attached'} [options.mode] 启动策略，默认 detached
 * @param {(msg: string, extra?: unknown) => void} [options.log]
 * @param {boolean} [options.dryRun] 只检查不真启动（单测用）
 * @returns {{launched: boolean, reason: string, pid?: number, mode?: string}}
 */
export function launchCard(options) {
  const { panelDir, dataDir, log = () => {} } = options
  const mode = options.mode === 'attached' ? 'attached' : 'detached'

  const script = panelScriptPath(panelDir)
  if (!existsSync(script)) {
    const reason = `找不到卡片主程序: ${script}`
    log(reason)
    return { launched: false, reason, mode }
  }

  if (options.dryRun === true) {
    return { launched: false, reason: 'dryRun：没有真的启动', dryRun: true, mode }
  }

  // 参数一个个传，不拼字符串 —— 这样路径里的空格不会被拆开（坑 1）
  const args = [
    '-NoProfile',
    '-STA',                    // WPF 必须 STA，否则窗口起不来
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',  // 隐藏 PowerShell 自己的黑窗；不影响 WPF 窗口
    '-File', script,           // script 是数组里独立的一项，空格安全
  ]

  const env = { ...process.env, DSH_CARD_DATA_DIR: dataDir }

  const spawnOptions = {
    cwd: panelDir,
    env,
    stdio: 'ignore',
    // 注意：这里刻意不设 windowsHide。
    // 实测带这个参数时 WPF 窗口会被系统当成"应该隐藏"而不显示。
    windowsHide: false,
    detached: mode === 'detached',   // 坑 2 / 坑 3
  }

  let child
  try {
    child = spawn('powershell.exe', args, spawnOptions)
  } catch (e) {
    const reason = `启动卡片失败（${mode}）: ` + (e && e.message)
    log(reason)
    return { launched: false, reason, mode }
  }

  child.on('error', (e) => {
    log(`卡片进程报错（${mode}）: ` + (e && e.message))
  })

  if (mode === 'detached') {
    try { child.unref() } catch { /* ignore */ }
  }

  log(`已启动卡片（${mode} 策略，pid=${child.pid ?? '?'}）`, { script, dataDir })

  return { launched: true, reason: `已启动（${mode}）`, pid: child.pid, mode }
}

/** 等心跳出现 */
async function waitForHeartbeat(dataDir, timeoutMs, staleMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hb = checkHeartbeat(dataDir, { staleMs })
    if (hb.alive) return hb
    if (Date.now() >= deadline) return hb
    await new Promise(r => setTimeout(r, 250))
  }
}

/**
 * 确保卡片在跑（双策略自适应）。
 *
 * 语义：**已经跑着就什么都不做**；没跑才启动。
 * 单实例由卡片自己的 Mutex 兜底，所以即使判断错了也不会开出两个。
 *
 * @param {object} options
 * @param {string} options.panelDir
 * @param {string} options.dataDir
 * @param {(msg: string, extra?: unknown) => void} [options.log]
 * @param {number} [options.staleMs]
 * @param {number} [options.waitMs] 每种策略等多久看心跳，默认 6000
 * @param {() => number} [options.now]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{ok: boolean, launched: boolean, reason: string, mode?: string, tries: object[]}>}
 */
export async function ensureCardRunning(options) {
  const { panelDir, dataDir, log = () => {} } = options
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const waitMs = options.waitMs ?? 6000

  const hb0 = checkHeartbeat(dataDir, { staleMs, now: options.now })
  if (hb0.alive) {
    log(`卡片已在运行（pid=${hb0.pid ?? '?'}，心跳 ${Math.round((hb0.ageMs ?? 0) / 1000)} 秒前）`)
    return { ok: true, launched: false, reason: 'already-running', tries: [] }
  }

  log(`卡片没在跑：${hb0.reason}`)

  if (options.dryRun === true) {
    const r = launchCard({ panelDir, dataDir, log, dryRun: true, mode: 'detached' })
    return { ok: true, launched: false, reason: r.reason, tries: [r] }
  }

  const tries = []
  for (const mode of ['detached', 'attached']) {
    log(`尝试以 ${mode} 方式启动…`)
    const r = launchCard({ panelDir, dataDir, log, mode })
    tries.push(r)
    if (!r.launched) continue

    const hb = await waitForHeartbeat(dataDir, waitMs, staleMs)
    if (hb.alive) {
      log(`卡片启动成功（${mode} 策略，pid=${hb.pid ?? '?'}）`)
      return { ok: true, launched: true, reason: `started-${mode}`, mode, tries }
    }
    log(`${mode} 策略启动后 ${waitMs}ms 内没收到心跳：${hb.reason}，换策略重试`)
    // 换策略前稍微等一下，避免两个进程挤在一起抢 Mutex
    await new Promise(r2 => setTimeout(r2, 800))
  }

  log('两种启动策略都没成功。请手动跑 panel\\run-panel.bat 看报错。')
  return { ok: false, launched: false, reason: 'all-strategies-failed', tries }
}

/**
 * 判断"这次心跳检查之后要不要把卡片自动救回来"。
 *
 * 单独抽成纯函数的原因：这个判断涉及三种情况互相纠缠
 * （用户主动关 / 崩了 / 开机时残留的旧心跳），
 * 写在 setInterval 回调里就没法单独测，只能靠人工复现故障来验证 ——
 * 而 v0.5.1 那个崩溃事故恰恰就是"人工没复现出来"才漏出去的。
 *
 * @param {{alive: boolean, crashed?: boolean, updatedAtMs?: number}} hb
 * @param {object} state
 * @param {boolean} state.wasAlive 上一次检查时是活着的吗
 * @param {number} state.lastCrashedAt 上一次已经处理过的崩溃时间戳（去重）
 * @param {number} state.reviveCount 已经恢复过几次
 * @param {number} [state.maxRevive] 最多恢复几次，默认 3
 * @param {boolean} [state.autoLaunch] 用户是否允许自动拉起
 * @param {boolean} [state.reviving] 是否正在恢复中
 * @returns {{revive: boolean, reason: string, log?: string}}
 *   revive=true 表示这次应该去拉起卡片；
 *   log 是应该写给用户看的那句话（没有就不写）。
 */
export function shouldReviveCard(hb, state) {
  const maxRevive = state.maxRevive ?? 3
  const stamp = Number(hb.updatedAtMs ?? 0)

  // --- 情况 1：卡片正常地退出了（用户右键 -> 退出）
  // 这是用户的意愿，绝不能自动重开。只记一句话。
  if (state.wasAlive && !hb.alive && !hb.crashed) {
    return { revive: false, reason: 'user-closed', log: `卡片已退出：${hb.reason}（不会自动重开，下次 DSH 启动时会再拉起）` }
  }

  // --- 情况 2：崩了
  if (hb.crashed && state.autoLaunch !== false) {
    // 已经处理过同一个崩溃（同一个时间戳），不重复处理
    if (stamp <= state.lastCrashedAt) {
      return { revive: false, reason: 'already-handled' }
    }
    if (state.reviving === true) {
      return { revive: false, reason: 'reviving-in-progress' }
    }
    if (state.reviveCount >= maxRevive) {
      return {
        revive: false,
        reason: 'gave-up',
        log: `卡片已连续异常退出 ${maxRevive} 次，不再自动恢复。请手动运行 panel\\run-panel.bat 排查。`,
      }
    }
    return { revive: true, reason: 'crashed', stamp, log: `卡片异常退出（不是正常关闭）：${hb.reason}` }
  }

  return { revive: false, reason: 'nothing-to-do' }
}

/**
 * 停止卡片（只有在用户明确要求"关闭卡片"时才用）。
 *
 * 插件卸载时**不**调用这个 —— 交接文档明确说：DSH 关掉时卡片留着不杀。
 *
 * @param {string} dataDir
 * @returns {{stopped: boolean, reason: string}}
 */
export function stopCardByHeartbeat(dataDir) {
  const hb = checkHeartbeat(dataDir, { staleMs: 60000 })
  if (!hb.alive || !hb.pid) return { stopped: false, reason: '卡片没在跑' }
  try {
    process.kill(hb.pid)
    return { stopped: true, reason: `已结束进程 ${hb.pid}` }
  } catch (e) {
    return { stopped: false, reason: '结束进程失败: ' + (e && e.message) }
  }
}

// ================================================================ 旧代码检测（v0.9.12）
//
// 【这解决的是什么问题 —— 一个真实事故】
//   2026-10-29：Panel.ps1 改于 14:43:30，卡片进程起于 13:51:29。
//   用户反馈"柱状图没有看到蓝色的闪动"，排查半天才发现
//   **运行中的进程是 52 分钟前的旧代码，压根没有那段功能**。
//
//   为什么特别难查：旧代码本身是完好的，没有报错、没有异常、
//   日志里一切正常。用户看到的现象和"新功能写错了"一模一样。
//
//   根因：`.ps1` 是进程启动时**一次性读进内存**的，
//   之后改多少次文件，运行中的进程都不会重新加载。
//   而 DSH 重启并不会连带重启卡片（卡片是脱离进程树的常驻进程）。
//
// 【怎么判断】
//   卡片每 2 秒写心跳，现在里面带 scriptStampMs
//   = "我这个进程启动那一刻，磁盘上 Panel.ps1 是什么时间"。
//   拿它和磁盘当前 mtime 一比即可。
//
//   容差 2 秒：文件系统时间戳精度有限，
//   而且"写文件"和"读到新的 mtime"之间可能差一个 tick。
//
// 【为什么做成纯函数（不直接杀进程）】
//   这个判断一旦出错，后果是"误杀一个正常的卡片"：
//   用户的悬浮窗突然消失、又冒出来。
//   所以判断逻辑必须能脱离进程环境单独测（见 test/freshness.mjs），
//   真正的杀/重启由调用方做，且带节流。

/** 判定容差：两个时间戳差在这以内算同一版 */
export const STALE_TOLERANCE_MS = 2000

/**
 * 判断正在跑的卡片是不是旧代码。
 *
 * @param {object} hb 心跳对象（checkHeartbeat 的返回值，需含 pid）
 * @param {object} options
 * @param {number} options.diskStampMs 磁盘上 Panel.ps1 的修改时间（epoch ms）
 * @param {number} [options.toleranceMs] 容差，默认 2000
 * @returns {{stale: boolean, reason: string, behindMs?: number, loadedStampMs?: number}}
 *   stale=true 表示卡片跑的是旧代码，应该重启它。
 *   reason 是给日志看的一句话，不要直接当用户文案。
 */
export function judgeCardStaleness(hb, options = {}) {
  const toleranceMs = options.toleranceMs ?? STALE_TOLERANCE_MS
  const diskStampMs = Number(options.diskStampMs)

  // 磁盘时间读不出来 -> 不判断。宁可不动，也不要凭猜去杀进程。
  if (!Number.isFinite(diskStampMs) || diskStampMs <= 0) {
    return { stale: false, reason: 'no-disk-stamp' }
  }

  // 卡片没在跑 -> 没有"旧代码"一说（没跑就该由 ensureCardRunning 拉起）
  if (!hb || hb.alive !== true || !hb.pid) {
    return { stale: false, reason: 'card-not-running' }
  }

  // 【关键分支】老版本卡片没有这个字段
  //   不能当成"陈旧"——那会在升级前把每个用户的卡片都误杀一次。
  //   也不能当成"新鲜"就不管了 —— 升级到新版后第一次重启自然就有了。
  const loadedStampMs = Number(hb.scriptStampMs)
  if (!Number.isFinite(loadedStampMs) || loadedStampMs <= 0) {
    return { stale: false, reason: 'no-loaded-stamp' }
  }

  const behindMs = diskStampMs - loadedStampMs
  if (behindMs > toleranceMs) {
    return {
      stale: true,
      reason: 'code-newer-than-process',
      behindMs,
      loadedStampMs,
      // 给日志用的人话，带上"旧了多少"
      detail: `卡片跑的是旧代码（进程加载于 ${new Date(loadedStampMs).toISOString()}，` +
              `磁盘代码 ${new Date(diskStampMs).toISOString()}，落后 ${Math.round(behindMs / 1000)} 秒）`,
    }
  }

  return { stale: false, reason: 'up-to-date', behindMs, loadedStampMs }
}

/**
 * 读取 Panel.ps1 的修改时间（epoch ms）。读不到返回 0。
 * @param {string} panelScriptPath
 * @returns {number}
 */
export function readPanelStampMs(panelScriptPath) {
  try {
    return statSync(panelScriptPath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 判断"这次要不要因为代码更新而重启卡片"。
 *
 * 和 judgeCardStaleness 分开的原因：这个是**策略**，那个是**事实**。
 * 事实（是不是旧代码）要能单独测；策略（现在该不该动手）还涉及节流和重试上限。
 *
 * @param {object} staleness judgeCardStaleness 的返回值
 * @param {object} state
 * @param {number} [state.lastRestartAt] 上次因升级重启的时间戳（去重）
 * @param {number} [state.restartCount] 已经因升级重启过几次
 * @param {number} [state.maxRestart] 最多重启几次，默认 2
 * @param {boolean} [state.restarting] 是否正在重启
 * @param {boolean} [state.autoLaunch] 用户是否允许自动拉起
 * @param {number} [state.now]
 * @returns {{restart: boolean, reason: string, log?: string}}
 */
export function shouldRestartForUpdate(staleness, state = {}) {
  const maxRestart = state.maxRestart ?? 2

  if (!staleness || staleness.stale !== true) {
    return { restart: false, reason: 'not-stale' }
  }
  if (state.autoLaunch === false) {
    // 用户明确关了自动拉起，就绝不主动杀他的卡片
    return { restart: false, reason: 'auto-launch-off' }
  }
  if (state.restarting === true) {
    return { restart: false, reason: 'restarting-in-progress' }
  }
  if ((state.restartCount ?? 0) >= maxRestart) {
    // 【为什么要上限】
    //   如果重启之后心跳里的 scriptStampMs 还是旧的（比如卡片启动失败、
    //   或者读时间戳的代码本身有 bug），就会陷入"杀→拉→还是旧→杀"的死循环。
    //   上限 2 次，之后只记日志，让人来处理。
    return {
      restart: false,
      reason: 'gave-up',
      log: `卡片已因代码更新重启 ${maxRestart} 次仍是旧代码，停止自动重启。` +
           `请手动退出卡片再打开一次（右键卡片 → 退出，然后双击 panel\\run-panel.bat）。`,
    }
  }
  // 同一个"磁盘版本"只重启一次。
  // 用 loadedStampMs 做去重键：如果重启后进程加载的还是同一个旧时间戳，
  // 说明重启没生效，不该再试第二次（靠 restartCount 兜底）。
  if (state.lastRestartAt !== undefined && state.lastRestartAt === staleness.loadedStampMs) {
    return { restart: false, reason: 'already-restarted-for-this-build' }
  }

  return {
    restart: true,
    reason: 'code-updated',
    log: staleness.detail || '卡片跑的是旧代码，自动重启以加载新版本',
  }
}
