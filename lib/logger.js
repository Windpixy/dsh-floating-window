/**
 * lib/logger.js -- 插件自己的日志（v0.9.15 重做）
 *
 * 【v0.9.15 改了什么，为什么】
 *
 *   用户需求："我需要一个日志功能，方便在其他人使用中出现错误的时候方便反馈，
 *              也方便我们自己排查问题。"
 *
 *   这个插件一共写三份日志，分别属于三个互不相干的进程：
 *     · 插件（Node，跑在 DSH 进程里）  → plugin.log   ← 就是本文件
 *     · 卡片（PowerShell 独立进程）    → panel.log
 *     · 设置窗口（PowerShell，用完即退）→ settings.log
 *   三个进程不共享内存、只能靠文件通信（项目既定架构），所以日志天生分散，
 *   只能"事后合并"。既然是事后合并，三份的格式就必须能直接对齐，否则每次
 *   排查都得先做一次时间换算 —— 这才是这次改动的真正动机。
 *
 *   原来的 plugin.log 有三个硬伤：
 *
 *   ① 【时间是 UTC，和另外两份差 8 小时】
 *      原来写的是 new Date().toISOString()，产物形如 2026-10-29T15:09:24.914Z，
 *      结尾那个 Z 就是"这是 UTC"的意思。而 panel.log 写的是本地时间。
 *      结果：北京时间 23:09 发生的事，在 plugin.log 里记成 15:09，
 *      对齐时间线要手动 +8 小时，跨天的时候（本地 23:30 = UTC 15:30）
 *      还容易直接对错日期。现在统一成本地时间 + 日期 + 毫秒。
 *
 *   ② 【没有级别】
 *      原来只有"时间 + 内容"。三份日志合并成一个文件之后，几百行里
 *      根本没法快速找出"哪几行是错误" —— 只能靠人眼逐行读中文。
 *      现在统一成 [时间] [来源] [级别] 内容，来源固定 [PLUGIN]。
 *
 *   ③ 【轮转其实经常不生效，而且没有天数上限】
 *      原来的 rotateIfNeeded() 用一个 checkedRotation 布尔量：第一次写日志时
 *      检查一次大小，之后**整个进程生命周期再也不检查**。也就是说
 *      插件在启动时文件不到 1MB 的话，这一整轮 DSH 都不会再轮转，
 *      plugin.log 会一直涨下去直到 DSH 重启（DSH 一开就是好几天）。
 *      现在改成"节流检查"：每行只做几次数字比较，真正 stat 文件 /
 *      扫目录最多 60 秒一次 —— 既不拖慢热路径，也真的会轮转。
 *      同时按用户拍板的决定补上"保留 15 天"。
 *
 * 【和后端（卡片 / 设置窗口）约定好的格式，别单方面改】
 *
 *   行格式：[YYYY-MM-DD HH:mm:ss.SSS] [来源] [级别] 内容
 *   来源：  [PLUGIN] / [PANEL] / [SETTINGS]
 *   级别：  [INFO] / [WARN] / [ERR]
 *   保留：  15 天（三份日志同一个策略）
 *   说明详见 方案-日志功能.md 3.3。
 *
 *   注意：**历史日志里的旧格式行不动**。已经写进 plugin.log 的老行是
 *   UTC + 无级别，改不了也没必要改；合并工具要能同时认两种格式。
 *   本次只保证"从现在开始新写的行"是新格式。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

// ---------------------------------------------------------------- 可调参数

/** 主文件超过这个大小就轮转（沿用原来的 1MB，不趁机改，避免这次改动面变大） */
export const MAX_BYTES = 1024 * 1024

/** 日志保留天数（用户拍板：15 天） */
export const LOG_KEEP_DAYS = 15

/**
 * 轮转 / 清理检查的最小间隔。
 *
 * 【为什么要节流】
 *   log() 是热路径（一秒可能调好几次，卡片心跳、状态写入都在用它）。
 *   每次写日志都去 statSync 文件大小、甚至 readdirSync 扫目录，
 *   等于给热路径加一次磁盘 IO —— 这是拿主流程的性能换日志的整洁，不划算。
 *   折中：写日志时只做几次数值比较（微秒级），真正干活的部分 60 秒才跑一次。
 *
 * 【为什么是 60 秒】
 *   按一天 500 行 / 35KB 的实测速率，60 秒最多写进去几百字节，
 *   离 1MB 的轮转阈值差着三个数量级，不可能"撑爆了还没轮转"。
 */
export const MAINTENANCE_INTERVAL_MS = 60 * 1000

/**
 * 轮转失败告警的去重窗口。
 *
 * 【为什么是 10 分钟而不是 60 秒】
 *   维护本身 60 秒跑一次。如果告警也用 60 秒去重，那么在"杀毒软件扫 5 分钟"
 *   这种常见场景里会连写 5 条几乎一样的告警 —— 而它们写进的是**刚刚被清空的**
 *   主文件，等于告警自己又把文件刷大了。
 *   10 分钟足够让"这里有异常"被看见，也远小于 15 天的保留窗口
 *   （哪怕日志量很小也不会在清理时被漏掉）。
 */
const ROTATE_FAIL_WARN_INTERVAL_MS = 10 * 60 * 1000

/**
 * 写日志失败时，内存里最多挂多少条"待补写"。
 *
 * 【为什么要补写】
 *   写日志失败最常见的原因是"文件被短暂占用"（杀毒软件扫描、备份软件读取、
 *   或者我们自己刚做完 rename 轮转）。这类失败几秒后就自己好了，
 *   但如果失败时什么都不做，那一行日志就永久丢了 —— 而丢的往往正是
 *   出事那一刻的关键记录（出事时文件操作最频繁，被占用的概率最高）。
 *
 * 【为什么有上限】
 *   万一日志系统长期坏掉（磁盘满、目录被删），队列会无限增长，
 *   最后把 DSH 的内存吃光 —— 那就从"日志不好使"升级成"插件把宿主搞崩"。
 *   50 条足够覆盖短时间的占用，也不至于撑爆内存。
 */
const MAX_PENDING = 50

// ---------------------------------------------------------------- 级别自动识别
//
// 【为什么要自动识别级别，而不是挨个改调用点】
//   项目里已经有几十处 log('xxx失败: ...') 这种调用（index.js / lib/*.js）。
//   它们现在统统记成 INFO —— 也就是说"拉起卡片失败"和"节假日数据已就绪"
//   在日志里长得一模一样，合并之后根本挑不出错误。
//   给每一处都改成 log.err(...) 是更"干净"的做法，但要动几十行代码，
//   而这次改动的首要原则是"不能碰坏主流程"。所以：默认按内容猜级别。
//
// 【规则：怎么猜】
//   只看 message 本身（不看 extra 里的 JSON —— 那里面常有 "error": 字段，
//   拿它判断会把一堆正常日志误判成错误）。
//   ① 命中"失败类"词 → ERR
//   ② 否则命中"不对劲但不一定是失败"的词 → WARN
//   ③ 都没有 → INFO
//   ERR 优先于 WARN：一句话里同时有"失败"和"忽略"，那它仍然是个失败。
//
// 【规则：为什么要先剥掉括号里的内容】
//   启动那行是 log('插件启动 v0.5.2 (修复点卡片后卡片消失 + 崩溃自动恢复)')。
//   括号里的"崩溃"是**描述这次修了什么**，不是这次启动崩了。
//   不剥括号的话，每次启动的第一行都会被标成 [ERR] —— 一打开日志就是红的，
//   这种"狼来了"会让人直接无视级别。
//   括号里的内容通常是补充说明/限定条件，真正的动作在括号外，
//   这条判断对现有几十处调用都成立，所以值得为它多跑一次 replace。
//
// 【每条关键词是怎么定下来的，不是拍脑袋】
//   我把 index.js / lib/*.js 里 **98 条真实调用点原文** 逐条喂给这个函数，
//   人眼核对结果（工具留在 _lab/check-log-levels.mjs，可以随时重跑复核）。
//   最终只留"在这个项目里确实只表示失败"的词，宁可漏判（记成 INFO，
//   大不了人肉翻）也不要误判（把正常日志染红，级别就废了）。
//
//   几个刻意加进去、看着有点"具体"的词，说明理由：
//   · 找不到 / 取不到：项目里只出现在"找不到卡片主程序""取不到 DSH 网页地址"
//     这两类**硬失败**上。注意"不存在"没放进 ERR ——
//     '心跳文件不存在（卡片从没启动过）' 是启动瞬间的正常状态，不是错误。
//   · 请手动：凡是让用户"手动跑一下 xxx.bat"的，都是自动流程已经放弃了
//     （两种启动策略都失败 / 连续异常退出不再恢复 / 重启到达上限）。
//     这类是**必须让人看见**的，标 WARN 会被淹没。
//   · 没收到：'策略启动后 N 毫秒内没收到心跳'。
const ERR_RE = /失败|出错|错误|异常|报错|抛错|崩溃|无法|没能|没成功|未成功|没收到|取不到|找不到|超时|拒绝|致命|丢失|请手动|error|fail|exception|crash|timeout|fatal/i
const WARN_RE = /警告|可疑|降级|兜底|回退|过期|陈旧|忽略|跳过|不可用|不存在|重试|换策略|warn|fallback|retry|stale|skip/i
const PAREN_RE = /[（(][^）)]*[）)]/g

/**
 * 按内容猜一条日志的级别。纯函数，方便单测。
 *
 * 注意：这是"猜"，不是"事实"。真正需要精确级别的地方，调用方直接用
 * log.warn() / log.err()，那条路径**不会**再被这段规则改写 —— 调用方的
 * 明确意图优先于关键词猜测。
 *
 * @param {string} message
 * @returns {'INFO'|'WARN'|'ERR'}
 */
export function classifyLevel(message) {
  const text = String(message ?? '')
  if (!text) return 'INFO'

  // 快路径：绝大多数句子没有括号，省掉一次 replace 的内存分配
  const hasParen = text.includes('(') || text.includes('（')
  const bare = hasParen ? text.replace(PAREN_RE, '') : text

  if (ERR_RE.test(bare)) return 'ERR'
  if (WARN_RE.test(bare)) return 'WARN'
  return 'INFO'
}

// ---------------------------------------------------------------- 时间格式化

const pad2 = (n) => (n < 10 ? `0${n}` : String(n))
const pad3 = (n) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n))

/**
 * 本地时间，形如 2026-10-29 23:09:24.914。
 *
 * 【为什么不用 toISOString()】
 *   toISOString 是 UTC。原来就是这么写的，导致 plugin.log 和 panel.log
 *   差 8 小时（见文件头 ①）。这里改用 Date 的本地取时方法逐个拼，
 *   好处是**跟用户系统时区走**：用户在东八区就是东八区，
 *   出国/改时区也不会出现"日志时间跟文件名对不上"。
 *
 * 【为什么带毫秒】
 *   排查"双击变单击""动画卡住""心跳差 200ms"这类问题时，
 *   秒级粒度看不出先后顺序，必须毫秒。
 *
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatLocalTimestamp(nowMs = Date.now()) {
  const d = new Date(nowMs)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `.${pad3(d.getMilliseconds())}`
}

/**
 * 轮转文件名里的时间戳，形如 20261029-231027（本地时间）。
 *
 * 【为什么和卡片那边用同一个形状】
 *   卡片（Panel.ps1）轮转出来的是 panel.yyyyMMdd-HHmmss.log。三份日志
 *   用同一套命名，将来写"清理/合并工具"时一条正则就能覆盖全部，
 *   不用为每个进程记一套规则。
 *
 * 【为什么不按天命名（比如 plugin.2026-10-29.log）】
 *   一天里轮转两次会重名，第二次的 rename 会**直接覆盖**第一次 ——
 *   而且 rename 覆盖不报错，就是静默丢一整天的日志。
 *   精确到秒之后撞名只剩"同一秒内两次轮转"这一种极窄的情况，
 *   再由 pickRotateTarget() 加 -2 后缀兜掉，就彻底不会覆盖了。
 *   代价是文件名长一点，但日志文件名没人天天看。
 */
function formatFileStamp(nowMs) {
  const d = new Date(nowMs)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/** 把字符串转成能安全放进正则的字面量（stem 一般是 plugin，这里只是防御） */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------------------------------------------------------------- 工厂

/**
 * 造一个日志函数。
 *
 * 【签名为什么不变】
 *   index.js / lib/*.js 里已经有几十处 log('xxx') 和 log('xxx', obj)，
 *   全都在别的模块里。改签名就得改几十处调用点，而每改一处都可能改错 ——
 *   风险远大于收益。所以返回值仍然是 (message, extra) => void，
 *   默认按内容猜级别（见 classifyLevel）。
 *
 *   需要明确级别的**新**调用，用挂在函数上的方法：
 *     log.warn('xxx') / log.err('xxx') / log.info('xxx')
 *   老调用一行都不用改。
 *
 * @param {string} logPath 完整日志文件路径（一般是 <数据目录>/plugin.log）
 * @param {object} [options]
 * @param {boolean} [options.echo] 是否同时打到 console（调试用）
 * @param {string} [options.source] 来源标记，默认 'PLUGIN'
 * @returns {(msg: string, extra?: unknown) => void}
 */
export function createLogger(logPath, options = {}) {
  const echo = options.echo === true
  const source = typeof options.source === 'string' && options.source.trim()
    ? options.source.trim()
    : 'PLUGIN'

  const dir = dirname(logPath)

  // 轮转文件的前缀从主文件名推，而不是写死 'plugin' ——
  // 这样单测可以拿 app.log 之类的临时文件名跑同一套逻辑。
  const stem = basename(logPath).replace(/\.log$/i, '') || 'log'
  // 严格匹配：<stem>.yyyyMMdd-HHmmss.log（末尾可选 -2 / -3 这类去重后缀，见 pickRotateTarget）
  const rotatedRe = new RegExp(`^${escapeRe(stem)}\\.\\d{8}-\\d{6}(-\\d+)?\\.log$`)
  // v0.9.14 及更早版本的轮转名。<stem>.old.log 不再被生成，
  // 但用户机器上可能残留一个，所以要能在过期后一并清掉（见 pruneOld）。
  const legacyName = `${stem}.old.log`

  let dirReady = false
  /** 上次真正做轮转/清理的时间；0 表示还没做过 → 第一次写日志时做一次 */
  let lastMaintenanceAt = 0
  /**
   * 上次因为"改名失败被迫清空主文件"而报警的时间。
   *
   * 【为什么要这个去重（D4 第五类问题）】
   *   改名失败通常不会只失败一次：杀毒软件扫描一个 1MB 文件可能要几秒，
   *   备份软件占用更久。这期间每 60 秒维护一次、每次都会走"清空主文件"的
   *   兜底分支 —— 如果每次都写一条告警，告警本身会把刚清空的主文件重新刷大。
   *   所以同类告警 10 分钟最多一条：足够让人看见，又不会自己变成新的刷屏源。
   */
  let lastRotateFailWarnAt = 0
  /**
   * 距上次检查大概写了多少字符。
   * 【为什么用字符数近似字节数】中文一个字是 3 字节，这里算 1。
   * 它只用来回答"要不要提前去看一眼文件有多大了"，宁可早查不可漏查；
   * 误差最多让检查提前一点，不影响正确性，也省掉每次 Buffer.byteLength 的开销。
   */
  let charsSinceMaintenance = 0
  /** 写失败的那几行，等下次写成功时一起补上 */
  const pending = []

  const ensureDir = () => {
    if (dirReady) return
    try {
      mkdirSync(dir, { recursive: true })
      dirReady = true
    } catch { /* 建不出目录就算了，后面写文件自然会失败并走补写队列 */ }
  }

  /**
   * 删掉超过保留天数的轮转文件。
   *
   * 【⚠️ 这是"删文件"操作，匹配必须窄到不可能误伤】
   *   只认两种名字：
   *     · <stem>.<8位日期>-<6位时间>[-N].log  ← 我们自己轮转出来的（-N 是撞名去重后缀）
   *     · <stem>.old.log                     ← 老版本的轮转名（过渡期清理）
   *
   *   绝对不能按 plugin*.log 一把删：同一个目录里还躺着
   *     plugin.log（主文件，正在用）
   *     panel.log / panel-debug.log（卡片写的）
   *     settings.log（设置窗口写的）
   *     probe.log（用户/我们临时排错留的）
   *   其中任何一个被误删，都可能是别人正在查问题的唯一线索。
   *   名字必须**逐字符**匹配上面两种形状，多一个点少一个数字都不删。
   *
   * @param {number} nowMs
   */
  const pruneOld = (nowMs) => {
    const cutoffMs = nowMs - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return // 目录不存在/没权限，下次再说
    }
    for (const name of names) {
      if (!rotatedRe.test(name) && name !== legacyName) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue          // 同名目录不碰
        if (st.mtimeMs >= cutoffMs) continue // 还没过期
        unlinkSync(full)
      } catch {
        // 单个文件处理失败（被占用 / 刚好被别人删了）不影响其他文件。
        // 这里绝不能往外抛：删日志失败不是 DSH 需要知道的事。
      }
    }
  }

  /**
   * 挑一个还没被别人占用的轮转文件名。
   *
   * 【为什么需要这一步 —— 这是一个真的会丢日志的坑】
   *   文件名精确到秒（plugin.yyyyMMdd-HHmmss.log）。如果同一秒内触发了两次轮转，
   *   第二次的 renameSync 会**直接覆盖**第一次的文件 —— 而且不报错。
   *   什么时候会同一秒轮转两次？磁盘写满时 rename 一直失败、或者被占用，
   *   每次维护都会走到"清空主文件"的兜底分支，一旦某次突然能 rename 了……
   *   概率不高，但代价是"静默丢一整段日志"，而丢的正是出事那段。
   *   所以：撞名就加 -2 / -3 后缀，宁可文件名丑，也不覆盖。
   *
   * 【为什么只试到 -9 就放弃】
   *   同一秒撞 9 次说明目录里已经堆了异常多的轮转文件，
   *   再往下试只是白花 IO；这时返回 null，调用方走"清空主文件"兜底。
   *
   * @param {number} nowMs
   * @returns {string|null} 可用的完整路径，或 null（实在挑不出来）
   */
  const pickRotateTarget = (nowMs) => {
    const base = `${stem}.${formatFileStamp(nowMs)}`
    for (let n = 1; n <= 9; n++) {
      const name = n === 1 ? `${base}.log` : `${base}-${n}.log`
      const full = join(dir, name)
      if (!existsSync(full)) return full
    }
    return null
  }

  /**
   * 轮转 + 清理。最多 60 秒跑一次（见 MAINTENANCE_INTERVAL_MS）。
   * @param {number} nowMs
   */
  const runMaintenance = (nowMs) => {
    lastMaintenanceAt = nowMs
    charsSinceMaintenance = 0
    ensureDir()

    // ---- ① 主文件超限就轮转
    try {
      const size = existsSync(logPath) ? statSync(logPath).size : 0
      if (size >= MAX_BYTES) {
        const target = pickRotateTarget(nowMs)
        let rotated = false
        if (target) {
          try {
            renameSync(logPath, target)
            rotated = true
          } catch { /* 落到下面的兜底 */ }
        }
        if (!rotated) {
          // 改名失败（多半是主文件正被杀毒/备份软件占用）就退一步：把主文件清空。
          // 宁可丢历史，也不能让它无限长下去 —— 磁盘写满会让整个卡片
          // 出更奇怪的问题（状态文件写不进去、心跳更新不了），那才是大事故。
          //
          // 【D4 第五类问题：清空前必须留痕】
          //   原来是**纯静默**清空的：用户事后只会发现"日志莫名短了一截"，
          //   完全不知道丢的是哪一段、为什么丢、丢了多少 —— 而这正是
          //   最需要日志的时刻（改名失败说明有别的程序在抢这个文件）。
          //   现在先往清空后的主文件里写一条 WARN 说明情况。
          //   写这条本身也可能失败，那就真的什么都做不了了（下面那个空 catch）。
          const lostBytes = size
          try { writeFileSync(logPath, '', 'utf8') } catch { /* 连清空都失败：下次再试 */ }
          if (nowMs - lastRotateFailWarnAt >= ROTATE_FAIL_WARN_INTERVAL_MS) {
            lastRotateFailWarnAt = nowMs
            try {
              writeLine(
                `[${formatLocalTimestamp(nowMs)}] [${source}] [WARN] ` +
                `日志轮转失败（目标文件名被占用或目录不可写），已清空主文件以控制大小；` +
                `丢失约 ${lostBytes} 字节历史（大约最近的一段记录）。` +
                `常见原因是杀毒/备份软件正在读取该文件，稍后会自动恢复。` +
                `本条同类告警 ${Math.round(ROTATE_FAIL_WARN_INTERVAL_MS / 60000)} 分钟内只记一次。\n`,
              )
            } catch { /* 告警本身写不进去也不能影响主流程 */ }
          }
        }
      }
    } catch { /* 维护失败不影响写日志，60 秒后还会再试 */ }

    // ---- ② 删掉过期的轮转文件
    try { pruneOld(nowMs) } catch { /* 同上 */ }
  }

  /** 把一行写进文件，失败就挂到待补写队列 */
  const writeLine = (text) => {
    ensureDir()
    // 之前失败没写进去的先补上，拼成本次的一次写入（少一次 IO）
    const payload = pending.length ? pending.join('') + text : text
    try {
      appendFileSync(logPath, payload, 'utf8')
      if (pending.length) pending.length = 0
      charsSinceMaintenance += payload.length
    } catch {
      // 绝不能往外抛：日志失败绝不允许影响 DSH 主流程。
      // 这是本文件最重要的一条纪律 —— 日志是"旁路"，不是"功能"。
      try {
        if (pending.length < MAX_PENDING) pending.push(text)
      } catch { /* 连入队都失败就算了 */ }
    }
  }

  /** 拼出一整行（不含换行符） */
  const buildLine = (level, message, extra, nowMs) => {
    let body = String(message ?? '')
    // 一行必须只有一条记录：message 里如果带了换行（比如拼进去的异常原文），
    // 后面的行会缺 [时间][来源][级别]，合并/正则解析时整段错位。
    // 换成 ⏎ 既保住可读性，又不会把"一条日志"拆成两行。
    if (body.includes('\n') || body.includes('\r')) {
      body = body.replace(/\r\n|\r|\n/g, ' ⏎ ')
    }
    if (extra !== undefined) {
      try {
        body += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))
      } catch {
        body += ' <无法序列化>'
      }
    }
    return `[${formatLocalTimestamp(nowMs)}] [${source}] [${level}] ${body}`
  }

  /**
   * 统一写入口。
   * @param {'INFO'|'WARN'|'ERR'} level
   * @param {string} message
   * @param {unknown} extra
   */
  const write = (level, message, extra) => {
    const nowMs = Date.now()
    const line = buildLine(level, message, extra, nowMs)

    if (echo) {
      try { console.log('[dsh-floating-window]', line) } catch { /* ignore */ }
    }

    // 维护的门槛判断只有两次数值比较（纳秒级），真正花钱的部分在里面 60 秒才跑一次。
    // 第二个条件（charsSinceMaintenance）是保险：万一 60 秒内就写了接近 1MB
    // （比如某个循环在刷屏），也立刻去看一眼大小，不用等到下一个整分钟。
    if (nowMs - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS || charsSinceMaintenance >= MAX_BYTES) {
      runMaintenance(nowMs)
    }

    writeLine(line + '\n')
  }

  /**
   * 老调用点用的入口：签名 (message, extra)，级别按内容自动猜。
   * @type {((msg: string, extra?: unknown) => void) & Record<string, unknown>}
   */
  const log = (message, extra) => write(classifyLevel(message), message, extra)

  // ---- 明确指定级别的入口（给新代码用；调用方的意图不再被关键词规则改写）
  log.info = (message, extra) => write('INFO', message, extra)
  log.warn = (message, extra) => write('WARN', message, extra)
  log.err = (message, extra) => write('ERR', message, extra)
  // 手滑写成 log.error / log.warning 也别炸（只是别名，行为完全一样）
  log.error = log.err
  log.warning = log.warn

  /**
   * 立刻跑一次轮转 + 清理，不等 60 秒节流。
   * 目前只有单测（test/ 或 _lab/）在用：测试不可能真的等一分钟。
   * 生产代码**不要**调它 —— 它绕过节流，等于给热路径手动加一次磁盘 IO。
   */
  log.maintain = () => runMaintenance(Date.now())

  return log
}
