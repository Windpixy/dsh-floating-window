/**
 * lib/state.js -- 纯逻辑层：把「DSH 发生了什么」换算成「卡片要显示什么」
 *
 * 这个文件刻意不 import 任何 DSH / Node 的东西（只用 Date.now 这类标准能力），
 * 所以可以用 `node test/unit.mjs` 直接跑，改逻辑不用重启 DSH。
 *
 * 它遵守的唯一约定是卡片现有的数据格式（progress.md 1.3）：
 *
 *   {
 *     updatedAt: <秒>,
 *     tasks:     { running: <数字>, sessions: [ { title, elapsedSec, activity } ] },
 *     approval:  { pending: <数字>, items: [ { title } ] },
 *     lastFinished: "20261027151958" | null,
 *     tokens:    { today: <数字> }
 *   }
 *
 * 卡片对缺字段是容错的，但我们一律给全，避免出现"有时候不显示"的怪现象。
 */

/** 事件 → 内存状态的唯一入口。用类是为了让状态变化路径集中、可测。 */
export class CardState {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSessions] 最多跟踪多少个会话（防止内存无限增长）
   * @param {number} [options.finishedFlashMs] 「刚完成」绿点持续多久（卡片自己是 8 秒）
   * @param {boolean} [options.showSubagentSessions] 是否把子代理会话也当成任务显示
   * @param {() => number} [options.now] 时钟；单测注入固定时间用，默认 Date.now
   */
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? 64
    this.finishedFlashMs = options.finishedFlashMs ?? 8000
    this.showSubagentSessions = options.showSubagentSessions ?? false
    // 所有时间都从这里取，单测才能注入固定时钟
    this._now = typeof options.now === 'function' ? options.now : Date.now

    /** sessionId -> 会话记录 */
    this.sessions = new Map()
    /** 待审批：approvalId -> { sessionId, title, toolName, askedAt } */
    this.pendingApprovals = new Map()
    /**
     * 标题缓存：sessionId -> title
     *
     * 为什么要单独存：session/title 事件往往在会话"出现并开跑"之前
     * 就已经产生过了。插件启动回填时能读到标题，但那时会话可能还没进
     * sessions，直接调 sessionTitle() 会被丢掉。所以先存这里，
     * 等 sessionAdded 时再套上去。
     */
    this.titleCache = new Map()
    /** 今天用了多少 Token（外部可覆盖，比如启动回填后设一个基数） */
    this.todayTokens = 0
    /**
     * 按会话查 Token 的函数（v0.10.0 新增），由 index.js 用 TokenTracker 接上。
     * 默认 null = 没接，此时每行都输出 tokens: 0。
     * 见 setSessionTokenSource()。
     */
    this._sessionTokenOf = null
    /**
     * 峰谷状态，形如 { inValley: boolean, remainingSec: number, reason: string }。
     * 由外部（index.js）算好后设置；这里只带出去，不自己算 ——
     * 这样 state.js 保持纯逻辑、不依赖时钟和节假日数据，单测更好写。
     */
    this.valley = null
    /** 最近一次「任务刚跑完」的时间戳（毫秒）；null 表示没有 */
    this.lastFinishedAt = null
    /** 已经不再跟踪的会话，记住它们的 id，避免重复触发「完成」 */
    this.retired = new Set()
    /**
     * 最近一次悬浮窗审批的处理回执（v0.8.0）。
     *
     * 形如 { requestId, approvalId, accepted, outcome, reason, at }
     * 作用：卡片点完按钮后能看到"已生效 / 失败：通道暂不可用"，
     * 而不是"点了没反应不知道为啥"。
     * 这条通道是白送的 —— 卡片本来就每 500ms 读 state.json。
     */
    this.lastApprovalDecision = null
    /** 事件序号累计，仅用于诊断 */
    this.stats = { events: 0, toolCalls: 0, approvalsAsked: 0, approvalsDecided: 0 }
  }

  // ---------------------------------------------------------------- 会话出现 / 消失

  /**
   * 会话出现（api-session/added 或 session/created）。
   * @param {object} info
   * @param {string} info.sessionId
   * @param {boolean} [info.running] 出现时是否已经在跑
   * @param {boolean} [info.blank] 是不是还没写过任何内容的空会话
   * @param {string} [info.parentSessionId] 谁派生的（有值 = 子会话）
   * @param {'subagent'|undefined} [info.origin]
   * @param {string} [info.cwd]
   * @param {number} [info.createdAt] 创建时间（毫秒）
   */
  sessionAdded(info) {
    const id = info?.sessionId
    if (!id) return false

    const existing = this.sessions.get(id)
    if (existing) {
      // 重复上报很常见（added 会在多个时机重复发），只更新能变的字段
      if (typeof info.running === 'boolean') this._setRunning(existing, info.running, this._now())
      if (info.blank !== undefined) existing.blank = !!info.blank
      if (info.cwd) existing.cwd = info.cwd
      // 之前缓存的标题这时候补上
      if (!existing.title && this.titleCache.has(id)) existing.title = this.titleCache.get(id)
      return false
    }

    const now = this._now()
    const record = {
      sessionId: id,
      parentSessionId: info.parentSessionId ?? null,
      origin: info.origin ?? null,
      cwd: info.cwd ?? null,
      // 回填时可能已经读到过这个会话的标题，直接套上
      title: this.titleCache.get(id) ?? null,
      createdAt: typeof info.createdAt === 'number' ? info.createdAt : now,
      running: false,
      runningSince: null,
      blank: info.blank ?? true,
      activity: '',
      lastToolName: null,
      lastToolAt: null,
      turnStartedAt: null,
    }
    this.sessions.set(id, record)
    this.retired.delete(id)
    this._setRunning(record, info.running === true, now)
    this._trim()
    return true
  }

  /**
   * 会话从运行时列表里消失（api-session/removed）。
   * 如果它当时正在跑，视为异常结束，不触发「已完成」绿点。
   */
  sessionRemoved(sessionId) {
    const record = this.sessions.get(sessionId)
    if (!record) return false
    this.sessions.delete(sessionId)
    this.retired.add(sessionId)
    return true
  }

  /** 会话开跑 / 停跑（api-session/status）。这是「运行中」的主信号。 */
  sessionStatus(sessionId, running) {
    if (!sessionId) return false
    let record = this.sessions.get(sessionId)
    if (!record) {
      // 插件是后来才加载的：先补一条记录，避免丢事件
      this.sessionAdded({ sessionId, running: false })
      record = this.sessions.get(sessionId)
      if (!record) return false
    }
    return this._setRunning(record, running === true, this._now())
  }

  _setRunning(record, running, now) {
    if (record.running === running) return false
    record.running = running
    if (running) {
      record.runningSince = record.runningSince ?? now
      record.blank = false
    } else {
      record.runningSince = null
      record.activity = ''
      // 只有「跑过又停下来」才算完成；从没跑过的空会话不算。
      //
      // 【v0.6.0 起：还要再排除子代理】
      //   原来这里不区分主任务和子代理，于是任何一个子代理跑完都会设
      //   lastFinishedAt，卡片就闪 8 秒绿点、标题写「全部任务已经跑完」。
      //   实测后果：workflow 一次 fan-out 20 个 agent，主任务明明还在跑，
      //   就会假报 20 次「全部完成」。
      //
      //   这就是 test/unit.mjs 里那条「子任务完成不应让主任务闪绿点吗——
      //   实际会闪，记录该行为」记录的已知问题，本次修掉，那条测试已改成
      //   断言新行为（防回归）。
      if (!record.blank && !isSubagent(record)) {
        this.lastFinishedAt = now
      }
    }
    return true
  }

  _trim() {
    if (this.sessions.size <= this.maxSessions) return
    // 先淘汰「没在跑、也没标题」的，再从最老的开始
    const idle = [...this.sessions.values()].filter(s => !s.running)
    idle.sort((a, b) => a.createdAt - b.createdAt)
    for (const s of idle) {
      if (this.sessions.size <= this.maxSessions) break
      this.sessions.delete(s.sessionId)
      this.retired.add(s.sessionId)
    }
  }

  // ---------------------------------------------------------------- 标题 / 活动

  /** 会话标题（session/title 事件，或从会话日志回填） */
  sessionTitle(sessionId, title) {
    const id = String(sessionId ?? '')
    if (!id) return false
    const clean = typeof title === 'string' ? title.trim() : ''
    if (!clean) return false

    // 会话还没出现也要先记住：回填时标题常常先到
    const record = this.sessions.get(id)
    if (!record) {
      if (this.titleCache.get(id) === clean) return false
      this.titleCache.set(id, clean)
      return false   // 暂时没有可见效果，但记下了
    }
    if (record.title === clean) return false
    record.title = clean
    this.titleCache.set(id, clean)
    return true
  }

  /**
   * 收到一条工具调用：更新「正在做什么」。
   * 只有正在跑的会话才更新，避免停跑的会话残留旧文字。
   */
  toolCall(sessionId, toolName, argsPreview) {
    this.stats.toolCalls++
    const record = this.sessions.get(sessionId)
    if (!record) return false
    record.lastToolName = toolName ?? null
    record.lastToolAt = this._now()
    record.activity = describeTool(toolName, argsPreview)
    if (record.running) record.blank = false
    return true
  }

  // ---------------------------------------------------------------- 审批

  /**
   * 收到 approval/asked：记一项待审批。
   *
   * @param {object} info
   * @param {string} info.id 审批 id（= 会话日志里 approval/asked 的 id）
   * @param {string} [info.sessionId]
   * @param {string} [info.toolName]
   * @param {string} [info.reason]
   * @param {string} [info.callId] 本次工具调用 id（v0.8.0 新增）
   * @param {string} [info.nonce] 审批代理发的随机串（只有开关打开时才有）
   * @param {number} [info.expiresAtMs] 这条审批的决定文件截止时间
   */
  approvalAsked(info) {
    const id = info?.id
    if (!id) return false
    this.stats.approvalsAsked++
    if (this.pendingApprovals.has(id)) return false
    const record = this.sessions.get(info.sessionId)
    const askedAt = this._now()
    this.pendingApprovals.set(id, {
      // Map 的 key 就是审批编号；记录里再存一份，
      // 因为 snapshot 遍历 values() 时拿不到 key（v0.8.0 起卡片要 id）
      approvalId: id,
      sessionId: info.sessionId ?? null,
      title: describeApproval(info.toolName, info.reason, record?.title),
      toolName: info.toolName ?? null,
      // 【v0.8.0】这三个字段是悬浮窗审批要用的：
      //   callId  —— 把"瀑布里的请求"和"日志里的审批编号"配对的唯一钥匙
      //   nonce   —— 决定文件的一次性校验串（由 approval-proxy 生成）
      //   expiresAtMs —— 超过这个时刻按钮就该置灰
      // 老调用方不传时保持 undefined，snapshot 会自动省略它们（向后兼容）。
      callId: info.callId ?? null,
      nonce: info.nonce ?? null,
      expiresAtMs: Number.isFinite(info.expiresAtMs) ? info.expiresAtMs : null,
      askedAt,
    })
    return true
  }

  /** 收到 approval/decided：这项不再等待审批。 */
  approvalDecided(id) {
    if (!id) return false
    this.stats.approvalsDecided++
    return this.pendingApprovals.delete(id)
  }

  /** 这条审批还挂在待决表里吗？（审批代理判断"还能不能答"用） */
  hasPendingApproval(id) {
    return this.pendingApprovals.has(id)
  }

  /** 给某条待审批补上 nonce / 截止时间（代理攥住 Promise 之后回填）。 */
  annotateApproval(id, patch) {
    const rec = this.pendingApprovals.get(id)
    if (!rec || !patch) return false
    if (typeof patch.nonce === 'string') rec.nonce = patch.nonce
    if (Number.isFinite(patch.expiresAtMs)) rec.expiresAtMs = patch.expiresAtMs
    if (patch.held !== undefined) rec.held = patch.held === true
    return true
  }

  /** 标记某条审批"我们真的攥住了 Promise"（answerable 的第②个条件）。 */
  markHeld(id, held = true) {
    const rec = this.pendingApprovals.get(id)
    if (!rec) return false
    rec.held = held === true
    return true
  }

  // ---------------------------------------------------------------- Token

  /** 累加一条 usage。amount 是「这条消息新增的 token」。 */
  addTokens(amount) {
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) return false
    this.todayTokens += Math.round(n)
    return true
  }

  /** 用启动回填算出来的值覆盖今日 Token 起点。 */
  setTodayTokens(total) {
    const n = Number(total)
    if (!Number.isFinite(n) || n < 0) return false
    this.todayTokens = Math.round(n)
    return true
  }

  /**
   * 接上「按会话查 Token」的能力（v0.10.0 新增，卡片每行显示自己那一份）。
   *
   * 【为什么存一个查询函数，而不是直接把 TokenTracker 传进来】
   *   这个类刻意不 import 任何外部模块（见文件头注释），只依赖 Date.now 这类
   *   标准能力，所以能用 `node test/unit.mjs` 脱离 DSH 直接跑。
   *   传进一个 `(sessionId) => number` 的纯函数，既拿得到数，又不产生依赖，
   *   单测里可以直接塞一个假函数验证 snapshot 的输出，不用真的建 TokenTracker。
   *
   * @param {((sessionId: string) => number)|null} fn
   */
  setSessionTokenSource(fn) {
    this._sessionTokenOf = typeof fn === 'function' ? fn : null
    return this
  }

  /** 查某个会话的 Token 数；没接来源或查不到时返回 0（永远给数字，不给 undefined） */
  _tokensOfSession(sessionId) {
    if (!this._sessionTokenOf) return 0
    try {
      const n = Number(this._sessionTokenOf(String(sessionId ?? '')))
      if (!Number.isFinite(n) || n < 0) return 0
      return Math.round(n)
    } catch {
      // 查询函数出错绝不能连累快照 —— 最差只是这一行显示 0
      return 0
    }
  }

  /**
   * 一个「任务」的 Token 总量 = 它自己 + 挂在它下面的所有子会话。
   *
   * 【为什么不能只算自己那一份】
   *   子代理是独立会话，Token 记在子代理自己的 id 上，而卡片默认
   *   不显示子代理行（showSubagentSessions 默认 false）。只算自己的话，
   *   workflow / subagent 跑的量大头会"记账了但没有行显示"，用户看到
   *   "今日 3M Token"但任务行只写 "1.5k Token"，会以为功能坏了。
   *
   * 【为什么要兜一层 try】
   *   这个函数每 500ms 被调一次。宁可某一行显示 0，也不能让整个
   *   snapshot 崩掉 —— 崩了卡片就整张空白（第三轮事故教训）。
   *
   * @param {object} rec 会话记录（sessions 里的那一项）
   */
  _tokensOfTask(rec) {
    if (!rec || !this._sessionTokenOf) return 0
    try {
      let sum = this._tokensOfSession(rec.sessionId)
      // 累加所有父会话是它的子会话
      for (const child of this.sessions.values()) {
        if (child.parentSessionId !== rec.sessionId) continue
        sum += this._tokensOfSession(child.sessionId)
      }
      return sum
    } catch {
      return 0
    }
  }

  /** 跨天时清零。返回是否真的清零了。 */
  resetDayIfNeeded(now = this._now()) {
    const day = localDayKey(now)
    if (this._dayKey === undefined) { this._dayKey = day; return false }
    if (this._dayKey === day) return false
    this._dayKey = day
    this.todayTokens = 0
    return true
  }

  // ---------------------------------------------------------------- 汇总

  /**
   * 当前应该被卡片看到的状态。
   *
   * 【v0.6.0 新增 tasks.subagentCount】
   *   背景：原来子代理在下面第 284 行就被丢掉了，卡片完全看不见它们。
   *   于是出现一个很坑的现象：主任务已经跑完、子代理还在跑的时候，
   *   tasks.running 变成 0，卡片判定为「空闲」，收成 96 高扁条 + 灰点，
   *   用户以为没事了，其实还有活在跑。
   *
   *   所以这里额外报一个纯数字 tasks.subagentCount（只数**运行中**的子代理）。
   *   卡片用它做两件事：
   *     1. 标题上写「· N 个帮手」
   *     2. 让「有帮手在跑」也算「有活干」，不再假装空闲
   *
   *   【向后兼容：只加字段，不改任何现有字段的结构和含义】
   *     - tasks.running 仍然只数主任务。绝对不能改成「含子代理的总数」，
   *       否则老卡片会走 Panel.ps1:1224 的兜底分支，凭空造出「任务 2/3/4」假行。
   *     - tasks.sessions 里仍然只有主任务，一条都不多。
   *     - 老卡片读新 state.json 会忽略这个字段；新卡片读老 state.json
   *       会因 Get-Setting 的默认值拿到 0，行为跟改动前完全一样。
   *
   * @param {object} [options]
   * @param {boolean} [options.includeSubagents] 覆盖实例上的 showSubagentSessions
   * @param {number} [options.now] 便于单测注入时间
   */
  snapshot(options = {}) {
    const now = options.now ?? this._now()
    const includeSubagents = options.includeSubagents ?? this.showSubagentSessions

    // ---- 运行中的会话
    const running = []
    // 正在跑的子代理数量。单独数，和 includeSubagents 开关无关 ——
    // 就算调试时把开关打开（子代理也占行），这个数字依然是「有几个帮手」。
    let subagentCount = 0

    for (const s of this.sessions.values()) {
      if (!s.running) continue
      const child = isSubagent(s)
      if (child) subagentCount++
      if (!includeSubagents && child) continue
      running.push(s)
    }
    // 跑得久的排前面：用户最关心「那个跑了很久的」
    running.sort((a, b) => (a.runningSince ?? now) - (b.runningSince ?? now))

    const sessions = running.slice(0, 10).map(s => ({
      title: s.title || fallbackTitle(s),
      elapsedSec: Math.max(0, Math.round((now - (s.runningSince ?? now)) / 1000)),
      activity: s.activity || '正在运行',
      // 【v0.10.0 新增】这个任务「今天」用了多少 Token，卡片显示在行右侧。
      //
      // 【为什么要带上子代理的用量（2026-10-31 复核后改的）】
      //   第一版只取 s.sessionId 自己的那份，结果有个大坑：
      //   子代理是**独立会话**，跑 workflow / subagent 时绝大部分 Token
      //   都记在子代理的 id 上，而卡片默认不显示子代理行
      //   （showSubagentSessions 默认 false）。
      //   实测：主任务 1500 + 子代理 3000000 → 卡片那行只显示 1500，
      //   底部却写着今日 3001500。用户会认为"这功能是坏的"。
      //
      //   现在改成"这个会话 + 挂在它下面的所有子会话"之和，
      //   语义正好是用户要的"这个任务一共用了多少"。
      //   注意只算**还在 sessions 表里**的子会话：被 _trim 淘汰的旧会话
      //   查不到就不再计入（它们的用量仍然留在今日总额里，不会丢）。
      //
      // 【永远输出数字，不输出 undefined / null】
      //   文件头那条原则：卡片对缺字段是容错的，但我们一律给全，
      //   避免出现"有时候不显示"的怪现象。
      //   没接查询函数（老调用方、单测）或该会话没记录时，一律给 0。
      //
      // 【向后兼容】
      //   老卡片不认这个字段，读到了会忽略；新卡片读老 state.json 走
      //   Get-Setting 默认值 0，行为跟改动前一致。
      //
      // ⚠️ 取的是 s.sessionId。会话记录的字段名就叫 sessionId（见上面
      //    sessionAdded 里 `sessionId: id`），**不是 id** ——
      //    写成 s.id 会静默取到 undefined、每行永远显示 0，而且不报错。
      tokens: this._tokensOfTask(s),
    }))

    // ---- 待审批
    //
    // 【v0.8.0：悬浮窗审批】
    //   items 里除了 title，还要带出"这张卡片能不能点"所需的一切。
    //   但向后兼容是第一位的：老调用方（单测、旧数据）没有这些字段时，
    //   我们**不输出**它们，而不是输出 null —— 因为卡片会按"字段在不在"
    //   来选渲染哪种行，输出 null 会让卡片多一套判空逻辑。
    //
    //   answerable 的规则（task-9 硬性要求）：
    //     · 开关关（options.approvalInline 为假）→ **整个字段不输出**
    //     · 开关开 → true ⟺ 四条件全满足：
    //         ① 开关开着（已由外层保证）
    //         ② 真的攥住了这一条的 Promise（a.held）
    //         ③ 会话没被 _trim 淘汰（a.sessionId 在 sessions 里）
    //         ④ 卡片心跳是活的（options.cardAlive）
    const inline = options.approvalInline === true
    const cardAlive = options.cardAlive !== false   // 未传时按"活着"处理（单测友好）
    const approvals = []
    for (const a of this.pendingApprovals.values()) {
      const item = { title: a.title }
      if (inline) {
        const sessionAlive = !a.sessionId || this.sessions.has(a.sessionId)
        const held = a.held === true
        item.id = a.approvalId ?? null
        item.toolName = a.toolName ?? null
        item.sessionId = a.sessionId ?? null
        if (a.nonce) item.nonce = a.nonce
        if (Number.isFinite(a.expiresAtMs)) item.expiresAtMs = a.expiresAtMs
        item.answerable = Boolean(held && sessionAlive && cardAlive)
        if (!item.answerable) {
          // 给卡片一句能直接显示的说明，省得它在 PS 里重新推导原因
          item.blockReason = !cardAlive ? '卡片状态异常'
            : !sessionAlive ? '会话已结束'
            : !held ? '此条暂不支持直接审批'
            : ''
        }
      }
      approvals.push(item)
    }

    // ---- 刚完成
    let lastFinished = null
    if (this.lastFinishedAt !== null && now - this.lastFinishedAt < this.finishedFlashMs) {
      lastFinished = formatTimestamp(this.lastFinishedAt)
    }

    return {
      updatedAt: Math.floor(now / 1000),
      // running 只数主任务（老语义，不要动）；subagentCount 是新加的纯数字
      tasks: { running: running.length, subagentCount, sessions },
      approval: {
        pending: this.pendingApprovals.size,
        items: approvals,
        // 回执：只有真的处理过一次决定文件时才有。
        // 卡片读不到 → 不显示回执行（向后兼容）。
        ...(this.lastApprovalDecision ? { lastDecision: this.lastApprovalDecision } : {}),
      },
      lastFinished,
      tokens: { today: this.todayTokens },
      // 峰谷由插件算好塞进来（见 index.js）。这里只负责带出去，
      // 让状态对象保持"纯数据"，不引入时间和节假日依赖 —— 保持可单测。
      valley: this.valley ?? null,
    }
  }
}

// ================================================================ 辅助函数

/** 有 parentSession 或 origin=subagent，就算子代理会话。 */
export function isSubagent(record) {
  if (!record) return false
  if (record.origin === 'subagent') return true
  return typeof record.parentSessionId === 'string' && record.parentSessionId.length > 0
}

/** 没有标题时的兜底：用 cwd 的末段，再不行就用「任务 N」。 */
function fallbackTitle(record) {
  if (record.cwd) {
    const parts = record.cwd.split(/[\\/]+/).filter(Boolean)
    const tail = parts[parts.length - 1]
    if (tail) return tail
  }
  return '未命名任务'
}

/**
 * 把工具名翻成卡片上看得懂的中文。
 * 卡片只有一行位置，所以要短。
 *
 * 有具体文件/命令名时，优先显示「正在处理 xxx」——
 * 这比光说「正在改文件」信息量大得多，用户一眼能知道在动哪个文件。
 */
export function describeTool(toolName, argsPreview) {
  const name = typeof toolName === 'string' ? toolName : ''
  const arg = typeof argsPreview === 'string' ? argsPreview : ''

  // 先试着从参数里抠出具体目标；抠到了就用它，最具体
  const detail = extractFileName(arg)
  if (detail) return `正在处理 ${detail}`

  const table = {
    pwsh: '正在执行命令',
    bash: '正在执行命令',
    shell: '正在执行命令',
    read: '正在读文件',
    write: '正在写文件',
    edit: '正在改文件',
    glob: '正在找文件',
    grep: '正在搜索代码',
    web_fetch: '正在打开网页',
    web_search: '正在联网搜索',
    present: '正在整理交付文件',
    todo_write: '正在整理任务清单',
    subagent: '正在派发子任务',
    subagent_fork: '正在派发子任务',
    workflow: '正在编排流程',
    ask_user_question: '正在等你回答',
    load_workspace_dependencies: '正在准备环境',
  }
  if (table[name]) return table[name]

  if (!name) return '正在运行'
  return `正在使用 ${name}`
}

/** 从工具参数 JSON 里抠出一个文件名 / 命令片段，失败就返回空。 */
function extractFileName(argsPreview) {
  if (!argsPreview) return ''
  const patterns = [
    /"file_path"\s*:\s*"((?:[^"\\]|\\.){1,200})"/,
    /"path"\s*:\s*"((?:[^"\\]|\\.){1,200})"/,
    /"command"\s*:\s*"((?:[^"\\]|\\.){1,120})"/,
    /"pattern"\s*:\s*"((?:[^"\\]|\\.){1,80})"/,
  ]
  for (const re of patterns) {
    const m = argsPreview.match(re)
    if (!m) continue
    let v = m[1]
    try { v = JSON.parse('"' + v + '"') } catch { /* keep raw */ }
    v = v.replace(/\s+/g, ' ').trim()
    if (!v) continue
    // 只留最后一段路径
    const segs = v.split(/[\\/]+/).filter(Boolean)
    const base = segs.length > 0 ? segs[segs.length - 1] : v
    return base.length > 28 ? base.slice(0, 27) + '…' : base
  }
  return ''
}

/**
 * 审批事项的一句话描述。卡片一行放不下太多，控制在 40 字内。
 * 优先用 reason（DSH 自己写的说明），其次用工具名。
 */
export function describeApproval(toolName, reason, sessionTitle) {
  const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')
  const r = clean(reason)
  const t = clean(toolName)

  let text = ''
  if (r) {
    text = r
  } else if (t) {
    text = `${t} 需要你确认`
  } else if (sessionTitle) {
    text = `${sessionTitle} 需要你确认`
  } else {
    text = '有操作等待你确认'
  }
  return text.length > 40 ? text.slice(0, 39) + '…' : text
}

/**
 * 把毫秒时间戳转成卡片要的 "yyyyMMddHHmmss"（本地时间）。
 * 卡片拿这个字符串有没有变化来判断「是不是新完成的」。
 */
export function formatTimestamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 本地日期键 "YYYY-MM-DD"，用于跨天清零。 */
export function localDayKey(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
