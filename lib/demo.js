/**
 * lib/demo.js -- 假数据来源（M1 专用）
 *
 * 作用：在接真实数据之前，先把「插件 → state.json → 卡片」这条管道打通并验证。
 * 它会按顺序自动切换五种状态，和原来的 Simulate.ps1 效果一样，但由插件驱动。
 *
 * 接完真实数据（M2）后，把配置 useDemoData 设为 false 就停用。
 */

const STEPS = [
  {
    name: '空闲',
    holdMs: 12000,
    apply: (state) => {
      state.setTodayTokens(12300)
      // 清掉所有运行中
      for (const id of [...state.sessions.keys()]) state.sessionRemoved(id)
      state.lastFinishedAt = null
    },
  },
  {
    name: '一个任务在跑',
    holdMs: 10000,
    apply: (state) => {
      state.setTodayTokens(18600)
      state.sessionAdded({
        sessionId: 'demo-1', running: true, blank: false,
        cwd: 'C:\\Users\\demo\\Documents\\auth-module',
      })
      state.sessionTitle('demo-1', '重构登录模块')
      state.toolCall('demo-1', 'edit', '{"file_path":"C:\\\\proj\\\\src\\\\auth.ts"}')
    },
  },
  {
    name: '三个任务同时在跑',
    holdMs: 12000,
    apply: (state) => {
      state.setTodayTokens(25400)
      state.sessionAdded({ sessionId: 'demo-1', running: true, blank: false })
      state.sessionTitle('demo-1', '重构登录模块')
      state.sessionAdded({
        sessionId: 'demo-2', running: true, blank: false,
        cwd: 'C:\\proj\\tests',
      })
      state.sessionTitle('demo-2', '补单元测试')
      state.sessionAdded({
        sessionId: 'demo-3', running: true, blank: false,
        cwd: 'C:\\proj\\docs',
      })
      state.sessionTitle('demo-3', '更新接口文档')
      state.toolCall('demo-1', 'edit', '{"file_path":"C:\\\\proj\\\\src\\\\auth.ts"}')
      state.toolCall('demo-2', 'pwsh', '{"command":"pytest -q"}')
      state.toolCall('demo-3', 'write', '{"file_path":"C:\\\\proj\\\\docs\\\\README.md"}')
    },
  },
  {
    name: '两个任务 + 一项待审批',
    holdMs: 14000,
    apply: (state) => {
      state.setTodayTokens(32100)
      state.sessionRemoved('demo-3')
      state.sessionAdded({ sessionId: 'demo-1', running: true, blank: false })
      state.sessionAdded({ sessionId: 'demo-2', running: true, blank: false })
      state.toolCall('demo-1', 'pwsh', '{"command":"rm -rf ./tmp"}')
      state.approvalAsked({
        id: 'demo-approval-1',
        sessionId: 'demo-1',
        toolName: 'pwsh',
        reason: '删除 3 个临时文件',
      })
    },
  },
  {
    name: '五个任务（测试「还有 N 个」）',
    holdMs: 12000,
    apply: (state) => {
      state.setTodayTokens(40800)
      state.approvalDecided('demo-approval-1')
      for (let i = 1; i <= 5; i++) {
        const id = `demo-${i}`
        state.sessionAdded({ sessionId: id, running: true, blank: false, cwd: `C:\\proj\\task${i}` })
      }
      state.sessionTitle('demo-1', '重构登录模块')
      state.sessionTitle('demo-2', '补单元测试')
      state.sessionTitle('demo-3', '更新接口文档')
      state.sessionTitle('demo-4', '迁移数据库脚本')
      state.sessionTitle('demo-5', '压测接口')
      state.toolCall('demo-4', 'pwsh', '{"command":"migrate up"}')
      state.toolCall('demo-5', 'pwsh', '{"command":"locust -f load.py"}')
    },
  },
  {
    name: '全部完成（绿点）',
    holdMs: 10000,
    apply: (state) => {
      state.setTodayTokens(47300)
      for (let i = 1; i <= 5; i++) state.sessionStatus(`demo-${i}`, false)
    },
  },
  {
    name: '回到空闲',
    holdMs: 8000,
    apply: (state) => {
      state.setTodayTokens(49100)
    },
  },
]

/**
 * 启动演示循环。
 * @param {import('./state.js').CardState} state
 * @param {object} opts
 * @param {(reason: string) => void} opts.onChange 每次状态变化后调用，让外面去写盘
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ stop: () => void, current: () => string }}
 */
export function startDemo(state, opts) {
  const log = opts?.log ?? (() => {})
  const onChange = opts?.onChange ?? (() => {})
  let index = 0
  let timer = null
  let stopped = false

  const step = () => {
    if (stopped) return
    const current = STEPS[index % STEPS.length]
    try {
      current.apply(state)
    } catch (e) {
      log(`演示步骤「${current.name}」出错: ${e && e.message}`)
    }
    log(`演示 → ${current.name}`)
    onChange(`demo:${current.name}`)

    timer = setTimeout(() => {
      index++
      step()
    }, current.holdMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  // 立刻跑第一步
  step()

  return {
    stop() {
      stopped = true
      if (timer !== null) { clearTimeout(timer); timer = null }
    },
    current() {
      return STEPS[index % STEPS.length].name
    },
  }
}

export { STEPS as DEMO_STEPS }
