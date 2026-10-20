#!/usr/bin/env node
/**
 * 小鲸鱼 · API 密钥（DeepSeek）读写
 *
 * 密钥存在 DSH 自己的凭据文件里 —— 但**不是真的 `~/.dsh`**，而是隔离 home：
 *
 *     <项目目录>\.dsh-home\.credentials.yaml
 *
 *   version: 1
 *   records:      ← 账号设备/cookie 那些，本模块碰都不碰
 *     …
 *   refs:
 *     DEEPSEEK_API_KEY: sk-…      ← 本模块只管这一行
 *
 * 为什么用这个文件（而不是别的地方）：`@deepseek-ai/dsh-credentials-local` 的解析顺序是
 *   继承来的进程环境（只读，**优先级最高**）
 *   > $DSH_HOME/.credentials.yaml（可写，就是本文件）
 *   > <cwd>/.env / $DSH_HOME/.env（只读兜底）
 * 所以写这里就是「官方路径」——和 DSH 网页版 Models 页写的是同一个位置。
 * 代价是**环境变量会盖过它**；因此 childEnvFor() 在文件里有密钥时会把继承来的
 * DEEPSEEK_API_KEY 从子进程环境里删掉，保证「界面上填的那把」永远说话算数（R2：只动 .dsh-home）。
 *
 * 写文件的方式：**只做面向行的定点编辑**（保住 records 段与注释原样），先备份、写临时文件再
 * rename（原子替换），写完立刻回读校验。绝不用 PowerShell 读改写（会把 UTF-8 当 GBK 解坏）。
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 默认凭据引用名，与 profile 里 `dsh-llm-deepseek-api-key` 的 `apiKeyEnv` 一致。 */
export const DEFAULT_REF = 'DEEPSEEK_API_KEY'
/** 接口地址的环境变量名（`dsh-llm-deepseek` 读它做 baseURL 兜底）。 */
export const DEFAULT_BASE_ENV = 'DEEPSEEK_BASE_URL'
/** DeepSeek 官方默认端点（注意是 anthropic 协议那份）。 */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com/anthropic'

export const credentialsPath = (home) => path.join(home, '.credentials.yaml')
export const realCredentialsPath = (userHome) => path.join(userHome ?? '', '.dsh', '.credentials.yaml')

/** 掩码：只露头 6 尾 4，中间固定长度，不泄露长度信息。 */
export function maskKey(key) {
  const s = String(key ?? '')
  if (!s) return ''
  if (s.length <= 12) return `${s.slice(0, 3)}${'*'.repeat(6)}`
  return `${s.slice(0, 6)}${'*'.repeat(12)}${s.slice(-4)}`
}

/** 校验用户输入的密钥，返回洗净后的值。 */
export function validateKey(raw) {
  const s = String(raw ?? '').trim()
  if (!s) throw new Error('密钥不能为空')
  if (s.length < 8) throw new Error('密钥太短了（至少 8 个字符）')
  if (s.length > 512) throw new Error('密钥太长了（最多 512 个字符）')
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) throw new Error('密钥里不能有空格、换行或控制字符')
  return s
}

/** 去掉行尾注释与引号，还原一个 YAML 标量。 */
function parseScalar(raw) {
  const v = String(raw ?? '').trim()
  if (v.length === 0) return ''
  if (v.startsWith('"')) { try { return JSON.parse(v) } catch { return v.slice(1, -1) } }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'")
  return v.replace(/\s+#.*$/, '').trim()
}

/** 渲染一个 YAML 标量：安全字符直接裸写，否则用 JSON 双引号形式（JSON 标量是 YAML 1.2 的子集）。 */
function renderScalar(v) {
  const s = String(v)
  return /^[A-Za-z0-9][A-Za-z0-9._/@+=-]*$/.test(s) ? s : JSON.stringify(s)
}

/** 读 `refs:` 段（只解析这一段，records 原样不动）。 */
function parseRefs(text) {
  const refs = new Map()
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex((l) => /^refs\s*:/.test(l))
  if (start < 0) return refs
  const inline = /^refs\s*:\s*\{(.*)\}\s*$/.exec(lines[start])
  if (inline) {
    for (const part of inline[1].split(',')) {
      const i = part.indexOf(':')
      if (i > 0) refs.set(part.slice(0, i).trim(), parseScalar(part.slice(i + 1)))
    }
    return refs
  }
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]
    if (l.trim() === '') continue
    if (!/^\s/.test(l)) break                     // 顶格 → 这一段结束
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(l)
    if (m) refs.set(m[1], parseScalar(m[2]))
  }
  return refs
}

/** 读凭据文件：永远不抛，坏文件把错误带回来让界面显示。 */
export function readCredentials(file) {
  const out = { exists: false, text: '', refs: new Map(), error: '' }
  try {
    out.exists = existsSync(file)
    if (!out.exists) return out
    out.text = readFileSync(file, 'utf8')
  } catch (err) {
    out.error = String(err?.message ?? err)
    return out
  }
  try {
    if (/^version\s*:\s*1\s*$/m.test(out.text) === false && out.text.trim() !== '') {
      out.error = '凭据文件缺 `version: 1`，DSH 会拒绝加载它'
    }
    out.refs = parseRefs(out.text)
  } catch (err) {
    out.error = String(err?.message ?? err)
  }
  return out
}

/** 生成「写入/删除一个 ref 之后」的完整文件文本（纯函数，方便测）。 */
export function patchRefText(text, ref, value) {
  const body = String(text ?? '').replace(/\n+$/, '')
  const lines = body.length ? body.split('\n') : []
  const remove = value === undefined || value === null

  if (lines.length === 0) {
    if (remove) return 'version: 1\nrefs:\n'
    return `version: 1\nrefs:\n  ${ref}: ${renderScalar(value)}\n`
  }
  if (!lines.some((l) => /^version\s*:/.test(l))) lines.unshift('version: 1')

  const start = lines.findIndex((l) => /^refs\s*:\s*$/.test(l) || /^refs\s*:\s*\{\s*\}\s*$/.test(l))
  if (start < 0) {
    if (remove) return `${lines.join('\n')}\n`
    if (lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push('refs:', `  ${ref}: ${renderScalar(value)}`)
    return `${lines.join('\n')}\n`
  }

  lines[start] = 'refs:'
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1

  const re = new RegExp(`^\\s+${ref}\\s*:`)
  const at = lines.findIndex((l, i) => i > start && i < end && re.test(l))
  if (at >= 0) {
    if (remove) lines.splice(at, 1)
    else lines[at] = `  ${ref}: ${renderScalar(value)}`
  } else if (!remove) {
    lines.splice(start + 1, 0, `  ${ref}: ${renderScalar(value)}`)
  }
  return `${lines.join('\n')}\n`
}

/** 备份 + 原子落盘 + 回读校验。 */
function commit(file, before, text, backupFile) {
  let backup = ''
  if (backupFile && before && before !== text) {
    try {
      writeFileSync(backupFile, before, { encoding: 'utf8', mode: 0o600 })
      backup = path.basename(backupFile)
    } catch { /* 备份失败不挡写入 */ }
  }
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })   // Node 写 UTF-8，无 BOM
  renameSync(tmp, file)
  const back = readCredentials(file)
  if (back.error) throw new Error(`写入后回读失败：${back.error}`)
  return { bytes: Buffer.byteLength(text, 'utf8'), backup, refs: back.refs.size }
}

/** 写入/覆盖一个 ref。 */
export function setRef(file, ref, rawValue, { backupFile = '' } = {}) {
  const value = validateKey(rawValue)
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const text = patchRefText(before, ref, value)
  const r = commit(file, before, text, backupFile)
  const after = readCredentials(file)
  if (after.refs.get(ref) !== value) throw new Error('写入后校验失败：文件里的值和刚存的不一致')
  return r
}

/** 删除一个 ref（清空即恢复成「没有这一项」，DSH 的语法不允许空值）。 */
export function unsetRef(file, ref, { backupFile = '' } = {}) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!before) return { bytes: 0, backup: '', refs: 0 }
  const text = patchRefText(before, ref, undefined)
  const r = commit(file, before, text, backupFile)
  const after = readCredentials(file)
  if (after.refs.has(ref)) throw new Error('清除后校验失败：文件里还留着这一项')
  return r
}

/** 当前密钥状态（含「真正的 ~/.dsh 里有没有」这一项，用于「恢复默认」按钮）。 */
export function keyStatus({
  home, refName = DEFAULT_REF, envKey = process.env[refName], userHome = process.env.USERPROFILE,
} = {}) {
  const file = credentialsPath(home)
  const { refs, error, exists } = readCredentials(file)
  const fileKey = refs.get(refName) ?? ''
  const env = String(envKey ?? '').trim()
  const effective = fileKey || env
  let mtime = ''
  try { mtime = statSync(file).mtime.toISOString() } catch { /* 文件不存在 */ }
  const official = readCredentials(realCredentialsPath(userHome))
  return {
    refName,
    file,
    exists,
    error,
    fileKey,
    masked: maskKey(effective),
    configured: Boolean(effective),
    source: fileKey ? 'file' : (env ? 'env' : 'none'),
    envKeySet: Boolean(env),
    /** 环境里有、文件里也有：文件优先（childEnvFor 会把环境那份删掉）。 */
    envShadowed: Boolean(env && fileKey),
    mtime,
    officialFile: realCredentialsPath(userHome),
    officialHasKey: Boolean(official.refs.get(refName)),
  }
}

/**
 * 给子进程用的环境：保证「界面里填的那把」说话算数。
 * ① 文件里有密钥 → 把继承来的同名变量删掉（否则它按文档优先级会盖过文件）；
 * ② 配了自定义接口地址 → 以 DEEPSEEK_BASE_URL 传下去。
 * 文件里没有密钥时**不动**环境变量，方便你用 `$env:DEEPSEEK_API_KEY` 临时顶一下。
 */
export function childEnvFor({
  home, baseUrl = '', env = process.env, refName = DEFAULT_REF, baseEnv = DEFAULT_BASE_ENV,
} = {}) {
  const out = { ...env, DSH_HOME: home }
  let fileKey = ''
  try { fileKey = readCredentials(credentialsPath(home)).refs.get(refName) ?? '' } catch { /* 读不到就算没有 */ }
  if (fileKey) delete out[refName]
  const b = String(baseUrl ?? '').trim()
  if (b) out[baseEnv] = b
  return out
}

/** 把真正的 `~/.dsh` 里那把密钥读出来（只读，用来「恢复默认」）。 */
export function readOfficialKey(userHome = process.env.USERPROFILE, refName = DEFAULT_REF) {
  const file = realCredentialsPath(userHome)
  const { refs, error } = readCredentials(file)
  const k = refs.get(refName) ?? ''
  if (!k) throw new Error(error ? `读不到 ${file}：${error}` : `${file} 里没有 ${refName}`)
  return k
}
