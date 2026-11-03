/**
 * lib/endpoint.js -- 找出「这台 DSH 的网页地址」
 *
 * 【要解决的原始问题】
 *   卡片原先配的地址是写死的 `http://127.0.0.1:2278`。但 DSH 每次启动的端口
 *   是变的（实测这次是 11922）。端口一变，点卡片就跳到一个空白页，看着像"坏了"。
 *
 * 【这里只做一件事：问 DSH 要它自己的真实地址】
 *   DSH 自己就把地址存在 Service 里，不需要猜：
 *     · `ctx.webApp.getAdvertisedUrl()`  —— 对外公布的地址（可能含鉴权参数）
 *     · `ctx.webServer.getOrigin()`      —— 只给 scheme://host:port
 *
 * 【重要修正：拿不到 ≠ 没有。因此调用方必须重试】
 *   本文件之前的注释写的是"两者都用 ctx.get(...) 拿，不必写进 inject，
 *   拿不到就优雅退回"。这个判断只对了一半，而且那一半造成了真实的排错误导。
 *
 *   实测（2026-10-28，插件 v0.5.2）：
 *     - 每次启动 plugin.log 都是「配置: {...}」紧跟
 *       「拿不到 DSH 网页地址（webApp/webServer 都不可用）」，
 *       同毫秒级 → 说明这是启动早期的一次性调用。
 *     - 但用 cordis inspect 查运行时的 Service 目录，webServer / webApp
 *       **都存在且正常**。
 *     - 真正的原因在 webServer.getOrigin() 的官方契约里（原文）：
 *         throws: before `listen` binds a port,
 *                 or when the bind address has no URL form.
 *       也就是：插件 apply() 跑得太早，那一刻 webServer 还没完成 listen，
 *       服务对象拿得到，但取地址会 **throw**。
 *     - 本文件的两个 try/catch 把这个异常吞掉了，于是返回 null，
 *       调用方就只能写"服务都不可用"—— **这句话是错的**，服务在，只是没就绪。
 *
 *   所以现在分成两种失败，并且都要能被调用方看见：
 *     · notReady = true  —— 服务对象在，但访问器抛异常（典型：还没 listen）
 *     · notReady = false —— 服务真的没有（或拿到的地址不是 http(s)）
 *
 *   **结论：调用方（index.js）不能只试一次。** 正确做法是第一遍立即试，
 *   失败后按退避节奏重试（见下方 buildRetryPlan），成功一次就停。
 *   这样"启动瞬间没就绪"这个正常现象不会被误判成"服务缺失"。
 *
 * 【为什么不把 webServer/webApp 写进 inject】
 *   写进 inject 会让插件硬依赖这两个服务：在纯 CLI / 没有 Web 界面的
 *   DSH 形态下插件就装不上了。而"卡片能显示状态"这件事不依赖网址
 *   （点卡片回 DSH 主路径是 dsh:// 协议和激活窗口，网址只是兜底）。
 *   所以仍然用 ctx.get(...) 可选获取，靠重试解决时序问题。
 *
 * 【为什么"点卡片回到 DSH"不放在这里】
 *   只拿网址去开浏览器是不够的 —— DSH 是 Electron 桌面程序，
 *   网页只是它内部的界面。用浏览器打开只是"再开一个界面"，
 *   不会把已经开着的桌面窗口切到前面，而且该地址对未授权请求返回 401。
 *
 *   正确的做法是用 Windows 的 `dsh://` 协议唤起桌面程序本身。
 *   读注册表、发起协议调用都由**卡片**（Panel.ps1，PowerShell）来做 ——
 *   它本来就有这个权限，也不用在宿主里为了读一个注册表键去 spawn 子进程。
 *
 *   插件这边只负责把真实网址同步进 settings.json（纯文件操作，不起进程），
 *   作为卡片在"协议没注册"时的兜底。
 */

/**
 * 问 DSH 要它自己的网页地址（详细版）。
 *
 * 和 resolveDshUrl 的区别：这个版本会告诉你**为什么**没拿到，
 * 调用方才能写出不误导人的日志，也才能区分"该重试"和"重试也没用"。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {{ url: string|null, source: string|null, error: string|null, notReady: boolean }}
 *   · url      拿到了就是 http(s) 地址，否则 null
 *   · source   来源标识，没拿到时 null
 *   · error    最后一次失败原因（人话，可直接写进日志），成功时为 null
 *   · notReady 是否属于「服务已存在但尚未就绪」——这种失败**值得重试**
 */
export function resolveDshUrlDetailed(ctx) {
  /** 收集失败原因。第一条失败的往往最有用（webApp 是首选），但
   *  webServer 的 throw 才是"没就绪"的关键信号，所以两个都记，取能说明问题的。 */
  const errors = []
  let sawService = false      // 是否至少看到一个服务对象（存在但可能抛异常）
  let sawNotReady = false     // 是否出现过"服务在、但访问器抛异常"

  // 1) 官方宣传地址（最准，可能含鉴权参数）
  try {
    const webApp = ctx && typeof ctx.get === 'function' ? ctx.get('webApp') : undefined
    if (webApp && typeof webApp.getAdvertisedUrl === 'function') {
      sawService = true
      const url = webApp.getAdvertisedUrl()
      if (isHttpUrl(url)) {
        return { url: String(url).trim(), source: 'webApp.getAdvertisedUrl', error: null, notReady: false }
      }
      errors.push(`webApp.getAdvertisedUrl() 返回的不是 http(s) 地址: ${describeValue(url)}`)
    }
  } catch (e) {
    // 服务对象存在但访问器抛了 —— 这就是"还没 listen"的典型表现
    sawService = true
    sawNotReady = true
    errors.push('webApp.getAdvertisedUrl() 抛异常: ' + describeError(e))
  }

  // 2) 只拿 origin
  try {
    const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer && typeof webServer.getOrigin === 'function') {
      sawService = true
      const url = webServer.getOrigin()
      if (isHttpUrl(url)) {
        return { url: String(url).trim(), source: 'webServer.getOrigin', error: null, notReady: false }
      }
      errors.push(`webServer.getOrigin() 返回的不是 http(s) 地址: ${describeValue(url)}`)
    }
  } catch (e) {
    sawService = true
    sawNotReady = true
    errors.push('webServer.getOrigin() 抛异常: ' + describeError(e))
  }

  // 3) 都没成：把原因说清楚
  if (!sawService) {
    errors.push('ctx.get("webApp") 与 ctx.get("webServer") 都没拿到服务对象')
  }
  return {
    url: null,
    source: null,
    error: errors.length ? errors.join('；') : '未知原因',
    // 只要见过"服务在但抛异常"，就按"未就绪、值得重试"处理
    notReady: sawNotReady,
  }
}

/**
 * 问 DSH 要它自己的网页地址（简单版，保持旧契约）。
 *
 * 只返回 { url, source } 或 null。需要区分失败原因时用 resolveDshUrlDetailed。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {{ url: string, source: string } | null}
 */
export function resolveDshUrl(ctx) {
  const r = resolveDshUrlDetailed(ctx)
  if (!r.url) return null
  return { url: r.url, source: r.source }
}

/** 是不是一个可用的 http(s) 地址 */
function isHttpUrl(v) {
  return typeof v === 'string' && /^https?:\/\/\S+/i.test(v.trim())
}

/** 把任意值缩成一句能在日志里看的短文 */
function describeValue(v) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return v === '' ? '(空字符串)' : JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v)
  return `(${typeof v})`
}

/** 把异常缩成一句人话 */
function describeError(e) {
  if (!e) return '未知异常'
  const msg = typeof e.message === 'string' && e.message ? e.message : String(e)
  return msg.length > 120 ? msg.slice(0, 120) + '…' : msg
}

// ---------------------------------------------------------------- 重试节奏
//
// 【为什么重试节奏要抽成一个纯函数】
//   "重试几次、每次隔多久"是这段逻辑里唯一容易算错、又最容易回归的部分
//   （比如把上限算成 60 秒、或者最后一次延迟超过预算）。
//   抽成纯函数之后，单测可以不碰任何定时器就把它钉死，
//   而真正跑定时器的那部分（index.js）只负责按这个数组逐个排期。

/**
 * 重试策略默认值。
 *
 * 为什么是这个量级：
 *   · webServer listen 属于启动后期动作，实测卡片/mcp 这些都在秒级内完成；
 *   · 首次延迟必须小（250ms），否则常见情况下要白等半秒；
 *   · 上限 8 秒是为了别在"这台机器真的没有 Web 服务"时无限增长；
 *   · 总预算 30 秒：超过这个数还没就绪，说明不是"慢"，是"没有"，重试也无用。
 */
export const RETRY_POLICY = Object.freeze({
  /** 第一次重试前等多久 */
  firstDelayMs: 250,
  /** 单次延迟的上限（指数退避到这里就不再翻倍） */
  maxDelayMs: 8000,
  /** 所有重试延迟的累计预算；再往后重试就没意义了 */
  budgetMs: 30000,
})

/**
 * 算出退避重试的延迟序列（纯函数，不碰定时器）。
 *
 * 默认策略下产出：250, 500, 1000, 2000, 4000, 8000, 8000
 * （累计 23750ms；再加一次 8000 就超 30 秒预算，所以停在第 7 次）
 *
 * @param {{ firstDelayMs?: number, maxDelayMs?: number, budgetMs?: number }} [policy]
 * @returns {number[]} 每次重试前要等的毫秒数；空数组 = 不重试
 */
export function buildRetryPlan(policy) {
  const p = { ...RETRY_POLICY, ...(policy && typeof policy === 'object' ? policy : {}) }
  const first = Math.floor(p.firstDelayMs)
  const cap = Math.floor(p.maxDelayMs)
  const budget = Math.floor(p.budgetMs)

  const out = []
  // 参数不合法就干脆不重试（比抛异常好：这条链失败不该拖垮整个插件）
  if (!Number.isFinite(first) || !Number.isFinite(cap) || !Number.isFinite(budget)) return out
  if (first <= 0 || cap <= 0 || budget <= 0) return out

  let delay = Math.min(first, cap)
  let spent = 0
  // 安全上限：防止有人把 firstDelayMs 传成 1 导致数组爆炸
  while (spent + delay <= budget && out.length < 64) {
    out.push(delay)
    spent += delay
    delay = Math.min(delay * 2, cap)
    // delay 已经到 cap 且再加一次就超预算时，下一轮自然退出
  }
  return out
}

// ---------------------------------------------------------------- 写盘决策

/**
 * 算出「要不要把新地址写进 settings.json」，以及写进去的内容。
 *
 * 【为什么要单独一个函数】
 *   这段逻辑决定了两件事，都在真实事故里踩过：
 *     1) **只在值真的变了才写盘** —— 卡片每 500ms 读一次 settings.json，
 *        每次启动都无脑写一遍是纯浪费，还会把卡片惊动一次。
 *     2) **只改 dshUrl 这一个键，其它用户配置原样保留** —— 绝不能整份覆盖，
 *        否则会把用户在设置界面里改过的外观设置抹掉。
 *   抽成纯函数之后，这两条都能被单测钉死，而不是靠"读代码时小心"。
 *
 * @param {object|null|undefined} current 现在 settings.json 里的内容
 * @param {{ url: string }|null|undefined} found 刚取到的地址
 * @returns {{ changed: boolean, next: object }}
 *   changed=false 表示不需要写盘（值相同，或没取到地址）
 */
export function computeDshUrlSettingsUpdate(current, found) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  // 浅拷贝：不修改调用方传进来的对象
  const next = { ...base }

  if (!found || typeof found.url !== 'string' || !found.url) {
    return { changed: false, next }
  }

  if (next.dshUrl === found.url) {
    return { changed: false, next }
  }

  next.dshUrl = found.url
  // 已经注册了 dsh:// 协议就用协议，否则退回网址。
  // 只在用户从没设过这个键时补默认值 —— 已有的值一律不覆盖。
  if (next.openMode === undefined) next.openMode = 'protocol'
  return { changed: true, next }
}

// ---------------------------------------------------------------- 重试执行器

/**
 * 建一个「取地址 → 失败就退避重试 → 成功即停」的执行器。
 *
 * 【为什么不直接在这里写 setTimeout】
 *   定时器必须由调用方注入（index.js 注入 ctx 的 time service）。
 *   裸 setTimeout 会有两个真实问题：
 *     · 插件卸载后定时器还在 → 泄漏；
 *     · 卸载后回调才跑 → 在已销毁的 ctx 上继续读配置、写文件。
 *   注入之后，调用方能在卸载时调 stop()，而单测能塞一个假定时器，两边都干净。
 *
 * @param {object} options
 * @param {() => { url: string|null, source: string|null, error: string|null, notReady: boolean }} options.resolveOnce
 * @param {(found: { url: string, source: string }) => { wrote?: boolean }} [options.commit]
 *        真正写盘的动作；返回 { wrote: true } 表示确实写了文件。
 * @param {(cb: () => void, delayMs: number) => (() => void)} options.schedule
 *        排一个一次性定时器，返回 disposer。
 * @param {(msg: string) => void} [options.log]
 * @param {number[]} [options.plan] 重试延迟序列，默认 buildRetryPlan()
 * @returns {{ start: () => object, stop: () => void, state: () => object }}
 */
export function createUrlSyncRunner(options) {
  const opts = options || {}
  const resolveOnce = typeof opts.resolveOnce === 'function' ? opts.resolveOnce : () => ({ url: null, error: '未提供 resolveOnce', notReady: false })
  const commit = typeof opts.commit === 'function' ? opts.commit : null
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const plan = Array.isArray(opts.plan) ? opts.plan.slice() : buildRetryPlan()

  // ---------------------------------------------------------------- 显式级别
  //
  // 【为什么这里必须显式指定级别，不能继续让关键词猜（D4 第一类问题）】
  //   '取 DSH 网页地址失败（服务尚未就绪），将在 250ms 后重试（第 1 次）'
  //   这是一条**完全正常**的日志：DSH 刚启动，webApp 还没 listen 完，
  //   等 250ms 再试就好了 —— 它属于"启动时序"，不属于"出错"。
  //   但 classifyLevel 看到"失败"就判 ERR，于是每次正常启动都会在
  //   plugin.log 里留一串红色错误。这种"狼来了"的直接后果是：
  //   真出事那天，红色已经看习惯了，没人会多看一眼。
  //
  //   所以这四条路径不再靠猜，按**事实**分级：
  //     正常重试（还没就绪，会自己好）  → INFO
  //     重试用尽 / 排不上重试（功能降级）→ WARN
  //     真的写盘失败（文件系统层面）    → ERR
  //
  // 【为什么做成 logAt 这个适配层，而不是直接把 log 换成 log.warn】
  //   log 是**调用方注入**的（index.js 传 createLogger() 的返回值，
  //   单测传自己的假函数）。注入的普通函数上没有 .info / .warn / .err。
  //   直接写 log.info(...) 到了单测里就是 "log.info is not a function"，
  //   会把整条地址同步链炸掉 —— 而这条链挂了，卡片就永远拿不到地址。
  //   所以：有分级方法就用，没有就退回原来的 log(msg)，行为绝不变差。
  const logAt = (level, message) => {
    try {
      const fn = log && log[level]
      if (typeof fn === 'function') { fn.call(log, message); return }
      log(message)
    } catch {
      // 日志失败绝不允许影响地址同步（日志是旁路，不是功能）
    }
  }

  let retryCount = 0        // 已经排过几次重试
  let done = false          // 已经结束（成功 / 用尽 / 已停止）
  let stopped = false       // 调用方主动停
  let pendingDispose = null // 当前挂着的那个定时器的 disposer

  const stop = () => {
    stopped = true
    done = true
    try { if (pendingDispose) pendingDispose() } catch { /* ignore */ }
    pendingDispose = null
  }

  const step = (isRetry) => {
    if (done || stopped) return { done: true, stopped: true }

    let r
    try {
      r = resolveOnce()
    } catch (e) {
      r = { url: null, error: '取地址时抛异常: ' + describeError(e), notReady: false }
    }

    // ---- 拿到了：写盘（只在值变了才写）然后收工
    if (r && r.url) {
      done = true
      let wrote = false
      let commitFailed = false
      if (commit) {
        try {
          const c = commit({ url: r.url, source: r.source })
          wrote = !!(c && c.wrote)
        } catch (e) {
          commitFailed = true
          // 【ERR】这是真的失败了：地址拿到了，但写不进 settings.json。
          //   用户能感知的后果是"卡片点开还是旧地址"，必须让人看见。
          logAt('err', '同步 DSH 地址失败: ' + describeError(e))
        }
      }
      // 日志分三种，别混着写：
      //   重试过才成功 → 说清重试了几次（这是排错时最想知道的信息）
      //   首次即成功且写了盘 → "已把地址同步"
      //   首次即成功但没写盘 → "地址未变"（值相同或写失败）
      if (isRetry) {
        // 【INFO】重试后拿到了 —— 这是好消息，不是错误
        logAt('info', `已获取 DSH 网页地址 ${r.url}（来源 ${r.source}，重试 ${retryCount} 次）`)
      } else if (wrote) {
        logAt('info', `已把 DSH 地址同步到 settings.json: ${r.url}（来源 ${r.source}）`)
      } else if (!commitFailed) {
        // commitFailed 时上面已经记过失败原因了，不要再说"未变"误导人
        logAt('info', `DSH 地址未变: ${r.url}（来源 ${r.source}）`)
      }
      return { done: true, wrote, retryCount }
    }

    const err = (r && r.error) || '未知原因'

    // ---- 还有重试额度吗
    if (retryCount >= plan.length) {
      done = true
      // 【WARN，不是 ERR】重试用尽意味着功能降级（卡片只能用协议方式打开），
      //   但插件本身没坏、DSH 也没坏 —— 属于"要人看见"但"不到报错级"。
      logAt('warn', `已重试 ${plan.length} 次仍取不到 DSH 网页地址（最后错误：${err}），卡片将用协议方式打开`)
      return { done: true, exhausted: true, retryCount }
    }

    // ---- 排下一次
    const delay = plan[retryCount]
    retryCount++
    // 说人话：区分"还没就绪（会自己好）"和"真的没有（重试也没用）"
    const why = r && r.notReady === false ? err : '服务尚未就绪'
    // 【INFO，这是 D4 第一类问题的核心修复】
    //   这句话里带着"失败"两个字，但它描述的是**正常启动时序**：
    //   DSH 服务在，只是还没 listen，等一会儿就好。
    //   以前靠关键词猜 → 每次正常启动都刷一串红色 ERR。
    //   现在显式指定 INFO，红只留给真的坏事。
    logAt('info', `取 DSH 网页地址失败（${why}），将在 ${delay}ms 后重试（第 ${retryCount} 次）`)

    // 【注意：判断的是"排期有没有成功"，不是"schedule 函数在不在"】
    //   定时器可能因为宿主环境拿不到 timer 服务而无法排期，
    //   这时 schedule 往往返回 undefined 而不是抛异常。
    //   如果只看 `if (!schedule)`，就会走不到这个分支 ——
    //   结果是明明没排上任何定时器，却对外声称"正在重试"，
    //   然后永远不写地址（正是要修的那类静默失败）。
    if (schedule) {
      try {
        pendingDispose = schedule(() => {
          pendingDispose = null
          // 卸载后残留的回调走到这里要立刻退，绝不能继续写文件
          if (stopped) return
          step(true)
        }, delay)
      } catch {
        pendingDispose = null
      }
    }

    if (!pendingDispose) {
      // 排不上定时器 = 重试链断了。当场认输，别假装还在重试。
      // 措辞要分清两种情况，否则日志会写成"已重试 0 次仍取不到"，读着莫名其妙：
      //   · 一次都没排上（retryCount=1，本次刚失败）→ 说"无法排期重试"
      //   · 中途排不上了 → 说"已重试 N 次"
      done = true
      const doneTimes = retryCount - 1
      if (doneTimes <= 0) {
        // 【WARN】排不上定时器 = 重试链断了，地址同步功能实质失效。
        //   还不是 ERR：插件其他功能都正常，只是打不开网页版。
        logAt('warn', `取 DSH 网页地址失败，且当前环境无法排期重试（最后错误：${err}），卡片将用协议方式打开`)
      } else {
        logAt('warn', `已重试 ${doneTimes} 次仍取不到 DSH 网页地址（最后错误：${err}），卡片将用协议方式打开`)
      }
      return { done: true, exhausted: true, retryCount }
    }

    return { done: false, delay, attempt: retryCount }
  }

  return {
    start: () => step(false),
    stop,
    state: () => ({ retryCount, done, stopped, planLength: plan.length }),
  }
}

/** 协议名。DSH 安装时注册的就是这个。 */
export const DSH_PROTOCOL = 'dsh'

/**
 * 把网址规整成能直接交给 `Start-Process` 的形式。
 * 主要防一种情况：Address 里带空格或畸形字符。
 * @param {string} url
 * @returns {string | null}
 */
export function normalizeUrl(url) {
  if (!isHttpUrl(url)) return null
  try {
    const u = new URL(url.trim())
    // 只接受 http/https，且必须有 host
    if (!u.host) return null
    return u.toString()
  } catch {
    return null
  }
}
