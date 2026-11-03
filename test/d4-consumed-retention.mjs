/**
 * test/d4-consumed-retention.mjs -- D4：.consumed 归档保留策略的**真实行为**验证
 *
 * 【为什么不用 d4-log-retention.mjs 里的源码检查就够了】
 *   那个只确认"+15 天常量存在 / endsWith 判断存在"。
 *   但真正会出事的不是"有没有写"，而是"删错东西"：
 *     ① 把还在等待处理的 .json 删了 → 用户点了审批，卡片毫无反应
 *     ② 把卡片正在写的 .json.tmp 删了 → 决定丢失，审批卡住
 *     ③ 把刚归档 1 小时的 .consumed 删了 → 用户想查"我刚才点的那条"查不到
 *     ④ 把别的程序的 log 删了 → 别人正在查的问题线索没了
 *   这四类错误，静态检查全都看不出来。必须真的建文件、真的跑一遍、看剩下什么。
 *
 * 跑法：node test/d4-consumed-retention.mjs
 * 退出码 0 = 全通过，1 = 有失败。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ApprovalProxy } from '../lib/approval-proxy.js'

let pass = 0
let fail = 0
const bad = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  (${detail})` : ''}`)
  } else {
    fail++
    bad.push(name)
    console.log(`  ❌ ${name}${detail ? `  (${detail})` : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dshd4c-'))
const DAY = 24 * 60 * 60 * 1000
const nowMs = Date.now()

/**
 * 造一个最小可用的 ApprovalProxy。
 * 【为什么这么造】真构造函数要求 ctx / state / onChange 等一堆依赖。
 *   _sweepConsumed 只用得到 decisionsDir、log、_now，
 *   其余的传最小桩就够 —— 这样测的是**真方法**，不是复刻逻辑。
 */
function makeProxy(dir, logs = []) {
  const p = Object.create(ApprovalProxy.prototype)
  p.decisionsDir = dir
  p.log = (msg) => { logs.push(String(msg)) }
  p._now = () => nowMs
  return p
}

const setAge = (path, days) => {
  const t = (nowMs - days * DAY) / 1000
  utimesSync(path, t, t)
}

try {
  // ================================================================
  // 1. 过期的 .consumed 被删
  // ================================================================
  console.log('\n=== 1. 过期的 .consumed 被删 ===')
  {
    const dir = join(root, 'c1')
    mkdirSync(dir, { recursive: true })

    const fresh = join(dir, 'aaa.consumed')
    const edge = join(dir, 'bbb.consumed')
    const expired = join(dir, 'ccc.consumed')
    const ancient = join(dir, 'ddd.consumed')
    for (const p of [fresh, edge, expired, ancient]) writeFileSync(p, '{"ok":1}')

    setAge(fresh, 1)      // 1 天前 → 留
    setAge(edge, 14)      // 14 天前 → 留（还没到 15 天）
    setAge(expired, 16)   // 16 天前 → 删
    setAge(ancient, 90)   // 90 天前 → 删

    const logs = []
    makeProxy(dir, logs)._sweepConsumed()

    ok('1 天前的留着', existsSync(fresh))
    ok('14 天前的留着（边界内）', existsSync(edge))
    ok('【关键】16 天前的被删（超过 15 天）', !existsSync(expired))
    ok('90 天前的被删', !existsSync(ancient))

    ok('删除动作记了一条日志', logs.length >= 1, logs[0] || '没有日志')
    const joined = logs.join(' ')
    ok('日志里写明了删了几个', /删除\s*\d+\s*个/.test(joined), joined)
    ok('日志里写明了保留天数', /15\s*天/.test(joined), joined)
  }

  // ================================================================
  // 2. 【最关键】绝不碰 .json / .json.tmp / 其他文件
  // ================================================================
  console.log('\n=== 2. 绝不误伤正在处理的决定文件 ===')
  {
    const dir = join(root, 'c2')
    mkdirSync(dir, { recursive: true })

    // 这些全部设成 90 天前：如果后缀判断写错，它们就会被删
    const pending = join(dir, 'pending-approval.json')
    const tmpFile = join(dir, 'writing.json.tmp')
    const otherLog = join(dir, 'someone-else.log')
    const noExt = join(dir, 'README')
    const consumedOld = join(dir, 'old.consumed')

    for (const p of [pending, tmpFile, otherLog, noExt, consumedOld]) writeFileSync(p, 'x')
    for (const p of [pending, tmpFile, otherLog, noExt, consumedOld]) setAge(p, 90)

    makeProxy(dir)._sweepConsumed()

    ok('【关键】还在等待处理的 .json 没被删', existsSync(pending),
      existsSync(pending) ? '' : '被删了！用户的审批会凭空消失')
    ok('【关键】卡片正在写的 .json.tmp 没被删', existsSync(tmpFile),
      existsSync(tmpFile) ? '' : '被删了！决定会丢失')
    ok('别的程序的 .log 没被删', existsSync(otherLog))
    ok('没后缀的 README 没被删', existsSync(noExt))
    ok('过期的 .consumed 该删的删了', !existsSync(consumedOld))
  }

  // ================================================================
  // 3. 空目录 / 目录不存在时不炸
  // ================================================================
  console.log('\n=== 3. 边界情况不炸 ===')
  {
    const emptyDir = join(root, 'c3-empty')
    mkdirSync(emptyDir, { recursive: true })
    let threw = false
    try { makeProxy(emptyDir)._sweepConsumed() } catch { threw = true }
    ok('空目录不抛异常', !threw)

    threw = false
    try { makeProxy(join(root, 'does-not-exist'))._sweepConsumed() } catch { threw = true }
    ok('【关键】目录不存在不抛异常（插件刚装好时就是这种状态）', !threw)
  }

  // ================================================================
  // 4. 什么都不用删时不写日志（否则空闲时每 10 秒刷一条）
  // ================================================================
  console.log('\n=== 4. 无动作时不刷日志 ===')
  {
    const dir = join(root, 'c4')
    mkdirSync(dir, { recursive: true })
    const fresh = join(dir, 'fresh.consumed')
    writeFileSync(fresh, 'x')
    setAge(fresh, 1)

    const logs = []
    makeProxy(dir, logs)._sweepConsumed()
    ok('没有过期文件时不产生日志', logs.length === 0, `${logs.length} 条`)
    ok('新文件还在', existsSync(fresh))
  }

  // ================================================================
  // 5. 安全性：清理日志不许出现 nonce / 完整文件名
  // ================================================================
  console.log('\n=== 5. 清理日志不泄露凭据 ===')
  {
    const dir = join(root, 'c5')
    mkdirSync(dir, { recursive: true })

    // 归档文件名是 approvalId + .consumed，里面有正文字段 nonce
    const name = '01234567-89ab-cdef-0123-456789abcdef.consumed'
    const p = join(dir, name)
    writeFileSync(p, JSON.stringify({ nonce: 'SUPER-SECRET-NONCE-VALUE', approvalId: '01234567' }))
    setAge(p, 90)

    const logs = []
    makeProxy(dir, logs)._sweepConsumed()
    const joined = logs.join(' ')

    ok('过期文件被删了', !existsSync(p))
    ok('【安全】日志里没有 nonce', !joined.includes('SUPER-SECRET-NONCE-VALUE'), joined)
    ok('【安全】日志里没有完整 approvalId', !joined.includes('123456789abcdef'), joined)
  }

  // ================================================================
  // 6. 接在 _poll 的空闲分支上（有待审批时绝不清理）
  // ================================================================
  console.log('\n=== 6. 只在空闲轮次清理 ===')
  {
    const src = readFileSync(new URL('../lib/approval-proxy.js', import.meta.url), 'utf8')

    // 从 _poll 里取"空闲分支"
    const pollBody = (src.match(/_poll\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0]
    ok('抓到了 _poll 方法', pollBody.length > 0)

    const idleBranch = (pollBody.match(/if \(this\.held\.size === 0\) \{[\s\S]*?return\s*\n\s*\}/) || [''])[0]
    ok('抓到了"空闲"分支', idleBranch.length > 0)

    ok('【关键】空闲分支里会调 _sweepConsumed',
      /_sweepConsumed\s*\(/.test(idleBranch),
      idleBranch ? (/_sweepConsumed\s*\(/.test(idleBranch) ? '已接上' : '没看到调用') : '无分支')

    ok('【关键】_sweepConsumed 不在"忙"的分支里（有待审批时不跑）',
      !/_sweepConsumed\s*\(/.test(pollBody.replace(idleBranch, '')),
      '忙分支里也调了会有删掉正在等待决定的风险')
  }
} catch (e) {
  fail++
  bad.push('测试自身异常: ' + (e && e.message))
  console.log('\n❌ 测试自身抛异常: ' + (e && e.stack))
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('\n' + '='.repeat(60))
console.log(`通过 ${pass}   失败 ${fail}`)
if (fail === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
} else {
  console.log('有失败项')
  if (bad.length) console.log('失败清单:\n  · ' + bad.join('\n  · '))
  process.exit(1)
}
