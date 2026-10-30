/**
 * test/fetch-holidays.mjs -- 实测能不能真的从网上拉到节假日
 *
 * 这个要联网，所以单独一个脚本，不放进回归测试里。
 * 跑不通不算 bug（可能是网络环境问题），但要知道实际情况。
 *
 * 跑法：node test/fetch-holidays.mjs
 */

import { HolidayStore, judgePeak, nextSwitch, beijingDateKey } from '../lib/valley.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, rmSync } from 'node:fs'

const cachePath = join(homedir(), '.dsh', 'desktop-card', 'holidays.json')
const tmpPath = cachePath + '.probe'
if (existsSync(tmpPath)) rmSync(tmpPath)

const log = (m, e) => console.log(`    [log] ${m}${e ? ' ' + JSON.stringify(e) : ''}`)

console.log('='.repeat(58))
console.log('节假日数据拉取实测')
console.log('='.repeat(58))
console.log(`缓存路径: ${tmpPath}`)

const store = new HolidayStore({ path: tmpPath, log })
const year = new Date().getFullYear()
console.log(`目标年份: ${year} 和 ${year + 1}`)
console.log('')

const t0 = Date.now()
const r = await store.refresh(year)
const ms = Date.now() - t0

console.log('')
console.log(`结果: ok=${r.ok}  耗时=${ms}ms`)
console.log(`拿到的年份: ${r.years.join(',') || '(无)'}`)
if (r.error) console.log(`最后一个错误: ${r.error}`)
console.log('')
console.log('缓存概况:')
console.log('  ' + JSON.stringify(store.debug()))

if (r.ok) {
  const now = Date.now()
  const set = store.setAround(now)
  const today = beijingDateKey(now)
  const j = judgePeak(now, set)
  const n = nextSwitch(now, set)
  console.log('')
  console.log('现在这一刻的判断:')
  console.log(`  北京日期: ${today}`)
  console.log(`  当前: ${j.peak ? '高峰时段' : '低谷时段'}（原因: ${j.reason}）`)
  const h = Math.floor(n.remainingMs / 3600000)
  const m = Math.floor((n.remainingMs % 3600000) / 60000)
  console.log(`  距下次切换: ${h}小时${m}分`)

  // 看看今年具体记了哪些节假日
  const thisYear = store.years[String(year)] || []
  if (thisYear.length > 0) {
    console.log(`  ${year} 年收录 ${thisYear.length} 个放假日:`)
    console.log('    ' + thisYear.join(' '))
  }
}

// 清掉探针文件，不污染真实缓存
try { if (existsSync(tmpPath)) rmSync(tmpPath) } catch { /* ignore */ }
console.log('')
console.log('='.repeat(58))
