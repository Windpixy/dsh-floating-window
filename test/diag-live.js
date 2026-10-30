/**
 * test\diag-live.js -- 在 DSH 里跑一次，把真实结构打出来
 *
 * 用法：由 index.js 在回填完成后调用一次（只在 debug 开关打开时）
 * 这里只是给开发者看的参考实现。
 */

/** 把任意对象的结构描述成可读文本，用于日志 */
export function shapeOf(value, depth = 0, maxDepth = 3) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t !== 'object') return t

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (depth >= maxDepth) return `[${value.length} items]`
    return `[${shapeOf(value[0], depth + 1, maxDepth)} x${value.length}]`
  }

  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  if (depth >= maxDepth) return `{${keys.length} keys}`
  return '{' + keys.slice(0, 12).map(k => {
    let v
    try { v = value[k] } catch { v = '<getter>' }
    return `${k}:${shapeOf(v, depth + 1, maxDepth)}`
  }).join(', ') + (keys.length > 12 ? `, ...+${keys.length - 12}` : '') + '}'
}

/** 判断一个对象看起来像什么 */
export function guessKind(value) {
  if (!value || typeof value !== 'object') return 'not-object'
  if (Array.isArray(value)) return 'array'
  const keys = Object.keys(value)
  if (keys.includes('header') && keys.includes('id')) return 'session'
  if (keys.includes('agent')) return 'agent-wrapper'
  if (keys.includes('list') || keys.includes('get')) return 'registry'
  return 'object'
}
