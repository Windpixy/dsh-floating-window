/**
 * test/json-store.mjs -- D1 第一步：四份 JSON 的写入原子性
 *
 * ===========================================================================
 * 【这个测试守的是什么】
 * ===========================================================================
 *
 * 项目里有四份 JSON 会被写入，现状各不相同：
 *
 *   文件                 现状                              问题
 *   ---------------------------------------------------------------------
 *   card-launch.json     写 tmp → 删旧 → 改名              删旧与改名之间文件不存在
 *   settings.json        写 tmp → 改名 （固定 .tmp 名）      已是原子，但并发会撞
 *   holidays.json        直接 WriteAllText 覆盖             中途失败留下坏文件
 *   panel-pos.json       直接 WriteAllText 覆盖             同上
 *
 * 三种真实风险：
 *
 *   ① **半截文件**：写到一半崩了/断电，留下的是坏 JSON。
 *      卡片读到坏 JSON → 状态全丢 → 用户看到"空闲"（C2 修的就是这个的后果）。
 *
 *   ② **文件消失的瞬间**：「先删旧再改名」的两步之间，文件真的不存在。
 *      恰好在那一瞬间读的人会读到"文件不存在"。
 *
 *   ③ **两个进程共用同一个 .tmp 名**：
 *      进程 A 写 tmp → 进程 B 也写同一个 tmp → A 改名拿走 B 的内容（或反之）。
 *      结果是内容错乱，而且不报错。
 *
 * ===========================================================================
 * 【正确的写法：临时文件 + 原子改名】
 * ===========================================================================
 *
 *   1. 写到一个**独一无二**的临时文件名（带 pid + 随机串）
 *   2. flush（关闭句柄）
 *   3. 原子改名覆盖正式文件
 *
 * 第 3 步在 Windows 上要注意：
 *   fs.renameSync 在目标存在时会失败（EEXIST/EPERM）。
 *   所以要先 unlink 再 rename —— 但那又回到了"文件消失瞬间"的问题。
 *
 *   **正确解法**：Windows 上 `rename` 到已存在文件，Node 的 renameSync
 *   实际会失败。可靠做法是：
 *     a) 优先用 fs.renameSync（同卷内是原子的）
 *     b) 失败则退化为"删除 + 改名"，并承认这里有极短窗口
 *
 *   本项目采用 (b) 的降级策略，但**明确记录下来**这个残留风险，
 *   不假装它是完全原子的。
 *
 * 跑法：node test/json-store.mjs
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { writeJsonAtomic, readJsonSafe, makeTempName } from '../lib/json-store.js'

let failed = 0
let passed = 0
const group = (n) => console.log(`\n=== ${n} ===`)
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}  ${detail ?? ''}`); failed++ }
}

console.log('='.repeat(70))
console.log('D1：JSON 写入原子性')
console.log('='.repeat(70))

const dirs = []
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'dsh-js-'))
  dirs.push(d)
  return d
}

try {
  // ================================================================ 1. 临时文件名唯一
  group('1. 临时文件名必须独一无二（防止两个进程互相踩）')

  {
    const names = new Set()
    for (let i = 0; i < 200; i++) names.add(makeTempName('/path/to/settings.json'))
    check('连续生成 200 个临时名，全部不同', names.size === 200, `实际 ${names.size} 个不同`)

    const n1 = makeTempName('/a/settings.json')
    check('临时名带正式文件名前缀', n1.includes('settings.json'), n1)
    // 【断言要精确】"不以 .tmp 结尾"这个说法有歧义：
    //   我们**确实**以 .tmp 结尾（便于识别和清理），
    //   关键是**不是固定的 `<正式名>.tmp`** —— 那才是原来的坑。
    check('临时名不是固定的 `<正式名>.tmp`',
      n1 !== '/a/settings.json.tmp' && !/settings\.json\.tmp$/.test(n1), n1)
    check('临时名含 pid 段（跨进程不撞）',
      new RegExp('\\.' + process.pid + '\\.').test(n1), n1)
  }

  // ================================================================ 2. 正常写入
  group('2. 正常写入：内容正确、无临时文件残留')

  {
    const d = freshDir()
    const p = join(d, 'test.json')
    const ok = writeJsonAtomic(p, { a: 1, b: '中文', c: [1, 2, 3] })

    check('写入返回 true', ok === true, String(ok))
    check('文件存在', existsSync(p))

    const got = JSON.parse(readFileSync(p, 'utf8'))
    check('内容正确', got.a === 1 && got.b === '中文' && got.c.length === 3, JSON.stringify(got))
    check('中文没乱码', got.b === '中文', got.b)

    const leftovers = readdirSync(d).filter((f) => f !== 'test.json')
    check('没有临时文件残留', leftovers.length === 0, leftovers.join(','))
  }

  // ================================================================ 3. 覆盖写入
  group('3. 覆盖已有文件：内容被整体替换，不是追加')

  {
    const d = freshDir()
    const p = join(d, 'test.json')
    writeFileSync(p, JSON.stringify({ old: 'old', keep: 1 }), 'utf8')
    writeJsonAtomic(p, { fresh: true })

    const got = JSON.parse(readFileSync(p, 'utf8'))
    check('旧键消失（整体替换）', got.old === undefined && got.keep === undefined, JSON.stringify(got))
    check('新内容正确', got.fresh === true)

    const leftovers = readdirSync(d).filter((x) => x !== 'test.json')
    check('无临时文件残留', leftovers.length === 0, leftovers.join(','))
  }

  // ================================================================ 4. 写入失败不留半截
  group('4. 【关键】写入失败时，正式文件必须保持原样')

  {
    const d = freshDir()
    const p = join(d, 'test.json')
    const original = { good: 'yes', value: 42 }
    writeJsonAtomic(p, original)

    // 注入一个必然失败的场景：把写入函数换成会抛的
    const ok = writeJsonAtomic(p, { bad: true }, {
      _injectWriteError: true,     // 测试钩子：写到临时文件时抛
    })

    check('失败时返回 false（不抛出去）', ok === false, String(ok))
    const after = JSON.parse(readFileSync(p, 'utf8'))
    check('【关键】正式文件仍是原内容', after.good === 'yes' && after.value === 42, JSON.stringify(after))

    const leftovers = readdirSync(d).filter((x) => x !== 'test.json')
    check('失败后不残留临时文件（要清理）', leftovers.length === 0, leftovers.join(','))
  }

  // ================================================================ 5. 读取容错
  group('5. 读取：坏文件/不存在/空文件都不能崩')

  {
    const d = freshDir()

    check('文件不存在 → 返回 fallback',
      readJsonSafe(join(d, 'nope.json'), { fb: 1 }).fb === 1)

    const bad = join(d, 'bad.json')
    writeFileSync(bad, '{"broken": ', 'utf8')
    check('坏 JSON → 返回 fallback（不抛）',
      readJsonSafe(bad, { fb: 2 }).fb === 2)

    const empty = join(d, 'empty.json')
    writeFileSync(empty, '', 'utf8')
    check('空文件 → 返回 fallback',
      readJsonSafe(empty, { fb: 3 }).fb === 3)

    const arr = join(d, 'arr.json')
    writeFileSync(arr, '[1,2,3]', 'utf8')
    check('顶层是数组 → 返回 fallback（本项目只接受对象）',
      readJsonSafe(arr, { fb: 4 }).fb === 4)

    const nul = join(d, 'null.json')
    writeFileSync(nul, 'null', 'utf8')
    check('内容是 null → 返回 fallback',
      readJsonSafe(nul, { fb: 5 }).fb === 5)
  }

  // ================================================================ 6. 读-改-写合并
  group('6. 读-改-写：必须保留不认识的键（不能整份覆盖）')

  {
    const d = freshDir()
    const p = join(d, 'settings.json')

    // 用户/另一个进程写了一些我们不认识的键
    writeJsonAtomic(p, {
      cardWidth: 320,
      未来新功能A: 'value-a',
      nested: { deep: 'keep-me' },
    })

    // 我们的进程只改 cardWidth
    const cur = readJsonSafe(p, {})
    writeJsonAtomic(p, { ...cur, cardWidth: 400 })

    const got = readJsonSafe(p, {})
    check('改的键生效', got.cardWidth === 400, String(got.cardWidth))
    check('【关键】不认识的顶层键保留', got['未来新功能A'] === 'value-a', String(got['未来新功能A']))
    check('【关键】不认识的嵌套键保留', got.nested && got.nested.deep === 'keep-me', JSON.stringify(got.nested))
  }

  // ================================================================ 7. 并发写不互相踩
  group('7. 并发：多个写者轮流写，最终文件必须完整可读')

  {
    const d = freshDir()
    const p = join(d, 'concurrent.json')

    // 模拟并发：连续 50 次"读-改-写"，每轮加一个键
    let allOk = true
    for (let i = 0; i < 50; i++) {
      const cur = readJsonSafe(p, {})
      cur['k' + i] = i
      if (!writeJsonAtomic(p, cur)) { allOk = false; break }
    }

    check('50 轮写入全部成功', allOk)
    const got = readJsonSafe(p, {})
    const keys = Object.keys(got).filter((k) => k.startsWith('k'))
    check('50 个键都在（没有互相覆盖丢失）', keys.length === 50, `实际 ${keys.length}`)

    const leftovers = readdirSync(d).filter((x) => x !== 'concurrent.json')
    check('无临时文件残留', leftovers.length === 0, leftovers.join(','))
  }

  // ================================================================ 8. 目录自动创建
  group('8. 目标目录不存在时自动创建')

  {
    const d = freshDir()
    const p = join(d, 'sub', 'deep', 'test.json')
    const ok = writeJsonAtomic(p, { created: true })
    check('能写入深层目录', ok === true && existsSync(p))
    check('内容正确', readJsonSafe(p, {}).created === true)
  }

  // ================================================================ 9. 不产生纯 LF / BOM 问题
  group('9. 输出格式：UTF-8 无 BOM（JSON 绝不能带 BOM）')

  {
    const d = freshDir()
    const p = join(d, 'bom.json')
    writeJsonAtomic(p, { 中文键: '中文值' })

    const buf = readFileSync(p)
    check('无 UTF-8 BOM', !(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF),
      `前3字节: ${buf[0]},${buf[1]},${buf[2]}`)
    check('中文能正确解析回对象', readJsonSafe(p, {}).中文键 === '中文值')
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
