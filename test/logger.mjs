/**
 * test/logger.mjs -- 验证 lib/logger.js 的 15 天保留 + 新格式 + 向后兼容
 *
 * 这不是"看代码觉得对"的检查，每一步都真的写文件、真的读回来。
 * 跑法：node test/logger.mjs
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
  MAX_BYTES,
  classifyLevel,
  createLogger,
  formatLocalTimestamp,
} from '../lib/logger.js'

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

const root = mkdtempSync(join(tmpdir(), 'dshlog-'))
const lineRe = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(PLUGIN|PANEL|SETTINGS)\] \[(INFO|WARN|ERR)\] (.*)$/

const linesOf = (p) => readFileSync(p, 'utf8').split('\n').filter((s) => s.length > 0)
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
const safeName = (p) => p.replace(root, '<tmp>')

try {
  // ================================================================ 1. 格式
  console.log('\n=== 1. 新格式 ===')
  {
    const dir = join(root, 'fmt')
    const p = join(dir, 'plugin.log')
    const log = createLogger(p)
    log('插件启动 v0.9.14')
    log('拉起卡片失败', { error: 'spawn ENOENT' })
    log.warn('卡片心跳 9 秒没更新，先按不可用处理')
    log.err('写 state.json 失败', { code: 'EPERM' })

    const lines = linesOf(p)
    ok('写出了 4 行', lines.length === 4, `实际 ${lines.length}`)
    for (const [i, ln] of lines.entries()) {
      const m = lineRe.exec(ln)
      ok(`第 ${i + 1} 行符合 [时间] [PLUGIN] [级别] 内容`, m !== null, ln)
    }
    ok('第 1 行自动判 INFO', (lineRe.exec(lines[0]) || [])[3] === 'INFO', lines[0])
    ok('第 2 行自动判 ERR（含"失败"）', (lineRe.exec(lines[1]) || [])[3] === 'ERR', lines[1])
    ok('第 3 行 log.warn 生效', (lineRe.exec(lines[2]) || [])[3] === 'WARN', lines[2])
    ok('第 4 行 log.err 生效', (lineRe.exec(lines[3]) || [])[3] === 'ERR', lines[3])
    ok('extra 对象被序列化进同一行', lines[3].includes('"code":"EPERM"'), lines[3])
    ok('来源标记固定是 PLUGIN', lines.every((l) => l.includes('[PLUGIN]')))
  }
  {
    // 带括号的启动行（真实 index.js 的第一句就是这个形状）
    const p = join(root, 'fmt2', 'plugin.log')
    const log = createLogger(p)
    log('插件启动 v0.5.2 (修复点卡片后卡片消失 + 崩溃自动恢复)')
    ok('括号里的"崩溃"不算错误', linesOf(p)[0].includes('[INFO]'), linesOf(p)[0])
  }

  // ================================================================ 2. 本地时间
  console.log('\n=== 2. 本地时间（不是 UTC）===')
  {
    const p = join(root, 'time', 'plugin.log')
    const log = createLogger(p)
    const before = new Date()
    log('时间检查')
    const after = new Date()
    const line = linesOf(p)[0]
    const ts = line.slice(1, line.indexOf(']'))
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(ts)
    ok('时间戳形状是 YYYY-MM-DD HH:mm:ss.SSS', m !== null, ts)
    ok('结尾没有 Z（不是 UTC 标记）', !ts.endsWith('Z'), ts)

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const localHour = Number(m[4])
    ok(
      '小时数 = 本地小时',
      localHour === before.getHours() || localHour === after.getHours(),
      `日志 ${localHour} 点 / 本地 ${before.getHours()} 点 / 时区 ${tz}`,
    )
    const utcParts = `${before.getUTCFullYear()}-${String(before.getUTCMonth() + 1).padStart(2, '0')}-${String(before.getUTCDate()).padStart(2, '0')} ` +
      `${String(before.getUTCHours()).padStart(2, '0')}:${String(before.getUTCMinutes()).padStart(2, '0')}`
    console.log(`     本地日志 ${ts}  /  UTC 对照 ${utcParts}.${String(before.getUTCSeconds()).padStart(2, '0')}（时区 ${tz}）`)
    ok(
      '日志时间 = 本地时钟（不是 UTC，差 8 小时就是错的）',
      Math.abs(before.getTime() - Date.parse(ts.replace(' ', 'T'))) < 3000,
      `与本地时钟差 ${Math.abs(before.getTime() - Date.parse(ts.replace(' ', 'T')))}ms`,
    )

    // 毫秒必须真的在动（不是永远 .000）
    const p2 = join(root, 'time2', 'plugin.log')
    const log2 = createLogger(p2)
    for (let i = 0; i < 30; i++) log2('tick ' + i)
    // 行形如 [2026-10-29 23:38:30.406] …，毫秒是第 21..23 个字符
    const msSet = new Set(linesOf(p2).map((l) => l.slice(21, 24)))
    ok('毫秒字段真的有值（不是一直 000）', msSet.size > 1, `出现 ${msSet.size} 种毫秒`)

    const fixed = new Date(2026, 9, 29, 15, 9, 24, 914).getTime()
    ok('formatLocalTimestamp 与本地取时逐位一致', formatLocalTimestamp(fixed) === '2026-10-29 15:09:24.914', formatLocalTimestamp(fixed))
  }

  // ================================================================ 3. 级别自动识别
  console.log('\n=== 3. 级别自动识别（真实调用点原文）===')
  {
    const cases = [
      ['拉起卡片失败', 'ERR'],
      ['卡片启动失败（detached）: spawn ENOENT', 'ERR'],
      ['写 state.json 失败', 'ERR'],
      ['审批代理初始化异常: boom', 'ERR'],
      ['计算峰谷失败', 'ERR'],
      ['回填异常: timeout', 'ERR'],
      ['卡片已退出：心跳文件不存在（卡片从没启动过）', 'WARN'],
      ['两种启动策略都没成功。请手动跑 panel\\run-panel.bat 看报错。', 'ERR'],
      ['插件启动 v0.9.14', 'INFO'],
      ['配置: {"dataDir":"","autoLaunch":true}', 'INFO'],
      ['节假日数据已就绪', 'INFO'],
      ['已启动卡片（attached 策略，pid=33956）', 'INFO'],
      ['回填成功：911055478 Token / 8376ms / 0 个标题', 'INFO'],
      ['卡片已在运行（pid=33956，心跳 1 秒前）', 'INFO'],
      ['自动重启以加载新版本', 'INFO'],
      ['旧代码检测异常（已忽略）: boom', 'ERR'],
      ['演示模式开启（useDemoData=true）：不接真实数据', 'INFO'],
    ]
    for (const [msg, want] of cases) {
      const got = classifyLevel(msg)
      ok(`${want} ← ${msg.slice(0, 42)}`, got === want, `实得 ${got}`)
    }
    ok('ERR 优先于 WARN（"失败...忽略"仍是 ERR）', classifyLevel('刷新失败，已忽略') === 'ERR')
    ok('空消息不炸', classifyLevel('') === 'INFO' && classifyLevel(undefined) === 'INFO')
  }

  // ================================================================ 4. 向后兼容
  console.log('\n=== 4. 向后兼容（老调用点一行不用改）===')
  {
    const p = join(root, 'compat', 'plugin.log')
    const log = createLogger(p)
    ok('返回值是函数', typeof log === 'function')
    ok('签名 (message, extra)：单参数可调', log('只有消息') === undefined)
    ok('两参数（日志对象）可调', log('带对象', { agents: 1 }) === undefined)
    ok('extra 是字符串也不炸', log('带字符串', 's') === undefined)
    ok('extra 循环引用不炸（走 <无法序列化>）', (() => {
      const a = {}
      a.self = a
      log('循环引用', a)
      return true
    })())
    ok('循环引用那行有标记', linesOf(p).some((l) => l.includes('<无法序列化>')))
    ok('挂了 log.warn', typeof log.warn === 'function')
    ok('挂了 log.err', typeof log.err === 'function')
    ok('挂了 log.info', typeof log.info === 'function')
    const tags = linesOf(p).map((l) => (lineRe.exec(l) || [])[3])
    ok('默认级别 INFO（"只有消息"那行）', tags[0] === 'INFO', String(tags[0]))
    ok('多行 message 被压成一行（不会把日志结构拆坏）', (() => {
      const q = join(root, 'multiline', 'plugin.log')
      const l2 = createLogger(q)
      l2('第一段\n第二段\r\n第三段')
      const ls = linesOf(q)
      return ls.length === 1 && ls[0].includes('⏎') && lineRe.test(ls[0])
    })())
  }

  // ================================================================ 5. 1MB 轮转
  console.log('\n=== 5. 超过 1MB 轮转 ===')
  {
    const dir = join(root, 'rotate')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'plugin.log')
    // 先造一个已经超限的主文件（模拟插件跑了很久）
    writeFileSync(p, 'x'.repeat(MAX_BYTES + 1), 'utf8')
    const log = createLogger(p)
    log('轮转后的第一条')
    const names = readdirSync(dir)
    const rotated = names.filter((n) => /^plugin\.\d{8}-\d{6}\.log$/.test(n))
    ok('生成了带日期时间戳的轮转文件', rotated.length === 1, rotated.join(','))
    ok('轮转文件保留了旧内容', rotated.length === 1 && statSync(join(dir, rotated[0])).size > MAX_BYTES)
    ok('主文件只剩新的一行', linesOf(p).length === 1 && linesOf(p)[0].includes('轮转后的第一条'))
    ok('不再产生老名字 plugin.old.log', !existsSync(join(dir, 'plugin.old.log')))
    // 再写几条，不该再轮转（主文件现在很小）
    log('第二条')
    log('第三条')
    ok('小文件不会被反复轮转', readdirSync(dir).filter((n) => /^plugin\.\d{8}-\d{6}\.log$/.test(n)).length === 1)
    ok('轮转过程中日志没丢', linesOf(p).length === 3)

    // ---- 撞名去重：同一秒内第二次轮转不能覆盖第一次
    const stamp = new Date()
    const pad2 = (n) => String(n).padStart(2, '0')
    const sameSec = `${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}` +
      `-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}${pad2(stamp.getSeconds())}`
    const first = join(dir, `plugin.${sameSec}.log`)
    writeFileSync(first, '第一次轮转的内容（不能被覆盖）\n', 'utf8')   // 冒充"同一秒已经轮转过一次"
    writeFileSync(p, 'y'.repeat(MAX_BYTES + 1), 'utf8')
    const log2 = createLogger(p)
    log2('撞名后的第二条')
    ok('同一秒撞名时加了 -2 后缀，没有覆盖旧文件', existsSync(join(dir, `plugin.${sameSec}-2.log`)))
    ok('第一次轮转的内容还在', readFileSync(first, 'utf8').includes('不能被覆盖'))
  }

  // ================================================================ 6. 15 天清理
  console.log('\n=== 6. 15 天保留 + 不误删邻居 ===')
  {
    const dir = join(root, 'prune')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'plugin.log')

    const make = (name, days, content) => {
      const full = join(dir, name)
      writeFileSync(full, content ?? `content of ${name}\n`, 'utf8')
      const t = daysAgo(days)
      utimesSync(full, t, t)
      return full
    }

    // —— 应该被删：过期的轮转文件
    const old1 = make('plugin.20261001-120000.log', LOG_KEEP_DAYS + 5)
    const old2 = make('plugin.20260920-080000.log', 40)
    const old3 = make('plugin.20260925-080000-2.log', 30)   // 撞名去重后的名字，也算轮转文件
    const legacy = make('plugin.old.log', LOG_KEEP_DAYS + 1)   // 老版本残留，也该清
    // —— 应该保留：还没到 15 天
    const keep1 = make('plugin.20261020-120000.log', LOG_KEEP_DAYS - 1)
    const keep2 = make('plugin.20261028-120000.log', 1)
    // —— 必须绝对保留的"邻居"（名字像但不是我们的轮转文件）
    const keepMain = make('plugin.log', 60, 'main file\n')
    const keepPanel = make('panel.log', 60, 'panel\n')
    const keepPanelOld = make('panel.20200101-000000.log', 60, 'panel rotated\n')
    const keepDebug = make('panel-debug.log', 60, 'debug\n')
    const keepProbe = make('probe.log', 60, 'probe\n')
    const keepTxt = make('plugin.20261001-120000.log.txt', 60, 'not a log\n')
    const keepOther = make('myplugin.20261001-120000.log', 60, 'other plugin\n')
    const keepShop = make('plugin.2026101-120000.log', 60, 'wrong digit count\n')
    // -N 后缀只接受纯数字；别的字符一律不认（防止放宽之后误伤）
    const keepBadSuffix = make('plugin.20261001-120000-x.log', 60, 'bad suffix\n')
    const keepTwoDashes = make('plugin.20261001-120000-2-3.log', 60, 'double suffix\n')
    const keepNoTime = make('plugin.log.bak', 60, 'bak\n')
    // —— 同名但其实是目录：不能去删
    const dirDecoy = join(dir, 'plugin.20200101-000000.log')
    mkdirSync(dirDecoy)

    const log = createLogger(p)
    log('启动，触发一次清理')   // 第一次写日志就会跑维护

    const gone = (f) => !existsSync(f)
    ok('20 天前的轮转文件被删', gone(old1), safeName(old1))
    ok('40 天前的轮转文件被删', gone(old2), safeName(old2))
    ok('30 天前的 -2 去重文件被删（也认这个形状）', gone(old3), safeName(old3))
    ok('15 天前的老名字 plugin.old.log 被删（过渡清理）', gone(legacy), safeName(legacy))
    ok('14 天前的轮转文件保留（边界内）', !gone(keep1), safeName(keep1))
    ok('1 天前的轮转文件保留', !gone(keep2), safeName(keep2))
    ok('主文件 plugin.log 没被删', !gone(keepMain))
    ok('邻居 panel.log 没被删', !gone(keepPanel))
    ok('邻居 panel.20200101-000000.log 没被删', !gone(keepPanelOld))
    ok('邻居 panel-debug.log 没被删', !gone(keepDebug))
    ok('邻居 probe.log 没被删', !gone(keepProbe))
    ok('plugin.20261001-120000.log.txt（后缀不同）没被删', !gone(keepTxt))
    ok('myplugin.20261001-120000.log（前缀不同）没被删', !gone(keepOther))
    ok('plugin.2026101-120000.log（位数不对）没被删', !gone(keepShop))
    ok('plugin.20261001-120000-x.log（后缀不是数字）没被删', !gone(keepBadSuffix))
    ok('plugin.20261001-120000-2-3.log（双重后缀）没被删', !gone(keepTwoDashes))
    ok('plugin.log.bak 没被删', !gone(keepNoTime))
    ok('同名目录没被删', existsSync(dirDecoy) && statSync(dirDecoy).isDirectory())

    // 再看看清理之后目录里剩什么，人工可核对
    ok(
      '目录里剩下的都在预期名单内',
      readdirSync(dir).sort().join(',') ===
        [
          'myplugin.20261001-120000.log',
          'panel-debug.log',
          'panel.20200101-000000.log',
          'panel.log',
          'plugin.20200101-000000.log',   // 这个是目录
          'plugin.20261001-120000.log.txt',
          'plugin.20261001-120000-x.log',
          'plugin.20261001-120000-2-3.log',
          'plugin.2026101-120000.log',
          'plugin.20261020-120000.log',
          'plugin.20261028-120000.log',
          'plugin.log',
          'plugin.log.bak',
          'probe.log',
        ].sort().join(','),
      readdirSync(dir).sort().join(','),
    )
  }

  // ================================================================ 7. 手动维护钩子
  console.log('\n=== 7. log.maintain()：测试用的"立刻清理"钩子 ===')
  {
    const dir = join(root, 'maintain')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'plugin.log')
    const log = createLogger(p)
    log('第一条（首次写入会顺带做一次维护）')
    ok('log.maintain 是个函数', typeof log.maintain === 'function')

    // 造一个刚过期几秒的轮转文件，再手动触发清理。
    // 为什么要测这个：60 秒节流意味着正常写日志不可能在测试里触发第二次维护，
    // 没有这个钩子，"清理逻辑"在单测里就成了不可验证的代码。
    const stale = join(dir, 'plugin.20200101-000000.log')
    writeFileSync(stale, 'stale\n', 'utf8')
    const t = daysAgo(LOG_KEEP_DAYS + 1)
    utimesSync(stale, t, t)
    ok('清理前文件在', existsSync(stale))
    log.maintain()
    ok('log.maintain() 立刻清掉了过期文件（没等 60 秒）', !existsSync(stale))
    ok('log.maintain() 没有抛错也没写坏主文件', linesOf(p).length === 1 && lineRe.test(linesOf(p)[0]))
  }

  // ================================================================ 8. 失败隔离
  console.log('\n=== 8. 日志失败不能影响主流程 ===')
  {
    // 路径指向一个"目录"：appendFileSync 必然 EISDIR
    const dir = join(root, 'broken')
    mkdirSync(join(dir, 'plugin.log'), { recursive: true })
    const p = join(dir, 'plugin.log')
    const log = createLogger(p)
    let threw = null
    try {
      log('第一条（会失败）')
      log('第二条（会失败）')
    } catch (e) {
      threw = e
    }
    ok('写失败不抛异常', threw === null, threw && String(threw.message))

    // 补写队列：失败 60 次后把障碍移除，再写一次应该把队列（上限 50 条）冲刷出来
    for (let i = 0; i < 60; i++) log('失败中的第 ' + i)
    rmSync(p, { recursive: true, force: true })
    log('恢复后的第一条')
    const lines = linesOf(p)
    ok('恢复后把挂住的日志补写出来了', lines.length === 51, `实际 ${lines.length} 行（应为 50 条积压 + 1 条新的）`)
    ok('补写的行格式也正确', lines.every((l) => lineRe.test(l)))
    ok('补写顺序是"先积压后新的"', lines[lines.length - 1].includes('恢复后的第一条'))

    // 目录根本建不出来的极端情况（父路径是个文件）
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')
    const log2 = createLogger(join(blocker, 'sub', 'plugin.log'))
    let threw2 = null
    try { log2('这行写不进去') } catch (e) { threw2 = e }
    ok('父路径不可用时也不抛异常', threw2 === null, threw2 && String(threw2.message))
  }

  // ================================================================ 9. 性能
  console.log('\n=== 9. 热路径开销 ===')
  {
    const p = join(root, 'perf', 'plugin.log')
    const log = createLogger(p)
    log('warmup')
    const N = 5000
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < N; i++) log('热路径第 ' + i + ' 次')
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    ok(`${N} 次写入 < 2000ms`, ms < 2000, `${ms.toFixed(0)}ms（${(ms / N * 1000).toFixed(1)}µs/次）`)
    ok('确实写进去了', linesOf(p).length === N + 1)
  }

  // ================================================================ 10. 编码
  console.log('\n=== 10. 文件编码 / 行尾 ===')
  {
    const p = join(root, 'enc', 'plugin.log')
    const log = createLogger(p)
    log('中文内容不能乱码')
    const buf = readFileSync(p)
    ok('没有 BOM', !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf))
    ok('行尾是 LF 不是 CRLF', !buf.includes(0x0d), buf.includes(0x0d) ? '含 0x0D' : '无 0x0D')
    ok('中文正常读回', readFileSync(p, 'utf8').includes('中文内容不能乱码'))

    // 源码文件本身的编码/行尾
    const src = readFileSync(new URL('../lib/logger.js', import.meta.url))
    ok('logger.js 没有 BOM', !(src[0] === 0xef && src[1] === 0xbb && src[2] === 0xbf))
    ok('logger.js 行尾是 LF', !src.includes(0x0d))
  }
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('')
console.log('='.repeat(58))
console.log(`通过 ${pass}   失败 ${fail}`)
if (fail === 0) {
  console.log('全部通过 ✅')
} else {
  console.log('有失败项 ❌')
  for (const n of bad) console.log('  - ' + n)
}
console.log('='.repeat(58))
process.exit(fail === 0 ? 0 : 1)
