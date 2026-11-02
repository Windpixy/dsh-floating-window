/**
 * test/d3-holiday-cache.mjs -- D3：节假日缓存的更新与校验
 *
 * ===========================================================================
 * 【这个测试守的是什么】
 * ===========================================================================
 *
 * 实测代码确认了两个真实问题（lib/valley.js:346-399）：
 *
 * 【问题1：同年陈旧数据永不更新】
 *   refresh() 里：
 *     if (this.fetchedYears && this.fetchedYears.has(y)) {
 *       got.push(y); continue          ← 直接跳过，完全不看缓存多旧
 *     }
 *
 *   于是"我 2026 年拉过一次"之后，即使这份数据已经是三个月前的旧版，
 *   每次 refresh 都会跳过。国务院修订节假日安排时（历史上确实发生过
 *   调休调整），插件永远拿不到新版本。
 *
 *   isStale() 定义了 30 天阈值，但**只在别处用**，refresh 里根本没调它。
 *
 * 【问题2：不校验响应是不是我们要的那一年】
 *   parseHolidayJson() 只做两件事：
 *     · 检查日期格式是 YYYY-MM-DD
 *     · 排除 isOffDay=false
 *   然后就把结果当成"这一年的节假日"存进 years[key]。
 *
 *   它**不检查**：
 *     · 返回的 json.year 是否等于请求的年份
 *     · 日期是否真的属于那一年（比如请求 2027 却返回 2026 的日期）
 *     · 日期是否真实存在（2026-02-30）
 *     · 是否重复
 *
 *   后果：一个配置错误的镜像、或者镜像返回了错误的年份，
 *   会把错误数据写进缓存，而且因为"已拉过"就再也不刷新 ——
 *   **错误数据永久固化**。
 *
 * ===========================================================================
 * 【要验证的规则（用户 2026-11-02 拍板）】
 * ===========================================================================
 *   · 30 天到期重新请求同年数据
 *   · 结构/年份/日期错误直接拒绝，不污染缓存
 *   · 异常数量先 WARN 不贸然拒绝（避免把某年的 33 天当永久规则）
 *   · 网络失败保留旧缓存
 *
 * 跑法：node test/d3-holiday-cache.mjs
 */

import { HolidayStore, parseHolidayJson } from '../lib/valley.js'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failed = 0
let passed = 0
const group = (n) => console.log(`\n=== ${n} ===`)
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

console.log('='.repeat(70))
console.log('D3：节假日缓存更新与校验')
console.log('='.repeat(70))

const dirs = []
function freshStore(extra = {}) {
  const d = mkdtempSync(join(tmpdir(), 'dsh-d3-'))
  dirs.push(d)
  const logs = []
  const store = new HolidayStore({
    path: join(d, 'holidays.json'),
    log: (msg, o) => logs.push({ msg, ...(o || {}) }),
    ...extra,
  })
  return { store, dir: d, logs }
}

const DAY_MS = 24 * 3600 * 1000

/** 造一份合法的节假日响应 */
function makeResp(year, dates, extra = {}) {
  return {
    year,
    days: dates.map((dt) => ({ date: dt, isOffDay: true, name: '假' })),
    ...extra,
  }
}

function makeFetcher(responses) {
  // responses: { [year]: jsonOrFn }
  return async (url) => {
    const m = /year=(\d{4})|(\d{4})\.json|\/(\d{4})\b/.exec(url)
    const y = m ? Number(m[1] || m[2] || m[3]) : null
    const r = responses[y]
    if (r === undefined) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const body = typeof r === 'function' ? r() : r
    if (body === 'THROW') throw new Error('网络错误')
    if (body === 'BADJSON') {
      return { ok: true, json: async () => { throw new Error('JSON 坏了') } }
    }
    return { ok: true, json: async () => body }
  }
}

try {
  // ================================================================ 1. 陈旧时重新请求
  group('1. 【核心】30 天到期后，同年数据必须重新请求')

  {
    const { store, logs } = freshStore()

    // 造一份"31 天前拉的"缓存
    store.years = { '2026': ['20260101'] }
    store.fetchedYears = new Set([2026])
    store.fetchedAt = Date.now() - 31 * DAY_MS

    let requested = 0
    store.fetchImpl = async (url) => {
      requested++
      return { ok: true, json: async () => makeResp(2026, ['2026-01-01', '2026-05-01', '2026-10-01']) }
    }

    const before = [...(store.years['2026'] || [])]
    const r = await store.refresh(2026)

    check('【核心】陈旧时确实发起了请求', requested > 0, `requested=${requested}（改前是 0）`)
    check('  旧数据被替换成新的', (store.years['2026'] || []).length === 3,
      JSON.stringify(store.years['2026']))
    check('  新旧内容确实不同', JSON.stringify(before) !== JSON.stringify(store.years['2026']))
    check('  pulled 里包含 2026', Array.isArray(r.pulled) && r.pulled.includes(2026), JSON.stringify(r.pulled))
  }

  {
    // ---- 29 天：还没到期，2026 本身应该跳过
    //
    // 【断言要精确】
    //   refresh(2026) 会同时请求 2026 和 2027 两年（覆盖跨年）。
    //   2027 没被标记"已拉过"，所以它本来就会请求 —— 那不是 bug。
    //   要验证的是"2026 这一年在未到期时不被重复请求"。
    //   第一版断言用总请求数，把 2027 的正常请求也算进去了，所以误判。
    const { store } = freshStore()
    store.years = { '2026': ['20260101'] }
    store.fetchedYears = new Set([2026])
    store.fetchedAt = Date.now() - 29 * DAY_MS

    const requestedUrls = []
    store.fetchImpl = async (url) => {
      requestedUrls.push(url)
      return { ok: true, json: async () => makeResp(2026, ['2026-01-01']) }
    }

    await store.refresh(2026)

    const askedFor2026 = requestedUrls.some((u) => u.includes('2026'))
    check('29 天（未到期）→ 不请求 2026 这一年', askedFor2026 === false,
      `请求了: ${requestedUrls.join(', ')}`)
    check('  2026 缓存内容保持不变', (store.years['2026'] || []).length === 1,
      JSON.stringify(store.years['2026']))
    check('  但仍会请求下一年（覆盖跨年，这是正常行为）',
      requestedUrls.some((u) => u.includes('2027')) || requestedUrls.length === 0,
      `请求了: ${requestedUrls.join(', ')}`)
  }

  // ================================================================ 2. 年份校验
  group('2. 【核心】返回的年份不对，必须拒绝')

  {
    const { store } = freshStore()
    store.years = { '2026': ['20260101'] }
    store.fetchedYears = new Set()          // 没有 "已拉过" 标记，会去请求
    store.fetchedAt = 0

    // 请求 2026，但镜像返回 2025 的数据
    store.fetchImpl = async () => ({
      ok: true,
      json: async () => ({ year: 2025, days: [{ date: '2025-01-01', isOffDay: true }] }),
    })

    await store.refresh(2026)
    check('【核心】year 不匹配 → 不写入缓存',
      JSON.stringify(store.years['2026']) === JSON.stringify(['20260101']),
      JSON.stringify(store.years['2026']))
    check('  没有把 2025 的日期混进 2026', !(store.years['2026'] || []).includes('20250101'))
  }

  {
    // ---- 日期不属于目标年份
    const { store } = freshStore()
    store.fetchedYears = new Set()
    store.fetchedAt = 0
    store.years = {}

    store.fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        // 声称是 2026 的数据，但日期是 2025 的
        days: [{ date: '2025-01-01', isOffDay: true }, { date: '2025-05-01', isOffDay: true }],
      }),
    })

    await store.refresh(2026)
    const got = store.years['2026'] || []
    const allIn2026 = got.every((d) => String(d).startsWith('2026'))
    check('【核心】日期不属于目标年份 → 拒绝（或至少只保留该年的）', allIn2026,
      JSON.stringify(got))
  }

  // ================================================================ 3. 非法日期
  group('3. 非法/边界数据不能进缓存')

  {
    const cases = [
      ['2026-02-30', '不存在的日期（2月30日）'],
      ['2026-13-01', '月份 13'],
      ['2026-00-10', '月份 0'],
      ['2026-01-00', '日 0'],
      ['2026-01-32', '日 32'],
      ['not-a-date', '格式错'],
      ['2026/01/01', '斜杠格式'],
      ['20260101', '无分隔'],
    ]

    for (const [dt, desc] of cases) {
      const out = parseHolidayJson({ days: [{ date: dt, isOffDay: true }] })
      check(`${desc} 被过滤掉`, out.length === 0, `实际: ${JSON.stringify(out)}`)
    }

    // ---- 重复日期要去重
    const dup = parseHolidayJson({
      days: [
        { date: '2026-01-01', isOffDay: true },
        { date: '2026-01-01', isOffDay: true },
        { date: '2026-01-01', isOffDay: true },
      ],
    })
    check('重复日期去重', dup.length === 1, JSON.stringify(dup))

    // ---- isOffDay=false 要排除
    const makeup = parseHolidayJson({
      days: [
        { date: '2026-01-01', isOffDay: true },
        { date: '2026-01-04', isOffDay: false },   // 调休上班
      ],
    })
    check('调休上班日不计入放假日', makeup.length === 1 && makeup[0] === '20260101',
      JSON.stringify(makeup))

    // ---- 非对象 / 缺 days / 空数组
    check('null → 空数组', parseHolidayJson(null).length === 0)
    check('非对象 → 空数组', parseHolidayJson('garbage').length === 0)
    check('缺 days → 空数组', parseHolidayJson({ year: 2026 }).length === 0)
    check('days 不是数组 → 空数组', parseHolidayJson({ days: 'nope' }).length === 0)
    check('空 days → 空数组', parseHolidayJson({ days: [] }).length === 0)
    check('days 里有 null 项 → 跳过不崩',
      parseHolidayJson({ days: [null, { date: '2026-01-01', isOffDay: true }, undefined] }).length === 1)
  }

  // ================================================================ 4. 网络失败保留旧缓存
  group('4. 网络失败时保留旧缓存')

  {
    const { store, logs } = freshStore()
    const oldData = ['20260101', '20260501']
    store.years = { '2026': oldData }
    store.fetchedYears = new Set()
    store.fetchedAt = 0

    store.fetchImpl = async () => { throw new Error('网络断了') }

    await store.refresh(2026)
    check('【关键】网络失败 → 旧缓存完好',
      JSON.stringify(store.years['2026']) === JSON.stringify(oldData),
      JSON.stringify(store.years['2026']))
    check('  有记录错误', typeof store.lastError === 'string' && store.lastError.length > 0,
      store.lastError)
  }

  {
    // ---- 坏 JSON
    const { store } = freshStore()
    const oldData = ['20260101']
    store.years = { '2026': oldData }
    store.fetchedYears = new Set()
    store.fetchedAt = 0

    store.fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('解析失败') } })
    await store.refresh(2026)
    check('坏 JSON → 旧缓存完好', JSON.stringify(store.years['2026']) === JSON.stringify(oldData))
  }

  {
    // ---- 空列表不能覆盖好缓存
    const { store } = freshStore()
    const oldData = ['20260101', '20260501']
    store.years = { '2026': oldData }
    store.fetchedYears = new Set()
    store.fetchedAt = 0

    store.fetchImpl = async () => ({ ok: true, json: async () => ({ year: 2026, days: [] }) })
    await store.refresh(2026)
    check('空列表 → 旧缓存不被清空',
      JSON.stringify(store.years['2026']) === JSON.stringify(oldData),
      JSON.stringify(store.years['2026']))
  }

  // ================================================================ 5. 跨年
  group('5. 跨年：前一年/今年/下一年都要能取到')

  {
    const { store } = freshStore()
    store.years = {
      '2025': ['20250101'],
      '2026': ['20260101'],
      '2027': ['20270101'],
    }
    store.fetchedYears = new Set([2025, 2026, 2027])
    store.fetchedAt = Date.now()  // 新鲜

    // 2026-12-31 应该能取到 2025/2026/2027 三天
    const d1231 = Date.UTC(2026, 11, 31, 4, 0, 0) - 8 * 3600 * 1000
    const around = store.setAround(d1231)
    check('跨年时能合并相邻年份',
      around.has('20250101') && around.has('20260101') && around.has('20270101'),
      JSON.stringify([...around]))
  }

  {
    // ---- 下一年 404 不能影响今年
    const { store } = freshStore()
    store.years = { '2026': ['20260101'] }
    store.fetchedYears = new Set()
    store.fetchedAt = 0

    store.fetchImpl = async (url) => {
      if (url.includes('2027')) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, json: async () => makeResp(2026, ['2026-01-01', '2026-05-01']) }
    }

    const r = await store.refresh(2026)
    check('下一年 404 时，今年仍可用', (store.years['2026'] || []).length === 2,
      JSON.stringify(store.years['2026']))
    check('  ok 为 true（有可用数据）', r.ok === true, String(r.ok))
  }

  // ================================================================ 6. 成功后清理 lastError
  group('6. 成功之后应当清掉旧的 lastError')

  {
    const { store } = freshStore()
    store.years = {}
    store.fetchedYears = new Set()
    store.fetchedAt = 0
    store.lastError = '上次失败的旧错误'

    store.fetchImpl = async () => ({ ok: true, json: async () => makeResp(2026, ['2026-01-01']) })
    await store.refresh(2026)

    check('成功后 lastError 被清掉', !store.lastError || store.lastError === '',
      store.lastError)
  }

  // ================================================================ 7. 保存走安全写入（D1）
  group('7. 保存文件走 D1 的原子写（不留临时文件、不写坏）')

  {
    const { store, dir } = freshStore()
    store.years = { '2026': ['20260101', '20260501'] }
    store.fetchedYears = new Set([2026])
    store.fetchedAt = Date.now()
    store.save()

    const p = join(dir, 'holidays.json')
    check('文件已写出', existsSync(p))
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    check('版本 2', raw.version === 2, String(raw.version))
    check('years 正确', Array.isArray(raw.years['2026']) && raw.years['2026'].length === 2)
    check('pulledYears 记录了 2026', raw.pulledYears.includes(2026), JSON.stringify(raw.pulledYears))

    // ---- 无临时文件残留
    const { readdirSync } = await import('node:fs')
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    check('无临时文件残留', leftovers.length === 0, leftovers.join(','))
  }

} catch (e) {
  console.log('\n❌ 测试异常: ' + (e && e.stack))
  failed++
} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log('')
console.log('='.repeat(70))
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) console.log('全部通过 ✅')
else process.exitCode = 1
console.log('='.repeat(70))
