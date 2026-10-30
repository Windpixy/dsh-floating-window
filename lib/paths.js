/**
 * lib/paths.js -- 数据目录与配置默认值
 *
 * 按你的选择，运行数据统一放在 %USERPROFILE%\.dsh\desktop-card\
 * 插件目录只放程序本体，保持 git 干净。
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** DSH 主目录。DSH_HOME 环境变量优先。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 卡片数据目录（state.json / heartbeat / 位置记忆 / 日志都在这里） */
export function dataDir(configured) {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  return join(dshHome(), 'desktop-card')
}

/**
 * 插件包根目录。
 *
 * 用 import.meta.url 反推，而不是 process.cwd()：
 * cwd 是 DSH 的工作目录，不是插件目录。
 * lib/paths.js -> 上一级就是包根。
 */
export function packageRoot() {
  const here = dirname(fileURLToPath(import.meta.url))
  return dirname(here)
}

/**
 * 卡片程序目录（插件包里的 panel/）。
 *
 * @param {string} [configured] 用户配置的绝对路径；留空用包内的 panel/
 */
export function panelDir(configured) {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  return join(packageRoot(), 'panel')
}

/** 各文件的完整路径 */
export function dataPaths(dir) {
  return {
    dir,
    state: join(dir, 'state.json'),
    settings: join(dir, 'settings.json'),
    position: join(dir, 'panel-pos.json'),
    heartbeat: join(dir, 'heartbeat.json'),
    tokens: join(dir, 'tokens.json'),
    log: join(dir, 'plugin.log'),
    debugLog: join(dir, 'panel-debug.log'),
    /** 中国法定节假日缓存（每年变一次，从网上拉后存这里，断网也能用） */
    holidays: join(dir, 'holidays.json'),
    /**
     * 悬浮窗审批的「决定文件」目录（v0.8.0）。
     *
     * 【为什么用文件而不是 HTTP】
     *   卡片是独立 PowerShell 进程，它把用户点的「允许/拒绝」写成一个文件，
     *   插件每 250ms 扫一遍这个目录。理由：
     *     · 卡片本来就只干"读写文件"这一件事（交接文档 2.1 的架构），不引入新范式
     *     · 文件有 nonce + 时间戳 + 一次性消费三重校验，安全性不比自己实现
     *       HTTP 鉴权差（DSH 的 HTTP 层没有"本机免鉴权"待遇，见方案文档 3.7）
     *     · 出问题时能直接用记事本打开看，排查成本几乎为零
     *
     * 目录本身不进 git（运行数据）。
     */
    decisions: join(dir, 'decisions'),
  }
}

/** 插件配置的默认值。用户可在 cordis.patch.yml 里覆盖。 */
export const DEFAULTS = Object.freeze({
  /** 数据目录；空字符串 = 用默认 %USERPROFILE%\.dsh\desktop-card */
  dataDir: '',
  /** 卡片程序目录；空字符串 = 用插件包里的 panel/ */
  panelDir: '',
  /** 是否在 DSH 启动时自动拉起卡片窗口 */
  autoLaunch: true,
  /** state.json 最快写入间隔（毫秒） */
  writeThrottleMs: 500,
  /** 卡片最多显示几个任务（卡片自己硬上限是 5） */
  maxTaskRows: 5,
  /** 是否把子代理会话也当成任务显示 */
  showSubagentSessions: false,
  /** 点卡片打开的地址；空 = 用插件读到的实际地址 */
  dshUrl: '',
  /** 启动时回填今日 Token（关掉就只统计本次运行期间的用量） */
  backfillTodayTokens: true,
  /** 心跳超过多久算过期（卡片每 2 秒写一次） */
  heartbeatStaleMs: 8000,
  /** M1 阶段用假数据验证卡片；M2 接真实数据后改为 false */
  useDemoData: false,

  // ---------------------------------------------------------------- 悬浮窗审批（v0.8.0）
  //
  // 【这几个是"插件侧"的默认值，卡片侧读的是 settings.json】
  //   卡片要能"改开关立刻生效"，所以开关的真源必须是数据目录里的
  //   settings.json（卡片每 500ms 读一次），而不是这里的 DEFAULTS
  //   （DEFAULTS 只在插件加载时读一次，改它要重启 DSH）。
  //   approvalInline 放这里只是为了：settings.json 里缺这个键时，
  //   插件有个明确的默认值可用，行为和卡片侧的缺键默认值一致。

  /**
   * 悬浮窗上是否直接给「允许 / 拒绝」两个按钮（安全侧默认关）。
   * 关 → 卡片只显示「去处理 ›」，点一下跳到 DSH。
   * 开 → 卡片显示两个按钮，点完直接生效。
   *
   * 【为什么默认关】审批是安全闸门。开了就等于允许"本机上的程序"
   * 替用户做审批决定，这个口子应该由用户显式打开。
   */
  approvalInline: false,
  /** 点「允许」前是否二次确认（只在 approvalInline=true 时有意义） */
  approvalConfirm: true,
  /** 决定文件的有效期（毫秒）。超过就丢弃，避免陈旧的点击被误用 */
  approvalDecisionTtlMs: 60000,
  /** 扫 decisions 目录的间隔（毫秒） */
  approvalPollMs: 250,

  // ---------------------------------------------------------------- 柱态（v0.9.0）
  //
  // 【真源同样是 data dir 的 settings.json】
  //   和 approvalInline 一个道理：卡片要能改完立刻生效。
  //   这里只是"缺键时的默认值"。

  /** 是否启用"缩成细条"（关掉后右键菜单不显示这一项，拖动也不会触发） */
  barEnabled: true,
  /** 柱子宽度（逻辑像素）。太窄看不清颜色，太宽开始挡内容 */
  barWidth: 14,
  /** 柱子高度（逻辑像素） */
  barHeight: 120,
  /** 颜色条宽度（逻辑像素），必须小于 barWidth - 2
   *  v0.9.1 从 8 改成 6：14 宽里条占 8 是 57%，看着像糖果棒；
   *  6 是 43%，两边各留 4 像素玻璃边距，像"嵌在玻璃里的指示灯"。 */
  barStripWidth: 6,
  /** 判定"光标顶住边缘"的容差（逻辑像素） */
  barEdgeTolerance: 2,
})
