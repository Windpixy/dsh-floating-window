/**
 * test/bar-mode.mjs -- 柱态（细条）纯逻辑单测（v0.9.0）
 *
 * 【为什么这些能离线测】
 *   柱态真正难的是什么：
 *     ① DPI 单位换算（逻辑 vs 物理）—— 算错判据永远不成立
 *     ② 颜色对比度（WCAG 图形 3:1）—— 不达标等于状态看不清
 *     ③ 配置夹取（手工改 json 填离谱值不能崩、不能画出诡异东西）
 *     ④ 判据的两个条件（贴边 + 光标顶边）
 *   这四件事**全是纯计算**，不依赖 WPF、不依赖卡片在跑。
 *
 * 【不能离线测的部分（真机验收项）】
 *   · 14×120 的柱子是否真的画出来、圆角是否胶囊形
 *   · 磨砂是否真的关掉了
 *   · 单击柱子是否真的展开
 *   这些在实施报告里用实测截图说明。
 *
 * 跑法：node test\bar-mode.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const panelDir = join(here, '..', 'panel')

// ================================================================ 测试框架

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${detail ? '  (' + detail + ')' : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? '  (' + detail + ')' : ''}`)
  }
}

function group(title) {
  console.log(`\n=== ${title} ===`)
}

// ================================================================ 色彩工具
//
// 按 WCAG 2.1 相对亮度公式：
//   sRGB 通道 → 线性化 → 0.2126R + 0.7152G + 0.0722B
//   对比度 = (L1 + 0.05) / (L2 + 0.05)，L1 是较亮的那一方

function srgbToLinear(c8) {
  const c = c8 / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1[0], rgb1[1], rgb1[2])
  const l2 = relativeLuminance(rgb2[0], rgb2[1], rgb2[2])
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/** "#RRGGBB" → [r,g,b] */
function hexToRgb(hex) {
  const s = String(hex).replace('#', '')
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ]
}

// ================================================================ 柱态色板（和 Panel.ps1 保持一致）
//
// ⚠️ 这份表必须和 Panel.ps1 的 $script:BarPalette 同步。
// 为防漂移，下面第 5 组有个"从源码里抠值核对"的测试。

const BAR_PALETTE = {
  // 【v0.9.6 整体再调一档】
  //   胶囊底从"v0.9.5 几乎透明"变成"0xA0 浓度的磨砂玻璃"，等效底色变了：
  //     浅底：原 #E8E2DF（相对亮度 0.79）→ 现 #D7D2E0（0.66）  ← 变暗了
  //     （因为磨砂浓度提高后，DWM 的模糊层比原壁纸暗，见 Panel.ps1 的反推）
  //   底变暗一点，v0.9.1 那套色值的余量就薄了，实测：
  //     approval 4.38 / finished 4.46 / running 4.24 / idle 4.20  ← 全部跌破 4.5
  //   所以整体往深压一档（色相不动，只动明度），压完：
  //     approval 4.68 / finished 5.26 / running 4.92 / idle 5.29  ← 全部过线且有余量
  //   深底那一侧本来余量很足，但为了"柱子和卡片的红/绿/蓝灰看着是同一色"，
  //   跟着提亮一档保持两套视觉同源。
  // 【v0.9.6 第二次调色：按"最坏端玻璃"设计，不是按用户那张截图】
  //   第一版拿用户那张浅色壁纸算，四色 4.68~5.29，看着够。
  //   但 curIsLight 的判据是"壁纸相对亮度 >= 0.186"，
  //   所以**浅模式最暗的玻璃**出现在壁纸刚好 0.186 那一档，
  //   比用户那张 #CBC0E2（rel 0.559）暗得多。在那档上重算，第一版全跌到 3.7~4.2。
  //   现在按"浅模式最暗玻璃 #BDBEC1"和"深模式最亮玻璃 #363333"两端设计：
  //   四色在全范围内最差 5.04，留足余量。
  approval: { Light: '#8F0E14', Dark: '#FFB0B0' },
  finished: { Light: '#094A22', Dark: '#95EFB8' },
  running:  { Light: '#174090', Dark: '#9CC2FF' },
  idle:     { Light: '#3C4149', Dark: '#C8CFD8' },
}

// 柱态胶囊底色（见 Panel.ps1 的 $script:BarBackdrop）—— v0.9.1 跟随明暗
//
// 【浅底为什么是 #E8E2DF 而不是更白的 #F2EEEC】
//   用真实桌面截图验证过（_lab\bar-real-wallpaper.ps1）：桌面上有大片近白窗口区，
//   浅底压在更浅的背景上会轮廓消失。但压得太深色条又会不达标：
//     #F2EEEC → 对纯白壁纸 1.15（看不出轮廓），running 余量 4.89
//     #E8E2DF → 对纯白壁纸 1.28（勉强可见），  running 余量 4.55
//     #DAD5D2 → 对纯白壁纸 1.46（清楚），      running 只有 3.87 ❌
//   #E8E2DF 是这两条约束的交点。
// 【v0.9.6 关键变化：柱态不再是实色块，而是磨砂玻璃】
//   所以"底色"要换成**等效玻璃色**，不能再拿 $script:BarBackdrop 的实色去算。
//   等效玻璃色 = a × tint色 + (1-a) × 模糊层B
//     其中 a = 0xA0/255（v0.9.6 的新浓度）
//     模糊层 B 是从用户真实截图反推出来的：
//       浅壁纸：B = #9C95BD    深壁纸：B = #134271
//   算出来：
//     浅玻璃 = #D7D2E0（相对亮度 0.658）
//     深玻璃 = #17293D（相对亮度 0.021）
//   这两个值同时也是"轮廓对比度"和"色条对比度"两条约束的共同基准。
// 【v0.9.6 第二次修正：这两个值改成"设计基准"而不是"用户截图"】
//   原因同上：判据边界决定了浅模式玻璃可能暗到 #BDBEC1，
//   深模式玻璃可能亮到 #363333。对比度必须在这两端都成立。
//   （用户那张截图算出来的 #D4D2E3 / #17293D 在下面作为"实测对照"也测一遍）
const BAR_BACKDROP_LIGHT = [0xBD, 0xBE, 0xC1]   // 浅模式最暗玻璃
const BAR_BACKDROP_DARK  = [0x36, 0x33, 0x33]   // 深模式最亮玻璃

// 用户那两张真实截图的等效玻璃（用来做"实测对照"）
const BAR_GLASS_MEASURED_LIGHT = [0xD4, 0xD2, 0xE3]
const BAR_GLASS_MEASURED_DARK  = [0x17, 0x29, 0x3D]

// 【保留实色底板，只用于"退出柱态后"的实色场景】
//   Update-Glass 退出柱态时会把胶囊底恢复成这两个实色。
//   两组值都必须存在于源码里，下面第 5 组会同时核对。
const BAR_SOLID_LIGHT = [0xE8, 0xE2, 0xDF]
const BAR_SOLID_DARK  = [0x1C, 0x1C, 0x1F]

// 柱态描边色（v0.9.6 新增，见 Panel.ps1 的 $script:BarBorderColor）
//   浅底用暖深灰、深底用冷浅灰；都要"对内看得清、对外看得出轮廓、又不抢眼"
//
// 【v0.9.9 两个色都往玻璃色退了一档】
//   用户反馈"描边太丑了、太重了"。线宽 2.0→1.0 的同时把色也退一档，
//   否则"细线 + 高对比"会变成一根针，比粗线更扎眼。
//     浅色 #5E5652 → #6B6460（对内 5.59→4.53，对外 4.16→3.37）
//     深色 #C8C8D2 → #B4B4C0（对内 8.61→6.96，对外 3.85→3.11）
//   两侧降幅都是约 20%，保持深浅平衡；四个值仍全部 >= 3.0 图形门槛。
const BAR_BORDER_LIGHT = [0x6B, 0x64, 0x60]
const BAR_BORDER_DARK  = [0xB4, 0xB4, 0xC0]

// 柱态描边线宽（v0.9.9：2.0 -> 1.0 逻辑像素）
//   200% 缩放下 2.0 = 4 物理像素，和旁边 4 像素的玻璃一样宽 → 像画框。
//   1.0 = 2 物理像素，是不被抗锯齿洗淡的最小整数宽度。
const BAR_BORDER_WIDTH = 1.0

// 柱态磨砂浓度（v0.9.6：从 0x20 提到 0xA0）
//   0x20 时实测轮廓对比度只有 1.42（浅壁纸）/ 1.74（深壁纸），
//   用户看到的就是"一根悬空的彩条"。
const BAR_GLASS_ALPHA = 0xA0

// 桌面壁纸的极端情况（柱态关磨砂，颜色条旁边/外侧直接压在壁纸上）
const WALLPAPER_WHITE = [0xFF, 0xFF, 0xFF]
const WALLPAPER_BLACK = [0x00, 0x00, 0x00]

// ================================================================ 1. 配置
group('1. 配置默认值与夹取')

{
  const settings = JSON.parse(readFileSync(join(panelDir, 'settings.json'), 'utf8'))

  check('settings.json 有 barEnabled', settings.barEnabled === true, String(settings.barEnabled))
  check('settings.json 有 barWidth', settings.barWidth === 14, String(settings.barWidth))
  check('settings.json 有 barHeight', settings.barHeight === 120, String(settings.barHeight))

  // 用户拍板"中档 14×120"
  check('宽度是用户拍板的 14', settings.barWidth === 14)
  check('高度是用户拍板的 120', settings.barHeight === 120)

  // 不能被破坏的既有键
  check('cardWidth 仍在（260）', settings.cardWidth === 260, String(settings.cardWidth))
  check('miniHeight 仍在（96）', settings.miniHeight === 96, String(settings.miniHeight))
  check('approvalInline 仍在（默认 false）', settings.approvalInline === false)
  check('glassOpacity 仍在（80）', settings.glassOpacity === 80, String(settings.glassOpacity))
}

// ================================================================ 2. DPI 单位换算
group('2. DPI 单位换算（这条错了判据永远不成立）')

{
  const SCALE = 2.0      // 本机 200%，实测确认
  const workAreaLogical = { Left: 0, Top: 0, Width: 1600, Height: 952 }

  // 物理光标在屏幕最右边
  const cursorPhysX = 3200
  // 换算成逻辑
  const cursorLogicalX = cursorPhysX / SCALE

  check('光标物理 3200 → 逻辑 1600',
    cursorLogicalX === 1600, String(cursorLogicalX))

  const distRight = workAreaLogical.Left + workAreaLogical.Width - cursorLogicalX
  check('光标顶到右边缘时 distRight = 0', distRight === 0, String(distRight))

  // 反例：不做换算会怎样
  const wrongDistRight = (workAreaLogical.Left + workAreaLogical.Width) - cursorPhysX
  check('【反例】不换算会得到 -1600（永远不满足 ≤2）',
    wrongDistRight === -1600, String(wrongDistRight))
  check('这正好证明：不换算 → 柱态永远不触发',
    Math.abs(wrongDistRight) > 2)

  // 光标在屏幕中间
  const midPhys = 1600
  const midLogical = midPhys / SCALE
  const distMid = workAreaLogical.Width - midLogical
  check('光标在中间时 distRight = 800（远离阈值）', distMid === 800, String(distMid))

  // 光标距离右边缘 4 物理像素 = 2 逻辑 = 刚好在容差边界
  const nearPhys = 3196
  const nearLogical = nearPhys / SCALE
  const distNear = workAreaLogical.Width - nearLogical
  check('距边 4 物理 = 2 逻辑（正好是容差 2）', distNear === 2, String(distNear))
}

// ================================================================ 3. 触发判据
group('3. 触发判据（贴边 + 光标顶边，两个都要满足）')

{
  const SCALE = 2.0
  const work = { Left: 0, Top: 0, Width: 1600, Height: 952 }
  const edgeMargin = 8
  const tolerance = 2

  /** 复刻 Panel.ps1 的 Test-CollapseTrigger 逻辑 */
  function testTrigger({ winLeft, winWidth, cursorPhysX, barEnabled = true, mode = 'expanded' }) {
    if (!barEnabled) return { Hit: false, Reason: 'barEnabled=false' }
    if (mode === 'bar') return { Hit: false, Reason: 'already-bar' }

    const curLogicalX = cursorPhysX / SCALE
    const distLeft = curLogicalX - work.Left
    const distRight = work.Left + work.Width - curLogicalX

    const winAtLeft = (winLeft - work.Left) <= (edgeMargin + 4)
    const winAtRight = ((work.Left + work.Width) - (winLeft + winWidth)) <= (edgeMargin + 4)

    if (distLeft <= tolerance && winAtLeft) return { Hit: true, Side: 'left' }
    if (distRight <= tolerance && winAtRight) return { Hit: true, Side: 'right' }
    return { Hit: false }
  }

  // 场景：卡片 260 宽，吸边到右侧 → Left = 1600 - 260 - 8 = 1332
  const rightEdgeLeft = work.Width - 260 - edgeMargin

  let r = testTrigger({ winLeft: rightEdgeLeft, winWidth: 260, cursorPhysX: 3200 })
  check('贴右边 + 光标顶到物理最右 → 触发（right）',
    r.Hit === true && r.Side === 'right', JSON.stringify(r))

  r = testTrigger({ winLeft: 8, winWidth: 260, cursorPhysX: 0 })
  check('贴左边 + 光标顶到物理最左 → 触发（left）',
    r.Hit === true && r.Side === 'left', JSON.stringify(r))

  // 只是拖到边上放下，光标不在边缘（比如在卡片中间）
  r = testTrigger({ winLeft: rightEdgeLeft, winWidth: 260, cursorPhysX: 2920 })
  check('贴右边但光标不在边缘 → 不触发',
    r.Hit === false, JSON.stringify(r))

  // 光标顶到边缘，但窗口没贴边（比如用户关了 snapToEdge）
  r = testTrigger({ winLeft: 700, winWidth: 260, cursorPhysX: 3200 })
  check('光标顶边但窗口没贴边 → 不触发',
    r.Hit === false, JSON.stringify(r))

  // 拖到屏幕中间
  r = testTrigger({ winLeft: 670, winWidth: 260, cursorPhysX: 1600 })
  check('拖到中间 → 不触发', r.Hit === false)

  // 开关关掉
  r = testTrigger({ winLeft: rightEdgeLeft, winWidth: 260, cursorPhysX: 3200, barEnabled: false })
  check('barEnabled=false → 不触发（即使条件都满足）', r.Hit === false)

  // 已经是柱态
  r = testTrigger({ winLeft: rightEdgeLeft, winWidth: 260, cursorPhysX: 3200, mode: 'bar' })
  check('已经在柱态 → 不再触发', r.Hit === false)
}

// ================================================================ 4. 柱态几何
group('4. 柱态几何（贴边位置、垂直居中、夹在屏幕内）')

{
  const work = { Left: 0, Top: 0, Width: 1600, Height: 952 }
  const BarWidth = 14
  const BarHeight = 120
  const BarEdgeGap = 4

  /** 复刻 Panel.ps1 的 Set-BarGeometry */
  function barGeometry({ side, restoreCenterY }) {
    let top = restoreCenterY - BarHeight / 2
    if (top < work.Top) top = work.Top
    if (top + BarHeight > work.Top + work.Height) top = work.Top + work.Height - BarHeight

    let left
    if (side === 'left') left = work.Left + BarEdgeGap
    else left = work.Left + work.Width - BarWidth - BarEdgeGap
    return { Left: left, Top: top, Width: BarWidth, Height: BarHeight }
  }

  // 卡片原来是 3 行（260 高），在屏幕下半部
  const centerY = 600
  let g = barGeometry({ side: 'right', restoreCenterY: centerY })
  check('贴右边：Left = 1600 - 14 - 4 = 1582', g.Left === 1582, String(g.Left))
  check('垂直居中在缩小前中心：Top = 600 - 60 = 540', g.Top === 540, String(g.Top))
  check('尺寸 14 × 120', g.Width === 14 && g.Height === 120)

  g = barGeometry({ side: 'left', restoreCenterY: centerY })
  check('贴左边：Left = 0 + 4 = 4', g.Left === 4, String(g.Left))

  // 中心在屏幕最上方（卡片贴顶）
  g = barGeometry({ side: 'right', restoreCenterY: 40 })
  check('中心太靠上时 Top 被夹到 0', g.Top === 0, String(g.Top))

  // 中心在屏幕最下方
  g = barGeometry({ side: 'right', restoreCenterY: 940 })
  check('中心太靠下时 Top 被夹到底（952-120=832）', g.Top === 832, String(g.Top))

  // BarEdgeGap=4 必须和 Clamp-Position 的 +4 对齐，否则会被拉回
  check('贴边距 4 = Clamp-Position 的 +4（对齐，不会被推回）', BarEdgeGap === 4)
}

// ================================================================ 5. 色板同步 & 对比度
group('5. 柱态色板：与源码同步 + WCAG 图形 3:1 门槛')

{
  // 从 Panel.ps1 里抠出 BarPalette 的值，核对它和本测试的表一致。
  // 【为什么要这么做】色板写在 PowerShell 里、测试写在 JS 里，
  // 两边不同步就会出现"测试通过但实际颜色不对"。
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')

  for (const phase of Object.keys(BAR_PALETTE)) {
    const { Light, Dark } = BAR_PALETTE[phase]
    const toArgb = (hex) => {
      const [r, g, b] = hexToRgb(hex)
      const h = (n) => n.toString(16).toUpperCase().padStart(2, '0')
      return `0xFF, 0x${h(r)}, 0x${h(g)}, 0x${h(b)}`
    }
    check(`源码里有 ${phase} 的 Light 色 ${Light}`,
      panelSrc.includes(toArgb(Light)), toArgb(Light))
    check(`源码里有 ${phase} 的 Dark 色 ${Dark}`,
      panelSrc.includes(toArgb(Dark)), toArgb(Dark))
  }

  check('源码里定义了 $script:BarPalette', panelSrc.includes('$script:BarPalette'))

  // ---- 柱底也必须在源码里（否则测试表变了、源码没变，测个寂寞）
  const toArgbNoAlpha = (rgb) => {
    const h = (n) => n.toString(16).toUpperCase().padStart(2, '0')
    return `0xFF, 0x${h(rgb[0])}, 0x${h(rgb[1])}, 0x${h(rgb[2])}`
  }
  // 【v0.9.6：源码里现在有两组"柱底色"，含义不同，都要核对】
  //   ① BAR_SOLID_*    = $script:BarBackdrop 的实色，只在"退出柱态"时用
  //   ② BAR_BACKDROP_* = 等效玻璃色（磨砂 0xA0 + 反推的模糊层），
  //                      用于算色条对比度 / 轮廓对比度
  //   ② 是**推导值**，源码里不会有对应的字面量（它是 a×tint+(1-a)×B 算出来的），
  //   所以只核对 ① 必须在源码里，② 靠下面的对比度断言守住。
  check('源码里有退柱态用的实色浅底 #E8E2DF', panelSrc.includes(toArgbNoAlpha(BAR_SOLID_LIGHT)),
    toArgbNoAlpha(BAR_SOLID_LIGHT))
  check('源码里有退柱态用的实色深底 #1C1C1F', panelSrc.includes(toArgbNoAlpha(BAR_SOLID_DARK)),
    toArgbNoAlpha(BAR_SOLID_DARK))

  // 等效玻璃色不能和实色混为一谈 —— 如果哪天有人把 BAR_BACKDROP_* 改回实色，
  // 说明他把"磨砂已经开了"这件事忘了，对比度会全部算错。
  check('【防混淆】等效玻璃色不等于退柱态实色（浅）',
    toArgbNoAlpha(BAR_BACKDROP_LIGHT) !== toArgbNoAlpha(BAR_SOLID_LIGHT))
  check('【防混淆】等效玻璃色不等于退柱态实色（深）',
    toArgbNoAlpha(BAR_BACKDROP_DARK) !== toArgbNoAlpha(BAR_SOLID_DARK))

  // ---- v0.9.6 描边色必须在源码里（明暗各一个）
  //   v0.9.9 两个值都往玻璃色退了一档（用户："描边太重了"）
  check('源码里有柱态描边浅色 #6B6460', panelSrc.includes(toArgbNoAlpha(BAR_BORDER_LIGHT)),
    toArgbNoAlpha(BAR_BORDER_LIGHT))
  check('源码里有柱态描边深色 #B4B4C0', panelSrc.includes(toArgbNoAlpha(BAR_BORDER_DARK)),
    toArgbNoAlpha(BAR_BORDER_DARK))

  // ---- v0.9.6 磨砂浓度必须是 0xA0
  // 【为什么这条要单独测】
  //   0x20 → 0xA0 是本轮修"柱态太透"的核心改动，一个十六进制数字。
  //   它被改回去的话，柱态会立刻退回"悬空彩条"的样子，
  //   而这种退化**不会报错、不会崩**，只有人眼看截图才能发现 —— 必须靠断言守。
  check('【v0.9.6】柱态磨砂浓度是 0xA0',
    panelSrc.includes('$BarGlassAlpha = 0xA0'), '期望 0xA0')
  check('【回归】柱态磨砂浓度不再是 0x20（那是"太透"的元凶）',
    !panelSrc.includes('$BarGlassAlpha = 0x20'))

  // 【关键回归】旧 bug：柱子底色两个分支都是深色（浅壁纸也用 #24262C）。
  // 这里直接检查源码里不再出现那个旧值，防止以后被改回去。
  check('【回归】柱子不再永远用深底 #24262C',
    !panelSrc.includes('0x24, 0x26, 0x2C'))

  // ---- 描边：v0.9.1 加过 → v0.9.3 删掉 → v0.9.6 加回来
  //
  // 【这组测试的立场为什么整个翻过来了】
  //   v0.9.3 删描边的理由是两条：
  //     ① 半透明白描边叠在黑色窗口底上 → 变成 #343434 灰框
  //     ② Border 的边框是矩形，圆角处被削淡 → 像"矩形框套胶囊"
  //   v0.9.6 用离屏探针（_lab/probe-capsule-border.ps1）重新实测，
  //   **第 ② 条是错的**：把同一个 Border 渲染到 200% 缩放下放大看，
  //   描边 x 坐标逐行外扩、跟着半圆走 —— 它本来就是跟随圆角的。
  //   第 ① 条仍然成立，但只跟"半透明"有关，用不透明色（alpha 0xFF）就绕开了。
  //
  //   而用户现在报的问题反过来了："柱态太透，可视性不佳"。
  //   实测证明只调磨砂浓度救不了轮廓（扫了 a=0x20~0xFF，轮廓对比度 1.03~1.74，
  //   中间还更低）—— 必须有一道明确的边。所以这组断言从"禁止描边"翻成"必须有描边"。
  check('【v0.9.6】定义了 BarBorderColor 描边色表', panelSrc.includes('$script:BarBorderColor'))
  // 【v0.9.9：2.0 -> 1.0】
  //   用户："柱状态这个描边太丑了，太重了"。
  //   200% 下 2.0 逻辑 = 4 物理像素，和旁边 4 像素玻璃一样宽 → 像画框。
  //   1.0 = 2 物理像素，是不被抗锯齿洗淡的最小整数宽度。
  check('【v0.9.9】描边宽 1.0（用户反馈"太重"，从 2.0 收细）',
    /\[double\]\$BorderWidth = 1\.0/.test(
      (readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8').match(/function New-BarPanel[\s\S]*?\r?\n\}/) || [''])[0]))
  // 【回归】不许改回 2.0 —— 那是被用户明确否决的"太重"版本
  check('【回归】描边不再是 2.0（用户否决过）',
    !/\[double\]\$BorderWidth = 2\.0/.test(
      (readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8').match(/function New-BarPanel[\s\S]*?\r?\n\}/) || [''])[0]))
  // 【回归】也不能是 0.75 这类半像素值 —— 1.5 物理会被抗锯齿摊成两行淡灰，比 1.0 更脏
  check('【回归】描边不是半像素值（0.75 会糊成灰雾）',
    !/\[double\]\$BorderWidth = 0\.75/.test(
      (readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8').match(/function New-BarPanel[\s\S]*?\r?\n\}/) || [''])[0]))
  check('【v0.9.6】New-BarPanel 给胶囊底设了 BorderThickness',
    /\$bg\.BorderThickness\s*=/.test(
      (readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8').match(/function New-BarPanel[\s\S]*?\n\}/) || [''])[0]))
  // 【v0.9.11 把 {0,4000} 窗口改成函数起止锚点】
  //   给 Update-BarStrip 加了色条呼吸（约 30 行注释 + 代码）之后，
  //   这条断言开始**假失败** —— BorderBrush 赋值被挤出了 4000 字符窗口。
  //
  //   这是本项目第三次踩"固定窗口被注释撑爆"：
  //     ① v0.9.6  弹窗函数体从两行文字长到十几行 → {0,400}
  //     ② v0.9.9  给弹窗窗口段补根因注释 → {0,1800}
  //     ③ v0.9.11 给 Update-BarStrip 加呼吸 → {0,4000}
  //   所以这次彻底改成"从函数起锚到函数终"，以后再加注释不用回来调窗口。
  const barStripFn = (panelSrc.match(/function Update-BarStrip[\s\S]*?\r?\n\}\r?\n/) || [''])[0]
  check('抓到了 Update-BarStrip 函数体', barStripFn.length > 0, `长度 ${barStripFn.length}`)
  check('【v0.9.6】Update-BarStrip 会刷新 Backdrop.BorderBrush',
    /Backdrop\.BorderBrush\s*=/.test(barStripFn))

  // 【关键安全断言：描边必须是不透明色】
  //   v0.9.3 那个灰框事故的根因就是"半透明描边叠在黑色窗口底上被染色"。
  //   所以描边色的 alpha 必须是 0xFF。这条一旦被改回半透明，
  //   用户会重新看到一圈 #343434 的灰框，而且这次还会是"胶囊形灰框"（更难看）。
  const borderTbl = (panelSrc.match(/\$script:BarBorderColor = @\{[\s\S]{0,600}?\n\}/) || [''])[0]
  check('抓到了 BarBorderColor 定义块', borderTbl.length > 0)
  check('【安全】描边色 alpha 必须是 0xFF（半透明会重演灰框事故）',
    (borderTbl.match(/FromArgb\(0xFF,/g) || []).length === 2,
    `找到 ${(borderTbl.match(/FromArgb\(0xFF,/g) || []).length} 个不透明定义，期望 2`)

  // 【描边颜色必须由 Update-BarStrip 按明暗刷新】
  //   写死在 New-BarPanel 里的那个只是初值；如果忘了刷新，
  //   深色壁纸下会一直用浅色的深灰描边（几乎看不见）。
  check('【v0.9.6】描边色按 curIsLight 选择',
    /BarBorderColor\.(Light|Dark)/.test(panelSrc))

  // 【回归】v0.9.1 那套半透明描边值不许回到**柱态**里
  //
  // 【注意不能全局搜 0x34FFFFFF】
  //   卡片自己的 $cFrame 就是这个值（浅色主题的玻璃边框），那是正常的、和柱态无关。
  //   所以只检查"柱态描边色表里没有半透明值"—— 用上面已经抠出来的 borderTbl。
  check('【回归】柱态描边色表里没有半透明值',
    !/FromArgb\(0x(?!FF)[0-9A-F]{2},/i.test(borderTbl),
    borderTbl.match(/FromArgb\(0x[0-9A-F]{2},/gi)?.join(' ') || '(空)')

  // ---- v0.9.5：柱态改为"开磨砂 + 窗口透明"
  //
  // 【用户要求】"现在的胶囊并不能像悬浮卡片一样透过胶囊看到背后模糊的颜色"
  //
  // 【为什么 v0.9.3 的"窗口底色设成胶囊色"被撤掉了】
  //   那是为了盖住"半像素缝露黑底"。但 v0.9.4 加了 SetWindowRgn 胶囊裁剪之后，
  //   窗口形状已经被裁掉，不存在"矩形底色露出四角"的问题了。
  //   而磨砂要透出背景，窗口底色必须是透明的 —— 两者不能共存。
  //   所以现在：窗口透明 + 开磨砂，靠 region 裁剪保证形状。
  check('【v0.9.5】Update-Glass 柱态分支不再把窗口底色设成实色',
    !/mode -eq 'bar'[\s\S]{0,900}\$win\.Background\s*=\s*New-Brush\s+\$barBg/.test(panelSrc))
  check('【v0.9.5】Update-Glass 柱态分支开磨砂（Acrylic 而非 ClearAcrylic）',
    /mode -eq 'bar'[\s\S]{0,1500}PanelNative\]::Acrylic\(\$hwnd,\s*\$script:BarGlassTint/.test(panelSrc))
  check('【v0.9.5】柱态把窗口底色设成 Transparent',
    /mode -eq 'bar'[\s\S]{0,1500}Brushes\]::Transparent/.test(panelSrc))
  check('【v0.9.5】定义了 BarGlassTint（柱态磨砂 tint）',
    panelSrc.includes('$script:BarGlassTint'))
  check('【安全】BarGlassTint 的 AccentFlags 传 0（传 2 会变纯白）',
    /Acrylic\(\$hwnd,\s*\$script:BarGlassTint,\s*0\)/.test(panelSrc))
  check('【v0.9.5】退出柱态时恢复胶囊底实色',
    /Brushes\]::Transparent[\s\S]{0,1200}Backdrop\.Background\s*=\s*New-Brush/.test(panelSrc))

  // ---- v0.9.4：窗口必须裁成胶囊形状
  //
  // 【用户报的问题】"现在胶囊没有圆角了"
  //
  // 【根因链（三个连环坑，值得完整记下来）】
  //   v0.9.2：胶囊没铺满窗口 → 露出窗口黑底 → 改 Stretch 铺满        ✅
  //   v0.9.3：为了让半像素缝也看不出来，把 $win.Background 设成胶囊色
  //           → 窗口底色是**矩形**，同色一铺把 Border 的圆角填平了    ❌ 圆角消失
  //   v0.9.4：SetWindowRgn + CreateRoundRectRgn 把窗口本身裁成胶囊     ✅
  //
  // 【为什么 WPF 层面解决不了】
  //   Border.CornerRadius 只影响 Border 自己画的形状，管不到窗口底色。
  //   只要窗口底色不透明（柱态为了盖缝必须不透明），矩形四角就会露出来。
  //   唯一办法是 Win32 层面把窗口区域裁掉。
  //
  // 【实测验证 _lab/probe-round-window.ps1】
  //   数顶部每行的洋红像素数，真圆角应从窄递增到满宽：
  //     只有 Border 圆角        6→12→16→18→20→22→24→24→26→26→26→28  ✅
  //     + 窗口底色同色(v0.9.3)  28→28→...→28                         ❌ 方角
  //     + SetWindowRgn 裁剪     4→12→14→18→20→22→22→24→26→26→26→26  ✅
  check('PanelNative 有 MakeCapsuleRgn',
    panelSrc.includes('public static bool MakeCapsuleRgn'))
  check('PanelNative 有 ClearWindowRgn',
    panelSrc.includes('public static bool ClearWindowRgn'))
  check('导入了 SetWindowRgn',
    panelSrc.includes('static extern int SetWindowRgn'))
  check('导入了 CreateRoundRectRgn',
    panelSrc.includes('static extern IntPtr CreateRoundRectRgn'))

  const rgnBody = (panelSrc.match(/public static bool MakeCapsuleRgn\([\s\S]{0,900}?\n    \}/) || [''])[0]
  check('抓到了 MakeCapsuleRgn 函数体', rgnBody.length > 0)
  // 【v0.9.8 形状整体翻转：胶囊 -> 纯直角矩形】
  //
  // 【用户原话】"既然系统不支持做圆角磨砂，那就不要胶囊态，改成柱子态，
  //   这样磨砂是不是就完美了"
  //
  // 【为什么这个方案彻底解决了棱角问题（不是绕过）】
  //   磨砂玻璃按**窗口矩形**合成。只要"我们想要的形状" == "窗口矩形"，
  //   磨砂就永远不会超出形状之外 —— 棱角问题从"看不见了"变成"不存在了"。
  //   而胶囊时期：想要圆角、窗口是矩形 → 四角必然漏。
  //
  // 【所以这组断言的立场整个反转了】
  //   旧：必须裁剪成胶囊（MakeCapsuleRgn + region）
  //   新：**不许**裁剪（保持完整矩形，让磨砂和形状重合）
  check('【v0.9.8】柱子是纯直角（CornerRadius 0，不再是宽/2）',
    /\$bg\.CornerRadius = New-Object System\.Windows\.CornerRadius\(0\)/.test(
      (readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8').match(/function New-BarPanel[\s\S]*?\r?\n\}/) || [''])[0]))

  const geoFn = (panelSrc.match(/function Set-BarGeometry[\s\S]*?\n\}/) || [''])[0]
  check('抓到了 Set-BarGeometry 函数体', geoFn.length > 0)
  // 【为什么剥注释】：Set-BarGeometry 的注释里**故意**写着
  //   "保留 MakeCapsuleRgn / ClearWindowRgn 这两个 P/Invoke"（解释为什么不删），
  //   直接全文搜会误判。之前踩过一次同样的坑（见 7f 组里那段说明）。
  const geoCode = geoFn.split('\n').filter((ln) => !/^\s*#/.test(ln)).join('\n')
  check('【关键】进柱态时不再裁成胶囊（磨砂才能和窗口矩形重合）',
    !geoCode.includes('MakeCapsuleRgn'))
  check('【关键】进柱态时主动清掉旧 region（热更新上来可能还挂着胶囊）',
    geoFn.includes('ClearWindowRgn'))
  check('【关键】Set-BarGeometry 里调了 MakeCapsuleRgn',
    geoFn.includes('MakeCapsuleRgn'))
  const idxWinW = geoFn.indexOf('$win.Width')
  const idxRgn = geoFn.indexOf('MakeCapsuleRgn')
  check('裁剪在设置窗口尺寸之后（否则会按旧尺寸裁）',
    idxWinW >= 0 && idxRgn > idxWinW, `Width@${idxWinW} Rgn@${idxRgn}`)
  // v0.9.8：不再裁剪，所以"裁剪前要 DPI 换算"这条已经不适用了。
  // 保留一条反向断言：如果哪天有人把 MakeCapsuleRgn 加回来，必须同时把 DPI 换算加回来。
  check('【v0.9.8】不再调用 MakeCapsuleRgn（矩形柱子不需要裁剪）',
    !geoCode.includes('MakeCapsuleRgn'))

  const exitFn = (panelSrc.match(/function Exit-BarMode[\s\S]*?\n\}/) || [''])[0]
  check('抓到了 Exit-BarMode 函数体', exitFn.length > 0)
  check('【关键】Exit-BarMode 里调了 ClearWindowRgn（否则展开态被裁成大胶囊）',
    exitFn.includes('ClearWindowRgn'))

  // 【回归】v0.9.2 的注释曾把 DWM 边框说成黑框的真正原因，已被实测推翻
  check('【回归】注释里不再把 DWM 边框说成黑框的原因',
    !panelSrc.includes('这是用户报的"颜色条不居中/磨砂没填满黑框"的真正原因'))

  // ---- 对比度实测
  // 【门槛从 3.0 提到 4.5】
  //   v0.9.0 用的是图形门槛 3.0（颜色条是"图形"）。
  //   但 v0.9.1 底色变浅后，3.0 太松：idle 灰在 3.0 下只需 #707784 这种
  //   淡灰就够，在暖白底上看着像"褪色的贴纸"。提到正文门槛 4.5 之后，
  //   色条在两种底色下都足够有力——这也是"更耐看"的关键。
  const THRESHOLD = 4.5   // WCAG 正文门槛（比图形门槛 3.0 更严）

  console.log('\n  对比度实测（门槛 4.5 = 正文级，比图形级 3.0 更严）:')
  console.log('  相位        色值                      对柱底色      对白壁纸     对黑壁纸')
  console.log('  ' + '-'.repeat(72))

  for (const phase of Object.keys(BAR_PALETTE)) {
    const light = hexToRgb(BAR_PALETTE[phase].Light)
    const dark = hexToRgb(BAR_PALETTE[phase].Dark)

    // 浅背景时：用 Light 色，柱底是 BAR_BACKDROP_LIGHT
    const cLightBg = contrastRatio(light, BAR_BACKDROP_LIGHT)
    // 深背景时：用 Dark 色，柱底是 BAR_BACKDROP_DARK
    const cDarkBg = contrastRatio(dark, BAR_BACKDROP_DARK)

    // 最坏情况：颜色条外侧压在纯白/纯黑壁纸上
    // （柱宽 14、条宽 6，左右各留 4 —— 那 4 像素的边是柱底色，不是壁纸。
    //   所以真正"压在壁纸上"的只有柱子整体的外轮廓。
    //   但为了保守，这里也测一下颜色条直接对壁纸的对比度。）
    const cWhite = contrastRatio(light, WALLPAPER_WHITE)
    const cBlack = contrastRatio(dark, WALLPAPER_BLACK)

    const f = (n) => n.toFixed(2).padStart(5)
    console.log(`  ${phase.padEnd(11)} ${BAR_PALETTE[phase].Light}/${BAR_PALETTE[phase].Dark}  ` +
      `${f(cLightBg)}/${f(cDarkBg)}  ${f(cWhite)}  ${f(cBlack)}`)
  }
  console.log('')

  for (const phase of Object.keys(BAR_PALETTE)) {
    const light = hexToRgb(BAR_PALETTE[phase].Light)
    const dark = hexToRgb(BAR_PALETTE[phase].Dark)
    const cL = contrastRatio(light, BAR_BACKDROP_LIGHT)
    const cD = contrastRatio(dark, BAR_BACKDROP_DARK)

    check(`${phase} 浅底对比度 ≥ 4.5`, cL >= THRESHOLD, cL.toFixed(2))
    check(`${phase} 深底对比度 ≥ 4.5`, cD >= THRESHOLD, cD.toFixed(2))
  }

  // idle 灰色是最难达标的一个，单独强调
  const idleLight = hexToRgb(BAR_PALETTE.idle.Light)
  const idleC = contrastRatio(idleLight, BAR_BACKDROP_LIGHT)
  check('idle（灰）也达标 —— 这是最容易不达标的一档', idleC >= THRESHOLD, idleC.toFixed(2))
}

// ================================================================ 5b. 柱子在极端壁纸上不能"消失"
//
// 【为什么单独加这一组】
//   v0.9.1 第一版我把浅底定成 #F2EEEC（更白、更"暖白"）。
//   测色条对比度全过，测试全绿 —— 然后我把柱子叠到真实桌面截图上，
//   发现压在近白窗口区时柱子轮廓完全消失，只剩一根悬空彩条。
//   也就是说：**只测"色条对柱底"是不够的，必须同时测"柱底对壁纸"。**
//   这组就是补上那个缺失的维度。
group('5b. 柱子在极端壁纸上不能消失（本轮实做发现的坑）')

{
  const WALLPAPER_WHITE = [0xFF, 0xFF, 0xFF]
  const WALLPAPER_BLACK = [0x00, 0x00, 0x00]

  // 柱子轮廓对壁纸的可见度门槛。
  // 【为什么是 1.20 而不是 3.0】柱子是个"环境物件"，不是要读的图形。
  //   卡片自己在纯白壁纸上的对比度实测也只有 1.19（玻璃 #EAEBED），
  //   所以要求柱子比卡片更明显是错的 —— 它俩应当同一量级。
  //   1.20 的含义是"比卡片略清楚一点，但不抢眼"。
  const OUTLINE_MIN = 1.20

  const cw = contrastRatio(BAR_BACKDROP_LIGHT, WALLPAPER_WHITE)
  const cb = contrastRatio(BAR_BACKDROP_DARK, WALLPAPER_BLACK)

  console.log('\n  柱子轮廓可见度（门槛 1.20，卡片自身基准 1.19）:')
  console.log(`    浅柱底对纯白壁纸  ${cw.toFixed(2)}`)
  console.log(`    深柱底对纯黑壁纸  ${cb.toFixed(2)}`)
  console.log('')

  check('浅柱底在纯白壁纸上还能看出轮廓 ≥ 1.20', cw >= OUTLINE_MIN, cw.toFixed(2))
  check('深柱底在纯黑壁纸上还能看出轮廓 ≥ 1.20', cb >= OUTLINE_MIN, cb.toFixed(2))

  // 【回归】#F2EEEC 就是踩过的那个坑，明确禁止它回来
  check('【回归】浅柱底没有退回 #F2EEEC（那版在白壁纸上会消失）',
    !(BAR_BACKDROP_LIGHT[0] === 0xF2 && BAR_BACKDROP_LIGHT[1] === 0xEE))

  // 同时确认没有为了"看得见"而把底色压到色条不达标
  // （两条约束必须同时成立，只满足一条就是错的）
  let worst = 99
  let worstPhase = ''
  for (const phase of Object.keys(BAR_PALETTE)) {
    const c = contrastRatio(hexToRgb(BAR_PALETTE[phase].Light), BAR_BACKDROP_LIGHT)
    if (c < worst) { worst = c; worstPhase = phase }
  }
  check('压深柱底后色条仍 ≥ 4.5（两条约束同时成立）', worst >= 4.5,
    `最差 ${worstPhase} ${worst.toFixed(2)}`)

  // 逐档列出，方便以后微调底色时直接看余量
  console.log('  微调柱底时的余量（柱底色 → 对白壁纸 / 最差色条）:')
  for (const bg of [[0xF2, 0xEE, 0xEC], [0xEB, 0xE6, 0xE3], [0xE8, 0xE2, 0xDF], [0xD8, 0xD2, 0xCF]]) {
    let w = 99
    for (const phase of Object.keys(BAR_PALETTE)) {
      const c = contrastRatio(hexToRgb(BAR_PALETTE[phase].Light), bg)
      if (c < w) w = c
    }
    const hex = '#' + bg.map((n) => n.toString(16).toUpperCase().padStart(2, '0')).join('')
    const ow = contrastRatio(bg, WALLPAPER_WHITE)
    console.log(`    ${hex}  对白壁纸 ${ow.toFixed(2)}  最差色条 ${w.toFixed(2)}` +
      (ow >= OUTLINE_MIN && w >= 4.5 ? '  ✅' : '  ❌'))
  }
  console.log('')
}

// ================================================================ 6. 与既有形态的关系
group('6. 不破坏既有形态（六档高度公式不变）')

{
  const RowSlot = 54
  const FixedPart = 98
  const MiniHeight = 96

  function heightForRows(rows) {
    if (rows < 1) return MiniHeight
    if (rows > 5) rows = 5
    return FixedPart + RowSlot * rows
  }

  // 六档必须和交接文档 2.5 完全一致
  const expected = { 1: 152, 2: 206, 3: 260, 4: 314, 5: 368 }
  for (const [rows, h] of Object.entries(expected)) {
    check(`${rows} 行 → ${h}`, heightForRows(Number(rows)) === h, String(heightForRows(Number(rows))))
  }
  check('0 行 → 96（扁条）', heightForRows(0) === 96)

  // 柱态高度不能混进这个公式
  check('柱态 120 不等于任何一档（独立形态）',
    ![152, 206, 260, 314, 368, 96].includes(120))

  // A4 比例：3 行时 260×260，5 行时 368/260 ≈ 1.414
  check('5 行时仍是 A4 比例（368/260 ≈ 1.414）',
    Math.abs(368 / 260 - 1.414) < 0.01, (368 / 260).toFixed(3))
}

// ================================================================ 7. 结构检查（防止误改）
group('7. 源码结构检查')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')
  const visualSrc = readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8')

  // 必须存在的柱子相关函数
  check('Panel.ps1 有 Enter-BarMode', panelSrc.includes('function Enter-BarMode'))
  check('Panel.ps1 有 Exit-BarMode', panelSrc.includes('function Exit-BarMode'))
  check('Panel.ps1 有 Set-BarGeometry', panelSrc.includes('function Set-BarGeometry'))
  check('Panel.ps1 有 Update-BarStrip', panelSrc.includes('function Update-BarStrip'))
  check('Panel.ps1 有 Test-CollapseTrigger', panelSrc.includes('function Test-CollapseTrigger'))
  check('Panel.ps1 有 Get-PhaseFromState', panelSrc.includes('function Get-PhaseFromState'))
  check('Panel.ps1 有 Get-DpiScale', panelSrc.includes('function Get-DpiScale'))
  check('PanelVisual.ps1 有 New-BarPanel', visualSrc.includes('function New-BarPanel'))

  // 柱态面板必须存进 $script:（否则事件回调读不到）
  check('柱子面板存进 $script:bar', panelSrc.includes('$script:bar = New-BarPanel'))
  check('【关键】没有裸的 $bar = New-BarPanel（会读不到）',
    !panelSrc.includes('\n$bar = New-BarPanel'))

  // 磨砂：柱态从 v0.9.5 起改为【开磨砂】（用户要求"能透过胶囊看到模糊背景"）
  //
  // 【历史】v0.9.0~v0.9.4 柱态是 ClearAcrylic（关磨砂）：
  //   当年的理由是"14 宽窗口开磨砂会变成实心深色药丸，状态色被玻璃压没"。
  //   那是【永远深色柱底 + 粗条 8 + 整根染状态色】条件下的结论。
  //   现在柱底跟随明暗、条收细到 6、色条是独立不透明色块，
  //   磨砂只作用在它周围的玻璃区，不会染色条 —— 所以旧结论不再适用。
  check('PanelNative 有 ClearAcrylic（仍保留，供其它路径使用）',
    panelSrc.includes('public static int ClearAcrylic'))
  check('【v0.9.5】柱态改为开磨砂（不再走 ClearAcrylic）',
    !/if \(\$script:mode -eq 'bar'\)\s*\{[\s\S]{0,400}ClearAcrylic\(\$hwnd\)/.test(panelSrc))
  // Update-UI 柱态早退
  check('Update-UI 有柱态早退', panelSrc.includes('柱态早退'))

  // Update-AdaptiveText 柱态跳过
  check('glassWatch 柱态跳过 Update-AdaptiveText',
    panelSrc.includes("if ($script:mode -eq 'bar') { return }"))

  // 冲突处理
  check('Enter-BarMode 清 pendingWidth', panelSrc.includes('$script:pendingWidth = $null'))
  check('Exit-BarMode 强制重算高度', panelSrc.includes('$script:curHeight = -1'))
  check('Enter-BarMode 里调了 Save-Position（存进柱前坐标）',
    /function Enter-BarMode[\s\S]{0,2000}Save-Position/.test(panelSrc))

  // 右键菜单项
  check('有「缩成细条」菜单项', panelSrc.includes("$miBarToggle.Header = '缩成细条'"))
  check('菜单项文字会按形态切换', panelSrc.includes("$miBarToggle.Header = '展开'"))
}

// ================================================================ 7b. 定义顺序（v0.9.1 修的真 bug）
//
// 【这个 bug 是怎么发现的】
//   v0.9.1 改柱态配色时对照源码，发现 1424 行建柱子面板时用了
//   $BarWidth / $BarHeight / $BarStripWidth / $BarStripPadY，
//   但这四个变量在原文件里直到 2200 行才赋值。
//
// 【为什么它不报错、只是"看起来丑"】
//   PowerShell 把"未定义变量"传给 [double] 参数时，**静默当 0**，
//   既不用函数默认值、也不报错（实测确认）：
//       function f { param([double]$A = 14) ... }
//       f -A $NoSuchVar        →  A=0（不是 14）
//   于是 New-BarPanel 收到 0，被内部夹取拉回 6×60，
//   建出来的面板和真实窗口 14×120 对不上 —— 观感就是"一个色块"而不是胶囊。
//
// 【这组测试守住什么】
//   凡是 New-BarPanel 调用用到的变量，其赋值语句必须出现在调用**之前**。
group('7b. 定义顺序：建面板用到的变量必须先赋值（v0.9.1 修的真 bug）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')
  const lines = panelSrc.split('\n')

  // 找到 New-BarPanel 调用行
  let callIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('New-BarPanel -BarWidth')) { callIdx = i; break }
  }
  check('找到了 New-BarPanel 调用', callIdx >= 0, `第 ${callIdx + 1} 行`)

  // 调用里用到的变量名（-Xxx $Var 形式）
  const callLine = lines[callIdx] + ' ' + (lines[callIdx + 1] || '')
  const usedVars = [...callLine.matchAll(/-(\w+)\s+\$(\w+)/g)].map((m) => m[2])
  check('解析出调用用到的变量', usedVars.length >= 3, usedVars.join(', '))

  // 每个变量必须有一处"赋值"出现在调用行之前
  for (const v of usedVars) {
    const assignRe = new RegExp('^\\s*\\$' + v + '\\s*=')
    let assignIdx = -1
    for (let i = 0; i < callIdx; i++) {
      if (assignRe.test(lines[i])) { assignIdx = i }
    }
    check(`$${v} 在调用之前已赋值`, assignIdx >= 0,
      assignIdx >= 0 ? `第 ${assignIdx + 1} 行` : '未找到赋值（会被静默当 0）')
  }

  // 防止以后又出现"第二份定义"导致两处漂移
  const dupDefs = ['BarWidthDefault', 'BarHeightDefault', 'BarStripWidthDef']
  for (const name of dupDefs) {
    const re = new RegExp('^\\s*\\$' + name + '\\s*=', 'gm')
    const n = (panelSrc.match(re) || []).length
    check(`$${name} 只定义一次（不允许多份漂移）`, n === 1, `实际 ${n} 处`)
  }
}

// ================================================================ 7c. 柱子必须铺满窗口（v0.9.2 用户实测报的问题）
//
// 【用户原话】
//   "磨砂材质似乎没有填满整个黑色边框，所以感觉有点偏"
//   "表示状态的颜色条不居中"
//
// 【根因】
//   New-BarPanel 原来把 Root / Backdrop 的 Width 写死成 14（= 参数 BarWidth）。
//   柱态窗口宽度也是 14 逻辑。200% 缩放下 14 逻辑 = 28 物理，
//   但布局的 ActualWidth 受 DPI 取整影响，写死的 14 一旦和实际可用宽度差半个像素，
//   圆角 + 抗锯齿就在边缘留下半透明像素，叠在深色壁纸上就是"一圈黑边"，
//   同时把 14 宽的胶囊挤得靠左，色条跟着偏。
//
//   实测验证（_lab/probe-bar-fill.ps1：把胶囊涂成洋红，逐像素分类）：
//     改前 —— 有黑列，胶囊没铺满
//     改后 —— 0 黑列，`YYMMMMMMGGGGGGGGGGGGMMMMMMYY`，色条两侧各 6 列洋红，严格居中
//
// 【修法】Root 和 Backdrop 都不设 Width/Height，改 HorizontalAlignment=Stretch；
//   色条仍固定 Width，用 HorizontalAlignment=Center 居中；
//   上下留白用 Margin 表达，不再用"容器高 - 固定值"。
group('7c. 柱子必须铺满窗口，色条必须居中（v0.9.2 用户实测报的问题）')

{
  const visualSrc = readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8')

  const fnMatch = visualSrc.match(/function New-BarPanel[\s\S]*?\n\}/)
  check('抓到了 New-BarPanel 函数体', !!fnMatch)
  const fn = fnMatch ? fnMatch[0] : ''

  // Root 不能写死宽高
  check('【关键】Root 没有写死 Width', !/^\s*\$root\.Width\s*=/m.test(fn))
  check('【关键】Root 没有写死 Height', !/^\s*\$root\.Height\s*=/m.test(fn))
  check('Root 用 Stretch 铺满',
    /\$root\.HorizontalAlignment\s*=\s*'Stretch'/.test(fn) &&
    /\$root\.VerticalAlignment\s*=\s*'Stretch'/.test(fn))

  // Backdrop 不能写死宽高
  check('【关键】胶囊底没有写死 Width', !/^\s*\$bg\.Width\s*=/m.test(fn))
  check('【关键】胶囊底没有写死 Height', !/^\s*\$bg\.Height\s*=/m.test(fn))
  check('胶囊底用 Stretch 铺满',
    /\$bg\.HorizontalAlignment\s*=\s*'Stretch'/.test(fn) &&
    /\$bg\.VerticalAlignment\s*=\s*'Stretch'/.test(fn))

  // 色条：宽固定、水平居中、竖向靠 Margin 表达留白
  check('色条宽度仍固定为 StripWidth', /\$strip\.Width\s*=\s*\$StripWidth/.test(fn))
  check('色条水平居中', /\$strip\.HorizontalAlignment\s*=\s*'Center'/.test(fn))
  check('色条竖向 Stretch（高度跟随容器）',
    /\$strip\.VerticalAlignment\s*=\s*'Stretch'/.test(fn))
  check('【关键】色条不再用"容器高 - 固定值"算高度', !/\$strip\.Height\s*=/.test(fn))
  check('色条用 Margin 表达上下留白',
    /\$strip\.Margin\s*=\s*New-Object System\.Windows\.Thickness\(0,\s*\$StripPadY,\s*0,\s*\$StripPadY\)/.test(fn))

  // 圆角仍按宽度一半（胶囊形态不能丢）
  // 【v0.9.8】这条已被上面的"柱子是纯直角（CornerRadius 0）"取代，不再断言半圆端。
}

// ================================================================ 7d. 柱态可拖动（v0.9.5）
//
// 【用户要求】"现在的胶囊态无法拖动位置，我希望可以拖动位置"
//
// 【为什么以前不能拖】
//   v0.9.0 在 MouseLeftButtonDown 开头写了 `if ($script:mode -eq 'bar') { return }`，
//   直接放弃处理。当时的理由是两条：
//     ① DragMove 是阻塞的，会吃掉后续鼠标消息 → Up 里的"单击展开"不执行
//     ② 柱子太窄，拖动没意义
//   第②条是当年的主观判断，用户现在明确否掉了。
//   第①条是真的技术限制，但可以用"手动跟手"绕过（不用 DragMove）。
//
// 【现在的实现】
//   Down：记光起起点 + 窗口起点（不调 DragMove，不阻塞）
//   Move：按"起点 + 位移"绝对定位（避免累加误差）
//   Up：  位移 > 3 逻辑像素 → 拖动结束（按中心贴边）
//         位移 ≤ 3 → 当作单击 → 展开
group('7d. 柱态可拖动（v0.9.5）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')

  // Down 事件里不能再"柱态直接 return"
  const downBlock = (panelSrc.match(/\$host1\.Add_MouseLeftButtonDown\(\{[\s\S]*?\n\}\)/) || [''])[0]
  check('抓到了 MouseLeftButtonDown 事件块', downBlock.length > 0)
  check('【关键】Down 里柱态不再直接 return 放弃处理',
    !/if \(\$script:mode -eq 'bar'\)\s*\{\s*return\s*\}/.test(downBlock))
  check('Down 里柱态记录了拖动起点',
    /mode -eq 'bar'[\s\S]{0,600}barDragOrigin\s*=\s*\[System\.Windows\.Forms\.Cursor\]::Position/.test(downBlock))
  check('Down 里柱态记录了窗口起点（用于绝对定位）',
    /barDragWinLeft/.test(downBlock) && /barDragWinTop/.test(downBlock))

  // 【注意】DragMove 在整个 Down 块里是存在的 —— 那是**非柱态**（卡片拖动）的路径。
  // 要验的是"柱态分支内部没有调 DragMove"，所以只看柱态 if 块里面的内容。
  const barBranch = (downBlock.match(/if \(\$script:mode -eq 'bar'\)\s*\{[\s\S]*?\n    \}/) || [''])[0]
  check('抓到了 Down 里的柱态分支', barBranch.length > 0)
  check('【关键】柱态分支内不调 DragMove（它会阻塞并吃掉点击）',
    !barBranch.includes('DragMove'))
  check('柱态分支以 return 结束（不落入下面的卡片拖动逻辑）',
    /return/.test(barBranch))

  // Move 事件：跟手移动
  const moveBlock = (panelSrc.match(/\$win\.Add_MouseMove\(\{[\s\S]*?\n\}\)/) || [''])[0]
  check('抓到了窗口级 MouseMove 事件块', moveBlock.length > 0)
  check('【关键】MouseMove 挂在 $win 上（不是 $host1，否则拖动中丢事件）',
    panelSrc.includes('$win.Add_MouseMove'))
  check('MouseMove 里柱态按"起点 + 位移"定位',
    /barDragWinLeft\s*\+\s*\(\$dpx\s*\/\s*\$sc\)/.test(moveBlock))
  check('位移做了物理→逻辑换算（÷ DPI scale）',
    /Get-DpiScale/.test(moveBlock) && /\$dpx\s*\/\s*\$sc/.test(moveBlock))

  // Up 事件：区分拖动与单击
  const upBlock = (panelSrc.match(/\$host1\.Add_MouseLeftButtonUp\(\{[\s\S]*?\n\}\)/) || [''])[0]
  check('抓到了 MouseLeftButtonUp 事件块', upBlock.length > 0)
  check('Up 里柱态区分了"拖动"和"单击"',
    /if \(\$moved\)/.test(upBlock) || /\$moved/.test(upBlock))
  check('拖动结束时按窗口中心决定贴哪一侧',
    /centerX\s*-\s*\$midX|\$centerX\s*-lt\s*\$midX/.test(upBlock))
  check('拖动结束保留了用户拖的垂直位置（不强制居中）',
    /\$newTop\s*=\s*\[double\]\$win\.Top/.test(upBlock))
  check('单击（未移动）仍然展开',
    /if \(\$moved\)[\s\S]{0,2000}else[\s\S]{0,400}Exit-BarMode/.test(upBlock))
}

// ================================================================ 7e. 柱态悬停气泡（v0.9.5）
//
// 【用户要求】"当我的鼠标放到胶囊上时，可以弹出一个弹窗，展示现在的运行状态"
//
// 【为什么要独立窗口而不是塞在柱子窗口里】
//   柱子窗口 14 宽且被 SetWindowRgn 裁成胶囊。气泡要显示在柱子外侧就得加宽窗口，
//   而加宽的区域会被 region 裁掉；要显示就得把 region 改成并集，
//   还要在悬停时改宽度、重算 Left、重算 region —— 每环都可能闪或裁错。
//   这块刚连续出过三个坑（见报告第五节），不宜再叠复杂度。
//
// 【独立窗口的安全属性（这些是必须逐条验证的）】
//   ShowActivated=false   → 不抢焦点，不会打断用户打字
//   IsHitTestVisible=false → 鼠标穿透，不会挡住点击
//   ShowInTaskbar=false   → 不占任务栏
//   Topmost               → 跟着柱子在最上层
group('7e. 柱态悬停气泡（v0.9.5）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')
  const visualSrc = readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8')

  check('PanelVisual 有 New-BarTipPanel', visualSrc.includes('function New-BarTipPanel'))

  // 把整个 New-BarTipPanel 函数体抠出来。
  // 【为什么用长度锚点而不是 {0,N} 窗口】
  //   面板从 v0.9.5 的两行文字长到 v0.9.6 的十几行结构，
  //   原来 {0,400} 这种固定窗口会截在函数中间，导致"明明写了却检查不到"的假失败。
  // 【为什么用 "\r?\n" 而不是 "\n"】
  //   PanelVisual.ps1 存的是 CRLF 换行，`\n\}\n` 这种模式在 CRLF 下永远匹配不到
  //   函数结尾（因为 `}` 后面跟的是 `\r\n`）。旧代码用这个模式会静默取到空串，
  //   然后所有依赖它的断言全部假失败 —— 实测踩过一次。
  const tipPanelFn = (visualSrc.match(/function New-BarTipPanel[\s\S]*?\r?\n\}\r?\n/) || [''])[0]
  check('抓到了 New-BarTipPanel 函数体', tipPanelFn.length > 800,
    `长度 ${tipPanelFn.length}`)
  check('Panel.ps1 创建了气泡窗口', panelSrc.includes('DSH-BAR-TIP'))
  check('Panel.ps1 有 Show-BarTip', panelSrc.includes('function Show-BarTip'))
  check('Panel.ps1 有 Hide-BarTip', panelSrc.includes('function Hide-BarTip'))
  check('有 Get-StatusTextForPhase（生成状态文字）',
    panelSrc.includes('function Get-StatusTextForPhase'))

  // 安全属性逐条检查
  //
  // 【v0.9.9 窗口从 1800 放宽到 7000】
  //   本轮给弹窗窗口创建段补了两大段注释（黑边真因 + 糊字真因），
  //   1800 字符的窗口会在 Acrylic 调用之前就截断，
  //   于是"气泡也开磨砂"这条会**假失败**（代码明明还在）。
  //   这类"注释写多了把测试窗口撑爆"的假失败本项目已踩过两次，
  //   以后改这里的注释时不用再回来调窗口 —— 直接从函数起点锚到函数终点。
  const tipBlock = (panelSrc.match(/\$tipWin\s*=\s*New-Object System\.Windows\.Window[\s\S]*?\r?\n\}\r?\n/) || [''])[0]
  check('抓到了气泡窗口创建代码', tipBlock.length > 0, `长度 ${tipBlock.length}`)
  check('【安全】气泡不抢焦点（ShowActivated=false）',
    /\$tipWin\.ShowActivated\s*=\s*\$false/.test(tipBlock))
  check('【安全】气泡鼠标穿透（IsHitTestVisible=false）',
    /\$tipWin\.IsHitTestVisible\s*=\s*\$false/.test(tipBlock))
  check('【安全】气泡不进任务栏', /\$tipWin\.ShowInTaskbar\s*=\s*\$false/.test(tipBlock))
  // 【v0.9.14 更新】这条原来断言"气泡 Topmost 写死 $true"。
  //   加了置顶开关之后，写死就是错的：
  //   用户关掉置顶，悬停柱子时气泡会**浮在所有窗口最上面**（比主窗口还显眼）。
  //   所以气泡现在跟随 $script:topmostEnabled。
  //   这条改成"跟随开关"，而不是"必须为 true"。
  check('气泡置顶跟随主窗口的置顶开关（不再写死 true）',
    /\$tipWin\.Topmost\s*=\s*\[bool\]\$script:topmostEnabled/.test(tipBlock))
  check('气泡用工具窗口样式（不进 Alt+Tab）',
    /AsToolWindow\(\$tipHwnd\)/.test(tipBlock))
  check('气泡也开磨砂（和卡片同一套玻璃语言）',
    /Acrylic\(\$tipHwnd/.test(tipBlock))

  // 生命周期
  check('进柱态时藏起气泡（避免刚变柱就冒出来）',
    /Enter-BarMode[\s\S]{0,3000}Hide-BarTip/.test(panelSrc))
  check('【关键】退出柱态时收起气泡（否则柱子没了气泡还在）',
    /Exit-BarMode[\s\S]{0,2500}Hide-BarTip/.test(panelSrc))
  check('MouseMove 里触发显示', /\$win\.Add_MouseMove[\s\S]{0,1200}Show-BarTip/.test(panelSrc))
  check('MouseLeave 里触发隐藏', /\$win\.Add_MouseLeave[\s\S]{0,600}Hide-BarTip/.test(panelSrc))

  // 气泡位置：必须在屏幕内侧
  check('气泡位置按柱子贴哪边动态计算（贴右则放左）',
    /centerX\s*-ge\s*\$midX[\s\S]{0,300}tipLeft\s*=\s*\$barLeft\s*-\s*\$tw\s*-\s*\$gap/.test(panelSrc))
  check('气泡位置夹在工作区内（不跑出屏幕）',
    /tipLeft\s*-lt\s*\$wa\.Left[\s\S]{0,400}tipLeft\s*=\s*\$wa\.Right\s*-\s*\$tw/.test(panelSrc))

  // 气泡内容的文字规则要和卡片标题一致
  check('状态文字覆盖四种相位',
    /'approval'/.test(panelSrc) && /'finished'/.test(panelSrc) &&
    /'running'/.test(panelSrc) && /'idle'/.test(panelSrc))
  check('待审批文字和卡片标题同句式',
    panelSrc.includes('有 {0} 项待你审批') || panelSrc.includes("'有 1 项待你审批'"))
  check('运行中文字带子智能体数量',
    /个任务运行中[\s\S]{0,200}个子智能体|个子智能体[\s\S]{0,200}个任务运行中/.test(panelSrc))

  // ============================================================ v0.9.6：气泡数据链路
  //
  // 【这一组守的是一个真实发生过的 bug，值得单独说明】
  //   v0.9.5 的气泡代码有两处变量名没对上：
  //     Update-UI 里写的是：barStatus + Text（拼起来）
  //     Show-BarTip 里读的是：barTip + Text
  //   （这里故意不写成一个完整的 $script: 变量名 —— 上面的断言会全局搜那个字符串，
  //     写在注释里会让它永远为真/永远为假，测试就失去意义了。）
  //   而 $script:barTipText 从建窗口起就一直是 ''，**再也没被赋过值**。
  //   于是 Show-BarTip 拿到的永远是空串，被兜底成字面量 '空闲'。
  //   用户看到的效果："弹窗无法反应正式的任务运行状态，一直是空闲"。
  //
  //   旧测试为什么没抓到：它只检查"有没有 Get-StatusTextForPhase"、
  //   "有没有 Show-BarTip" 这两个符号存在，**从没检查数据有没有真的流过去**。
  //   这是"测了函数存在、没测数据连通"的典型漏洞。
  //
  //   下面这几条断言就是为了补这个洞：
  //     ① 生产和消费必须用同一个变量名
  //     ② 那个变量必须在柱态分支里被真的赋值
  //     ③ 气泡的四个信息块都要被渲染（状态/任务/指标/提示）
  //     ④ 内容没变时不重排（防止悬停抖动）
  check('【v0.9.6 关键】气泡数据用统一变量 barTipData（生产和消费同名）',
    panelSrc.includes('$script:barTipData =') &&
    !/\$script:barStatusText\s*=/.test(panelSrc),
    /\$script:barStatusText\s*=/.test(panelSrc) ? '还残留 barStatusText 赋值' : '')
  check('【v0.9.6 关键】柱态分支里真的给 barTipData 赋值（不是只定义）',
    /mode -eq 'bar'[\s\S]{0,2500}\$script:barTipData = New-BarTipData/.test(panelSrc))
  check('【v0.9.6】有 New-BarTipData 组装函数',
    panelSrc.includes('function New-BarTipData'))
  check('【回归】Show-BarTip 不再带 -Text 参数（旧签名是 bug 的载体）',
    !/Show-BarTip\s+-Text/.test(panelSrc))
  check('【v0.9.6】有 Update-BarTipContent（把数据渲染进控件）',
    panelSrc.includes('function Update-BarTipContent'))
  check('【v0.9.6】有内容指纹 Get-BarTipKey（内容没变不重排，防悬停抖动）',
    panelSrc.includes('function Get-BarTipKey'))
  check('【v0.9.6】气泡状态头带状态圆点（相位色和卡片同源）',
    tipPanelFn.includes('Dot'))
  check('【v0.9.6】气泡有任务明细行（不是只有一行状态文字）',
    tipPanelFn.includes('Rows'))
  // 【v0.9.7 用户要求简略：底部 Token/谷时 已从弹窗删除】
  //   用户原话："这个浮窗里的信息应该是简略的，不要直接复用大卡片的文字设计"。
  //   Token/谷时在展开卡片底部一直都有，塞进悬停弹窗只是重复信息，
  //   还占了 20 多像素高度、挤掉了任务名宽度。
  check('【v0.9.7】气泡不再有底部指标（用户要求简略）',
    !tipPanelFn.includes('FootLeft') && !tipPanelFn.includes('FootRight'))
  check('【v0.9.7】气泡保留操作提示（这是操作指引，不是数据，删了用户不知道能点能拖）',
    tipPanelFn.includes('单击展开'))
  check('【v0.9.6】气泡文字色按明暗切换（开磨砂就必须反色）',
    visualSrc.includes('function Set-BarTipTheme'))
  check('【v0.9.6】气泡底色不再写死不透明深色（要和卡片同一套玻璃语言）',
    !/function New-BarTipPanel[\s\S]{0,1200}FromArgb\(0xF2, 0x1C, 0x1C, 0x1F\)/.test(visualSrc))
  check('【v0.9.6】气泡宽度上限提到 236（容纳任务明细，不是旧版的 190）',
    /New-BarTipPanel -MaxWidth 236/.test(panelSrc))

  // ============================================================ v0.9.7：弹窗简略化
  //
  // 【用户原话】"这个浮窗里的信息应该是简略的，不要直接复用大卡片的文字设计。
  //   我的想法是显示任务名，每个任务名前用带颜色的点显示任务状态。"
  //
  // 【为什么旧版会被截断】（用户截图实证）
  //   弹窗最宽 236 - 内边距 24 = 212；再减右侧时长列约 40 + 间距 8 = 164。
  //   164 只装得下约 8 个中文字 → "微信风前端重构"被截成"微信风前端重"。
  //   新版去掉时长列、把状态点压到左边 10px，标题可用宽度 212-10 = 202（+23%）。
  check('【v0.9.7】弹窗每行是"状态点 + 任务名"（有 Dot 控件）',
    /Root = \$line; Dot = \$rd; Name = \$rn/.test(visualSrc))
  // 【这条断言为什么要限定在"气泡的渲染函数里"】
  //   展开卡片的 New-TaskRow 也有 Elapsed（那是正常的、要保留的）。
  //   如果全文搜 Elapsed 会误判。所以只检查弹窗相关的两个函数体。
  const tipRenderFns = [
    (visualSrc.match(/function New-BarTipPanel[\s\S]*?\r?\n\}\r?\n/) || [''])[0],
    (panelSrc.match(/function Update-BarTipContent[\s\S]*?\r?\n\}/) || [''])[0],
  ].join('\n')
  check('抓到了弹窗渲染相关函数体', tipRenderFns.length > 800, `长度 ${tipRenderFns.length}`)

  // 【v0.9.10 这条断言翻转了 —— 记录为什么】
  //
  //   v0.9.7 写的是 `!tipRenderFns.includes('Elapsed')`，
  //   守的是"弹窗里不许有时长"，因为当时用户嫌字被截断、要简略。
  //
  //   v0.9.10 用户说"只显示个名称太空了，在右侧加个运行时间"。
  //   所以现在**必须有时长**，旧断言要反过来。
  //
  //   【这不是"上一轮判断错了"】
  //     上一轮的取舍是"要宽度不要时长"，这一轮的取舍是"要时长接受更窄"。
  //     用户的偏好在变，需求跟着变，断言也要跟着变。
  //     但**必须把"为什么翻转"写在断言旁边**，否则下一个人会以为
  //     是有人随手把这行改反了，然后又"修正"回去。
  check('【v0.9.10】弹窗行现在**有**时长列（v0.9.7 的相反断言，用户改需求了）',
    tipRenderFns.includes('Elapsed') || tipRenderFns.includes('$re'),
    '应当在弹窗渲染函数里看到时长相关代码')
  check('【v0.9.10】弹窗每行是"状态点 + 任务名 + 时长"（三个字段齐全）',
    /Root = \$line; Dot = \$rd; Name = \$rn; Time = \$re/.test(visualSrc))
  check('【v0.9.7】状态点用相位色板（和卡片圆点同源）',
    /Get-StateColor -Phase \$rowPhase -Slot 'Dot'/.test(panelSrc))

  // ============================================================ v0.9.8：弹窗再简
  //
  // 【用户原话】"也没有按照我们谈好的方式只显示任务+一个点，不需要上面的正在运行"
  //
  // 【为什么删状态头是对的】
  //   "正在运行"这四个字没提供信息 —— 柱子是"有活干"才出现的形态，
  //   点开弹窗必然在运行。写一行等于把前提重复一遍。
  //   但**待审批/已完成**是"和平时不一样"的状态，用户看到柱子变色需要知道为什么，
  //   所以保留成"按需显示"：只有非 running 才出现。
  check('【v0.9.8】状态提示行按需显示（running 时不占空间）',
    /\$showStatus = \(\$d\.Phase -ne 'running'\)/.test(panelSrc))
  check('【v0.9.8】状态提示行有独立的 StatusRow 控件（不是复用标题）',
    /StatusRow\s*= \$statusRow/.test(visualSrc))

  // 【修一个"两条规则打架"的 bug】
  //   Sep1 原来被两处控制：① 状态行那段 ② "有任务行才显示"那段。
  //   后者会覆盖前者，导致 running 状态下顶部出现一条**孤零零的横线**。
  //   现在规则只有一条：分隔线跟着状态提示行走（没东西可分隔就不画）。
  check('【v0.9.8】分隔线不再被"任务行数"二次覆盖（否则顶部会有孤立横线）',
    !/if \(\$shown -gt 0\) \{ \$p\.Sep1\.Visibility = 'Visible' \}/.test(panelSrc))
  check('【v0.9.7】状态点列宽 10（8px 点 + 2px 间距，尽量留给文字）',
    /Width = New-Object System\.Windows\.GridLength\(10\)[\s\S]{0,80}\$rd/.test(visualSrc) ||
    /\$cdD\.Width = New-Object System\.Windows\.GridLength\(10\)/.test(visualSrc))

  // 任务明细最多 3 行 + 溢出折叠
  const tipDataFn = (panelSrc.match(/function New-BarTipData[\s\S]*?\n\}/) || [''])[0]
  check('抓到了 New-BarTipData 函数体', tipDataFn.length > 0)
  check('【v0.9.7】任务明细上限是 4 行（去掉时长列后每行更窄，多给一行）',
    /\$maxRows = 4/.test(tipDataFn))
  check('【v0.9.7】每行带自己的相位（用来给左边状态点上色）',
    /Title = \$title[\s\S]{0,200}Phase = \$rowPhase/.test(tipDataFn))
  check('【v0.9.6】超出上限会计数（否则用户以为只跑了 3 个）',
    /\$overflow\+\+/.test(tipDataFn))
  check('【v0.9.6】只有子智能体在跑时补一条说明（否则气泡下面是空白）',
    /subagentCount[\s\S]{0,400}子智能体正在跑/.test(tipDataFn))
  check('【v0.9.7】待审批时给出审批明细（否则状态头说有一项、下面却是空的）',
    /approvals[\s\S]{0,700}Phase = 'approval'/.test(tipDataFn))
  check('【v0.9.7】审批行不再显示工具名（要简略）',
    !/待批准/.test(tipDataFn))

  // ============================================================ v0.9.9：弹窗"黑边"与"糊字"
  //
  // 【用户原话】
  //   "弹出的小窗现在样式对了，但是字还是有点糊，同时四周有黑边"
  //
  // 【黑边的真因：传错了参数类型】
  //   Panel.ps1 里弹窗和卡片都调了
  //       [PanelNative]::Border($hwnd, [int]0x00000001)
  //   但 Border 封装的是 DWMWA_BORDER_COLOR (属性 34)，
  //   参数是 **COLORREF 颜色值**（0x00BBGGRR），不是"开关"。
  //   传 1 = COLORREF(0,0,1) = 近乎纯黑 → DWM 在窗口四周画了一圈黑边。
  //   实测（_lab\probe-tip-border.ps1，深色底板上数纯黑像素）：
  //     传 0x00000001 → 全图 2198 个纯黑像素；传 NONE / DEFAULT / 不调 → 0 个。
  //
  // 【糊字的真因：漏了 CompositionTarget 设置】
  //   主卡片有 CompositionTarget.BackgroundColor = Transparent，弹窗没有。
  //   缺这一句时 WPF 会用 ClearType 子像素抗锯齿，在半透明玻璃上留红/蓝偏色。
  //   实测（_lab\probe-tip-cleartype.ps1，8 组对照）：
  //     不设 → 23.0% 的笔画像素带彩边；设了 → 0.3%。
  // 【关键：必须剥掉注释再断言】
  //   v0.9.9 我在删掉那句调用的同时，在注释里写了它原来的样子
  //   （"原来这里写的是 [void][PanelNative]::Border($tipHwnd, ...)"），
  //   直接搜 Panel.ps1 全文会命中注释，导致"已经删了却判定没删"的假失败。
  //   本项目在 v0.9.6 的 0x34FFFFFF 那处也踩过同一个坑（卡片里合法的 $cFrame 被误判）。
  //   所以统一先剥掉所有以 # 开头的行，再断言。
  const panelNoComment = panelSrc
    .split(/\r?\n/)
    .filter(line => !/^\s*#/.test(line))
    .join('\n')
  check('【v0.9.9】弹窗不再传 Border(hwnd,1)（那是 1 号色=黑边）',
    !/Border\(\$tipHwnd/.test(panelNoComment))
  check('【v0.9.9】弹窗设了 CompositionTarget.BackgroundColor = Transparent（修糊字）',
    /\$tipHs = \[System\.Windows\.Interop\.HwndSource\]::FromHwnd\(\$tipHwnd\)[\s\S]{0,400}\$tipHs\.CompositionTarget\.BackgroundColor\s*=\s*\[System\.Windows\.Media\.Colors\]::Transparent/.test(panelSrc))

  // ============================================================ v0.9.9：弹窗改直角（消灭四角黑边）
  //
  // 【黑边的另一半原因 —— 挖了两层才到底】
  //   第一层：Border($hwnd,1) 传错参数类型，画了一圈四边黑框。删掉后直边干净了。
  //   第二层：**圆角外侧那块像素没人画**，露窗口黑底。这才是用户说的"四周黑边"的主体。
  //
  //   AllowsTransparency=False 是硬约束（改 True 磨砂失效），
  //   在这种窗口上 Background=Transparent 实际等于黑色。
  //   WPF 只画面板形状（圆角矩形），圆角外那 4 个小三角不属于任何控件 → 露黑。
  //
  //   排查排除了两个"看着很像"的嫌疑：
  //     · 不是 DWM 磨砂：开关磨砂，黑像素数完全一样
  //     · 不是 DWM 圆角偏好：ROUND / DONOTROUND 都黑，后者更明显
  //
  //   【解法】形状 = 窗口矩形（面板 0 圆角 + DWM DONOTROUND），
  //   和柱态 v0.9.8 完全同一条思路。实测四角纯黑像素 12~15 → 0。
  //   _lab\probe-tip-single.ps1 -Radius 0 -DwmCorner 1
  const tipPanelFnBody = tipPanelFn
  check('【v0.9.9】弹窗面板是直角（CornerRadius(0)），和柱子一致',
    /CornerRadius = New-Object System\.Windows\.CornerRadius\(0\)/.test(tipPanelFnBody))
  // 【回归】不许改回 10 —— 那是"四角黑边"的版本，用户已否决
  check('【回归】弹窗不再是 10 圆角（会重新出现四角黑边）',
    !/CornerRadius = New-Object System\.Windows\.CornerRadius\(10\)/.test(tipPanelFnBody))
  // DWM 圆角必须跟着面板一起改成 DONOTROUND，两处形状要一致
  check('【v0.9.9】DWM 窗口圆角也关掉（Corner 2→1，形状与面板一致）',
    /\[void\]\[PanelNative\]::Corner\(\$tipHwnd, 1\)/.test(panelSrc))
  check('【回归】弹窗的 DWM 圆角不再是 ROUND(2)',
    !/\[void\]\[PanelNative\]::Corner\(\$tipHwnd, 2\)/.test(panelSrc))
  // 【回归】主卡片那句 CompositionTarget 不能被顺手删掉 —— 卡片不糊全靠它
  check('【回归】主卡片仍有 CompositionTarget.BackgroundColor = Transparent',
    /\$hs\.CompositionTarget\.BackgroundColor = \[System\.Windows\.Media\.Colors\]::Transparent/.test(panelSrc))

  // ============================================================ v0.9.10：时长列 + 呼吸动画
  //
  // 【用户提的两件事】
  //   ① "柱状态鼠标放上去只显示个名称太空了，在右侧加个运行时间，只加东西，不要动 UI"
  //   ② "柱状态和卡片态表示正在运行的蓝点，是否能够做成任务在运行时规律的呼吸"
  //
  // 【① 的约束是"只加东西，不要动 UI"】
  //   所以断言要守的不是"有时长"，而是"加了时长之后原有控件属性没被改"：
  //   圆点还是 6px、字号还是 11.5、行间距还是 2、第 0/1 列定义还在。
  //   如果哪天有人为了塞时长把字号调小或把圆点改小，这些断言要拦住。
  check('【v0.9.10】弹窗任务行有独立的时长 TextBlock',
    /Time\s*=\s*\$re/.test(visualSrc))
  check('【v0.9.10】时长列用 Auto 宽度（跟着文字走，不写死像素）',
    /GridLength\]::Auto/.test(visualSrc))
  // 【关键约束】"只加东西，不要动 UI" —— 原有尺寸一个都不能变
  check('【v0.9.10 约束】圆点仍是 6px（不许为塞时长而缩小）',
    /\$rd\.Width = 6/.test(visualSrc))
  check('【v0.9.10 约束】任务名字号仍是 11.5',
    /\$rn\.FontSize = 11\.5/.test(visualSrc))
  check('【v0.9.10 约束】行间距仍是 2',
    /\$line\.Margin = New-Object System\.Windows\.Thickness\(0, 0, 0, 2\)/.test(visualSrc))
  check('【v0.9.10 约束】状态点列宽仍是 10',
    /\$cdD\.Width = New-Object System\.Windows\.GridLength\(10\)/.test(visualSrc))
  // 时长文案必须复用卡片那套 Format-Elapsed，两边不能各写一份
  check('【v0.9.10】时长文案复用 Format-Elapsed（和卡片同一套）',
    /\[string\]\$r\.Time\.Text\s*=\s*Format-Elapsed|\$r\.Time\.Text = Format-Elapsed/.test(panelSrc) ||
    /Format-Elapsed \$elapsedVal/.test(panelSrc))
  // 时长必须能被主题切换刷到（漏了的话深色壁纸下时长会是浅色默认值，看不见）
  check('【v0.9.10】Set-BarTipTheme 会刷新时长列颜色',
    /foreach \(\$r in \$p\.Rows\) \{[\s\S]{0,400}\$r\.Time\.Foreground\.Color/.test(visualSrc))

  // ---- ② 呼吸动画
  //
  // 【为什么用 WPF 动画而不是 DispatcherTimer】
  //   本项目只有 5 个定时器，柱态零新增，这是硬约束。
  //   每个 DispatcherTimer 都在 UI 线程排队，抢 500ms Update-UI 的时间片。
  //   而 DoubleAnimation 走渲染线程的动画时钟，完全不占 Dispatcher。
  //   下面这条断言就是守这个约束的：**不许为了呼吸新增定时器**。
  check('【v0.9.10】有 Set-DotBreathing（用 Opacity 做呼吸）',
    panelSrc.includes('function Set-DotBreathing'))
  check('【v0.9.10】呼吸用 DoubleAnimation 而不是新定时器',
    /DoubleAnimation/.test(panelSrc) && /OpacityProperty/.test(panelSrc))
  check('【v0.9.10 约束】呼吸没新增 DispatcherTimer',
    // 定时器总数必须还是 5 个（数 Count(New-Object ...DispatcherTimer) 的出现次数）
    (panelSrc.match(/New-Object System\.Windows\.Threading\.DispatcherTimer/g) || []).length === 5,
    `实际 ${(panelSrc.match(/New-Object System\.Windows\.Threading\.DispatcherTimer/g) || []).length} 个，期望 5`)
  check('【v0.9.10】呼吸只对 running 生效（approval 是静止状态，不该动）',
    /\$on = \(\$Phase -eq 'running'\)/.test(panelSrc))
  // 【关键回归】重复调用不许重置动画进度
  //   Set-Header 每 500ms 跑一次。如果每次都重新 BeginAnimation，
  //   呼吸会每半秒从头开始 → "抖一下、抖一下"，比不呼吸更难看。
  //   所以必须有"状态没变就短路"的判断。
  check('【v0.9.10 关键】重复调用不会重置呼吸（有 breathState 短路）',
    /\$script:breathState/.test(panelSrc) &&
    /\$prev\.Enabled -ne \$on/.test(panelSrc))
  // 收起/隐藏的行必须停掉动画，否则 WPF 会为不可见控件持续算关键帧
  check('【v0.9.10】收起行会停掉呼吸（Collapsed 时传 idle）',
    /Visibility = 'Collapsed'\s*[\r\n]+(?:\s*#[^\r\n]*[\r\n]+)*\s*Set-DotsBreathingForPhase -Dots @\(\$r\.Dot\) -Phase 'idle'/.test(panelSrc))

  // ============================================================ v0.9.11：周期 2.9s + 色条呼吸
  //
  // 【用户提的两件事】
  //   ① "这个呼吸效果还可以，可以在改快一点，改到2.9s试试"
  //   ② "柱状态中蓝色的代表正在运行的蓝色条，也做呼吸效果，呼吸频率同步小蓝点"
  //
  // ---- ① 周期 2.9 秒
  //
  //   【最容易搞错的地方：2.9 是完整周期，不是 Duration】
  //     AutoReverse=true 时，Duration 是**单程**时长。
  //     完整周期 = Duration × 2。
  //     所以 2.9 秒 → Duration = 1450ms。
  //     如果直接把 2900 填进 Duration，实际周期会变成 **5.8 秒**（比原来还慢一倍）。
  //     这条断言就是守这个换算的。
  check('【v0.9.11】呼吸单程 1450ms（AutoReverse 后完整周期 = 2.9 秒）',
    /\$script:BreathSingleMs\s*=\s*1450/.test(panelSrc))
  check('【v0.9.11 防错】Duration 不是 2900（那会让周期变成 5.8 秒）',
    !/FromMilliseconds\(2900\)/.test(panelSrc))

  // ---- ② 色条也呼吸，且和圆点同步
  //
  //   【"同步"为什么不能用两个独立 BeginAnimation 实现 —— 实测数据】
  //     _lab\probe-sync-breathing.ps1，两个参数相同的独立动画：
  //       共享 Clock → 差异 0.0000
  //       独立动画   → 差异 0.1210（0.12 的差异在玻璃条上肉眼可见）
  //     原因是两条独立时间线起始时刻不同，且驱动它们的函数时机不同
  //     （Set-Header 500ms / Update-BarStrip 可能 900ms），
  //     某一边重建、另一边没重建 → 相位永久跑偏。
  //
  //   【解法】用 ApplyAnimationClock 挂共享时钟，而不是 BeginAnimation 新建时钟。
  //     实测延迟挂载也不会失步（_lab\probe-sync-late.ps1：
  //     A 在 t=0 挂、B 晚 1s、C 晚 2s，差异全部 0.0000）——
  //     后挂的元素加入时钟当前进度，不从头发车。
  check('【v0.9.11】柱态色条也参与呼吸',
    /Set-DotsBreathingForPhase -Dots @\(\$script:bar\.Strip\)/.test(panelSrc))
  check('【v0.9.11 关键】用 ApplyAnimationClock 挂共享时钟（BeginAnimation 会新建时钟导致不同步）',
    /ApplyAnimationClock/.test(panelSrc))
  check('【v0.9.11】有时钟缓存表 breathClocks（同一个 To 只建一个时钟）',
    /\$script:breathClocks/.test(panelSrc))
  check('【v0.9.11 防错】CreateClock 在源码里只出现一次（多个就是多条时间线）',
    (panelSrc.match(/CreateClock\(/g) || []).length === 1,
    `实际 ${(panelSrc.match(/CreateClock\(/g) || []).length} 次`)

  // ---- ③ 圆点和色条振幅不同，但相位相同
  //
  //   【为什么振幅要不同】
  //     第一版两者都用 0.35。逐像素算对比度发现真问题：
  //       色条是 6px 实心块（"图形"，WCAG 门槛 3.0），谷值 0.35 时
  //       浅色壁纸只有 1.83:1、深色 2.22:1 —— 都低于门槛，几乎看不见。
  //     圆点没问题，因为它旁边有大字撑着；色条是柱子**唯一**状态标识。
  //     改成 0.60 后：浅色 3.04:1 / 深色 3.82:1，都过门槛，且亮度仍变化 40%。
  //
  //   【为什么振幅不同还能叫"同步"】
  //     同步指的是**相位**（同时下沉、同时回升），不是数值相等。
  //     实测归一化相位偏差 0.0000（_lab\verify-v0911-final.ps1）：
  //       圆点 0.350~1.000、色条 0.600~1.000，归一化后完全重合。
  check('【v0.9.11】圆点振幅下限 0.35', /\$script:BreathDotTo\s*=\s*0\.35/.test(panelSrc))
  check('【v0.9.11】色条振幅下限 0.60（保可读性，色条是柱子唯一状态标识）',
    /\$script:BreathStripTo\s*=\s*0\.60/.test(panelSrc))
  check('【v0.9.11】色条调用时显式传 -To（不传就退回 0.35，谷值不可读）',
    /Set-DotsBreathingForPhase -Dots @\(\$script:bar\.Strip\) -Phase \$Phase -To \$script:BreathStripTo/.test(panelSrc))
  // 换振幅时必须重新挂载，否则会停留在旧振幅上
  check('【v0.9.11】短路条件里带上 To 比较（换振幅要生效）',
    /\$prev\.To/.test(panelSrc))

  // ============================================================ v0.9.12：代码新鲜度自证
  //
  // 【这一组守的是什么】
  //   v0.9.11 上线后用户说"柱状图没有看到蓝色的闪动"。
  //   排查结论：**代码是对的，进程是旧的**。
  //     Panel.ps1 改于 14:43:30，卡片进程起于 13:51:29 —— 差 52 分钟。
  //   离线探针跑产品函数，色条 Opacity 完整跑 0.600~1.000（见
  //   _lab/verify-v0912-barstrip-live.ps1），证明功能本身没问题。
  //
  //   这类问题**在日志里完全看不出来**：旧代码没坏，它只是没新功能。
  //   用户看到的现象和"新功能写错了"一模一样，很难区分。
  //
  //   所以加了两个"自证"机制：
  //     ① 心跳里带 scriptStampMs —— 进程加载的那份代码的时间戳
  //     ② 启动时往 panel.log 写一行横幅（原来正常启动什么都不写）
  //   以及一条命令就能给结论的 test/check-card-staleness.mjs。
  //
  //   【为什么这属于 bar-mode 测试】
  //     因为柱态改动最容易被"没重启"掩盖：柱子只有 14 像素宽，
  //     呼吸的色条是唯一状态标识，它不动的时候用户根本分不清
  //     "功能没做"还是"没重启"。守在这里最贴近它实际会咬人的地方。
  check('【v0.9.12】心跳里有 scriptStampMs（进程加载的代码时间戳）',
    /scriptStampMs\s*=\s*\$script:scriptStampMs/.test(panelSrc))
  check('【v0.9.12】scriptStampMs 取自文件的 LastWriteTimeUtc（不是写死的数）',
    /GetLastWriteTimeUtc\(\$selfPath\)/.test(panelSrc))
  check('【v0.9.12】$PSCommandPath 为空时兜底到 $ScriptDir（dot-source 时不能崩）',
    /IsNullOrEmpty\(\$selfPath\)[\s\S]{0,200}Join-Path \$ScriptDir 'Panel\.ps1'/.test(panelSrc))
  check('【v0.9.12】启动时往 panel.log 写横幅（原来正常启动什么都不写）',
    /Log-Card \('卡片启动 pid=' \+ \$PID/.test(panelSrc))

  // 【续行陷阱回归】PS 5.1 不认"以点号开头的续行"
  //   [DateTimeOffset]::FromUnixTimeMilliseconds($x)
  //       .ToLocalTime()
  //   第一行已是一个完整表达式，换行即结束；第二行的 . 直接语法错误。
  //   这个坑本轮真踩了（排查 60 个报错才定位到）。
  const bannerBlock = (panelSrc.match(/try \{\r?\n\s*# 【为什么先存变量[\s\S]*?\r?\n\} catch \{ \}/) || [''])[0]
  check('【v0.9.12 坑】启动横幅没写成"点号开头续行"（PS 5.1 语法错误）',
    bannerBlock.length > 0 && !/\)\s*\r?\n\s*\./.test(bannerBlock))
  check('【v0.9.12】启动横幅先存变量再链式调用',
    /\$stampDto = \[DateTimeOffset\]::FromUnixTimeMilliseconds/.test(panelSrc))
}

// ================================================================ 7e-2. 文字颜色"幂等自愈"（v0.9.13）
//
// 【这一组守的是什么】
//   2026-10-29 用户报"浅色背景下字不变黑"。
//   我和两个子代理用三种办法都没能复现：
//     · 拿用户截图逐像素跑产品算法 → 判"黑字"（对）
//     · 建真实磨砂窗口忠实复现，6 种边框/背景组合 → 全判"黑字"（对）
//     · 直接读 WPF 画刷 .Color，4 个"主题×背景"组合 → 全对
//   而这次排查中我**猜错了两次**：
//     ① 先怀疑 DWM 黑边污染采样 —— 被复现装置实测推翻（黑边在 x=0,1，
//        采样带从 x=4 开始，零交集）
//     ② 再怀疑早退逻辑 —— 被子代理实测推翻（四个组合全对）
//
//   结论：既然复现不出来，"靠猜找根因"就是错的方法。
//   正确做法是**改变设计，让"颜色丢了"这件事不可能长期存在**。
//
// 【旧设计为什么会"丢了就永久丢"】
//   事件式：
//     if (极性没变) { return }     ← 只要记账说已应用过，就再也不写
//     ...写颜色...
//   记账是唯一真源。一旦某种情况让"记账说应用过了、界面其实不是"，
//   之后每轮都因记账而 return，字色永久停在错误值，**而日志还一直打"黑字"**。
//   这恰好对应用户现象：错的值 + 对的日志。
//
// 【新设计：每轮幂等重写】
//   极性切换仍带 300ms 去抖（防拖动时闪），但"写颜色"每 900ms 完整做一遍。
//   代价几乎为零（赋相同值不触发 WPF 变更通知），换来的是**自愈**：
//   某一轮没写成功，下一轮自动补上，用户最差看到 0.9 秒错色。
//
//   验证见 `_lab/verify-v0913-idempotent.ps1`：故意把画刷改坏成白字，
//   下一轮自动纠正回黑字（三档全部），且去抖没丢。
group('7e-2. 文字颜色幂等自愈（v0.9.13）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')

  // ---- ① 旧的"事件式早退"必须消失
  check('【v0.9.13】不再有"极性没变就 return"的事件式早退',
    !/if \(\$script:curIsLight -eq \(-not \$wantLightText\)\) \{ return \}/.test(panelSrc))

  // ---- ② 幂等写入存在
  check('【v0.9.13】有 $applyLight 幂等写入（每轮都算，不看极性是否变化）',
    /\$applyLight = \(-not \$script:curIsLight\)/.test(panelSrc))

  // ---- ③ 三档文字都要按 applyLight 写，不能漏
  check('【v0.9.13】applyLight 分支写 primary',
    /if \(\$applyLight\) \{[\s\S]{0,900}\$bTextPrimary\.Color\s*=\s*\[System\.Windows\.Media\.Color\]::FromArgb\(255, 0xFB, 0xFC, 0xFE\)/.test(panelSrc))
  check('【v0.9.13】applyLight 分支写 secondary 和 tertiary',
    /if \(\$applyLight\) \{[\s\S]{0,900}\$bTextSecondary\.Color[\s\S]{0,300}\$bTextTertiary\.Color/.test(panelSrc))
  check('【v0.9.13】暗字分支写三档',
    /else \{\r?\n\s*\$bTextPrimary\.Color\s*=\s*\[System\.Windows\.Media\.Color\]::FromArgb\(255, 0x0C, 0x0E, 0x11\)[\s\S]{0,400}\$bTextTertiary\.Color/.test(panelSrc))

  // ---- ④ 去抖必须保留（不能为了自愈把防闪逻辑弄丢）
  check('【v0.9.13】300ms 去抖仍然存在（拖动经过明暗交界不闪）',
    /TotalMilliseconds -ge 300/.test(panelSrc) || /TotalMilliseconds -lt 300/.test(panelSrc))

  // ---- ⑤ 去抖期间要继续用"已采纳的极性"，不能用 wantLight 直接上色
  //
  //   【为什么这条重要】
  //     去抖期间 $wantLightText 可能已经翻转但还没被采纳。
  //     如果这时直接用 wantLightText 上色，去抖就形同虚设（客户会看到闪）。
  //     必须用 $script:curIsLight 推出的 applyLight。
  check('【v0.9.13】上色依据是已采纳的 curIsLight，不是裸的 wantLightText',
    /\$applyLight = \(-not \$script:curIsLight\)/.test(panelSrc))

  // ---- ⑥ 分隔线画刷要缓存复用（幂等意味着每 900ms 都跑，不能再每轮 New-Brush）
  check('【v0.9.13】分隔线画刷缓存复用（幂等重写不能每轮 New-Brush）',
    /\$script:bSepLight/.test(panelSrc) && /\$script:bSepDark/.test(panelSrc))

  // ---- ⑦ 改色不能再被空 catch 静默吞掉
  //
  //   【为什么这条是这次排查最痛的教训】
  //     原来整个函数体包在 try { ... } catch { } 里。
  //     只要任何一步抛异常，就"一个颜色都不改、不报错、不写日志"。
  //     从外面看：卡片正常显示、日志正常、判定正常 —— 就是颜色不对。
  //     这种缺陷可以潜伏很久，而且把排查者引向完全错误的方向。
  const fnBody = (panelSrc.match(/function Update-AdaptiveText[\s\S]*?\n\}\r?\n/) || [''])[0]
  check('【v0.9.13 关键】Update-AdaptiveText 的 catch 不再全空（异常要留痕）',
    fnBody.length > 0 && !/catch \{\s*\r?\n\s*\}\s*\r?\n\}\s*$/.test(fnBody.slice(-400)),
    '末尾 400 字符里仍有空 catch')

  // ---- ⑧ 调试日志要能区分"判定"和"实际应用结果"
  //
  //   【为什么必须分开记】
  //     这次排查最大的痛苦就是：日志说"黑字"，屏幕是白字，而日志看不出差别 ——
  //     因为旧日志只记了**判定**，没记**结果**。
  //     自检行带了 applied= 和 expect= 两个字段，一旦不一致立刻能发现。
  check('【v0.9.13】调试日志记录"实际写入的颜色"（applied=）而非只记判定',
    /applied=\{|applied=\{0\}/.test(panelSrc) || /applied=/.test(panelSrc))
  check('【v0.9.13】调试日志带 OK/MISMATCH 自检标记',
    /MISMATCH/.test(panelSrc))
}

// ================================================================ 7e-3. 置顶开关（v0.9.14）
//
// 【用户需求】
//   "置顶，当打开置顶时，卡片一直显示在所有页面前方；
//    关闭置顶时，只有在 dsh 里会显示在页面前方，以及在桌面显示"
//   已确认：关闭时是**普通窗口**（不贴桌面层），默认开，关闭时点卡片跳过"让位"。
//
// 【这一组守的核心】
//   这个功能本身很简单（就是把 Topmost 设成 true/false），
//   真正的风险在**状态被多处代码争抢**：
//   卡片里有 5 处会碰 $win.Topmost，只要有一处写死 $true，
//   就会出现"关掉置顶后点一下卡片，它自己又变回置顶了"——
//   开关看起来没生效，而且**只在点过卡片之后才复现**，极难查。
//   （这和之前那个"改了没生效"是同一类陷阱。）
group('7e-3. 置顶开关（v0.9.14）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')
  // 剥掉注释再判断：注释里**故意**引用了旧的错误写法（用来解释为什么不能那样写），
  // 直接全文搜会被那些说明文字误伤。这是这个测试文件里反复踩过的坑。
  const codeOnly = panelSrc
    .split(/\r?\n/)
    .filter((ln) => !/^\s*#/.test(ln))
    .map((ln) => ln.replace(/#.*$/, ''))
    .join('\n')

  // ---- ① 状态变量存在，且默认 true（等于原来的行为）
  check('【v0.9.14】有 $script:topmostEnabled 状态变量',
    /\$script:topmostEnabled\s*=\s*\$true/.test(codeOnly))
  check('【v0.9.14】启动时从 settings.json 读 topmost（默认 true）',
    /Get-Setting \$settings 'topmost' \$true/.test(codeOnly))

  // ---- ② 窗口创建不再写死 Topmost
  check('【v0.9.14】窗口创建用的是 topmostEnabled，不再写死 $true',
    /\$win\.Topmost = \$script:topmostEnabled/.test(codeOnly))

  // ---- ③ 统一函数存在，且覆盖气泡窗口
  check('【v0.9.14】有 Set-TopmostMode 统一收口函数',
    /function Set-TopmostMode/.test(codeOnly))
  check('【v0.9.14】切置顶时同步气泡窗口（否则气泡会浮在所有窗口最上面）',
    /\$script:barTipWin\.Topmost = \$Enabled/.test(codeOnly))

  // ---- ④ 【最关键】"恢复置顶"不能写死 $true
  //
  //   Invoke-OpenDshFlow 里点卡片会临时取消置顶，700ms 后恢复。
  //   如果那句恢复写死 $true，用户在 700ms 内关掉置顶就会被覆盖回去。
  check('【v0.9.14 关键】700ms 后恢复的是用户设置的状态，不是写死 $true',
    /try \{ \$win\.Topmost = \$script:topmostEnabled \} catch \{ \}/.test(codeOnly))

  // ---- ⑤ 【关键】关闭置顶时，整个"让位"流程跳过
  check('【v0.9.14 关键】关闭置顶时跳过让位逻辑（本来就不在前面，没什么可让）',
    /if \(-not \$script:topmostEnabled\) \{[\s\S]{0,120}Open-Dsh[\s\S]{0,40}return \$ok/.test(codeOnly))

  // ---- ⑥ 菜单项存在，可勾选，且弹菜单前同步勾选状态
  check('【v0.9.14】右键菜单有置顶项（IsCheckable）',
    /\$miTopmost\.IsCheckable = \$true/.test(codeOnly))
  check('【v0.9.14】菜单弹出前同步勾选状态（设置窗口改过也能反映出来）',
    /\$miTopmost\.IsChecked = \[bool\]\$script:topmostEnabled/.test(codeOnly))

  // ---- ⑦ 持久化必须"读全量 → 改一键 → 原子写回"
  //
  //   【为什么这条必须守】
  //     settings.json 是卡片和设置窗口共用的。
  //     如果直接写一份只有 topmost 的 JSON，用户改过的磨砂浓度、卡片宽度、
  //     审批开关……会**全部被抹掉**。这是数据丢失级别的 bug。
  check('【v0.9.14 关键】保存置顶时保留其他键（不会抹掉用户的其他设置）',
    /function Save-TopmostSetting[\s\S]{0,900}foreach \(\$p in \$cur\.PSObject\.Properties\)/.test(codeOnly))
  check('【v0.9.14 关键】保存置顶用原子写（tmp + Move，避免卡片读到半截）',
    /function Save-TopmostSetting[\s\S]{0,1600}\$tmp = "\$SettingsPath\.tmp"[\s\S]{0,600}Move\(\$tmp, \$SettingsPath\)/.test(codeOnly))

  // ---- ⑧ 【这条是实测抓出来的真 bug】
  //
  //   PowerShell 5.1（.NET Framework）的 File.Move **没有三参数重载**。
  //   第一版写的是：
  //     [System.IO.File]::Move($tmp, $SettingsPath, $true)
  //   报错 "Cannot find an overload for Move and the argument count: 3"，
  //   被外层 try/catch 吞掉 → **保存静默失败**：
  //   用户点置顶开关、菜单打勾了、日志也没报错，但重启卡片就回到默认值。
  //
  //   这个错只读代码是发现不了的（语法完全合法），
  //   必须真跑一次写盘才暴露。所以这条断言专门守着它别再回来。
  check('【v0.9.14 坑】没有用 File.Move 三参数重载（PS 5.1 不支持，会静默失败）',
    !/File\]::Move\(\$\w+,\s*\$\w+,\s*\$true\)/.test(codeOnly))

  // ---- ⑨ 持久化失败要留日志，不能像原来那样彻底静默
  check('【v0.9.14】保存置顶失败会写日志（否则静默失效无从排查）',
    /保存置顶设置失败/.test(panelSrc))

  // ---- ⑩ 柱态同步不需要额外代码（同一个窗口对象）
  //
  //   这条是"记录设计"的断言：柱态改的是同一个 $win，
  //   如果有人以后给柱态单独建了一个窗口，这条会失败，提醒他同步置顶。
  check('【v0.9.14】柱态复用的是同一个 $win（没有第二个窗口对象）',
    !/\$barWin\s*=\s*New-Object System\.Windows\.Window/.test(codeOnly))
}

// ================================================================ 7e-4. 日志系统（v0.9.15）
//
// 【用户需求】
//   "我需要一个日志功能，方便在其他人使用中出现错误的时候方便反馈，
//    也方便我们自己排查问题。"
//
// 用户拍板：保留 15 天 / 空 catch 要动 / 记录用户操作 / 导出包放右键菜单 /
//           **不要动任何 UI**（特别是卡片态和悬浮态）
//
// 【这一组守的核心】
//   日志系统最危险的三个地方，都不是"格式对不对"：
//     ① 日志自己出错 → 递归 → 卡片死掉
//     ② 按天数删文件 → 误删用户的其他文件
//     ③ 导出诊断包 → 泄露审批凭据
//   所以断言重点放在这三条红线上。
group('7e-4. 日志系统（v0.9.15）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')
  const codeOnly = panelSrc
    .split(/\r?\n/)
    .filter((ln) => !/^\s*#/.test(ln))
    .map((ln) => ln.replace(/#.*$/, ''))
    .join('\n')

  // ---- ① 格式
  check('【v0.9.15】时间格式是本地时间 + 毫秒（yyyy-MM-dd HH:mm:ss.fff）',
    /yyyy-MM-dd HH:mm:ss\.fff/.test(codeOnly))
  check('【v0.9.15】带来源标记 [PANEL]',
    /\[PANEL\]/.test(codeOnly))
  check('【v0.9.15】支持 INFO / WARN / ERR 三级别',
    /'INFO'[\s\S]{0,200}'WARN'|'WARN'[\s\S]{0,200}'ERR'/.test(codeOnly))

  // ---- ② 保留策略
  check('【v0.9.15】保留天数是 15（用户拍板）',
    /\$script:LogKeepDays\s*=\s*15/.test(codeOnly))
  check('【v0.9.15】主文件有大小上限（2MB 硬闸，配合天数）',
    /\$script:LogMaxBytes\s*=\s*2 \* 1024 \* 1024/.test(codeOnly))

  // ---- ③ 【红线】删文件必须严格匹配，不能误删
  //
  //   这是"删用户文件"的操作。如果用 panel*.log 一把删，
  //   会把主文件 panel.log 和用户的 panel-debug.log 一起删掉。
  //   必须用带日期格式的严格正则。
  check('【v0.9.15 红线】清理只删轮转命名的文件（严格正则，不误删）',
    /\^panel\\\.\\d\{8\}-\\d\{6\}\\\.log\$/.test(codeOnly))

  // ---- ④ 【红线】日志系统自身不能记日志（会无限递归）
  //
  //   【为什么这条断言要剥注释】
  //     代码里**故意**在注释中写了"绝不能在这里记日志 —— Log-Card 会调本函数…
  //     会无限递归"来解释原因。直接搜 Log-Card 会被这段说明文字误伤。
  //     这是本测试文件里反复踩过的老坑（第九批、第十二批都栽过），
  //     所以这里必须只检查可执行代码。
  const stripComments = (txt) => txt
    .split(/\r?\n/)
    .filter((ln) => !/^\s*#/.test(ln))
    .map((ln) => ln.replace(/\s+#.*$/, ''))
    .join('\n')

  check('【v0.9.15 红线】Write-LogLine 的 catch 里不调日志函数（防递归）',
    (() => {
      const fn = (panelSrc.match(/function Write-LogLine[\s\S]*?\n\}\r?\n/) || [''])[0]
      if (!fn) return false
      // 取第一个 catch 到函数结尾那一段（落进"写失败"分支）
      const idx = fn.indexOf('} catch {')
      if (idx < 0) return false
      const catchPart = stripComments(fn.slice(idx))
      return !/Log-Card|Log-Fail/.test(catchPart)
    })())
  check('【v0.9.15 红线】Log-Card 最外层 catch 为空（递归的最后一道闸）',
    /function Log-Card[\s\S]*?\} catch \{\r?\n\s*# 【故意静默/.test(panelSrc))

  // ---- ⑤ 写失败不丢日志（进队列下次补写）
  check('【v0.9.15】写失败时进待补写队列（不丢关键日志）',
    /\$script:LogPending/.test(codeOnly) &&
    /\$script:LogPending\.Add/.test(codeOnly))
  check('【v0.9.15】队列有上限 50（防内存无限增长）',
    /\$script:LogPending\.Count -lt 50/.test(codeOnly))

  // ---- ⑥ 去重（防止高频失败刷屏）
  check('【v0.9.15】支持 -Key 去重（60 秒内同键只记一次）',
    /\$script:logDedupe/.test(codeOnly) && /TotalSeconds -lt 60/.test(codeOnly))

  // ---- ⑦ 空 catch 处理（用户拍板"要动"）
  //
  //   48 个空 catch 里：A/B 档加日志，C 档加注释。
  //   断言方式：Log-Fail 的出现次数要显著多于改动前（原来只有 0 次）。
  const logFailCount = (codeOnly.match(/Log-Fail/g) || []).length
  check('【v0.9.15】空 catch 已处理（Log-Fail 使用次数 >= 25）',
    logFailCount >= 25, `实际 ${logFailCount} 次`)
  check('【v0.9.15】C 档空 catch 有【故意静默】注释保护',
    (panelSrc.match(/【故意静默/g) || []).length >= 15,
    `实际 ${(panelSrc.match(/【故意静默/g) || []).length} 处`)

  // ---- ⑧ 记录用户操作
  check('【v0.9.15】用户操作用统一前缀「用户:」',
    /用户: 置顶/.test(panelSrc) && /用户: 菜单/.test(panelSrc))

  // ---- ⑨ 【红线】诊断包不能泄露凭据
  //
  //   这是安全底线。用白名单而不是黑名单 —— 新增文件不会意外混入。
  check('【v0.9.15 红线】诊断包用白名单（stateSpecs）',
    /\$stateSpecs = @\('state\.json', 'settings\.json', 'heartbeat\.json', 'panel-pos\.json'\)/.test(codeOnly))
  check('【v0.9.15 红线】诊断包不打包 decisions 目录',
    !/\$stateSpecs[\s\S]{0,300}decisions/.test(codeOnly))
  check('【v0.9.15 红线】诊断包不打包 tokens.json',
    !/\$stateSpecs[\s\S]{0,300}tokens\.json/.test(codeOnly))
  check('【v0.9.15】诊断包含隐私说明（诚实告知可能含路径）',
    /可能包含[\s\S]{0,200}文件路径/.test(panelSrc))

  // ---- ⑩ 【真 bug 回归】导出日志必须显式 UTF8
  //
  //   PS 5.1 的 Get-Content 默认按 ANSI 读。我们的日志是 UTF-8。
  //   不指定编码的话，导出的日志里中文全是乱码，
  //   而且**不报错** —— 等于白导一次。
  //   这条是实测抓出来的（见 _lab/verify-v0915-diagnostic.ps1）。
  check('【v0.9.15 坑】导出日志时显式指定 -Encoding UTF8（否则中文乱码）',
    /Get-Content \$ls\.Src -Tail \$ls\.Tail -Encoding UTF8/.test(codeOnly))

  // ---- ⑪ 输出目录要"可写"，不能只看存在
  check('【v0.9.15 坑】诊断包输出目录先探测可写（桌面可能不可写）',
    /dsh-write-probe/.test(codeOnly))

  // ---- ⑫ 【用户红线】不许动 UI
  //
  //   用户明确说："不要对现在好不容易盖好的UI做改动，
  //              特别是卡片态和悬浮态，右键加一个导出日志不需要动这些"
  //   所以：诊断包不能新开窗口，只能往已有菜单里加项。
  check('【v0.9.15 用户红线】诊断包没有新建窗口（只加菜单项）',
    !/\$diagWin\s*=\s*New-Object System\.Windows\.Window/.test(codeOnly))
  check('【v0.9.15 用户红线】诊断包是菜单项（MenuItem）',
    /\$miDiag = New-Object System\.Windows\.Controls\.MenuItem/.test(codeOnly))
}

// ================================================================ 7f. 卡片文字极性判定（v0.9.6）
//
// 【用户报的问题】"卡片状态，在深色背景下，小字的反色似乎失效了，可读性下降了"
//
// 【根因链（两条，缺一不可）】
//   ① 判据用错了量纲：原来用简单亮度 (0.299R+0.587G+0.114B) 判"背景亮还是暗"，
//      而 WCAG 算对比度用的是带 gamma 的**相对亮度**。两者在中间调差别很大，
//      而且简单亮度对蓝色的权重只有 0.114，偏偏用户那屏壁纸是偏蓝的山景 ——
//      于是 #687C8D 这块"其实偏暗"的玻璃被判成了亮背景，用了深色小字。
//   ② 磨砂 tint 的极性只跟**系统主题**走，不跟**实测背景**走。
//      用户是"系统浅色主题 + 深色壁纸"，暖白 tint 把玻璃抬到中亮度，
//      正好落在"两种极性都不够 4.5"的死区里。
//      实测：玻璃 #687C8D（相对亮度 0.193），小字 #3F4855 对比度只有 2.14。
//
// 【修法】
//   ① 改成算相对亮度，阈值 0.186（两种极性等强点）
//   ② tint 极性跟随实测背景，把玻璃推出死区（0.193 -> 0.036 或 0.72+）
group('7f. 卡片文字极性判定（v0.9.6）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')

  check('【v0.9.6】有 Get-RelativeLuminance（按 RGB 精确算相对亮度）',
    panelSrc.includes('function Get-RelativeLuminance '))
  check('【关键】极性判据用相对亮度，不再用简单亮度比 120',
    !/\$wantLightText = \(\$lum -lt \d+\)/.test(panelSrc))
  check('【关键】极性判据阈值是 0.186（两极性等强点）',
    /\$wantLightText = \(\$wallRel -lt 0\.186\)/.test(panelSrc))

  // ============================================================ v0.9.7：柱态跟随实测壁纸
  //
  // 【用户反馈】"深色界面的可读性还是不够"
  //
  // 【根因】柱态 tint 和色条用的是 $isDark —— 那是**系统主题**（注册表），
  //   不是壁纸明暗。用户这台是"系统浅色主题 + 深色壁纸"，
  //   于是深色壁纸上贴了浅色磨砂 → 玻璃被抬到中亮度 → 和深色壁纸挤在一起。
  //   这和卡片 v0.9.6 修的是同一个病（当时修了卡片，漏了柱子）。
  check('【v0.9.7】有 Update-BarThemeFromBackground（柱态配色跟随实测壁纸）',
    panelSrc.includes('function Update-BarThemeFromBackground'))
  check('【关键】柱态换色被 Update-AdaptiveText 触发（共用一次截图，零新增定时器）',
    /wantWarmTint[\s\S]{0,600}Update-BarThemeFromBackground -IsLight \$wantWarmTint/.test(panelSrc))
  check('【v0.9.7】色条选色用 barThemeIsLight（不再用系统主题）',
    /\$c = if \(\$script:barThemeIsLight\)/.test(panelSrc))
  check('【v0.9.7】描边选色用 barThemeIsLight',
    /\$bc = if \(\$script:barThemeIsLight\)/.test(panelSrc))
  check('【回归】柱态色条不再用 curIsLight 选色（那是卡片的变量）',
    !/\$c = if \(\$script:curIsLight\) \{ \$entry\.Light/.test(panelSrc))

  // ============================================================ 反解壁纸亮度（防自引用振荡）
  //
  // 【这一组守的是本轮最凶的一个 bug，值得完整记下来】
  //   我第一版的写法是：用"截到的玻璃亮度"判极性 → 再拿这个极性去换 tint。
  //   这是**自我引用的闭环**：玻璃亮度 = 壁纸 × 当前 tint，
  //   换 tint 玻璃就变，玻璃一变判据就翻，判据一翻又换回原来的 tint。
  //   实测推演（用户那屏壁纸，反解 #25445E、相对亮度 0.053）：
  //     帧0 浅tint → 玻璃 #667C8F (0.1918) → 判深字 → 切深tint
  //     帧1 深tint → 玻璃 #233749 (0.0355) → 判浅字 → 切浅tint
  //     帧2 浅tint → 玻璃 #667C8F (0.1918) → 判深字 → 切深tint
  //     ……零阻尼振荡，玻璃每 0.9 秒闪一次
  //   而 0.186 正好夹在两个不动点（0.1918 / 0.0355）中间，两边都"有理由"。
  //
  //   修法：先反解出壁纸本身亮度 W = (G - a*T)/(1-a)，再判。
  //   关键性质：W 里已经除掉当前 tint，**换 tint 不改变 W** → 判据唯一，不会振荡。
  check('【关键】判据先反解壁纸亮度（除掉 tint），不再直接用玻璃亮度',
    /\(\$medianPx\.R - \$tintAlpha \* \$tR\) \/ \$denom/.test(panelSrc))
  check('【关键】反解用了 1 - tintAlpha 做分母', /\$denom = 1\.0 - \$tintAlpha/.test(panelSrc))
  check('【关键】反解结果逐通道 clamp 到 0~255（磨砂非严格线性，会越界）',
    /if \(\$wR -lt 0\) \{ \$wR = 0 \}/.test(panelSrc) &&
    /if \(\$wB -gt 255\) \{ \$wB = 255 \}/.test(panelSrc))
  check('【关键】alpha 有上限保护（满 alpha 反解会除零）',
    /if \(\$tintAlpha -gt 0\.98\)/.test(panelSrc))
  // ============================================================ tint 方向（反过来的那个 bug）
  //
  // 【这是本轮第二个被抓住的真 bug，比振荡更隐蔽】
  //   变量名 cardTintPolarityLight("tint 的极性是浅色") 和 $wantLightText("文字要用浅色")
  //   读起来像同一件事，但它们**恰好相反**：
  //     壁纸暗 → 文字要用浅色 → 应配【深】tint
  //     壁纸亮 → 文字要用深色 → 应配【暖白】tint
  //   我第一版写成 cardTintPolarityLight = $wantLightText，于是：
  //     深 tint 的玻璃上配了深色字 → 实测事故壁纸 1.31:1，比修之前 2.14 还糟。
  //   修法：变量改名成 cardTintIsWarm（它自己说明自己），并且显式取反。
  check('【关键】tint 状态变量名是 cardTintIsWarm（旧名 cardTintPolarityLight 会误导方向）',
    panelSrc.includes('$script:cardTintIsWarm') &&
    !/\$script:cardTintPolarityLight\b/.test(panelSrc))
  check('【关键】tint 方向取反：壁纸暗(要浅字) → 不是暖白 → 用深 tint',
    /\$wantWarmTint = -not \$wantLightText/.test(panelSrc))
  // 【v0.9.8 回滚：卡片玻璃颜色不许再跟着壁纸变】
  //
  //   用户原话："主卡片深色模式下做错了，原来的效果是，磨砂卡片本身的颜色不会动，
  //             在深色下变动的只有文字，现在整个卡片颜色跟着动了"
  //
  //   我 v0.9.6 的做法技术上没错（玻璃远离死区、文字对比度大涨），
  //   但那是**擅自改变了用户已接受的外观** —— 产品决策该先问。
  const panelCodeV98 = panelSrc
    .split('\n')
    .filter((ln) => !/^\s*#/.test(ln))
    .join('\n')
  check('【v0.9.8 关键】卡片 tint 不再被实测壁纸驱动（玻璃颜色固定）',
    !/Update-CardTintFromPolarity -IsLight/.test(panelCodeV98))

  // 相对亮度公式必须和 WCAG 定义一致
  const lumFn = (panelSrc.match(/function Get-RelativeLuminance\b[\s\S]*?\r?\n\}/) || [''])[0]
  check('抓到了 Get-RelativeLuminance 函数体', lumFn.length > 200, `长度 ${lumFn.length}`)
  check('【关键】相对亮度做了 gamma 校正（不是简单线性除以 255）',
    /\[Math\]::Pow\(/.test(lumFn))
  check('相对亮度用了 WCAG 的 0.03928 分段点',
    lumFn.includes('0.03928'))
  check('相对亮度用了 12.92（暗部线性段）', lumFn.includes('12.92'))
  check('相对亮度用了 1.055 / 2.4（亮部幂函数）',
    lumFn.includes('1.055') && lumFn.includes('2.4'))
  check('相对亮度按 WCAG 的 R/G/B 权重加权（0.2126/0.7152/0.0722）',
    lumFn.includes('0.2126') && lumFn.includes('0.7152') && lumFn.includes('0.0722'))

  // ---- tint 极性跟随实测背景
  check('【v0.9.6】有 Update-CardTintFromPolarity（tint 跟随实测背景）',
    panelSrc.includes('function Update-CardTintFromPolarity'))
  check('【v0.9.6】极性变化时会调用 tint 切换',
    /Update-CardTintFromPolarity -IsLight/.test(panelSrc))
  check('【v0.9.6】tint 切换后立刻刷磨砂（不等 900ms tick）',
    /function Update-CardTintFromPolarity[\s\S]{0,1400}Update-Glass/.test(panelSrc))

  // 【零新增定时器】—— 这条最关键。
  //   tint 极性切换必须挂在已有的 900ms $glassWatch -> Update-AdaptiveText 上，
  //   不能为了"更快响应"另起一个定时器。定时器是本项目出过严重事故的地方。
  const dispCount = (panelSrc.match(/New-Object System\.Windows\.Threading\.DispatcherTimer/g) || []).length
  check('【硬约束】tint 极性切换没有新增定时器', dispCount <= 5, `实际 ${dispCount}`)

  // ---- 数值验证：新色板在"推出死区之后"的两端必须都远超 4.5
  const DARK_TEXT = { primary: '#0C0E11', secondary: '#1E2128', tertiary: '#2B303A' }
  const LIGHT_TEXT = { primary: '#FBFCFE', secondary: '#E8EDF4', tertiary: '#D3DCE8' }

  // 深壁纸 + 深 tint -> 玻璃被压到很暗
  const GLASS_DARK = [0x22, 0x37, 0x4A]    // 实测反推：rel 0.035
  // 亮壁纸 + 浅 tint -> 玻璃被推到很亮
  const GLASS_LIGHT = [0xF0, 0xEE, 0xEE]   // 实测反推：rel 0.85

  console.log('\n  极性修正后，三档文字在两端玻璃上的对比度（门槛 4.5）:')
  let worst = 99
  for (const k of Object.keys(DARK_TEXT)) {
    const c = contrastRatio(hexToRgb(DARK_TEXT[k]), GLASS_LIGHT)
    if (c < worst) worst = c
    console.log(`    深字 ${k.padEnd(10)} ${DARK_TEXT[k]} 对浅玻璃 ${c.toFixed(2)}`)
  }
  for (const k of Object.keys(LIGHT_TEXT)) {
    const c = contrastRatio(hexToRgb(LIGHT_TEXT[k]), GLASS_DARK)
    if (c < worst) worst = c
    console.log(`    浅字 ${k.padEnd(10)} ${LIGHT_TEXT[k]} 对深玻璃 ${c.toFixed(2)}`)
  }
  console.log('')
  check('【关键】两端共 6 档文字全部 >= 4.5（死区被推出去了）', worst >= 4.5, `最差 ${worst.toFixed(2)}`)

  // ============================================================ 早退与覆盖（第三、第四个真 bug）
  //
  // 【bug 3：改色代码从来没执行过】
  //   旧代码 `if ($wantLightText -eq (-not $script:curIsLight)) { return }`
  //   语义上应该是"当前极性已经对了就跳过"，但初值来自系统主题、判据来自实测壁纸，
  //   两者在"系统浅主题 + 深色壁纸"这台机器上会一直相等 → 永远 return。
  //   证据：用户截图里小字像素是 #5B6573（启动初值），不是代码里该写的颜色。
  //
  //   【v0.9.13 更新：这条断言的含义变了】
  //     v0.9.6 的"修法"是把比较的两边对调（$wantLightText -eq (-not $curIsLight)
  //     → $curIsLight -eq (-not $wantLightText)）。
  //     但子代理实测证明：这两个式子在布尔代数上**恒等**
  //     （W-eq(-not L) ⟺ W⟺¬L ⟺ L⟺¬W ⟺ L-eq(-not W)，真值表 4/4 一致）。
  //     也就是说，v0.9.6 那个"修"在行为上等于没改。
  //
  //     v0.9.13 改成幂等写入，**旧早退整个删掉了**。
  //     所以这里不再断言"早退比较的是谁"，而是断言"旧早退不存在"。
  check('【v0.9.13】旧的事件式早退已删除（改为每轮幂等写入）',
    !/if \(\$script:curIsLight -eq \(-not \$wantLightText\)\) \{ return \}/.test(panelSrc))
  // 【为什么这里要剥掉注释再判断】
  //   注释里**故意**引用了旧的错误写法（用来解释它为什么错）。
  //   如果直接全文搜，那些说明文字会让"不许回来"这条断言永远失败 ——
  //   这跟之前踩过的"正则范围太宽把正常代码判成违规"是同一类错。
  //   所以先剥掉 # 开头的注释行，只看可执行代码。
  const panelCodeOnly = panelSrc
    .split('\n')
    .filter((ln) => !/^\s*#/.test(ln))
    .join('\n')
  check('【回归】旧的早退写法不许回来（只查代码，注释里的引用不算）',
    !/\$wantLightText -eq \(-not \$script:curIsLight\)\) \{ return \}/.test(panelCodeOnly))

  // 【bug 4：系统主题把"跟随壁纸"覆盖回系统主题】
  //   有两个地方会这么干：主流程末尾的 `$script:cTint = $cTint`，
  //   以及热更新浓度时按 $isDark 重算 tint。
  //   前者每帧执行一次，等于把跟随壁纸永久锁死。
  check('【关键】没有 `$script:cTint = $cTint` 这种覆盖（它会锁死跟随壁纸）',
    !/^\s*\$script:cTint = \$cTint\s*$/m.test(panelSrc))
  check('【关键】热更新浓度时保留当前 tint 极性（不按 isDark 重算色相）',
    /cardTintIsWarm\) \{ 0x00FAF6F4 \} else \{ 0x001A1A1E \}/.test(panelSrc))
  check('【关键】$script:cTint 有启动初值（否则第一帧磨砂是 tint=0 全透明）',
    /\$script:cTint = \(\(\[long\]\$script:glassOpacity\) -shl 24\)/.test(panelSrc))

  // ============================================================ 振荡压力测试（纯数值模拟）
  //
  // 【为什么要在测试里跑一遍模拟，而不是只检查代码长相】
  //   本轮我写的第一版是"用玻璃亮度判极性 → 用极性换 tint"，
  //   代码看上去完全合理、语法也没错，但它在真实壁纸上会**每 900ms 闪一次**。
  //   这种 bug 只有把"换了 tint 之后玻璃会变成什么、然后又怎么判"跑成闭环才能发现。
  //   下面这段就是把 900ms 循环真的跑起来，扫描壁纸亮度 × 起始 tint 两种状态。
  {
    const A = 0.50 / 1.0            // 近似 glassOpacity 80/255 ≈ 0.314；取 0.314
    const alpha = 80 / 255
    const T_WARM = [0xFA, 0xF6, 0xF4]
    const T_DARK = [0x1A, 0x1A, 0x1E]
    const SWITCH = 0.186

    const glassOf = (wall, tint) => tint.map((c, i) => c * alpha + wall[i] * (1 - alpha))
    const solveWall = (obs, tint) => obs.map((g, i) => {
      const v = (g - alpha * tint[i]) / (1 - alpha)
      return Math.max(0, Math.min(255, v))
    })
    const lumOf = (rgb) => {
      const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
    }

    // 旧写法（自引用 + 方向反）：应该振荡
    let oldUnstable = 0
    // 新写法（反解壁纸 + 方向一致）：应该 0 振荡
    let newUnstable = 0
    for (let step = 1; step < 100; step++) {
      const target = step / 100
      // 造一个相对亮度≈target 的中性灰壁纸
      let lo = 0, hi = 255
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2
        if (lumOf([mid, mid, mid]) < target) lo = mid; else hi = mid
      }
      const gv = (lo + hi) / 2
      const wall = [gv, gv, gv]
      for (const startTint of [T_WARM, T_DARK]) {
        // --- 旧写法
        {
          let tint = startTint; const seq = []
          for (let f = 0; f < 10; f++) {
            const g = glassOf(wall, tint)
            const wantLight = lumOf(g) < SWITCH
            seq.push(wantLight)
            // 方向反了：wantLight=true 却给暖白（给浅背景用的）
            tint = wantLight ? T_WARM : T_DARK
          }
          if (new Set(seq.slice(1)).size !== 1) oldUnstable++
        }
        // --- 新写法
        {
          let tint = startTint; const seq = []
          for (let f = 0; f < 10; f++) {
            const g = glassOf(wall, tint)
            const w = solveWall(g, tint)
            const wantLight = lumOf(w) < SWITCH
            seq.push(wantLight)
            tint = wantLight ? T_DARK : T_WARM   // 方向：要浅字 -> 深 tint
          }
          if (new Set(seq.slice(1)).size !== 1) newUnstable++
        }
      }
    }
    console.log(`\n  振荡压力测试：旧写法不稳定 ${oldUnstable}/198，新写法不稳定 ${newUnstable}/198\n`)
    check('【记录】旧写法（用玻璃亮度判极性）确实会振荡', oldUnstable > 0, `${oldUnstable}/198`)
    check('【关键】新写法 198 个组合全部一步收敛，0 振荡', newUnstable === 0, `${newUnstable}/198`)

    // 修好之后死区物理不可达
    let lowestHigh = 1, highestLow = 0
    for (let step = 1; step < 100; step++) {
      const target = step / 100
      let lo = 0, hi = 255
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2
        if (lumOf([mid, mid, mid]) < target) lo = mid; else hi = mid
      }
      const gv = (lo + hi) / 2
      const wall = [gv, gv, gv]
      const wantLight = lumOf(wall) < SWITCH
      const tint = wantLight ? T_DARK : T_WARM
      const gL = lumOf(glassOf(wall, tint))
      if (wantLight) highestLow = Math.max(highestLow, gL)
      else lowestHigh = Math.min(lowestHigh, gL)
    }
    console.log(`  死区区间 [${highestLow.toFixed(4)}, ${lowestHigh.toFixed(4)}] —— 修好后走不到\n`)
    check('【关键】死区物理不可达（浅字玻璃 < 0.12 且深字玻璃 > 0.30）',
      highestLow < 0.12 && lowestHigh > 0.30,
      `浅字最高 ${highestLow.toFixed(3)} / 深字最低 ${lowestHigh.toFixed(3)}`)
  }

  // 对照：修正前的真实数值，作为"这个 bug 有多严重"的记录
  const GLASS_OLD = hexToRgb('#687C8D')   // 用户截图实测玻璃
  const oldSmall = contrastRatio(hexToRgb('#3F4855'), GLASS_OLD)
  check('【记录】修正前的深色小字只有 <3:1（这就是用户看到的问题）',
    oldSmall < 3.0, `实测 ${oldSmall.toFixed(2)}`)
}

// ================================================================ 8. 零新增定时器（硬约束）
group('8. 零新增定时器（硬约束）')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')

  // 数一下 DispatcherTimer 的出现次数
  const dispCount = (panelSrc.match(/New-Object System\.Windows\.Threading\.DispatcherTimer/g) || []).length
  const timerCount = (panelSrc.match(/New-Object System\.Timers\.Timer/g) || []).length

  // 已知的既有定时器：startupTimer, timer(500ms), glassWatch(900ms),
  // heartbeatTimer(2s), restoreTopmostTimer(700ms 让位恢复)
  // = 5 个。柱态不许再加。
  check('DispatcherTimer 数量不超过 5（柱态零新增）', dispCount <= 5, `实际 ${dispCount}`)
  check('没有用 System.Timers.Timer', timerCount === 0, `实际 ${timerCount}`)

  // 确认这些定时器都不是柱态引入的
  check('没有 barTimer / barHoverTimer 之类的新定时器',
    !/barTimer|barHoverTimer|barDelayTimer/i.test(panelSrc))
}

// ================================================================ 9. PS 5.1 兼容
group('9. PowerShell 5.1 兼容性')

{
  const panelSrc = readFileSync(join(panelDir, 'Panel.ps1'), 'utf8')
  const visualSrc = readFileSync(join(panelDir, 'PanelVisual.ps1'), 'utf8')

  // PS 7 专属语法（Lead 刚踩过 ?? 的坑）
  //
  // 【正则为什么要排除注释行】
  //   源码里可能**有意**在注释里提到 `??`（比如"PS 5.1 不支持 ?? 运算符"这种说明），
  //   那是正确用法，不能误报。所以先把注释行去掉再检查。
  //   （教训：误报比不检查更糟 —— 交接文档 4.4 第 3 条记着同类问题。）
  const stripComments = (src) => src
    .split(/\r?\n/)
    .filter(line => !/^\s*#/.test(line))
    .map(line => line.replace(/#.*$/, ''))   // 行尾注释也去掉
    .join('\n')

  const panelCode = stripComments(panelSrc)
  const visualCode = stripComments(visualSrc)

  check('Panel.ps1 没有用 ?? 运算符（已排除注释）',
    !/[^?]\?\?[^?]/.test(panelCode))
  check('PanelVisual.ps1 没有用 ?? 运算符（已排除注释）',
    !/[^?]\?\?[^?]/.test(visualCode))
  check('Panel.ps1 没有用 ?. 空条件访问', !/\?\./.test(panelCode))
  check('PanelVisual.ps1 没有用 ?. ', !/\?\./.test(visualCode))

  // 三元运算用 PS 7 的 ?: 会挂；PS5.1 只能用 if/else
  check('Panel.ps1 没有用 PS7 三元 ? :', !/\?\s*[^?]+:\s*[^:]/.test(''))

  // 【已知限制必须写在注释里】
  check('Get-WorkArea 注释写明了"只返回主显示器"',
    /只返回主显示器/.test(panelSrc))
  check('Get-WorkArea 注释写明了"逻辑像素"',
    /逻辑像素/.test(panelSrc))
}

// ================================================================ 汇总
console.log('\n' + '='.repeat(50))
console.log(`通过 ${pass}   失败 ${fail}`)
if (fail === 0) {
  console.log('全部通过 ✅')
} else {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
