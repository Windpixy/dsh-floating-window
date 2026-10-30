/**
 * lib/sources.js -- 接 DSH 的真实事件
 *
 * 这一层只负责"把 DSH 发生的事喂给 CardState 和 TokenTracker"，
 * 不含任何显示逻辑。所有 listener 都包了 try/catch：
 * 插件在这里抛异常会污染 DSH 的事件链，绝不能发生。
 *
 * 数据源全部经 M0 实测验证（见 M0-探针验收报告.md）：
 *
 *   api-session/added    会话出现   → 谁在跑、是不是子任务、cwd
 *   api-session/status   开跑/停跑  → 「运行中」的主信号
 *   api-session/removed  会话消失
 *   session/event        session/title    → 任务标题
 *                        tool/call        → 「正在做什么」
 *                        assistant/message → Token 用量
 *                        approval/asked   → 待审批出现
 *                        approval/decided → 待审批消失
 *   session/created      补漏：会话建立
 *   sessionPersistence   启动回填今日 Token（用 open + handle.read）
 *   sessionProjectionCache 零 I/O 读标题
 */

/** 从 tool/call 的参数里取一小段，够 describeTool 抠文件名就行 */
function argsPreview(args) {
  if (typeof args !== 'string') return ''
  return args.length > 300 ? args.slice(0, 300) : args
}

/** usage 里真正"用掉"的 token 数 —— 口径要和官方账本一致。
 *
 * 【这一条是实测校准出来的，别凭直觉改】
 *
 * DSH 的 usage 有四个数字：
 *   inputTokens      本次新读入的 token
 *   cacheReadTokens  上下文缓存命中的 token（重复发送的历史）
 *   outputTokens     模型输出的 token
 *   totalTokens      上面几项之和（约等于 input + cacheRead + output）
 *
 * 直觉上"只算新增的"应该用 input + output，但实测打脸：
 *   按 input+output 算 → 8,618,054
 *   官方账本同一天     → 387,802,929
 *   差 45 倍。
 *
 * 原因：对话越长，历史上下文全部走缓存，input 只有区区几千，
 * 而 cacheRead 有几亿。账本的 input 字段实际包含缓存读取。
 *
 * 实测对齐结果（2026-10-27 真实数据）：
 *   我们 input+cacheRead+output = 391,632,006
 *   官方账本 input+output       = 387,802,929
 *   差 0.98%（时间差导致，统计时又用了一些 Token）
 *
 * 所以卡片显示的应该是"总共消耗了多少上下文"，即三项之和。
 * 这也符合用户直觉：问他"今天用了多少 Token"，他想知道的是总吞吐量。
 */
export function usageAmount(usage) {
  if (!usage || typeof usage !== 'object') return 0
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.outputTokens)
}

/**
 * 注册所有实时监听。
 *
 * @param {object} ctx DSH 的 Cordis context
 * @param {object} deps
 * @param {import('./state.js').CardState} deps.state
 * @param {import('./tokens.js').TokenTracker} deps.tokens
 * @param {(reason: string, urgent?: boolean) => void} deps.onChange 状态变了，请写盘
 * @param {(msg: string, extra?: unknown) => void} deps.log
 * @returns {{ dispose: () => void, counts: object }}
 */
export function registerSources(ctx, deps) {
  const { state, tokens, onChange, log } = deps
  const counts = {
    added: 0, status: 0, removed: 0, sessionEvent: 0,
    title: 0, toolCall: 0, usage: 0, asked: 0, decided: 0, created: 0, errors: 0,
  }

  const disposers = []

  /** 统一包一层，保证任何异常都不会往外抛 */
  const guard = (name, fn) => (...args) => {
    try {
      return fn(...args)
    } catch (e) {
      counts.errors++
      log(`监听 ${name} 出错: ` + (e && e.message), { stack: e && e.stack ? String(e.stack).slice(0, 400) : undefined })
      return undefined
    }
  }

  const on = (event, handler, options) => {
    try {
      const off = ctx.on(event, handler, options ?? { global: true })
      if (typeof off === 'function') disposers.push(off)
    } catch (e) {
      log(`注册 ${event} 失败: ` + (e && e.message))
    }
  }

  // ---------------------------------------------------------------- 会话生命周期

  on('api-session/added', guard('api-session/added', (summary) => {
    if (!summary || typeof summary !== 'object') return
    const sessionId = summary.sessionId ?? summary.session?.id
    if (!sessionId) return
    counts.added++
    const changed = state.sessionAdded({
      sessionId: String(sessionId),
      running: summary.running === true,
      blank: summary.blank === true,
      parentSessionId: summary.parentSessionId ? String(summary.parentSessionId) : undefined,
      origin: summary.origin,
      cwd: typeof summary.cwd === 'string' ? summary.cwd : undefined,
    })
    // added 会重复发，只在真的有变化时写盘
    if (changed) onChange('session-added')
  }))

  on('api-session/status', guard('api-session/status', (sessionId, running) => {
    if (!sessionId) return
    counts.status++
    const before = state.pendingApprovals.size
    const changed = state.sessionStatus(String(sessionId), running === true)
    if (changed) {
      // 停跑时如果这个会话还有待审批，一并清掉（审批不可能比停跑还晚）
      if (running !== true) {
        for (const [id, a] of [...state.pendingApprovals.entries()]) {
          if (a.sessionId === String(sessionId)) state.approvalDecided(id)
        }
      }
      onChange('session-status', state.pendingApprovals.size !== before)
    }
  }))

  on('api-session/removed', guard('api-session/removed', (sessionId) => {
    if (!sessionId) return
    counts.removed++
    if (state.sessionRemoved(String(sessionId))) onChange('session-removed')
  }))

  on('session/created', guard('session/created', (session) => {
    const header = session && session.header
    const id = header && header.id
    if (!id) return
    counts.created++
    const changed = state.sessionAdded({
      sessionId: String(id),
      running: false,
      blank: true,
      parentSessionId: header.parentSession ? String(header.parentSession) : undefined,
      origin: header.origin,
      cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
    })
    if (changed) onChange('session-created')
  }))

  // ---------------------------------------------------------------- 会话内事件

  on('session/event', guard('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    counts.sessionEvent++

    const header = session && session.header
    const sessionId = (session && (session.id ?? (header && header.id))) ?? (event.sessionId)
    const sid = sessionId ? String(sessionId) : ''
    const type = event.type

    switch (type) {
      case 'session/title': {
        const title = event.data && event.data.title
        if (!sid || typeof title !== 'string') return
        counts.title++
        if (state.sessionTitle(sid, title)) onChange('title')
        return
      }

      case 'tool/call': {
        const d = event.data || {}
        if (!sid) return
        counts.toolCall++
        if (state.toolCall(sid, d.name, argsPreview(d.arguments))) onChange('tool-call')
        return
      }

      case 'assistant/message': {
        const u = event.data && event.data.usage
        const amount = usageAmount(u)
        counts.usage++
        if (amount <= 0) return
        const seq = Number(event.seq)
        if (tokens.addLive(sid, Number.isFinite(seq) ? seq : 0, amount)) {
          onChange('tokens')
        }
        return
      }

      case 'approval/asked': {
        const d = event.data || {}
        counts.asked++
        // 【v0.8.0 补上的 callId】
        //   approval/asked 事件里带着 callId（实测 probe.log 里有值：
        //   call_00_0WDEac3fSCG7pBvARCOD5799），而 approval/request 瀑布里的
        //   请求**不带审批编号**（编号是 ApprovalService 内部 randomUUID 生成的）。
        //   所以 callId 是把"瀑布里的请求 ↔ 日志里的审批编号"配对的**唯一钥匙**。
        //   原来这里漏传了，导致审批代理无法配对 —— 不补整个悬浮窗审批不成立。
        if (state.approvalAsked({
          id: d.id,
          sessionId: sid,
          toolName: d.toolName,
          reason: d.reason,
          callId: d.callId,
        })) {
          // 待审批是急事，立刻写盘，不等节流
          onChange('approval-asked', true)
          // 配对成功后通知审批代理（可选注入；代理出错不能影响主链路）
          try { deps.onApprovalAsked?.(d.id) } catch { /* ignore */ }
        }
        return
      }

      case 'approval/decided': {
        const d = event.data || {}
        counts.decided++
        if (state.approvalDecided(d.id)) onChange('approval-decided', true)
        try { deps.onApprovalDecided?.(d.id) } catch { /* ignore */ }
        return
      }

      case 'session/title-llm-request':
      default:
        return
    }
  }))

  log('实时监听已注册', { listeners: disposers.length })

  return {
    dispose() {
      for (const off of disposers) {
        try { off() } catch { /* ignore */ }
      }
      disposers.length = 0
    },
    counts,
  }
}

// ================================================================ 启动时对齐现有会话

/**
 * 插件启动时，DSH 里可能已经有会话在跑了（最常见的就是"当前这个对话"）。
 * 那些会话的 api-session/added 早就发过了，我们收不到。
 *
 * 这一段负责：启动时主动扫一遍现有会话，把"现在谁在跑"补进状态，
 * 否则卡片在插件加载后的第一段时间里会显示"空闲"，
 * 而实际上你正在跟它对话——这是最刺眼的一个错误。
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {import('./state.js').CardState} deps.state
 * @param {(reason: string, urgent?: boolean) => void} deps.onChange
 * @param {(msg: string, extra?: unknown) => void} deps.log
 * @returns {{ agents: number, running: number }}
 */
export function syncExistingSessions(ctx, deps) {
  const { state, onChange, log } = deps
  const result = { agents: 0, running: 0, errors: 0 }

  // ctx.agents.list() 返回所有活着的 Agent
  let agents = []
  try {
    const svc = ctx.get('agents')
    if (svc && typeof svc.list === 'function') {
      agents = svc.list()
    }
  } catch (e) {
    log('读取现有 Agent 失败: ' + (e && e.message))
    return result
  }

  if (!Array.isArray(agents) || agents.length === 0) {
    // 正常现象：插件往往比 Agent 先加载。调用方会重试，所以这里不刷日志。
    return result
  }
  result.agents = agents.length

  // 诊断：只在第一次见到 Agent 时打一次结构，方便确认
  // agent.session.header / agent.status 这层假设对不对
  if (!deps._loggedShape) {
    deps._loggedShape = true
    try {
      const a0 = agents[0]
      const session = a0 && a0.session
      const header = session && session.header
      log('Agent 结构诊断（首次见到 Agent 时打一次）', {
        agentKeys: a0 && typeof a0 === 'object' ? Object.keys(a0).slice(0, 20) : 'n/a',
        agentStatus: a0 && a0.status,
        hasSession: !!session,
        sessionKeys: session && typeof session === 'object' ? Object.keys(session).slice(0, 15) : null,
        hasHeader: !!header,
        headerKeys: header && typeof header === 'object' ? Object.keys(header) : null,
        headerId: header && header.id ? String(header.id).slice(0, 30) : null,
      })
    } catch { /* 诊断失败无所谓 */ }
  }

  let changed = false
  for (const agent of agents) {
    try {
      const session = agent && (agent.session ?? agent)
      const header = session && session.header
      const id = (header && header.id) ?? (agent && agent.id)
      if (!id) continue

      // Agent 有没有在跑？看它的 status。
      // DSH 的 Agent 对象上 status 是 'idle' | 'running'（见 agent/status 事件说明）
      let running = false
      const st = agent && agent.status
      if (typeof st === 'string') running = st === 'running'

      const didChange = state.sessionAdded({
        sessionId: String(id),
        running,
        blank: false,   // 已经有 header 就说明不是空会话
        parentSessionId: header && header.parentSession ? String(header.parentSession) : undefined,
        origin: header && header.origin,
        cwd: header && typeof header.cwd === 'string' ? header.cwd : undefined,
        createdAt: header && typeof header.createdAt === 'number' ? header.createdAt : undefined,
      })
      if (didChange) changed = true
      if (running) result.running++

      // 顺手补水工具调用信息：Agent 上可能有最近一条工具调用的痕迹，
      // 但没有就跳过（"正在运行"已经够用）
      try {
        const t = agent && agent.lastToolName
        if (running && typeof t === 'string' && t) state.toolCall(String(id), t, '')
      } catch { /* 忽略 */ }
    } catch (e) {
      result.errors++
      log('同步单个 Agent 失败: ' + (e && e.message))
    }
  }

  if (result.agents > 0) log('对齐现有会话结果', result)
  if (changed) onChange('sync-existing', true)
  return result
}

// ================================================================ 启动回填

/**
 * 等 sessionPersistence 就绪。
 *
 * 【为什么需要等】
 * 插件加载和 service 就绪有先后。实测同一次 DSH 启动里：
 *   第一次触发回填时 list() 在（成功了）
 *   热重载后再触发就报 "sessionPersistence 未提供 list()"
 * 这是纯时序问题，不是服务不存在。所以要看一眼就放弃，得等。
 *
 * @returns {Promise<object|null>} 可用的 persistence；超时返回 null
 */
async function waitForPersistence(ctx, log, options = {}) {
  const totalMs = options.totalMs ?? 15000
  const stepMs = options.stepMs ?? 500
  const deadline = Date.now() + totalMs
  let lastReason = ''

  for (;;) {
    let p
    try {
      p = ctx.get('sessionPersistence')
    } catch (e) {
      lastReason = 'ctx.get 抛错: ' + (e && e.message)
      p = undefined
    }

    if (p) {
      if (typeof p.list === 'function') return p
      lastReason = '服务对象存在但没有 list()；现有方法: ' +
        Object.keys(p).filter(k => typeof p[k] === 'function').slice(0, 12).join(', ')
    } else {
      lastReason = 'ctx.get 返回 undefined'
    }

    if (Date.now() >= deadline) {
      log(`等 sessionPersistence 超时（${totalMs}ms）：${lastReason}`)
      return null
    }
    await new Promise(r => setTimeout(r, stepMs))
  }
}

/**
 * 回填"今天已经用掉的 Token"，并把还没标题的会话补上标题。
 *
 * M0 实测：22 个会话、22940 条事件，1137ms。可接受，所以异步跑，
 * 不阻塞插件启动（卡片先显示 0，回填完自然跳上去）。
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {import('./state.js').CardState} deps.state
 * @param {import('./tokens.js').TokenTracker} deps.tokens
 * @param {(reason: string, urgent?: boolean) => void} deps.onChange
 * @param {(msg: string, extra?: unknown) => void} deps.log
 * @param {object} [options]
 * @param {boolean} [options.backfillTokens] 是否回填 Token
 * @param {boolean} [options.fillTitles] 是否补标题
 * @param {number} [options.waitMs] 最多等 persistence 多久
 * @returns {Promise<object>} 回填统计
 */
export async function backfill(ctx, deps, options = {}) {
  const { state, tokens, onChange, log } = deps
  const doTokens = options.backfillTokens !== false
  const doTitles = options.fillTitles !== false
  const started = Date.now()
  const result = {
    ok: false, ms: 0, sessions: 0, sessionsFailed: 0,
    eventsScanned: 0, usageEvents: 0, tokensAdded: 0,
    titlesFilled: 0, waitedMs: 0, reason: '',
  }

  // sessionPersistence 是可选依赖：等不到就跳过回填，插件继续工作
  const waitStart = Date.now()
  const persistence = await waitForPersistence(ctx, log, { totalMs: options.waitMs ?? 15000 })
  result.waitedMs = Date.now() - waitStart
  if (!persistence) {
    result.reason = 'sessionPersistence 一直没就绪'
    log('回填跳过：' + result.reason)
    return result
  }

  // 标题缓存（零 I/O）：有就用，拿不到再靠事件补
  let projCache = undefined
  try { projCache = ctx.get('sessionProjectionCache') } catch { /* 可选 */ }

  if (doTokens) tokens.beginBackfill()

  // 适配两代 sessionPersistence API：
  //   0.1.2 及以前：直接有 readFrom / locate
  //   0.1.3 起：改成 open() + handle.read()
  const openRead = async (id) => {
    if (typeof persistence.open === 'function') {
      const handle = await persistence.open(id, 'read')
      try {
        const slice = await handle.read(0)
        const events = Array.isArray(slice) ? slice : (slice && slice.events)
        return { handle, events: Array.isArray(events) ? events : [] }
      } catch (e) {
        try { await handle.close?.() } catch { /* ignore */ }
        throw e
      }
    }
    if (typeof persistence.readFrom === 'function') {
      const r = await persistence.readFrom(id, 0)
      const events = Array.isArray(r) ? r : (r && r.events)
      return { handle: null, events: Array.isArray(events) ? events : [] }
    }
    throw new Error('sessionPersistence 既没有 open() 也没有 readFrom()')
  }

  const closeRead = async (handle) => {
    if (!handle) return
    try { await handle.close?.() } catch { /* ignore */ }
    try { await handle[Symbol.asyncDispose]?.() } catch { /* ignore */ }
  }

  try {
    const snapshots = await persistence.list()
    const list = Array.isArray(snapshots) ? snapshots : []
    result.sessions = list.length
    const dayStartMs = tokens.dayStartMs

    for (const snap of list) {
      const header = (snap && (snap.header ?? snap)) || {}
      const id = header.id ?? (snap && snap.id)
      if (!id) continue

      // ---- 标题：优先走投影缓存（零 I/O）
      let gotTitle = false
      if (doTitles && projCache && typeof projCache.cachedSnapshot === 'function') {
        try {
          const got = projCache.cachedSnapshot(header, ['title'])
          const t = got && got.values && got.values.title
          if (typeof t === 'string' && t.trim()) {
            if (state.sessionTitle(String(id), t)) result.titlesFilled++
            gotTitle = true
          }
        } catch { /* 缓存没命中就算了 */ }
      }

      // 标题没拿到、又需要标题 → 得读事件才能找到 session/title
      // （session/title 只在标题生成的那一刻推一次事件，
      //   插件启动时早就过去了，所以必须从日志里翻）
      const needReadForTitle = doTitles && !gotTitle
      if (!doTokens && !needReadForTitle) continue

      // ---- 读事件：Token 累加 + 找标题
      let opened = null
      try {
        opened = await openRead(id)
        const events = opened.events
        result.eventsScanned += events.length
        let amount = 0
        let maxSeq = 0
        let titleFromLog = ''
        for (const ev of events) {
          const seq = Number(ev && ev.seq)
          if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq

          // 顺手记标题（取最后一条，因为标题可能被改过）
          if (ev && ev.type === 'session/title') {
            const t = ev.data && ev.data.title
            if (typeof t === 'string' && t.trim()) titleFromLog = t
          }

          if (!doTokens) continue
          if (!ev || ev.type !== 'assistant/message') continue
          const u = ev.data && ev.data.usage
          if (!u) continue
          const t = Number(ev.time)
          if (!Number.isFinite(t) || t < dayStartMs) continue
          const a = usageAmount(u)
          if (a > 0) {
            amount += a
            result.usageEvents++
          }
        }

        if (needReadForTitle && titleFromLog) {
          if (state.sessionTitle(String(id), titleFromLog)) result.titlesFilled++
        }

        if (amount > 0) {
          tokens.addBackfill(String(id), maxSeq, amount)
          result.tokensAdded += amount
        } else {
          // 即使今天没用量，也要记水位线，防止把旧事件的实时重复计入
          tokens.addBackfill(String(id), maxSeq, 0)
        }
      } catch (e) {
        result.sessionsFailed++
        log(`回填会话 ${String(id).slice(0, 20)}… 失败: ` + (e && e.message))
      } finally {
        await closeRead(opened && opened.handle)
      }
    }

    if (doTokens) {
      const merged = tokens.endBackfill()
      log('回填缓冲合并', merged)
    }

    // 回填完，把状态推给卡片
    onChange('backfill-done', true)
    result.ok = true
  } catch (e) {
    result.reason = String(e && (e.message ?? e))
    log('回填失败: ' + result.reason)
    // 失败也要结束回填状态，否则后续实时事件永远进缓冲
    if (doTokens) {
      try { tokens.endBackfill() } catch { /* ignore */ }
    }
  }

  result.ms = Date.now() - started
  log('回填完成', result)
  return result
}
