/**
 * lib/valley.js -- 自动判断「现在是不是 DeepSeek 的低价时段」
 *
 * 【为什么需要这个模块】
 *   卡片原先靠用户手填 `settings.json` 里的 `valley` 字段：
 *       {"mon": [["00:30","08:30"]], ... 七天全一样}
 *   但 DeepSeek 官方规则根本不是这样。查官方文档
 *   （api-docs.deepseek.com/zh-cn/quick_start/pricing）明确写着：
 *
 *     > 空闲时段价格为高峰时段价格的一半。北京时间周一至周五
 *     > （不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；
 *     > 其余时段，包括周末及中国法定节假日全天均为空闲时段。
 *
 *   也就是：工作日只有 9-12 和 14-18 共 7 小时是峰时，其余 17 小时都是谷时；
 *   周末和法定节假日全天谷时。手填的「每天 00:30-08:30」把大量谷时算成了峰时，
 *   卡片上的「距谷时开始」基本是错的。
 *
 * 【为什么不像别的插件那样把时段写死在代码里】
 *   别的插件（如 dsh-ui-usage-billing）把「9-12/14-18 + 周末 + 节假日」写死。
 *   问题在于节假日每年国务院才公布一次，写死就必然过期，改一次要发一个版本。
 *
 *   所以这里做成：
 *     1. 时段规则（9-12/14-18、周末）写死 —— 这条极稳定，官方从改版至今没变
 *     2. 节假日从网上拉 —— 每年会变，必须能更新
 *     3. 拉不到就用本地缓存 —— 断网也能工作
 *     4. 缓存也过期就用「只认周末」的降级模式 —— 永远能给出一个合理答案
 *
 * 【数据源】
 *   NateScarlet/holiday-cn —— 逐年在抓国务院公告的开源仓库，
 *   也被上面提到的计费插件引用。这里只用它的 `days`（放假日期），
 *   因为调休上班日（`workdays`）在计费口径上仍按节假日算谷时，
 *   官方文档说的是"法定节假日"，不含调休。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { builtinHolidaysFor, builtinYears, BUILTIN_VERSION } from './holidays-builtin.js'

/** 高峰时段（北京时间）。官方文档：9:00-12:00、14:00-18:00 */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 北京时间相对 UTC 的偏移（毫秒）。中国不实行夏令时，固定 +8。 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** 缓存多久算过期。节假日一年才变一次，30 天足够。 */
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000

/** 节假日数据源。多个镜像，按顺序试。 */
const HOLIDAY_SOURCES = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
]

// ---------------------------------------------------------------- 时间换算

/**
 * 把任意时刻换成「北京时间当天的分钟数」。
 * 为什么要单独算：宿主所在时区不一定是 +8，不能直接用 getHours()。
 * @param {number} timeMs epoch 毫秒
 * @returns {number} 0..1439
 */
export function beijingMinuteOfDay(timeMs) {
  const shifted = timeMs + BEIJING_OFFSET_MS
  const dayMs = ((shifted % 86400000) + 86400000) % 86400000
  return Math.floor(dayMs / 60000)
}

/**
 * 北京时间星期几。0=周日，1=周一 … 6=周六
 * @param {number} timeMs
 */
export function beijingWeekday(timeMs) {
  const d = new Date(timeMs + BEIJING_OFFSET_MS)
  return d.getUTCDay()
}

/**
 * 北京日期键 YYYYMMDD，与宿主时区无关。
 * @param {number} timeMs
 */
export function beijingDateKey(timeMs) {
  const d = new Date(timeMs + BEIJING_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}

// ---------------------------------------------------------------- 时段判断

/**
 * 判断某一时刻是不是高峰时段。
 *
 * @param {number} timeMs
 * @param {Set<string>} holidays 节假日日期键集合（YYYYMMDD）
 * @returns {{ peak: boolean, reason: 'weekend' | 'holiday' | 'window' | 'off-window' }}
 */
export function judgePeak(timeMs, holidays) {
  const weekday = beijingWeekday(timeMs)
  if (weekday === 0 || weekday === 6) return { peak: false, reason: 'weekend' }
  if (holidays && holidays.has(beijingDateKey(timeMs))) return { peak: false, reason: 'holiday' }
  const minute = beijingMinuteOfDay(timeMs)
  for (const [start, end] of PEAK_WINDOWS) {
    if (minute >= start && minute < end) return { peak: true, reason: 'window' }
  }
  return { peak: false, reason: 'off-window' }
}

/**
 * 算出「距下一次状态切换还有多久」。
 *
 * 卡片要显示的是一个倒计时：现在在谷时，就显示「还有 X 分进入峰时」；
 * 现在在峰时，就显示「还有 X 分进入谷时」。
 *
 * 做法：从当前时刻往后，按分钟逐格探测状态翻转点。
 * 为什么不用解析式求解：规则里混了周末和节假日，跨天跨周，
 * 解析式很容易写错。逐分钟探测单次极便宜，而且绝不可能算错。
 *
 * 【扫描范围为什么从 7 天改成 16 天】
 *   这是测试抓出来的真实 bug：春节/国庆最长能连休 8 天，加上前后的周末，
 *   从"假期前一天傍晚"到"假期后第一个工作日 09:00"可以超过 7 天。
 *   7 天的窗口探不到翻转点，就返回 remainingMs=0 —— 卡片会显示「还有 0 分
 *   进入峰时」，并且一直停在 0，看起来像卡死了。
 *   16 天足以覆盖「最长假期 + 两侧周末」的极端组合。
 *
 * @param {number} timeMs 现在
 * @param {Set<string>} holidays
 * @param {number} [maxScanMinutes] 最多往前探多少分钟，默认 16 天
 * @returns {{ inValley: boolean, reason: string, remainingMs: number, switchAtMs: number | null }}
 */
export function nextSwitch(timeMs, holidays, maxScanMinutes = 16 * 24 * 60) {
  const now = judgePeak(timeMs, holidays)
  const inValley = !now.peak

  // 对齐到下一个整分钟，避免从中间开始切
  const minuteMs = 60000
  let cursor = Math.ceil(timeMs / minuteMs) * minuteMs
  let scanned = 0
  while (scanned < maxScanMinutes) {
    cursor += minuteMs
    scanned++
    const at = judgePeak(cursor, holidays)
    if (at.peak !== now.peak) {
      return {
        inValley,
        reason: now.reason,
        remainingMs: Math.max(0, cursor - timeMs),
        switchAtMs: cursor,
      }
    }
  }
  // 探不到翻转点（理论上不该发生，除非节假日数据把整段都标成假期）。
  // 返回 null 让调用方知道"没算出来"，不要用 0 冒充"马上要切"。
  return { inValley, reason: now.reason, remainingMs: 0, switchAtMs: null }
}

// ---------------------------------------------------------------- 节假日数据

/**
 * 解析 holiday-cn 的 JSON，只取「真正放假的日子」。
 *
 * 【关键：必须看 isOffDay 字段】
 *   该仓库的数据形如：
 *     { "year": 2026, "days": [
 *         { "name": "元旦", "date": "2026-01-01", "isOffDay": true  },   <- 放假
 *         { "name": "元旦", "date": "2026-01-04", "isOffDay": false },   <- 调休上班
 *         { "name": "春节", "date": "2026-02-14", "isOffDay": false },   <- 调休上班
 *     ] }
 *
 *   `days` 里**既有放假日，也有调休上班日**，靠 `isOffDay` 区分。
 *   实测 2026 年 days 共 39 条，其中 33 条放假、6 条调休上班
 *   （01-04 / 02-14 / 02-28 / 05-09 / 09-20 / 10-10）。
 *
 *   如果只按"有 date 就收"，会把 6 个调休上班日当成节假日，
 *   导致这些天被算成谷时 —— 而它们其实是正常工作日的周六/周日，
 *   DeepSeek 官方口径下（非节假日）仍按周末/时段规则走。
 *   这个 bug 不会报错，只会让倒计时悄悄偏 1 天，极难发现。
 *
 * 【为什么仍然不收调休上班日】
 *   DeepSeek 官方文档：「（不含中国法定节假日）……法定节假日全天均为空闲时段」。
 *   调休上班日不是法定节假日，所以按官方口径：
 *     · 若它落在周六/周日 → 仍按"周末全天谷时"处理（结果还是谷时）
 *     · 若它落在工作日     → 按 9-12/14-18 峰时规则处理
 *   两种都自动由 judgePeak 的周末/时段分支得出，不需要额外数据。
 *
 * @param {unknown} json
 * @returns {string[]} YYYYMMDD 数组
 */
export function parseHolidayJson(json) {
  const out = []
  const days = json && Array.isArray(json.days) ? json.days : []
  for (const d of days) {
    if (!d || typeof d !== 'object') continue
    // 明确标了 isOffDay=false 的是调休上班日，跳过。
    // 字段缺失时按"放假"处理（兼容没有这个字段的旧数据/其它数据源）。
    if (d.isOffDay === false) continue
    const date = typeof d.date === 'string' ? d.date : ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.push(date.replace(/-/g, ''))
  }
  return out
}

/**
 * 解析出调休上班日（isOffDay=false 的那些）。
 * 目前不参与峰谷计算，单独导出便于排查和以后扩展。
 * @param {unknown} json
 * @returns {string[]} YYYYMMDD 数组
 */
export function parseMakeupWorkdays(json) {
  const out = []
  const days = json && Array.isArray(json.days) ? json.days : []
  for (const d of days) {
    if (!d || typeof d !== 'object' || d.isOffDay !== false) continue
    const date = typeof d.date === 'string' ? d.date : ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.push(date.replace(/-/g, ''))
  }
  return out
}

/**
 * 节假日数据的本地缓存。
 * 一个文件存全部年份，免得管多个文件。
 */
export class HolidayStore {
  /**
   * @param {object} opts
   * @param {string} opts.path 缓存文件路径
   * @param {(msg: string, extra?: unknown) => void} [opts.log]
   * @param {typeof fetch} [opts.fetchImpl] 便于测试注入
   */
  constructor(opts) {
    this.path = opts.path
    this.log = opts.log ?? (() => {})
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    /** @type {Record<string, string[]>} year -> YYYYMMDD[] */
    this.years = {}
    /**
     * 哪些年份是**从网上拉到的**（区别于内置兜底）。
     * 只有这些才值得跳过联网；否则内置的旧数据会挡住新一年的获取。
     * @type {Set<number>}
     */
    this.fetchedYears = new Set()
    this.fetchedAt = 0
    this.lastError = ''
    this.load()
  }

  load() {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const j = JSON.parse(raw)
      this.years = (j && typeof j.years === 'object' && j.years) || {}
      this.fetchedAt = Number(j && j.fetchedAt) || 0
      // 缓存里记着"哪些年是从网上拉的"，恢复回来
      this.fetchedYears = new Set(
        Array.isArray(j && j.pulledYears) ? j.pulledYears.map(Number).filter(Number.isFinite) : []
      )
    } catch {
      // 文件不存在或坏了，从空开始
      this.years = {}
      this.fetchedAt = 0
      this.fetchedYears = new Set()
    }
    // 用内置数据补上"网上没拉到、缓存里也没有"的年份。
    // 必须在 load 之后做：缓存里的算"拉到的"，优先级更高，
    // 不能反过来让内置的旧数据覆盖新拉到的。
    this._fillFromBuiltin()
  }

  /**
   * 把内置数据补进缺失的年份。
   * 只补空的，不覆盖已有的 —— 联网拉到的永远优先。
   */
  _fillFromBuiltin() {
    for (const y of builtinYears()) {
      const key = String(y)
      const cur = this.years[key]
      if (Array.isArray(cur) && cur.length > 0) continue
      const list = builtinHolidaysFor(y)
      if (list.length > 0) this.years[key] = list
    }
    this.builtinVersion = BUILTIN_VERSION
  }

  save() {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      writeFileSync(this.path, JSON.stringify({
        version: 2,
        fetchedAt: this.fetchedAt,
        years: this.years,
        // 记下哪些是"从网上拉到的"，下次启动才不会因为内置数据而跳过联网
        pulledYears: [...this.fetchedYears],
      }, null, 2), 'utf8')
    } catch (e) {
      this.log('保存节假日缓存失败', { error: String(e && e.message) })
    }
  }

  /** 缓存是否过期（或从没有过） */
  isStale(nowMs = Date.now()) {
    if (!this.fetchedAt) return true
    return (nowMs - this.fetchedAt) > CACHE_TTL_MS
  }

  /**
   * 取某年的节假日集合。
   * @param {number} year 如 2026
   * @returns {Set<string>}
   */
  setFor(year) {
    return new Set(this.years[String(year)] || [])
  }

  /** 跨年边界要用：把今年和明年的合并，避免元旦当天判错 */
  setAround(timeMs) {
    const d = new Date(timeMs + BEIJING_OFFSET_MS)
    const y = d.getUTCFullYear()
    const merged = new Set()
    for (const yy of [y - 1, y, y + 1]) {
      for (const k of (this.years[String(yy)] || [])) merged.add(k)
    }
    return merged
  }

  /**
   * 拉取指定年份（含下一年，覆盖跨年）。
   * 网络失败不抛异常，只记录错误 —— 卡片靠缓存继续工作。
   * @param {number} year
   * @returns {Promise<{ ok: boolean, years: number[], error?: string }>}
   */
  async refresh(year) {
    if (typeof this.fetchImpl !== 'function') {
      this.lastError = '当前环境没有 fetch'
      return { ok: false, years: [], error: this.lastError }
    }
    const got = []
    const pulled = []
    for (const y of [year, year + 1]) {
      const key = String(y)
      // 关键：已经"从网上拉到"的年份才跳过。
      // 光有内置数据不能算拉到 —— 内置的是上一年的旧数据，
      // 如果因为它而跳过联网，新的一年永远拿不到，春节就会被算成工作日。
      if (this.fetchedYears && this.fetchedYears.has(y)) {
        got.push(y)
        continue
      }
      let okThisYear = false
      for (const tpl of HOLIDAY_SOURCES) {
        const url = tpl.replace('{year}', key)
        try {
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) })
          if (!res.ok) continue
          const json = await res.json()
          const list = parseHolidayJson(json)
          if (list.length > 0) {
            this.years[key] = list
            if (!this.fetchedYears) this.fetchedYears = new Set()
            this.fetchedYears.add(y)
            got.push(y)
            pulled.push(y)
            okThisYear = true
            this.log('已获取节假日', { year: y, days: list.length, url })
            break
          }
        } catch (e) {
          this.lastError = String(e && e.message)
        }
      }
      if (!okThisYear) {
        this.log('获取某年节假日失败（将使用内置/缓存数据）', {
          year: y,
          error: this.lastError,
          hasBuiltin: (this.years[key] || []).length > 0,
        })
      }
    }
    if (pulled.length > 0) {
      this.fetchedAt = Date.now()
      this.save()
    }
    // 注意 ok 的含义是"现在有可用的节假日数据"，包括内置兜底。
    // 只要某年有数据，就不该让调用方以为"什么都没有"。
    const hasAny = got.length > 0 || this.setAround(Date.now()).size > 0
    return { ok: hasAny, years: got, pulled, error: this.lastError }
  }

  /**
   * 调试用：目前有哪些年份、各多少天、哪些是拉到的
   */
  debug() {
    const out = {}
    for (const [y, list] of Object.entries(this.years)) out[y] = list.length
    return {
      path: this.path,
      fetchedAt: this.fetchedAt,
      stale: this.isStale(),
      years: out,
      pulledYears: this.fetchedYears ? [...this.fetchedYears] : [],
      builtinVersion: this.builtinVersion || null,
      lastError: this.lastError,
    }
  }
}

export const PEAK_RULES = Object.freeze({
  windows: PEAK_WINDOWS.map(([s, e]) => [s, e]),
  description: '北京时间周一至周五（不含法定节假日）09:00-12:00、14:00-18:00 为高峰；其余为低谷',
})
