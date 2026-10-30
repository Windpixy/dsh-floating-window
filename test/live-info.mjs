/**
 * test/live-info.mjs -- 看真实运行环境里的实际情况
 *
 * 只读，不改任何东西。用来回答：
 *   · DSH 现在实际在哪个端口
 *   · 卡片上的 settings.json 里 dshUrl 是什么
 *   · 峰谷现在算出来是什么
 *   · 节假日用了哪份数据
 *
 * 跑法：node test/live-info.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HolidayStore, judgePeak, nextSwitch, beijingDateKey, beijingWeekday } from '../lib/valley.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA = join(DSH_HOME, 'desktop-card')

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function fmtDur(ms) {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}小时`
  if (h > 0) return `${h}小时${m}分`
  return `${m}分`
}

console.log('='.repeat(60))
console.log('真实环境现状')
console.log('='.repeat(60))

// ---------------------------------------------------------------- state.json
const state = readJson(join(DATA, 'state.json'))
console.log('\n--- state.json ---')
if (!state) {
  console.log('  读不到（插件没在跑？）')
} else {
  console.log(`  写入时间: ${new Date(state.updatedAt * 1000).toLocaleString('zh-CN')}`)
  console.log(`  运行中: ${state.tasks?.running ?? '?'} 个任务`)
  console.log(`  待审批: ${state.approval?.pending ?? '?'} 项`)
  console.log(`  今日 Token: ${(state.tokens?.today ?? 0).toLocaleString()}`)
  console.log(`  valley 字段: ${state.valley ? JSON.stringify(state.valley) : '(没有 — 说明还是老版插件)'}`)
}

// ---------------------------------------------------------------- settings.json
const st = readJson(join(DATA, 'settings.json'))
console.log('\n--- 卡片 settings.json ---')
if (!st) {
  console.log('  读不到')
} else {
  console.log(`  openMode: ${JSON.stringify(st.openMode ?? '(没设，默认 protocol)')}`)
  console.log(`  dshUrl  : ${JSON.stringify(st.dshUrl ?? '')}`)
  if (st.dshUrl && /2278/.test(st.dshUrl)) {
    console.log('            ^^ 这是老默认值，插件跑起来后会被同步成真实地址')
  }
}

// ---------------------------------------------------------------- 峰谷
console.log('\n--- 峰谷（用当前时间和内置/缓存节假日算）---')
const store = new HolidayStore({ path: join(DATA, 'holidays.json'), log: () => {} })
const now = Date.now()
const set = store.setAround(now)
const j = judgePeak(now, set)
const n = nextSwitch(now, set)
const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][beijingWeekday(now)]
console.log(`  北京日期: ${beijingDateKey(now)}（${wd}）`)
console.log(`  现在: ${j.peak ? '高峰时段' : '低谷时段'}（原因: ${j.reason}）`)
console.log(`  距下次切换: ${fmtDur(n.remainingMs)}`)
console.log(`  可用节假日期数: ${set.size}`)
console.log(`  数据来源: ${JSON.stringify(store.debug())}`)

// ---------------------------------------------------------------- 逻辑自检
console.log('\n--- 逻辑自检（几个关键时间点）---')
function bj(y, mo, d, h, mi) { return Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600 * 1000 }
const probes = [
  ['今天上午 10:00', bj(2026, 10, 28, 10, 0)],
  ['今天中午 12:30', bj(2026, 10, 28, 12, 30)],
  ['今天下午 15:00', bj(2026, 10, 28, 15, 0)],
  ['今晚 19:00', bj(2026, 10, 28, 19, 0)],
  ['周六上午 10:00', bj(2026, 10, 31, 10, 0)],
  ['国庆 10-05 10:00', bj(2026, 10, 5, 10, 0)],
]
for (const [label, ms] of probes) {
  const s = store.setAround(ms)
  const jj = judgePeak(ms, s)
  const nn = nextSwitch(ms, s)
  console.log(`  ${label.padEnd(18, ' ')} => ${jj.peak ? '峰时' : '谷时'}（${jj.reason}），还有 ${fmtDur(nn.remainingMs)}`)
}

console.log('\n' + '='.repeat(60))
