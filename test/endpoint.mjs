/**
 * test/endpoint.mjs -- 「点卡片回到 DSH」的数据部分测试
 *
 * 背景：原先点卡片是 `Start-Process 'http://127.0.0.1:2278'`。
 * 但那是写死的端口，DSH 实际端口会变（实测 11922），所以点了打开空白页。
 *
 * 分工：
 *   · 插件（这个文件测的部分）：问 DSH 要真实网址，写进 settings.json
 *   · 卡片（Panel.ps1）：优先用 dsh:// 协议唤起桌面程序，网址只作兜底
 *
 * 这个测试只验证插件的地址获取逻辑，不真的去点开 DSH
 * （真的点了会打断用户当前会话，属于不该自动做的事）。
 *
 * 【B8 之后新增的一大块：重试】
 *   原先插件只在 apply() 里调一次 resolveDshUrl()，而那一刻 webServer
 *   还没 listen 完（契约：getOrigin() throws before listen binds a port），
 *   于是每次都失败，日志还写成"服务都不可用"——误导了整轮排查。
 *   修法：失败退避重试、成功即停、用注入的定时器（不裸 setTimeout）。
 *
 *   这部分测试的重点是**不碰真定时器**：定时器由 schedule 注入，
 *   本文件塞一个"立刻执行"或"只记录不执行"的假定时器，
 *   于是重试次数、上限、提前停止这些行为都能瞬间测完，不用等 24 秒。
 *
 * 跑法：node test/endpoint.mjs
 */

import {
  DSH_PROTOCOL,
  resolveDshUrl,
  normalizeUrl,
  resolveDshUrlDetailed,
  buildRetryPlan,
  computeDshUrlSettingsUpdate,
  createUrlSyncRunner,
  RETRY_POLICY,
} from '../lib/endpoint.js'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

console.log('='.repeat(58))
console.log('打开 DSH：地址获取')
console.log('='.repeat(58))

// ---------------------------------------------------------------- 协议名
check('协议名是 dsh', DSH_PROTOCOL === 'dsh', DSH_PROTOCOL)

// ---------------------------------------------------------------- 地址解析
console.log('\n--- 从 DSH 服务里取网址 ---')

{
  const ctx = {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => 'http://127.0.0.1:11922/?token=abc' }
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:11922' }
      return undefined
    },
  }
  const r = resolveDshUrl(ctx)
  check('优先用 webApp.getAdvertisedUrl', r && r.source === 'webApp.getAdvertisedUrl', r && r.url)
  check('保留鉴权参数', r && r.url.includes('token=abc'), r && r.url)
}

{
  const ctx = {
    get(name) {
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:11922' }
      return undefined
    },
  }
  const r = resolveDshUrl(ctx)
  check('webApp 缺失时退回 webServer.getOrigin', r && r.source === 'webServer.getOrigin', r && r.url)
}

{
  const r = resolveDshUrl({ get: () => undefined })
  check('都拿不到时返回 null', r === null)
}

{
  let threw = false
  let r = null
  try { r = resolveDshUrl({ get() { throw new Error('服务坏了') } }) } catch { threw = true }
  check('服务抛异常时自己吞掉，不往上冒', !threw && r === null)
}

{
  check('返回空串时当作没拿到', resolveDshUrl({ get: () => ({ getAdvertisedUrl: () => '' }) }) === null)
  check('返回非网址时当作没拿到', resolveDshUrl({ get: () => ({ getAdvertisedUrl: () => 'not-a-url' }) }) === null)
  check('返回 ftp 时当作没拿到', resolveDshUrl({ get: () => ({ getAdvertisedUrl: () => 'ftp://x/y' }) }) === null)
}

{
  let threw = false
  let r = null
  try { r = resolveDshUrl({}) } catch { threw = true }
  check('ctx 没有 get 方法时安全返回 null', !threw && r === null)
}

// ---------------------------------------------------------------- 详情版：区分"没就绪"和"没有"
console.log('\n--- 失败原因要能说清（notReady 判定）---')

{
  // 这就是 B8 的真实场景：服务在，但 getOrigin 在 listen 之前抛异常
  const ctx = {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => { throw new Error('before listen binds a port') } }
      if (name === 'webServer') return { getOrigin: () => { throw new Error('before listen binds a port') } }
      return undefined
    },
  }
  const r = resolveDshUrlDetailed(ctx)
  check('访问器抛异常时 url 为 null', r.url === null)
  check('访问器抛异常 → notReady=true（值得重试）', r.notReady === true, String(r.notReady))
  check('失败原因里带上了异常原文', typeof r.error === 'string' && r.error.includes('listen'), r.error && r.error.slice(0, 60))
}

{
  // 服务真的没有：notReady=false，重试也没用（但调用方仍按统一节奏试，只是日志措辞不同）
  const r = resolveDshUrlDetailed({ get: () => undefined })
  check('服务不存在 → notReady=false', r.notReady === false, String(r.notReady))
  check('服务不存在时也给出原因', typeof r.error === 'string' && r.error.length > 0, r.error)
}

{
  const ctx = { get: (n) => (n === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:3080' } : undefined) }
  const r = resolveDshUrlDetailed(ctx)
  check('成功时 error 为空、notReady=false', r.url === 'http://127.0.0.1:3080' && r.error === null && r.notReady === false)
}

{
  // 成功路径不该被"前一个服务抛异常"污染
  const ctx = {
    get(name) {
      if (name === 'webApp') return { getAdvertisedUrl: () => { throw new Error('boom') } }
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:3080' }
      return undefined
    },
  }
  const r = resolveDshUrlDetailed(ctx)
  check('webApp 抛异常后仍能用 webServer 成功', r.url === 'http://127.0.0.1:3080' && r.source === 'webServer.getOrigin', r.source)
}

{
  const r = resolveDshUrlDetailed({ get: () => ({ getAdvertisedUrl: () => 42 }) })
  check('访问器返回非字符串时不崩、按未拿到处理', r.url === null, String(r.url))
}

// ---------------------------------------------------------------- 退避节奏
console.log('\n--- 退避重试节奏（纯函数，不碰定时器）---')

{
  const plan = buildRetryPlan()
  check('默认节奏是 250/500/1s/2s/4s/8s/8s',
    JSON.stringify(plan) === JSON.stringify([250, 500, 1000, 2000, 4000, 8000, 8000]),
    JSON.stringify(plan))
  check('重试次数为 7 次', plan.length === 7, String(plan.length))
  const total = plan.reduce((a, b) => a + b, 0)
  check('累计等待不超过 30 秒预算', total <= RETRY_POLICY.budgetMs, `${total}ms <= ${RETRY_POLICY.budgetMs}ms`)
  check('累计等待确实接近预算（不是只等到 1 秒）', total > 20000, `${total}ms`)
}

{
  check('延迟严格递增或持平（指数退避）',
    buildRetryPlan().every((v, i, a) => i === 0 || v >= a[i - 1]), JSON.stringify(buildRetryPlan()))
  check('延迟不超过单次上限 8 秒', buildRetryPlan().every((v) => v <= RETRY_POLICY.maxDelayMs))
  check('所有延迟都是正的整数毫秒', buildRetryPlan().every((v) => Number.isInteger(v) && v > 0))
}

{
  // 参数非法 → 空计划（不重试），而不是抛异常炸掉插件
  check('budgetMs=0 时返回空计划', buildRetryPlan({ budgetMs: 0 }).length === 0)
  check('firstDelayMs=0 时返回空计划', buildRetryPlan({ firstDelayMs: 0 }).length === 0)
  check('负数参数返回空计划', buildRetryPlan({ firstDelayMs: -1 }).length === 0)
  check('传 null 走默认策略', JSON.stringify(buildRetryPlan(null)) === JSON.stringify(buildRetryPlan()))
  check('firstDelayMs=1 不会爆炸（有 64 次硬上限）', buildRetryPlan({ firstDelayMs: 1, maxDelayMs: 2, budgetMs: 1e9 }).length <= 64)
}

// ---------------------------------------------------------------- 写盘决策：只在值变了才写
console.log('\n--- 写盘决策：只在值真的变了才写 ---')

{
  const cur = { dshUrl: 'http://127.0.0.1:2278', cardWidth: 260, glassOpacity: 80 }
  const r = computeDshUrlSettingsUpdate(cur, { url: 'http://127.0.0.1:11922' })
  check('值不同 → changed=true', r.changed === true)
  check('写入了新地址', r.next.dshUrl === 'http://127.0.0.1:11922')
  check('其它键原样保留', r.next.cardWidth === 260 && r.next.glassOpacity === 80)
  check('不修改传进来的对象（纯函数）', cur.dshUrl === 'http://127.0.0.1:2278')
}

{
  const cur = { dshUrl: 'http://127.0.0.1:11922', cardWidth: 260 }
  const r = computeDshUrlSettingsUpdate(cur, { url: 'http://127.0.0.1:11922' })
  check('值相同 → changed=false（不写盘）', r.changed === false)
  check('值相同时内容不变', JSON.stringify(r.next) === JSON.stringify(cur))
}

{
  const r = computeDshUrlSettingsUpdate({ dshUrl: 'http://x' }, null)
  check('没取到地址 → changed=false', r.changed === false)
  const r2 = computeDshUrlSettingsUpdate({ dshUrl: 'http://x' }, { url: '' })
  check('地址为空串 → changed=false', r2.changed === false)
  const r3 = computeDshUrlSettingsUpdate({ dshUrl: 'http://x' }, { url: 123 })
  check('地址不是字符串 → changed=false', r3.changed === false)
}

{
  const r = computeDshUrlSettingsUpdate(null, { url: 'http://127.0.0.1:3080' })
  check('原文件为空/损坏时也能写（从空对象开始）', r.changed === true && r.next.dshUrl === 'http://127.0.0.1:3080')
  check('没设过 openMode 时补默认 protocol', r.next.openMode === 'protocol')
}

{
  const r = computeDshUrlSettingsUpdate({ openMode: 'url' }, { url: 'http://127.0.0.1:3080' })
  check('用户已设过 openMode 时绝不覆盖', r.next.openMode === 'url')
}

// ---------------------------------------------------------------- 重试执行器
console.log('\n--- 重试执行器 ---')

/**
 * 造一个假定时器：把所有排期攒起来，由测试手动"跑完"。
 * 这样能在毫秒内验证 7 次重试，不用真的等 24 秒。
 */
function makeFakeClock() {
  const queue = []
  return {
    schedule(cb, delayMs) {
      const item = { cb, delayMs, cancelled: false }
      queue.push(item)
      return () => { item.cancelled = true }
    },
    /** 把队列里的任务全跑掉（含期间新排进来的），最多 n 轮防死循环 */
    drain(max = 100) {
      let rounds = 0
      while (queue.length > 0 && rounds < max) {
        const item = queue.shift()
        rounds++
        if (!item.cancelled) item.cb()
      }
      return rounds
    },
    pending: () => queue.filter((x) => !x.cancelled).length,
    delays: () => queue.map((x) => x.delayMs),
  }
}

{
  // 场景 A：一直是"没就绪"，最终用尽
  const clock = makeFakeClock()
  const logs = []
  let calls = 0
  const runner = createUrlSyncRunner({
    resolveOnce: () => { calls++; return { url: null, source: null, error: 'before listen', notReady: true } },
    commit: () => ({ wrote: false }),
    schedule: clock.schedule,
    log: (m) => logs.push(m),
    plan: [10, 20, 40],
  })
  runner.start()
  clock.drain()

  check('用尽场景：resolveOnce 被调 1+3 次（首次 + 3 次重试）', calls === 4, String(calls))
  check('用尽场景：最终 done=true', runner.state().done === true)
  check('用尽场景：retryCount=3', runner.state().retryCount === 3, String(runner.state().retryCount))
  check('用尽场景：日志里有"已重试 3 次仍取不到"',
    logs.some((m) => m.includes('已重试 3 次仍取不到')), logs[logs.length - 1])
  check('用尽场景：日志里不再出现"都不可用"这种误导话',
    !logs.some((m) => m.includes('都不可用')))
  check('用尽场景：提到卡片将用协议方式打开', logs.some((m) => m.includes('协议方式打开')))
  check('用尽场景：不再有挂起的定时器', clock.pending() === 0, String(clock.pending()))
}

{
  // 场景 B：第 2 次重试时成功 → 立刻停，不再排定时器
  const clock = makeFakeClock()
  const logs = []
  let calls = 0
  const commits = []
  const runner = createUrlSyncRunner({
    resolveOnce: () => {
      calls++
      if (calls < 3) return { url: null, source: null, error: 'not ready', notReady: true }
      return { url: 'http://127.0.0.1:3080', source: 'webServer.getOrigin', error: null, notReady: false }
    },
    commit: (f) => { commits.push(f); return { wrote: true } },
    schedule: clock.schedule,
    log: (m) => logs.push(m),
    plan: [10, 20, 40],
  })
  runner.start()
  clock.drain()

  check('成功即停：总共只调了 3 次', calls === 3, String(calls))
  check('成功即停：done=true', runner.state().done === true)
  check('成功即停：commit 只被调 1 次', commits.length === 1, String(commits.length))
  check('成功即停：commit 拿到的是真实地址', commits[0] && commits[0].url === 'http://127.0.0.1:3080')
  check('成功即停：日志写"已获取 DSH 网页地址"并注明重试次数',
    logs.some((m) => m.includes('已获取 DSH 网页地址') && m.includes('重试 2 次')), logs[logs.length - 1])
  check('成功即停：之后不再有挂起定时器', clock.pending() === 0)
}

{
  // 场景 C：首次就成功 → 一次都不重试（快路径，不能白等 250ms）
  const clock = makeFakeClock()
  const logs = []
  let calls = 0
  const runner = createUrlSyncRunner({
    resolveOnce: () => { calls++; return { url: 'http://127.0.0.1:3080', source: 'webServer.getOrigin', error: null, notReady: false } },
    commit: () => ({ wrote: true }),
    schedule: clock.schedule,
    log: (m) => logs.push(m),
    plan: [10, 20, 40],
  })
  runner.start()

  check('首次就成功：只调 1 次', calls === 1, String(calls))
  check('首次就成功：一个定时器都没排', clock.delays().length === 0, JSON.stringify(clock.delays()))
  check('首次就成功：日志是"已把 DSH 地址同步"',
    logs.some((m) => m.includes('已把 DSH 地址同步到 settings.json')), logs[logs.length - 1])
}

{
  // 场景 D：值没变 → 不该写盘，日志说"未变"
  const clock = makeFakeClock()
  const logs = []
  const runner = createUrlSyncRunner({
    resolveOnce: () => ({ url: 'http://127.0.0.1:3080', source: 'webServer.getOrigin', error: null, notReady: false }),
    commit: () => ({ wrote: false }),   // 内部判断"值相同"后返回 wrote:false
    schedule: clock.schedule,
    log: (m) => logs.push(m),
    plan: [10],
  })
  runner.start()
  check('值未变：日志写"DSH 地址未变"', logs.some((m) => m.includes('DSH 地址未变')), logs[logs.length - 1])
}

{
  // 场景 E：stop() 之后，已排上队的回调不能继续干活（这就是"卸载不泄漏"）
  const clock = makeFakeClock()
  let calls = 0
  const runner = createUrlSyncRunner({
    resolveOnce: () => { calls++; return { url: null, error: 'not ready', notReady: true } },
    commit: () => ({ wrote: true }),
    schedule: clock.schedule,
    log: () => {},
    plan: [10, 20, 40],
  })
  runner.start()          // 第 1 次失败，排了一个定时器
  const afterFirst = calls
  runner.stop()            // 模拟插件卸载

  clock.drain()            // 把排着的那个跑掉（它内部应该因为 stopped 直接返回）
  check('stop() 后不再发起新的 resolve', calls === afterFirst, `${calls} vs ${afterFirst}`)
  check('stop() 后 state 标记 stopped', runner.state().stopped === true)
  check('stop() 后 done=true（不会假装还在重试）', runner.state().done === true)
}

{
  // 场景 F：resolveOnce 自己抛异常 → 不能把插件带崩，且照样走重试
  const clock = makeFakeClock()
  const logs = []
  let calls = 0
  let threw = false
  let runner = null
  try {
    runner = createUrlSyncRunner({
      resolveOnce: () => { calls++; throw new Error('炸了') },
      commit: () => ({ wrote: false }),
      schedule: clock.schedule,
      log: (m) => logs.push(m),
      plan: [10, 20],
    })
    runner.start()
    clock.drain()
  } catch { threw = true }
  check('resolveOnce 抛异常时 runner 不往外炸', !threw)
  check('resolveOnce 抛异常时仍会重试到上限', calls === 3, String(calls))
  check('resolveOnce 抛异常时最终走"用尽"分支',
    logs.some((m) => m.includes('仍取不到')), logs[logs.length - 1])
}

{
  // 场景 G：没有可用的定时器（schedule 返回 undefined）
  //   → 必须当场认输，不能假装"还在重试"然后永远不写地址
  const logs = []
  let calls = 0
  const runner = createUrlSyncRunner({
    resolveOnce: () => { calls++; return { url: null, error: 'no timer', notReady: true } },
    commit: () => ({ wrote: false }),
    schedule: () => undefined,
    log: (m) => logs.push(m),
    plan: [10, 20, 40],
  })
  runner.start()
  check('没有定时器时不当场卡住（done=true）', runner.state().done === true)
  check('没有定时器时只试了 1 次就收手', calls === 1, String(calls))
  check('没有定时器时说清是"无法排期重试"，不是"已重试 0 次"',
    logs.some((m) => m.includes('无法排期重试')), logs[logs.length - 1])
  check('没有定时器时不写"已重试 0 次"这种别扭话',
    !logs.some((m) => m.includes('已重试 0 次')), logs.join(' | '))
}

{
  // 场景 H：commit 抛异常 → 地址照样算"拿到了"，不能让写盘失败变成重试风暴
  const clock = makeFakeClock()
  const logs = []
  let calls = 0
  const runner = createUrlSyncRunner({
    resolveOnce: () => { calls++; return { url: 'http://127.0.0.1:3080', source: 'webServer.getOrigin', error: null, notReady: false } },
    commit: () => { throw new Error('磁盘满了') },
    schedule: clock.schedule,
    log: (m) => logs.push(m),
    plan: [10, 20],
  })
  runner.start()
  check('commit 抛异常时不算失败、不重试', calls === 1 && runner.state().done === true, String(calls))
  check('commit 抛异常时记了日志', logs.some((m) => m.includes('同步 DSH 地址失败')), logs.join(' | '))
}

// ---------------------------------------------------------------- 网址规整
console.log('\n--- 网址规整 ---')
check('正常网址原样通过', normalizeUrl('http://127.0.0.1:11922/') === 'http://127.0.0.1:11922/', normalizeUrl('http://127.0.0.1:11922/'))
check('去掉首尾空格', normalizeUrl('  http://127.0.0.1:11922/  ') === 'http://127.0.0.1:11922/')
check('https 也接受', normalizeUrl('https://example.com/a') !== null)
check('空值返回 null', normalizeUrl('') === null && normalizeUrl(null) === null)
check('非 http 协议返回 null', normalizeUrl('file:///c:/x') === null)
check('畸形地址返回 null', normalizeUrl('http://') === null)

// ---------------------------------------------------------------- 汇总
console.log('')
console.log('='.repeat(58))
const passed = results.filter(r => r.pass).length
const failed = results.length - passed
console.log(`通过 ${passed}   失败 ${failed}`)
if (failed === 0) console.log('全部通过 ✅')
else {
  console.log('有失败项 ❌')
  for (const r of results.filter(x => !x.pass)) console.log(`  - ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
}
console.log('='.repeat(58))
process.exitCode = failed === 0 ? 0 : 1
