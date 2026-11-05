/**
 * 以人物为单元的长期记忆器官：人物档案、总目录、权重衰减与压缩、挂账追问、情绪判断、纠错与导出
 * 由数字生命自己通过 write_new_organ 生成于 2026-11-05T13:25:17.366Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
// onLoad 拿到的 ctx 存在这里：getPromptContext 在 onLoad 外面，拿不到里面的闭包
let ORGAN_CTX = null
// 主人自己也是一个节点。任务型对话靠它落地：记的是"哪天在做什么"
const SELF_ID = 'p_self'

export default defineOrgan({
  manifest: {
    name: 'listener',
    version: '1.0.0',
    capabilities: ['tools', 'prompt', 'timer', 'state:read', 'chem:write', 'fs:organ'],
  },

  // 每轮注入一小段。这个方法在 onLoad 外面，只能用 ORGAN_CTX，不能用里面的闭包
  getPromptContext() {
    const ctx = ORGAN_CTX
    if (!ctx) return ''
    const kv = (key, fallback) => {
      try {
        const value = ctx.kv.get(key)
        return value === undefined || value === null ? fallback : value
      } catch (error) {
        return fallback
      }
    }
    const p2 = (n) => (n < 10 ? '0' + n : '' + n)
    const day = (ms) => {
      const d = new Date(ms)
      return p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    }
    const cut = (text, max) => {
      const s = String(text || '').trim()
      return s.length <= max ? s : s.slice(0, max) + '…'
    }
    try {
      // 空库、或者一个月没记过东西，就彻底闭嘴：任务型用法不该被这套东西打扰
      const events = kv('events', {})
      if (!Object.keys(events).length) return ''
      const meta = kv('meta', {})
      const last = meta.lastWriteAt ? Date.parse(meta.lastWriteAt) : 0
      if (last && Date.now() - last > 30 * 86400000) return ''

      const people = kv('people', {})
      const topics = kv('topics', {})
      const ledger = kv('ledger', [])
      const pending = kv('pending', [])
      const self = people[SELF_ID]
      const mine = self
        ? (self.events || []).filter((eid) => events[eid]).slice(-3).map((eid) => events[eid])
        : []
      const names = Object.keys(people)
        .map((id) => people[id])
        .filter((p) => p.id !== SELF_ID)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .slice(0, 8)
        .map((p) => p.name + (p.relation ? '(' + cut(p.relation, 12) + ')' : ''))
      const topicNames = Object.keys(topics)
        .map((id) => topics[id])
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .slice(0, 6)
        .map((t) => '#' + t.name)
      const recent = ledger
        .slice(-4)
        .map((row) => day(row.at) + ' ' + (row.who.length ? row.who.join('、') : '?') + '：' + row.what)
      const open = pending.filter((q) => q.status === 'open')
      const ask = open.length ? ' 挂着 ' + open.length + ' 个疑问：' + cut(open[0].question, 24) + '（合适时自然地问一句）' : ''
      const lines = ['【记事本】']
      if (names.length) lines.push('人：' + names.join('、') + '。')
      if (topicNames.length) lines.push('事：' + topicNames.join('、') + '。')
      if (recent.length) lines.push('最近：' + recent.join('；') + '。')
      if (mine.length) lines.push('你在做：' + mine.map((ev) => day(ev.at) + ' ' + cut(ev.claim, 16)).join('；') + '。')
      lines.push('对方讲到具体的人或事，先 organ_listener_remember 记下再回；聊到已知的人，先 organ_listener_recall 翻档案，别凭印象编。记错立刻 organ_listener_fix。' + ask)
      return lines.join('')
    } catch (error) {
      return ''
    }
  },

  feedback() {
    return {}
  },

  onLoad(ctx) {
    ORGAN_CTX = ctx
    const DAY = 86400000
    const REINFORCE_TAU = 7
    const FLOOR = 0.05

    // ── 存取 ─────────────────────────────────────────────
    const read = (key, fallback) => {
      try {
        const raw = ctx.kv.get(key)
        if (raw === undefined || raw === null) return fallback
        return raw
      } catch (error) {
        return fallback
      }
    }
    const save = (key, value) => {
      try {
        ctx.kv.set(key, value)
      } catch (error) {
        ctx.log('写入失败 ' + key + '：' + error)
      }
    }

    // ── 文本 ─────────────────────────────────────────────
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    const dayOf = (ms) => {
      const d = new Date(ms)
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }
    const clip = (text, max) => {
      const s = String(text || '').replace(/\s+/g, ' ').trim()
      if (s.length <= max) return s
      const cut = s.slice(0, max)
      const stop = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('；'))
      return (stop > max * 0.55 ? cut.slice(0, stop) : cut) + '…'
    }
    const firstClause = (text, max) => {
      const s = String(text || '').replace(/\s+/g, ' ').trim()
      const m = s.match(/^[^，。！？；]{1,300}/)
      return clip(m ? m[0] : s, max)
    }
    const stripLead = (text, names) => {
      const s = String(text || '').trim()
      for (const name of names || []) {
        if (name && s.indexOf(name) === 0) return s.slice(name.length).replace(/^[，,、：: ]+/, '')
      }
      return s
    }
    const splitNames = (value) => {
      if (!value) return []
      if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean)
      return String(value).split(/[，,、;；\s]+/).map((s) => s.trim()).filter(Boolean)
    }
    const hash = (text) => {
      let h = 5381
      const s = String(text)
      for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
      return h.toString(36).slice(0, 6)
    }
    const slug = (name) => {
      const clean = String(name || '').trim()
      const keep = clean.replace(/[^\w\u4e00-\u9fa5]/g, '')
      return (keep.slice(0, 10) || 'p') + '_' + hash(clean)
    }

    // ── 检索：中文没有空格，用二元组当索引；同义表补上"住院≈手术" ──
    const SYNONYMS = {
      住院: ['手术', '医院', '病了', '开刀'],
      手术: ['住院', '开刀', '医院'],
      病了: ['住院', '发烧', '感冒', '难受'],
      去世: ['走了', '过世', '葬礼'],
      结婚: ['婚礼', '领证', '嫁人'],
      离婚: ['分居', '离了'],
      吵架: ['争执', '生气', '闹翻'],
      上班: ['公司', '单位', '工作'],
      工作: ['公司', '单位', '上班'],
      跳槽: ['辞职', '入职', '换工'],
      借钱: ['欠钱', '还钱', '借给'],
      孩子: ['儿子', '女儿', '小孩'],
      考试: ['考上', '考研', '高考'],
      房子: ['买房', '租房', '搬家'],
    }
    const grams = (text) => {
      const s = String(text || '').replace(/[^\w\u4e00-\u9fa5]/g, '')
      const out = new Set()
      for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2))
      return out
    }
    const queryGrams = (text) => {
      const set = grams(text)
      for (const g of Array.from(set)) {
        const extra = SYNONYMS[g]
        if (!extra) continue
        for (const word of extra) for (const e of grams(word)) set.add(e)
      }
      return set
    }
    const searchByText = (events, query) => {
      const q = queryGrams(query)
      if (!q.size) return []
      const out = []
      for (const id of Object.keys(events)) {
        const ev = events[id]
        const target = grams(ev.claim + ' ' + (ev.topic || '') + ' ' + (ev.gist || ''))
        let hit = 0
        for (const g of q) if (target.has(g)) hit += 1
        if (hit > 0) out.push({ ev, hit })
      }
      out.sort((a, b) => b.hit - a.hit)
      return out
    }

    // ── 图：边不是标签，是有寿命的东西 ───────────────────
    // 每条边记两个时间轴：validFrom/validTo 是这件事在世界上成立的区间，
    // recordedAt/invalidatedAt 是我们什么时候知道它、什么时候推翻它。
    const edgeKey = (from, to, type) => from + '>' + to + ':' + type
    const addEdge = (from, to, type, opts) => {
      if (!from || !to || from === to) return false
      const edges = read('edges', [])
      const key = edgeKey(from, to, type)
      if (edges.some((e) => edgeKey(e.from, e.to, e.type) === key)) return false
      edges.push(Object.assign({
        id: 'g_' + hash(key),
        from,
        to,
        type,
        validFrom: '',
        validTo: '',
        recordedAt: new Date().toISOString(),
        invalidatedAt: '',
        note: '',
      }, opts || {}))
      save('edges', edges.slice(-4000))
      return true
    }
    const edgesOf = (id, includeDead) => {
      const edges = read('edges', [])
      return edges.filter((e) => (e.from === id || e.to === id) && (includeDead || !e.invalidatedAt))
    }
    const describe = (id, people, events) => {
      if (people && people[id]) return people[id].name
      if (events && events[id]) {
        const ev = events[id]
        return clip(ev.claim, 16) + '（' + dayOf(Date.parse(ev.at)) + '）'
      }
      const topics = read('topics', {})
      if (topics[id]) return '#' + topics[id].name
      return id
    }

    // ── 整理：去重、补摘要、清理悬空引用 ─────────────────
    const jaccard = (a, b) => {
      if (!a.size || !b.size) return 0
      let inter = 0
      for (const g of a) if (b.has(g)) inter += 1
      return inter / (a.size + b.size - inter)
    }
    // 包含度：一句话基本被另一句盖住时，Jaccard 会被长度拖低，用这个补
    const containment = (a, b) => {
      if (!a.size || !b.size) return 0
      let inter = 0
      for (const g of a) if (b.has(g)) inter += 1
      return inter / Math.min(a.size, b.size)
    }

    const consolidate = () => {
      const events = read('events', {})
      const ids = Object.keys(events)
      const drop = new Set()
      let merged = 0
      let linked = 0
      let pruned = 0

      const groups = {}
      for (const id of ids) {
        const ev = events[id]
        if (!ev.gist) ev.gist = firstClause(ev.claim, 36)
        const who = (ev.who || []).slice().sort()
        // 没挂人的事按主题分组，别把不相关的事串成一条链
        const key = who.length ? who.join('+') : (ev.topic ? 'topic:' + ev.topic : '__none__')
        groups[key] = groups[key] || []
        groups[key].push(ev)
      }

      for (const key of Object.keys(groups)) {
        const list = groups[key].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
        for (let i = 0; i < list.length; i += 1) {
          const a = list[i]
          if (drop.has(a.id)) continue
          const setA = grams(a.claim)
          for (let j = i + 1; j < list.length; j += 1) {
            const b = list[j]
            if (drop.has(b.id)) continue
            const diff = Math.abs((Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)) / DAY
            if (diff > 120) break
            const setB = grams(b.claim)
            const ratio = jaccard(setA, setB)
            const cover = containment(setA, setB)
            if (ratio >= 0.75 || cover >= 0.75) {
              // 同一件事说了两遍：留一条，原话取长的，保护标记取并集
              if (String(b.claim).length > String(a.claim).length) {
                a.claim = b.claim
                a.gist = b.gist || firstClause(b.claim, 36)
              }
              a.protected = Boolean(a.protected || b.protected)
              a.emotion = Math.max(Number(a.emotion) || 0, Number(b.emotion) || 0)
              a.touches = (a.touches || []).concat(b.touches || []).slice(-16)
              a.merged = (a.merged || 0) + 1
              drop.add(b.id)
              merged += 1
            } else if (ratio >= 0.4 || cover >= 0.55) {
              // 像同一件事的两种说法：不合并，连一条有时效的边
              // 十天内算"同一次"，超过算"后来那件事"
              const made = addEdge(a.id, b.id, diff <= 10 ? 'similar' : 'follows', {
                validFrom: a.at,
                validTo: b.at,
                note: diff <= 10 ? '像是同一次' : '后来的事',
              })
              if (made) linked += 1
            }
          }
        }
        // 同一个人的事按时间串起来：文字不像，时间上是连着的
        for (let i = 0; i + 1 < list.length; i += 1) {
          const a = list[i]
          const b = list[i + 1]
          if (drop.has(a.id) || drop.has(b.id)) continue
          const gap = (Date.parse(b.at) - Date.parse(a.at)) / DAY
          if (!(gap >= 0) || gap > 365) continue
          if (addEdge(a.id, b.id, 'next', { validFrom: a.at, validTo: b.at, note: '接着发生' })) linked += 1
        }
      }

      const people = read('people', {})
      for (const pid of Object.keys(people)) {
        const after = []
        for (const eid of people[pid].events || []) {
          if (drop.has(eid)) continue
          if (!events[eid]) { pruned += 1; continue }
          if (after.indexOf(eid) >= 0) continue
          after.push(eid)
        }
        people[pid].events = after
      }

      // 同名但被建成两条档案的，合回一条
      const byName = {}
      for (const pid of Object.keys(people)) {
        const k = String(people[pid].name || '').replace(/\s+/g, '')
        if (!k) continue
        if (byName[k]) {
          const target = people[byName[k]]
          const source = people[pid]
          target.aliases = Array.from(new Set((target.aliases || []).concat([source.name], source.aliases || [])))
          target.events = Array.from(new Set((target.events || []).concat(source.events || [])))
          target.edges = (target.edges || []).concat(source.edges || [])
          for (const id of Object.keys(events)) {
            events[id].who = (events[id].who || []).map((x) => (x === pid ? byName[k] : x))
          }
          const relink = read('edges', [])
          for (const e of relink) {
            if (e.from === pid) e.from = byName[k]
            if (e.to === pid) e.to = byName[k]
          }
          save('edges', relink)
          delete people[pid]
          merged += 1
        } else {
          byName[k] = pid
        }
      }

      for (const id of drop) delete events[id]
      save('events', events)
      save('people', people)
      const edgeList = read('edges', []).filter((e) => {
        const fromOk = Boolean(people[e.from] || events[e.from])
        const toOk = Boolean(people[e.to] || events[e.to])
        return fromOk && toOk
      })
      save('edges', edgeList)

      const topics = read('topics', {})
      const liveTopics = {}
      for (const tid of Object.keys(topics)) {
        const t = topics[tid]
        const alive = (t.events || []).filter((eid) => Boolean(events[eid]))
        if (!alive.length) continue
        t.events = alive
        liveTopics[tid] = t
      }
      save('topics', liveTopics)

      const seen = new Set()
      const kept = []
      for (const row of read('ledger', [])) {
        if (drop.has(row.eventId)) continue
        if (seen.has(row.eventId)) continue
        seen.add(row.eventId)
        kept.push(row)
      }
      save('ledger', kept)

      return { merged, linked, pruned, events: Object.keys(events).length }
    }

    // ── 人物 ─────────────────────────────────────────────
    const findPerson = (name) => {
      const people = read('people', {})
      const target = String(name || '').trim()
      if (!target) return null
      const ids = Object.keys(people)
      for (const id of ids) {
        const p = people[id]
        if (p.name === target) return p
        if ((p.aliases || []).indexOf(target) >= 0) return p
      }
      for (const id of ids) {
        const p = people[id]
        const names = [p.name].concat(p.aliases || [])
        for (const alias of names) {
          if (!alias || alias.length < 2) continue
          if (target.indexOf(alias) >= 0 || alias.indexOf(target) >= 0) return p
        }
      }
      return null
    }

    const ensurePerson = (name, at) => {
      const people = read('people', {})
      const found = findPerson(name)
      if (found) {
        found.lastSeen = Math.max(found.lastSeen || 0, at)
        save('people', people)
        return { person: found, created: false }
      }
      const id = slug(name)
      const person = {
        id,
        name: String(name).trim(),
        aliases: [],
        relation: '',
        note: '',
        firstSeen: at,
        lastSeen: at,
        events: [],
        edges: [],
      }
      people[id] = person
      save('people', people)
      return { person, created: true }
    }

    // 主人自己：不建则已，建了就和别人一样吃衰减、吃检索
    const ensureSelf = (at) => {
      const people = read('people', {})
      if (people[SELF_ID]) {
        people[SELF_ID].lastSeen = Math.max(people[SELF_ID].lastSeen || 0, at)
        save('people', people)
        return people[SELF_ID]
      }
      const me = {
        id: SELF_ID,
        name: '我',
        aliases: ['主人'],
        relation: '这是你自己',
        note: '日志层：记主人在哪天做了什么',
        firstSeen: at,
        lastSeen: at,
        events: [],
        edges: [],
      }
      people[SELF_ID] = me
      save('people', people)
      return me
    }

    // ── 主题：不是人，但也是一条线。任务型用法靠它落地 ────
    const findTopic = (name) => {
      const topics = read('topics', {})
      const target = String(name || '').trim().replace(/^#/, '')
      if (!target) return null
      const ids = Object.keys(topics)
      for (const id of ids) {
        const t = topics[id]
        if (t.name === target) return t
        if ((t.aliases || []).indexOf(target) >= 0) return t
      }
      for (const id of ids) {
        const t = topics[id]
        if (t.name.length >= 2 && target.indexOf(t.name) >= 0) return t
      }
      return null
    }
    const ensureTopic = (name, at) => {
      const topics = read('topics', {})
      const found = findTopic(name)
      if (found) {
        found.lastSeen = Math.max(found.lastSeen || 0, at)
        save('topics', topics)
        return { topic: found, created: false }
      }
      const label = String(name || '').trim().replace(/^#/, '')
      const id = 't_' + hash(label)
      const topic = { id, name: label, aliases: [], firstSeen: at, lastSeen: at, events: [] }
      topics[id] = topic
      save('topics', topics)
      return { topic, created: true }
    }

    // ── 权重 ─────────────────────────────────────────────
    const weightOf = (ev, nowMs) => {
      const at = Date.parse(ev.at) || nowMs
      const ageDays = Math.max(0, (nowMs - at) / DAY)
      const e = Number(ev.emotion) || 0
      let boost = 0
      const touches = ev.touches || []
      for (const t of touches) {
        const ago = Math.max(0, (nowMs - (Date.parse(t) || nowMs)) / DAY)
        boost += 0.2 * Math.exp(-ago / REINFORCE_TAU)
      }
      // 两条曲线叠加：细节一年内淡掉，这件事存在本身几年都不消失
      const fast = 1.1 * Math.exp(-ageDays / 45) * (0.6 + 1.2 * e) * Math.min(2.2, 1 + boost)
      const slow = 0.45 * Math.exp(-ageDays / 730) * (0.8 + 0.4 * e)
      return Math.max(FLOOR, Math.min(3.6, fast + slow))
    }

    // ── 情绪判断 ─────────────────────────────────────────
    const POS = ['考上', '升职', '加薪', '结婚', '怀孕', '生了', '康复', '出院', '中奖', '顺利', '成功', '开心', '高兴', '终于', '喜欢', '赢了', '买房', '好消息', '谢谢你', '太好了']
    const NEG = ['去世', '走了', '病了', '住院', '手术', '离婚', '分手', '吵架', '难过', '哭', '失业', '赔', '欠', '亏', '累', '压力', '烦', '孤独', '失望', '被裁', '失败', '疼', '失眠', '担心', '熬']
    const CRISIS = ['不想活', '自杀', '撑不住', '崩溃', '绝望', '没意思']

    const judgeTone = (text) => {
      const s = String(text || '')
      let pos = 0
      let neg = 0
      const hits = []
      for (const w of POS) if (s.indexOf(w) >= 0) { pos += 1; hits.push(w) }
      for (const w of NEG) {
        if (s.indexOf(w) < 0) continue
        // "他爸激动得哭了"这种喜极而泣不该算负面：句子里已经有好事，就跳过"哭"
        if (w === '哭' && pos > 0) continue
        neg += 1
        hits.push(w)
      }
      let crisis = false
      for (const w of CRISIS) if (s.indexOf(w) >= 0) { crisis = true; hits.push(w) }
      const val = pos - neg
      if (crisis) return { stance: '先接住，别讲道理', intensity: 0.95, val, hits }
      if (val <= -2) return { stance: '沉下来，陪着', intensity: 0.85, val, hits }
      if (val === -1) return { stance: '收着点，多听少说', intensity: 0.6, val, hits }
      if (val === 0) return { stance: '平稳地听', intensity: 0.35, val, hits }
      if (val === 1) return { stance: '替他高兴', intensity: 0.65, val, hits }
      return { stance: '一起高兴', intensity: 0.85, val, hits }
    }

    const feel = (tone) => {
      try {
        if (tone.intensity < 0.7) return null
        if (ctx.state && ctx.state.frozen) return null
        if (tone.val > 0) {
          ctx.inflict('dopamine', 3, '听朋友讲了好事')
          return 'dopamine+3'
        }
        ctx.inflict('cortisol', 3, '听朋友讲了难事')
        return 'cortisol+3'
      } catch (error) {
        return null
      }
    }

    // ── 工具注册 ─────────────────────────────────────────
    const tool = (definition) => {
      try {
        ctx.registerTool(definition)
      } catch (error) {
        ctx.log('工具 ' + definition.name + ' 注册失败：' + error)
      }
    }

    tool({
      name: 'remember',
      description: '朋友讲了一件事，记到相关的人名下。对方只要提到具体的人，回答前先调这个。',
      parameters: {
        text: { type: 'string', description: '这件事的要点，尽量保留原话和细节', required: true },
        persons: { type: 'string', description: '涉及的人名，多个用逗号或顿号隔开；没有就留空' },
        topic: { type: 'string', description: '一句话主题，如 婚礼 / 住院 / 换工作' },
        at: { type: 'string', description: '事情发生的时间，如 2026-08-21；不确定就留空' },
        emotion: { type: 'number', description: '0-1，情绪强度，留空自动判断' },
        keep: { type: 'boolean', description: '承诺、冲突、关系定性设 true，永不被压缩' },
      },
      execute: (args) => {
        const input = args || {}
        const text = String(input.text || '').trim()
        if (!text) return { ok: false, reason: '没有内容可记' }
        const nowMs = Date.now()
        const parsed = input.at ? Date.parse(String(input.at)) : NaN
        const when = Number.isFinite(parsed) ? parsed : nowMs
        const names = splitNames(input.persons)

        const created = []
        const linked = []
        for (const name of names) {
          const result = ensurePerson(name, when)
          linked.push({ id: result.person.id, name: result.person.name })
          if (result.created) created.push(result.person.name)
        }

        const tone = judgeTone(text)
        const emotion = Number.isFinite(input.emotion)
          ? Math.max(0, Math.min(1, input.emotion))
          : (tone.intensity >= 0.6 ? tone.intensity : 0.2)

        const events = read('events', {})
        const id = 'e_' + hash(text + when)
        const ev = {
          id,
          at: new Date(when).toISOString(),
          who: linked.map((p) => p.id),
          topic: String(input.topic || '').trim(),
          claim: clip(text, 200),
          gist: firstClause(text, 36),
          level: 0,
          emotion,
          protected: Boolean(input.keep),
          created: nowMs,
          touches: [new Date(nowMs).toISOString()],
        }
        events[id] = ev
        save('events', events)

        const people = read('people', {})
        for (const p of linked) {
          const person = people[p.id]
          if (person) {
            person.events = person.events || []
            person.events.push(id)
            person.lastSeen = Math.max(person.lastSeen || 0, when)
          }
        }
        save('people', people)

        const topicName = String(input.topic || '').trim()
        if (topicName) {
          const made = ensureTopic(topicName, when)
          const topicsNow = read('topics', {})
          if (topicsNow[made.topic.id]) {
            const t = topicsNow[made.topic.id]
            t.events = (t.events || []).concat([id])
            t.lastSeen = Math.max(t.lastSeen || 0, when)
            save('topics', topicsNow)
          }
          addEdge(id, made.topic.id, 'about', { validFrom: ev.at, note: '关于' })
        }
        const meta = read('meta', {})
        meta.lastWriteAt = new Date(nowMs).toISOString()
        save('meta', meta)

        const ledger = read('ledger', [])
        ledger.push({
          at: new Date(when).toISOString(),
          who: linked.map((p) => p.name),
          what: firstClause(stripLead(text, linked.map((p) => p.name)), 30),
          eventId: id,
        })
        save('ledger', ledger.slice(-4000))

        const pending = read('pending', [])
        const questions = []
        const addQuestion = (q) => {
          const item = Object.assign({ id: 'q_' + hash(q.question + id), askedAt: nowMs, status: 'open' }, q)
          pending.push(item)
          questions.push(item)
        }
        if (linked.length === 0 && !topicName) addQuestion({ kind: 'who', eventId: id, question: '这件事跟谁有关？' })
        for (const name of created) {
          const person = findPerson(name)
          addQuestion({
            kind: 'relation',
            personId: person ? person.id : '',
            question: person ? person.name + '和你是什么关系？' : name + '是谁？',
          })
        }
        if (linked.length >= 2) {
          const peopleNow = read('people', {})
          const a = peopleNow[linked[0].id]
          const b = peopleNow[linked[1].id]
          const known = a && (a.edges || []).some((edge) => edge.to === linked[1].id)
          if (a && b && !known) {
            addQuestion({
              kind: 'edge',
              personId: linked[0].id,
              otherId: linked[1].id,
              question: a.name + '和' + b.name + '是什么关系？',
            })
          }
        }
        if (questions.length) save('pending', pending)

        return {
          ok: true,
          eventId: id,
          when: dayOf(when),
          people: linked.map((p) => p.name),
          created,
          tone: { stance: tone.stance, intensity: tone.intensity, cues: tone.hits },
          felt: feel(tone),
          questions: questions.map((q) => q.question),
          weight: Number(weightOf(ev, nowMs).toFixed(2)),
        }
      },
    })

    tool({
      name: 'recall',
      description: '翻某个人的档案，或按关键词找旧事。聊到已知的人时先翻再开口。',
      parameters: {
        person: { type: 'string', description: '人名' },
        query: { type: 'string', description: '关键词，没有人物时用' },
        topic: { type: 'string', description: '主题，比如 住院 / 新版研究方向' },
        budget: { type: 'number', description: '返回字数上限，默认 900' },
        detail: { type: 'string', description: 'auto=按新旧自动决定详略（默认）  raw=一律给原话  gist=只给摘要' },
      },
      execute: (args) => {
        const input = args || {}
        const nowMs = Date.now()
        const events = read('events', {})
        const budget = Number.isFinite(input.budget) ? Math.max(200, Math.min(3000, input.budget)) : 900

        let picked = []
        let person = null
        const detail = String(input.detail || 'auto')
        if (input.person) {
          person = findPerson(input.person)
          if (!person) return { ok: true, found: false, text: '', hint: '记忆里没有这个人' }
          picked = (person.events || []).map((id) => events[id]).filter(Boolean).map((ev) => ({ ev, hit: 0 }))
        } else if (input.query) {
          const q = String(input.query)
          picked = searchByText(events, q)
          if (!picked.length) return { ok: true, found: true, person: null, header: '没找到相关的记忆', text: '', count: 0 }
        } else if (input.topic) {
          const topic = findTopic(input.topic)
          if (!topic) return { ok: true, found: true, person: null, header: '没有这个主题', text: '', count: 0 }
          picked = (topic.events || []).map((eid) => events[eid]).filter(Boolean).map((ev) => ({ ev, hit: 0 }))
        } else {
          return { ok: false, reason: '要给 person 或 query' }
        }

        // 命中准度优先，权重只负责同分时的先后：找错人的细节比找不到更糟
        const scored = picked.map((item) => ({
          ev: item.ev,
          score: item.hit * 2 + (item.ev.protected ? 10 : 0) + weightOf(item.ev, nowMs),
        }))
        scored.sort((a, b) => b.score - a.score)

        const people = read('people', {})
        const lines = []
        let used = 0
        const recalled = []
        for (const item of scored) {
          const ev = item.ev
          const w = weightOf(ev, nowMs)
          const head = dayOf(Date.parse(ev.at))
          // 详略由权重决定：压的是展示，不是存储。原话一直在库里
          let body
          if (detail === 'raw') body = ev.claim
          else if (detail === 'gist') body = ev.gist || firstClause(ev.claim, 40)
          else if (ev.protected || w >= 1.2) body = ev.claim
          else if (w >= 0.5) body = ev.gist || firstClause(ev.claim, 40)
          else body = clip(ev.gist || firstClause(ev.claim, 22), 18)
          const others = person
            ? (ev.who || [])
              .map((id) => people[id])
              .filter((p) => p && p.id !== person.id)
              .map((p) => p.name)
            : []
          const tail = others.length ? '（还有 ' + others.join('、') + '）' : ''
          const line = head + (ev.topic ? '｜' + ev.topic : '') + '：' + body + tail
          if (used + line.length > budget && lines.length > 0) break
          lines.push(line)
          used += line.length
          recalled.push(ev.id)
        }

        // 顺着边往外看一跳：想起一件事，旁边那件事也该在
        if (budget - used > 100) {
          const seen = new Set(recalled)
          const extra = []
          for (const id of recalled) {
            for (const edge of edgesOf(id)) {
              if (edge.type === 'supersedes') continue
              const other = edge.from === id ? edge.to : edge.from
              if (seen.has(other) || !events[other]) continue
              seen.add(other)
              extra.push(events[other])
            }
          }
          extra.sort((x, y) => weightOf(y, nowMs) - weightOf(x, nowMs))
          for (const ev of extra) {
            const line = '↳ ' + dayOf(Date.parse(ev.at)) + (ev.topic ? '｜' + ev.topic : '') + '：' + clip(ev.gist || ev.claim, 28)
            if (used + line.length > budget) break
            lines.push(line)
            used += line.length
            recalled.push(ev.id)
          }
        }

        const nowIso = new Date(nowMs).toISOString()
        for (const id of recalled) {
          const ev = events[id]
          ev.touches = (ev.touches || []).concat(nowIso).slice(-16)
        }
        if (recalled.length) save('events', events)

        const header = person
          ? person.name + (person.relation ? '（' + person.relation + '）' : '') + '，' + lines.length + ' 条'
          : (input.topic ? '主题「' + input.topic + '」' : '关键词「' + input.query + '」') + '，' + lines.length + ' 条'
        return {
          ok: true,
          found: true,
          person: person ? { name: person.name, relation: person.relation, gist: person.gist || '' } : null,
          header,
          text: lines.join('\n'),
          count: lines.length,
        }
      },
    })

    tool({
      name: 'people',
      description: '列出记忆里认识的所有人及一句话近况。',
      parameters: {},
      execute: () => {
        const nowMs = Date.now()
        const people = read('people', {})
        const events = read('events', {})
        const list = Object.keys(people).filter((id) => id !== SELF_ID).map((id) => {
          const p = people[id]
          const evs = (p.events || []).map((eid) => events[eid]).filter(Boolean)
          const top = evs.reduce((max, ev) => Math.max(max, weightOf(ev, nowMs)), 0)
          return {
            name: p.name,
            relation: p.relation || '',
            aliases: p.aliases || [],
            events: evs.length,
            lastSeen: p.lastSeen ? dayOf(p.lastSeen) : '',
            heat: Number(top.toFixed(2)),
          }
        })
        list.sort((a, b) => b.heat - a.heat)
        return { ok: true, count: list.length, people: list }
      },
    })

    tool({
      name: 'profile',
      description: '看某个人的完整档案：关系、他和你的位置、最近的事。',
      parameters: {
        person: { type: 'string', description: '人名', required: true },
      },
      execute: (args) => {
        const person = findPerson((args || {}).person)
        if (!person) return { ok: true, found: false }
        const nowMs = Date.now()
        const events = read('events', {})
        const people = read('people', {})
        const evs = (person.events || []).map((id) => events[id]).filter(Boolean)
        const ranked = evs
          .map((ev) => ({ ev, score: (ev.protected ? 10 : 0) + weightOf(ev, nowMs) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
        return {
          ok: true,
          found: true,
          name: person.name,
          aliases: person.aliases || [],
          relation: person.relation,
          note: person.note,
          gist: person.gist || '',
          edges: edgesOf(person.id).map((e) => {
            const otherId = e.from === person.id ? e.to : e.from
            const other = people[otherId]
            return {
              to: other ? other.name : describe(otherId, people, events),
              type: e.note || e.type,
              since: e.validFrom || e.recordedAt,
              dead: Boolean(e.invalidatedAt),
            }
          }),
          events: ranked.map((item) => ({
            date: dayOf(Date.parse(item.ev.at)),
            topic: item.ev.topic,
            claim: item.ev.claim,
            protected: Boolean(item.ev.protected),
          })),
        }
      },
    })

    tool({
      name: 'ledger',
      description: '总目录：按年份看谁在什么时候提过谁、什么事。',
      parameters: {
        year: { type: 'number', description: '四位年份；留空给年度概览' },
      },
      execute: (args) => {
        const ledger = read('ledger', [])
        const year = (args || {}).year
        if (Number.isFinite(year)) {
          const lines = ledger
            .filter((row) => new Date(Date.parse(row.at)).getFullYear() === year)
            .map((row) => dayOf(Date.parse(row.at)) + ' ' + (row.who.length ? row.who.join('、') : '未归类') + '：' + row.what)
          return { ok: true, year, count: lines.length, lines: lines.slice(-200) }
        }
        const byYear = {}
        for (const row of ledger) {
          const y = new Date(Date.parse(row.at)).getFullYear()
          byYear[y] = byYear[y] || { total: 0, people: {} }
          byYear[y].total += 1
          for (const name of row.who || []) byYear[y].people[name] = (byYear[y].people[name] || 0) + 1
        }
        const summary = Object.keys(byYear)
          .sort()
          .reverse()
          .map((y) => {
            const top = Object.keys(byYear[y].people)
              .sort((a, b) => byYear[y].people[b] - byYear[y].people[a])
              .slice(0, 6)
              .map((name) => name + '×' + byYear[y].people[name])
              .join(' ')
            return y + ' 年 ' + byYear[y].total + ' 件事｜' + top
          })
        return { ok: true, years: summary, total: ledger.length }
      },
    })

    tool({
      name: 'settle',
      description: '回答之前挂账的疑问：这个人是谁、和他什么关系、事情怎么定。',
      parameters: {
        id: { type: 'string', description: '挂账 id；也可以用问题里的关键词' },
        answer: { type: 'string', description: '答案', required: true },
      },
      execute: (args) => {
        const input = args || {}
        const pending = read('pending', [])
        const answer = String(input.answer || '').trim()
        const open = pending.filter((q) => q.status === 'open')
        let target = null
        if (input.id) target = open.find((q) => q.id === input.id) || null
        if (!target && input.id) target = open.find((q) => q.question.indexOf(String(input.id)) >= 0) || null
        if (!target && open.length === 1) target = open[0]
        if (!target) return { ok: false, reason: '没找到这条挂账', open: open.map((q) => ({ id: q.id, question: q.question })) }

        const people = read('people', {})
        const events = read('events', {})
        if (target.kind === 'relation' && target.personId && people[target.personId]) {
          people[target.personId].relation = answer
        }
        if (target.kind === 'who' && target.eventId && events[target.eventId]) {
          const result = ensurePerson(answer, Date.parse(events[target.eventId].at) || Date.now())
          events[target.eventId].who = (events[target.eventId].who || []).concat([result.person.id])
          const peopleAfter = read('people', {})
          if (peopleAfter[result.person.id]) {
            peopleAfter[result.person.id].events = (peopleAfter[result.person.id].events || []).concat([target.eventId])
            save('people', peopleAfter)
          }
          save('events', events)
        }
        if (target.kind === 'edge' && target.personId && target.otherId) {
          addEdge(target.personId, target.otherId, 'related', {
            note: answer,
            validFrom: new Date().toISOString(),
          })
        }
        save('people', people)
        target.status = 'done'
        target.answer = answer
        save('pending', pending)
        return { ok: true, settled: target.question, answer, remaining: pending.filter((q) => q.status === 'open').length }
      },
    })

    tool({
      name: 'tone',
      description: '判断这条讲述该用什么情绪回应。返回姿态和强度，不给答案文本。',
      parameters: {
        text: { type: 'string', description: '朋友刚说的话', required: true },
        person: { type: 'string', description: '涉及的人，可选' },
        apply: { type: 'boolean', description: '是否让这份情绪真的影响自己，默认 false' },
      },
      execute: (args) => {
        const input = args || {}
        const tone = judgeTone(input.text)
        const person = input.person ? findPerson(input.person) : null
        const known = person ? clip(person.relation || person.gist || '认识的人', 20) : ''
        return {
          ok: true,
          stance: tone.stance,
          intensity: tone.intensity,
          cues: tone.hits,
          about: person ? person.name + '（' + (known || '关系未记') + '）' : '',
          felt: input.apply ? feel(tone) : null,
        }
      },
    })

    tool({
      name: 'fix',
      description: '更正记错的东西：改称呼、合并重名、补关系、把一件事挪到别人名下、删一条。改错要立刻用，别将错就错。',
      parameters: {
        action: {
          type: 'string',
          description: 'alias=加别名  merge=把 from 合并进 to  relation=设关系  move=把事件挪给某人  drop=删事件  rename=改本名',
          required: true,
        },
        from: { type: 'string', description: '要处理的人或事件 id' },
        to: { type: 'string', description: '目标人或名字' },
        value: { type: 'string', description: '关系描述等具体内容' },
        eventId: { type: 'string', description: 'move/drop 时的事件 id' },
      },
      execute: (args) => {
        const input = args || {}
        const action = String(input.action || '')
        const people = read('people', {})
        const events = read('events', {})

        if (action === 'relation') {
          const person = findPerson(input.from)
          if (!person) return { ok: false, reason: '没有这个人' }
          people[person.id].relation = String(input.value || '').trim()
          save('people', people)
          const pendingAfter = read('pending', [])
          for (const q of pendingAfter) {
            if (q.status === 'open' && q.kind === 'relation' && q.personId === person.id) {
              q.status = 'done'
              q.answer = people[person.id].relation
            }
          }
          save('pending', pendingAfter)
          return { ok: true, person: person.name, relation: people[person.id].relation }
        }

        if (action === 'alias') {
          const person = findPerson(input.from)
          if (!person) return { ok: false, reason: '没有这个人' }
          const alias = String(input.to || input.value || '').trim()
          if (!alias) return { ok: false, reason: '要给别名' }
          people[person.id].aliases = (people[person.id].aliases || []).concat([alias])
          save('people', people)
          return { ok: true, person: person.name, aliases: people[person.id].aliases }
        }

        if (action === 'rename') {
          const person = findPerson(input.from)
          if (!person) return { ok: false, reason: '没有这个人' }
          const next = String(input.to || input.value || '').trim()
          if (!next) return { ok: false, reason: '要给新名字' }
          people[person.id].aliases = (people[person.id].aliases || []).concat([person.name])
          people[person.id].name = next
          save('people', people)
          return { ok: true, person: next }
        }

        if (action === 'merge') {
          const from = findPerson(input.from)
          const to = findPerson(input.to)
          if (!from || !to) return { ok: false, reason: '两边都要是已存在的人' }
          if (from.id === to.id) return { ok: false, reason: '是同一个人' }
          const target = people[to.id]
          const source = people[from.id]
          target.aliases = (target.aliases || []).concat([source.name], source.aliases || [])
          target.events = (target.events || []).concat(source.events || [])
          target.edges = (target.edges || []).concat(source.edges || [])
          for (const id of Object.keys(events)) {
            const ev = events[id]
            ev.who = (ev.who || []).map((pid) => (pid === source.id ? target.id : pid))
          }
          for (const id of Object.keys(people)) {
            for (const edge of people[id].edges || []) {
              if (edge.to === source.id) edge.to = target.id
            }
          }
          const mergeEdges = read('edges', [])
          for (const e of mergeEdges) {
            if (e.from === source.id) e.from = target.id
            if (e.to === source.id) e.to = target.id
          }
          save('edges', mergeEdges)
          delete people[source.id]
          save('people', people)
          save('events', events)
          return { ok: true, merged: source.name, into: target.name, events: (target.events || []).length }
        }

        if (action === 'move') {
          const ev = events[input.eventId]
          const person = findPerson(input.from || input.to)
          if (!ev) return { ok: false, reason: '没有这条事件' }
          if (!person) return { ok: false, reason: '没有这个人' }
          ev.who = [person.id]
          people[person.id].events = (people[person.id].events || []).concat([ev.id])
          save('events', events)
          save('people', people)
          return { ok: true, moved: ev.topic || ev.id, to: person.name }
        }

        if (action === 'drop') {
          const id = input.eventId || input.from
          if (!events[id]) return { ok: false, reason: '没有这条事件' }
          delete events[id]
          for (const pid of Object.keys(people)) {
            people[pid].events = (people[pid].events || []).filter((eid) => eid !== id)
          }
          save('events', events)
          save('people', people)
          save('ledger', read('ledger', []).filter((row) => row.eventId !== id))
          return { ok: true, dropped: id }
        }

        if (action === 'supersede') {
          // 旧事不作废，只是标一个"到此为止"：世界上它曾经成立，后来变了
          const oldId = input.from
          const newId = input.to || input.eventId
          const oldEv = events[oldId]
          const newEv = events[newId]
          if (!oldEv || !newEv) return { ok: false, reason: '两条事件都要存在' }
          if (oldId === newId) return { ok: false, reason: '不能自己推翻自己' }
          const made = addEdge(newId, oldId, 'supersedes', {
            note: String(input.value || '').trim() || '后来改了',
            validFrom: newEv.at,
          })
          oldEv.validTo = newEv.at
          save('events', events)
          return { ok: true, superseded: oldId, by: newId, edge: made }
        }

        if (action === 'cause') {
          // 因果要理解，不做自动推断：只接受明确指定的两端
          const fromEv = events[input.from]
          const toEv = events[input.to || input.eventId]
          if (!fromEv || !toEv) return { ok: false, reason: '因果两端都要是已存在的事件 id' }
          const made = addEdge(fromEv.id, toEv.id, 'causes', {
            note: String(input.value || '').trim() || '导致',
            validFrom: fromEv.at,
            validTo: toEv.at,
          })
          return { ok: true, cause: fromEv.id, effect: toEv.id, edge: made }
        }

        return { ok: false, reason: 'action 只能是 alias / merge / relation / move / drop / rename / supersede / cause' }
      },
    })

    tool({
      name: 'diary',
      description: '记一条流水：哪天主人在做什么。任务型对话用这个，不用判断涉及谁，一句话就够。',
      parameters: {
        doing: { type: 'string', description: '这天在做什么，一句话', required: true },
        topic: { type: 'string', description: '归到哪个主题，比如 倾听者插件 / 新版研究方向' },
        at: { type: 'string', description: '日期，默认今天' },
        keep: { type: 'boolean', description: '决定、里程碑这类重要的设 true' },
      },
      execute: (args) => {
        const input = args || {}
        const doing = String(input.doing || '').trim()
        if (!doing) return { ok: false, reason: '没有内容' }
        const nowMs = Date.now()
        const parsed = input.at ? Date.parse(String(input.at)) : NaN
        const when = Number.isFinite(parsed) ? parsed : nowMs
        const me = ensureSelf(when)
        const tone = judgeTone(doing)
        const events = read('events', {})
        const id = 'e_' + hash('diary' + doing + when)
        const ev = {
          id,
          at: new Date(when).toISOString(),
          who: [me.id],
          topic: String(input.topic || '').trim(),
          claim: clip(doing, 200),
          gist: firstClause(doing, 36),
          level: 0,
          emotion: tone.intensity >= 0.6 ? tone.intensity : 0.2,
          protected: Boolean(input.keep),
          created: nowMs,
          touches: [new Date(nowMs).toISOString()],
          kind: 'diary',
        }
        events[id] = ev
        save('events', events)

        const people = read('people', {})
        if (people[SELF_ID]) {
          people[SELF_ID].events = (people[SELF_ID].events || []).concat([id])
          people[SELF_ID].lastSeen = Math.max(people[SELF_ID].lastSeen || 0, when)
          save('people', people)
        }

        const topicName = String(input.topic || '').trim()
        if (topicName) {
          const made = ensureTopic(topicName, when)
          const topicsNow = read('topics', {})
          if (topicsNow[made.topic.id]) {
            const t = topicsNow[made.topic.id]
            t.events = (t.events || []).concat([id])
            t.lastSeen = Math.max(t.lastSeen || 0, when)
            save('topics', topicsNow)
          }
          addEdge(id, made.topic.id, 'about', { validFrom: ev.at, note: '关于' })
        }

        const meta = read('meta', {})
        meta.lastWriteAt = new Date(nowMs).toISOString()
        save('meta', meta)

        const ledger = read('ledger', [])
        ledger.push({ at: new Date(when).toISOString(), who: ['我'], what: firstClause(doing, 30), eventId: id })
        save('ledger', ledger.slice(-4000))

        return {
          ok: true,
          eventId: id,
          when: dayOf(when),
          topic: topicName,
          weight: Number(weightOf(ev, nowMs).toFixed(2)),
        }
      },
    })

    tool({
      name: 'journal',
      description: '按天回看主人在做什么：最近这些天的流水。',
      parameters: {
        days: { type: 'number', description: '回看多少天，默认 7' },
      },
      execute: (args) => {
        const input = args || {}
        const span = Math.max(1, Math.min(365, Number(input.days) || 7))
        const since = Date.now() - span * DAY
        const events = read('events', {})
        const me = read('people', {})[SELF_ID]
        if (!me) return { ok: true, days: span, count: 0, text: '' }
        const mine = (me.events || [])
          .map((eid) => events[eid])
          .filter(Boolean)
          .filter((ev) => (Date.parse(ev.at) || 0) >= since)
          .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
        const byDay = {}
        for (const ev of mine) {
          const key = dayOf(Date.parse(ev.at))
          byDay[key] = byDay[key] || []
          byDay[key].push(ev)
        }
        const text = Object.keys(byDay)
          .sort()
          .reverse()
          .map((key) => key + '：' + byDay[key].map((ev) => ev.claim).join('；'))
          .join('\n')
        return { ok: true, days: span, count: mine.length, text }
      },
    })

    tool({
      name: 'topics',
      description: '列出记忆里的主题。不挂在任何人名下的事，从这儿看。',
      parameters: {},
      execute: () => {
        const nowMs = Date.now()
        const topics = read('topics', {})
        const events = read('events', {})
        const people = read('people', {})
        const list = Object.keys(topics).map((id) => {
          const t = topics[id]
          const evs = (t.events || []).map((eid) => events[eid]).filter(Boolean)
          const involved = {}
          for (const ev of evs) {
            for (const pid of ev.who || []) {
              const p = people[pid]
              if (p) involved[p.name] = (involved[p.name] || 0) + 1
            }
          }
          const top = evs.reduce((max, ev) => Math.max(max, weightOf(ev, nowMs)), 0)
          return {
            name: t.name,
            events: evs.length,
            people: Object.keys(involved).sort((a, b) => involved[b] - involved[a]).slice(0, 6),
            lastSeen: t.lastSeen ? dayOf(t.lastSeen) : '',
            heat: Number(top.toFixed(2)),
          }
        })
        list.sort((a, b) => b.heat - a.heat)
        return { ok: true, count: list.length, topics: list }
      },
    })

    tool({
      name: 'graph',
      description: '从一个人或一件事出发，看周围连着什么。回答跨人、跨事的问题时用，比如"谁还跟他有关系"。',
      parameters: {
        person: { type: 'string', description: '从这个人出发' },
        topic: { type: 'string', description: '从这个主题出发' },
        eventId: { type: 'string', description: '或者从这条事件出发' },
        depth: { type: 'number', description: '几跳，默认 1，最多 2' },
        dead: { type: 'boolean', description: '是否连已作废的边一起看，默认 false' },
      },
      execute: (args) => {
        const input = args || {}
        const people = read('people', {})
        const events = read('events', {})
        let start = input.eventId || ''
        if (!start && input.person) {
          const found = findPerson(input.person)
          if (found) start = found.id
        }
        if (!start && input.topic) {
          const found = findTopic(input.topic)
          if (found) start = found.id
        }
        if (!start) return { ok: false, reason: '给 person / topic / eventId' }
        if (!people[start] && !events[start] && !read('topics', {})[start]) return { ok: false, reason: '找不到起点' }
        const depth = Math.min(2, Math.max(1, Number(input.depth) || 1))
        const lines = []
        const seenEdge = new Set()
        const seenNode = new Set([start])
        let frontier = [start]
        for (let hop = 1; hop <= depth; hop += 1) {
          const next = []
          for (const node of frontier) {
            for (const edge of edgesOf(node, Boolean(input.dead))) {
              if (seenEdge.has(edge.id)) continue
              seenEdge.add(edge.id)
              const otherId = edge.from === node ? edge.to : edge.from
              const dead = edge.invalidatedAt ? '（已作废）' : ''
              lines.push(
                describe(node, people, events) + ' —' + (edge.note || edge.type) + '→ ' +
                describe(otherId, people, events) + dead
              )
              if (!seenNode.has(otherId)) {
                seenNode.add(otherId)
                next.push(otherId)
              }
            }
            // 人和事之间的归属不作为边存（会重复），遍历时现算
            if (people[node]) {
              for (const eid of people[node].events || []) {
                const bound = events[eid]
                if (!bound) continue
                const tag = 'who:' + node + ':' + eid
                if (seenEdge.has(tag)) continue
                seenEdge.add(tag)
                lines.push(
                  people[node].name + ' —有事→ ' + describe(eid, people, events) +
                  (bound.validTo ? '（后来变了）' : '')
                )
                if (!seenNode.has(eid)) {
                  seenNode.add(eid)
                  next.push(eid)
                }
              }
            }
          }
          frontier = next
          if (!frontier.length) break
        }
        return {
          ok: true,
          start: describe(start, people, events),
          nodes: seenNode.size,
          edges: lines,
          empty: lines.length === 0,
        }
      },
    })

    tool({
      name: 'tidy',
      description: '立刻整理记忆：合并重复、给相似的事连线、清理悬空引用。平时每 6 小时自动跑一次。',
      parameters: {},
      execute: () => {
        const stats = consolidate()
        return Object.assign({ ok: true }, stats)
      },
    })

    tool({
      name: 'export',
      description: '把全部记忆导出成一份可读的 Markdown，给人看。',
      parameters: {},
      execute: () => {
        const nowMs = Date.now()
        const people = read('people', {})
        const events = read('events', {})
        const ledger = read('ledger', [])
        const pending = read('pending', [])
        const out = ['# 记事本', '', '共 ' + Object.keys(events).length + ' 件事，' + Object.keys(people).length + ' 个人。', '']
        const ids = Object.keys(people).sort((a, b) => (people[b].lastSeen || 0) - (people[a].lastSeen || 0))
        for (const id of ids) {
          const p = people[id]
          out.push('## ' + p.name + (p.relation ? '（' + p.relation + '）' : ''))
          if ((p.aliases || []).length) out.push('别名：' + p.aliases.join('、'))
          for (const edge of p.edges || []) {
            out.push('关系：' + p.name + ' 与 ' + (people[edge.to] ? people[edge.to].name : edge.to) + ' 是' + edge.type)
          }
          const evs = (p.events || []).map((eid) => events[eid]).filter(Boolean)
            .map((ev) => ({ ev, score: (ev.protected ? 10 : 0) + weightOf(ev, nowMs) }))
            .sort((a, b) => b.score - a.score)
          for (const item of evs.slice(0, 12)) {
            const mark = item.ev.protected ? '📌 ' : ''
            out.push('- ' + mark + dayOf(Date.parse(item.ev.at)) + ' ' + item.ev.claim)
          }
          out.push('')
        }
        const topics = read('topics', {})
        const topicIds = Object.keys(topics)
        if (topicIds.length) {
          out.push('## 主题')
          for (const tid of topicIds) {
            const t = topics[tid]
            const evs = (t.events || []).map((eid) => events[eid]).filter(Boolean)
            out.push('### #' + t.name + '（' + evs.length + ' 条）')
            for (const ev of evs.slice(-10)) out.push('- ' + dayOf(Date.parse(ev.at)) + ' ' + ev.claim)
          }
          out.push('')
        }

        const orphan = Object.keys(events).map((id) => events[id]).filter((ev) => !(ev.who || []).length)
        if (orphan.length) {
          out.push('## 未归类')
          for (const ev of orphan.slice(-20)) out.push('- ' + dayOf(Date.parse(ev.at)) + ' ' + ev.claim)
          out.push('')
        }
        if (pending.filter((q) => q.status === 'open').length) {
          out.push('## 待问')
          for (const q of pending.filter((x) => x.status === 'open')) out.push('- ' + q.question)
          out.push('')
        }
        out.push('## 总目录（最近 40 条）')
        for (const row of ledger.slice(-40)) {
          out.push('- ' + dayOf(Date.parse(row.at)) + ' ' + (row.who.length ? row.who.join('、') : '未归类') + '：' + row.what)
        }
        return { ok: true, markdown: out.join('\n'), total: ledger.length }
      },
    })

    tool({
      name: 'forget',
      description: '忘掉一个人，或清空全部记忆。删人时连带删掉只属于他的事。',
      parameters: {
        person: { type: 'string', description: '要忘掉的人名' },
        all: { type: 'boolean', description: 'true 则清空全部' },
      },
      execute: (args) => {
        const input = args || {}
        if (input.all) {
          save('people', {})
          save('events', {})
          save('topics', {})
          save('edges', [])
          save('ledger', [])
          save('pending', [])
          save('meta', {})
          return { ok: true, wiped: true }
        }
        const person = findPerson(input.person)
        if (!person) return { ok: false, reason: '没有这个人' }
        const people = read('people', {})
        const events = read('events', {})
        for (const id of person.events || []) {
          const ev = events[id]
          if (!ev) continue
          ev.who = (ev.who || []).filter((pid) => pid !== person.id)
          if (!ev.who.length) delete events[id]
        }
        for (const id of Object.keys(people)) {
          const p = people[id]
          if (!p.edges) continue
          p.edges = p.edges.filter((edge) => edge.to !== person.id)
        }
        delete people[person.id]
        save('people', people)
        save('events', events)
        save('edges', read('edges', []).filter((e) => e.from !== person.id && e.to !== person.id))
        save('ledger', read('ledger', []).filter((row) => (row.who || []).indexOf(person.name) < 0))
        save('pending', read('pending', []).filter((q) => q.personId !== person.id))
        return { ok: true, forgot: person.name }
      },
    })

    // ── 每 6 小时整理一次：去重、连线、清悬空 ────────────
    try {
      ctx.onTick(6 * 3600 * 1000, () => {
        const stats = consolidate()
        if (stats.merged || stats.linked || stats.pruned) {
          ctx.log('整理：合并 ' + stats.merged + '，连线 ' + stats.linked + '，清理悬空 ' + stats.pruned)
        }
      })
    } catch (error) {
      ctx.log('定时器注册失败：' + error)
    }

    ctx.log('就绪：人物档案 + 总目录 + 权重衰减')
  },
})

