/**
 * test/d1-four-files.mjs -- D1 第一步：四份真实文件的写入专项验证
 *
 * ===========================================================================
 * 【和 json-store.mjs 的区别】
 * ===========================================================================
 *   json-store.mjs 测的是**通用模块**的行为（原子性、容错、并发）。
 *   这个文件测的是**四份真实文件各自的接入点**是否真的用上了它：
 *
 *     card-launch.json   → launcher.js  writeLaunchState
 *     settings.json      → index.js     writeSettingsFile（内部函数）
 *     holidays.json      → valley.js    HolidayStore.save
 *     panel-pos.json     → Panel.ps1    Save-Position（PowerShell，另测）
 *
 * 施工卡 D1-5 第 5 条要求"四文件专项"，就是这一组。
 *
 * 跑法：node test/d1-four-files.mjs
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readLaunchState, writeLaunchState } from '../lib/launcher.js'
import { HolidayStore } from '../lib/valley.js'

let failed = 0
let passed = 0
const group = (n) => console.log(`\n=== ${n} ===`)
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

console.log('='.repeat(70))
console.log('D1：四份真实文件的写入专项')
console.log('='.repeat(70))

const dirs = []
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'dsh-d1f-'))
  dirs.push(d)
  return d
}

/** 列出目录里的临时文件残留（本模块生成的格式） */
function tempLeftovers(dir) {
  try {
    return readdirSync(dir).filter((f) => f.startsWith('.') && f.endsWith('.tmp'))
  } catch { return [] }
}

try {
  // ================================================================ 1. card-launch.json
  group('1. card-launch.json（启动策略记忆）')

  {
    const d = freshDir()

    check('初始状态读为空对象', Object.keys(readLaunchState(d)).length === 0)

    const ok = writeLaunchState(d, {
      detachedUnsupported: true,
      detachedFailedAt: Date.now(),
      detachedFailedReason: '测试原因',
    })
    check('写入返回 true', ok === true, String(ok))

    const back = readLaunchState(d)
    check('能读回 detachedUnsupported', back.detachedUnsupported === true)
    check('中文原因没乱码', back.detachedFailedReason === '测试原因', back.detachedFailedReason)

    check('无临时文件残留', tempLeftovers(d).length === 0, tempLeftovers(d).join(','))

    // ---- 合并语义：只改一个键，不能丢掉别的
    writeLaunchState(d, { extra: 'keep' })
    const merged = readLaunchState(d)
    check('【关键】合并写入保留原有键', merged.detachedUnsupported === true && merged.extra === 'keep',
      JSON.stringify(merged))

    // ---- 反复写 20 次，文件必须始终可读
    let allReadable = true
    for (let i = 0; i < 20; i++) {
      writeLaunchState(d, { counter: i })
      const r = readLaunchState(d)
      if (typeof r.counter !== 'number') { allReadable = false; break }
    }
    check('20 次连续写入，每次都立即可读', allReadable)
    check('最终无临时文件残留', tempLeftovers(d).length === 0, tempLeftovers(d).join(','))
  }

  // ================================================================ 2. holidays.json
  group('2. holidays.json（节假日缓存）')

  {
    const d = freshDir()
    const holPath = join(d, 'holidays.json')
    const logs = []
    const store = new HolidayStore({ path: holPath, log: (m, o) => logs.push(m + JSON.stringify(o || {})) })

    // 造一点"从网上拉到的"数据
    store.years = { '2026': ['2026-01-01', '2026-05-01'] }
    store.fetchedYears = new Set([2026])
    store.fetchedAt = Date.now()

    store.save()

    check('文件已生成', existsSync(holPath))
    const raw = JSON.parse(readFileSync(holPath, 'utf8'))
    check('版本号是 2', raw.version === 2, String(raw.version))
    check('年份数据正确', Array.isArray(raw.years['2026']) && raw.years['2026'].length === 2,
      JSON.stringify(raw.years))
    check('pulledYears 记录了 2026', Array.isArray(raw.pulledYears) && raw.pulledYears.includes(2026),
      JSON.stringify(raw.pulledYears))
    check('无临时文件残留', tempLeftovers(d).length === 0, tempLeftovers(d).join(','))

    // ---- 重新加载，确认能读回
    const store2 = new HolidayStore({ path: holPath, log: () => {} })
    store2.load()
    check('重新加载后年份还在', store2.years['2026'] && store2.years['2026'].length === 2,
      JSON.stringify(store2.years['2026']))
    check('重新加载后 pulledYears 还在', store2.fetchedYears.has(2026))

    // ---- 写失败不能污染现有缓存
    const before = readFileSync(holPath, 'utf8')
    const badStore = new HolidayStore({ path: join(d, 'nodir-that-will-be-made', 'holidays.json'), log: () => {} })
    badStore.years = { '2027': ['2027-01-01'] }
    badStore.save()
    check('【关键】写到别的路径失败，不影响已存在的这份',
      readFileSync(holPath, 'utf8') === before)
  }

  // ================================================================ 3. 三个写者场景（settings.json 的接入口）
  group('3. settings.json 三写者场景（模拟插件 / 卡片 / 设置窗口）')

  {
    // settings.json 的写入函数在 index.js 内部（未导出），
    // 这里直接验证它所依赖的 json-store 的合并语义 ——
    // 也就是三个写者各自"读最新→改自己的键→写回"时会不会丢键。
    const { readJsonSafe, writeJsonAtomic } = await import('../lib/json-store.js')
    const d = freshDir()
    const p = join(d, 'settings.json')

    // 初始：设置窗口写入了外观 + 一个未知键
    writeJsonAtomic(p, {
      cardWidth: 320,
      approvalInline: false,
      topmost: true,
      未来功能键: '要保留',
    })

    // 写者A（插件）同步 dshUrl —— 只改自己那个键
    let cur = readJsonSafe(p, {})
    writeJsonAtomic(p, { ...cur, dshUrl: 'http://127.0.0.1:11922/' })

    // 写者B（卡片）写置顶
    cur = readJsonSafe(p, {})
    writeJsonAtomic(p, { ...cur, topmost: false })

    // 写者C（设置窗口）改宽度 + 审批开关
    cur = readJsonSafe(p, {})
    writeJsonAtomic(p, { ...cur, cardWidth: 400, approvalInline: true })

    const final = readJsonSafe(p, {})
    check('A 的 dshUrl 在', final.dshUrl === 'http://127.0.0.1:11922/', final.dshUrl)
    check('B 的 topmost 在（且是后写的 false）', final.topmost === false, String(final.topmost))
    check('C 的两项都在', final.cardWidth === 400 && final.approvalInline === true,
      JSON.stringify({ w: final.cardWidth, a: final.approvalInline }))
    check('【关键】未知键没被任何人丢掉', final['未来功能键'] === '要保留', String(final['未来功能键']))

    check('无临时文件残留', tempLeftovers(d).length === 0, tempLeftovers(d).join(','))
  }

  // ================================================================ 4. 坏文件不阻断读取
  group('4. 四份文件被外部改坏时，读取方不能崩')

  {
    const d = freshDir()

    // card-launch 坏了
    writeFileSync(join(d, 'card-launch.json'), '{"broken', 'utf8')
    check('card-launch 坏 JSON → 读为空对象（不抛）',
      Object.keys(readLaunchState(d)).length === 0)

    // holidays 坏了
    writeFileSync(join(d, 'holidays.json'), 'not json at all', 'utf8')
    let threw = false
    try {
      const s = new HolidayStore({ path: join(d, 'holidays.json'), log: () => {} })
      s.load()
    } catch { threw = true }
    check('holidays 坏 JSON → load 不抛异常', threw === false)

    // settings 坏了
    const { readJsonSafe } = await import('../lib/json-store.js')
    writeFileSync(join(d, 'settings.json'), '[1,2,3]', 'utf8')
    check('settings 是数组 → 返回空对象', Object.keys(readJsonSafe(join(d, 'settings.json'), {})).length === 0)

    // panel-pos 坏了（Node 侧不读它，但确认 json-store 行为一致）
    writeFileSync(join(d, 'panel-pos.json'), '{"left": ', 'utf8')
    check('panel-pos 坏 JSON → 返回空对象',
      Object.keys(readJsonSafe(join(d, 'panel-pos.json'), {})).length === 0)
  }

  // ================================================================ 5. PowerShell 侧接入确认
  group('5. Panel.ps1 侧接入确认（静态检查）')

  {
    const { readFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const panelSrc = readFileSync(join(here, '..', 'panel', 'Panel.ps1'), 'utf8')

    check('Panel.ps1 定义了 Write-FileAtomic', /function Write-FileAtomic/.test(panelSrc))
    check('Save-Position 使用 Write-FileAtomic',
      /Write-FileAtomic -Path \$PosPath/.test(panelSrc))

    // 【防坑】PS 5.1 / .NET Framework 的 File.Move 只有两参数版本。
    //   三参数 Move(a,b,true) 是 .NET Core 才有的，在 PS 5.1 上会抛异常。
    //
    // 【检查方法要精确】不能直接正则全文搜 ——
    //   代码注释里**故意写了** `[System.IO.File]::Move($tmp, $dst, $true)` 作为反例说明，
    //   第一版断言把这行注释误判成了真实调用（这就是那次失败的原因）。
    //   正确做法：剥掉注释行，再在剩下的代码里查。
    const codeOnly = panelSrc
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')

    const threeArgMoves = codeOnly.match(/\[System\.IO\.File\]::Move\s*\([^)]*,[^)]*,[^)]*\)/g) || []
    check('【防坑】代码里没有三参数 Move（PS 5.1 不支持）',
      threeArgMoves.length === 0,
      threeArgMoves.length > 0 ? '发现: ' + threeArgMoves.join(' | ') : '')

    check('代码里用了 File.Replace（原子替换）',
      /\[System\.IO\.File\]::Replace\s*\(/.test(codeOnly))
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
