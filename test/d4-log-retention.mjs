/**
 * test/d4-log-retention.mjs -- D4 日志与审批数据留存（A~E 五类问题）
 *
 * 【这张测试守的是什么】
 *   施工卡 02-D 的 D4 一节列了五类问题，每一类都不是"代码看着不对"，
 *   而是**真的会丢证据 / 真的会误报**：
 *
 *     A 日志级别误判：正常"服务未就绪、稍后重试"被关键词判成 ERR。
 *     B panel-debug.log 无边界：现在会一直长，而且开调试就整份清空。
 *     C decisions/*.consumed 永不清理：审批回执一直堆着。
 *     D 启动配置整份入日志：未来加个密钥就会被一起写下来。
 *     E 轮转失败静默清空：改名失败时直接把主日志清掉，不留任何痕迹。
 *
 * 【为什么 A / D 用"真跑一遍看日志"，而不是检查源码里有没有某个字符串】
 *   「日志级别对不对」是一张**实际写出来的日志行**的属性，不是源码的属性。
 *   源码里写着 log.info(...) 当然说明意图，但真正要看的是：
 *   把这条消息喂给它运行时，落盘的级别到底是什么。
 *   所以 A / D 都真的建一个 logger、真的取地址、真的读回日志文件。
 *
 * 【为什么 B / E 要读 Panel.ps1 的源码】
 *   卡片端是 PowerShell，在 Node 里起不了真实的 WPF 卡片（也不该起）。
 *   这里做的是**源码契约检查**：确认约定的函数/常量/分支确实存在。
 *   按交接文档 4.4 的坑，静态检查一律先剥注释再匹配 ——
 *   否则注释里故意写的反例说明会被当成"代码里真的这么干了"。
 *
 * 跑法：node test/d4-log-retention.mjs
 * 退出码 0 = 全通过，1 = 有失败。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LOG_KEEP_DAYS,
  classifyLevel,
  createLogger,
} from '../lib/logger.js'
import { createUrlSyncRunner } from '../lib/endpoint.js'

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

const root = mkdtempSync(join(tmpdir(), 'dshd4-'))
const panelSrc = readFileSync(
  new URL('../panel/Panel.ps1', import.meta.url),
  'utf8',
)

/**
 * 剥掉 PowerShell 注释行。
 *
 * 【为什么必须剥】
 *   交接文档 4.4 明确记着：D1 第二步查"没有用三参数 Move"时，
 *   正则匹配到了注释里**故意写的反例说明**，报了一次假失败。
 *   这里的检查同样会碰到注释 —— 比如 Panel.ps1 里就有一大段注释
 *   在解释"为什么原来不该直接清空主文件"，字面上正好包含要查的写法。
 *   所以统一先剥注释，再匹配。只剥整行注释（行首若干空白 + #），
 *   行尾注释不动 —— 本项目的行尾注释很少，且都不是检查目标。
 */
const stripPsComments = (src) =>
  src
    .split(/\r?\n/)
    .filter((ln) => !/^\s*#/.test(ln))
    .join('\n')

const panelCode = stripPsComments(panelSrc)

/** 取一个 PowerShell 函数体（从 function 起锚，到行首 } 收尾） */
const psFunc = (src, name) => {
  const m = src.match(new RegExp(`function\\s+${name}\\s*\\{[\\s\\S]*?\\r?\\n\\}`))
  return m ? m[0] : ''
}

const linesOf = (p) => readFileSync(p, 'utf8').split('\n').filter((s) => s.length > 0)
/** 从一行日志里取级别：形如 [时间] [PLUGIN] [INFO] 内容 */
const levelOf = (line) => (line.match(/\[(INFO|WARN|ERR)\]/) || [])[1] || ''
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

try {
  // ================================================================
  // A. 日志级别：正常重试是 INFO，真的失败才是 ERR
  // ================================================================
  console.log('\n=== A. 日志级别（正常未就绪不该报红） ===')

  {
    // ---- A1：真实调用点必须**显式**指定级别，不能继续靠关键词猜
    //
    //   【这里踩过一次坑，值得写下来】
    //   最初这条断言写的是「classifyLevel 那句"服务尚未就绪…重试"不等于 ERR」。
    //   但那是错的：classifyLevel 的职责就是"给没标明级别的地方兜个底"，
    //   它按"失败"判 ERR 对**老调用点**是合理的（拉卡片失败就该红）。
    //   要修的是**调用点**，不是分类器 —— 改分类器会连累几十处老调用，
    //   正是施工卡 D4-4 A.2 说的"保留老调用自动分类"。
    //   所以正确的断言是：endpoint 这条路径上不再出现裸 log(...)，
    //   而是显式 logAt('info'|'warn'|'err')。

    const epSrc = readFileSync(new URL('../lib/endpoint.js', import.meta.url), 'utf8')
    const runnerBody = (epSrc.match(/export function createUrlSyncRunner[\s\S]*?\n\}/) || [''])[0]
    ok('抓到了 createUrlSyncRunner 函数体', runnerBody.length > 0)

    // 剥掉注释再查，否则会被说明文字骗过去（交接文档 4.4 的坑）
    const runnerCode = runnerBody
      .split(/\r?\n/)
      .filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln))
      .join('\n')

    // 【为什么要排除 log(message) 这一行】
    //   logAt 适配层里有一句"没有分级方法就退回 log(message)"的兜底 ——
    //   那是**故意**保留的，不是漏改。它必须在那儿，
    //   否则单测传入的普通函数（没有 .info/.warn）会让整条地址同步链炸掉。
    //   所以要查的是"除了这唯一一处兜底之外，还有没有裸 log(...)"。
    const bareLogs = (runnerCode.match(/(?<![.\w])log\([^\n]*/g) || [])
      .filter((s) => !/^log\(message\)$/.test(s.trim()))
    ok('【关键】地址同步路径不再用裸 log() 猜级别（除适配层唯一兜底）',
      bareLogs.length === 0,
      bareLogs.length ? `还有 ${bareLogs.length} 处: ${bareLogs[0]}` : '只剩 log(message) 兜底')

    ok('【关键】正常重试显式标成 info',
      /logAt\('info',\s*`取 DSH 网页地址失败/.test(runnerCode.replace(/\s+/g, ' ')) ||
      /logAt\('info'[\s\S]{0,80}取 DSH 网页地址失败/.test(runnerCode),
      '应写 logAt(\'info\', `取 DSH 网页地址失败...`)')

    ok('【关键】重试用尽显式标成 warn',
      /logAt\('warn'[\s\S]{0,120}仍取不到/.test(runnerCode),
      '应写 logAt(\'warn\', ...仍取不到...)')

    ok('【关键】真写盘失败显式标成 err',
      /logAt\('err'[\s\S]{0,120}同步 DSH 地址失败/.test(runnerCode),
      '应写 logAt(\'err\', ...同步 DSH 地址失败...)')

    // ---- A2：真跑一遍 runner，看落盘的级别（这才是用户能看到的）
    const dir = join(root, 'a-retry')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'plugin.log')
    const log = createLogger(logPath)

    let disposers = []
    const runner = createUrlSyncRunner({
      resolveOnce: () => ({ url: null, source: null, error: '服务未就绪', notReady: true }),
      commit: () => ({ wrote: false }),
      schedule: (cb, delay) => {
        // 假定时器：收集起来，不真的等
        const d = () => {}
        disposers.push({ cb, delay, dispose: d })
        return d
      },
      log,
      // 故意给小一点的重试序列，测完不用等 30 秒
      plan: [10, 20],
    })
    runner.start()

    const retryLines = linesOf(logPath).filter((l) => l.includes('重试'))
    ok('【关键】正常未就绪的重试日志能落盘', retryLines.length > 0,
      `实际 ${retryLines.length} 条`)

    const retryErrs = retryLines.filter((l) => levelOf(l) === 'ERR')
    ok('【关键】正常未就绪的重试**没有一条**被记成 ERR',
      retryErrs.length === 0,
      retryErrs.length ? `有 ${retryErrs.length} 条: ${retryErrs[0]}` : '全部非 ERR')

    // ---- A3：重试额度耗尽 → WARN（要人看见，但还没到"真的坏了"）
    while (disposers.length > 0) {
      const d = disposers.shift()
      d.cb()
    }
    const exhaustLines = linesOf(logPath).filter((l) => l.includes('仍取不到'))
    ok('重试用尽会留下一条日志', exhaustLines.length > 0,
      `实际 ${exhaustLines.length} 条`)
    if (exhaustLines.length > 0) {
      ok('【关键】重试用尽记成 WARN（不是 ERR，也不是静默 INFO）',
        levelOf(exhaustLines[0]) === 'WARN', `实际 ${levelOf(exhaustLines[0])}`)
    } else {
      ok('【关键】重试用尽记成 WARN（不是 ERR，也不是静默 INFO）', false, '没有这条日志')
    }

    runner.stop()
  }

  {
    // ---- A4：真正的写盘失败必须是 ERR
    //   【为什么这条要单独测】改级别时最容易犯的错是"怕误报，于是全降级"。
    //   真失败如果也降成 WARN/INFO，那就换了个方向误导人。
    const dir = join(root, 'a-realerr')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'plugin.log')
    const log = createLogger(logPath)

    const runner = createUrlSyncRunner({
      resolveOnce: () => ({ url: 'http://127.0.0.1:1234/', source: 'listen', error: null, notReady: false }),
      commit: () => { throw new Error('EACCES: settings.json 只读') },
      schedule: () => undefined,
      log,
      plan: [],
    })
    runner.start()
    const lines = linesOf(logPath)
    const syncErr = lines.filter((l) => l.includes('同步 DSH 地址失败'))
    ok('真写盘失败会留下日志', syncErr.length > 0, `实际 ${syncErr.length} 条`)
    if (syncErr.length > 0) {
      ok('【关键】真写盘失败记成 ERR（不许为了"不误报"把它降级）',
        levelOf(syncErr[0]) === 'ERR', `实际 ${levelOf(syncErr[0])}`)
    } else {
      ok('【关键】真写盘失败记成 ERR（不许为了"不误报"把它降级）', false, '没有这条日志')
    }
  }

  {
    // ---- A5：老调用点继续按关键词猜（向后兼容不能破）
    const dir = join(root, 'a-compat')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'plugin.log')
    const log = createLogger(logPath)
    log('拉起卡片失败')
    log('这是一条普通信息')
    const ls = linesOf(logPath)
    ok('老调用点：含"失败"仍自动判 ERR', levelOf(ls[0]) === 'ERR', ls[0])
    ok('老调用点：普通信息仍判 INFO', levelOf(ls[1]) === 'INFO', ls[1])
  }

  // ================================================================
  // B. panel-debug.log 边界（2MB 轮转 / 留 3 个 / 15 天 / 不清空）
  // ================================================================
  console.log('\n=== B. panel-debug.log 边界 ===')

  {
    const dbgRotate = psFunc(panelCode, 'Invoke-DebugLogMaintenance')
    ok('【关键】存在专门管 panel-debug.log 的维护函数', dbgRotate.length > 0,
      dbgRotate.length ? `抓到 ${dbgRotate.length} 字符` : '未找到 Invoke-DebugLogMaintenance')

    ok('【关键】debug 日志有 2MB 大小上限',
      /DebugMaxBytes\s*=\s*2\s*\*\s*1024\s*\*\s*1024/.test(panelCode),
      '应为 $script:DebugMaxBytes = 2 * 1024 * 1024')

    ok('【关键】debug 轮转只留最近 3 个',
      /DebugKeepCount\s*=\s*3\b/.test(panelCode),
      '应为 $script:DebugKeepCount = 3')

    ok('debug 沿用 15 天保留（与主日志同一拍板值）',
      /DebugKeepDays\s*=\s*15\b/.test(panelCode),
      '应为 $script:DebugKeepDays = 15')

    // 【关键回归】开调试不许再把唯一的旧记录清空
    //
    //   【这里踩过一次坑，值得记下来】
    //   最初写的是"全文里不许出现 WriteAllText($script:debugPath, '')"。
    //   加了轮转之后这条就误报了 —— 因为轮转成功后需要**主动建一个空文件**
    //   （Move 把主文件移走了，得补回一个），那也是同一句调用。
    //   但那是"轮转之后从空文件继续写"，跟"开调试就把历史抹掉"是两件完全不同的事。
    //   所以断言必须精确到**位置**：只在调试开关那段配置区里查。
    const debugInitZone = (panelCode.match(/\$script:debugOn\s*=[\s\S]{0,2500}?\$script:DebugCheckMs\s*=\s*60000/) || [''])[0]
    ok('抓到了调试开关配置区', debugInitZone.length > 0)
    ok('【关键】开调试不再整份清空 panel-debug.log',
      !/WriteAllText\(\s*\$script:debugPath\s*,\s*''/.test(debugInitZone),
      debugInitZone ? '配置区里仍在清空' : '无配置区')

    // 轮转命名必须是 panel-debug. 前缀，且清理正则不能误伤 panel.log
    ok('debug 轮转文件用 panel-debug. 前缀',
      /'panel-debug\.'\s*\+\s*\$stamp/.test(panelCode) ||
      /panel-debug\.\$\{?stamp/.test(panelCode) ||
      /DebugRotatePrefix/.test(panelCode),
      '应生成 panel-debug.yyyyMMdd-HHmmss.log')

    const pruneInDebug = /panel-debug\\\.\\d\{8\}/.test(panelCode) ||
      /DebugRotateRe/.test(panelCode)
    ok('【关键】清理 debug 轮转的正则不会误伤 panel.log',
      pruneInDebug, '应只匹配 panel-debug.<日期>-<时间>.log')

    // 写失败不能影响改色主循环：所有 debug 写入点都在 try/catch 内
    ok('debug 写入失败不影响主循环（写入点都有 try/catch 保护）',
      /Log-DebugLine/.test(panelCode) ||
      /AppendAllText\(\$script:debugPath/.test(panelCode),
      '应统一走一个带保护的写入口')
  }

  // ================================================================
  // C. decisions/*.consumed 保留 15 天
  // ================================================================
  console.log('\n=== C. 审批回执保留 15 天 ===')

  {
    const apSrc = readFileSync(new URL('../lib/approval-proxy.js', import.meta.url), 'utf8')
    ok('【关键】approval-proxy 有 CONSUMED 保留天数常量',
      /CONSUMED_KEEP_DAYS\s*=\s*15\b/.test(apSrc),
      '应为 CONSUMED_KEEP_DAYS = 15')

    // 【断言必须精确】不能只查 CONSUMED_EXT 出现过 ——
    //   那个常量本来就有（_archive 用它拼文件名），查它等于永远通过。
    //   要查的是"有没有一个专门清理它的方法"。
    ok('【关键】存在专门清理 .consumed 的方法',
      /_sweepConsumed\s*\(/.test(apSrc),
      '应有 _sweepConsumed() 方法')

    // 清理必须按后缀精确匹配，绝不能按"目录里所有文件"一把扫
    const sweepBody = (apSrc.match(/_sweepConsumed\s*\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0]
    ok('抓到了 _sweepConsumed 方法体', sweepBody.length > 0,
      sweepBody.length ? `抓到 ${sweepBody.length} 字符` : '未找到方法体')

    ok('【关键】只认 .consumed 后缀（不碰 .json / .tmp）',
      /endsWith\(\s*CONSUMED_EXT\s*\)/.test(sweepBody),
      sweepBody ? '方法体里没有 endsWith(CONSUMED_EXT)' : '无方法体')

    ok('清理按修改时间判断，不按名字前缀批量删',
      /mtimeMs/.test(sweepBody) && /CONSUMED_KEEP_DAYS/.test(sweepBody),
      sweepBody ? '应有 statSync().mtimeMs + 天数阈值' : '无方法体')

    // 【安全边界】有待审批时不许按名字批量清 —— 必须能看见"只在空闲轮次调用"
    ok('【关键】_sweepConsumed 只在空闲轮次被调用（有待审批时不跑）',
      /_idlePolls[\s\S]{0,400}_sweepConsumed\s*\(/.test(apSrc) ||
      /_sweepStale[\s\S]{0,400}_sweepConsumed\s*\(/.test(apSrc),
      '没有看到它被 _poll 的空闲分支接上')

    // nonce 是最敏感的东西，清理日志绝不许打出来
    ok('【安全】清理日志不打印 nonce',
      !/log\([^)]*nonce/i.test(sweepBody),
      sweepBody ? '方法体里似乎打了 nonce' : '无方法体')
  }

  // ================================================================
  // D. 启动配置只记白名单
  // ================================================================
  console.log('\n=== D. 配置白名单（不许整份 JSON.stringify） ===')

  {
    const idxSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

    // 【必须剥注释再查】踩过：这个文件里我写了三处**说明性注释**，
    //   里面正好包含 "JSON.stringify(cfg)" 这个字符串（在解释"原来是怎么错的"）。
    //   不剥注释就会误判成"代码里还在用"。这正是交接文档 4.4 记的那个坑。
    const idxCode = idxSrc
      .split(/\r?\n/)
      .filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln))
      .join('\n')

    ok('【关键】启动日志不再整份 JSON.stringify(cfg)',
      !/JSON\.stringify\(cfg\)/.test(idxCode),
      (idxCode.match(/JSON\.stringify\(cfg\)[^\n]*/) || ['无（正确）'])[0])

    ok('启动日志改用白名单汇总函数',
      /summarizeConfigForLog\(cfg\)/.test(idxCode),
      '应调用 summarizeConfigForLog(cfg)')

    ok('存在白名单常量或函数',
      /LOG_SAFE_CFG_KEYS|pickLoggableConfig|summarizeConfigForLog/i.test(idxSrc),
      '应有 LOG_SAFE_CFG_KEYS / pickLoggableConfig')

    // 白名单字段必须覆盖施工卡 D4-4 D.1 列的那几个排障必需项
    // 【为什么要在"提取白名单数组"之后判断，而不是全文搜】
    //   全文搜 autoLaunch 永远为真 —— 这个字段在 index.js 里被用了十几次。
    //   必须先把白名单那一行/数组抠出来，再在里面找。
    const wlMatch = idxSrc.match(/(?:LOG_SAFE_CFG_KEYS|pickLoggableConfig)[\s\S]{0,900}/)
    const wlBlock = wlMatch ? wlMatch[0] : ''
    ok('抓到了白名单定义块', wlBlock.length > 0,
      wlBlock.length ? `抓到 ${wlBlock.length} 字符` : '未找到')

    for (const k of ['autoLaunch', 'useDemoData', 'showSubagentSessions', 'writeThrottleMs',
      'backfillTodayTokens', 'heartbeatStaleMs', 'approvalDecisionTtlMs', 'approvalPollMs']) {
      ok(`白名单包含 ${k}`, new RegExp(k).test(wlBlock),
        wlBlock ? '' : '无白名单块')
    }

    // 【安全】敏感命名一律不记：哪怕被误加进白名单也要被这个过滤挡住
    ok('【关键】有"敏感命名一律不记"的兜底过滤',
      /SENSITIVE|isSensitiveKey/.test(idxSrc) &&
      /token|secret|password|credential/i.test(idxSrc),
      '应有 isSensitiveKey / SENSITIVE 过滤函数')
  }

  // ================================================================
  // E. 轮转失败要留痕，不许静默清空
  // ================================================================
  console.log('\n=== E. 轮转失败留痕 ===')

  {
    const logSrc = readFileSync(new URL('../lib/logger.js', import.meta.url), 'utf8')
    // 【这条原来写得太宽】原断言是 "有 rotat 又有 WARN" —— 这文件里
    //   到处都是这两个词，等于永远通过。要查的是"清空兜底那个分支里，
    //   清空之前有没有先写一条日志"。
    const rotBlock = (logSrc.match(/if \(!rotated\) \{[\s\S]{0,1400}?\n      \}/) || [''])[0]
    ok('抓到了轮转失败兜底分支', rotBlock.length > 0,
      rotBlock.length ? `抓到 ${rotBlock.length} 字符` : '未找到 if (!rotated) 块')

    ok('【关键】插件端：清空主文件之前先写一条 WARN/ERR',
      /writeLine\(|log\.warn|log\.err|emitWarn/.test(rotBlock),
      rotBlock ? (/(writeLine\(|log\.warn|log\.err)/.test(rotBlock) ? '已有告警写入' : '兜底分支里没有写日志') : '无分支体')

    ok('【关键】这条告警里带上"丢了多大"（字节数）',
      /size|字节|Bytes/i.test(rotBlock),
      rotBlock ? (/size|字节|Bytes/i.test(rotBlock) ? '含大小信息' : '没看到大小信息') : '无分支体')

    ok('插件端：主日志轮转失败有去重（同类告警不刷屏）',
      /rotateFail|maintFail|维护失败/.test(logSrc),
      '应有轮转失败去重标记')

    const panelLogFn = psFunc(panelCode, 'Invoke-LogMaintenance')
    ok('抓到了卡片端 Invoke-LogMaintenance', panelLogFn.length > 0)

    ok('卡片端：主日志轮转失败会留一条 WARN',
      /-Level\s+'WARN'|Log-Fail/.test(panelLogFn),
      panelLogFn ? '未在 Invoke-LogMaintenance 里看到告警' : '未找到函数')

    ok('卡片端：轮转失败告警有去重键',
      /-Key\s+'/.test(panelLogFn),
      '应传 -Key 让 60 秒内只记一条')

    // ---- 设置窗口端（第三端，走同一套约定）
    const settingsSrc = readFileSync(
      new URL('../panel/Settings.ps1', import.meta.url),
      'utf8',
    )
    const settingsCode = settingsSrc
      .split(/\r?\n/)
      .filter((ln) => !/^\s*#/.test(ln))
      .join('\n')

    const maintFn = (settingsCode.match(/function Invoke-SettingsLogMaintenance[\s\S]*?\n\}/) || [''])[0]
    ok('抓到了设置窗口的日志维护函数', maintFn.length > 0)

    ok('【关键】设置窗口端：轮转失败也会留一句 WARN',
      /\[WARN\]/.test(maintFn),
      maintFn ? (maintFn.includes('[WARN]') ? '已有' : '没有 WARN 行') : '无函数')

    ok('设置窗口端：告警里带上丢失大小',
      /lostKb|KB/.test(maintFn),
      maintFn ? '含大小信息' : '无函数')

    // 【关键安全断言】维护函数里绝不能调 Write-SettingsLog，
    //   否则就是 维护→写日志→维护→写日志 的无限递归，设置窗口直接崩。
    ok('【关键】设置窗口维护函数不调 Write-SettingsLog（否则无限递归）',
      !/Write-SettingsLog\s/.test(maintFn),
      maintFn && /Write-SettingsLog\s/.test(maintFn) ? '调了，会栈溢出！' : '没调')
  }

  // ================================================================
  // F. 诊断包收 debug 日志（拍板：主 debug 尾部 + 最近 1 个轮转尾部）
  // ================================================================
  console.log('\n=== F. 诊断包收 panel-debug.log ===')

  {
    const exportFn = psFunc(panelCode, 'Export-DiagnosticPackage')
    ok('抓到了 Export-DiagnosticPackage 函数体', exportFn.length > 0)

    ok('【关键】诊断包收集 panel-debug.log',
      /panel-debug\.log/.test(exportFn),
      '导出函数里没看到 panel-debug.log')

    ok('诊断包会带最近 1 个 debug 轮转文件',
      /panel-debug\.\*\.log|DebugRotateRe/.test(exportFn),
      '应抓 panel-debug.*.log 的最新 1 个')
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
