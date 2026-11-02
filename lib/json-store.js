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

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs'
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
