/**
 * dsh-floating-window -- 让 DSH 桌面卡片显示真实状态
 *
 * 分工（交接文档定的，别改）：
 *   插件只写数据 → %USERPROFILE%\.dsh\desktop-card\state.json
 *   卡片（Panel.ps1，独立进程）每 500ms 读一次
 *
 * 所以：
 *   - 插件崩了最多数据不更新，卡片不会跟着崩
 *   - 调试极简单：直接打开 state.json 就知道插件有没有在干活
 *
 * 数据来源全部经 M0 实测验证，见 M0-探针验收报告.md。
 */

import { CardState } from './lib/state.js'
import { TokenTracker } from './lib/tokens.js'
import { StateWriter } from './lib/writer.js'
import { DEFAULTS, dataDir, dataPaths, panelDir } from './lib/paths.js'
import { createLogger } from './lib/logger.js'
import { registerSources, backfill, syncExistingSessions } from './lib/sources.js'
// 【D6】isProcessAlive 加进来是为了在监控循环里核对"心跳里那个 pid 还在不在"。
//   过去只有 ensureCardRunning 的首次拉起会做这一步（本文件下方 verifyPid: true），
//   每 5 秒跑的监控循环从来没核对过 —— 那正是"一张卡片变三张"的根因。
import { ensureCardRunning, checkHeartbeat, shouldReviveCard, isProcessAlive, judgeCardStaleness, shouldRestartForUpdate, readPanelStampMs, stopCardByHeartbeat, waitForPreviousCardExit } from './lib/launcher.js'
import { startDemo } from './lib/demo.js'
import { HolidayStore, nextSwitch } from './lib/valley.js'
import { createApprovalProxy } from './lib/approval-proxy.js'
import {
  resolveDshUrlDetailed,
  computeDshUrlSettingsUpdate,
  createUrlSyncRunner,
  buildRetryPlan,
} from './lib/endpoint.js'
import { readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './lib/json-store.js'

// ================================================================ 版本号
//
// 启动日志第一行会打印它，以前是**硬编码**的字符串：
// 版本早就走到 0.9.x 了，那行还写着 v0.5.2，排查时按日志里的版本去
// 对代码和数据，会一头雾水（"这功能明明加了，日志显示的老版本却没有"）。
// 所以改成从同目录的 package.json 读 version —— 以后改版本只改一处。
//
// 【为什么用 new URL(..., import.meta.url) 而不是 process.cwd()】
//   cwd 是 DSH 的工作目录，不是插件目录，拼出来的 package.json 根本不存在。
//   import.meta.url 是**本文件**的位置，和插件装在哪儿无关，永远指对。
//
// 【读失败不能让插件崩掉】
//   包被裁过、package.json 权限异常、JSON 坏了……都可能失败。
//   第一行日志拿不到版本号是小事，插件起不来是大事，所以兜底成 'unknown'。
const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return (typeof pkg?.version === 'string' && pkg.version.trim()) ? pkg.version.trim() : 'unknown'
  } catch {
    return 'unknown'
  }
})()

// ================================================================ settings.json 读写
//
// 卡片和插件都要改 settings.json：
//   卡片：用户在设置界面里改外观
//   插件：把 DSH 的真实网址同步进去
// 所以两边都遵循同一套读写方式，避免互相踩。
//
// 只做"读出来、改一个键、原子写回"，绝不整份覆盖 ——
// 否则会把用户改过的外观设置抹掉。

/** 读 settings.json，失败就返回空对象（不抛） */
function readSettingsFile(path) {
  try {
    if (!existsSync(path)) return {}
    const j = JSON.parse(readFileSync(path, 'utf8'))
    return (j && typeof j === 'object') ? j : {}
  } catch {
    return {}
  }
}

/** 原子写 settings.json（写 tmp 再改名，卡片不会读到半截） */
function writeSettingsFile(path, obj) {
  // ================================================================
  // 【v0.10.13 · D1】改用统一的原子写入
  //
  // 【改造前】
  //     const tmp = path + '.tmp'
  //     writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  //     renameSync(tmp, path)
  //
  // 已经是"临时文件 + 改名"了，方向对。但临时名固定为 `settings.json.tmp`，
  // 而 settings.json 恰好是**三个写者**都会动的文件
  // （插件同步 dshUrl、卡片写置顶、设置窗口保存外观）。
  // 两个写者同时动手时共用同一个 tmp 名 → 互相覆盖中间结果，
  // 最终文件内容可能来自"半次 A + 半次 B"，而且**全程不报错**。
  //
  // 现在交给 writeJsonAtomic：临时名带 pid + 随机串，不可能撞。
  // ================================================================
  return writeJsonAtomic(path, obj)
}

export const name = 'dsh-floating-window'

/**
 * timer 是硬依赖（定时补推）。
 * sessionPersistence / sessionProjectionCache 在 backfill 里用 ctx.get 取，
 * 故意不放进 inject：它们是可选增强，缺了插件也要能正常跑。
 */
export const inject = ['timer']

// ================================================================ 配置日志白名单（D4）
//
// 【原来是什么问题】
//   启动时直接 log(`配置: ${JSON.stringify(cfg)}`) —— 把**整份配置**原样写进
//   plugin.log。今天这 11 个字段都无害，但这是一条**未来会出事**的写法：
//   哪天加一个 apiKey / webhookToken / password 之类的配置项，
//   它会被自动写进磁盘上的明文日志，而且没人会注意到 ——
//   因为"配置行"本来就一直在那儿，看着很正常。
//   这类问题等到发现时通常已经泄露很久了。
//
// 【改成什么样】
//   只记**排障真的会用到**的字段（下面这张表），其余一律不出现。
//   以后新增配置，默认**不记**；要看它就主动加进这张表。
//   这是"默认安全"而不是"记得手删"——两者的差别在于一年后还对不对。
//
// 【为什么还要 isSensitiveKey 这层兜底】
//   白名单本身也可能出错：有人图省事往表里加个 token 字段。
//   所以再加一道**按名字**的过滤，命中就无条件不记（连"已隐藏"都不说，
//   免得日志里出现 `apiKey=***` 反而提示"这里有东西"）。
//   两道闸独立生效：白名单管"记不记"，敏感名管"哪怕在名单里也不记"。
const LOG_SAFE_CFG_KEYS = [
  'autoLaunch',
  'useDemoData',
  'showSubagentSessions',
  'writeThrottleMs',
  'backfillTodayTokens',
  'heartbeatStaleMs',
  'approvalDecisionTtlMs',
  'approvalPollMs',
  'approvalInline',
]

/** 名字里出现这些词就绝不记录（大小写无关） */
const SENSITIVE_KEY_RE = /token|secret|password|passwd|credential|apikey|api_key|private|auth|cookie/i

/**
 * 把配置压成一行"可安全写日志"的文本。
 *
 * 【为什么不返回对象】
 *   返回值直接拼进日志行。返回对象的话调用方还得自己 stringify，
 *   于是很容易又写回 `JSON.stringify(cfg)` 的老路。
 *   返回成品字符串，调用点只有一种写法，想写错都难。
 *
 * @param {Record<string, unknown>} cfg
 * @returns {string} 形如 `autoLaunch=true useDemoData=false ...`
 */
export function summarizeConfigForLog(cfg) {
  const parts = []
  for (const key of LOG_SAFE_CFG_KEYS) {
    // 双保险：白名单里的字段也要过一遍敏感名过滤
    if (SENSITIVE_KEY_RE.test(key)) continue
    // 只记录"自己确实说过"的字段。没配置的值不该以 undefined 出现在日志里，
    // 那会让人误以为"系统读到了 undefined"，实际是"根本没设置"。
    if (!Object.prototype.hasOwnProperty.call(cfg || {}, key)) continue
    const v = cfg[key]
    if (v === undefined) continue
    // 值本身也要防一手：万一是对象/数组，打出来可能很长甚至含嵌套凭据
    if (v !== null && typeof v === 'object') continue
    parts.push(`${key}=${String(v)}`)
  }
  return parts.length ? parts.join(' ') : '(无可记录字段)'
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  const dir = dataDir(cfg.dataDir)
  const paths = dataPaths(dir)
  const cardDir = panelDir(cfg.panelDir)
  const log = createLogger(paths.log)

  log('========================================')
  log(`插件启动 v${pkgVersion}（插件只写数据，卡片独立渲染；卡片掉线会自动复活）`)
  log(`dataDir=${dir}`)
  log(`panelDir=${cardDir}`)
  // 【D4】不再 JSON.stringify(cfg) 整份输出，只记白名单里的排障字段。
  //   dataDir / panelDir 上面已经单独记过了，不在这张表里也不会丢信息。
  log(`配置: ${summarizeConfigForLog(cfg)}`)

  // ---------------------------------------------------------------- 核心状态
  const state = new CardState({
    maxSessions: 64,
    finishedFlashMs: 8000,
    showSubagentSessions: cfg.showSubagentSessions === true,
  })
  const tokens = new TokenTracker()
  // 【v0.10.0】把"按会话查 Token"接到状态层，卡片每行才能显示自己那一份。
  //   传的是函数而不是 TokenTracker 对象本身 —— state.js 刻意不依赖任何外部模块，
  //   只认一个 (sessionId) => number 的纯函数（见 lib/state.js 的同名注释）。
  state.setSessionTokenSource((sessionId) => tokens.sessionTotal(sessionId))

  const writer = new StateWriter({
    dir,
    throttleMs: cfg.writeThrottleMs,
    log,
  })

  // 演示模式自己管 state.todayTokens，真实模式由 TokenTracker 提供
  const isDemo = cfg.useDemoData === true

  // ---------------------------------------------------------------- 峰谷
  //
  // 每 30 秒重算一次「现在是不是谷时、还有多久切换」，塞进 state。
  // 为什么不在卡片里算：节假日数据要联网取、规则要跟着官方文档走，
  // 这些都属于"插件该干的事"，卡片只管显示。
  //
  // 节假日本地缓存放在数据目录，断网也能用上次的。
  const holidays = new HolidayStore({
    path: paths.holidays,
    log,
  })
  let valleyRefreshBusy = false

  const refreshValley = (nowMs = Date.now()) => {
    try {
      const set = holidays.setAround(nowMs)
      const r = nextSwitch(nowMs, set)
      state.valley = {
        inValley: r.inValley,
        remainingSec: Math.round(r.remainingMs / 1000),
        reason: r.reason,
        // 给排错用的旁证：这一次判断用到了几天节假日数据
        holidayCount: set.size,
      }
    } catch (e) {
      log('计算峰谷失败', { error: String(e && e.message) })
    }
  }

  // 节假日数据：启动时拉一次（被动，不阻塞），之后每 6 小时看一次是否过期
  const maybeFetchHolidays = async () => {
    if (valleyRefreshBusy) return
    valleyRefreshBusy = true
    try {
      const year = new Date().getFullYear()
      const r = await holidays.refresh(year)
      if (r.ok) {
        log('节假日数据已就绪', { years: r.years, detail: holidays.debug() })
        refreshValley()
        push('holidays', true)
      } else {
        log('节假日数据拉取失败，先用缓存/周末规则', { error: r.error, detail: holidays.debug() })
      }
    } catch (e) {
      log('拉取节假日异常', { error: String(e && e.message) })
    } finally {
      valleyRefreshBusy = false
    }
  }

  if (!isDemo) {
    // 立刻算一次，保证首份 state.json 里就有峰谷
    refreshValley()
    maybeFetchHolidays()
    // 每 6 小时看一次节假日缓存是否过期。
    // 原来这里是裸 setInterval + unref，本轮统一改成 ctx.interval：
    //   · 裸定时器不会随插件卸载被清掉，卸载后还会去读缓存、拉网络、写文件；
    //   · ctx.interval 返回的是 disposer，ctx.effect 卸载时会自动调，天然对齐。
    ctx.effect(() => {
      const stop = ctx.interval(() => { maybeFetchHolidays() }, 6 * 3600 * 1000)
      return () => { try { stop?.() } catch { /* ignore */ } }
    }, 'dsh-floating-window: holidays')
  }

  const push = (reason, urgent = false) => {
    try {
      if (!isDemo) {
        state.setTodayTokens(tokens.total())
        // 每次推送都顺手刷新峰谷，避免倒计时停在旧值上
        refreshValley()
      }
      // 【v0.8.0】悬浮窗审批的两个快照选项：
      //   approvalInline —— 开关关时 snapshot 会**完全不输出** answerable/id/nonce
      //                     （字段越少越不容易出错，卡片读不到就只显示"去处理"）
      //   cardAlive      —— answerable 的第④个条件
      const snap = state.snapshot({
        approvalInline: approvalInlineEnabled(),
        cardAlive: liveness.alive === true,
      })
      writer.write(snap, { urgent })
    } catch (e) {
      log('写状态失败: ' + (e && e.message) + (reason ? ` (来源: ${reason})` : ''))
    }
  }

  // ---------------------------------------------------------------- 演示模式
  let demo = null
  if (cfg.useDemoData === true) {
    log('演示模式开启（useDemoData=true）：不接真实数据')
    demo = startDemo(state, { log, onChange: () => push('demo', true) })
    ctx.effect(() => () => demo?.stop(), 'dsh-floating-window: demo loop')
  }

  // ---------------------------------------------------------------- 卡片存活状态（v0.8.0）
  //
  // 【为什么单独暴露一个对象】
  //   审批代理要判断"卡片还活着吗"（判据 C2：卡片死了就 next() 让路）。
  //   但 wasAlive / reviving 都在下面心跳监控的 ctx.effect 闭包里，外面拿不到。
  //   而且**不能每次审批都去读心跳文件** —— 那是同步 I/O，审批是热路径。
  //
  //   下面心跳监控每 5 秒会跑一次 checkHeartbeat，
  //   顺手把结果写进这个对象，就是现成的 5 秒缓存，零额外 I/O。
  //
  // 【5 秒窗口无害】
  //   最坏情况是卡片刚死、我们还以为活着，这个窗口内用户点按钮 ——
  //   但卡片都死了就没人点，所以不值当为它缩短轮询。
  const liveness = { alive: false }

  // ---------------------------------------------------------------- 悬浮窗审批开关（v0.8.0）
  //
  // 【真源是数据目录的 settings.json，不是 cfg】
  //   用户要在设置界面里切开关，切完要立刻生效、不能重启 DSH。
  //   而 cfg 只在插件加载时读一次（改它必须重启）。
  //   所以每次审批时读 settings.json —— 但不能每次都开文件、每次 JSON.parse，
  //   用 mtime 过滤：平时只多一次 GetLastWriteTime 级别的开销。
  let approvalInlineCache = { mtimeMs: -1, value: cfg.approvalInline === true }
  const approvalInlineEnabled = () => {
    try {
      const st = statSync(paths.settings)
      if (st.mtimeMs !== approvalInlineCache.mtimeMs) {
        const j = readSettingsFile(paths.settings)
        approvalInlineCache = {
          mtimeMs: st.mtimeMs,
          // 缺键时用 DEFAULTS 里的值（安全侧默认 false）
          value: j.approvalInline === undefined
            ? cfg.approvalInline === true
            : j.approvalInline === true,
        }
        log('悬浮窗审批开关: ' + (approvalInlineCache.value ? '开' : '关'))
      }
      return approvalInlineCache.value
    } catch {
      // 读不到就按关闭处理（安全侧）
      return cfg.approvalInline === true
    }
  }

  // ---------------------------------------------------------------- 悬浮窗审批代理（v0.8.0）
  //
  // 【常驻注册，不随开关变化】—— task-9 硬性要求。
  //   开关只在 answerer 内部决定行为（为假就 next()）。
  //   理由：动态注册会导致"改开关必须重启 DSH"，跟用户要的
  //   "设置界面里切开关"直接冲突；而且会引入时序/重复注册/反注册失败三个新问题。
  //
  // 【注册在 sources 之前还是之后】
  //   放在 sources 之后：这样 approval/asked 事件已经能进 state，
  //   我们的配对主路（查 pendingApprovals）命中率最高。
  let approvalProxy = null
  if (cfg.useDemoData !== true) {
    try {
      approvalProxy = createApprovalProxy({
        ctx,
        state,
        onChange: push,
        log,
        decisionsDir: paths.decisions,
        liveness,
        inlineEnabled: approvalInlineEnabled,
        decisionTtlMs: cfg.approvalDecisionTtlMs,
        pollMs: cfg.approvalPollMs,
      })
      approvalProxy.ensureDir()
      const ok = approvalProxy.install()
      // 卸载时：proxy.dispose() 会把所有挂住的 Promise 全部 resolve 成 unavailable，
      // 这一步漏了会把 DSH 卡住（最危险的失败模式，见 approval-proxy.js 文件头）
      ctx.effect(() => () => {
        try { approvalProxy?.dispose() } catch (e) { log('审批代理卸载出错: ' + (e && e.message)) }
      }, 'dsh-floating-window: approval-proxy')
      log('审批代理初始化' + (ok ? '成功' : '失败（功能不可用，卡片会显示暂不可用）'))
    } catch (e) {
      log('审批代理初始化异常: ' + (e && e.message))
      approvalProxy = null
    }
  }

  // ---------------------------------------------------------------- 接真实数据
  let sources = null
  if (cfg.useDemoData !== true) {
    sources = registerSources(ctx, {
      state, tokens, onChange: push, log,
      // 审批事件进了 state 之后，通知代理"有一条新的待审批"——
      // 代理会立刻推一次状态，让卡片马上长出按钮。
      onApprovalAsked: () => { try { approvalProxy?.ensureDir() } catch { /* ignore */ } },
    })
    ctx.effect(() => () => { try { sources?.dispose() } catch { /* ignore */ } }, 'dsh-floating-window: sources')

    // 立刻对齐"启动前就已经在跑"的会话。
    // 这一步很要紧：当前这个对话在你重启 DSH 恢复后就已经在跑，
    // 它的 api-session/added 早就发过了，我们收不到。
    // 不主动扫一遍，卡片会在最初一段时间显示"空闲"。
    //
    // 注意：插件往往比 Agent 先加载，第一次调用通常拿到 0 个 Agent。
    // 所以要重试几次，直到真的看到 Agent 为止。
    const syncDeps = { state, onChange: push, log, _loggedShape: false }
    const syncOnce = (label) => {
      try {
        const r = syncExistingSessions(ctx, syncDeps)
        if (r.agents > 0) log(`对齐现有会话（${label}）：${r.agents} 个 Agent，${r.running} 个在跑`)
        return r.agents > 0
      } catch (e) {
        log(`对齐现有会话失败（${label}）: ` + (e && e.message))
        return false
      }
    }

    syncOnce('启动即刻')

    // 500ms 一次，最多 24 次（前 12 秒），看到 Agent 就停
    ctx.effect(() => {
      let tries = 0
      const stop = ctx.interval(() => {
        tries++
        if (syncOnce(`重试 #${tries}`) || tries >= 24) {
          try { stop?.() } catch { /* ignore */ }
        }
      }, 500)
      return () => { try { stop?.() } catch { /* ignore */ } }
    }, 'dsh-floating-window: sync-existing')

    // 启动回填（异步，不阻塞）
    if (cfg.backfillTodayTokens === true) {
      let cancelled = false
      ctx.effect(() => () => { cancelled = true }, 'dsh-floating-window: backfill-cancel')
      Promise.resolve()
        .then(() => {
          if (cancelled) return null
          return backfill(ctx, { state, tokens, onChange: push, log }, {
            backfillTokens: true,
            fillTitles: true,
          })
        })
        .then((result) => {
          if (result && result.ok) {
            log(`回填成功：${result.tokensAdded} Token / ${result.ms}ms / ${result.titlesFilled} 个标题`)
          }
        })
        .catch((e) => log('回填异常: ' + (e && e.message)))
    }
  }

  // ---------------------------------------------------------------- 定时兜底刷新
  // 事件驱动为主，但「跑了多久」这个数字得自己走。
  ctx.effect(() => {
    const id = ctx.interval(() => {
      try {
        if (isDemo) {
          push('tick')
          return
        }
        // 跨天：Token 清零
        if (tokens.rollover()) {
          log('跨天，今日 Token 已清零')
          push('rollover', true)
          return
        }
        // 待审批过期保护：卡片的审批只可能来自正在跑的会话，
        // 如果那个会话已经不在了，这条审批也失效（防止卡片永久卡红）
        let dirty = false
        for (const [aid, a] of [...state.pendingApprovals.entries()]) {
          if (a.sessionId && !state.sessions.has(a.sessionId)) {
            state.approvalDecided(aid)
            dirty = true
          }
        }
        if (dirty) log('清理了失效的待审批项')
        push('tick', dirty)
      } catch (e) {
        log('定时刷新出错: ' + (e && e.message))
      }
    }, 1000)
    return () => { try { id?.() } catch { /* ignore */ } }
  }, 'dsh-floating-window: tick')

  // ---------------------------------------------------------------- 卸载清理
  ctx.effect(() => () => {
    try {
      if (!isDemo) state.setTodayTokens(tokens.total())
      const snap = state.snapshot()
      writer.write(snap, { urgent: true })
      writer.dispose()
      log('插件卸载，已停止写盘')
    } catch { /* ignore */ }
  }, 'dsh-floating-window: teardown')

  // 立刻写第一份
  push('boot', true)
  log(`首份 state.json 已写入: ${paths.state}`)

  // ---------------------------------------------------------------- 把真实地址同步给卡片
  //
  // 【为什么需要这一步】
  //   卡片原来配的是写死的 http://127.0.0.1:2278，但 DSH 端口每次可能不同
  //   （实测这次是 11922），端口一变点卡片就是空白页。
  //
  //   现在点卡片默认走 dsh:// 协议（不需要端口），网址只是兜底。
  //   但兜底也要用真实地址，所以把 DSH 自己报告的地址写进 settings.json。
  //
  //   注意：只改 dshUrl 这一个键，其它用户配置原样保留。
  //   卡片每 500ms 读一次 settings.json，所以不必重启卡片。
  //
  // ----------------------------------------------------------------
  // 【B8：为什么现在要重试，而不是调一次就完】
  //
  //   原先这里是裸调一次 syncDshUrl()。结果是：**每次启动都失败**。
  //   plugin.log 里「配置: {...}」紧跟「拿不到 DSH 网页地址（webApp/webServer
  //   都不可用）」，同毫秒级。而 settings.json 的 dshUrl 至今还是那个
  //   早就不在监听的 http://127.0.0.1:2278。
  //
  //   但服务其实是**存在且正常**的（cordis inspect 查过 Service 目录）。
  //   真正的契约在 webServer.getOrigin() 里：
  //       throws: before `listen` binds a port.
  //   也就是 apply() 跑得太早，那一刻还没 listen 完。
  //
  //   所以：首次立即试（快路径），失败就退避重试 250 → 500 → 1s → 2s →
  //   4s → 8s（约 24 秒内 7 次），成功一次立刻停，30 秒后不再试。
  //
  //   定时器一律走 ctx 的 timer 服务（export const inject = ['timer'] 已有）。
  //   绝不用裸 setTimeout：卸载后它会继续跑，然后在已销毁的 ctx 上写文件。
  //   这里的 disposer 也登记进了 ctx.effect，卸载时一并清掉。
  //
  //   日志措辞也一并改了 —— 原来那句"服务都不可用"是误导，会让下一个排错的人
  //   （包括我自己）以为服务没装，方向直接跑偏。
  // ----------------------------------------------------------------
  const urlSync = createUrlSyncRunner({
    resolveOnce: () => resolveDshUrlDetailed(ctx),
    commit: (found) => {
      // 【只在值真的变了才写盘】
      //   computeDshUrlSettingsUpdate 是纯函数，把"值相同就不写"和
      //   "只改 dshUrl、其它键原样保留"这两条都固化下来，单测能钉死。
      //   注意：这里每次都是重新读一遍文件再比对，不缓存 ——
      //   因为卡片（设置界面）随时可能改这个文件，缓存会写出旧值。
      const cur = readSettingsFile(paths.settings)
      const { changed, next } = computeDshUrlSettingsUpdate(cur, found)
      if (!changed) return { wrote: false }
      const ok = writeSettingsFile(paths.settings, next)
      if (!ok) {
        log('写 settings.json 失败（dshUrl 未能同步）')
        return { wrote: false }
      }
      return { wrote: true }
    },
    // 必须用 ctx 的 timer：它是随 fiber 销毁的 disposer 式定时器。
    // 取法按优先级：ctx.timeout（timer 服务混入到 ctx 上的形态，
    // 和本文件已有的 ctx.interval 同源）→ ctx.timer.timeout（服务对象形态）。
    // 两处都拿不到就返回 undefined，runner 会当场认输而不是假装还在重试。
    schedule: (cb, delayMs) => {
      if (typeof ctx.timeout === 'function') return ctx.timeout(cb, delayMs)
      const t = typeof ctx.get === 'function' ? ctx.get('timer') : null
      if (t && typeof t.timeout === 'function') return t.timeout(cb, delayMs)
      return undefined
    },
    log,
    // 默认节奏：250/500/1s/2s/4s/8s/8s，累计 23.75 秒
    plan: buildRetryPlan(),
  })

  // 卸载时把还挂着的重试定时器清掉。
  // 光靠 ctx.timeout 的自动清理不够 —— 还要阻止"已排队但还没跑"的回调
  // 在卸载后继续写 settings.json（stop() 会把 stopped 置 true，回调开头就退）。
  ctx.effect(() => () => { try { urlSync.stop() } catch { /* ignore */ } },
    'dsh-floating-window: url-sync')

  // 首次立即尝试（快路径：listen 已完成时一次就拿到，不会白等 250ms）
  try {
    urlSync.start()
  } catch (e) {
    log('启动同步 DSH 地址异常: ' + (e && e.message))
  }

  // ---------------------------------------------------------------- 自动拉起卡片
  //
  // 时机：在所有数据源注册、首份 state 写完、回填也启动之后。
  // 这样卡片一打开就有东西可读，不会先闪一下"空闲"。
  //
  // 语义：**已经在跑就什么都不做**。单实例由卡片自己的心跳兜底，
  // 所以判断错了也最多是"多起一个进程然后它自己退出"，不会叠出两张卡。
  //
  // 内部是双策略自适应（detached 优先，失败退回 attached），原因见 launcher.js。
  let launchPromise = null
  if (cfg.autoLaunch === true) {
    launchPromise = ensureCardRunning({
      panelDir: cardDir,
      dataDir: dir,
      log,
      staleMs: cfg.heartbeatStaleMs,
      // 【v0.10.4】首次拉起时多核对一步"心跳里那个 pid 还在不在"。
      //
      // 【为什么只在这一处打开】
      //   卡片是 attached 启动的（挂在本机 DSH 进程树里），DSH 一关它就跟着死。
      //   而"心跳过期"门槛 8 秒 > "DSH 重开"的 10~15 秒里最坏那种情况 ——
      //   只要重启够快，新插件读到的心跳就还没过期，于是判"卡片在跑"直接跳过拉起，
      //   屏幕上一张卡都没有，还不自愈。2026-10-31 14:04:56 就是这么发生的：
      //   日志说「卡片已在运行（pid=39096，心跳 6 秒前）」，而那张卡 5.6 秒前就死了。
      //
      //   监控循环（下面的 5 秒定时器）判据不同、有自己的一套去重和复查，
      //   不在这一版改动范围内。
      verifyPid: true,
    })
      .then((r) => {
        log('自动拉起结果: ' + JSON.stringify({ ok: r.ok, launched: r.launched, reason: r.reason, mode: r.mode }))
        if (!r.ok) {
          log('⚠️ 卡片没能自动启动。手动双击 panel\\run-panel.bat 试试，或者看上面的日志。')
        }
        return r
      })
      .catch((e) => {
        log('自动拉起异常: ' + (e && e.message))
        return null
      })

    // 不让失败的 Promise 变成未处理的拒绝
    ctx.effect(() => () => { try { launchPromise?.catch(() => {}) } catch { /* ignore */ } },
      'dsh-floating-window: launch-settle')
  } else {
    log('autoLaunch=false，不自动拉起卡片')
  }

  // 心跳监控：分两种情况，处理方式完全不同
  //
  //   1) 用户主动关掉（右键 -> 退出）-> 卡片会先把心跳写成 alive=false。
  //      这是用户的意愿，**不自动重开**，只记一条日志。
  //
  //   2) 卡片崩掉了（心跳还写着 alive=true 但早已过期）-> 用户什么都没做，
  //      卡片却消失了。这种情况必须**自动救回来**，否则用户面对的就是
  //      "卡片不见了，等多久都不回来" —— v0.5.1 就出过这个事故
  //      （点卡片触发定时器里的空引用，整个 WPF 应用退出）。
  //
  // 为什么要自动重开：卡片是 DSH 的常驻悬浮窗，用户没有"关掉它"的理由，
  // 突然消失只可能是故障。自动重开是修复动作，不是打扰。
  // 万一新版本有反复崩溃的 bug，这里也不会无限刷进程：
  // 每轮最多重开一次，且计数到 MAX_REVIVE 就停手并记日志。
  const MAX_REVIVE = 3

  // 【v0.9.12】因"代码更新"而重启的次数上限。
  //
  // 为什么是 2 而不是和崩溃恢复一样 3：
  //   崩溃恢复是在救一个已经不见了的东西，多试一次没有副作用。
  //   而因升级重启是**主动杀一个正常的卡片**，副作用更直接（窗口闪一下）。
  //   而且判据更可靠（比两个时间戳），一次不成就已经说明有问题了
  //   （比如拉起失败、或者时间戳逻辑本身有 bug），再试第三次只是让窗口多闪一下。
  const MAX_RESTART_FOR_UPDATE = 2
  let reviveCount = 0
  let reviving = false

  ctx.effect(() => {
    let wasAlive = false
    // 起始值 = 插件起来的时刻再往前推一个"心跳过期门槛"。
    //
    // 【目的（保持不变）】
    //   开机时那条**上一次运行留下的**过期心跳不算"新崩溃"
    //   （那种情况上面的 autoLaunch 已经在处理，这里再插一脚会重复启两次）。
    //
    // 【v0.10.4 为什么要往前推 staleMs —— 一个真 bug】
    //   原来这里是 `let lastCrashedAt = Date.now()`，等于"凡是在插件启动之前
    //   打的时间戳，一律当成已经处理过"。这有个致命的副作用：
    //     · 卡片在插件起来前几秒刚死（attached 模式下 DSH 一关它就是这种死法）
    //     · 心跳时间戳 = 死亡时刻，必然早于插件启动时刻
    //     → 被判成"上一次运行留下的旧心跳" → **永不重开，而且一句日志都不写**
    //
    //   实测（plugin.log 2026-10-31）：14:04:56 插件起来，卡片 14:04:51 死，
    //   之后 76 秒里监控循环跑了约 15 轮，零日志、零动作，屏幕上一张卡都没有。
    //
    //   往前推 staleMs（8 秒）之后："插件启动前 8 秒内死掉的卡片"会被当成
    //   真正需要处理的一次崩溃；只有更早那些才是"上一次运行留下的"。
    //   这个窗口刚好等于"心跳过期门槛"，语义上也对得上。
    let lastCrashedAt = Date.now() - (cfg.heartbeatStaleMs ?? 8000)
    let reviveCount = 0
    let reviving = false
    // 已经为哪个时间戳写过"这种情况不处理"的日志（避免每 5 秒刷一条）
    let alreadyHandledLoggedAt = 0

    // ---------------------------------------------------------- 【D6】pid 存活探测
    //
    // 【这个函数存在的唯一理由：把"判断不了"和"确定还活着"分开】
    //   launcher.js 里的 isProcessAlive 已经能区分三种结果，但直接调用它
    //   有个坑：它接受 undefined/NaN 并返回 null，而 pid 可能从心跳里拿到
    //   各种奇怪的值（字符串、负数、缺失）。这里做一层薄封装，保证：
    //     · 心跳里没有 pid（极老版本卡片）→ undefined
    //         （让 shouldReviveCard 保持旧行为，不因为"没 pid"就拒绝救命）
    //     · pid 有值且查得到 → true / false
    //     · 查的时候抛异常 → null（判断不了，保守不拉起）
    //
    // 【为什么没有 pid 要返回 undefined 而不是 null】
    //   null 会被 shouldReviveCard 当成"判断不了 → 保守不拉起"。
    //   但"心跳里根本没记 pid"是**老卡片的正常形态**，不是权限问题。
    //   对它保守不拉起，等于让老版本用户的卡片永远不被自动救活 ——
    //   这是比叠卡更难受的故障。所以返回 undefined，走旧逻辑照常救。
    const probePidAliveSafely = (rawPid) => {
      const n = Number(rawPid)
      if (!Number.isFinite(n) || n <= 0) return undefined
      try {
        return isProcessAlive(n)
      } catch {
        return null
      }
    }

    // ---------------------------------------------------------- 旧代码自动重启（v0.9.12）
    //
    // 【为什么要做】
    //   2026-10-29 的真实事故：代码改于 14:43，卡片进程起于 13:51，
    //   用户以为新功能没做，其实是**跑着 52 分钟前的旧代码**。
    //
    //   卡片是脱离 DSH 进程树的常驻进程，DSH 重启**不会**连带它重启。
    //   用户改完代码后唯一能做的就是手动"右键 → 退出 → 双击 run-panel.bat"，
    //   而多数时候他并不知道需要这么做。
    //
    // 【怎么判】
    //   心跳里的 scriptStampMs = 卡片启动时读到的 Panel.ps1 时间戳。
    //   和磁盘当前 mtime 比，落后超过 2 秒就是旧代码。判据在
    //   launcher.js 的 judgeCardStaleness（纯函数，可单测）。
    //
    // 【为什么放在这个 5 秒定时器里，不新增定时器】
    //   本项目有"只有 5 个 DispatcherTimer"的硬约束（见柱态设计文档第五节）。
    //   而且这里已经有每 5 秒一次的心跳读取，顺手多读一个文件 mtime 几乎零成本。
    //
    // 【为什么上限 2 次】
    //   如果重启后读到的还是旧时间戳（卡片启动失败 / 时间戳逻辑本身有 bug），
    //   不加限制就会陷入"杀→拉→还是旧→杀"的死循环，用户的卡片一直闪。
    //   2 次之后只记一条日志，交给人。
    let restartCount = 0
    let restarting = false
    let lastRestartAt = undefined

    const id = ctx.interval(() => {
      try {
        const hb = checkHeartbeat(dir, { staleMs: cfg.heartbeatStaleMs })

        // 【v0.8.0】把存活状态暴露出去给审批代理用（判据 C2）。
        // 写在这里而不是别处：这已经是每 5 秒一次的心跳检查，
        // 顺手写一个布尔，零额外 I/O。
        liveness.alive = hb.alive === true

        // ================================================ 旧代码检测
        //
        // 【顺序很重要：必须在 shouldReviveCard 之前】
        //   如果卡片跑着旧代码、同时又刚好没在跑（崩溃了），
        //   那就交给下面的恢复逻辑拉起 —— 拉起来的自然是新代码，
        //   不需要"先杀再拉"。所以这里只在**卡片活着**时才有意义，
        //   judgeCardStaleness 内部已经挡住了 hb.alive !== true 的情况。
        try {
          const diskStampMs = readPanelStampMs(join(cardDir, 'Panel.ps1'))
          const staleness = judgeCardStaleness(hb, { diskStampMs })
          const restartVerdict = shouldRestartForUpdate(staleness, {
            lastRestartAt,
            restartCount,
            maxRestart: MAX_RESTART_FOR_UPDATE,
            restarting,
            autoLaunch: cfg.autoLaunch === true,
          })

          if (restartVerdict.log) {
            // 只在真的要动手、或者"放弃自动重启"这两种情况记日志。
            // not-stale / not-running 这种每 5 秒都会命中的正常情况不写，避免刷屏。
            if (restartVerdict.restart || restartVerdict.reason === 'gave-up') {
              log(restartVerdict.log)
            }
          }

          if (restartVerdict.restart) {
            restartCount++
            restarting = true
            lastRestartAt = staleness.loadedStampMs
            log(`检测到卡片在跑旧代码，自动重启（第 ${restartCount} 次）…`)

            // 【为什么先杀再拉，而不是"直接拉一个"】
            //   卡片有单实例保护（心跳新鲜时新进程会安静退出），
            //   所以必须先让旧进程真正退出，否则新进程起来就自杀了。
            const stopResult = stopCardByHeartbeat(dir)
            log('停止旧卡片: ' + stopResult.reason)

            // ================================================================
            // 【v0.10.9 · C3】不再固定等 1200ms，改成"等到确实能启动"
            //
            // 【原来为什么是 1200ms，以及为什么它不够】
            //   见 launcher.js 里 waitForPreviousCardExit 上方那段长注释。
            //   一句话：强杀不写 alive=false，心跳要 8 秒才过期，
            //   而 1.2 秒后拉起的新卡片会被这份"新鲜的旧心跳"挡住 → 自杀。
            //   实测空窗约 13 秒。
            //
            // 【现在怎么判】
            //   旧 PID 已不存在 **且** 属于旧 PID 的心跳已失效
            //   （alive=false / 被新 PID 替换 / 按 staleMs 判过期）。
            //   用户 2026-11-02 拍板选的就是这一条。
            //
            // 【超时了怎么办 —— 这里必须想清楚】
            //   waitForPreviousCardExit 超时返回 ready=false。
            //   不能"超时也硬启动"（那正是原来 1.2 秒的问题），
            //   也不能永远不动（卡片就再也不回来了）。
            //   选择：**仍然尝试拉起**，但明确记一条 WARN。
            //   理由：卡片自己的单实例保护会兜底 —— 最坏情况是新进程起来后
            //   发现心跳新鲜、安静退出，等于白跑一次，但不会叠出两张窗。
            //   而不启动的后果是卡片彻底消失，那严重得多。
            //   这条取舍写在这里，将来有人调整时能看到为什么。
            // ================================================================
            const oldPid = stopResult.pid

            waitForPreviousCardExit({
              oldPid,
              dataDir: dir,
              staleMs: cfg.heartbeatStaleMs,
              log,
            })
              .then((exit) => {
                if (exit.ready !== true) {
                  log('警告: ' + exit.reason + ' —— 仍然尝试拉起（单实例保护会兜底）')
                } else if (exit.waitedMs > 0) {
                  log(`旧卡片已退出（等了 ${exit.waitedMs} ms），开始拉起新卡片`)
                }

                return ensureCardRunning({
                  panelDir: cardDir,
                  dataDir: dir,
                  log,
                  staleMs: cfg.heartbeatStaleMs,
                })
              })
              .then((r) => {
                log('因代码更新重启结果: ' + JSON.stringify({ ok: r.ok, launched: r.launched, reason: r.reason }))
                if (!r.ok) {
                  // 拉起失败要把次数退回去，否则重试预算被白白消耗
                  restartCount = Math.max(0, restartCount - 1)
                  lastRestartAt = undefined
                }
              })
              .catch((e) => {
                log('因代码更新重启异常: ' + (e && e.message))
                restartCount = Math.max(0, restartCount - 1)
                lastRestartAt = undefined
              })
              .finally(() => { restarting = false })
          }
        } catch (e) {
          // 旧代码检测是"锦上添花"，任何异常都不能影响主流程
          try { log('旧代码检测异常（已忽略）: ' + (e && e.message)) } catch { /* ignore */ }
        }

        const verdict = shouldReviveCard(hb, {
          wasAlive,
          lastCrashedAt,
          reviveCount,
          maxRevive: MAX_REVIVE,
          autoLaunch: cfg.autoLaunch === true,
          reviving,
          // ================================================================
          // 【D6 · 2026-11-03】把"那个 pid 现在还在不在"告诉 shouldReviveCard
          //
          // 【为什么必须在这里补这一句 —— 真实事故】
          //   本机曾同时跑着 3 张卡片，翻 plugin.log 才看清根因：
          //   旧卡片（pid 25260）**从未退出**，只是有段时间没写心跳，
          //   而这里把"心跳过期"当成了"卡片没了"，5 秒一轮地不断补新的，
          //   于是 11:21 / 11:40 / 12:27 各补了一张，越补越多。
          //
          // 【为什么只在 crashed 时才真的去查】
          //   verifyHeartbeatPid 要调一次系统接口（process.kill(pid, 0)），
          //   虽然很便宜，但没必要每 5 秒对每种情况都调。
          //   只有"心跳过期"这一种情况才需要区分"崩溃了"和"只是没写心跳"，
          //   其他分支（用户主动退出 / 情况不明）本来就不用 pid 结论。
          //
          // 【返回值的三种含义】见 probePidAlive 的注释
          // ================================================================
          pidAlive: hb.crashed === true ? probePidAliveSafely(hb.pid) : undefined,
        })

        // ----------------------------------------------------------------
        // 【v0.10.3：这条日志必须等"复查完"再写】
        //
        // 【修之前是什么样】
        //   这里是 `if (verdict.log) log(verdict.log)`，在**动手复查之前**就把
        //   "卡片异常退出（不是正常关闭）"写进了 ERR 日志。
        //   而 shouldReviveCard 给的那句话，是在"心跳过期"这个初始判断上说的，
        //   并非最终结论。
        //
        //   实际后果（2026-10-31 13:30 和 13:37 两次，原文）：
        //     [ERR] 卡片异常退出（不是正常关闭）：心跳过期（338 秒没更新，未正常退出）
        //     [INFO] 复查后心跳已恢复：卡片其实活着，是刚才没醒透，不重开
        //   结论其实被复查纠正了，但那条 ERR 已经落在文件里。
        //   卡片**根本没有异常退出**——它只是跟着电脑一起睡了。
        //   任何人（包括排查问题的我）翻日志都会以为卡片天天在崩。
        //
        // 【现在怎么改】
        //   "崩溃"这种话只在**复查确认之后**才写（见下面 .then 里）。
        //   还没复查的，只写一句如实描述现状的话，级别用 INFO：
        //     "心跳看着过期了，正在复查是不是电脑刚睡醒"
        //   这样日志里出现的每一条"异常退出"都对应真实故障。
        // ----------------------------------------------------------------
        // 【v0.10.3】给用户的日志措辞由 shouldReviveCard 统一决定，
        //   这里只负责"写不写、什么时候写"，不再自己拼一层包装
        //   （自己再包一层会得到"心跳看着不对（心跳过期（心跳过期（…）））"这种叠词）。
        //
        //   关键规矩：要动手复查的时候，这句日志**不下结论**，
        //   只如实描述"心跳看着不对、正在复查"。
        //   "异常退出 / 卡片确实不在了"这类结论，一律留到复查确认之后写
        //   （见下面 .then 里的两处）。
        //
        // 【v0.10.4：already-handled 那条要去重，其余照写】
        //   2026-10-31 实测：卡片 14:04:51 死、插件 14:04:56 起，
        //   心跳时间戳早于插件启动时刻 → 每 5 秒命中 already-handled 一次。
        //   以前这条完全静默（查不出原因），现在必须有日志；
        //   但它每 5 秒会重复出现，所以要按时间戳去重，只写第一次。
        if (verdict.log) {
          if (verdict.reason === 'already-handled') {
            if (verdict.stamp !== alreadyHandledLoggedAt) {
              alreadyHandledLoggedAt = verdict.stamp
              log(verdict.log)
            }
          }
          else {
            log(verdict.log)
          }
        }

        if (verdict.revive) {
          lastCrashedAt = verdict.stamp
          reviveCount++
          reviving = true
          ensureCardRunning({ panelDir: cardDir, dataDir: dir, log, staleMs: cfg.heartbeatStaleMs })
            .then((r) => {
              log('自动恢复结果: ' + JSON.stringify({ ok: r.ok, launched: r.launched, reason: r.reason }))

              // 【v0.10.1：睡眠唤醒的假象不能消耗恢复次数】
              //   电脑睡一觉醒来，心跳看起来"过期几小时"，ensureCardRunning
              //   会先等 2.6 秒复查；如果卡片自己接着写心跳了，它会返回
              //   reason='recovered-from-sleep'，并没有真的重开任何东西。
              //   这种情况属于"什么都没发生"，必须把次数和去重标记都退回去。
              if (r && r.reason === 'recovered-from-sleep') {
                // 【v0.10.3】复查确认是睡醒的假象 —— 这里才用大白话说清楚，
                //   而不是在动手前先喊一句"异常退出"。
                log('复查结论：卡片没事，是电脑刚睡醒还没写心跳。不重开，也不算崩溃')
                lastCrashedAt = 0
                reviveCount = Math.max(0, reviveCount - 1)
                return
              }

              // 【v0.10.2：只有"真的启动了新进程"才消耗恢复次数】
              //
              // 【为什么不能只看 r.ok】
              //   2026-10-31 用户实际踩到的问题：卡片一直在跑（08:18 启动），
              //   中间某一次心跳文件恰好读不到，被判成"卡片崩溃"并走了恢复流程。
              //   这次恢复其实什么都没启动（r.launched === false 或
              //   reason === 'already-running'），但次数照样 +1 了。
              //   反复几次就把 3 次预算耗光，最后变成"永久不再恢复"。
              //
              //   次数这个上限的本意是"别无限刷进程拖垮机器"，
              //   所以只有真的 spawn 了新进程才算数。没启动任何东西的尝试
              //   一律退次数、退去重标记，让下一轮还能正常判断。
              const reallyLaunched = r && r.ok === true && r.launched === true
              if (!reallyLaunched) {
                lastCrashedAt = 0
                reviveCount = Math.max(0, reviveCount - 1)
                log('这次恢复并没有真的启动新进程（卡片可能一直在跑），不消耗恢复次数')
                return
              }

              // 【v0.10.3】到这里才算"复查确认卡片真的没了，并且已重新拉起"。
              //   这是唯一该说"异常退出"的地方 —— 复查在前，结论在后，
              //   日志里每一句"异常退出"都对应真实的故障。
              log(`复查确认卡片确实不在了，已重新拉起（第 ${reviveCount} 次）`)

              // 【恢复失败要把去重标记退回去，否则再也不会重试】
              //   去重靠 lastCrashedAt 记"这个崩溃我处理过了"。
              //   但恢复失败时，心跳还是那一条（卡片没活过来，时间戳不会变），
              //   如果保留去重标记，下一轮就会认为"已经处理过"而永远不再尝试，
              //   卡片就真的永远回不来了 —— 这跟没修一样。
              if (!r.ok) {
                lastCrashedAt = 0
                reviveCount = Math.max(0, reviveCount - 1)   // 失败的尝试不该消耗次数
              }
            })
            .catch((e) => {
              log('自动恢复异常: ' + (e && e.message))
              lastCrashedAt = 0
              reviveCount = Math.max(0, reviveCount - 1)
            })
            .finally(() => { reviving = false })
        }

        // 【v0.10.1：卡片活回来了，把"连续恢复次数"清零 —— 这是"连续"二字的本意】
        //
        // 【原来的 bug】
        //   reviveCount 只在上面的失败分支里减，**成功之后从不归零**。
        //   于是它实际记的是"这个 DSH 进程里总共恢复过几次"，而不是
        //   "连续恢复失败了几次"。日志里的真实后果（2026-10-28 22:49:54）：
        //     卡片已连续异常退出 3 次，不再自动恢复。
        //     请手动运行 panel\run-panel.bat 排查。
        //   —— 那 3 次全是电脑睡眠唤醒造成的误判，卡片一次都没真崩过，
        //      但预算被累计用光，从此**卡片再也不自动回来，界面上没有任何提示**。
        //
        //   修完之后：只要卡片确认活着（心跳正常），计数就归零。
        //   真正的反复崩溃照样会被 3 次上限拦住（因为那种情况心跳一直是死的，
        //   走不到这一行），但"跨天的偶发误判"不会再加起来算。
        if (hb.alive === true && reviveCount !== 0) {
          reviveCount = 0
          log('卡片已恢复正常，连续恢复次数清零')
        }

        wasAlive = hb.alive
      } catch { /* ignore */ }
    }, 5000)
    return () => { try { id?.() } catch { /* ignore */ } }
  }, 'dsh-floating-window: heartbeat-watch')

  // ---------------------------------------------------------------- 调试入口
  return {
    debugSnapshot: () => state.snapshot(),
    debugTokens: () => tokens.debug(),
    debugCounts: () => (sources ? { ...sources.counts } : null),
    debugHeartbeat: () => checkHeartbeat(dir, { staleMs: cfg.heartbeatStaleMs }),
    debugLaunchResult: () => launchPromise,
    debugPush: () => { push('debug', true); return true },
    debugPaths: () => ({ ...paths, panelDir: cardDir }),
    // B8 排错入口：URL 同步重试到哪一步了（成功 / 第几次重试 / 已用尽）
    debugUrlSync: () => urlSync.state(),
  }
}
