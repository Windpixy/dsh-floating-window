/**
 * lib/json-store.js -- 四份 JSON 的统一安全读写（v0.10.13 · D1）
 *
 * ===========================================================================
 * 【这个模块解决什么】
 * ===========================================================================
 *
 * 项目里有四份 JSON 会被写：settings / card-launch / panel-pos / holidays。
 * 改造前，四处写法各不相同，各带一类风险：
 *
 *   文件                 改造前写法                      风险
 *   ----------------------------------------------------------------------
 *   card-launch.json     写 tmp → **删旧** → 改名        删与改名之间文件不存在
 *   settings.json        写 tmp → 改名（固定 .tmp 名）    已是原子，但并发会撞
 *   holidays.json        WriteAllText 直接覆盖           中途失败留下坏文件
 *   panel-pos.json       WriteAllText 直接覆盖           同上
 *
 * 三类真实后果：
 *
 *   ① **半截文件**：写到一半崩溃/断电，留下坏 JSON。
 *      读取方解析失败 → 数据全丢 → 用户看到"卡片变空了"。
 *      （C2 修的正是"读不到数据却显示空闲"的后果，这里是它的上游原因之一。）
 *
 *   ② **文件消失的瞬间**：「先删旧再改名」两步之间文件真的不存在。
 *      恰好在这一瞬间读的进程会读到"文件不存在"。
 *
 *   ③ **共用固定 .tmp 名**：进程 A 写 tmp → 进程 B 也写同一个 tmp
 *      → A 或 B 改名时拿到对方的内容。结果内容错乱，而且**不报错**。
 *
 * ===========================================================================
 * 【本模块的做法】
 * ===========================================================================
 *
 * 写入（writeJsonAtomic）：
 *   1. 生成**独一无二**的临时文件名（正式名 + pid + 随机串 + 时间戳）
 *   2. 写入临时文件，关闭句柄（writeFileSync 返回即已关闭）
 *   3. 原子改名覆盖正式文件
 *   4. 任何一步失败 → 删除临时文件、返回 false、**不抛异常**
 *
 * 读取（readJsonSafe）：
 *   - 文件不存在 / 读失败 / JSON 坏 / 顶层不是对象 → 一律返回 fallback
 *   - **绝不抛异常**，也不返回 null 让调用方去判空
 *
 * ===========================================================================
 * 【诚实记录：Windows 上的重命名残留风险】
 * ===========================================================================
 *
 * 理论上，「临时文件 → 改名覆盖」在同一卷内是原子的。
 * 但 **Windows 上 fs.renameSync 在目标文件已存在时会失败**
 * （EEXIST / EPERM / EACCES，视文件系统与杀软而定）。
 *
 * 所以这里采用**降级策略**：
 *
 *   a) 先试 renameSync（目标不存在时直接成功，原子）
 *   b) 失败则 unlink 目标 + 再 renameSync
 *      —— 这一步存在**极短的文件消失窗口**（微秒级）
 *
 * 为什么接受这个残留风险：
 *   - 没有它，在 Windows 上**根本没法覆盖写**（renameSync 必然失败）
 *   - 窗口是微秒级，而原来的「先删再改名」是**两次独立系统调用**，窗口大得多
 *   - 读取方（readJsonSafe）已经把"文件不存在"当正常情况处理
 *
 * **这一点不假装是完全原子的。** 真正要完全避免，需要引入文件锁（D1 第二步）。
 *
 * ===========================================================================
 * 【和 D1 第二步（跨进程锁）的关系】
 * ===========================================================================
 *
 * 本模块解决「单个进程写坏了文件」。
 * 但**不解决**「两个进程同时读-改-写，后写的盖掉先写的另一个键」。
 *
 * 那个问题需要跨进程互斥，属 D1 第二步。本模块先把地基打好。
 */

import {
  existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync,
  readdirSync, statSync, openSync, closeSync, writeSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'

/**
 * 生成一个独一无二的临时文件名。
 *
 * 【为什么要带这么多东西】
 *   - 正式文件名：同一个目录下有多种 JSON，靠它区分
 *   - pid：不同进程不会撞
 *   - 随机串：同一进程内多次并发写也不会撞
 *   - 时间戳：便于排查"这个临时文件是哪次写的"
 *
 * 【为什么不用固定 `.tmp` 后缀】
 *   改造前 card-launch / settings 都写死 `path + '.tmp'`。
 *   两个进程同时写就必然互相覆盖中间结果 —— 而且很难发现。
 *
 * @param {string} targetPath 正式文件的完整路径
 * @returns {string} 临时文件的完整路径（不创建文件，只给名字）
 */
export function makeTempName(targetPath) {
  const dir = dirname(targetPath)
  const base = basename(targetPath)
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0
  const rnd = Math.random().toString(36).slice(2, 10)
  const ts = Date.now().toString(36)
  return join(dir, `.${base}.${pid}.${ts}.${rnd}.tmp`)
}

/**
 * 原子写一个 JSON 文件。
 *
 * @param {string} targetPath 正式文件路径
 * @param {object} obj 要写入的对象（会被 JSON.stringify）
 * @param {object} [options]
 * @param {number} [options.indent] 缩进，默认 2
 * @param {boolean} [options._injectWriteError] **仅测试用**：模拟写临时文件时抛错
 * @returns {boolean} true=成功；false=失败（已清理临时文件，不抛异常）
 */
export function writeJsonAtomic(targetPath, obj, options = {}) {
  const indent = Number.isFinite(options.indent) ? options.indent : 2
  const tmp = makeTempName(targetPath)

  try {
    // ---- ① 确保目录存在（深层目录首次写入时）
    const dir = dirname(targetPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // ---- ② 序列化（先做，序列化失败就不必碰磁盘）
    const text = JSON.stringify(obj, null, indent)
    if (typeof text !== 'string') {
      // undefined / 函数 / 循环引用等情况
      throw new Error('无法序列化为 JSON')
    }

    // ---- ③ 写临时文件（writeFileSync 返回即句柄已关闭）
    if (options._injectWriteError === true) {
      throw new Error('（测试注入）写临时文件失败')
    }
    writeFileSync(tmp, text, 'utf8')

    // ---- ④ 改名覆盖
    //
    // 【为什么先试一次 renameSync】
    //   目标文件不存在时（首次写入），renameSync 直接成功，完全原子。
    //
    // 【为什么还要 catch 再降级】
    //   Windows 上目标已存在时 renameSync 会失败。
    //   这时只能"删目标 + 改名"，承认有极短窗口（见文件头说明）。
    try {
      renameSync(tmp, targetPath)
      return true
    } catch {
      // 降级路径：删除目标再改名
      try {
        if (existsSync(targetPath)) unlinkSync(targetPath)
      } catch { /* 删不掉也继续试，让下面的 rename 报错 */ }
      renameSync(tmp, targetPath)
      return true
    }
  } catch {
    // ---- ⑤ 失败清理：绝不留下垃圾临时文件
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch { /* 清理失败也只能算了，不能在错误处理里再抛 */ }
    return false
  }
}

/**
 * 安全读一个 JSON 文件。**永不抛异常。**
 *
 * @param {string} targetPath
 * @param {object} [fallback] 读不到/解析失败时返回的对象，默认 {}
 * @returns {object} 一定是对象（不会是 null / 数组 / 原始值）
 */
export function readJsonSafe(targetPath, fallback = {}) {
  const fb = (fallback && typeof fallback === 'object' && !Array.isArray(fallback))
    ? fallback
    : {}

  try {
    if (!existsSync(targetPath)) return fb
    const text = readFileSync(targetPath, 'utf8')
    if (!text || !text.trim()) return fb
    const parsed = JSON.parse(text)
    // 【为什么只接受普通对象】
    //   本项目的这些配置文件顶层都该是对象。
    //   如果解析出数组或原始值，说明文件被外部改坏了，
    //   当成"读不到"比把数组当对象用更安全。
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fb
    return parsed
  } catch {
    return fb
  }
}

/**
 * 读-改-写：在**当前磁盘内容**基础上合并改动，保留不认识的键。
 *
 * 【为什么必须有这个函数】
 *   "读出来 → 改一个键 → 写回去"这三步如果中间隔了别的写者，
 *   直接用旧对象覆盖就会把别人的改动抹掉。
 *
 *   本函数内部重新读一次（尽量拿到最新的），合并后再原子写。
 *
 *   ⚠️ **但它不是并发安全的**：读和写之间仍有窗口，
 *      两个进程同时调这个函数，仍可能互相覆盖。
 *      真正的并发安全要跨进程锁（D1 第二步）。
 *      这里只是把最原始的"拿锁外旧对象直接覆盖"改善成"写前重读"。
 *
 * @param {string} targetPath
 * @param {(current: object) => object} merger 收到当前内容，返回要写入的新对象
 * @param {object} [options] 透传给 writeJsonAtomic
 * @returns {{ok: boolean, next?: object, error?: string}}
 */
export function mergeJsonAtomic(targetPath, merger, options = {}) {
  try {
    const cur = readJsonSafe(targetPath, {})
    const next = merger(cur)
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return { ok: false, error: 'merger 返回的不是对象' }
    }
    const ok = writeJsonAtomic(targetPath, next, options)
    return ok ? { ok: true, next } : { ok: false, error: '写入失败' }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

/**
 * 清理目录里遗留的临时文件（只匹配本模块生成的命名格式）。
 *
 * 【为什么要清理】
 *   进程被强杀时，步骤 ⑤ 的清理跑不到，会留下临时文件。
 *   积累多了会让目录变乱，也可能被误当成正式文件。
 *
 * 【为什么必须严格匹配命名格式】
 *   不能误删用户或其它程序的文件。
 *   本模块生成的名字带前导点、以 .tmp 结尾、中间有 pid 段。
 *
 * @param {string} dir 目录
 * @param {number} [olderThanMs] 只删超过这个时长的（默认 10 分钟），避免删掉正在写的
 * @returns {{deleted: number, failed: number}}
 */
export function cleanupTempFiles(dir, olderThanMs = 10 * 60 * 1000) {
  let deleted = 0
  let failed = 0
  try {
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      // 严格格式：以 . 开头、以 .tmp 结尾、中间有 pid 数字段
      if (!name.startsWith('.') || !name.endsWith('.tmp')) continue
      if (!/^\..+\.\d+\.[0-9a-z]+\.[0-9a-z]+\.tmp$/i.test(name)) continue
      try {
        const p = join(dir, name)
        const st = statSync(p)
        if (!st.isFile()) continue
        if (now - st.mtimeMs < olderThanMs) continue
        unlinkSync(p)
        deleted++
      } catch {
        failed++
      }
    }
  } catch {
    // 目录读不了就算了，清理不是关键路径
  }
  return { deleted, failed }
}

// ===========================================================================
// ============ 跨进程写锁（v0.10.14 · D1 第二步）============================
// ===========================================================================
//
// 【这一步解决什么】
//   第一步解决了"单个进程写坏文件"，但**没解决**"两个进程互相覆盖"。
//
//   典型翻车现场（settings.json 有三个写者）：
//
//     插件：读 {width:320} → 改 dshUrl → 写 {width:320, dshUrl:...}
//     卡片：读 {width:320} → 改 topmost → 写 {width:320, topmost:false}
//                                          ↑ 把插件的 dshUrl 盖没了
//
//   两个进程各自读到的是**旧内容**，各自写回自己那份，后写的赢。
//
// 【怎么解决：锁 + 锁内重读】
//
//   关键不在于"锁住写"这一下，而在于**拿到锁之后必须重新读一次**。
//   锁外读到的对象可能已经过期 —— 用它做基准合并，等于白锁。
//
// 【为什么用文件当锁，不用系统 Mutex】
//   · Node 和 PowerShell 5.1 都要能用。系统 Mutex 在 Node 里要额外库，
//     PS 里另有一套 API，两边还得对齐名字 —— 成本高且易错。
//   · 文件锁跨语言天然一致：谁都能创建/删除文件。
//   · 进程崩溃后锁文件留在磁盘上，正好可以靠**时间戳判断过期**。
//
// 【怎么保证"创建"是原子的】
//   用 `openSync(path, 'wx')` —— 这是 O_CREAT | O_EXCL 语义：
//   文件已存在就抛 EEXIST，绝不会两个进程同时"创建成功"。
//   这是整个锁机制唯一真正依赖的原子性。

/** 默认抢锁超时（毫秒）。抢不到就放弃，不能无限等。 */
export const LOCK_TIMEOUT_MS = 2000

/** 锁超过这个时长没更新，就认为持有者已死，可以接管 */
export const LOCK_STALE_MS = 10000

/** 默认轮询间隔 */
const LOCK_POLL_MS = 50

/**
 * 锁文件路径（和正式文件同目录，加 .lock 后缀）。
 * @param {string} targetPath
 */
function lockPathFor(targetPath) {
  return targetPath + '.lock'
}

/**
 * 读锁文件的信息（内容坏了返回 null）。
 * @param {string} lockPath
 * @returns {{pid?:number, at?:number, nonce?:string}|null}
 */
function readLockInfo(lockPath) {
  try {
    const txt = readFileSync(lockPath, 'utf8')
    const j = JSON.parse(txt)
    if (!j || typeof j !== 'object') return null
    return j
  } catch {
    return null
  }
}

/**
 * 判断现有锁是否已经"过期"（持有者多半已死）。
 *
 * 【判据用两重，取更保守的那个】
 *   ① 锁文件里的 at 字段
 *   ② 锁文件的 mtime
 *   任一显示"够旧"就认为过期 —— 为什么用"或"而不是"且"：
 *   锁文件内容可能被写坏（读不到 at），那时只能靠 mtime；
 *   而 mtime 在某些网络盘上可能不准，at 更可信。
 *   任一可信证据表明它旧了，就应该允许接管，否则可能永久卡死。
 *
 * @param {string} lockPath
 * @param {number} now
 * @returns {{stale: boolean, reason: string}}
 */
function isLockStale(lockPath, now = Date.now()) {
  const info = readLockInfo(lockPath)

  // ① 内容里有 at 就用它
  if (info && Number.isFinite(Number(info.at))) {
    const age = now - Number(info.at)
    if (age >= LOCK_STALE_MS) {
      return { stale: true, reason: `锁已存在 ${Math.round(age / 1000)} 秒（超过 ${LOCK_STALE_MS / 1000} 秒）` }
    }
    return { stale: false, reason: `锁还很新（${Math.round(age / 1000)} 秒）` }
  }

  // ② 内容坏了 / 没有 at → 退回用 mtime
  try {
    const st = statSync(lockPath)
    const age = now - st.mtimeMs
    if (age >= LOCK_STALE_MS) {
      return { stale: true, reason: `锁文件 mtime 已是 ${Math.round(age / 1000)} 秒前（内容不可解析）` }
    }
    return { stale: false, reason: `锁文件 mtime 还新（${Math.round(age / 1000)} 秒）` }
  } catch {
    // 连 stat 都失败（文件刚被删），当作过期，让别人去抢
    return { stale: true, reason: '锁文件已读不到' }
  }
}

/**
 * 尝试抢锁（单次，不等待）。
 *
 * @param {string} targetPath 正式文件路径（锁文件放它旁边）
 * @returns {{ok: boolean, lockPath: string, info?: object, reason?: string}}
 */
function tryAcquireOnce(targetPath) {
  const lockPath = lockPathFor(targetPath)
  const nonce = Math.random().toString(36).slice(2, 12)
  const info = {
    pid: typeof process !== 'undefined' && process.pid ? process.pid : 0,
    at: Date.now(),
    nonce,
    target: basename(targetPath),
  }

  try {
    const dir = dirname(lockPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // 【关键】'wx' = O_CREAT | O_EXCL，已存在则 EEXIST
    const fd = openSync(lockPath, 'wx')
    try {
      writeSync(fd, JSON.stringify(info))
    } finally {
      closeSync(fd)
    }
    return { ok: true, lockPath, info }
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // 已有人持锁，看看是否过期
      const st = isLockStale(lockPath)
      if (st.stale) {
        // ---- 接管过期锁
        //
        // 【为什么先删再抢，而不是直接覆盖】
        //   直接覆盖有竞态：两个进程同时判定"过期"，同时覆盖，
        //   两个都以为自己拿到了锁。
        //   先删再抢也有竞态，但**抢的那一步是 O_EXCL 原子操作**，
        //   所以最终只有一个能真正创建成功。另一个会 EEXIST 然后重试。
        try { unlinkSync(lockPath) } catch { /* 别人先删了也正常 */ }
        try {
          const fd2 = openSync(lockPath, 'wx')
          try {
            writeSync(fd2, JSON.stringify(info))
          } finally {
            closeSync(fd2)
          }
          return { ok: true, lockPath, info, reason: `接管了过期锁：${st.reason}` }
        } catch {
          return { ok: false, lockPath, reason: '接管过期锁时被别的进程抢先' }
        }
      }
      return { ok: false, lockPath, reason: `被占用：${st.reason}` }
    }
    return { ok: false, lockPath, reason: '创建锁文件失败: ' + (e && e.message) }
  }
}

/**
 * 获取写锁（**异步**，带超时和轮询）。
 *
 * 【为什么是异步】
 *   抢不到锁时要等（最多 2 秒）。如果用 Atomics.wait 同步等，
 *   那 2 秒里 **DSH 主线程完全卡死** —— 这正是 C4 刚修掉的同类问题。
 *   所以这里用 setTimeout 异步轮询，等的时候主线程可以干别的。
 *
 * @param {string} targetPath 要保护的文件
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 抢不到就放弃
 * @param {number} [options.pollMs] 轮询间隔
 * @param {(ms:number) => Promise<void>} [options.sleep] 便于测试注入假时钟
 * @returns {Promise<{ok: boolean, lockPath: string, info?: object, reason?: string, release: () => boolean}>}
 */
export async function acquireLock(targetPath, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : LOCK_TIMEOUT_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : LOCK_POLL_MS
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const started = Date.now()

  let lastReason = ''
  while (true) {
    const r = tryAcquireOnce(targetPath)
    if (r.ok) {
      const myNonce = r.info.nonce
      return {
        ok: true,
        lockPath: r.lockPath,
        info: r.info,
        reason: r.reason,
        /**
         * 释放锁。
         *
         * 【为什么要核对 nonce 再删】
         *   如果我的锁因为"超时"被别人接管了，我这时候再删，
         *   会把**别人的新锁**删掉 —— 于是第三个进程也能进来，
         *   互斥就破了。所以只删"确实还是我建的"那把。
         */
        release() {
          try {
            const cur = readLockInfo(r.lockPath)
            if (cur && cur.nonce === myNonce) {
              unlinkSync(r.lockPath)
              return true
            }
            return false
          } catch {
            return false
          }
        },
      }
    }

    lastReason = r.reason || '未知原因'
    const elapsed = Date.now() - started
    if (elapsed >= timeoutMs) {
      return {
        ok: false,
        lockPath: r.lockPath,
        reason: `抢锁超时（等了 ${Math.round(elapsed)}ms）：${lastReason}`,
      }
    }

    // ---- 异步等待一小会儿再试
    const remain = Math.min(pollMs, timeoutMs - elapsed)
    if (remain > 0) await sleep(remain)
  }
}

/**
 * 带锁执行"读-改-写"。
 *
 * 【这是本模块最重要的函数】
 *   它强制在**锁内重读**，所以不会用过期内容做基准。
 *
 * @param {string} targetPath
 * @param {(current: object) => object|null} merger 收当前内容，返回新内容；返回 null 表示不写
 * @param {object} [options] 透传给 acquireLock / writeJsonAtomic
 * @returns {Promise<{ok: boolean, next?: object, skipped?: boolean, error?: string}>}
 */
export async function withLock(targetPath, merger, options = {}) {
  const lock = await acquireLock(targetPath, options)

  if (!lock.ok) {
    return { ok: false, error: lock.reason || '抢锁失败' }
  }

  try {
    // 【关键】锁内重读 —— 不是用调用方手里的旧对象
    const cur = readJsonSafe(targetPath, {})
    const next = merger(cur)

    if (next === null || next === undefined) {
      // 调用方决定不写（比如"值没变就不用写"）
      return { ok: true, skipped: true }
    }
    if (typeof next !== 'object' || Array.isArray(next)) {
      return { ok: false, error: 'merger 返回的不是对象' }
    }

    const wrote = writeJsonAtomic(targetPath, next, options)
    return wrote ? { ok: true, next } : { ok: false, error: '写入失败' }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  } finally {
    // 【必须放】异常路径也要释放，否则死锁
    lock.release()
  }
}

/**
 * 带锁执行的**同步**版本。
 *
 * ⚠️ **不推荐**，只在确实无法改 async 的同步调用方里用。
 *
 * 【为什么不推荐】
 *   抢不到锁时它必须**同步**等待，那段等待会把调用方所在的线程卡住。
 *   在 DSH 插件宿主里跑就会卡住 DSH —— 和 C4 刚修掉的问题同一类。
 *
 * 【当前用途】
 *   仅作为"抢锁失败立即返回"的非阻塞尝试（timeoutMs 传 0）。
 *   例如：写启动策略这种"失败也无所谓"的旁路径，抢不到就算了。
 *
 * 逻辑与 withLock 相同（含锁内重读），只是不等锁。
 *
 * @param {string} targetPath
 * @param {(current: object) => object|null} merger
 * @param {object} [options] 建议传 { timeoutMs: 0 }，抢不到立即失败
 * @returns {{ok: boolean, next?: object, skipped?: boolean, error?: string}}
 */
export function withLockSync(targetPath, merger, options = {}) {
  // 同步版只尝试一次，绝不同步死等（那会卡住宿主）
  const r = tryAcquireOnce(targetPath)
  if (!r.ok) {
    return { ok: false, error: r.reason || '抢锁失败（同步版不等待）' }
  }

  const myNonce = r.info.nonce
  const release = () => {
    try {
      const cur = readLockInfo(r.lockPath)
      if (cur && cur.nonce === myNonce) unlinkSync(r.lockPath)
    } catch { /* ignore */ }
  }

  try {
    const cur = readJsonSafe(targetPath, {})
    const next = merger(cur)
    if (next === null || next === undefined) return { ok: true, skipped: true }
    if (typeof next !== 'object' || Array.isArray(next)) {
      return { ok: false, error: 'merger 返回的不是对象' }
    }
    const wrote = writeJsonAtomic(targetPath, next, options)
    return wrote ? { ok: true, next } : { ok: false, error: '写入失败' }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  } finally {
    release()
  }
}
