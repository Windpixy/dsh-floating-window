/**
 * test/restart-window.mjs -- C3：自动更新重启的空窗与防叠卡
 *
 * ---------------------------------------------------------------------------
 * 【这个测试守的是什么问题】
 * ---------------------------------------------------------------------------
 * 现状（v0.10.8 及之前）的代码更新重启流程：
 *
 *     1. stopCardByHeartbeat()  杀掉旧卡片
 *     2. setTimeout(1200ms)     固定等 1.2 秒
 *     3. ensureCardRunning()    拉起新卡片
 *
 * 问题在于 **1.2 秒不够**：
 *   · 卡片被杀时来不及把 alive=false 写进心跳（强杀不会走退出清理）
 *   · 心跳里还留着"我活着" + 旧时间戳
 *   · 心跳要超过 8 秒才被判过期
 *   · 新卡片启动时读到这份"新鲜"的旧心跳 → 以为自己是重复 → 自己退出
 *
 * 实测后果：从"停止旧卡片"到"新窗口真正可见"约 13 秒空窗
 * （来源：项目梳理报告-V1.0/05-踩坑与BUG汇总.md:161-162）
 *
 * ---------------------------------------------------------------------------
 * 【怎么修（用户 2026-11-02 拍板）】
 * ---------------------------------------------------------------------------
 * 把"固定等 1200ms"换成"**等到确实可以启动**"：
 *
 *   旧 PID 已不存在  **且**  属于旧 PID 的心跳已失效
 *   （失效 = 被标记 alive=false / 被新记录替换 / 按规则判过期）
 *
 * 加总超时兜底，避免永远等下去。
 *
 * ---------------------------------------------------------------------------
 * 【为什么这些测试必须能脱离真实进程跑】
 * ---------------------------------------------------------------------------
 * 这个功能改错的后果是"卡片永远起不来"或"叠出两张卡片"。
 * 两种都得靠人工复现故障才能验证 —— 不可接受。
 * 所以核心判断抽成纯函数 / 可注入依赖，这里用假时钟 + 假探针跑。
 *
 * 真实进程验证放在 test/restart-window-real.mjs（需要起进程）。
 *
 * 跑法：node test/restart-window.mjs
 */

import { waitForPreviousCardExit, judgePreviousCardGone, DEFAULT_EXIT_WAIT_MS, DEFAULT_POLL_MS }
  from '../lib/launcher.js'

let failed = 0
let passed = 0
const group = (n) => console.log(`\n=== ${n} ===`)
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

console.log('='.repeat(66))
console.log('C3 自动更新重启：等待旧卡片退出（空窗与防叠卡）')
console.log('='.repeat(66))

const NOW = new Date('2026-11-02T00:30:00+08:00').getTime()
const OLD_PID = 7644
const OLD_STAMP = NOW - 1000

// ================================================================ 1. 纯判断函数
group('1. judgePreviousCardGone：现在能不能启动新卡片')

{
  // ---- 旧进程还在 -> 不能启动
  const r = judgePreviousCardGone({
    pidAlive: true,
    hb: { alive: true, pid: OLD_PID, updatedAtMs: NOW - 1000 },
    oldPid: OLD_PID,
    now: NOW,
    staleMs: 8000,
  })
  check('旧进程还活着 → 不能启动（ready=false）', r.ready === false, r.reason)
  check('  原因写明是进程还在', /进程|pid/i.test(r.reason), r.reason)
}

{
  // ---- 进程没了，但心跳还是旧的且新鲜 -> 也不能启动（防止被单实例挡住）
  const r = judgePreviousCardGone({
    pidAlive: false,
    hb: { alive: true, pid: OLD_PID, updatedAtMs: NOW - 300 },   // 3 秒前，还新鲜
    oldPid: OLD_PID,
    now: NOW,
    staleMs: 8000,
  })
  check('进程没了但心跳仍新鲜 → 不能启动', r.ready === false, r.reason)
  check('  原因写明心跳还新鲜', /心跳/.test(r.reason), r.reason)
}

{
  // ---- 进程没了 + 心跳过期 -> 可以启动
  const r = judgePreviousCardGone({
    pidAlive: false,
    hb: { alive: true, pid: OLD_PID, updatedAtMs: NOW - 9000 },  // 9 秒前，已过期
    oldPid: OLD_PID,
    now: NOW,
    staleMs: 8000,
  })
  check('进程没了 + 心跳过期 → 可以启动', r.ready === true, r.reason)
}

{
  // ---- 进程没了 + 心跳已标记 alive=false -> 可以启动（最快路径）
  const r = judgePreviousCardGone({
    pidAlive: false,
    hb: { alive: false, pid: OLD_PID, updatedAtMs: NOW - 200 },
    oldPid: OLD_PID,
    now: NOW,
    staleMs: 8000,
  })
  check('进程没了 + 心跳 alive=false → 可以启动', r.ready === true, r.reason)
}

{
  // ---- 进程没了 + 心跳被新 PID 替换 -> 可以启动
  const r = judgePreviousCardGone({
    pidAlive: false,
    hb: { alive: true, pid: 9999, updatedAtMs: NOW - 100 },     // 已经是别人的心跳
    oldPid: OLD_PID,
    now: NOW,
    staleMs: 8000,
  })
  check('进程没了 + 心跳属于新 PID → 可以启动', r.ready === true, r.reason)
}

{
  // ---- 进程没了 + 心跳文件消失 -> 可以启动
  const r = judgePreviousCardGone({
    pidAlive: false,
    hb: { alive: false, missing: true, unknown: true },
    oldPid: OLD_PID,
    now: NOW,
    staleMs: 8000,
  })
  check('进程没了 + 心跳文件不存在 → 可以启动', r.ready === true, r.reason)
}

{
  // ---- 判断不了进程状态（权限）-> 保守：不能启动
  const r = judgePreviousCardGone({
    pidAlive: null,       // null = 判断不了
    hb: { alive: true, pid: OLD_PID, updatedAtMs: NOW - 9000 },
    oldPid: OLD_PID,
    now: NOW,
    staleMs: 8000,
  })
  check('【安全】进程状态判断不了 → 保守不启动（宁可慢，不可叠卡）',
    r.ready === false, r.reason)
}

// ================================================================ 2. 轮询等待
group('2. waitForPreviousCardExit：带超时的轮询等待')

{
  // ---- 第一轮就满足：立即返回，不浪费时间
  let calls = 0
  const r = await waitForPreviousCardExit({
    oldPid: OLD_PID,
    probePid: () => { calls++; return false },              // 进程已经没了
    readHeartbeat: () => ({ alive: false, pid: OLD_PID }),   // 心跳已标记退出
    now: () => NOW,
    staleMs: 8000,
    timeoutMs: 5000,
    pollMs: 100,
    sleep: async () => { throw new Error('不应该等待') },
  })
  check('条件立即满足 → 立即返回，不 sleep', r.ready === true && calls === 1, `calls=${calls}`)
  check('  记录等待时长约 0', (r.waitedMs ?? 0) === 0, String(r.waitedMs))
}

{
  // ---- 第 3 轮才满足：轮询等待
  //
  // 【注意这个测试的假时钟必须自洽】
  //   第一版我把心跳时间戳写死成 `t - 500`，但 `t` 在前进 ——
  //   于是"心跳年龄"永远停在 500ms，一直不满足"过期"，跑到超时。
  //   那不是代码错，是测试的假时钟没跟上真实语义。
  //   正确做法：心跳时间戳固定（残骸就是停在那儿的），让 now 往前走。
  let t = NOW
  let probeCalls = 0
  const DEAD_STAMP = NOW - 100       // 旧卡片死时留下的心跳时刻，固定不动
  const r = await waitForPreviousCardExit({
    oldPid: OLD_PID,
    probePid: () => { probeCalls++; return probeCalls >= 3 ? false : true },
    readHeartbeat: () => ({ alive: true, pid: OLD_PID, updatedAtMs: DEAD_STAMP }),
    now: () => t,
    staleMs: 8000,
    timeoutMs: 20000,                // 给足时间让它走到 staleMs 过期
    pollMs: 1000,                    // 每次轮询把时钟推进 1 秒
    sleep: async (ms) => { t += ms },
  })
  check('第 3 轮才满足 → 最终 ready=true', r.ready === true, r.reason)
  check('  确实轮询了多次', probeCalls >= 3, `probeCalls=${probeCalls}`)
  check('  记录了等待时长', (r.waitedMs ?? 0) > 0, String(r.waitedMs))
  check('  原因是心跳过期（不是别的路径）', /过期|进程/.test(r.reason), r.reason)
}

{
  // ---- 超时：进程一直活着
  let t = NOW
  const r = await waitForPreviousCardExit({
    oldPid: OLD_PID,
    probePid: () => true,                     // 永远活着
    readHeartbeat: () => ({ alive: true, pid: OLD_PID, updatedAtMs: t }),
    now: () => t,
    staleMs: 8000,
    timeoutMs: 500,
    pollMs: 100,
    sleep: async (ms) => { t += ms },
  })
  check('【关键】超时后 ready=false（不能无限等）', r.ready === false, r.reason)
  check('  标记 timedOut', r.timedOut === true, String(r.timedOut))
  check('  等待时长不超过超时值', (r.waitedMs ?? 0) <= 600, String(r.waitedMs))
}

{
  // ---- 探针抛异常：不能崩，按"判断不了"处理
  let t = NOW
  const r = await waitForPreviousCardExit({
    oldPid: OLD_PID,
    probePid: () => { throw new Error('探查失败') },
    readHeartbeat: () => ({ alive: true, pid: OLD_PID, updatedAtMs: t }),
    now: () => t,
    staleMs: 8000,
    timeoutMs: 300,
    pollMs: 100,
    sleep: async (ms) => { t += ms },
  })
  check('探针异常不崩，最终超时返回 ready=false', r.ready === false, r.reason)
}

{
  // ---- 没有 oldPid：直接放行（没有"旧卡片"可等）
  const r = await waitForPreviousCardExit({
    oldPid: undefined,
    probePid: () => true,
    readHeartbeat: () => ({ alive: true, pid: 1 }),
    now: () => NOW,
    staleMs: 8000,
    timeoutMs: 5000,
    pollMs: 100,
    sleep: async () => { throw new Error('不应该等待') },
  })
  check('没有旧 PID → 立即 ready=true（没有可等的东西）', r.ready === true, r.reason)
}

// ================================================================ 3. 常量
group('3. 常量合理性')

check('默认超时是有限值（不会无限等）', Number.isFinite(DEFAULT_EXIT_WAIT_MS) && DEFAULT_EXIT_WAIT_MS > 0,
  String(DEFAULT_EXIT_WAIT_MS))
check('默认轮询间隔合理（50~1000ms）', DEFAULT_POLL_MS >= 50 && DEFAULT_POLL_MS <= 1000, String(DEFAULT_POLL_MS))
check('默认超时不超过心跳过期时间太多（避免"等太久不如不等"）',
  DEFAULT_EXIT_WAIT_MS <= 15000, String(DEFAULT_EXIT_WAIT_MS))

// ================================================================ 4. index.js 接线检查
group('4. index.js 不再使用固定 1200ms')

{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const indexPath = join(here, '..', 'index.js')
  const indexSrc = readFileSync(indexPath, 'utf8')

  check('index.js 不再有 `}, 1200)` 这种固定等待',
    !/\},\s*1200\s*\)/.test(indexSrc),
    '应改成等待旧卡片退出')
  check('index.js 调用了 waitForPreviousCardExit',
    /waitForPreviousCardExit/.test(indexSrc))
}

// ================================================================ 5. 真实链路字段（血泪教训）
group('5. 【真实暴露的 bug】新鲜心跳必须带 updatedAtMs')

{
  // 【为什么单独有这一组】
  //   上面所有用例的 hb 都是**我手工构造的**，我理所当然地塞了 updatedAtMs。
  //   而真实的 checkHeartbeat() 新鲜分支**没有**返回这个字段 ——
  //   于是 judgePreviousCardGone 永远读不到时间戳、永远判"残骸、可以启动"，
  //   C3 的等待逻辑直接失效。
  //
  //   这个 bug 是 test/restart-window-real.mjs（真实进程）跑出来的，
  //   上面那些用假对象的单测**全部是绿的**。
  //   这一组就是为了守住：真实的 checkHeartbeat 必须给出 updatedAtMs。
  const { checkHeartbeat } = await import('../lib/launcher.js')
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = join(tmpdir(), 'dsh-restart-window-field-' + Date.now())
  mkdirSync(dir, { recursive: true })
  const nowMs = Date.now()
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    pid: 1234, hwnd: 0, alive: true, updatedAtMs: nowMs,
    scriptStampMs: nowMs - 5000,
  }), 'utf8')

  const hb = checkHeartbeat(dir, { now: () => nowMs })
  check('真实 checkHeartbeat 新鲜分支返回 updatedAtMs',
    hb.alive === true && Number.isFinite(hb.updatedAtMs),
    `alive=${hb.alive} updatedAtMs=${hb.updatedAtMs}（undefined 会让 C3 判断失效）`)
  check('  值与心跳文件里的一致', Number(hb.updatedAtMs) === nowMs,
    `${hb.updatedAtMs} vs ${nowMs}`)

  // ---- 用**真实** hb 走一遍等待判断，确认它不会误放行
  const verdict = judgePreviousCardGone({
    pidAlive: false,          // 进程已经没了
    hb,                       // 但心跳还是新鲜的 alive=true
    oldPid: 1234,
    now: nowMs,
    staleMs: 8000,
  })
  check('【关键】进程没了但心跳新鲜 → 不能放行',
    verdict.ready === false, verdict.reason)

  rmSync(dir, { recursive: true, force: true })
}

console.log('')
console.log('='.repeat(66))
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) console.log('全部通过 ✅')
else process.exitCode = 1
console.log('='.repeat(66))
