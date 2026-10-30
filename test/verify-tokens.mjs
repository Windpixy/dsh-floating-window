/**
 * test/verify-tokens.mjs -- 用真实会话文件验证 Token 算法
 *
 * 为什么需要这一步：
 *   M2 的 Token 数字必须和官方账本对得上，否则卡片显示的数字就是错的。
 *   但插件里跑的代码要重启 DSH 才生效，往返太慢。
 *   所以这个脚本**完全脱离 DSH**，直接读磁盘上的会话文件，
 *   用和插件一模一样的算法（usageAmount / 按天过滤），
 *   再和官方账本 .dsh-usage-stats.json 对比。
 *
 * 算法一致 = 插件跑起来的结果也可信。
 *
 * 跑法：node test/verify-tokens.mjs [--day YYYY-MM-DD] [--verbose]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { usageAmount } from '../lib/sources.js'
import { startOfToday } from '../lib/tokens.js'

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const dayArgIdx = argv.indexOf('--day')
const DAY = dayArgIdx >= 0 ? argv[dayArgIdx + 1] : null

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const LEDGER = join(DSH_HOME, '.dsh-usage-stats.json')

/** 按 magic 切 zstd 帧 —— 单帧解压只能拿到第一条事件（M0 实测过这个坑） */
function splitFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames = []
  let start = buf.indexOf(MAGIC, 0)
  while (start !== -1) {
    const next = buf.indexOf(MAGIC, start + 4)
    frames.push(buf.subarray(start, next === -1 ? buf.length : next))
    start = next
  }
  return frames
}

function decodeSession(path) {
  const raw = readFileSync(path)
  const frames = splitFrames(raw)
  const chunks = []
  let badFrames = 0
  for (const f of frames) {
    try { chunks.push(zstdDecompressSync(f)) } catch { badFrames++ }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { events.push(JSON.parse(s)) } catch { /* 跳过坏行 */ }
  }
  return { events, frames: frames.length, badFrames }
}

// ================================================================ 遍历所有会话

function listSessionFiles() {
  const out = []
  if (!existsSync(SESSIONS_ROOT)) return out
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    const wsPath = join(SESSIONS_ROOT, ws)
    let isDir = false
    try { isDir = statSync(wsPath).isDirectory() } catch { continue }
    if (!isDir) continue
    let entries = []
    try { entries = readdirSync(wsPath) } catch { continue }
    for (const sid of entries) {
      const sidPath = join(wsPath, sid)
      let isSessionDir = false
      try { isSessionDir = statSync(sidPath).isDirectory() } catch { continue }
      if (!isSessionDir) continue
      let files = []
      try { files = readdirSync(sidPath) } catch { continue }
      for (const f of files) {
        if (f.endsWith('.zstd')) {
          out.push({ workspace: ws, sessionId: sid, path: join(sidPath, f) })
        }
      }
    }
  }
  return out
}

// ================================================================ 主流程

const now = DAY ? new Date(DAY + 'T12:00:00+08:00').getTime() : Date.now()
const dayStartMs = startOfToday(now)
const dayKey = (() => {
  const d = new Date(dayStartMs)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

console.log('='.repeat(60))
console.log('Token 算法验证（真实会话文件 vs 官方账本）')
console.log('='.repeat(60))
console.log(`统计日期: ${dayKey}  (起点 ${new Date(dayStartMs).toISOString()})`)
console.log(`会话目录: ${SESSIONS_ROOT}`)

const files = listSessionFiles()
console.log(`发现会话文件: ${files.length} 个\n`)

let totalInputOutput = 0
let totalWithCacheRead = 0
let usageEvents = 0
let eventsScanned = 0
let badFrames = 0
let failed = 0
const perSession = []

const t0 = Date.now()
for (const f of files) {
  let decoded
  try {
    decoded = decodeSession(f.path)
  } catch (e) {
    failed++
    if (verbose) console.log(`  读取失败 ${f.sessionId}: ${e.message}`)
    continue
  }
  badFrames += decoded.badFrames
  eventsScanned += decoded.events.length

  let sum = 0
  let sumCacheRead = 0
  let n = 0
  for (const ev of decoded.events) {
    if (!ev || ev.type !== 'assistant/message') continue
    const u = ev.data && ev.data.usage
    if (!u) continue
    const t = Number(ev.time)
    if (!Number.isFinite(t) || t < dayStartMs) continue
    sum += usageAmount(u)               // 插件用的就是这个函数
    sumCacheRead += Number(u.totalTokens) || 0
    n++
  }
  if (n > 0) {
    totalInputOutput += sum
    totalWithCacheRead += sumCacheRead
    usageEvents += n
    perSession.push({ sessionId: f.sessionId, workspace: f.workspace, amount: sum, events: n })
  }
}
const ms = Date.now() - t0

perSession.sort((a, b) => b.amount - a.amount)

console.log(`扫描耗时: ${ms}ms   事件总数: ${eventsScanned.toLocaleString()}   坏帧: ${badFrames}   读取失败: ${failed}`)
console.log(`今日 usage 事件: ${usageEvents.toLocaleString()}\n`)

console.log('--- 按会话（前 10，按用量降序）---')
for (const p of perSession.slice(0, 10)) {
  console.log(`  ${p.sessionId.slice(0, 24).padEnd(26)} ${String(p.events).padStart(5)} 条  ${p.amount.toLocaleString().padStart(14)}`)
}

console.log('\n--- 我们的算法结果 ---')
console.log(`  input + output 合计 : ${totalInputOutput.toLocaleString()}`)
console.log(`  (参考) totalTokens  : ${totalWithCacheRead.toLocaleString()}   <- 含 cacheRead，会虚高`)

// ---------------------------------------------------------------- 对比官方账本
console.log('\n--- 官方账本对比 ---')
if (!existsSync(LEDGER)) {
  console.log('  账本文件不存在，跳过对比')
} else {
  try {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'))
    const day = ledger.byDay && ledger.byDay[dayKey]
    if (!day) {
      console.log(`  账本里没有 ${dayKey} 的记录`)
      console.log(`  有这些日期: ${Object.keys(ledger.byDay || {}).join(', ')}`)
    } else {
      const ledgerSum = (day.input || 0) + (day.output || 0)
      console.log(`  账本 input        : ${(day.input || 0).toLocaleString()}`)
      console.log(`  账本 output       : ${(day.output || 0).toLocaleString()}`)
      console.log(`  账本 input+output : ${ledgerSum.toLocaleString()}`)
      console.log(`  账本 calls        : ${(day.calls || 0).toLocaleString()}`)
      console.log(`  账本记录时间      : ${new Date(ledger.updatedAt).toLocaleString('zh-CN')}`)

      const diff = ledgerSum - totalInputOutput
      const pct = ledgerSum === 0 ? 0 : (diff / ledgerSum) * 100
      console.log(`\n  【口径 A】拿我们"现在"的总数比账本"当时"的数`)
      console.log(`  我们: ${totalInputOutput.toLocaleString()}`)
      console.log(`  差额 = ${diff.toLocaleString()}  (${pct.toFixed(4)}%)`)
      console.log(`  ${Math.abs(pct) < 0.5 ? '✅' : '⚠️'} 这个比较本身不公平：账本之后我们又用了 Token`)

      // ---- 公平比较：把统计截止时间对齐到账本的记录时刻
      const ledgerAt = Number(ledger.updatedAt)
      if (Number.isFinite(ledgerAt) && ledgerAt > dayStartMs) {
        let sumAtLedgerTime = 0
        let callsAtLedgerTime = 0
        for (const f of files) {
          let decoded
          try { decoded = decodeSession(f.path) } catch { continue }
          for (const ev of decoded.events) {
            if (!ev || ev.type !== 'assistant/message') continue
            const u = ev.data && ev.data.usage
            if (!u) continue
            const t = Number(ev.time)
            if (!Number.isFinite(t) || t < dayStartMs || t > ledgerAt) continue
            sumAtLedgerTime += usageAmount(u)
            callsAtLedgerTime++
          }
        }
        const d2 = ledgerSum - sumAtLedgerTime
        const p2 = ledgerSum === 0 ? 0 : (d2 / ledgerSum) * 100
        console.log(`\n  【口径 B】把我们的统计截止到账本记录时刻（公平比较）`)
        console.log(`  截止 ${new Date(ledgerAt).toLocaleString('zh-CN')}`)
        console.log(`  我们: ${sumAtLedgerTime.toLocaleString()}   事件 ${callsAtLedgerTime} 条`)
        console.log(`  账本: ${ledgerSum.toLocaleString()}   调用 ${(day.calls || 0).toLocaleString()} 次`)
        console.log(`  差额 = ${d2.toLocaleString()}  (${p2.toFixed(4)}%)`)
        const ok = Math.abs(p2) < 0.5
        console.log(`  判定: ${ok ? '✅ 通过（<0.5%）' : '❌ 超差，需排查'}`)
        process.exitCode = ok ? 0 : 1
      } else {
        process.exitCode = Math.abs(pct) < 0.5 ? 0 : 1
      }
    }
  } catch (e) {
    console.log('  读账本失败: ' + e.message)
  }
}

console.log('\n' + '='.repeat(60))
