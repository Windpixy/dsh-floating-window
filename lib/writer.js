/**
 * lib/writer.js -- 把状态写到磁盘
 *
 * 两个必须满足的要求：
 *
 * 1. **卡片永远不能读到半截内容**
 *    卡片每 500ms 读一次 state.json。如果边写边读，可能读到写了一半的 JSON，
 *    卡片那边解析失败就退回「全 0」，屏幕上会闪一下「空闲」。
 *    做法：先写 state.json.tmp，再 rename 覆盖。Windows 上 rename 到已存在的
 *    文件是原子的（MoveFileEx REPLACE_EXISTING），读的一方要么看到旧的完整内容，
 *    要么看到新的完整内容，不会看到中间态。
 *
 * 2. **不能每条事件都写盘**
 *    DSH 忙的时候每秒几十条事件，每条都写会把磁盘打满。
 *    做法：节流。最快 writeThrottleMs 毫秒写一次，期间的多次变化合并成一次。
 *    但「待审批」这种要紧变化允许插队立刻写（优先级参数）。
 */

import { renameSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export class StateWriter {
  /**
   * @param {object} options
   * @param {string} options.dir 数据目录
   * @param {string} [options.fileName] 默认 state.json
   * @param {number} [options.throttleMs] 最快多久写一次，默认 500（和卡片读取频率一致）
   * @param {(msg: string, extra?: unknown) => void} [options.log]
   */
  constructor(options) {
    if (!options?.dir) throw new TypeError('StateWriter 需要 dir')
    this.dir = options.dir
    this.fileName = options.fileName ?? 'state.json'
    this.path = join(this.dir, this.fileName)
    this.tmpPath = this.path + '.tmp'
    this.throttleMs = options.throttleMs ?? 500
    this.log = options.log ?? (() => {})

    this._lastWriteAt = 0
    this._timer = null
    this._pending = null
    this._lastPayload = null
    this.writes = 0
    this.skipped = 0
    this.failures = 0
    this.retries = 0
    this.retriedFlushes = 0
    this._retryTimer = null
    this._pendingPayload = null

    try { mkdirSync(this.dir, { recursive: true }) } catch { /* 稍后写的时候还会再试 */ }
  }

  /**
   * 请求写一次。
   * @param {object} snapshot 要写的对象（会被 JSON.stringify）
   * @param {object} [opts]
   * @param {boolean} [opts.urgent] 要緊变化（如待审批出现），不等节流立刻写
   * @returns {boolean} 这次是否真的写了盘
   */
  write(snapshot, opts = {}) {
    const now = Date.now()
    const elapsed = now - this._lastWriteAt

    // 内容没变就不写，省磁盘
    const payload = JSON.stringify(snapshot, null, 2)
    if (payload === this._lastPayload) {
      this.skipped++
      return false
    }

    if (opts.urgent || elapsed >= this.throttleMs) {
      return this._flush(payload, now)
    }

    // 还在节流窗口里：记住最新内容，到点了再写
    this._pending = payload
    if (this._timer === null) {
      const wait = Math.max(0, this.throttleMs - elapsed)
      this._timer = setTimeout(() => {
        this._timer = null
        if (this._pending !== null) {
          const p = this._pending
          this._pending = null
          this._flush(p, Date.now())
        }
      }, wait)
      // 让 Node 不要因为这个定时器而无法退出
      if (typeof this._timer.unref === 'function') this._timer.unref()
    }
    this.skipped++
    return false
  }

  _flush(payload, now) {
    // 写临时文件（这一步几乎不会失败）
    try {
      writeFileSync(this.tmpPath, payload, 'utf8')
    } catch (e) {
      this.failures++
      this.log('写 state.json.tmp 失败', { error: String(e && e.message) })
      return false
    }

    // 再原子替换。
    //
    // Windows 上「改名覆盖」要求目标文件此刻没有被别的句柄占着。
    // 卡片每 500ms 读一次 state.json，读的那一瞬间正好撞上改名，就拿到 EPERM。
    // 卡片的持有时间通常 1~3ms，所以隔 10ms 重试几次就够。
    //
    // 为什么不同步 sleep：_flush 由定时器调用，同步阻塞会卡住整个 Node 事件循环，
    // 反而让 DSH 里别的事情（包括卡片那边读文件的时机）更乱。
    // 这里改成「失败就排一次 10ms 后的重试」，把等待交还给事件循环。
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(this.tmpPath, this.path)
        this._lastWriteAt = now
        this._lastPayload = payload
        this.writes++
        if (attempt > 0) this.retries++
        return true
      } catch (e) {
        lastErr = e
        const code = String(e && e.code || '')
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      }
    }

    // 三次瞬试都失败：说明读者正好在长持有（或发生了别的占用）。
    // 排一次延迟重试，别丢掉这次内容。
    const retryCode = String(lastErr && lastErr.code || '')
    if (retryCode === 'EPERM' || retryCode === 'EBUSY' || retryCode === 'EACCES') {
      if (this._retryTimer === null) {
        this._pendingPayload = payload
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null
          const p = this._pendingPayload
          this._pendingPayload = null
          if (p !== null) {
            this.retriedFlushes++
            this._flush(p, Date.now())
          }
        }, 10)
        if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref()
      } else {
        // 已有一次重试在排队，把最新的内容换上，到点一次性写
        this._pendingPayload = payload
      }
      return false
    }

    this.failures++
    this.log('写 state.json 失败', {
      error: String(lastErr && lastErr.message),
      code: retryCode,
    })
    // 清理残留的临时文件，避免下次 rename 被占用
    try { if (existsSync(this.tmpPath)) unlinkSync(this.tmpPath) } catch { /* ignore */ }
    return false
  }

  /** 强制把待写的写掉（插件卸载、DSH 退出时调用） */
  flushNow() {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    // 延迟重试队列里还有内容：优先把它写掉，否则退出时最后一条状态会丢
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    if (this._pendingPayload !== null) {
      const p = this._pendingPayload
      this._pendingPayload = null
      return this._flush(p, Date.now())
    }
    if (this._pending !== null) {
      const p = this._pending
      this._pending = null
      return this._flush(p, Date.now())
    }
    return false
  }

  dispose() {
    this.flushNow()
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
  }
}
