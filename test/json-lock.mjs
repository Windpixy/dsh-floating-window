/**
 * test/json-lock.mjs -- D1 第二步：跨进程写锁
 *
 * ===========================================================================
 * 【这一步解决什么 —— 第一步没解决的问题】
 * ===========================================================================
 *
 * 第一步（v0.10.13）解决了「单个进程写坏文件」：唯一临时名 + 原子替换。
 *
 * 但**没有解决**「两个进程同时读-改-写，后写的盖掉先写的」：
 *
 *     进程A：读 {width:320}          进程B：读 {width:320}
 *            ↓ 改 width=400                ↓ 改 topmost=false
 *            写 {width:400}                 写 {topmost:false}
 *                                          ↑ 把 A 的 width 盖没了
 *
 * 真实场景里，settings.json 恰好有**三个写者**：
 *   · 插件（Node）      —— 同步 dshUrl
 *   · 卡片（PowerShell）—— 写 topmost
 *   · 设置窗口（PowerShell）—— 保存外观
 *
 * 而且卡片和设置窗口**都用固定名 `settings.json.tmp`**，
 * 两个 PowerShell 进程同时保存时会互相覆盖中间文件。
 *
 * ===========================================================================
 * 【怎么解决：文件锁 + 锁内重读】
 * ===========================================================================
 *
 * 写入流程改成：
 *
 *   1. 抢锁（创建一个独占文件，O_CREAT | O_EXCL 语义）
 *   2. 抢到后**重新读一次**最新内容（不是用锁外读到的旧对象！）
 *   3. 合并本次要改的键
 *   4. 原子写回
 *   5. 释放锁
 *
 * 关键在**第 2 步**：锁外读到的可能已经过期，必须在锁内重读。
 *
 * ===========================================================================
 * 【锁的边界条件（这一步的难点）】
 * ===========================================================================
 *
 * ① **超时**：抢不到锁不能无限等，要有上限（默认 2 秒）
 * ② **进程强杀**：持锁进程被 kill，锁文件留在磁盘上 → 后续进程永远抢不到
 *    → 必须有「锁过期」机制：锁文件太旧就认为持有者已死，强制接管
 * ③ **锁的所有者标识**：交付锁时确认"这锁还是我的"，避免误删别人的新锁
 * ④ **异常释放**：写失败也必须放锁，否则死锁
 *
 * ===========================================================================
 * 【为什么文件名锁而不是真正的系统互斥量】
 * ===========================================================================
 *   · 跨语言（Node + PowerShell 5.1）都能用，不需要额外依赖
 *   · 进程崩溃后锁文件留在磁盘上，可以靠时间戳判断过期
 *   · 系统 Mutex 在 Node 里需要额外库，PS 5.1 里另写一套，两边还要对齐名称
 *
 * 跑法：node test/json-lock.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { acquireLock, withLock, readJsonSafe, writeJsonAtomic,
  LOCK_TIMEOUT_MS, LOCK_STALE_MS } from '../lib/json-store.js'

let failed = 0
let passed = 0
const group = (n) => console.log(`\n=== ${n} ===`)
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

console.log('='.repeat(70))
console.log('D1 第二步：跨进程写锁')
console.log('='.repeat(70))

const dirs = []
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  dirs.push(d)
  return d
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  // ================================================================ 1. 常量
  group('1. 常量合理性')

  check('锁超时是有限值', Number.isFinite(LOCK_TIMEOUT_MS) && LOCK_TIMEOUT_MS > 0, String(LOCK_TIMEOUT_MS))
  check('锁超时不太长（< 10 秒，否则用户会以为卡住）', LOCK_TIMEOUT_MS <= 10000, String(LOCK_TIMEOUT_MS))
  check('锁过期时间 > 超时时间（否则自己还在等就被判死锁）',
    LOCK_STALE_MS > LOCK_TIMEOUT_MS, `stale=${LOCK_STALE_MS} timeout=${LOCK_TIMEOUT_MS}`)

  // ================================================================ 2. 基本获取与释放
  group('2. 基本获取与释放')

  {
    const d = freshDir()
    const target = join(d, 'a.json')

    const lock = await acquireLock(target)
    check('能获取锁', lock.ok === true, lock.reason)
    check('锁文件存在', existsSync(lock.lockPath), lock.lockPath)
    check('锁文件里记了 pid', Number(lock.info.pid) === process.pid, String(lock.info.pid))

    const released = lock.release()
    check('释放成功', released === true)
    check('释放后锁文件已删除', !existsSync(lock.lockPath))
  }

  // ================================================================ 3. 互斥：第二个抢不到
  group('3. 互斥：锁被占用时第二次获取必须失败')

  {
    const d = freshDir()
    const target = join(d, 'b.json')

    const l1 = await acquireLock(target)
    check('第一个获取成功', l1.ok === true, l1.reason)

    const l2 = await acquireLock(target, { timeoutMs: 200, pollMs: 50 })
    check('【关键】第二个获取失败（互斥生效）', l2.ok === false, l2.reason)
    check('  失败原因说明是超时', /超时|被占用/.test(l2.reason || ''), l2.reason)

    l1.release()

    const l3 = await acquireLock(target, { timeoutMs: 500 })
    check('第一个释放后，第三个能获取', l3.ok === true, l3.reason)
    l3.release()
  }

  // ================================================================ 4. 等锁：占用者释放后能拿到
  group('4. 等锁：短暂占用后能自动获得')

  {
    const d = freshDir()
    const target = join(d, 'c.json')

    const l1 = await acquireLock(target)
    check('第一个拿到锁', l1.ok === true)

    // 200ms 后释放
    let l2Result = null
    const p = (async () => {
      l2Result = await acquireLock(target, { timeoutMs: 2000, pollMs: 50 })
      return l2Result
    })()

    await sleep(200)
    l1.release()

    await p
    check('等了一会儿后拿到锁（不是立即失败）', l2Result.ok === true, l2Result.reason)
    l2Result.release()
  }

  // ================================================================ 5. 死锁恢复：锁文件残留
  group('5. 【关键】持有者被强杀，锁文件残留 → 必须能接管')

  {
    const d = freshDir()
    const target = join(d, 'd.json')
    const lockPath = target + '.lock'

    // 手工造一个"早就过期"的锁文件（模拟进程被强杀，没来得及释放）
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      host: 'dead-machine',
      at: Date.now() - LOCK_STALE_MS - 5000,   // 明显超过过期时间
      nonce: 'deadbeef',
    }), 'utf8')

    const lock = await acquireLock(target, { timeoutMs: 1000 })
    check('【关键】能接管过期的锁（不会永久卡死）', lock.ok === true, lock.reason)

    if (lock.ok) {
      check('  接管后锁文件里是新的 pid', Number(lock.info.pid) === process.pid, String(lock.info.pid))
      lock.release()
    }
  }

  // ================================================================ 6. 不接管新鲜但非自己的锁
  group('6. 别人的锁如果还新鲜，不能抢')

  {
    const d = freshDir()
    const target = join(d, 'e.json')
    const lockPath = target + '.lock'

    // 造一个"刚创建"的、属于"别的进程"的锁
    writeFileSync(lockPath, JSON.stringify({
      pid: 999998,
      host: 'other-proc',
      at: Date.now(),        // 刚刚
      nonce: 'freshenough',
    }), 'utf8')

    const lock = await acquireLock(target, { timeoutMs: 300, pollMs: 50 })
    check('【安全】别人的新鲜锁抢不到', lock.ok === false, lock.reason)
    check('  超时后放弃，不硬抢', /超时/.test(lock.reason || ''), lock.reason)
  }

  // ================================================================ 7. 锁文件损坏
  group('7. 锁文件本身损坏 → 也要能恢复（不能永久卡死）')

  {
    const d = freshDir()
    const target = join(d, 'f.json')
    const lockPath = target + '.lock'

    // 锁文件内容不是合法 JSON
    writeFileSync(lockPath, 'not a json at all', 'utf8')
    // 让它看起来是旧的
    const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000
    utimesSync(lockPath, old, old)

    const lock = await acquireLock(target, { timeoutMs: 1000 })
    check('【关键】坏锁文件能接管（不会永久卡死）', lock.ok === true, lock.reason)
    if (lock.ok) lock.release()
  }

  // ================================================================ 8. withLock 封装
  group('8. withLock：自动释放（含异常路径）')

  {
    const d = freshDir()
    const target = join(d, 'g.json')
    writeJsonAtomic(target, { base: 1 })

    // 正常路径
    const r1 = await withLock(target, (cur) => ({ ...cur, added: 2 }))
    check('正常路径返回 ok', r1.ok === true, r1.error)
    const after1 = readJsonSafe(target, {})
    check('  改动生效', after1.added === 2 && after1.base === 1, JSON.stringify(after1))
    check('  锁已释放', !existsSync(target + '.lock'))

    // 异常路径：merger 抛错
    const r2 = await withLock(target, () => { throw new Error('故意抛错') })
    check('异常路径返回 ok:false', r2.ok === false, String(r2.ok))
    check('  【关键】异常后锁已释放（不会死锁）', !existsSync(target + '.lock'))
    const after2 = readJsonSafe(target, {})
    check('  文件内容没被破坏', after2.added === 2 && after2.base === 1, JSON.stringify(after2))
  }

  // ================================================================ 9. 锁内重读：核心价值
  group('9. 【核心】锁内重读：两个写者轮流改不同键，都不能丢')

  {
    const d = freshDir()
    const target = join(d, 'h.json')
    writeJsonAtomic(target, { width: 320 })

    // 模拟两个"进程"：各自先读到旧内容，然后带锁写入
    // 注意：这里的关键是 withLock 内部**重新读**，而不是用调用方手里的旧对象
    await withLock(target, (cur) => ({ ...cur, width: 400 }))
    await withLock(target, (cur) => ({ ...cur, topmost: false }))
    await withLock(target, (cur) => ({ ...cur, approvalInline: true }))

    const final = readJsonSafe(target, {})
    check('width 是最后一次写的 400', final.width === 400, String(final.width))
    check('【关键】topmost 没被后来的覆盖丢掉', final.topmost === false, String(final.topmost))
    check('【关键】approvalInline 也在', final.approvalInline === true, String(final.approvalInline))
    check('无锁文件残留', !existsSync(target + '.lock'))
  }

  // ================================================================ 10. 并发压力
  group('10. 并发：多个写者同时改，谁也不能丢')

  {
    const d = freshDir()
    const target = join(d, 'i.json')
    writeJsonAtomic(target, {})

    // 并发 20 个写者，各写一个独立键
    const writers = []
    for (let i = 0; i < 20; i++) {
      writers.push(
        withLock(target, (cur) => ({ ...cur, ['k' + i]: i }), { timeoutMs: 5000 })
          .then((r) => r.ok)
      )
    }
    const results = await Promise.all(writers)
    const okCount = results.filter(Boolean).length

    check('20 个并发写全部成功', okCount === 20, `${okCount}/20`)

    const final = readJsonSafe(target, {})
    const keys = Object.keys(final).filter((k) => k.startsWith('k'))
    check('【关键】20 个键一个都没丢', keys.length === 20,
      `实际 ${keys.length} 个: ${keys.join(',')}`)
    check('无锁文件残留', !existsSync(target + '.lock'))
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
