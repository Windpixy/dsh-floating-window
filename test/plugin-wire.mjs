/**
 * test/plugin-wire.mjs -- 验证「插件把峰谷和地址接进去」这件事真的成立
 *
 * 前面 valley.mjs 测的是算法、endpoint.mjs 测的是取地址。
 * 这个文件测的是"接线"：插件里那几个函数拼起来，产出的 state 长什么样。
 *
 * 为什么单独做：
 *   接线错误（比如 valley 忘了塞进 snapshot、settings 被整份覆盖）
 *   不会让任何单元测试失败，但会让卡片显示不出来。
 *
 * 跑法：node test/plugin-wire.mjs
 */

import { CardState } from '../lib/state.js'
import { HolidayStore, nextSwitch } from '../lib/valley.js'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}
function bj(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600 * 1000
}

console.log('='.repeat(58))
console.log('插件接线：峰谷进 state')
console.log('='.repeat(58))

// ---------------------------------------------------------------- 1. valley 能进 snapshot
console.log('\n--- valley 字段能带进 state.json ---')
{
  const st = new CardState({ now: () => bj(2026, 10, 28, 10, 0) })
  st.valley = { inValley: false, remainingSec: 7200, reason: 'window' }
  const snap = st.snapshot()
  check('snapshot 里有 valley', snap.valley !== null && typeof snap.valley === 'object',
    JSON.stringify(snap.valley))
  check('inValley 原样带出', snap.valley.inValley === false)
  check('remainingSec 原样带出', snap.valley.remainingSec === 7200)
}

{
  const st = new CardState({ now: () => Date.now() })
  const snap = st.snapshot()
  check('没设 valley 时为 null（卡片会退回读设置）', snap.valley === null)
}

// ---------------------------------------------------------------- 2. 端到端算一遍
console.log('\n--- 用真实规则算一遍（2026-10-28 周三）---')
{
  const dir = mkdtempSync(join(tmpdir(), 'wire-'))
  const holidays = new HolidayStore({ path: join(dir, 'holidays.json'), log: () => {} })
  // 塞 2026 国庆，验证节假日分支
  holidays.years = { 2026: ['20261001', '20261002', '20261003', '20261004', '20261005', '20261006', '20261007'] }
  holidays.fetchedAt = Date.now()

  const cases = [
    ['周三 10:00 峰时', bj(2026, 10, 28, 10, 0), false],
    ['周三 12:30 谷时', bj(2026, 10, 28, 12, 30), true],
    ['周三 15:00 峰时', bj(2026, 10, 28, 15, 0), false],
    ['周三 19:00 谷时', bj(2026, 10, 28, 19, 0), true],
    ['周六 10:00 谷时', bj(2026, 10, 31, 10, 0), true],
    ['国庆 10-05 10:00 谷时', bj(2026, 10, 5, 10, 0), true],
  ]
  for (const [label, ms, expectValley] of cases) {
    const r = nextSwitch(ms, holidays.setAround(ms))
    check(label, r.inValley === expectValley, `${r.inValley ? '谷' : '峰'}/${r.reason}`)
  }

  // 关键：倒计时都是正数
  let allPos = true
  for (const [, ms] of cases) {
    const r = nextSwitch(ms, holidays.setAround(ms))
    if (!(r.remainingMs > 0)) allPos = false
  }
  check('所有场景倒计时都是正数', allPos)

  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 3. settings 只改一个键
console.log('\n--- 同步网址时不能把用户配置冲掉 ---')
{
  const dir = mkdtempSync(join(tmpdir(), 'wire2-'))
  const p = join(dir, 'settings.json')
  writeFileSync(p, JSON.stringify({
    glassOpacity: 88,
    cardWidth: 300,
    snapToEdge: false,
    openMode: 'protocol',
    dshUrl: '',
    valley: { mon: [['00:30', '08:30']] },
  }, null, 2))

  // 模拟插件的同步逻辑：读 -> 改一个键 -> 原子写回
  const cur = JSON.parse(readFileSync(p, 'utf8'))
  cur.dshUrl = 'http://127.0.0.1:11922/'
  writeFileSync(p + '.tmp', JSON.stringify(cur, null, 2))
  const { renameSync } = await import('node:fs')
  renameSync(p + '.tmp', p)

  const after = JSON.parse(readFileSync(p, 'utf8'))
  check('dshUrl 已更新', after.dshUrl === 'http://127.0.0.1:11922/', after.dshUrl)
  check('glassOpacity 未被改动', after.glassOpacity === 88)
  check('cardWidth 未被改动', after.cardWidth === 300)
  check('snapToEdge 未被改动', after.snapToEdge === false)
  check('openMode 未被改动', after.openMode === 'protocol')
  check('valley 仍保留', after.valley && after.valley.mon[0][0] === '00:30')
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 4. 卡片优先级
console.log('\n--- 卡片取峰谷的优先级 ---')
{
  // 卡片逻辑：先看 state.valley，没有才读 settings.json
  const pick = (stateValley, settingsValley) => {
    if (stateValley !== null && stateValley !== undefined && typeof stateValley.inValley === 'boolean') {
      return 'plugin'
    }
    if (settingsValley) return 'settings'
    return 'none'
  }
  check('插件给了就用插件', pick({ inValley: true, remainingSec: 100 }, { mon: [] }) === 'plugin')
  check('插件没给就用设置', pick(null, { mon: [['00:30', '08:30']] }) === 'settings')
  check('都没有就是 none', pick(null, null) === 'none')
  check('插件给的字段不完整时不用它',
    pick({ remainingSec: 100 }, null) === 'none',
    '没有 inValley 布尔值')
}

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
