#!/usr/bin/env node
/**
 * 小鲸鱼 · 本机 Web 管理台（方案 dsh-bot-plan.md §4 D-2）
 *
 *   - 由 bridge.mjs 在**自己进程内**启动（import { startAdmin }），不是独立服务；
 *   - 也可以单独跑：node src\admin.mjs（只读模式，用来验证界面）；
 *   - 零依赖：只用 node:http / node:fs，前端是 src\web\index.html 单文件。
 *
 * 三条硬约束（方案 §4 D-2）
 *   1. **只绑 127.0.0.1**，本机浏览器用；
 *   2. **http 起不来不许影响聊天**：listen 失败只记日志返回 null，handler 全包 try/catch；
 *   3. 启动生成随机 token 写 state\admin-token.txt（0600）并打印到控制台；
 *      URL 必须带 ?t=<token>（首次访问后种 Cookie）；
 *      写操作还要校验 Origin 必须是本机这个端口 —— 防浏览器里任意网页 POST 过来把机器人停掉。
 *
 * R2：所有文件读写都用**本文件里硬编码的路径常量**拼出来，日志文件名的外部输入一律 path.basename 洗净，
 *     绝不接受请求里传来的绝对路径。
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import {
  DEFAULT_REF, PUBLIC_BASE_URL, keyStatus, maskKey, readOfficialKey, setRef, unsetRef,
} from './apikey.mjs'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.dirname(SRC_DIR)

const MEM_START = '<!-- MEMORY:BEGIN -->'
const MEM_END = '<!-- MEMORY:END -->'
const AFFINITY_LEVELS = [[30, '还不太熟'], [50, '有点熟了'], [70, '熟'], [85, '亲近'], [101, '特别亲近']]

/** 带 HTTP 状态码的错误：校验类问题一律 400/404/413，别再当成 500 服务端崩溃。 */
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

/**
 * 把底层模块（apikey.mjs 等）抛出的**普通 Error** 也归到 400。
 * 那些 Error 都是「你给的东西不对」，不是服务端崩了 —— 直接冒到顶层会变成 500，界面只会说「服务器错误」。
 */
const asBad = (fn) => {
  try { return fn() } catch (e) {
    if (e && Number(e.status)) throw e
    throw bad(e?.message ?? String(e))
  }
}

/** 读请求体（上限 1 MiB）。 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(bad('请求体过大', 413)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startAdmin(opts = {}) {
  const ROOT = opts.root ?? ROOT_DIR
  const HOME = opts.home ?? path.join(ROOT, '.dsh-home')
  const STATE = path.join(ROOT, 'state')
  const LOGS = path.join(ROOT, 'logs')
  const MEMORY = path.join(ROOT, 'memory')
  const DAILY = path.join(MEMORY, 'daily')
  const WEB = path.join(ROOT, 'src', 'web')
  const AGENTS = path.join(ROOT, 'AGENTS.md')
  const LONGTERM = path.join(MEMORY, 'long-term.md')
  const AFF_FILE = path.join(STATE, 'affinity.json')
  const CFG_FILE = path.join(ROOT, 'config.json')
  const TOKEN_FILE = path.join(STATE, 'admin-token.txt')
  const DISTILL = path.join(ROOT, 'src', 'distill.mjs')
  /** 模型密钥就写在这个文件的 `refs:` 段里（隔离 home，绝不碰真的 ~/.dsh）。 */
  const CRED_FILE = path.join(HOME, '.credentials.yaml')
  const CRED_BAK = path.join(STATE, 'credentials.bak.yaml')

  const cfg = opts.cfg ?? {}
  const host = String(cfg.admin?.host ?? '127.0.0.1')
  const port = Number(cfg.admin?.port ?? 8787)
  /** 真正绑上的端口（配 0 时由系统分配）；Origin 校验和返回的 URL 都用它。 */
  let boundPort = port
  const log = opts.log ?? ((kind, data = {}) => console.log(`[admin] ${kind} ${JSON.stringify(data)}`))
  const getStatus = opts.getStatus ?? (() => ({}))
  const getPaused = opts.getPaused ?? (() => false)
  const actions = opts.actions ?? {}
  const standalone = opts.standalone === true

  // ------------------------------------------------------------------ token

  function loadToken() {
    try {
      const t = readFileSync(TOKEN_FILE, 'utf8').trim()
      if (/^[0-9a-f]{32,}$/.test(t)) return t
    } catch { /* 首次 */ }
    const t = randomBytes(24).toString('hex')
    writeFileSync(TOKEN_FILE, `${t}\n`, { encoding: 'utf8', mode: 0o600 })
    return t
  }
  const TOKEN = loadToken()

  // ------------------------------------------------------------- 读本地数据

  const readText = (file, def = '') => { try { return readFileSync(file, 'utf8') } catch { return def } }
  const readJson = (file, def = {}) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return def } }

  function levelWord(v) { return (AFFINITY_LEVELS.find(([ceil]) => v < ceil) ?? [0, '熟'])[1] }

  function affinityView() {
    const o = readJson(AFF_FILE, {})
    const base = Number.isFinite(o?.base) ? o.base : 50
    const history = Array.isArray(o?.history) ? o.history : []
    const value = Number.isFinite(o?.value) ? o.value : base
    return { base, value, level: levelWord(value), history: history.slice(-60).reverse(), updatedAt: o?.updatedAt ?? '' }
  }

  function factsView() {
    const out = []
    for (const line of readText(LONGTERM).split('\n')) {
      const m = /^-\s*(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+)$/.exec(line.trim())
      if (m) out.push({ date: m[1] ?? '', text: m[2].trim() })
    }
    return out
  }

  function dailiesView() {
    if (!existsSync(DAILY)) return []
    return readdirSync(DAILY)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort().reverse()
      .map((n) => {
        const text = readText(path.join(DAILY, n))
        const note = (/^#.*\n+([\s\S]*?)\n+##\s/.exec(text)?.[1] ?? '').trim()
        return { date: n.slice(0, 10), note, bytes: text.length }
      })
  }

  function memoryBlockView() {
    const raw = readText(AGENTS)
    const i = raw.indexOf(MEM_START)
    const j = raw.indexOf(MEM_END)
    if (i < 0 || j < 0) return ''
    return raw.slice(i + MEM_START.length, j)
  }

  function listLogFiles() {
    try {
      return readdirSync(LOGS)
        .filter((n) => /\.(jsonl|txt|html)$/.test(n))
        .map((n) => {
          const st = statSync(path.join(LOGS, n))
          return { name: n, size: st.size, mtime: st.mtime.toISOString() }
        })
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    } catch { return [] }
  }

  /** 日志文件尾部若干行。文件名一律 basename 洗净（R2）。 */
  function tailLog(name, tail = 200) {
    const safe = path.basename(String(name || ''))
    if (!safe || !/\.(jsonl|txt|html)$/.test(safe)) throw bad('文件名不合法')
    const file = path.join(LOGS, safe)
    if (!existsSync(file)) throw bad(`没有这个日志文件：${safe}`, 404)
    const lines = readText(file).split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return { name: safe, total: lines.length, lines: lines.slice(-Math.max(1, Math.min(2000, tail))) }
  }

  /** 把 logs\bridge-<date>.jsonl 还原成对话回合。 */
  function transcript(date) {
    const safe = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : ''
    const file = path.join(LOGS, `bridge-${safe}.jsonl`)
    if (!safe || !existsSync(file)) return { date: safe, turns: [], notes: [] }
    const turns = []
    const notes = []
    let pending = null
    for (const line of readText(file).split('\n')) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.kind === 'inbound') {
        pending = { ts: e.ts, text: String(e.text ?? ''), userId: e.userId ?? '' }
      } else if (e.kind === 'reply_sent' && pending) {
        turns.push({ user: pending.text, bot: String(e.text ?? ''), at: pending.ts, replyAt: e.ts })
        pending = null
      } else if (e.kind === 'session_created' || e.kind === 'logout' || e.kind === 'reply_fallback'
        || e.kind === 'session_invalidated' || e.kind === 'respond_error' || e.kind === 'distill_spawned'
        || e.kind === 'user_command' || e.kind === 'skipped_paused') {
        notes.push({ kind: e.kind, at: e.ts, detail: e.reason ?? e.note ?? e.date ?? e.sessionId ?? e.error ?? e.text ?? '' })
      }
    }
    return { date: safe, turns, notes, pending: pending?.text ?? '' }
  }

  function statusView() {
    const bridge = getStatus() ?? {}
    const aff = affinityView()
    const usage = bridge.usage ?? {}
    const budget = Number(cfg.guard?.dailyTokenBudget ?? 0)
    const used = Number(usage.totalTokens ?? 0)
    return {
      now: new Date().toISOString(),
      paused: getPaused(),
      uptimeSec: bridge.startedAt ? Math.round((Date.now() - Date.parse(bridge.startedAt)) / 1000) : 0,
      admin: { host, port, standalone },
      bridge,
      usage,
      budget: { daily: budget, used, pct: budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0 },
      affinity: { value: aff.value, level: aff.level },
      memory: {
        facts: factsView().length,
        dailies: dailiesView().length,
        memoryChars: memoryBlockView().length,
        longTermBytes: readText(LONGTERM).length,
      },
      footprint: { logs: listLogFiles().length, qrPage: existsSync(path.join(LOGS, 'qr.html')) },
    }
  }

  // ------------------------------------------------------------------ 写操作

  /** 调 distill.mjs 干重活（重建记忆段 / 蒸馏某天），fire-and-forget。 */
  function runDistill(args) {
    if (standalone) throw bad('只读模式不能执行这个动作', 403)
    const child = spawn(process.execPath, [DISTILL, ...args], {
      cwd: ROOT, env: { ...process.env }, detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    return child.pid
  }

  function saveConfigText(text) {
    let parsed
    try { parsed = JSON.parse(text) } catch (err) { throw bad(`不是合法 JSON：${String(err?.message ?? err)}`) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('顶层必须是一个 JSON 对象')
    const bak = path.join(STATE, `config.bak-${Date.now()}.json`)
    if (existsSync(CFG_FILE)) copyFileSync(CFG_FILE, bak)
    writeFileSync(CFG_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')   // Node 写 UTF-8，无 BOM
    log('config_saved', { backup: path.basename(bak), bytes: text.length })
    return { backup: path.basename(bak) }
  }

  // ------------------------------------------------------------------ API 密钥

  /**
   * 界面要看到的密钥状态。
   * 注意这里**只回掩码**，明文永远不出后端（除了用户自己刚输入的那一次，也不回显）。
   */
  function apiKeyView() {
    const st = keyStatus({ home: HOME, envKey: process.env[DEFAULT_REF] })
    return {
      refName: DEFAULT_REF,
      file: st.file,
      exists: st.exists,
      error: st.error,
      masked: st.masked,
      configured: st.configured,
      source: st.source,
      envKeySet: st.envKeySet,
      envShadowed: st.envShadowed,
      mtime: st.mtime,
      officialFile: st.officialFile,
      officialHasKey: st.officialHasKey,
      backup: existsSync(CRED_BAK) ? path.basename(CRED_BAK) : '',
      baseUrl: String(cfg.api?.baseUrl ?? ''),
      baseUrlEnv: 'DEEPSEEK_BASE_URL',
      publicBaseUrl: PUBLIC_BASE_URL,
      effectiveNow: '每条消息都会起一个新的 headless 进程，所以改完**下一条消息就生效**，不用重启',
    }
  }

  function saveApiKey(raw) {
    const r = asBad(() => setRef(CRED_FILE, DEFAULT_REF, raw, { backupFile: CRED_BAK }))
    log('apikey_saved', { masked: maskKey(String(raw).trim()), bytes: r.bytes, backup: r.backup })
    return r
  }

  function clearApiKey() {
    const r = asBad(() => unsetRef(CRED_FILE, DEFAULT_REF, { backupFile: CRED_BAK }))
    log('apikey_cleared', { backup: r.backup })
    return r
  }

  function restoreApiKey() {
    const k = asBad(() => readOfficialKey())
    const r = asBad(() => setRef(CRED_FILE, DEFAULT_REF, k, { backupFile: CRED_BAK }))
    log('apikey_restored', { masked: maskKey(k) })
    return r
  }

  /** 改接口地址要写 config.json 并重启 —— bridge 只在启动时读一次 cfg。 */
  function saveBaseUrl(raw) {
    const url = String(raw ?? '').trim()
    if (url && !/^https?:\/\//i.test(url)) throw bad('接口地址要以 http:// 或 https:// 开头')
    if (url.length > 300) throw bad('接口地址太长了')
    let o
    try { o = JSON.parse(readText(CFG_FILE, '{}')) } catch { throw bad('config.json 不是合法 JSON，先把它修好') }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('config.json 顶层必须是对象')
    o.api = { ...(o.api ?? {}), baseUrl: url }
    const bak = path.join(STATE, `config.bak-${Date.now()}.json`)
    if (existsSync(CFG_FILE)) copyFileSync(CFG_FILE, bak)
    writeFileSync(CFG_FILE, `${JSON.stringify(o, null, 2)}\n`, 'utf8')   // Node 写 UTF-8，无 BOM
    log('api_baseurl_saved', { baseUrl: url, backup: path.basename(bak) })
    return { backup: path.basename(bak), baseUrl: url }
  }

  const ensureTrailing = (t) => (t.endsWith('\n') ? t : `${t}\n`)

  function saveLongTerm(text) {
    if (typeof text !== 'string') throw bad('内容必须是字符串')
    if (text.length > 200000) throw bad('太长了')
    const lines = text.split('\n').filter((l) => /^\s*-\s*\S/.test(l) || /^#/.test(l) || l.trim() === '' || l.trim().startsWith('<!--'))
    if (!lines.length) throw bad('内容看起来不是事实列表（每行以 "- " 开头）')
    writeFileSync(LONGTERM, ensureTrailing(text), 'utf8')
    log('longterm_saved', { bytes: text.length })
  }

  function saveDailyFile(date, text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw bad('日期不合法')
    if (typeof text !== 'string' || text.length > 200000) throw bad('内容不合法')
    writeFileSync(path.join(DAILY, `${date}.md`), ensureTrailing(text), 'utf8')
    log('daily_saved', { date, bytes: text.length })
  }

  function saveAffinityBase(base) {
    const b = Number(base)
    if (!Number.isFinite(b) || b < 0 || b > 100) throw bad('基准值要在 0~100 之间')
    const o = readJson(AFF_FILE, { base: b, value: b, history: [] })
    const history = Array.isArray(o.history) ? o.history : []
    const value = Math.max(0, Math.min(100, Math.round(b + history.reduce((a, h) => a + (Number(h.delta) || 0), 0))))
    writeFileSync(AFF_FILE, JSON.stringify({ base: b, value, updatedAt: new Date().toISOString(), history }, null, 2), 'utf8')
    log('affinity_base_saved', { base: b, value })
  }

  /** 清空某一天：删日记、删当天事实、删当天好感度条目，然后重建记忆段。 */
  function clearDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw bad('日期不合法')
    const daily = path.join(DAILY, `${date}.md`)
    if (existsSync(daily)) rmSync(daily, { force: true })
    const kept = readText(LONGTERM).split('\n').filter((l) => !l.trim().startsWith(`- [${date}]`))
    writeFileSync(LONGTERM, ensureTrailing(kept.join('\n')), 'utf8')
    const o = readJson(AFF_FILE, {})
    if (Array.isArray(o?.history)) {
      o.history = o.history.filter((h) => h.date !== date)
      o.value = Math.max(0, Math.min(100, Math.round((Number(o.base) || 50) + o.history.reduce((a, h) => a + (Number(h.delta) || 0), 0))))
      o.updatedAt = new Date().toISOString()
      writeFileSync(AFF_FILE, JSON.stringify(o, null, 2), 'utf8')
    }
    runDistill(['--rebuild-memory'])
    log('clear_day', { date })
  }

  // ------------------------------------------------------------------ 路由

  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'cache-control': 'no-store', ...headers })
    res.end(body)
  }
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' })
  const fail = (res, code, err) => json(res, code, { ok: false, error: String(err?.message ?? err) })

  function parseCookie(header) {
    const out = {}
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=')
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    return out
  }
  const authed = (req, url) => {
    if (url.searchParams.get('t') === TOKEN) return true
    if (req.headers['x-admin-token'] === TOKEN) return true
    return parseCookie(req.headers.cookie).kt === TOKEN
  }
  /** 写操作：浏览器来的请求必须同源（防 CSRF）；没有 Origin 的（curl）放行，因为它们已经过了 token。 */
  const originOk = (req) => {
    const o = req.headers.origin
    if (!o) return true
    return o === `http://${host}:${boundPort}` || o === `http://127.0.0.1:${boundPort}` || o === `http://localhost:${boundPort}`
  }

  const HANDLERS = {
    'GET /api/status': (req, res) => json(res, 200, { ok: true, ...statusView() }),

    'GET /api/config': (req, res) => {
      const text = readText(CFG_FILE, '{}')
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* 让前端显示原始文本 */ }
      return json(res, 200, { ok: true, text, config: parsed, file: CFG_FILE })
    },

    'POST /api/config': async (req, res) => {
      const body = JSON.parse(await readBody(req) || '{}')
      const r = saveConfigText(String(body.text ?? ''))
      json(res, 200, { ok: true, ...r, restarting: !!actions.restart })
      if (actions.restart) setTimeout(() => actions.restart('config-saved'), 600)
    },

    'GET /api/memory': (req, res, url) => {
      const date = url.searchParams.get('date') ?? ''
      const dailyFile = /^\d{4}-\d{2}-\d{2}$/.test(date) ? readText(path.join(DAILY, `${date}.md`)) : ''
      json(res, 200, {
        ok: true,
        affinity: affinityView(),
        facts: factsView(),
        dailies: dailiesView(),
        longTermText: readText(LONGTERM),
        dailyFile: { date, text: dailyFile },
        memoryBlock: memoryBlockView(),
      })
    },

    'POST /api/memory': async (req, res) => {
      const body = JSON.parse(await readBody(req) || '{}')
      const done = []
      if (typeof body.longTermText === 'string') { saveLongTerm(body.longTermText); done.push('长期事实已保存') }
      if (body.dailyFile && typeof body.dailyFile.text === 'string') {
        saveDailyFile(body.dailyFile.date, body.dailyFile.text); done.push(`${body.dailyFile.date} 的日记已保存`)
      }
      if (body.affinityBase !== undefined) { saveAffinityBase(body.affinityBase); done.push('好感度基准已保存') }
      if (done.length) { runDistill(['--rebuild-memory']); done.push('记忆段已重建（机器人下一条消息就生效）') }
      json(res, 200, { ok: true, done })
    },

    'GET /api/transcript': (req, res, url) => json(res, 200, { ok: true, ...transcript(url.searchParams.get('date') ?? '') }),

    'GET /api/apikey': (req, res) => json(res, 200, { ok: true, ...apiKeyView() }),

    'POST /api/apikey': async (req, res) => {
      if (standalone) throw bad('只读模式不能改密钥', 403)
      const body = JSON.parse(await readBody(req) || '{}')
      const act = String(body.action ?? 'set')
      const done = []
      let restart = false
      if (act === 'set') {
        if (body.key === undefined) throw bad('没有收到密钥')
        saveApiKey(body.key)
        done.push('新密钥已写入（下一条消息就生效，不用重启）')
      } else if (act === 'clear') {
        clearApiKey()
        done.push('已清除；如果启动环境里有 DEEPSEEK_API_KEY，会退回去用它')
      } else if (act === 'restore') {
        restoreApiKey()
        done.push('已恢复成 ~/.dsh 里那把')
      } else if (act === 'base-url') {
        const r = saveBaseUrl(body.baseUrl)
        done.push(r.baseUrl ? '接口地址已保存，正在重启（约 3 秒）' : '已改回官方地址，正在重启（约 3 秒）')
        restart = true
      } else {
        throw bad(`未知操作：${act}`)
      }
      json(res, 200, { ok: true, done, ...apiKeyView() })
      if (restart && actions.restart) setTimeout(() => actions.restart('api-base-url'), 600)
    },

    'GET /api/logs': (req, res) => json(res, 200, { ok: true, files: listLogFiles() }),

    'GET /api/log': (req, res, url) => {
      const r = tailLog(url.searchParams.get('name'), Number(url.searchParams.get('tail') ?? 200))
      json(res, 200, { ok: true, ...r })
    },

    'POST /api/action': async (req, res) => {
      const body = JSON.parse(await readBody(req) || '{}')
      const action = String(body.action ?? '')
      const arg = body.arg ?? ''
      if (standalone && action !== 'noop') throw bad('只读模式不能执行动作', 403)
      switch (action) {
        case 'restart':
          json(res, 200, { ok: true, note: '正在重启（约 3 秒后回来）' })
          setTimeout(() => actions.restart?.('admin'), 400)
          return
        case 'quit':
          json(res, 200, { ok: true, note: '正在停止（start.cmd 的守护循环也会一起退出）' })
          setTimeout(() => actions.quit?.('admin'), 400)
          return
        case 'pause': actions.setPaused?.(true); return json(res, 200, { ok: true, note: '已暂停回复' })
        case 'resume': actions.setPaused?.(false); return json(res, 200, { ok: true, note: '已恢复回复' })
        case 'new-session': actions.newSession?.(); return json(res, 200, { ok: true, note: '下次消息会开一个新会话' })
        case 'distill': return json(res, 200, { ok: true, pid: runDistill(arg ? [String(arg)] : []), note: '蒸馏已在后台开始（看 logs\\distill.jsonl）' })
        case 'rebuild-memory': return json(res, 200, { ok: true, pid: runDistill(['--rebuild-memory']), note: '记忆段重建中' })
        case 'test-key': {
          if (!actions.testKey) throw bad('只读模式不能测密钥', 403)
          const result = await actions.testKey()
          log('apikey_tested', { exitCode: result.exitCode, elapsedMs: result.elapsedMs })
          return json(res, 200, {
            ok: true,
            result,
            note: result.exitCode === 0
              ? `密钥可用（${(result.elapsedMs / 1000).toFixed(1)} 秒）`
              : '密钥不可用或调用失败，看下面的报错',
          })
        }
        case 'clear-day': clearDay(String(arg)); return json(res, 200, { ok: true, note: `${arg} 已清空` })
        default: return json(res, 400, { ok: false, error: `未知动作：${action}` })
      }
    },
  }

  // ------------------------------------------------------------------ 服务器

  const server = createServer(async (req, res) => {
    let url
    try { url = new URL(req.url, `http://${host}:${boundPort}`) } catch { return send(res, 400, 'bad url') }
    try {
      const p = url.pathname
      if (!authed(req, url)) {
        return send(res, 401, '需要管理台 token：请用控制台打印出来的 http://127.0.0.1:' + boundPort + '/?t=<token> 打开', { 'content-type': 'text/plain; charset=utf-8' })
      }
      if (p === '/qr') {
        const f = path.join(LOGS, 'qr.html')
        if (!existsSync(f)) return send(res, 404, '二维码页还没生成', { 'content-type': 'text/plain; charset=utf-8' })
        return send(res, 200, readText(f), { 'content-type': 'text/html; charset=utf-8' })
      }
      if (p === '/') {
        // 带 ?t= 首次访问：顺手种 Cookie（下次直接敲 / 也行），但页面当场就渲染，不靠 302
        const headers = { 'content-type': 'text/html; charset=utf-8' }
        if (url.searchParams.get('t') === TOKEN) headers['set-cookie'] = `kt=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`
        return send(res, 200, readText(path.join(WEB, 'index.html'), '<h1>找不到 src\\web\\index.html</h1>'), headers)
      }
      const key = `${req.method} ${p}`
      const h = HANDLERS[key]
      if (!h) return json(res, 404, { ok: false, error: `没有这个接口：${key}` })
      if (req.method !== 'GET' && !originOk(req)) return json(res, 403, { ok: false, error: 'Origin 不匹配，拒绝写操作' })
      await h(req, res, url)
    } catch (err) {
      const code = Number(err?.status) || 500
      log(code >= 500 ? 'handler_error' : 'bad_request', { url: req.url, method: req.method, error: String(err?.message ?? err) })
      try { fail(res, code, err) } catch { /* 已经发过响应 */ }
    }
  })

  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    server.once('error', (err) => {
      log('listen_failed', { host, port, error: String(err?.message ?? err), note: '管理台起不来，聊天不受影响' })
      console.error(`[管理台] 起不来（${host}:${port}）：${err?.message ?? err} —— 聊天不受影响，改 config.json 的 admin.port 换个端口。`)
      done(null)
    })
    server.listen(port, host, () => {
      boundPort = server.address()?.port ?? port
      const url = `http://${host}:${boundPort}/?t=${TOKEN}`
      log('listening', { host, port: boundPort })
      console.log('')
      console.log('  ┌─ 小鲸鱼管理台 ─────────────────────────────────────────')
      console.log(`  │  ${url}`)
      console.log('  │  （这个带 token 的地址只给本机用；token 存在 state\\admin-token.txt）')
      console.log('  └───────────────────────────────────────────────────────')
      console.log('')
      done({ server, url, port: boundPort, token: TOKEN, close: () => server.close() })
    })
  })
}

// --------------------------------------------------- 单独跑（只读，验证界面）

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const ROOT = ROOT_DIR
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8')) } catch { /* 默认 */ }
  let status = {}
  try { status = JSON.parse(readFileSync(path.join(ROOT, 'state', 'status.json'), 'utf8')) } catch { /* 无 */ }
  const r = await startAdmin({
    root: ROOT, cfg, standalone: true,
    getStatus: () => ({ ...status, note: '只读模式：进程状态是启动时的快照' }),
    getPaused: () => false,
  })
  if (r) console.log(`只读管理台：${r.url}`)
}
