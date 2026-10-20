// 多写入者文件（AGENTS.md）的安全分段改写。
//
// 背景：AGENTS.md 至少有三个写入者 —— 记忆蒸馏器（MEMORY 段）、表情包同步（STICKERS 段）、
// 以及人手改（好感度/人格）。多个 `writeFileSync(整份)` 互相覆盖是这类文件最容易出的 bug：
// 谁也没保证"只动自己那一段"。所以**所有写入者都必须走这里**，不许自己写整份。
//
// 这里的保证：
//   1. 只替换自己 BEGIN/END 之间那一段，一个字节都不碰别人的段；
//   2. 写前**重新读一次**文件（防止"读旧写新"把别人的改动冲掉）；
//   3. 写临时文件 → 读回校验 → rename 原子替换（半截文件不会留在盘上）；
//   4. 替换前备份一份 `<file>.bak`（滚动覆盖）；
//   5. UTF-8 **无 BOM**，并断言（读回检查前 3 字节不是 EF BB BF）；
//   6. 文件不存在就创建，而不是抛错。

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

/** 读文本并剥掉可能存在的 BOM（PowerShell 的 `-Encoding utf8` 会写出来）。 */
export function readTextNoBom(file) {
  const raw = readFileSync(file, 'utf8')
  if (raw.charCodeAt(0) === 0xfeff) return { text: raw.slice(1), bom: true }
  return { text: raw, bom: false }
}

/**
 * 纯函数：把 `body` 并进 `raw`，只动 `begin`/`end` 之间的那一段。
 *
 * - 段存在（且 begin/end 各恰好一次）→ 原地替换，尾巴里重复的 end 行顺手清掉；
 * - 段不存在 → `insertIfMissing` 为真时插到 `anchor` 之前（没有 anchor 就追加到末尾），
 *   插入时带上 `insertPrefix`（比如 `## 表情包\n\n`）；为假则抛错，宁可不动；
 * - 段残缺或重复 → 一律抛错（不猜，避免吃掉别人的段）。
 */
export function spliceSectionText(raw, {
  begin, end, body, anchor = '', insertPrefix = '', insertIfMissing = true,
} = {}) {
  const text = String(raw ?? '')
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  if (i >= 0 && j > i) {
    if (text.indexOf(begin, i + 1) >= 0) throw new Error(`有多处 ${begin}，拒绝改写`)
    // 尾巴里历史上可能残留重复的 end 行，一并清掉（body 自带那一个保留）
    const tail = text.slice(j + end.length).split('\n').filter((l) => l.trim() !== end).join('\n')
    return `${text.slice(0, i)}${body}${tail}`
  }
  if (i >= 0 || j >= 0) throw new Error(`${begin} / ${end} 不成对，拒绝改写`)
  if (!insertIfMissing) throw new Error(`找不到 ${begin} 段，拒绝改写`)
  const block = `${insertPrefix}${body}`
  if (anchor) {
    const at = text.indexOf(anchor)
    if (at >= 0) return `${text.slice(0, at)}\n${block}\n${text.slice(at)}`
  }
  if (!text.trim()) return `${block}\n`
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`
}

/** 只读：取出某一段的内容（剥掉首尾空白）。段不存在返回 error 而不是抛错。 */
export function readSection(file, { begin, end } = {}) {
  let raw
  try {
    raw = readTextNoBom(file).text
  } catch (err) {
    return { ok: false, body: '', error: String(err?.message ?? err) }
  }
  const i = raw.indexOf(begin)
  const j = raw.indexOf(end)
  if (i < 0 || j < 0 || j < i) return { ok: false, body: '', error: `找不到 ${begin} 段` }
  return { ok: true, body: raw.slice(i + begin.length, j).trim(), bom: readTextNoBom(file).bom }
}

/**
 * 带 fs 的安全改写。返回 `{ ok, changed, error?, bomStripped? }`，**不抛错**。
 *
 * @param {string} file
 * @param {{begin:string,end:string,body:string,anchor?:string,insertPrefix?:string,
 *          insertIfMissing?:boolean,backup?:boolean,validate?:(next:string)=>string|void}} opts
 *        `validate` 返回非空字符串即视为校验失败，放弃写入。
 */
export function spliceSection(file, {
  begin, end, body, anchor = '', insertPrefix = '', insertIfMissing = true,
  backup = true, validate,
} = {}) {
  const existed = existsSync(file)
  let raw = ''
  let bomStripped = false
  if (existed) {
    try {
      const r = readTextNoBom(file)
      raw = r.text
      bomStripped = r.bom
    } catch (err) {
      return { ok: false, changed: false, error: `读取失败：${err?.message ?? err}` }
    }
  }

  let next
  try {
    next = spliceSectionText(raw, { begin, end, body, anchor, insertPrefix, insertIfMissing })
  } catch (err) {
    return { ok: false, changed: false, error: String(err?.message ?? err) }
  }

  if (typeof validate === 'function') {
    const bad = validate(next)
    if (bad) return { ok: false, changed: false, error: String(bad) }
  }

  if (existed && next === raw) return { ok: true, changed: false, bomStripped }

  if (existed && backup) {
    try {
      copyFileSync(file, `${file}.bak`)   // 滚动覆盖，只留一份
    } catch { /* 备份失败不阻断改写，但调用方能从日志看出异常 */ }
  }

  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, next, 'utf8')      // Node 写 UTF-8，天然不带 BOM
    const bytes = readFileSync(tmp)
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error('临时文件被写成了 BOM，拒绝替换')
    }
    if (readFileSync(tmp, 'utf8') !== next) throw new Error('临时文件读回与预期不一致，拒绝替换')
    // Windows 上目标文件可能正被别的进程读着，rename 偶发 EPERM/EBUSY → 短暂重试
    let lastErr
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        renameSync(tmp, file)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        const until = Date.now() + 60
        while (Date.now() < until) { /* 忙等 ~60ms，无依赖 */ }
      }
    }
    if (lastErr) throw lastErr
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败无所谓 */ }
    return { ok: false, changed: false, error: String(err?.message ?? err) }
  }

  return { ok: true, changed: true, bomStripped, chars: next.length }
}
