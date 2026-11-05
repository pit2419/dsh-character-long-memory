const fs = require('fs')
const SRC = process.argv[2] || 'listener.ts'

const src = fs.readFileSync(SRC, 'utf8')
const code = src.replace('export default defineOrgan(', 'module.exports = (')
const mod = { exports: {} }
new Function('module', 'exports', code)(mod, mod.exports)
const def = mod.exports

const store = {}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const tools = {}
let tickFn = null
const chem = []

const ctx = {
  kv: {
    get: (k) => clone(store[k]),
    set: (k, v) => { store[k] = clone(v) },
    delete: (k) => { delete store[k] },
  },
  state: { energy: 70, dopamine: 60, cortisol: 40, serotonin: 60, frozen: false, openGaps: [], scars: [], idleMs: 0 },
  hostMetrics: {},
  log: () => {},
  consume: () => {},
  inflict: (n, d) => { chem.push([n, d]) },
  emit: () => {},
  proposeGap: () => {},
  callTool: async () => ({}),
  onToolResult: () => {},
  onTick: (ms, fn) => { tickFn = fn },
  registerTool: (t) => { tools[t.name] = t },
  onPrompt: () => {},
  net: {},
}

def.onLoad(ctx)

const fails = []
const passes = []
const assert = (label, cond, extra) => {
  if (cond) passes.push(label)
  else fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
}

const run = (name, args) => {
  if (!tools[name]) {
    fails.push('工具缺失：' + name)
    return {}
  }
  try {
    const out = tools[name].execute(args)
    if (out === undefined) fails.push(name + ' 返回 undefined')
    return out || {}
  } catch (error) {
    fails.push(name + ' 抛错：' + (error && error.message))
    return {}
  }
}

// 1. 人物事件
const r1 = run('remember', { text: '老张住院了，心脏的问题', persons: '老张', topic: '住院', keep: true })
assert('remember 成功', r1.ok === true, r1)
assert('remember 建了人', Array.isArray(r1.created) && r1.created[0] === '老张', r1)

// 2. 日志
const d1 = run('diary', { doing: '给插件加日志层', topic: '倾听者插件' })
const d2 = run('diary', { doing: '修注入 bug', topic: '倾听者插件', at: '2026-11-04' })
assert('diary 成功', d1.ok === true && d2.ok === true, [d1, d2])
const j = run('journal', { days: 30 })
assert('journal 有两条', j.count === 2, j)
assert('journal 有文本', typeof j.text === 'string' && j.text.indexOf('给插件加日志层') >= 0, j)

// 3. 主题
const t = run('topics', {})
assert('topics 建了主题', t.count >= 2, t)
const tPlugin = (t.topics || []).find((x) => x.name === '倾听者插件')
assert('topics 带上人', tPlugin && tPlugin.people.indexOf('我') >= 0, t)

// 4. 图
const g1 = run('graph', { topic: '倾听者插件', depth: 2 })
assert('graph 从主题走通', g1.ok === true && g1.edges.length >= 2, g1)
const g2 = run('graph', { person: '老张', depth: 1 })
assert('graph 从人走通', g2.ok === true && g2.edges.length >= 1, g2)

// 5. 检索
const q1 = run('recall', { person: '老张' })
assert('recall 按人', q1.count === 1, q1)
const q2 = run('recall', { query: '手术' })
assert('recall 同义扩展命中住院', q2.count >= 1, q2)
const q3 = run('recall', { topic: '倾听者插件' })
assert('recall 按主题', q3.count === 2, q3)

// 6. 纠错
const f1 = run('fix', { action: 'relation', from: '老张', value: '同事' })
assert('fix 补关系', f1.ok === true && f1.relation === '同事', f1)
const pend = store['pending'] || []
assert('补关系后挂账销掉', pend.filter((p) => p.status === 'open' && p.kind === 'relation').length === 0, pend)
const f2 = run('fix', { action: 'alias', from: '老张', to: '张总' })
assert('fix 加别名', f2.ok === true, f2)
const q4 = run('recall', { person: '张总' })
assert('别名能检索到', q4.count === 1, q4)

// 7. 合并重名
run('remember', { text: '李四今天来电话了', persons: '李四' })
run('remember', { text: '李四说他下周出差', persons: '李四' })
const before = Object.keys(store['events']).length
const f3 = run('fix', { action: 'merge', from: '李四', to: '老张' })
assert('fix 合并', f3.ok === true, f3)
const after = Object.keys(store['events']).length
assert('合并后事件数不变', before === after, [before, after])
const edgesAfterMerge = store['edges'] || []
const exists = (id) => Boolean((store['people'] || {})[id] || (store['events'] || {})[id] || (store['topics'] || {})[id])
assert('合并后没有悬空边', edgesAfterMerge.every((e) => exists(e.from) && exists(e.to)), edgesAfterMerge)

// 8. 因果 + 作废
const evIds = Object.keys(store['events'])
const evA = evIds[0]
const evB = evIds[1]
const f4 = run('fix', { action: 'cause', from: evA, to: evB, value: '先住院后手术' })
assert('fix 因果', f4.ok === true && f4.edge === true, f4)
const f5 = run('fix', { action: 'supersede', from: evB, to: evA })
assert('fix 作废', f5.ok === true, f5)
assert('作废写入 validTo', Boolean(store['events'][evB].validTo), store['events'][evB])

// 9. 整理
run('remember', { text: '老张住院了，心脏的毛病', persons: '老张' })
const n1 = Object.keys(store['events']).length
const tidy = run('tidy', {})
const n2 = Object.keys(store['events']).length
assert('tidy 合并了重复', n2 === n1 - 1 && tidy.merged === 1, [n1, n2, tidy])

// 10. 导出
const ex = run('export', {})
assert('export 有内容', typeof ex.markdown === 'string' && ex.markdown.length > 50, ex)
assert('export 含日志', ex.markdown.indexOf('给插件加日志层') >= 0, ex)

// 11. 注入
const pc = def.getPromptContext()
assert('注入非空', typeof pc === 'string' && pc.length > 20, pc)
assert('注入含「你在做」', typeof pc === 'string' && pc.indexOf('你在做') >= 0, pc)

// 12. 定时器
assert('onTick 注册了', typeof tickFn === 'function')
if (tickFn) {
  try { tickFn() } catch (error) { fails.push('onTick 执行抛错：' + error.message) }
}

// 13. 删除
const f6 = run('forget', { person: '老张' })
assert('forget 单人', f6.ok === true, f6)
assert('删人后边清干净', (store['edges'] || []).every((e) => e.from !== f6.id && e.to !== f6.id), store['edges'])
const f7 = run('forget', { all: true })
assert('forget 全部', f7.ok === true && Object.keys(store).length >= 0, f7)
assert('清空后库是空的', !store['people'] || Object.keys(store['people']).length === 0, Object.keys(store))
const pcEmpty = def.getPromptContext()
assert('空库时闭嘴', pcEmpty === '', pcEmpty)

console.log('通过 ' + passes.length + ' 项，失败 ' + fails.length + ' 项')
if (fails.length) {
  console.log('\n失败：')
  for (const f of fails) console.log('  - ' + f)
} else {
  console.log('全部通过')
}
