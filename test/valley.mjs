/**
 * test/valley.mjs -- 峰谷时段判断测试
 *
 * 判据来自 DeepSeek 官方文档（api-docs.deepseek.com/zh-cn/quick_start/pricing）：
 *   空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
 *   9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
 *   全天均为空闲时段。
 *
 * 这个测试**不依赖网络**：节假日用固定的 2026 年国庆数据。
 *
 * 跑法：node test/valley.mjs
 */

import {
  judgePeak,
  nextSwitch,
  beijingMinuteOfDay,
  beijingWeekday,
  beijingDateKey,
  parseHolidayJson,
  parseMakeupWorkdays,
  HolidayStore,
  PEAK_RULES,
} from '../lib/valley.js'
import { builtinHolidaysFor, builtinYears } from '../lib/holidays-builtin.js'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

/** 构造"北京时间某年月日某时某分"对应的 epoch 毫秒 */
function bj(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600 * 1000
}

/** 2026 年国庆假期（现有计费插件里记录的口径） */
const HOLIDAYS = new Set([
  '20260925', '20260926', '20260927',
  '20261001', '20261002', '20261003', '20261004', '20261005', '20261006', '20261007',
])

console.log('='.repeat(58))
console.log('峰谷时段判断')
console.log('='.repeat(58))

// ---------------------------------------------------------------- 基础换算
console.log('\n--- 时间换算（不依赖宿主时区）---')
check('北京 10:00 的当日分钟数 = 600', beijingMinuteOfDay(bj(2026, 10, 28, 10, 0)) === 600,
  String(beijingMinuteOfDay(bj(2026, 10, 28, 10, 0))))
check('北京 00:30 的当日分钟数 = 30', beijingMinuteOfDay(bj(2026, 10, 28, 0, 30)) === 30,
  String(beijingMinuteOfDay(bj(2026, 10, 28, 0, 30))))
check('2026-10-28 是周三', beijingWeekday(bj(2026, 10, 28, 12, 0)) === 3,
  String(beijingWeekday(bj(2026, 10, 28, 12, 0))))
check('2026-10-31 是周六', beijingWeekday(bj(2026, 10, 31, 12, 0)) === 6,
  String(beijingWeekday(bj(2026, 10, 31, 12, 0))))
check('日期键格式 YYYYMMDD', beijingDateKey(bj(2026, 10, 5, 12, 0)) === '20261005',
  beijingDateKey(bj(2026, 10, 5, 12, 0)))

// 关键：UTC 跨日边界不能算错。北京 10-28 07:00 = UTC 10-27 23:00
check('UTC 还是前一天时，北京日期仍算当天',
  beijingDateKey(bj(2026, 10, 28, 7, 0)) === '20261028',
  `北京10-28 07:00 => ${beijingDateKey(bj(2026, 10, 28, 7, 0))}`)

// ---------------------------------------------------------------- 峰谷判定
console.log('\n--- 峰时 / 谷时判定 ---')
const judgeCases = [
  ['工作日 09:00 整（峰时起点）', bj(2026, 10, 28, 9, 0), true],
  ['工作日 08:59（谷）', bj(2026, 10, 28, 8, 59), false],
  ['工作日 10:00（峰）', bj(2026, 10, 28, 10, 0), true],
  ['工作日 11:59（峰）', bj(2026, 10, 28, 11, 59), true],
  ['工作日 12:00 整（谷时起点）', bj(2026, 10, 28, 12, 0), false],
  ['工作日 12:30（谷）', bj(2026, 10, 28, 12, 30), false],
  ['工作日 14:00 整（峰时起点）', bj(2026, 10, 28, 14, 0), true],
  ['工作日 15:00（峰）', bj(2026, 10, 28, 15, 0), true],
  ['工作日 17:59（峰）', bj(2026, 10, 28, 17, 59), true],
  ['工作日 18:00 整（谷时起点）', bj(2026, 10, 28, 18, 0), false],
  ['工作日 18:30（谷）', bj(2026, 10, 28, 18, 30), false],
  ['工作日 23:00（谷）', bj(2026, 10, 28, 23, 0), false],
  ['工作日 02:00（谷）', bj(2026, 10, 28, 2, 0), false],
  ['周六 10:00（谷，周末全天）', bj(2026, 10, 31, 10, 0), false],
  ['周六 15:00（谷）', bj(2026, 10, 31, 15, 0), false],
  ['周日 15:00（谷）', bj(2026, 11, 1, 15, 0), false],
  ['国庆 10-05 10:00（谷，节假日全天）', bj(2026, 10, 5, 10, 0), false],
  ['国庆 10-02 15:00（谷）', bj(2026, 10, 2, 15, 0), false],
  ['国庆期间 10-06 14:00（谷，法定节假日优先于时段）', bj(2026, 10, 6, 14, 0), false],
  ['国庆前调休日 09-25 10:00（谷）', bj(2026, 9, 25, 10, 0), false],
  // 假期结束后第一个工作日应恢复峰时
  ['假期后 10-08 10:00（峰，恢复工作）', bj(2026, 10, 8, 10, 0), true],
]
for (const [label, ms, expect] of judgeCases) {
  const r = judgePeak(ms, HOLIDAYS)
  check(label, r.peak === expect, r.peak ? '峰时' : `谷时/${r.reason}`)
}

// ---------------------------------------------------------------- 倒计时
console.log('\n--- 距下次切换的倒计时 ---')
function fmt(ms) {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return `${h}小时${m}分`
}

{
  // 工作日 10:00 峰时，12:00 转谷 → 还有 2 小时
  const r = nextSwitch(bj(2026, 10, 28, 10, 0), HOLIDAYS)
  check('峰时 10:00 → 2 小时后转谷', !r.inValley && Math.abs(r.remainingMs - 2 * 3600000) < 60000, fmt(r.remainingMs))
}
{
  // 工作日 17:00 峰时，18:00 转谷 → 还有 1 小时
  const r = nextSwitch(bj(2026, 10, 28, 17, 0), HOLIDAYS)
  check('峰时 17:00 → 1 小时后转谷', !r.inValley && Math.abs(r.remainingMs - 3600000) < 60000, fmt(r.remainingMs))
}
{
  // 工作日 19:00 谷时，次日 09:00 转峰 → 还有 14 小时
  const r = nextSwitch(bj(2026, 10, 28, 19, 0), HOLIDAYS)
  check('谷时 19:00 → 14 小时后转峰', r.inValley && Math.abs(r.remainingMs - 14 * 3600000) < 60000, fmt(r.remainingMs))
}
{
  // 周五 19:00 谷时 → 下周一 09:00 才转峰 = 周五19点到周一9点 = 62 小时
  const r = nextSwitch(bj(2026, 10, 30, 19, 0), HOLIDAYS)
  check('周五 19:00 → 62 小时后转峰（跨周末）',
    r.inValley && Math.abs(r.remainingMs - 62 * 3600000) < 60000, fmt(r.remainingMs))
}
{
  // 国庆前一天（09-30 周三）19:00 谷 → 因为接下来 10-01~10-07 全假，要到 10-08 09:00 才转峰
  // 从 09-30 19:00 到 10-08 09:00 = 7天14小时 = 182 小时
  const r = nextSwitch(bj(2026, 9, 30, 19, 0), HOLIDAYS)
  check('节前 09-30 19:00 → 182 小时后转峰（跨整段假期）',
    r.inValley && Math.abs(r.remainingMs - 182 * 3600000) < 60000, fmt(r.remainingMs))
}
{
  // 倒计时必须是正的，绝不能返回 0 或负数
  const probes = [
    bj(2026, 10, 28, 0, 0), bj(2026, 10, 28, 9, 0), bj(2026, 10, 28, 23, 59),
    bj(2026, 10, 31, 0, 0), bj(2026, 10, 5, 12, 0),
  ]
  let allPositive = true
  for (const ms of probes) {
    const r = nextSwitch(ms, HOLIDAYS)
    if (!(r.remainingMs > 0)) allPositive = false
  }
  check('各种时刻的倒计时都是正数', allPositive)
}

// ---------------------------------------------------------------- 节假日解析
console.log('\n--- 节假日数据解析 ---')
{
  // holiday-cn 的真实结构：days 里既有放假日也有调休上班日，靠 isOffDay 区分。
  // 实测 2026 年 days 共 39 条 = 33 条放假 + 6 条调休上班。
  const json = {
    year: 2026,
    days: [
      { name: '国庆节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节', date: '2026-10-02', isOffDay: true },
      { name: '元旦', date: '2026-01-01', isOffDay: true },
      // 调休上班日：必须排除
      { name: '国庆调休', date: '2026-10-10', isOffDay: false },
      { name: '元旦调休', date: '2026-01-04', isOffDay: false },
    ],
  }
  const list = parseHolidayJson(json)
  check('解析出 3 个放假日（排除 2 个调休上班日）', list.length === 3, list.join(','))
  check('格式转成 YYYYMMDD', list.includes('20261001'), list[0])
  check('isOffDay=false 的调休上班日被排除',
    !list.includes('20261010') && !list.includes('20260104'),
    '实测抓到的真 bug：早先版本把 6 个调休日当成了节假日')

  const makeup = parseMakeupWorkdays(json)
  check('parseMakeupWorkdays 能取出调休日', makeup.length === 2 && makeup.includes('20261010'), makeup.join(','))
}
{
  // 缺 isOffDay 字段时按"放假"处理（兼容没有该字段的数据源）
  const list = parseHolidayJson({ days: [{ date: '2026-05-01' }] })
  check('缺 isOffDay 字段时按放假处理', list.length === 1, list.join(','))
}
{
  const bad = parseHolidayJson({ days: [{ date: 'not-a-date' }, null, {}] })
  check('脏数据不会炸，返回空数组', Array.isArray(bad) && bad.length === 0)
  check('非对象也不炸', Array.isArray(parseHolidayJson(null)))
}

// 关键：调休上班日落在周六/周日时，仍应按"周末"算谷时（不是按节假日）
{
  const set = new Set(builtinHolidaysFor(2026))  // 不含调休日
  // 2026-10-10 是周六（调休上班）→ 官方口径下仍算周末谷时
  const r = judgePeak(bj(2026, 10, 10, 10, 0), set)
  check('调休上班的周六（10-10）按周末算谷时', r.peak === false && r.reason === 'weekend', r.reason)
  // 2026-09-20 是周日（调休上班）→ 谷时
  const r2 = judgePeak(bj(2026, 9, 20, 10, 0), set)
  check('调休上班的周日（9-20）按周末算谷时', r2.peak === false && r2.reason === 'weekend', r2.reason)
}

// ---------------------------------------------------------------- HolidayStore
console.log('\n--- 节假日缓存 ---')
{
  const store = new HolidayStore({
    path: process.env.TEMP ? `${process.env.TEMP}\\_valley_test_cache.json` : '/tmp/_valley_test_cache.json',
    log: () => {},
  })
  store.years = { 2026: ['20261001', '20261002'] }
  store.fetchedAt = Date.now()
  const set = store.setFor(2026)
  check('setFor 返回 Set', set instanceof Set && set.has('20261001'))
  check('刚抓过的缓存不过期', store.isStale() === false)
  store.fetchedAt = Date.now() - 40 * 24 * 3600 * 1000
  check('40 天后算过期', store.isStale() === true)
  check('setAround 合并相邻年份', store.setAround(bj(2026, 12, 31, 12, 0)).has('20261001'))
}

{
  // 网络失败时不能抛异常。
  // 注意语义变了（v0.5 起）：有了内置节假日作为兜底，
  // 断网时 ok 是 true（"现在有可用数据"），而不是 false。
  // 判断"有没有拉到"应该看 pulled 字段 —— 那才是真正的联网结果。
  const store = new HolidayStore({
    path: process.env.TEMP ? `${process.env.TEMP}\\_valley_test_cache2.json` : '/tmp/_valley_test_cache2.json',
    log: () => {},
    fetchImpl: async () => { throw new Error('网络断了') },
  })
  let threw = false
  let res = null
  try { res = await store.refresh(2026) } catch { threw = true }
  check('网络失败不抛异常', !threw)
  check('网络失败时 pulled 为空（确实没拉到）', res && Array.isArray(res.pulled) && res.pulled.length === 0,
    res && JSON.stringify(res.pulled))
  check('网络失败但有内置兜底，ok 仍为 true', res && res.ok === true, res && res.error)
  check('内置兜底让 setAround 有数据', store.setAround(bj(2026, 10, 5, 12, 0)).has('20261005'))
  // 关键：没有节假日数据的"未收录年份"仍要能工作（降级为只认周末）
  const sunday = judgePeak(bj(2026, 11, 1, 10, 0), new Set())
  check('无节假日数据时周末仍判为谷时', sunday.peak === false, sunday.reason)
}

{
  // 用假的 fetch 验证成功路径，不碰真网络
  const store = new HolidayStore({
    path: process.env.TEMP ? `${process.env.TEMP}\\_valley_test_cache3.json` : '/tmp/_valley_test_cache3.json',
    log: () => {},
    fetchImpl: async (url) => {
      if (url.includes('2026')) {
        return {
          ok: true,
          json: async () => ({ year: 2026, days: [{ date: '2026-10-01' }, { date: '2026-10-02' }] }),
        }
      }
      return { ok: false, json: async () => ({}) }
    },
  })
  const res = await store.refresh(2026)
  check('假 fetch 成功路径可用', res.ok && store.years['2026'].length === 2, JSON.stringify(res.years))
  check('抓取后 fetchedAt 被更新', store.fetchedAt > 0)
}

// ---------------------------------------------------------------- 内置节假日数据
//
// 这一节是"照抄国务院原文"的自检。官方通知：
//   《国务院办公厅关于2026年部分节假日安排的通知》国办发明电〔2025〕7号
//   https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
//
// 之所以要一条条核对：节假日数据写错不会报错，只会让卡片上的
// "距谷时开始"悄悄算错，用户完全看不出来。这种错最难发现。
console.log('\n--- 内置节假日数据（对照国务院原文）---')
{
  const y2026 = builtinHolidaysFor(2026)
  check('2026 共 33 天', y2026.length === 33, `${y2026.length} 天`)

  // 一条一条对原文
  const expect = {
    '元旦 1/1-1/3': ['20260101', '20260102', '20260103'],
    '春节 2/15-2/23（9天）': [
      '20260215', '20260216', '20260217', '20260218', '20260219',
      '20260220', '20260221', '20260222', '20260223',
    ],
    '清明 4/4-4/6': ['20260404', '20260405', '20260406'],
    '劳动节 5/1-5/5': ['20260501', '20260502', '20260503', '20260504', '20260505'],
    '端午 6/19-6/21': ['20260619', '20260620', '20260621'],
    '中秋 9/25-9/27': ['20260925', '20260926', '20260927'],
    '国庆 10/1-10/7': [
      '20261001', '20261002', '20261003', '20261004',
      '20261005', '20261006', '20261007',
    ],
  }
  const set2026 = new Set(y2026)
  for (const [label, days] of Object.entries(expect)) {
    const missing = days.filter(d => !set2026.has(d))
    check(label, missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : `${days.length} 天全在`)
  }

  // 调休上班日不能混进放假日（否则会把谷时算成峰时）
  const makeup = ['20260104', '20260214', '20260228', '20260509', '20260920', '20261010']
  const leaked = makeup.filter(d => set2026.has(d))
  check('调休上班日没有混进放假日', leaked.length === 0, leaked.length ? `混入了 ${leaked.join(',')}` : '正确排除')

  check('没有 2025 的数据（未收录年份返回空数组）', builtinHolidaysFor(2025).length === 0)
  check('内置年份列表含 2026', builtinYears().includes(2026), builtinYears().join(','))
}

// 用内置数据跑一遍关键判断：中秋假期
{
  const set = new Set(builtinHolidaysFor(2026))
  check('中秋 9/26（周六）判谷时且原因是节假日或周末',
    judgePeak(bj(2026, 9, 26, 10, 0), set).peak === false,
    judgePeak(bj(2026, 9, 26, 10, 0), set).reason)
  check('中秋 9/25（周五）10:00 判谷时（节假日优先于时段）',
    judgePeak(bj(2026, 9, 25, 10, 0), set).peak === false,
    judgePeak(bj(2026, 9, 25, 10, 0), set).reason)
  check('中秋后 9/28（周一）10:00 恢复峰时',
    judgePeak(bj(2026, 9, 28, 10, 0), set).peak === true)
  check('春节 2/17（周二）10:00 判谷时',
    judgePeak(bj(2026, 2, 17, 10, 0), set).peak === false,
    judgePeak(bj(2026, 2, 17, 10, 0), set).reason)
  check('春节后 2/24（周二）10:00 恢复峰时',
    judgePeak(bj(2026, 2, 24, 10, 0), set).peak === true)
}

// 内置数据要能充当兜底：store 不联网也应该有 2026 数据
{
  const store = new HolidayStore({
    path: process.env.TEMP ? `${process.env.TEMP}\\_valley_test_cache4.json` : '/tmp/_valley_test_cache4.json',
    log: () => {},
    fetchImpl: async () => { throw new Error('断网') },
  })
  const set = store.setAround(bj(2026, 10, 5, 12, 0))
  check('断网时内置数据仍然生效（国庆有数据）', set.has('20261005'), `${set.size} 天可用`)
  check('断网时春节也有数据', set.has('20260217'))
  const d = store.debug()
  check('debug 里能看到内置版本', !!d.builtinVersion, String(d.builtinVersion))
}

// 内置数据不能被"拉到的"覆盖，反过来也不能
{
  const p = process.env.TEMP ? `${process.env.TEMP}\\_valley_test_cache5.json` : '/tmp/_valley_test_cache5.json'
  const s1 = new HolidayStore({
    path: p, log: () => {},
    fetchImpl: async (url) => url.includes('2026')
      ? { ok: true, json: async () => ({ year: 2026, days: [{ date: '2026-12-25' }] }) }
      : { ok: false, json: async () => ({}) },
  })
  await s1.refresh(2026)
  check('联网拉到的会覆盖内置', s1.years['2026'].length === 1 && s1.years['2026'][0] === '20261225',
    s1.years['2026'].join(','))
  // 重新读盘，确认 "pulledYears" 被持久化，下次不会又被内置顶回去
  const s2 = new HolidayStore({ path: p, log: () => {}, fetchImpl: async () => { throw new Error('x') } })
  check('重新读盘后仍是拉到的数据（没被内置覆盖）',
    s2.years['2026'].length === 1 && s2.years['2026'][0] === '20261225', s2.years['2026'].join(','))
  check('pulledYears 被持久化', s2.debug().pulledYears.includes(2026), JSON.stringify(s2.debug().pulledYears))
}

// ---------------------------------------------------------------- 规则快照
console.log('\n--- 规则内容 ---')
check('高峰时段是 9-12 和 14-18', JSON.stringify(PEAK_RULES.windows) === '[[540,720],[840,1080]]',
  JSON.stringify(PEAK_RULES.windows))

// ---------------------------------------------------------------- 汇总
console.log('')
console.log('='.repeat(58))
const passed = results.filter(r => r.pass).length
const failed = results.length - passed
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) console.log('全部通过 ✅')
else console.log('有失败项 ❌')
console.log('='.repeat(58))
process.exitCode = failed === 0 ? 0 : 1
