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
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 心跳新鲜时，要不要再确认一次"心跳里那个 pid 是不是真的还活着"。
 *
 * 【为什么需要这一步 —— 2026-10-31 的真 bug】
 *   卡片在"attached 模式"下启动时是挂在 DSH 进程树里的，
 *   DSH 一关，卡片会被系统连带收走（实测：插件卸载后 9 秒卡片最后心跳停止）。
 *   而 DSH 重新打开只要 10~15 秒左右，心跳过期门槛却只有 8 秒。
 *
 *   于是出现一个必然的时序陷阱：
 *     DSH 关闭 → 卡片跟着死 → 心跳停在死亡那一刻
 *     → 8 秒内 DSH 又开着 → 新插件读到"6 秒前的心跳" → 判定"卡片在跑"
 *     → 直接跳过拉起 → **屏幕上一张卡片都没有，而且不会自愈**
 *
 *   日志实证（plugin.log，同一形态至少 5 次）：
 *     14:04:56.959 「卡片已在运行（pid=39096，心跳 6 秒前）」
 *     而 pid 39096 的最后一次心跳是 14:04:51.370，判活那一刻它已经死了 5.6 秒
 *     00:03:29 / 11:42:14 / 15:14:35 / 00:30:15 四次的形态完全一样
 *
 * 【为什么只加"pid 还在不在"这一步，不改心跳过期时间】
 *   改 staleMs 会牵连一大片（睡眠唤醒保护、单实例保护、监控循环都读它）。
 *   而 pid 这个信息心跳里本来就有（见 Panel.ps1 的 Write-Heartbeat），
 *   只是从来没人用它核对过 —— 加一步纯核对，改动面最小。
 *
 * 【为什么做成可选开关，不默认开】
 *   这条路会在主线程上多一次系统调用，而且"pid 查不到"的语义依赖环境权限。
 *   目前只有"插件启动时的首次拉起"这个场景确证踩过坑，
 *   所以只在那一处显式打开（见 index.js 的 ensureCardRunning 调用）。
 *   监控循环（shouldReviveCard）判据不同，不受影响。
 *
 * @param {number} pid
 * @returns {true|false|null} true=活着 / false=确实没了 / null=判断不了
 */
export function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return null
  try {
    // 信号 0 不发送任何信号，只做"这个 pid 存在吗"的存在性检查
    process.kill(n, 0)
    return true
  } catch (e) {
    const code = String(e && e.code || '')
    if (code === 'ESRCH') return false
    // EPERM = 进程存在但当前用户没权限动它。这种情况**必须当成活着**，
    // 否则跨用户/提权环境下会把一张正常卡片误判成"死了"，然后叠出第二张。
    if (code === 'EPERM') return true
    // 其它错误（参数非法等）—— 判断不了，交给调用方决定（保守=不推翻心跳结论）
    return null
  }
}

/**
 * 心跳说"我活着"，再核对一下心跳里那个 pid 是否真的还在。
 *
 * @param {{alive: boolean, pid?: number}} hb checkHeartbeat 的返回值
 * @param {object} [options]
 * @param {(pid: number) => (true|false|null)} [options.isPidAlive] 便于单测注入
 * @returns {{gone: boolean, known: boolean, pid?: number}}
 *   gone=true 表示"心跳新鲜但进程确实没了"，调用方应当忽略这份心跳继续去拉起。
 */
export function verifyHeartbeatPid(hb, options = {}) {
  const probe = options.isPidAlive ?? isProcessAlive
  const pid = Number(hb && hb.pid)
  if (!Number.isFinite(pid) || pid <= 0) {
    // 心跳里没 pid（极老版本的卡片）：判断不了，不能推翻心跳结论
    return { gone: false, known: false }
  }
  let verdict = null
  try { verdict = probe(pid) } catch { verdict = null }
  if (verdict === false) return { gone: true, known: true, pid }
  return { gone: false, known: verdict === true, pid }
}

const DEFAULT_STALE_MS = 8000
const BUILD_TAG = 'm3-adaptive-2'

/**
 * 心跳"不新鲜但也没确认死掉"时的清醒宽限（毫秒）。
 *
 * 【为什么需要它 —— 2026-10-31 从日志里查出来的真事故】
 *   实测本机 15 次「卡片异常退出」判定里，有 12 次和「电脑刚从睡眠唤醒」
 *   精确到秒地吻合（±5 秒）。真实情况根本不是卡片崩了：
 *     合上电脑 → 卡片进程被系统挂起，不再写心跳
 *     唤醒电脑 → 卡片要过一小会儿才恢复写心跳
 *     而插件醒来第一件事就是读心跳，读到的是"几小时前"的那条
 *     → 判定"崩溃"→ 重开一张（其实旧的那张下一秒就活过来了）
 *
 *   重开不但没必要，还会盖掉旧卡片的心跳时间线，让日志更难读。
 *   所以这里先等一小会儿再看一眼：如果心跳自己恢复了，就什么都不做。
 *
 * 【为什么只有 2.6 秒】
 *   卡片心跳周期是 2 秒，插件的落后判定是 8 秒。
 *   唤醒后卡片最迟 2 秒内就会恢复写心跳，2.6 秒留了 0.6 秒余量。
 *   这段宽限只在「心跳写着 alive=true 但已经过期」时才走，
 *   正常启动（心跳文件不存在 / 写着 alive=false）完全不受影响。
 */
const DEFAULT_GRACE_MS = 2600

/**
 * detached 启动被判定"本机不可用"之后，多久才再试一次（毫秒）。
 *
 * 【为什么不永久记住】
 *   这个判断依赖机器环境（安全软件、组策略、系统版本）。
 *   环境可能随 Windows 更新或换机器而变好，永久放弃就再也吃不到那个好处。
 *   30 天试一次，代价只是"某天启动多花一个探测窗口"，可以接受。
 */
const DETACHED_RETRY_AFTER_MS = 30 * 24 * 3600 * 1000

/**
 * 同步睡一小会儿（毫秒）。
 *
 * 【为什么需要同步版本】
 *   checkHeartbeat 是同步函数，20 多处调用都按同步方式用它。
 *   要给它加"读不到就重试"的能力，就只能同步地等 —— 改成 async 会把
 *   所有调用方都得改，风险远大于收益。
 *
 * 【为什么用 Atomics.wait 而不是忙等】
 *   忙等（while 循环空转）会把 CPU 打满；Atomics.wait 在内核里阻塞，
 *   不占 CPU。延迟只有几十毫秒，对主线程的可见影响可以忽略。
 *   万一这个 API 不可用（极老版本 Node），退回忙等也不会死。
 */
function syncSleepMs(ms) {
  try {
    const sab = new SharedArrayBuffer(4)
    const view = new Int32Array(sab)
    Atomics.wait(view, 0, 0, ms)
    return
  } catch { /* 落下去用忙等兜底 */ }
  const end = Date.now() + ms
  while (Date.now() < end) { /* 忙等兜底 */ }
}

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

  // ---------------------------------------------------------------- 读文件（带重试）
  //
  // 【为什么必须重试 —— 2026-10-31 的真事故】
  //   卡片写心跳的方式是"写 tmp → 改名覆盖"（见 Panel.ps1 的 Write-Heartbeat）。
  //   在改名的极短瞬间，或者杀毒软件短暂锁住文件时，existsSync/readFile
  //   会失败。那一瞬间读不到，不代表卡片没了。
  //
  //   当时的实际后果（plugin.log 11:44:15）：
  //     "卡片已退出：心跳文件不存在（卡片从没启动过）（不会自动重开…）"
  //   卡片当时正在跑（08:18 启动，已跑 3.5 小时），却因为那一瞬间读不到
  //   被判成"用户主动关闭"，于是**永远不再自动拉起** —— 用户只能重启 DSH。
  //
  //   那一次读失败通常只有几十毫秒，所以这里重试几次、每次隔 100ms，
  //   几乎一定能读到。读到了就走正常分支，压根不会产生误判。
  //
  // 【为什么重试放在这一层，而不是让调用方自己重试】
  //   这个函数有 20 多处调用（单实例保护、自动恢复、调试入口……）。
  //   放在这里，所有调用方一次性都受益，不用每处都记得写。
  const readAttempts = Number.isFinite(options.readAttempts) ? options.readAttempts : 3
  const readRetryMs = Number.isFinite(options.readRetryMs) ? options.readRetryMs : 100
  const syncSleep = options.syncSleep ?? syncSleepMs

  let hb = null
  let sawFile = false
  let lastParseError = null

  for (let attempt = 0; attempt < Math.max(1, readAttempts); attempt++) {
    if (!existsSync(path)) {
      // 文件不在了：可能是刚才还没写出来，也可能真的被删了。
      // 先别下结论，等一小会儿再看（最后一次才认命）。
      lastParseError = null
      sawFile = false
    } else {
      sawFile = true
      try {
        hb = JSON.parse(readFileSync(path, 'utf8'))
        lastParseError = null
        break
      } catch (e) {
        // 读到半截 / 被锁：重试
        lastParseError = e
        hb = null
      }
    }
    if (attempt < readAttempts - 1 && readRetryMs > 0) syncSleep(readRetryMs)
  }

  if (!sawFile) {
    // unknown=true：**关键**。"文件读不到"和"卡片正常退出"必须分开，
    // 因为处理结论完全相反：
    //    正常退出（alive=false，用户自己点的）-> 尊重用户，别重开
    //    文件读不到（情况不明）              -> 应该去救，卡片可能还在
    // 修之前这里只返回 {alive:false}，于是被 shouldReviveCard 归进
    // "用户主动关闭"分支，卡片就再也不回来了。
    return { alive: false, missing: true, unknown: true, reason: '心跳文件读不到（可能正在写，或已被删除）' }
  }
  if (hb === null) {
    const why = lastParseError ? `（${lastParseError.message}）` : ''
    return { alive: false, missing: true, unknown: true, reason: `心跳文件内容不完整${why}` }
  }

  if (!hb || hb.alive !== true) {
    // cleanExit=true：卡片自己把 alive 写成 false 才叫"正常退出"。
    // 这是用户的意愿，绝不能自动重开，也不该被当成"睡眠唤醒的假象"。
    return { alive: false, cleanExit: true, reason: '卡片上次是正常退出的' }
  }

  const at = Number(hb.updatedAtMs)
  if (!Number.isFinite(at)) {
    // 有文件、有 alive=true，但时间戳坏了 —— 这是"数据损坏"，不是"用户退出"。
    // 归到 unknown，让上层去救，而不是当成用户关掉。
    return { alive: false, unknown: true, reason: '心跳文件里没有时间戳' }
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

/**
 * 判断"这次心跳过期"到底是真崩了，还是电脑刚从睡眠回来（卡片还没醒透）。
 *
 * 单独抽成纯函数的理由，和 shouldReviveCard 一样：
 *   这个判断错了的后果是"屏幕上多一张卡片"或者"卡片永远不回来"，
 *   两种都不该靠人工复现故障来验证。抽出来后可以直接喂两组心跳数据做断言。
 *
 * 【判据：等一会儿再看，心跳有没有自己往前走】
 *   睡眠唤醒：卡片进程只是被挂起，恢复后立刻继续写心跳
 *             → 第二次读到的 updatedAtMs 比第一次的新
 *   真崩了  ：进程已经不在了，没人写心跳
 *             → 第二次读到的 updatedAtMs 一模一样（或心跳文件直接没了）
 *
 * @param {object} before 第一次读到的结论（checkHeartbeat 的返回值）
 * @param {object} after  等待宽限后读到的结论
 * @returns {{recovered: boolean, reason: string}}
 *   recovered=true 表示"卡片其实活着，刚才那一下是睡眠唤醒的假象，别重开"。
 */
export function judgeAsleepRecovery(before, after) {
  // 第一次就不是"过期" -> 不该走到这里，保守返回"没恢复"（保持原行为）
  if (!before || before.crashed !== true) {
    return { recovered: false, reason: 'not-a-stale-heartbeat' }
  }

  // 第二次读到心跳正常 -> 卡片活着，刚才只是没醒透
  if (after && after.alive === true) {
    return { recovered: true, reason: 'heartbeat-resumed' }
  }

  // 第二次仍过期，但时间戳往前走了 -> 卡片在恢复写心跳的过程中，
  // 只是还没追上 8 秒的新鲜度标准。同样说明进程还在。
  if (after && after.crashed === true) {
    const beforeAt = Number(before.updatedAtMs ?? 0)
    const afterAt = Number(after.updatedAtMs ?? 0)
    if (afterAt > beforeAt) {
      return { recovered: true, reason: 'heartbeat-advanced' }
    }
    // 时间戳没动 -> 真的没人写心跳了
    return { recovered: false, reason: 'heartbeat-frozen' }
  }

  // 第二次变成"卡片自己写了正常退出"-> 这是真的退出了，不是睡醒的假象
  //
  // 【为什么用 cleanExit 而不是 alive===false 来判】
  //   alive===false 有好几种来源，处理结论却完全不同：
  //     · 卡片自己写了 alive=false        -> 用户主动退出，尊重他，别重开
  //     · 心跳文件根本不存在 / 读不出来    -> 情况不明，保守去救
  //   最初写成看 alive===false，结果"文件没了"被误判成"正常退出"，
  //   于是卡片真的死了也不去救 —— 这正是 v0.5.1 那个老事故的形态。
  //   所以这里只认 checkHeartbeat 明确给的 cleanExit 标记。
  if (after && after.cleanExit === true) {
    return { recovered: false, reason: 'card-exited-cleanly' }
  }

  // 心跳文件没了 / 读不出来 -> 保守当成没恢复（保持原行为，仍然会去救）
  return { recovered: false, reason: 'heartbeat-gone' }
}

/** 等一会儿（默认 2.6 秒）再读一次心跳，用来分辨"睡眠唤醒"还是"真崩了" */
export async function recheckHeartbeatAfterGrace(dataDir, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : DEFAULT_GRACE_MS
  const sleep = options.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
  if (graceMs > 0) await sleep(graceMs)
  return checkHeartbeat(dataDir, options)
}

/** 卡片主脚本的完整路径 */
export function panelScriptPath(panelDir) {
  return join(panelDir, 'Panel.ps1')
}

// ================================================================ detached 策略记忆（v0.10.1）
//
// 【这解决的是什么 —— 2026-10-31 从日志里查出来的真问题】
//   plugin.log 里 43 次 detached 尝试，失败 31 次；剩下 12 次"成功"全是假的。
//   怎么证明是假的：把每次「启动时报的 pid」和「心跳文件的 pid」逐个比，
//   12 次没有一次一致。真实情况是 detached 拉起的 PowerShell 秒退，
//   Node 拿回的 child.pid 指向一个已经不存在的进程；那 12 次"成功"是
//   读到了上一次残留的旧心跳（同一个 pid 反复出现）。
//
//   代价有两条，都很实在：
//     ① 每次启动卡片都要先白等 6 秒才换方案 —— 用户感知是"卡片出现得慢"
//     ② 日志被 43 组三行噪音淹掉，真问题看不见
//
// 【为什么不在这一版修好 detached 本身】
//   实测（多种参数组合）在这台机器上 detached 就是秒退，这是环境限制，
//   不是参数写错了。所以能做的是"别再每次都白试一遍"。
//
// 【存哪、存什么】
//   存在数据目录下的 card-launch.json，和 settings.json 同级：
//     { detachedUnsupported: true, detachedFailedAt: <epoch ms>, detachedFailedReason: "..." }
//   30 天后自动重试一次，避免机器环境变好之后永远吃不到好处。

const LAUNCH_STATE_FILE = 'card-launch.json'

/** 读"启动策略记忆"。任何异常都当成"没有记忆"，绝不影响启动。 */
export function readLaunchState(dataDir) {
  try {
    const p = join(dataDir, LAUNCH_STATE_FILE)
    if (!existsSync(p)) return {}
    const v = JSON.parse(readFileSync(p, 'utf8'))
    if (!v || typeof v !== 'object') return {}
    return v
  } catch {
    return {}
  }
}

/** 写"启动策略记忆"。失败也只是少一条记录，不能挡住启动。 */
export function writeLaunchState(dataDir, patch) {
  try {
    const p = join(dataDir, LAUNCH_STATE_FILE)
    const cur = readLaunchState(dataDir)
    const next = { ...cur, ...patch }
    // 先写临时文件再改名：避免读到写了一半的 json
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    try { if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
    renameSync(tmp, p)
    return true
  } catch {
    return false
  }
}

/**
 * 判断这次要不要先试 detached。
 *
 * 【两个例外仍然会试】
 *   ① 从没失败过（第一次跑、老用户升级上来）—— 没有依据就别乱跳过
 *   ② 距上次失败已经超过 30 天 —— 万一环境修好了呢
 *
 * @param {object} state readLaunchState 的返回值
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.retryAfterMs] 多久后重试，默认 30 天
 * @returns {{try: boolean, reason: string}}
 */
export function shouldTryDetached(state, options = {}) {
  const now = options.now ?? Date.now()
  const retryAfterMs = options.retryAfterMs ?? DETACHED_RETRY_AFTER_MS
  const s = state || {}

  if (s.detachedUnsupported !== true) {
    return { try: true, reason: 'never-failed' }
  }

  const failedAt = Number(s.detachedFailedAt)
  if (!Number.isFinite(failedAt) || failedAt <= 0) {
    // 记着"不支持"却没有时间戳 —— 数据不完整，当作过期，再试一次
    return { try: true, reason: 'no-timestamp' }
  }

  const age = now - failedAt
  if (age >= retryAfterMs) {
    return { try: true, reason: 'retry-window-elapsed' }
  }

  return {
    try: false,
    reason: 'known-unsupported',
    retryInMs: retryAfterMs - age,
    failedAt,
  }
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

/**
 * 等心跳出现。
 *
 * 【expectPid：为什么必须核对 pid（2026-10-31 修）】
 *   原来的判据是纯 hb.alive ——"有心跳就算启动成功"。
 *   这在 detached 秒退的环境下会撒一个很隐蔽的谎：
 *   进程死了，但数据目录里上一次留下的旧心跳还在（或者别的进程正在写），
 *   于是判成"启动成功"，实际屏幕上什么都没有。
 *
 *   本机证据：43 次 detached 尝试里 12 次判成"成功"，
 *   而这 12 次「启动时报告的 pid」和「心跳里的 pid」没有一次一致。
 *
 *   现在带上 expectPid 之后：
 *     pid 对得上  -> alive 且 pidMatched=true
 *     pid 对不上  -> 返回 pidMatched=false（调用方据此判失败，而不是成功）
 *   没给 expectPid（老调用方/单测）-> 保持原行为，pidMatched 为 undefined。
 *
 * @param {string} dataDir
 * @param {number} timeoutMs
 * @param {number} staleMs
 * @param {object} [options]
 * @param {number} [options.expectPid] 只认这个 pid 的心跳
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
async function waitForHeartbeat(dataDir, timeoutMs, staleMs, options = {}) {
  const sleep = options.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
  const expectPid = Number.isFinite(options.expectPid) ? options.expectPid : undefined
  const deadline = Date.now() + timeoutMs
  let last = null

  for (;;) {
    const hb = checkHeartbeat(dataDir, { staleMs })
    last = hb

    if (hb.alive) {
      if (expectPid === undefined) return hb
      // pid 可能是数字也可能是字符串（心跳是 JSON 写出来的），统一成数字比
      const gotPid = Number(hb.pid)
      if (Number.isFinite(gotPid) && gotPid === expectPid) {
        return { ...hb, pidMatched: true }
      }
      // pid 对不上：继续等到超时。中途可能旧心跳被新卡片覆盖
      if (Date.now() >= deadline) {
        return { ...hb, pidMatched: false }
      }
    } else if (Date.now() >= deadline) {
      return hb
    }

    await sleep(250)
  }
  // 不会走到这里；保留是为了让"一定有返回值"这件事对读代码的人明确
  /* c8 ignore next */
  return last
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
  const sleep = options.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))

  let hb0 = checkHeartbeat(dataDir, { staleMs, now: options.now })

  // ---------------------------------------------------------------- 心跳新鲜，但进程可能已经死了
  //
  // 【这一步修的是什么 —— 2026-10-31 用户实际踩到的】
  //   场景：卡片是 attached 启动的（挂在本机 DSH 进程树里），DSH 一关它就跟着没了。
  //   而"心跳过期"的门槛是 8 秒，DSH 重新打开又只要 10~15 秒左右 ——
  //   于是**只要重启够快，新插件读到的心跳就还没过期**，于是：
  //     "卡片已在运行" → 跳过拉起 → 屏幕上一张卡片都没有，而且不会自愈。
  //
  //   真实日志（plugin.log 14:04:56.959）：
  //     「卡片已在运行（pid=39096，心跳 6 秒前）」
  //   而 pid 39096 的最后一个心跳是 14:04:51.370 —— 判活那一刻它已经死了 5.6 秒。
  //
  // 【为什么默认不查】
  //   多一次进程存在性检查，而且只在"插件启动时首次拉起"这个场景确证踩过坑。
  //   所以做成开关，由调用方显式打开（index.js 的那一处），
  //   监控循环里的 checkHeartbeat 调用不受影响。
  //
  // 【判定不了时怎么办】
  //   isProcessAlive 返回 null（权限、参数异常）→ 保留心跳的原始结论，
  //   绝不因为"查不到"就去多起一张卡片。
  if (hb0.alive && options.verifyPid === true) {
    const check = verifyHeartbeatPid(hb0, options)
    if (check.gone) {
      log(`心跳写着活着（pid=${check.pid}，${Math.round((hb0.ageMs ?? 0) / 1000)} 秒前），但那个进程已经不在了 —— 按"卡片没在跑"处理`)
      // 伪造一份"崩溃"结论，让后面的流程（含睡眠唤醒复查）照常走
      hb0 = {
        alive: false,
        crashed: true,
        reason: `心跳还在，但进程 pid=${check.pid} 已经退出（多半是 DSH 关掉时把它一起带走了）`,
        ageMs: hb0.ageMs,
        updatedAtMs: hb0.updatedAtMs,
        pid: check.pid,
        pidGone: true,
      }
    }
  }

  if (hb0.alive) {
    log(`卡片已在运行（pid=${hb0.pid ?? '?'}，心跳 ${Math.round((hb0.ageMs ?? 0) / 1000)} 秒前）`)
    return { ok: true, launched: false, reason: 'already-running', tries: [] }
  }

  // ---------------------------------------------------------------- 睡眠唤醒保护
  //
  // 只有「心跳写着 alive=true 但已经过期」这一种情况才先等一等。
  // 理由见文件上方 DEFAULT_GRACE_MS 的长注释：本机 15 次"崩溃"里 12 次
  // 是电脑刚唤醒造成的假象，卡片其实下一秒就自己活过来了。
  //
  // 心跳文件不存在 / 写着 alive=false 的情况完全不走这里 —— 那些是
  // "第一次装"和"用户主动关掉"，等一等只是白白拖慢启动。
  //
  // 【为什么放在 dryRun 之前】
  //   dryRun 只用于单测，不受影响；但放在前面意味着单测也能覆盖这条分支
  //   的日志措辞，不用真的启动进程。
  let hbUsed = hb0
  // 【pidGone 时不走睡眠唤醒宽限】
  //   宽限是为"电脑刚睡醒、卡片还没活过来"设计的 —— 那时进程确实还在，只是没醒。
  //   而这里我们已经直接问过系统"这个 pid 还在吗"，答案是"不在了"，
  //   再等 2.6 秒纯粹是拖慢启动。所以跳过。
  const skipGrace = options.skipGrace === true || hb0.pidGone === true
  if (hb0.crashed === true && !skipGrace) {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    log(`心跳过期（${Math.round((hb0.ageMs ?? 0) / 1000)} 秒前），先等 ${Math.round(graceMs / 1000)} 秒再确认一次（可能是电脑刚睡醒）…`)
    const after = await recheckHeartbeatAfterGrace(dataDir, {
      staleMs,
      now: options.now,
      graceMs,
      sleep,
    })
    const verdict = judgeAsleepRecovery(hb0, after)
    if (verdict.recovered) {
      log(`复查后心跳已恢复（${verdict.reason}）：卡片其实活着，是刚才没醒透，不重开`)
      return { ok: true, launched: false, reason: 'recovered-from-sleep', tries: [] }
    }
    hbUsed = after
    log(`复查后确认卡片确实不在了（${verdict.reason}）`)
  }

  log(`卡片没在跑：${hbUsed.reason}`)

  // ---------------------------------------------------------------- 情况不明时先确认，别急着开第二张
  //
  // 【这段解决什么 —— 2026-10-31 修"情况不明去救"带来的连带风险】
  //   修完"心跳读不到 -> 去救"之后，出现一个新的可能：
  //   卡片其实活得好好的，只是心跳文件这一瞬间读不到，
  //   于是插件去启动——**屏幕上就会叠出第二张卡片**。
  //
  //   卡片自己有单实例保护（启动时查心跳，新鲜就安静退出），
  //   所以即便叠一次也不会真出两张窗。但那要多跑一个 PowerShell 进程，
  //   而且日志里会多一条容易误导人的"启动失败"。
  //
  //   这里先多看几眼：情况不明时等一小会儿再读，读到了就直接返回
  //   already-running，一个进程都不用起。
  //
  // 【为什么只对"情况不明"做】
  //   明确的崩溃（读到过期心跳）和首次安装（从没跑过）不该拖时间；
  //   只有"文件读不到"这种确实可能是一瞬间锁文件的情形值得多等。
  if (hbUsed.unknown === true && options.skipUnknownRecheck !== true) {
    const recheckMs = options.unknownRecheckMs ?? 500
    const recheckTimes = options.unknownRecheckTimes ?? 4
    const syncSleep = options.syncSleep ?? syncSleepMs
    for (let i = 0; i < recheckTimes; i++) {
      if (recheckMs > 0) syncSleep(recheckMs)
      const again = checkHeartbeat(dataDir, {
        staleMs,
        now: options.now,
        readAttempts: 1,        // 这里自己控节奏，别再叠内层重试
        readRetryMs: 0,
      })
      if (again.alive === true) {
        log(`再读 ${i + 1} 次后读到心跳了（pid=${again.pid ?? '?'}）：卡片一直在跑，不重复启动`)
        return { ok: true, launched: false, reason: 'already-running', tries: [] }
      }
      if (again.unknown !== true) {
        // 读出了确定的结论（崩溃 / 正常退出），交给下面正常流程
        hbUsed = again
        break
      }
    }
    log(`情况不明时又确认了 ${recheckTimes} 次，仍然读不到心跳，按"卡片不在"处理`)
  }

  if (options.dryRun === true) {
    const r = launchCard({ panelDir, dataDir, log, dryRun: true, mode: 'detached' })
    return { ok: true, launched: false, reason: r.reason, tries: [r] }
  }

  // ---------------------------------------------------------------- 启动策略顺序
  //
  // detached 一旦在本机被证明不可用，就先不试它了（省掉每次 6 秒白等）。
  // 判据与豁免规则见 shouldTryDetached。
  const launchState = readLaunchState(dataDir)
  const detachedVerdict = shouldTryDetached(launchState, { now: options.now })
  const modes = detachedVerdict.try ? ['detached', 'attached'] : ['attached']
  if (!detachedVerdict.try) {
    log(`跳过 detached 策略（本机已确认它起不来，省掉 ${Math.round(waitMs / 1000)} 秒；30 天后会自动再试一次）`)
  }

  const tries = []
  for (const mode of modes) {
    log(`尝试以 ${mode} 方式启动…`)
    const r = launchCard({ panelDir, dataDir, log, mode })
    tries.push(r)
    if (!r.launched) continue

    // 【关键修法：不能只看"有心跳"，还要看是不是我启的那张】
    //
    // 之前的判据是纯 hb.alive —— 于是 detached 秒退之后，只要数据目录里
    // 还留着上一次的旧心跳（或者别的进程在写），就会判成"启动成功"。
    // 本机日志里 12 次"detached 启动成功"，pid 没有一次和启动时报告的一致，
    // 全是这么来的假象。
    //
    // 现在要求：心跳里的 pid 必须等于我这次 spawn 拿到的 pid。
    // 拿不到 child.pid（理论上不该发生）时才退回老判据，避免把正常情况卡死。
    const hb = await waitForHeartbeat(dataDir, waitMs, staleMs, {
      expectPid: r.pid,
      sleep,
    })
    if (hb.alive && hb.pidMatched !== false) {
      log(`卡片启动成功（${mode} 策略，pid=${hb.pid ?? '?'}）`)
      return { ok: true, launched: true, reason: `started-${mode}`, mode, tries }
    }

    // ---- 失败：区分"没心跳"和"心跳是别人的"
    const why = hb.alive && hb.pidMatched === false
      ? `等到的心跳不是这次启动的进程（期望 pid=${r.pid ?? '?'}，实际 pid=${hb.pid ?? '?'}）`
      : hb.reason
    log(`${mode} 策略启动后 ${waitMs}ms 内没确认成功：${why}，换策略重试`)

    // ---- 记下"detached 在本机不可用"，下次别再白试
    //
    // 只记 detached：attached 也失败说明卡片本身起不来（可能是代码问题），
    // 那种情况必须每次如实重试并报错，绝不能"记住后跳过"。
    if (mode === 'detached') {
      const ok = writeLaunchState(dataDir, {
        detachedUnsupported: true,
        detachedFailedAt: options.now ?? Date.now(),
        detachedFailedReason: why,
      })
      if (ok) log('已记录：detached 策略在本机不可用，下次启动直接走 attached')
    }

    // 换策略前稍微等一下，避免两个进程挤在一起抢 Mutex
    await sleep(800)
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
 * 【2026-10-31 修：为什么必须区分"用户退出"和"情况不明"】
 *   修之前的分支是 `!hb.alive && !hb.crashed` -> 当成用户主动退出，永不重开。
 *   问题是 hb.crashed 只在"读到过期心跳"时才为真。而"心跳文件读不到"
 *   也是 alive=false 且 crashed=undefined，于是被误判成用户退出。
 *
 *   真实后果（用户当天实际遇到）：
 *     plugin.log 11:44:15
 *     "卡片已退出：心跳文件不存在（卡片从没启动过）（不会自动重开…）"
 *     卡片当时正在跑（08:18 启动，已跑 3.5 小时），只因为那一瞬间
 *     文件被锁/正在改名读不到，就被判成"用户主动关闭"，从此再不拉起，
 *     用户只能重启 DSH 才看得到卡片。
 *
 *   所以现在的判据改成：**只有明确读到 alive=false（cleanExit）才算用户退出**。
 *   文件读不到 / 内容坏了 / 时间戳坏了 —— 一律归为"情况不明"，去救。
 *
 * @param {{alive: boolean, crashed?: boolean, cleanExit?: boolean, missing?: boolean, unknown?: boolean, updatedAtMs?: number}} hb
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

  // --- 情况 1：**用户明确地**退出了卡片（右键 -> 退出）
  //
  // 【判据只看 cleanExit，不看 `!hb.alive && !hb.crashed`】
  //   后者会把"文件读不到 / 内容坏了"一起吞进来，那是 2026-10-31
  //   卡片再也不回来的直接原因。cleanExit 只在卡片自己把 alive 写成
  //   false 时才为真，是唯一能代表"用户意愿"的证据。
  if (hb.cleanExit === true) {
    return { revive: false, reason: 'user-closed', log: `卡片已退出：${hb.reason}（不会自动重开，下次 DSH 启动时会再拉起）` }
  }

  // --- 情况 2：情况不明（心跳文件读不到 / 内容不完整 / 时间戳坏了）
  //
  // 【为什么这种情况必须去救，而不是放着不管】
  //   这几种都是"读不出来"，不是"卡片说它退出了"。
  //   最常见的成因恰恰是卡片正在写心跳（写 tmp → 改名的瞬间），
  //   也就是说卡片**大概率活得好好的**。
  //   就算它真的没了，救一次也只多起一个进程（会被单实例心跳挡住），代价很小；
  //   而不救的代价是"卡片永久消失，用户完全不知道发生了什么"。
  //
  // 【为什么用 reason='unknown-heartbeat' 单独标出来】
  //   调用方据此**不消耗恢复次数**、也不写"崩溃"日志 ——
  //   这属于"情况不明时的保险动作"，不该被记成卡片崩了。
  if (hb.unknown === true || hb.missing === true) {
    if (state.autoLaunch === false) {
      return { revive: false, reason: 'unknown-autolaunch-off' }
    }
    if (state.reviving === true) {
      return { revive: false, reason: 'reviving-in-progress' }
    }
    // 这里刻意**不查 reviveCount 上限**：这不是崩溃，只是在情况不明时
    // 确认一下卡片在不在。真到上限了也该继续确认 —— 否则又回到
    // "卡片永远不回来"的老路上。
    return {
      revive: true,
      reason: 'unknown-heartbeat',
      stamp,
      // 【措辞说明】hb.reason 本身已经是一句完整的话（如"心跳文件读不到（可能正在写…）"），
      //   所以不再套一层"心跳读不到（…）"，否则日志会变成"心跳读不到（心跳文件读不到（…））"。
      log: `情况不明：${hb.reason}。复查一次卡片是否还在`,
    }
  }

  // --- 情况 3：心跳过期（可能是真的没了，也可能只是电脑刚睡醒）
  if (hb.crashed && state.autoLaunch !== false) {
    // 已经处理过同一个崩溃（同一个时间戳），不重复处理
    if (stamp <= state.lastCrashedAt) {
      // 【v0.10.4：这个分支以前完全静默，害得"卡片不见了"查不出原因】
      //
      // 【为什么必须留一条日志】
      //   2026-10-31 实测：14:04:56 插件启动，卡片 14:04:51 就死了，
      //   心跳时间戳早于插件启动时刻 → 命中本分支 → 每 5 秒静默 return，
      //   76 秒里约 15 轮、**一行日志都没有**，屏幕上一张卡都没有。
      //   事后翻日志完全看不出发生过什么。
      //
      // 【为什么用 log：调用方自己做去重】
      //   index.js 那边按时间戳只写一次，避免每 5 秒刷一条。
      return {
        revive: false,
        reason: 'already-handled',
        stamp,
        log: `心跳过期（${Math.round((hb.ageMs ?? 0) / 1000)} 秒没更新），但这份心跳早于本插件启动时刻 —— 判定为上一次运行留下的记录，本次不重复处理`,
      }
    }
    if (state.reviving === true) {
      return { revive: false, reason: 'reviving-in-progress' }
    }
    if (state.reviveCount >= maxRevive) {
      return {
        revive: false,
        reason: 'gave-up',
        // 【v0.10.3 改措辞】"已连续异常退出 N 次"是在没有复查证据时下的结论，
        //   历史上这句话让人（包括排查的我）以为卡片天天在崩，实际多数是
        //   电脑睡眠唤醒造成的假象。改成如实描述"尝试恢复过 N 次"。
        log: `卡片已尝试自动恢复 ${maxRevive} 次仍未成功，暂停自动恢复。请手动运行 panel\\run-panel.bat 排查。`,
      }
    }
    // 【v0.10.3 改措辞：这里不下"异常退出"的结论】
    //   这句 log 会在**复查之前**被打印（因为复查发生在调用方）。
    //   原来写"卡片异常退出（不是正常关闭）"，但紧接着复查常常发现
    //   "其实是电脑刚睡醒"——于是日志里留下一堆假的崩溃记录。
    //   现在只如实说"心跳过期了"，结论由调用方在复查后写。
    //
    // 【为什么不再套一层"心跳过期（…）"】
    //   hb.reason 本身已经是"心跳过期（338 秒没更新，未正常退出）"这样的
    //   完整句子，再包一层会变成"心跳过期（心跳过期（…））"，读着别扭。
    const detail = String(hb.reason || '').startsWith('心跳过期')
      ? String(hb.reason)
      : `心跳过期（${hb.reason}）`
    return { revive: true, reason: 'crashed', stamp, log: `${detail}，先复查是不是电脑刚睡醒再决定` }
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
