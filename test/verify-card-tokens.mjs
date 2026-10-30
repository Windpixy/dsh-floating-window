/**
 * test/verify-card-tokens.mjs -- 核对「卡片上那个 Token 数字」对不对
 *
 * 和 verify-tokens.mjs 的区别：
 *   verify-tokens.mjs  把我们的算法整体和官方账本比（证明算法正确）。
 *   这个脚本           **按 state.json 自己的时间戳**截止计算，
 *                      再去和卡片显示的数字比（证明插件把数字写对了）。
 *
 * 为什么要单独做：
 *   卡片显示的是「今天累计」。而账本、会话文件都还在继续增长。
 *   直接拿"现在的账本"比"几秒前写下的卡片数字"必然有差，且差额大小无意义。
 *   唯一公平的比较是：把会话文件也截止到 state.json 的那一秒。
 *
 * 还有一个坑：**日志落盘有延迟**。
 *   DSH 写会话文件不是瞬时完成的，state.json 写下时，最近那一两条
 *   assistant/message 可能还没落到 .zstd 里。
 *   实测：立刻算会差 0.52%（正好是一两条大事件的量），
 *         等 12 秒后再按**同一个截止时间**重算 → 差额 0。
 *   所以这个脚本先算一次，若超差就等一会儿**用同一截止时间**再算一次。
 *   绝不能"重取一个新的 state.json 时间"再比，那是拿新数字比旧数字，掩盖问题。
 *
 * 跑法：node test/verify-card-tokens.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { usageAmount } from '../lib/sources.js'
import { startOfToday } from '../lib/tokens.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const LEDGER = join(DSH_HOME, '.dsh-usage-ledger.json')
const STATE = join(homedir(), '.dsh', 'desktop-card', 'state.json')

/** 按 magic 切 zstd 帧 —— 单帧解压只能拿到第一条事件（M0 实测过这个坑） */
function splitFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames = []
  let s = buf.indexOf(MAGIC, 0)
  while (s !== -1) {
    const n = buf.indexOf(MAGIC, s + 4)
    frames.push(buf.subarray(s, n === -1 ? buf.length : n))
    s = n
  }
  return frames
}

function decodeSession(path) {
  const chunks = []
  for (const f of splitFrames(readFileSync(path))) {
    try { chunks.push(zstdDecompressSync(f)) } catch { /* 坏帧跳过 */ }
  }
  const evs = []
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { evs.push(JSON.parse(t)) } catch { /* 坏行跳过 */ }
  }
  return evs
}

function listFiles() {
  const out = []
  if (!existsSync(SESSIONS_ROOT)) return out
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    const wp = join(SESSIONS_ROOT, ws)
    try { if (!statSync(wp).isDirectory()) continue } catch { continue }
    let ids = []
    try { ids = readdirSync(wp) } catch { continue }
    for (const sid of ids) {
      const sp = join(wp, sid)
      try { if (!statSync(sp).isDirectory()) continue } catch { continue }
      let fs2 = []
      try { fs2 = readdirSync(sp) } catch { continue }
      for (const f of fs2) if (f.endsWith('.zstd')) out.push({ sid, path: join(sp, f) })
    }
  }
  return out
}

if (!existsSync(STATE)) {
  console.log(`找不到 ${STATE}，插件还没写过状态？`)
  process.exit(1)
}

const st = JSON.parse(readFileSync(STATE, 'utf8'))
const cutoff = st.updatedAt * 1000
const cardValue = st.tokens.today
const dayStartMs = startOfToday(cutoff)

const files = listFiles()

/** 按「同一个截止时间」统计今天累计 */
function recount() {
  let total = 0
  let n = 0
  const per = new Map()
  for (const f of files) {
    let evs = []
    try { evs = decodeSession(f.path) } catch { continue }
    for (const ev of evs) {
      if (!ev || ev.type !== 'assistant/message') continue
      const u = ev.data && ev.data.usage
      if (!u) continue
      const t = Number(ev.time)
      if (!Number.isFinite(t) || t < dayStartMs || t > cutoff) continue
      const a = usageAmount(u)
      total += a
      n++
      per.set(f.sid, (per.get(f.sid) || 0) + a)
    }
  }
  return { total, n, per }
}

let r = recount()
let total = r.total
let n = r.n
const per = r.per

const pctOf = (card, sum) => (sum === 0 ? 0 : ((card - sum) / sum) * 100)

console.log('='.repeat(64))
console.log('卡片 Token 数字核对')
console.log('='.repeat(64))
console.log(`state.json 时间 : ${new Date(cutoff).toLocaleString('zh-CN')}`)
console.log(`卡片显示       : ${cardValue.toLocaleString()}`)
console.log(`会话文件算出   : ${total.toLocaleString()}   事件 ${n} 条`)
let diff = cardValue - total
let pct = pctOf(cardValue, total)
console.log(`差额           : ${diff.toLocaleString()}  (${pct.toFixed(4)}%)`)

// 日志落盘有延迟：差得不多就先等一会儿，用**同一个截止时间**重算
let waited = 0
if (Math.abs(pct) >= 0.5) {
  console.log('')
  console.log('超出合格线，先判断是不是"日志还没落盘"（截止时间不变，只等文件写完）')
  for (const w of [4000, 8000, 8000]) {
    await new Promise(res => setTimeout(res, w))
    waited += w
    r = recount()
    total = r.total
    n = r.n
    diff = cardValue - total
    pct = pctOf(cardValue, total)
    console.log(`  等 ${waited / 1000}s 后重算: ${total.toLocaleString()}   差额 ${diff.toLocaleString()} (${pct.toFixed(4)}%)`)
    if (Math.abs(pct) < 0.5) break
  }
}

const ok = Math.abs(pct) < 0.5
console.log(`判定           : ${ok ? '✅ 一致' : '❌ 不一致'}${waited > 0 ? `（等待落盘 ${waited}ms 后）` : '（无需等待）'}`)

try {
  const lg = JSON.parse(readFileSync(LEDGER, 'utf8'))
  const d0 = new Date(cutoff)
  const p = x => String(x).padStart(2, '0')
  const key = `${d0.getFullYear()}-${p(d0.getMonth() + 1)}-${p(d0.getDate())}`
  let li = 0
  let lo = 0
  let lc = 0
  for (const s of lg.sessions || []) {
    const d = s.fold && s.fold.byDay && s.fold.byDay[key]
    if (!d) continue
    li += d.input || 0
    lo += d.output || 0
    lc += d.calls || 0
  }
  const lagSec = ((cutoff - lg.updatedAt) / 1000).toFixed(0)
  console.log('')
  console.log(`官方账本 [${key}] : input+output = ${(li + lo).toLocaleString()}  calls=${lc}`)
  console.log(`账本记录时间     : ${new Date(lg.updatedAt).toLocaleString('zh-CN')}（比卡片时间早 ${lagSec} 秒）`)
  console.log(`卡片 vs 账本差额 : ${(cardValue - (li + lo)).toLocaleString()}  <- 卡片更新，所以偏大是正常的`)
  console.log('  公平对比请用上面的「会话文件算出」一行。')
} catch (e) {
  console.log('读账本失败: ' + e.message)
}
console.log('='.repeat(64))
process.exitCode = ok ? 0 : 1
