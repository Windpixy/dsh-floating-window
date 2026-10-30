/**
 * test-title.mjs -- 一次性的结构探查
 *
 * 目的：确认 ctx.get('agents').list() 返回什么形状。
 * 我在 sources.js 的 syncExistingSessions 里假设了
 *   agent.session.header.id / agent.status === 'running'
 * 但没实测过。这个脚本先验证，避免又改错。
 *
 * 因为没法在 DSH 外部拿到 ctx，这个文件**只在插件内部被调用**，
 * 由 index.js 在回填后打一份诊断日志。
 * 这里是给开发者看的说明 + 可复用的解析函数。
 */

/**
 * 从 Agent 对象里尽量稳定地取出我们要的三样东西。
 * 所有字段都做兼容处理，拿不到就返回 undefined 而不是抛错。
 *
 * @param {object} agent
 * @returns {{sessionId?: string, running?: boolean, header?: object, shape?: string}}
 */
export function parseAgent(agent) {
  if (!agent || typeof agent !== 'object') return { shape: 'not-object' }

  const out = { shape: '' }

  // session 可能在 agent.session，也可能 agent 本身就是 session
  const session = agent.session ?? agent
  const header = session && session.header

  if (header && typeof header === 'object') {
    out.header = header
    out.sessionId = header.id ? String(header.id) : undefined
  }
  if (!out.sessionId) {
    const id = agent.id ?? agent.sessionId ?? (session && session.id)
    if (id) out.sessionId = String(id)
  }

  // status：可能是 agent.status（字符串），也可能是 agent.isRunning()
  if (typeof agent.status === 'string') {
    out.running = agent.status === 'running'
    out.shape = 'status:string'
  } else if (typeof agent.isRunning === 'function') {
    try { out.running = !!agent.isRunning() } catch { /* ignore */ }
    out.shape = 'isRunning:fn'
  } else if (typeof agent.running === 'boolean') {
    out.running = agent.running
    out.shape = 'running:bool'
  }

  return out
}

/** 描述一个 Agent 对象的字段构成，用于诊断日志 */
export function describeAgent(agent) {
  if (!agent || typeof agent !== 'object') return 'not-object'
  const keys = Object.keys(agent)
  const session = agent.session
  const header = session && session.header
  return {
    keys: keys.slice(0, 20),
    hasSession: !!session,
    sessionKeys: session && typeof session === 'object' ? Object.keys(session).slice(0, 15) : null,
    hasHeader: !!header,
    headerKeys: header && typeof header === 'object' ? Object.keys(header) : null,
    status: agent.status,
    id: agent.id ? String(agent.id).slice(0, 30) : null,
  }
}
