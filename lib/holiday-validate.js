/**
 * 节假日响应校验（v0.10.15 · D3）
 *
 * @param {unknown} json 镜像返回的原始对象
 * @param {number} targetYear 我们请求的年份
 * @param {(msg: string, extra?: object) => void} [log]
 * @returns {{ok: boolean, list: string[], reason?: string}}
 *   ok=false 表示这份响应不可信，调用方应保留旧缓存。
 *   list 是 YYYYMMDD 数组（已去重、已排除调休上班日）。
 */
export function validateHolidayResponse(json, targetYear, log = () => {}) {
  const reject = (reason) => ({ ok: false, list: [], reason })

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return reject('响应不是对象')
  }

  const days = json.days
  if (!Array.isArray(days)) return reject('缺少 days 数组')
  if (days.length === 0) return reject('days 是空数组')

  // ---- ① year 字段存在时，必须等于目标年份
  //
  // 【为什么要检查】
  //   镜像配置错误、或者接口把年份当参数却返回了默认年份时，
  //   我们拿到的会是另一年的数据。不检查的话，错误数据会写进
  //   years[key]（key 是目标年份），而且因为"已拉过"再也不刷新
  //   —— 错误永久固化。
  if (json.year !== undefined && json.year !== null) {
    const y = Number(json.year)
    if (!Number.isFinite(y)) return reject('year 不是数字')
    if (y !== Number(targetYear)) {
      return reject(`year 不匹配（期望 ${targetYear}，实际 ${y}）`)
    }
  }

  // ---- ② 逐条校验日期
  const seen = new Set()
  const list = []
  let skippedCount = 0

  for (const d of days) {
    if (!d || typeof d !== 'object') { skippedCount++; continue }
    // 调休上班日不计入放假日集合（现有产品口径，不改）
    if (d.isOffDay === false) continue

    const date = typeof d.date === 'string' ? d.date : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skippedCount++; continue }

    const [ys, ms, ds] = date.split('-').map(Number)

    // 日期必须真实存在（2026-02-30 是无效的）
    const dt = new Date(Date.UTC(ys, ms - 1, ds))
    if (dt.getUTCFullYear() !== ys || dt.getUTCMonth() !== ms - 1 || dt.getUTCDate() !== ds) {
      skippedCount++
      continue
    }

    // ---- ③ 日期必须属于目标年份
    if (ys !== Number(targetYear)) { skippedCount++; continue }

    const compact = `${ys}${String(ms).padStart(2, '0')}${String(ds).padStart(2, '0')}`
    if (seen.has(compact)) continue          // 去重
    seen.add(compact)
    list.push(compact)
  }

  if (skippedCount > 0) {
    // 单条脏数据只记日志，不整份拒绝（避免因为一条脏数据就把好数据全丢掉）
    log('节假日响应里有无效日期，已跳过', { targetYear, skipped: skippedCount, total: days.length })
  }

  if (list.length === 0) return reject('没有有效的放假日')

  // ---- ④ 数量合理性：先 WARN 不拒绝
  //
  // 【为什么不直接拒绝】
  //   施工卡明确要求"不要拍脑袋写死成某年的 33 天"。
  //   中国法定节假日每年不同（2025 年 13 天放假 + 调休，2026 年又是另一组），
  //   把某一年数字当成永久规则，下次官方调整就会误拒。
  //   所以这里只在明显异常时记 WARN，让人在日志里看得到。
  const n = list.length
  if (n < 3 || n > 60) {
    log('节假日数量异常（请人工核对）', { targetYear, count: n })
  }

  return { ok: true, list }
}
