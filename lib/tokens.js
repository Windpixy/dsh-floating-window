/**
 * lib/tokens.js -- 今日 Token 账本
 *
 * 难点不在"加数字"，而在**不能重复计算**。
 *
 * 问题场景：
 *   插件启动时要把"今天已经用掉的 Token"补进来（回填），
 *   但回填的同时，实时事件也在往这里推。
 *   如果两边都算，同一笔 Token 就会被算两次。
 *
 * 解决办法：用会话的事件序号（seq）做水位线。
 *   回填时记下"这个会话我读到第几条了"（maxSeq）。
 *   之后实时来的事件，seq 比水位线小的说明回填时已经算过，跳过。
 *
 * 这个文件不 import 任何 DSH/Node 的东西，可以脱离 DSH 单测。
 */

/** 本地时间当天 00:00:00 的毫秒时间戳 */
export function startOfToday(now = Date.now()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export class TokenTracker {
  /**
   * 拿不到会话号时，这笔钱记在这个桶里。
   * 用一个不可能与会话 id 相同的字符串（会话 id 是 UUID 之类，不会带这个前缀）。
   */
  static ORPHAN_KEY = '__no_session__'

  /**
   * @param {object} [options]
   * @param {number} [options.dayStartMs] 当天的起点；默认按当前时间算
   * @param {() => number} [options.now] 时钟；单测注入用
   */
  constructor(options = {}) {
    this._now = typeof options.now === 'function' ? options.now : Date.now
    this.dayStartMs = options.dayStartMs ?? startOfToday(this._now())

    /** sessionId -> 回填时读到的最大 seq（水位线） */
    this._scannedMax = new Map()
    /**
     * sessionId -> 这个会话「今天」用掉的 Token（v0.10.0 新增，卡片按行显示用）
     *
     * 【和 _total 的关系：旁路账本，不是它的分解】
     *   _total 仍然是「今日总额」的唯一权威，total() 也只读它。
     *   这张表是**额外**记的一份按会话切分的副本，专门给卡片"每个任务行
     *   显示自己那一份"用。绝对不能把 total() 改成"遍历这张表求和"——
     *   回填/水位线的语义不是"求和"能表达的，改了会成片崩掉去重逻辑。
     *
     * 【为什么回填的钱也要记进来（用户 2026-10-31 拍板，方案 B1）】
     *   插件启动时会把"今天已经用掉的 Token"从会话日志里补回来。
     *   如果这笔不算进会话，卡片刚启动那段时间每行都是 0 或很小，
     *   用户会以为功能坏了。算进去之后含义是"这个任务今天一共用了多少"。
     *
     * 【跨天必须清空】
     *   见 rollover()。不清的话过了零点卡片上还挂着昨天的数 ——
     *   而 _total 清了、这张表没清，两处会打架。
     */
    this._bySession = new Map()
    /** 回填期间先存着，等回填完成再结算 */
    this._buffer = []
    /** 是否还在回填中 */
    this._backfilling = false
    /** 累计值 */
    this._total = 0
    /** 诊断用 */
    this.stats = { backfillAmount: 0, liveAmount: 0, buffered: 0, droppedByWatermark: 0 }
  }

  /** 今日累计 Token */
  total() {
    return this._total
  }

  /**
   * 某个会话今天用掉的 Token 数。没记录过就返回 0（不返回 undefined）。
   * @param {string} sessionId
   * @returns {number}
   */
  sessionTotal(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return 0
    return this._bySession.get(id) ?? 0
  }

  /**
   * 按会话累加（内部用）。所有计入 _total 的地方都必须同时调它。
   *
   * 【为什么要单独一个私有方法而不是每处写两遍】
   *   计入金额的地方有三处：addBackfill / endBackfill / addLive。
   *   写三遍容易漏一处，而漏掉的那处表现是"数字跟总额对不上"，
   *   非常难排查（不会报错，只是少加）。集中成一处，改的时候只有一个地方。
   *
   * 【拿不到会话号时记到 ORPHAN_KEY，而不是直接丢掉】
   *   （2026-10-31 复核后改的，原写法是 `if (!id) return`）
   *
   *   原来的写法有个静默漏洞：addLive 没有判空，所以会话号是空串时
   *   _total 涨了、会话账本没涨 —— "各会话之和 = 今日总额"这条不变量
   *   被悄悄破坏，事后对账对不出来。
   *
   *   但**不能**像复核建议那样改成"没 id 就不记账"：那会把真实的 Token
   *   从今日总额里丢掉，而今日总额是实测校准到和官方账本 0 误差的
   *   （见 test/verify-tokens.mjs）。宁可记到一个专门的桶里，
   *   也不能让总额变少。
   *
   *   ORPHAN_KEY 是一个不可能与会话号冲突的字符串，卡片永远不会去查它，
   *   所以这笔钱"记在账上但不显示" —— 总额正确，卡片也不会凭空多出一行。
   */
  _addToSession(sessionId, amount) {
    const add = Math.round(Number(amount))
    if (!Number.isFinite(add) || add <= 0) return
    const id = String(sessionId ?? '') || TokenTracker.ORPHAN_KEY
    this._bySession.set(id, (this._bySession.get(id) ?? 0) + add)
  }

  /** 会话账本里所有条目之和。正常情况应该恰好等于 total()，测试用来守不变量。 */
  sessionSum() {
    let sum = 0
    for (const v of this._bySession.values()) sum += v
    return sum
  }

  /** 今天是不是已经换天了 */
  isStale(now = this._now()) {
    return startOfToday(now) !== this.dayStartMs
  }

  /** 跨天：清空重来。返回是否真的清零了。 */
  rollover(now = this._now()) {
    if (!this.isStale(now)) return false
    this.dayStartMs = startOfToday(now)
    this._scannedMax.clear()
    // 【v0.10.0】会话级账本也要清，否则卡片上会挂着昨天的数
    this._bySession.clear()
    this._buffer.length = 0
    this._total = 0
    this.stats = { backfillAmount: 0, liveAmount: 0, buffered: 0, droppedByWatermark: 0 }
    return true
  }

  // ---------------------------------------------------------------- 回填

  /** 开始回填。之后的实时事件先缓冲，不直接计入。 */
  beginBackfill() {
    this._backfilling = true
    this._buffer.length = 0
    return this
  }

  /**
   * 回填一个会话的结果。
   * @param {string} sessionId
   * @param {number} maxSeq 这个会话读到的最大事件序号
   * @param {number} amount 这个会话里"今天"的 Token 合计
   */
  addBackfill(sessionId, maxSeq, amount) {
    const id = String(sessionId ?? '')
    if (!id) return false

    // 水位线取最大值：同一会话可能被扫描多次
    const prev = this._scannedMax.get(id)
    const seq = Number.isFinite(maxSeq) ? maxSeq : 0
    this._scannedMax.set(id, prev === undefined ? seq : Math.max(prev, seq))

    const n = Number(amount)
    if (Number.isFinite(n) && n > 0) {
      const add = Math.round(n)
      this._total += add
      // 【v0.10.0】同时记进会话账本。回填的钱算进会话 = 用户拍板的方案 B1
      this._addToSession(id, add)
      this.stats.backfillAmount += add
      return true
    }
    return false
  }

  /** 回填期间收到的实时事件，先存着。 */
  bufferLive(sessionId, seq, amount) {
    this._buffer.push({ sessionId: String(sessionId ?? ''), seq: Number(seq) || 0, amount: Number(amount) || 0 })
    this.stats.buffered++
    return this
  }

  /**
   * 回填结束：把缓冲里的事件按水位线筛一遍再加。
   * @returns {{counted: number, skipped: number}}
   */
  endBackfill() {
    this._backfilling = false
    let counted = 0
    let skipped = 0
    for (const item of this._buffer) {
      if (this._isCoveredByBackfill(item.sessionId, item.seq)) {
        skipped++
        this.stats.droppedByWatermark++
        continue
      }
      if (item.amount > 0) {
        this._total += Math.round(item.amount)
        // 【v0.10.0】缓冲里的事件同样要记进会话账本。
        //   注意位置：只有**过了水位线**（没被 continue 掉）的才走到这里，
        //   所以不会把回填已经算过的钱重复记进会话。
        this._addToSession(item.sessionId, item.amount)
        this.stats.liveAmount += Math.round(item.amount)
        counted++
      }
    }
    this._buffer.length = 0
    return { counted, skipped }
  }

  // ---------------------------------------------------------------- 实时

  /**
   * 实时累计一笔。
   * 回填期间自动转成缓冲，避免重复计算。
   * @returns {boolean} 是否真的计入了
   */
  addLive(sessionId, seq, amount) {
    if (this._backfilling) {
      this.bufferLive(sessionId, seq, amount)
      return false
    }
    const id = String(sessionId ?? '')
    const s = Number(seq) || 0
    if (this._isCoveredByBackfill(id, s)) {
      this.stats.droppedByWatermark++
      return false
    }
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) return false
    const add = Math.round(n)
    this._total += add
    // 【v0.10.0】实时增长也记进会话账本。走到这里说明已过水位线，
    //   和上面的缓冲路径是互斥的（回填期间会走 bufferLive 提前 return）。
    this._addToSession(id, add)
    this.stats.liveAmount += add
    return true
  }

  /** 这条事件是不是回填时已经算过了 */
  _isCoveredByBackfill(sessionId, seq) {
    const max = this._scannedMax.get(sessionId)
    if (max === undefined) return false   // 回填时没这个会话（比如新建的），要算
    return seq <= max                      // 水位线以内，回填已覆盖
  }

  /** 诊断快照 */
  debug() {
    return {
      total: this._total,
      dayStart: new Date(this.dayStartMs).toISOString(),
      backfilling: this._backfilling,
      // 【v0.10.0】注意这两个数不是一回事，别混：
      //   sessionsTracked = 有水位线记录的会话数（_scannedMax）
      //   sessionsPriced  = 有会话级 Token 金额的会话数（_bySession）
      //
      // 【⚠️ 两者**没有**大小关系】（2026-10-31 复核纠错，原来这里写的是错的）
      //   原注释说"前者 >= 后者"，实测能反过来：
      //     beginBackfill → addBackfill('old',100,5000) → endBackfill
      //       → addLive('brand-new',5,700)
      //     结果 sessionsTracked = 1，sessionsPriced = 2。
      //   原因：回填之后**新建的会话**只有实时金额、没有水位线。
      //   所以两种反例都存在：
      //     · 只有水位线没有金额：今天没用过的会话（回填记了水位线，金额 0）
      //     · 只有金额没有水位线：回填完成后才出现的新会话
      //   排查时别拿"谁大谁小"去推断，方向会被带偏。
      sessionsTracked: this._scannedMax.size,
      sessionsPriced: this._bySession.size,
      // 账本求和，用来跟 total 对账（正常情况下两者相等）
      sessionSum: this.sessionSum(),
      buffered: this._buffer.length,
      stats: { ...this.stats },
    }
  }
}
