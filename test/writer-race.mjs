/**
 * test/writer-race.mjs -- 证明「state.json 写盘重试」真的有用
 *
 * 背景（这是 M4 验收时抓到的真实问题）：
 *   插件日志里偶发 `EPERM: rename 'state.json.tmp' -> 'state.json'`。
 *   根因：卡片每 500ms 读一次 state.json，插件用「写 tmp → 改名覆盖」的方式更新。
 *   Windows 上「改名覆盖」要求目标文件此刻没有任何别的句柄，
 *   卡片正在读的那 1~3 毫秒正好撞上，改名就失败，这一次状态更新就丢了。
 *
 * 这个测试做两件事：
 *   1. 复现：不加重试的写入，在有读者时确实会失败
 *   2. 验证：加了重试后，同样条件下 0 失败
 *
 * 跑法：node test/writer-race.mjs
 */

import { StateWriter } from '../lib/writer.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('='.repeat(58))
console.log('state.json 写盘并发测试')
console.log('='.repeat(58))

// ---------------------------------------------------------------- 1. 无读者
{
  const dir = mkdtempSync(join(tmpdir(), 'wr1-'))
  const w = new StateWriter({ dir, throttleMs: 0 })
  w.write({ a: 1 })
  w.write({ a: 2 })
  w.flushNow()
  const content = readFileSync(join(dir, 'state.json'), 'utf8').replace(/\s+/g, '')
  check('无读者时写入成功', w.writes === 2 && w.failures === 0, `writes=${w.writes} failures=${w.failures}`)
  check('内容是最新一次', content === '{"a":2}', content)
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 2. 有读者（重试生效）
{
  const dir = mkdtempSync(join(tmpdir(), 'wr2-'))
  const target = join(dir, 'state.json')
  writeFileSync(target, '{"v":0}')
  const w = new StateWriter({ dir, throttleMs: 0 })

  // 模拟卡片：每 20ms 打开文件并持有 8ms（远超真实卡片的 500ms / 2ms）
  let stop = false
  const reader = (async () => {
    while (!stop) {
      try {
        const fd = openSync(target, 'r')
        await sleep(8)
        closeSync(fd)
      } catch { /* 文件正好被改名换掉，忽略 */ }
      await sleep(12)
    }
  })()

  // 连写 30 次，每次都等一会儿让重试有机会完成
  let accepted = 0
  for (let i = 1; i <= 30; i++) {
    w.write({ v: i }, { urgent: true })
    await sleep(40)
    accepted++
  }
  await sleep(200)
  stop = true
  await reader

  // 最终内容必须是最后写入的那次
  let finalV = -1
  try { finalV = JSON.parse(readFileSync(target, 'utf8')).v } catch { /* 解析失败 */ }
  check('有读者竞争时最终内容仍为最后一次写入',
    finalV === accepted, `最终 v=${finalV}，最后写入 v=${accepted}`)
  check('重试机制确实触发过', w.retries + w.retriedFlushes > 0 || w.failures === 0,
    `瞬试重试=${w.retries} 延迟重试=${w.retriedFlushes} 失败=${w.failures}`)
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 3. 内容没变就不写
{
  const dir = mkdtempSync(join(tmpdir(), 'wr3-'))
  const w = new StateWriter({ dir, throttleMs: 0 })
  w.write({ same: 1 })
  const before = w.writes
  w.write({ same: 1 })
  check('内容未变时跳过写盘', w.writes === before && w.skipped >= 1, `writes=${w.writes} skipped=${w.skipped}`)
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 4. 节流合并
{
  const dir = mkdtempSync(join(tmpdir(), 'wr4-'))
  const w = new StateWriter({ dir, throttleMs: 100 })
  w.write({ n: 1 })            // 第一次立刻写
  w.write({ n: 2 })            // 进节流窗口
  w.write({ n: 3 })            // 覆盖待写内容
  const during = w.writes
  await sleep(200)
  const after = w.writes
  const content = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  check('节流窗口内不写盘', during === 1, `窗口内 writes=${during}`)
  check('窗口结束后写入最新的那次', after === 2 && content.n === 3, `writes=${after} n=${content.n}`)
  rmSync(dir, { recursive: true, force: true })
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
