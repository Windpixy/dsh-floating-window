/**
 * test/check-card-staleness.mjs -- 一条命令回答"卡片是不是在跑旧代码"
 *
 * ---------------------------------------------------------------------------
 * 【这个脚本解决的真实问题】
 * ---------------------------------------------------------------------------
 * v0.9.11 用户反馈"柱状图没有看到蓝色的闪动"。
 * 排查发现：改动代码 14:43，卡片进程 13:51 启动 —— 内存里是旧代码。
 * 代码本身没问题（离屏探针跑产品函数，色条 0.600~1.000 完整起伏）。
 *
 * 这类问题最难受的地方是：**日志里没有任何异常**。
 * 旧代码本身好好的，它只是没有新功能。
 * 用户看到的现象和"新功能写错了"一模一样。
 *
 * 所以这个脚本把判断压缩成一条命令：
 *
 *   有 NPM/PNPM 时：  pnpm test:staleness
 *   直接跑：          node test/check-card-staleness.mjs
 *
 * 输出三种结论：
 *   ✅ 新鲜      正在跑的就是磁盘上这版代码
 *   ⚠️ 过旧      进程是旧代码 —— 重启卡片即可
 *   ❔ 无法判断  老版本卡片没有 scriptStampMs 字段 / 卡片没在跑
 *
 * 【为什么和心跳时戳比"文件 mtime"就够，不用比哈希】
 *   我们关心的是"用户看的这一版是不是包含我刚写的那段代码"。
 *   代码每次改动都会更新 mtime；只要进程加载时的 mtime >= 磁盘 mtime，
 *   就说明进程里至少包含了当前磁盘版本。
 *   哈希更严格，但要多读 280KB 文件，而这个脚本要能随手跑，
 *   毫秒级出结果才有用。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const PANEL_SCRIPT = join(here, '..', 'panel', 'Panel.ps1')
const DATA_DIR = process.env.DSH_CARD_DATA_DIR || join(homedir(), '.dsh', 'desktop-card')

/** 心跳超过这么久算"卡片没在跑"（卡片每 2 秒写一次） */
const STALE_MS = 8000
/** 容忍的时钟误差：两个时间戳差在这以内就算同一版 */
const TOLERANCE_MS = 2000

const fmt = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

console.log('='.repeat(56))
console.log('卡片代码新鲜度检查')
console.log('='.repeat(56))

// ---------------------------------------------------------------- 磁盘
if (!existsSync(PANEL_SCRIPT)) {
  console.log(`❌ 找不到 ${PANEL_SCRIPT}`)
  process.exit(1)
}
const diskMs = statSync(PANEL_SCRIPT).mtimeMs

// ---------------------------------------------------------------- 心跳
const hbPath = join(DATA_DIR, 'heartbeat.json')
if (!existsSync(hbPath)) {
  console.log(`❔ 卡片没在跑（心跳文件不存在）`)
  console.log(`   数据目录：${DATA_DIR}`)
  console.log('')
  console.log('   卡片没在跑就谈不上"跑旧代码"。启动后重新运行本脚本。')
  process.exit(0)
}

let hb
try {
  hb = JSON.parse(readFileSync(hbPath, 'utf8'))
} catch {
  console.log(`❔ 心跳文件读不出来（可能正在写），稍后重试`)
  process.exit(0)
}

const ageMs = Date.now() - Number(hb.updatedAtMs)
const running = hb.alive === true && Number.isFinite(ageMs) && ageMs < STALE_MS

console.log(`磁盘代码：${fmt(diskMs)}   (Panel.ps1 修改时间)`)
console.log(`卡片进程：pid=${hb.pid}  hwnd=${hb.hwnd}`)
console.log(`心跳时间：${fmt(Number(hb.updatedAtMs))}  (${Math.round(ageMs / 1000)} 秒前)`)

if (!running) {
  console.log('')
  console.log(`❔ 卡片没在跑（心跳已过期或已退出）`)
  process.exit(0)
}

// ---------------------------------------------------------------- 进程加载的版本
if (!Number.isFinite(Number(hb.scriptStampMs)) || Number(hb.scriptStampMs) <= 0) {
  console.log('')
  console.log('❔ 无法判断：这个进程没有汇报代码时间戳')
  console.log('   说明它跑的是 v0.9.12 之前的版本（那时还没有这个字段）。')
  console.log('   → 重启一次卡片，之后这个检查就能用了。')
  process.exit(0)
}

const loadedMs = Number(hb.scriptStampMs)
console.log(`进程加载：${fmt(loadedMs)}   (这个进程启动时读到的 Panel.ps1)`)
console.log('')

const behindMs = diskMs - loadedMs

if (behindMs > TOLERANCE_MS) {
  const min = Math.floor(behindMs / 60000)
  const sec = Math.round((behindMs % 60000) / 1000)
  console.log(`⚠️ 正在跑旧代码 —— 磁盘上的代码比进程里新 ${min} 分 ${sec} 秒`)
  console.log('')
  console.log('   这就是"改了没效果"的典型原因，不是新功能有问题。')
  console.log('   修复：右键卡片 → 退出，然后双击')
  console.log(`         ${join(here, '..', 'panel', 'run-panel.bat')}`)
  process.exitCode = 2
} else {
  console.log('✅ 新鲜 —— 正在跑的就是磁盘上这版代码')
  console.log('   如果某个改动看起来没生效，那是代码本身的问题，可以放心查。')
  process.exitCode = 0
}
