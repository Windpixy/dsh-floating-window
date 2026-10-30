/**
 * lib/approval-proxy.js -- 悬浮窗审批代理（v0.8.0）
 *
 * ============================================================================
 * 这个文件在干什么
 * ============================================================================
 *
 * 用户想要：悬浮窗上直接点「允许/拒绝」，不用切回 DSH。
 *
 * 但 DSH 的审批系统**没有**"拿审批编号调一个方法把答案塞回去"的接口
 * （`approval` 服务只有 setPolicy / request / overrideOf 三个方法，
 *   详见 优化方案-Clili-悬浮窗审批.md 第 3.2 节）。
 *
 * 唯一入口是：自己成为 `approval/request` 瀑布的一个 **answerer**，
 * 把那个待决的 Promise **攥在手里**，等外部（卡片）给了决定再 resolve。
 *
 * 官方网页界面就是这么干的（@deepseek-ai/dsh-client-ui-approval：
 * `ctx.remote.$on("approval/request", ...)` + `this.#resolve(outcome)`），
 * 所以我们走的是正道，不是野路子。
 *
 * ============================================================================
 * 为什么要"攥住"，以及怎么和 @xmanrui/dsh-im 共存（血泪教训，别改）
 * ============================================================================
 *
 * dsh-im 用 `{global: true, prepend: true}` 抢在最前面。但它是**比赛型**的
 * （源码里字段就叫 `competitive: true`）：它会**同时**跑两条路 ——
 *   ① `next()` 交给下游（官网界面 / 我们）
 *   ② 把审批推到飞书/微信/QQ
 * 谁先返回 `allowed-once`/`rejected` 谁就赢。
 *
 * 所以：
 *   · **绝不能 prepend 抢到它前面** —— 抢了 dsh-im 就再也拿不到审批，
 *     用户的飞书/微信审批会彻底失效。
 *   · 正确做法：普通 `{global:true}` 注册，排在它后面。
 *   · 而且我们的 answerer **不能挂太久不动**：dsh-im 的 withdraw() 里有一句
 *     `if (!nativeAvailable) pending.settle('unavailable')`，
 *     意思是"IM 送不出去 + 我们也不接" → 整条审批变成拒绝。
 *     这不算 bug（fail-closed 是安全的），但会让用户觉得"点了没反应"。
 *
 * ============================================================================
 * 三个安全/正确性判据（task-9 硬性要求，不实现会出真 bug）
 * ============================================================================
 *
 *   C1a：`callId` 缺失 → 立刻 next()
 *        契约里 `callId?: ToolCallId` 是可选的。没有它就没法跟会话日志里的
 *        approval/asked 配对 → 攥住就是**盲批**（不知道在批哪一条）。
 *
 *   C1b：会话已被 _trim() 淘汰 → 立刻 next()
 *        state.js 在 64 个会话上限时会淘汰空闲会话。攥着一条卡片不显示、
 *        用户也点不到的审批，它会一直卡到超时 —— 用户完全看不出为什么。
 *
 *   C2 ：卡片心跳死了（进程没了）→ 立刻 next()
 *        **注意是 next() 让路，不是返回 'unavailable'** ——
 *        让官网/IM 接手。返回 unavailable 等于替用户拒绝，太粗暴。
 *        用 index.js 那个 5 秒心跳检查的结果（liveness.alive），零额外 I/O。
 *
 * ============================================================================
 * 常驻注册，禁止动态注册（task-9 硬性要求）
 * ============================================================================
 *
 * 监听者在插件加载时就注册，**不随开关变化**。开关 `approvalInline`
 * 只在 answerer 内部决定行为：为假 → 立即 next()。
 *
 * 为什么不能"开关打开时才注册"：
 *   1. 注册时序 + 重复注册 + 反注册失败，三个新问题，收益为零
 *   2. 插件只在 DSH 启动时加载 → 动态注册会导致"改开关必须重启 DSH"，
 *      跟用户要的"设置界面里切开关"直接冲突
 *   3. 常驻注册才能让 `answerable` 有单一含义
 *
 * ============================================================================
 * 最危险的失败模式（卸载时）
 * ============================================================================
 *
 * **卸载时必须把所有挂住的 Promise 全部 resolve 成 'unavailable'。**
 * 忘了这一步，热重载期间所有待审批会一直卡着不返回，DSH 的整条工具调用
 * 就挂在那里，直到它自己的 signal 超时。见 dispose()。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 合法结果词汇（和 DSH 的 ApprovalOutcome 对齐，只有 allowed-once 是放行） */
const OUTCOMES = new Set(['allowed-once', 'rejected'])

/** 决定文件名后缀 */
const DECISION_EXT = '.json'

/** 已消费文件的后缀：留在盘上便于排查"我明明点了为什么没生效" */
const CONSUMED_EXT = '.consumed'

/**
 * 审批代理。
 *
 * 纯逻辑为主，所有 I/O 都集中在这里，方便单测：
 *   · 文件系统操作通过构造函数注入（默认用 node:fs）
 *   · 时钟通过 options.now 注入
 *   · 心跳通过 liveness 对象读（外部每 5 秒刷新）
 */
export class ApprovalProxy {
  /**
   * @param {object} options
   * @param {object} options.ctx Cordis context（用来注册 waterfall）
   * @param {import('./state.js').CardState} options.state
   * @param {(reason: string, urgent?: boolean) => void} options.onChange 状态变了请写盘
   * @param {(msg: string, extra?: unknown) => void} options.log
   * @param {string} options.decisionsDir 决定文件目录
   * @param {{ alive: boolean }} options.liveness 心跳缓存（index.js 每 5 秒刷）
   * @param {() => boolean} options.inlineEnabled 开关（读 settings.json，带缓存）
   * @param {number} [options.decisionTtlMs] 决定文件有效期
   * @param {number} [options.pollMs] 扫描间隔
   * @param {() => number} [options.now]
   */
  constructor(options) {
    this.ctx = options.ctx
    this.state = options.state
    this.onChange = options.onChange ?? (() => {})
    this.log = options.log ?? (() => {})
    this.decisionsDir = options.decisionsDir
    this.liveness = options.liveness ?? { alive: false }
    this.inlineEnabled = options.inlineEnabled ?? (() => false)
    this.decisionTtlMs = options.decisionTtlMs ?? 60000
    this.pollMs = options.pollMs ?? 250
    this._now = options.now ?? Date.now

    /**
     * 挂住的审批：approvalId -> { resolve, nonce, askedAtMs, expiresAtMs, callId, sessionId }
     *
     * 这张表是**唯一**能让外部作答的凭据。表里没有的 approvalId，
     * 收到任何决定文件都一律丢弃（防止过期文件 / 伪造文件）。
     */
    this.held = new Map()

    /** 最近一次处理结果，写进 state.json 给卡片显示回执 */
    this.lastDecision = null

    /** 统计（report / debug 用） */
    this.stats = {
      seen: 0, held: 0, passedThrough: 0,
      passC1a: 0, passC1b: 0, passC2: 0, passSwitchOff: 0,
      decisionsApplied: 0, decisionsRejected: 0, filesDropped: 0,
    }

    this._disposers = []
    this._pollTimer = null
    /** 连续"没有待审批"的轮数（用来做低频清理，见 _poll） */
    this._idlePolls = 0
  }

  // ---------------------------------------------------------------- 注册

  /**
   * 注册 waterfall 监听者（**常驻，不随开关变化**）。
   *
   * 注册优先级：普通 {global:true}，**刻意不加 prepend** ——
   * 理由见文件头"怎么和 dsh-im 共存"那一节。
   *
   * @returns {boolean} 是否注册成功
   */
  install() {
    if (typeof this.ctx?.on !== 'function') {
      this.log('审批代理：ctx.on 不可用，跳过注册')
      return false
    }
    try {
      const off = this.ctx.on(
        'approval/request',
        (request, next) => this._handle(request, next),
        { global: true },
      )
      if (typeof off === 'function') this._disposers.push(off)
      this.log('审批代理已注册（常驻，普通优先级，不抢 dsh-im）')
      this._startPolling()
      return true
    } catch (e) {
      // 注册失败不能让插件崩 —— 只是这个功能不可用，卡片会显示"暂不可用"
      this.log('审批代理注册失败: ' + (e && e.message))
      return false
    }
  }

  /**
   * waterfall 主体。
   *
   * 【绝对不能让异常冒出去】审批是 DSH 的关键路径，我们抛异常会污染事件链。
   * 出任何问题都要 next() 让路（而不是返回一个值）。
   *
   * @param {object} request ApprovalRequestEvent
   * @param {() => Promise<string>} next 交给下一个 answerer
   */
  async _handle(request, next) {
    this.stats.seen++

    // ---- 判据 0：开关关着 → 立刻让路
    //
    // 这是**默认状态**。开关关时我们的存在感应该是零：
    // 直接 next()，行为和没装这个功能完全一样。
    let inline = false
    try {
      inline = this.inlineEnabled() === true
    } catch {
      inline = false   // 读开关失败 → 按关闭处理（安全侧）
    }
    if (!inline) {
      this.stats.passSwitchOff++
      return this._pass(next, 'switch-off')
    }

    // ---- 判据 C1a：callId 缺失 → 立刻让路
    const callId = request?.callId
    if (!callId) {
      this.stats.passC1a++
      return this._pass(next, 'no-callId')
    }

    // ---- 判据 C2：卡片心跳死了 → 立刻让路
    //
    // 注意：next() 让路，**不是**返回 'unavailable'。
    // 卡片死了只是"我们的 UI 不在"，不代表用户拒绝 ——
    // 让官网界面 / IM 接手才对。
    if (this.liveness.alive !== true) {
      this.stats.passC2++
      return this._pass(next, 'card-dead')
    }

    // ---- 配对：用 callId 找会话日志里对应的 approval/asked
    //
    // 为什么要配对：ApprovalRequestEvent **不带审批编号**
    // （编号是 ApprovalService.request() 内部 randomUUID 生成的，
    //   只有会话日志的 approval/asked 里才有）。
    // 而卡片要按 approvalId 决定"批哪一条"，所以必须把这个号找回来。
    const approvalId = this._findApprovalId(request)
    if (!approvalId) {
      // 找不到对应记录 → 不攥住（否则我们拿一个假 id 写进 state.json，
      // 用户点了也对不上任何真实审批）
      return this._pass(next, 'no-match')
    }

    // ---- 判据 C1b：会话已被 _trim() 淘汰 → 立刻让路
    const sessionId = request?.agent?.id ? String(request.agent.id) : null
    if (sessionId && !this.state.sessions.has(sessionId)) {
      this.stats.passC1b++
      return this._pass(next, 'session-trimmed')
    }

    // ---- 通过全部判据：攥住
    return this._hold(request, next, { approvalId, callId, sessionId })
  }

  /** 让路：把控制权交给下一个 answerer */
  _pass(next, reason) {
    this.stats.passedThrough++
    this.log(`审批代理让路（${reason}）`)
    try {
      return next()
    } catch (e) {
      this.log('审批代理 next() 抛错: ' + (e && e.message))
      // next() 抛错时返回 undefined 会被 DSH 规范成 unavailable（fail-closed，安全）
      return undefined
    }
  }

  /**
   * 用 callId 在会话日志里找回审批编号。
   *
   * 抄的是 dsh-im 的配对逻辑（modern-harness-api.mjs 745-754 行）：
   * 从后往前扫，跳过已 decided 的、跳过已经被别人 claim 的，
   * callId 必须严格相等。
   *
   * 【为什么要两条路都试】
   *   主路：state.pendingApprovals —— 便宜，而且带 sessionId 更可靠。
   *         但它依赖 approval/asked 事件**已经**进了 state。
   *         极端时序下瀑布可能比 session/event 监听者先到
   *         （事件是"提交后投递"，不保证和工具调用严格同步），
   *         这时主路会空。
   *   备路：直接翻 session 的事件快照 —— 和 dsh-im 完全一样的做法，
   *         不依赖我们自己的 state，更"权威"但也更贵。
   *
   * @param {object} request
   * @returns {string|null}
   */
  _findApprovalId(request) {
    const callId = request?.callId
    if (!callId) return null
    const wanted = String(callId)

    // ---- 主路：自己的 pendingApprovals
    for (const [id, a] of this.state.pendingApprovals) {
      if (a.callId && String(a.callId) === wanted) {
        if (this.held.has(id)) continue
        return id
      }
    }

    // ---- 备路：翻 session 的事件快照（和 dsh-im 同款）
    try {
      const session = request?.agent?.session
      let events = null
      if (typeof session?.snapshotEvents === 'function') {
        const snap = session.snapshotEvents()
        if (Array.isArray(snap)) events = snap
      }
      if (!events && Array.isArray(session?.events)) events = session.events
      if (!events) return null

      const decided = new Set()
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (!ev || typeof ev.type !== 'string') continue
        if (ev.type === 'approval/decided') {
          const did = ev.data?.id
          if (did) decided.add(String(did))
          continue
        }
        if (ev.type !== 'approval/asked') continue
        const id = ev.data?.id
        if (!id) continue
        if (decided.has(String(id))) continue
        if (this.held.has(String(id))) continue
        // callId 必须严格相等（approval/asked 里也有 callId）
        if (String(ev.data?.callId ?? '') !== wanted) continue
        return String(id)
      }
    } catch (e) {
      this.log('备路配对失败: ' + (e && e.message))
    }

    return null
  }

  /**
   * 攥住这条审批，等外部决定。
   *
   * @param {object} request
   * @param {() => Promise<string>} next
   * @param {{approvalId: string, callId: string, sessionId: string|null}} key
   */
  _hold(request, next, key) {
    const { approvalId, callId, sessionId } = key

    // 同一条审批已经在攥着了 → 直接复用，不再新建 Promise
    const existing = this.held.get(approvalId)
    if (existing) {
      this.log(`审批 ${String(approvalId).slice(0, 8)}… 已攥住，复用`)
      return existing.promise
    }

    // 生成一次性 nonce。它只写进 state.json 给卡片看，
    // 决定文件里必须原样带回 —— 对不上就丢弃。
    const nonce = randomBytes(16).toString('hex')
    const askedAtMs = this._now()
    const expiresAtMs = askedAtMs + this.decisionTtlMs

    let resolveFn
    const promise = new Promise((resolve) => { resolveFn = resolve })

    const entry = {
      approvalId,
      callId,
      sessionId,
      nonce,
      askedAtMs,
      expiresAtMs,
      promise,
      resolve: resolveFn,
      // settled 防止重复 resolve（虽然 Promise 本身幂等，但我们还要清理落盘状态）
      settled: false,
    }
    this.held.set(approvalId, entry)

    // 回填到 state：nonce + 截止时间 + "攥住了"
    //
    // 这一步必须在写 state.json 之前完成，否则卡片拿到的 items
    // 里没有 nonce，用户点了会因为 nonce 对不上被丢弃（看起来像"点了没反应"）。
    try {
      this.state.annotateApproval(approvalId, { nonce, expiresAtMs, held: true })
    } catch (e) {
      this.log('回填审批元信息失败: ' + (e && e.message))
    }

    this.stats.held++
    this.log(`审批代理攥住: ${String(approvalId).slice(0, 8)}… (${request.toolName}, ${this.decisionTtlMs}ms 内有效)`)

    // 立刻推一次状态，让卡片马上显示按钮
    try { this.onChange('approval-held', true) } catch { /* ignore */ }

    // 自我保护：万一用户一直不点、DSH 的 signal 也一直不 abort（理论上不会），
    // 到点自动放开，避免永久占着一个 Promise。
    this._armDeadline(entry, request)

    return promise
  }

  /** 到点自动放开（保险丝，正常情况下用不到） */
  _armDeadline(entry, request) {
    const remain = entry.expiresAtMs - this._now()
    if (remain <= 0) {
      this._settle(entry, 'unavailable', 'deadline-already-passed')
      return
    }
    try {
      const t = setTimeout(() => {
        if (entry.settled) return
        this._settle(entry, 'unavailable', 'expired')
      }, remain + 1000)
      // 不阻止进程退出
      if (typeof t.unref === 'function') t.unref()

      // 同时跟着 DSH 的 signal 走：用户在 DSH 里点了取消/超时，我们也要撤
      const sig = request?.signal
      if (sig && typeof sig.addEventListener === 'function') {
        const onAbort = () => {
          if (entry.settled) return
          this._settle(entry, 'cancelled', 'request-aborted')
        }
        if (sig.aborted) onAbort()
        else sig.addEventListener('abort', onAbort, { once: true })
      }
    } catch (e) {
      this.log('装审批撤销监听失败: ' + (e && e.message))
    }
  }

  /**
   * 落地一条攥住的审批。**所有路径都必须走这里**，保证只 settle 一次、
   * 且落盘状态被清掉。
   *
   * @param {object} entry
   * @param {string} outcome allowed-once / rejected / unavailable / cancelled
   * @param {string} why 日志用
   */
  _settle(entry, outcome, why) {
    if (!entry || entry.settled) return false
    entry.settled = true
    this.held.delete(entry.approvalId)

    // 从 state 里抹掉"攥住了"标记（这一条马上会被 approval/decided 删掉，
    // 但如果 DSH 那边因为别的原因没发 decided，这里也不会残留一个可点的按钮）
    try { this.state.markHeld(entry.approvalId, false) } catch { /* ignore */ }

    this.log(`审批代理落地: ${String(entry.approvalId).slice(0, 8)}… → ${outcome}（${why}）`)

    try {
      entry.resolve(outcome)
    } catch (e) {
      this.log('resolve 审批 Promise 失败: ' + (e && e.message))
    }

    try { this.onChange('approval-settled', true) } catch { /* ignore */ }
    return true
  }

  // ---------------------------------------------------------------- 决定文件

  /** 确保决定文件目录存在 */
  ensureDir() {
    try {
      mkdirSync(this.decisionsDir, { recursive: true })
      return true
    } catch (e) {
      this.log('创建 decisions 目录失败: ' + (e && e.message))
      return false
    }
  }

  /** 开始轮询（只在有待审批时才真正读目录，见 _poll） */
  _startPolling() {
    if (this._pollTimer) return
    try {
      const t = setInterval(() => {
        try { this._poll() } catch (e) { this.log('扫决定文件出错: ' + (e && e.message)) }
      }, this.pollMs)
      if (typeof t.unref === 'function') t.unref()
      this._pollTimer = t
    } catch (e) {
      this.log('启动决定文件轮询失败: ' + (e && e.message))
    }
  }

  /**
   * 扫一遍决定文件。
   *
   * 【为什么"只在有待审批时才扫"】
   *   卡片常驻跑一天，每 250ms 读一次目录就是 34 万次无谓的 readdir。
   *   没有待审批时根本没有决定文件可读。
   *
   * 【但空闲时也要偶尔清一次】
   *   否则一个"审批已被别人抢先处理"的迟到决定文件会一直躺在盘上。
   *   每 40 轮（250ms × 40 = 10 秒）扫一次、只删过期的，代价可忽略。
   *   不做这一步不会错（下次真有待审批时它会被丢弃），但会攒垃圾文件。
   */
  _poll() {
    if (this.held.size === 0) {
      this._idlePolls++
      if (this._idlePolls >= 40) {
        this._idlePolls = 0
        this._sweepStale()
      }
      return
    }
    this._idlePolls = 0

    let names
    try {
      names = readdirSync(this.decisionsDir)
    } catch {
      return   // 目录不存在 / 被占用，下一轮再说
    }
    if (!names || names.length === 0) return

    for (const name of names) {
      if (!name.endsWith(DECISION_EXT)) continue
      try {
        this._consume(join(this.decisionsDir, name))
      } catch (e) {
        this.log(`处理决定文件 ${name} 出错: ` + (e && e.message))
        this.stats.decisionsRejected++
      }
    }
  }

  /**
   * 清掉过期的 / 已成孤儿的决定文件（空闲时的低频兜底）。
   *
   * 三类都清：
   *   ① 读不出来（坏 JSON / 半截文件）
   *   ② ts 超出有效期（陈旧点击）
   *   ③ 孤儿：approvalId 既不在攥住表里、也不在 state 的待审批里
   *      —— 这条审批早就处理完了，文件是迟到的
   *
   * 【为什么"孤儿"可以安全清掉】
   *   卡片只有在拿到 nonce 之后才可能写决定文件，而 nonce 是我们在攥住
   *   Promise 之后才写进 state.json 的。所以"合法的决定文件"必然对应
   *   一次曾经攥住过的审批。它既不在 held、又不在 pendingApprovals，
   *   就只可能是处理完之后的残留。
   *
   * 读得出来、时间戳新、且审批仍在等 —— 一律留着。
   */
  _sweepStale() {
    let names
    try { names = readdirSync(this.decisionsDir) } catch { return }
    const now = this._now()
    for (const name of names) {
      if (!name.endsWith(DECISION_EXT)) continue
      const path = join(this.decisionsDir, name)
      let d
      try {
        d = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        this._dropFile(path, '空闲清理：读不出来')
        continue
      }
      const ts = Number(d?.ts)
      if (!Number.isFinite(ts) || Math.abs(now - ts) > this.decisionTtlMs) {
        this._dropFile(path, '空闲清理：时间戳过期')
        continue
      }
      const id = typeof d?.approvalId === 'string' ? d.approvalId : ''
      if (id && !this.held.has(id) && !this.state.hasPendingApproval(id)) {
        this._dropFile(path, '空闲清理：审批已结束，文件是迟到的')
      }
    }
  }

  /**
   * 消费一个决定文件。
   *
   * 顺序很重要：**先落定 → 再改名归档**。
   * 反过来的话，改名成功但 resolve 抛错，用户会看到"文件被消化了但没生效"。
   */
  _consume(path) {
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return   // 卡片可能正在写，下一轮再读
    }

    let d
    try {
      d = JSON.parse(raw)
    } catch {
      this._dropFile(path, '不是合法 JSON')
      return
    }
    if (!d || typeof d !== 'object') {
      this._dropFile(path, '内容不是对象')
      return
    }

    const approvalId = typeof d.approvalId === 'string' ? d.approvalId : ''
    if (!approvalId) {
      this._dropFile(path, '缺 approvalId')
      return
    }

    const entry = this.held.get(approvalId)
    if (!entry) {
      // 最常见的情况：陈旧的点击（那条审批早就被处理了）
      this._dropFile(path, '这条审批已不在攥住表里（可能已处理/已过期）')
      return
    }

    // ---- nonce 校验：决定文件必须原样带回 state.json 里给它的那一串
    if (typeof d.nonce !== 'string' || d.nonce !== entry.nonce) {
      this._dropFile(path, 'nonce 不匹配')
      return
    }

    // ---- 时效校验：太旧的点击不算数
    const ts = Number(d.ts)
    if (!Number.isFinite(ts) || Math.abs(this._now() - ts) > this.decisionTtlMs) {
      this._dropFile(path, '决定文件时间戳超出有效期')
      return
    }

    // ---- 结果校验：只认这两个值
    const outcome = typeof d.outcome === 'string' ? d.outcome : ''
    if (!OUTCOMES.has(outcome)) {
      this._dropFile(path, `结果值非法: ${outcome}`)
      return
    }

    // ---- 一次性消费：先落定，再归档
    const why = `card:${typeof d.requestId === 'string' ? d.requestId.slice(0, 8) : '?'}`
    const ok = this._settle(entry, outcome, why)

    // 不管 settle 是否成功（可能被 abort 抢先了），这个文件都该挪走，
    // 否则下一轮还会读到它，日志被刷屏。
    this._archive(path, ok ? '已生效' : '文件有效但审批已被抢先落定')

    this.stats.decisionsApplied++
    this.lastDecision = {
      requestId: typeof d.requestId === 'string' ? d.requestId : null,
      approvalId,
      accepted: ok,
      outcome,
      reason: ok ? '' : '审批已被抢先处理',
      at: Math.floor(this._now() / 1000),
    }
    // 【回执必须写进 state，否则卡片永远看不到结果】
    //   卡片读的是 state.json 的 approval.lastDecision，
    //   只存在代理自己的字段里等于没写。
    try { this.state.lastApprovalDecision = { ...this.lastDecision } } catch { /* ignore */ }
    try { this.onChange('approval-decision', true) } catch { /* ignore */ }
  }

  /** 丢弃一个无效决定文件（删掉 + 计数，避免下一轮重复处理） */
  _dropFile(path, why) {
    this.stats.filesDropped++
    this.stats.decisionsRejected++
    this.log(`丢弃决定文件（${why}）: ` + path.split(/[\\/]/).pop())
    try { unlinkSync(path) } catch { /* 删不掉就算了，下一轮还会读到 */ }
  }

  /** 归档一个已处理的决定文件（改名 .consumed，留作排查证据） */
  _archive(path, why) {
    const dest = path.slice(0, -DECISION_EXT.length) + CONSUMED_EXT
    try {
      // 覆盖旧的同名归档（同一个 approvalId 只可能有一次有效决定）
      try { unlinkSync(dest) } catch { /* 没有旧的就正常 */ }
      renameSync(path, dest)
      this.log(`决定文件已归档（${why}）: ` + dest.split(/[\\/]/).pop())
    } catch {
      // rename 失败（极少见：跨卷/被占用）→ 退化成删除
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 卸载 / 热重载时的清理。
   *
   * 【这是最危险的失败模式】
   * 所有挂住的 Promise 必须**全部** resolve 成 'unavailable'。
   * 漏了任何一条，那个工具调用会一直卡在 DSH 里，直到它自己的 signal 超时。
   * 用户在界面上看到的就是"审批框一直在转圈，点了也没用"。
   */
  dispose() {
    // 1) 停轮询
    if (this._pollTimer) {
      try { clearInterval(this._pollTimer) } catch { /* ignore */ }
      this._pollTimer = null
    }

    // 2) 把所有挂住的审批全部落地成 unavailable（= 拒绝，安全侧）
    const ids = [...this.held.keys()]
    for (const id of ids) {
      const entry = this.held.get(id)
      this._settle(entry, 'unavailable', 'proxy-disposed')
    }
    if (ids.length > 0) {
      this.log(`审批代理卸载：已把 ${ids.length} 条挂住的审批全部落地为 unavailable`)
    }

    // 3) 摘掉监听者
    for (const off of this._disposers.splice(0)) {
      try { off() } catch { /* ignore */ }
    }
  }

  /** 给 index.js 暴露的诊断信息 */
  debug() {
    return {
      held: this.held.size,
      heldIds: [...this.held.keys()].map(k => String(k).slice(0, 8)),
      stats: { ...this.stats },
      lastDecision: this.lastDecision,
      decisionsDir: this.decisionsDir,
      cardAlive: this.liveness.alive === true,
    }
  }
}

/**
 * 建一个审批代理（语义化包装，index.js 用这个）。
 *
 * @param {object} options 同 ApprovalProxy
 * @returns {ApprovalProxy}
 */
export function createApprovalProxy(options) {
  return new ApprovalProxy(options)
}
