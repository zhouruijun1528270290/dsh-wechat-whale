// 把 dsh-bili-scroll 写的日报解析成微信能发的东西。
//
// 那个插件（另一个进程）只做一件事：把当天挑出的视频写成 `out\<日期>.md`，
// 每条的段首固定是 `### BV号`。它不会推送，也不认识我们。
// 所以这里只做「读文件 → 拆条目 → 排版」这一层，推送在 bridge.mjs 里。
//
// 解析要宽：插件那侧的报告模板以后可能改，字段缺了要能退化成「至少把链接发出去」，
// 而不是整份报告推不出去。

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** 一条 B 站视频的链接。 */
export function bvLink(bv) {
  return `https://www.bilibili.com/video/${bv}`
}

/** 从任意文本里抠出所有 BV 号（去重、保持出现顺序）。 */
export function extractBvs(text) {
  const out = []
  const seen = new Set()
  const re = /BV[0-9A-Za-z]{10}/g
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    out.push(m[0])
  }
  return out
}

/**
 * 从手机分享出来的链接大多是 `b23.tv/xxxx` 短链，里面没有 BV。
 * 跟一次跳转，从落地地址里抠 BV。拿不到就返回 ''。
 */
export async function resolveB23(url, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!/b23\.tv/i.test(String(url ?? ''))) return ''
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        referer: 'https://www.bilibili.com/',
      },
      signal: ac.signal,
    })
    const fromUrl = extractBvs(r.url || '')[0]
    if (fromUrl) return fromUrl
    // 落地页有时是活动页，BV 在正文里
    const body = await r.text()
    return extractBvs(body)[0] || ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 去掉 markdown 装饰，留给人看的纯文本。 */
function clean(line) {
  return String(line ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/\s+$/, '')
    .trim()
}

/** 抓 `键：值` 这种字段。keys 是若干可能的写法。 */
function field(lines, keys) {
  const re = new RegExp(`^\\s*(?:[-*+]\\s*)?(?:\\*\\*)?(?:${keys.join('|')})(?:\\*\\*)?\\s*[:：]\\s*(.+)$`)
  for (const line of lines) {
    const m = re.exec(line)
    if (m) {
      const v = clean(m[1])
      if (v) return v
    }
  }
  return ''
}

/** UP 那一行插件写成 `Blacktion · 6:54 · 播放 3313 · 评论 178` —— 只留第一段，别把统计塞进标题行。 */
function shortUp(value) {
  const v = String(value ?? '').split(/[·|｜]/)[0].trim()
  return v.replace(/[\s,，]+$/, '')
}

/** 时长优先从专门的字段里抓，退而求其次抓段内第一个 mm:ss。 */
function durationOf(lines) {
  const named = field(lines, ['时长', '长度', '播放时长'])
  if (named) return clean(named)
  for (const line of lines) {
    const m = /(\d{1,2}:\d{2}(?::\d{2})?)/.exec(line)
    if (m) return m[1]
  }
  return ''
}

/** 「它自己的一句话」——插件约定用引用块或「」包着，抓不到就算了。 */
function snippetOf(lines) {
  for (const line of lines) {
    if (/^\s*>/.test(line)) {
      const v = clean(line)
      if (v) return v
    }
  }
  // 「」只从正文抓：标题里本来就可能带引号（「他说「哈哈哈」」），从整段抓会把标题当观感
  for (const line of lines) {
    if (/^#{1,6}\s*/.test(line)) continue
    const m = /「([^」]{2,80})」/.exec(line)
    if (m) return m[1].trim()
  }
  return ''
}

/** 「我的一句」——她自己的口气，推给用户看的就是这一行；没有才退到中性的「为什么值得」。 */
function reasonOf(lines) {
  const voiced = field(lines, ['我的一句', '我的一句点评', '我的一句话', '我的看法', '我的感觉', '一句话点评'])
  if (voiced) return voiced
  const named = field(lines, ['为什么值得', '值得看的原因', '理由', '推荐理由'])
  if (named) return named
  for (const line of lines) {
    if (/^\s*[-*+]\s+/.test(line)) {
      const v = clean(line)
      if (!v) continue
      if (/^BV[0-9A-Za-z]{10}$/.test(v)) continue
      if (/https?:\/\//.test(v) || /bilibili\.com/i.test(v) || /BV[0-9A-Za-z]{10}/.test(v)) continue
      if (/^\[[^\]]*\]\([^)]*\)$/.test(v)) continue       // 纯 markdown 链接
      return v
    }
  }
  return ''
}

/** 标题：`《…》` 只从段首标题抓 > `标题：…` > 段首标题里 BV 之后剩下的部分 > 段内第一行正文。 */
function titleOf(heading, bv, lines) {
  const inBracket = /《([^》]{1,120})》/.exec(heading)
  if (inBracket) return inBracket[1].trim()

  const named = field(lines, ['标题', '视频标题', '名字'])
  if (named) return named

  const rest = clean(heading).replace(bv, '').replace(/^[\s·—\-–|,，:：]+/, '').replace(/[\s·—\-–|,，:：]+$/, '')
  if (rest) return rest

  // 上游更常见的写法是标题在**正文第一行**：`《标题》 · UP · 08:02`。
  // 只从段首标题抓《》会漏掉这种，退化成「整行当标题」，最后拼出 `《《标题》 · UP · 08:02》`。
  // 顺序要紧：段首能给出标题时绝不让正文里的《》劫持（见 R 段用例），所以放在 rest 之后。
  // （与 _share\dsh-bili-notify\report.mjs 保持一致，_probe\test-report-parity.mjs 会对拍）
  // 只认**以书名号开头**的正文行（`《标题》 · UP · 08:02`）。
  // 不能见到《》就抓：`为什么值得：推荐《别的视频》这期` 里的书名号是观感里提到的另一个视频。
  for (const line of lines) {
    const v = clean(line)
    if (!v.startsWith('《')) continue
    const inBody = /《([^》]{1,120})》/.exec(v)
    if (inBody) return inBody[1].trim()
  }

  for (const line of lines) {
    const v = clean(line)
    if (!v) continue
    if (/^BV[0-9A-Za-z]{10}$/.test(v)) continue
    if (/^(?:https?:\/\/)/.test(v)) continue
    if (/^(?:标题|UP主|up主|UP|作者|时长|长度|为什么值得|理由|推荐理由)\s*[:：]/.test(v)) continue
    return v
  }
  return ''
}

/**
 * 解析一份日报。
 * 返回 `{ title, date, intro, items: [{ bv, title, up, duration, reason, snippet, link }] }`。
 * `date` 只从文件名或 `# 2026-10-18` 这种大标题里取，取不到就是空字符串。
 */
export function parseReport(md, { filename = '' } = {}) {
  const text = String(md ?? '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)

  let date = ''
  const fromName = /(\d{4}-\d{2}-\d{2})/.exec(filename)
  if (fromName) date = fromName[1]
  if (!date) {
    for (const line of lines) {
      if (!/^#\s/.test(line)) continue
      const m = /(\d{4}-\d{2}-\d{2})/.exec(line)
      if (m) { date = m[1]; break }
    }
  }

  let title = ''
  for (const line of lines) {
    if (/^#\s/.test(line)) { title = clean(line.replace(/^#\s+/, '')); break }
  }

  const items = []
  const seen = new Set()
  let current = null
  const flush = () => {
    if (!current) return
    // 只认标题里的 BV。以前这里还会去正文里捞（`?? extractBvs(body)`），结果插件写
    // 「这轮一条都没挑出来」的空报告时，正文那个「候选」列表里的 BV 会被当成真视频排进队列，
    // 推给用户一条没有观感的东西。空报告就该是 0 条，宁可少推。
    const bv = extractBvs(current.heading)[0]
    if (!bv || seen.has(bv)) { current = null; return }
    seen.add(bv)
    items.push({
      bv,
      title: titleOf(current.heading, bv, current.body),
      up: shortUp(field(current.body, ['UP主', 'up主', 'UP', '作者', 'up'])),
      duration: durationOf(current.body),
      reason: reasonOf(current.body),
      snippet: snippetOf(current.body),
      link: bvLink(bv),
    })
    current = null
  }

  for (const line of lines) {
    // 放宽到 2~6 个 #，且 `###BV…`（没有空格）也认 —— 插件模板一改就整链路静默失效，这个坑踩过
    const m = /^#{2,6}\s*(.*)$/.exec(line)
    if (m) {
      flush()
      current = { heading: m[1], body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  flush()

  // 报销：有几个段落里其实没 BV（比如「今天没刷到」），没有条目就是空
  const intro = lines
    .filter((l) => !/^#{1,6}\s*/.test(l))
    .map(clean)
    .filter(Boolean)[0] ?? ''

  return { title, date, intro, items }
}

/**
 * 排成微信里发的一段话。
 * `maxPerPush` 限制一次推几条，剩下的只提一句「还有 N 条」。
 */
/**
 * 拆成「气泡」数组：每条视频两个气泡 —— 先说标题和感想，再单独给一条地址。
 * 这样一条消息里只有两行，不依赖长文本自动换行；地址也不占正文宽度。
 * 第一泡带「今天刷到 N 条」的头，最后一泡带「还有 N 条」的尾。
 */
export function reportToBubbles(report, { maxPerPush = 3, total = null } = {}) {
  const items = Array.isArray(report?.items) ? report.items : []
  const all = total ?? items.length
  if (!items.length) return []

  const shown = items.slice(0, Math.max(1, maxPerPush))
  const out = []
  shown.forEach((it, i) => {
    const meta = [it.duration, it.up].filter(Boolean).join(' · ')
    const head = `${i + 1}、${it.title ? `《${it.title}》` : it.bv}${meta ? ` ${meta}` : ''}`
    const tail = it.snippet || it.reason
    const lines = []
    if (i === 0) lines.push(`今天刷到 ${all} 条：`)
    lines.push(head)
    if (tail) lines.push(tail)
    out.push(lines.join('\n\n'))
    out.push(`地址：${it.link}`)
  })
  const rest = all - shown.length
  if (rest > 0) out[out.length - 1] += `\n\n还有 ${rest} 条，回 /bili 看。`
  return out
}

/**
 * 单条视频 → 一条消息（一次只发一条，像真人随手甩个视频过来）。
 * 三段：标题行（时长 · UP）/ 观感 / 地址，中间空一行 —— 单换行会被微信吞成空格。
 */
export function itemToMessage(item, { linkStyle = 'url', maxChars = 1800 } = {}) {
  if (!item) return ''
  const meta = [item.duration, item.up].filter(Boolean).join(' · ')
  const head = `《${item.title || item.bv}》${meta ? ` ${meta}` : ''}`
  let words = item.reason || item.snippet || ''
  const style = linkStyle === 'bv' || linkStyle === 'none' ? linkStyle : 'url'   // 拼错就回退 url，别静默丢地址
  const addr = style === 'url'
    ? `地址：${item.link || bvLink(item.bv)}`
    : (style === 'bv' ? `地址：BV 号 ${item.bv}` : '')
  // 一条消息必须一条发得出去：超长会被 channel.say 切片，切片中途失败重试就会重复 —— 先截断
  const budget = Math.max(120, Number(maxChars) || 1800) - head.length - addr.length - 4
  if (words.length > budget) words = `${words.slice(0, Math.max(0, budget - 1))}…`
  const parts = [head]
  if (words) parts.push(words)
  if (addr) parts.push(addr)
  return parts.join('\n\n')
}

/**
 * 单条视频 → **两个气泡**：先发「标题 + 地址」，再发「评价」。
 * 理由是真人推视频就是这么干的：先把东西甩过来（标题、链接），再补一句自己的话。
 * 评价为空时只发一个气泡（只有标题+地址），不要把空字符串也发出去。
 */
export function itemToMessages(item, { linkStyle = 'url', maxChars = 1800 } = {}) {
  if (!item) return []
  const meta = [item.duration, item.up].filter(Boolean).join(' · ')
  const head = `《${item.title || item.bv}》${meta ? ` ${meta}` : ''}`
  const style = linkStyle === 'bv' || linkStyle === 'none' ? linkStyle : 'url'
  const addr = style === 'url'
    ? `地址：${item.link || bvLink(item.bv)}`
    : (style === 'bv' ? `地址：BV 号 ${item.bv}` : '')
  const first = addr ? `${head}\n\n${addr}` : head        // 单换行会被微信吞成空格，所以用空行
  let words = `${item.reason || item.snippet || ''}`.trim()
  if (!words) return [first]
  const budget = Math.max(40, Number(maxChars) || 1800)
  if (words.length > budget) words = `${words.slice(0, Math.max(0, budget - 1))}…`
  return [first, words]
}

/**
 * 给一批待推的条目排「什么时候发」：每条在 [minDelayMin, maxDelayMin] 分钟内随机挑一个点，
 * 保持先后顺序、彼此至少隔 gapMin 分钟 —— 一次只发一条，散在整个空闲时段里，像想起来才发。
 * 上下界都要守住：第 i 条的上限要给后面 n-1-i 条留出 gap，否则会滚过 maxDelayMin（甚至滚到次日凌晨）。
 */
export function planDueAt(count, {
  nowMs = Date.now(), minDelayMin = 15, maxDelayMin = 240, gapMin = 20, rand = Math.random,
} = {}) {
  const n = Math.max(0, Number(count) || 0)
  const out = []
  if (!n) return out
  const lo = Math.max(0, Number(minDelayMin) || 0)
  const gap = Math.max(0, Number(gapMin) || 0)
  const maxMin = Math.max(lo, Number(maxDelayMin) || 0)
  // 条目太多、窗口太窄时，把 gap 压到刚好塞得下 —— 宁可挨近一点，也不能滚过上限（滚过去就是凌晨发）
  const gapEff = n > 1 ? Math.min(gap, (maxMin - lo) / (n - 1)) : 0
  let prev = 0
  for (let i = 0; i < n; i += 1) {
    const floor = i === 0 ? lo : Math.max(lo, prev + gapEff)
    const ceil = Math.max(floor, maxMin - (n - 1 - i) * gapEff)
    const delay = Math.round(floor + rand() * (ceil - floor))
    out.push(nowMs + delay * 60 * 1000)
    prev = delay
  }
  return out
}

export function reportToText(report, { maxPerPush = 3, total = null, linkStyle = 'bv' } = {}) {
  const items = Array.isArray(report?.items) ? report.items : []
  const all = total ?? items.length
  if (!items.length) return { text: '', shown: 0, total: all }

  // 实测：微信的 bot 文字气泡会把**单个换行**吞成空格（一整条挤成一段），
  // 所以逻辑行之间必须空一行（'\n\n'）才真的换行。
  // linkStyle：'bv' 只留 BV 号并进标题行（默认；微信里裸链接也不会变蓝）/ 'url' 完整链接单独一行 / 'none' 不要。
  const shown = items.slice(0, Math.max(1, maxPerPush))
  const lines = [`今天刷到 ${all} 条：`]
  shown.forEach((it, i) => {
    const meta = [it.duration, it.up].filter(Boolean).join(' · ')
    const bvTag = linkStyle === 'bv' ? it.bv : ''
    const head = `${i + 1}、${it.title ? `《${it.title}》` : it.bv}`
      + (meta ? ` ${meta}` : '')
      + (bvTag ? ` · ${bvTag}` : '')
    lines.push(head)
    const tail = it.snippet || it.reason
    if (tail) lines.push(tail)
    if (linkStyle === 'url') lines.push(it.link)
  })
  const rest = all - shown.length
  if (rest > 0) lines.push(`还有 ${rest} 条，回 /bili 看。`)

  return { text: lines.join('\n\n'), shown: shown.length, total: all }
}

/** 报告文件的指纹，用来判断「同一天的报告被改过了」。 */
export function reportStamp(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12)
}

/** 兜底读文件（调用方要自己 catch 不到就返回空串）。 */
export function readReportFile(file) {
  return readFileSync(file, 'utf8')
}

/**
 * 抓一张封面图（B 站公开的 view 接口，不需要登录）。
 * 拿不到就返回 null —— 封面是锦上添花，绝不能因为它失败就不推日报。
 */
export async function fetchCover(bv, { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return null
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    referer: bvLink(bv),
  }
  try {
    const r = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`, {
      headers,
      signal: ac.signal,
    })
    if (r.status !== 200) return null
    const j = await r.json()
    if (j?.code !== 0 || !j?.data?.pic) return null
    const pic = String(j.data.pic)
    if (!/^https?:\/\//.test(pic)) return null
    const img = await fetchImpl(pic, { headers, signal: ac.signal })
    if (img.status !== 200) return null
    const bytes = Buffer.from(await img.arrayBuffer())
    if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) return null
    return { bytes, url: pic }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
// ---------------------------------------------------------------- 视频概览（他分享过来时用）

/** 从 B站扫码凭证里拼 cookie；没登录也能取公开信息，所以失败就返回空串。 */
export function cookieFromCredential(raw) {
  if (!raw) return ''
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    const pairs = []
    for (const key of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
      const v = j?.[key]
      if (v && typeof v === 'string') pairs.push(`${key}=${v}`)
    }
    return pairs.join('; ')
  } catch {
    return ''
  }
}

export function mmss(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}小时${String(m).padStart(2, '0')}分` : `${m}分${String(sec).padStart(2, '0')}秒`
}

/** 取一个视频的公开信息 + 几条热评。任何失败都返回 { error }，不抛。 */
export async function biliVideoBrief(bv, { fetchImpl = globalThis.fetch, cookie = '', timeoutMs = 15000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    referer: `https://www.bilibili.com/video/${bv}`,
    ...(cookie ? { cookie } : {}),
  }
  try {
    const r = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers, signal: ac.signal })
    if (r.status !== 200) return { bv, error: `http-${r.status}` }
    const j = await r.json()
    if (j?.code !== 0 || !j?.data) return { bv, error: j?.message || `code-${j?.code}` }
    const d = j.data
    const brief = {
      bv,
      aid: d.aid,
      title: String(d.title || '').trim(),
      up: String(d.owner?.name || ''),
      duration: mmss(d.duration),
      view: Number(d.stat?.view) || 0,
      like: Number(d.stat?.like) || 0,
      desc: String(d.desc || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      comments: [],
    }
    try {
      const c = await fetchImpl(
        `https://api.bilibili.com/x/v2/reply?type=1&oid=${d.aid}&sort=2&ps=8`,
        { headers, signal: ac.signal },
      )
      if (c.status === 200) {
        const cj = await c.json()
        brief.comments = (cj?.data?.replies || [])
          .map((x) => String(x?.content?.message || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t.length > 3)
          .slice(0, 6)
          .map((t) => t.slice(0, 80))
      }
    } catch { /* 评论拿不到就只靠简介 */ }
    return brief
  } catch (e) {
    return { bv, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch-failed') }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把它拼成「他刚甩给你一个视频」的那段话，交给会话。
 * 刻意只给事实 + 一句约束，剩下的交给她的口吻。
 */
export function videoTaskText(brief, { clock = '' } = {}) {
  if (!brief || brief.error) return ''
  const lines = [
    clock,
    '他刚在微信里甩给你一个 B 站的视频，让你看看：',
    `《${brief.title}》`,
    `UP：${brief.up || '未知'}　时长：${brief.duration}　播放：${brief.view}　点赞：${brief.like}`,
    brief.desc ? `简介：${brief.desc}` : '',
    brief.comments.length ? `底下热评：${brief.comments.slice(0, 4).map((c) => `「${c}」`).join(' ')}` : '',
    '（你没看过画面，只有标题、简介和评论 —— 别假装看过画面。）',
    '用你自己的话回一句：可以吐槽、可以只接一个点、可以损他审美；不要复述标题、不要列点、别提「简介」「评论」「链接」这些词，一两句就够。',
  ]
  return lines.filter(Boolean).join('\n')
}

