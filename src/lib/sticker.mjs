// 表情包：标签解析 / 目录扫描 / 清单生成。
// 全部是纯函数（除了 listStickers 读目录），方便单测 —— 这里错了会静默失灵，必须能测。
//
// 约定（两种写法都行，可以混用）：
//   `stickers\无语.png`          —— 文件名（去扩展名）就是标签
//   `stickers\无语\*.png`        —— **目录名就是标签**，里面的图随便挑一张发（推荐，同一情绪多张不臃肿）
// 以 `_` 开头的文件/目录忽略；可选的 `描述.json`（{ "无语": "什么时候用" }）补"什么时候用"。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { spliceSection } from './sections.mjs'

export const STICKER_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
export const STICKERS_BEGIN = '<!-- STICKERS:BEGIN -->'
export const STICKERS_END = '<!-- STICKERS:END -->'

/** 模型在回复里写的标记：`[[表情:无语]]` / `[[表情包：无语]]` / `[[sticker:无语]]`。 */
export const STICKER_TAG_RE = /\[\[\s*(?:表情包?|sticker)\s*[:：]\s*([^\]\n]{1,40}?)\s*\]\]/gi

/**
 * 从回复里剥出标记，返回干净文本 + 想要的标签。
 * 标记可能出现在行首、行尾或句子中间；剥掉之后空行会被去掉。
 */
export function extractStickerTags(text) {
  const wanted = []
  const body = String(text ?? '').replace(STICKER_TAG_RE, (_m, name) => {
    const n = String(name ?? '').trim()
    if (n) wanted.push(n)
    return ''
  })
  const cleaned = body
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
  return { text: cleaned, wanted }
}

/** 把「一个文件一条」摊平成「一个标签一条」，`files` 是同名标签下的全部图（目录写法的用处）。 */
export function groupStickers(list) {
  const byLabel = new Map()
  for (const s of Array.isArray(list) ? list : []) {
    if (!s?.label) continue
    const g = byLabel.get(s.label)
    if (g) g.files.push(s.file)
    else byLabel.set(s.label, { label: s.label, files: [s.file], note: s.note ?? '' })
  }
  const out = [...byLabel.values()]
  out.sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  return out
}

/**
 * 把模型写的标签对到一个真实文件上。精确优先，其次双向包含（短标签不做反向包含，免得乱配）。
 * 一个标签下有多张时随机取一张 —— 同一个情绪多备几张，发出来才不会次次一样。
 * `rand` 只为单测注入固定值。
 */
export function resolveSticker(list, want, { rand = Math.random } = {}) {
  const w = String(want ?? '').trim().toLowerCase()
  if (!w) return null
  const groups = groupStickers(list)
  const exact = groups.find((s) => s.label.toLowerCase() === w)
  const hit = exact ?? groups.find((s) => {
    const l = s.label.toLowerCase()
    return l.includes(w) || (l.length >= 2 && w.includes(l))
  })
  if (!hit || !hit.files.length) return null
  const i = Math.min(hit.files.length - 1, Math.floor(rand() * hit.files.length))
  return { label: hit.label, file: hit.files[i], files: hit.files, note: hit.note }
}

/**
 * 决定这一轮到底发不发、发哪个（桥接侧兜底，不依赖模型自觉）。
 *
 * 硬规则：**正文超过 maxTextChars 字就丢弃标记** —— 长回复 = 这轮在讲正事，
 * 不是在插科打诨。比起在人格卡里写"认真模式不要发"，这条是硬的。
 * 一次最多一张。
 *
 * @returns {{ wanted: string[], note: string }} note 非空时是要记日志的原因
 */
export function planStickerTags(tagged, { maxTextChars = 200, enabled = true } = {}) {
  const wanted = Array.isArray(tagged?.wanted) ? tagged.wanted : []
  if (!enabled) return { wanted: [], note: wanted.length ? 'disabled' : '' }
  if (!wanted.length) return { wanted: [], note: '' }
  const chars = String(tagged?.text ?? '').length
  if (chars > Math.max(0, Number(maxTextChars))) {
    return { wanted: [], note: `dropped:long-reply(${chars})` }
  }
  return { wanted: wanted.slice(0, 1), note: '' }
}

/** 扫 `dir` 下的表情包：平铺图片按文件名当标签，子目录按目录名当标签（目录内的图都归它）。 */
export function listStickers(dir) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return [] }
  let notes = {}
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, '描述.json'), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) notes = parsed
  } catch { notes = {} }
  const out = []
  const push = (label, file) => {
    out.push({ label, file, note: String(notes[label] ?? '').trim() })
  }
  for (const entry of entries) {
    if (entry.startsWith('_')) continue
    const full = path.join(dir, entry)
    let st = null
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      const label = entry.trim()
      if (!label) continue
      let inner = []
      try { inner = readdirSync(full) } catch { continue }
      for (const name of inner) {
        if (name.startsWith('_')) continue
        if (!STICKER_EXT.has(path.extname(name).toLowerCase())) continue
        push(label, path.join(full, name))
      }
      continue
    }
    const ext = path.extname(entry).toLowerCase()
    if (!STICKER_EXT.has(ext)) continue
    const label = path.basename(entry, path.extname(entry)).trim()
    if (!label) continue
    push(label, full)
  }
  out.sort((a, b) => a.label.localeCompare(b.label, 'zh') || a.file.localeCompare(b.file, 'zh'))
  return out
}

/**
 * 生成要写进 AGENTS.md 的清单块。
 *
 * **标题 `## 表情包` 也在 BEGIN/END 里面** —— 这个写入者拥有的东西全在自己标记之内，
 * 标记之外一个字节都不产。这样"段外逐字节不变"才是能断言的不变量（插入时也不必加前缀）。
 */
export function stickerManifest(list) {
  const groups = groupStickers(list)
  const lines = [
    STICKERS_BEGIN,
    '## 表情包',
    '',
    '> 这一段由 `bridge.mjs` 自动生成，手改会在下次启动时被覆盖。',
    '',
    '**你有表情包可以发。** 想发的时候，在回复里**单独写一行**：',
    '',
    '```',
    '[[表情:名字]]',
    '```',
    '',
    'bridge 会把这一行从你的话里剥掉，先把文字发出去，再把那张图补上。名字要写准；不确定就别发。**一次最多一张。**',
    '',
    '**表里的名字是一个「情绪」，不是某一张图** —— 同一个名字底下可能有好几张，发哪张由 bridge 随便挑，你不用管。',
    '',
  ]
  if (!groups.length) {
    lines.push('_（`stickers\\` 目录现在是空的，你暂时没有表情包可发。）_')
  } else {
    lines.push('| 名字 | 张数 | 什么时候用 |', '| --- | --- | --- |')
    for (const s of groups) {
      lines.push(`| ${s.label} | ${s.files.length} | ${s.note || '（没写说明，自己看名字判断）'} |`)
    }
  }
  lines.push(
    '',
    '**什么时候发**：不用等什么特别时机 —— 对方在玩梗、你怼回去、你得意、你无语、你想岔开话题、气氛松下来，甚至只是随口应一句，都可以顺手甩一张。**差不多每两三条就带一张**，让对方眼前一直有你的样子。',
    '',
    '**什么时候别发**：',
    '- 不用每条都发，但连着两条都带也没关系；认真模式（③）里一张都不发。',
    '- 对方真难过的时候绝对不发。',
    '- 不要把表情包当成回答主要问题的手段。',
    '- **不许**把「表情包」三个字、或者标记本身写进你要说的话里。',
    '',
    '只发图、不说话也行 —— 那就只写标记那一行。',
    STICKERS_END,
  )
  return lines.join('\n')
}

/**
 * 把清单同步进 `file`（默认 AGENTS.md）。
 * 走共用的 `spliceSection` —— 只动 STICKERS 段，MEMORY / PERSONA / 手改的内容一个字节都不碰。
 * 返回 `{ ok, changed, count, error? }`（不抛错）。测试与 bridge 走的是**同一个函数**。
 */
export function syncStickerSection({ file, dir, anchor = '\n## 记忆段' } = {}) {
  const list = listStickers(dir)
  const res = spliceSection(file, {
    begin: STICKERS_BEGIN,
    end: STICKERS_END,
    body: stickerManifest(list),
    anchor,
    validate: (next) => {
      if ((next.match(/<!-- STICKERS:BEGIN -->/g) ?? []).length !== 1) return 'STICKERS:BEGIN 不是恰好一个'
      if ((next.match(/<!-- STICKERS:END -->/g) ?? []).length !== 1) return 'STICKERS:END 不是恰好一个'
      if ((next.match(/<!-- MEMORY:BEGIN -->/g) ?? []).length > 1) return '改完后 MEMORY 段被弄坏了'
      return ''
    },
  })
  return { ...res, count: groupStickers(list).length, files: list.length, labels: groupStickers(list).map((s) => s.label) }
}

