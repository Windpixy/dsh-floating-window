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
   * @param {object} [options]
   * @param {number} [options.dayStartMs] 当天的起点；默认按当前时间算
   * @param {() => number} [options.now] 时钟；单测注入用
   */
  constructor(options = {}) {
    this._now = typeof options.now === 'function' ? options.now : Date.now
    this.dayStartMs = options.dayStartMs ?? startOfToday(this._now())

    /** sessionId -> 回填时读到的最大 seq（水位线） */
    this._scannedMax = new Map()
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

  /** 今天是不是已经换天了 */
  isStale(now = this._now()) {
    return startOfToday(now) !== this.dayStartMs
  }

  /** 跨天：清空重来。返回是否真的清零了。 */
  rollover(now = this._now()) {
    if (!this.isStale(now)) return false
    this.dayStartMs = startOfToday(now)
    this._scannedMax.clear()
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
      sessionsTracked: this._scannedMax.size,
      buffered: this._buffer.length,
      stats: { ...this.stats },
    }
  }
}
