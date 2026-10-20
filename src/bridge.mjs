#!/usr/bin/env node
// 小鲸鱼 · 微信桥接（方案 dsh-bot-plan.md §4 阶段 B）
//
// 职责（单向流水线）：
//   手机微信 → iLink 长轮询收消息 → 起一个 dsh headless 子进程（带当天的 --session-id）
//   → 解析 NDJSON 取 final → 分片发回微信
//
// 关键约束（全部来自阶段 A 的实测，不要"优化"掉）：
//   1. DSH_HOME 指向本目录下 .dsh-home，真 ~/.dsh 零写入。
//   2. DSH 沙箱下 node 的 child_process 不能用管道 stdio（spawn EPERM）
//      → 子进程输出写文件描述符，再用 readFileSync 读回来。
//   3. --session-id 沿用时 DSH 会比对已记录的 cwd，不一致直接拒绝 → cwd 固定为 ROOT。
//   4. 同一条会话不能有两个进程同时活着 → 所有 headless 调用串行化（一条 promise 链）。
//   5. 一天一个会话：跨天（或 --session-id 失效）时新建，旧会话留给 distill.mjs。
//   6. 阶段 D-2 的硬性约束 1：从现在起就写 status.json 和 logs/bridge-*.jsonl，
//      否则以后做 WebUI 要返工。

import { spawn } from 'node:child_process'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { IlinkApi, IlinkStore, IlinkChannel, fetchImage } from './lib/ilink.js'
import {
  extractStickerTags, listStickers, planStickerTags, resolveSticker, syncStickerSection,
} from './lib/sticker.mjs'
import { spliceSection } from './lib/sections.mjs'
import { parseReport, reportToText, itemToMessages, planDueAt, fetchCover, reportStamp, extractBvs, resolveB23, biliVideoBrief, videoTaskText, cookieFromCredential } from './lib/bili.mjs'
import { writeQrPage } from './lib/qr.js'
import { startAdmin } from './admin.mjs'
import { childEnvFor } from './apikey.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULTS = {
  dshBin: '',
  dshHome: '.dsh-home',
  cwd: '.',
  persona: '小鲸鱼',
  session: { dailyReset: true, timeZone: 'Asia/Shanghai' },
  reply: {
    maxChars: 1800, gapMs: 900, typing: true, typingRefreshMs: 5000, timeoutMs: 180000,
    // 气泡：把回复按换行拆成最多 maxBubbles 条独立消息发出去（像真人一句一句发），
    // 而不是一条长消息带换行。超过上限的行会并进最后一条。
    maxBubbles: 2, bubbleGapMs: 700,
    errorText: '咕嘟咕嘟……本鲸鱼刚才算晕了，你再说一遍好不好。',
    emptyText: '唔……本鲸鱼刚才走神了，没想出话来，你再说一次？',
    unsupportedText: '本鲸鱼只看得懂文字哦，图片和文件先饶了我吧。',
  },
  log: { keepDays: 30 },
  guard: { dailyTokenBudget: 300000, pauseWhenExceeded: false },
  admin: { enabled: true, host: '127.0.0.1', port: 8787 },
  // 表情包：模型在回复里写一行 [[表情:名字]]，bridge 剥掉这行、发完文字后补一张图。
  // maxTextChars：正文超过这个字数就丢弃标记（长回复 = 在讲正事，不是插科打诨的场合）。
  sticker: { enabled: true, dir: 'stickers', maxPerHour: 12, gapMs: 500, maxTextChars: 200 },
  // B站日报：dsh-bili-scroll 插件把报告写成 Markdown 放在它自己家目录的 out\ 下，我们只读。
  // outDir 留空 = 用插件默认的 <USERPROFILE>\.dsh\bili-duty\out；pushAt 形如 "21:30"，留空 = 随时可推。
  // 一次只推一条视频、一条消息（真人不会一口气甩六条），其余按 dueAt 散在空闲时段里。
  // maxPerPush：一份报告最多排几条进队列；maxPerTick：每个 tick 最多推几条（默认 1）。
  // idleMinutes：对方安静这么久之后才发（避免打断对话）；minDelayMin/maxDelayMin/gapMin：排队时的随机延迟。
  // withCover：发完补一张该视频的封面（失败不影响正文）。
  bili: {
    enabled: true, outDir: '', maxPerPush: 3, maxPerTick: 1,
    // 封面默认关：正文之后紧跟一张图是 -2 的高危形态，且封面失败不重试。
    // 想看封面用 /bili 手动查，别让它跟着自动推送一起发。
    withCover: false, pushAt: '', linkStyle: 'url',
    idleMinutes: 20, minDelayMin: 15, maxDelayMin: 240, gapMin: 20,
    sleepFrom: '', sleepTo: '',
    bubbleGapMs: 1500, keepKeys: 50,
  },
  // 发件人白名单：空数组 = 谁都能聊；填了 userId 就只回名单里的人（机主永远豁免）。
  // 非名单里的消息会记一条 ignored_not_allowed 日志，里面有 userId，方便复制进来。
  allowUsers: [],
}

// ------------------------------------------------------------------ 基础设施

function loadConfig() {
  const file = path.join(ROOT, 'config.json')
  let user = {}
  try { user = JSON.parse(readFileSync(file, 'utf8')) } catch { user = {} }
  const pick = (k) => ({ ...DEFAULTS[k], ...(user[k] && typeof user[k] === 'object' ? user[k] : {}) })
  return {
    ...DEFAULTS, ...user,
    session: pick('session'),
    reply: pick('reply'),
    log: pick('log'),
    guard: pick('guard'),
    admin: pick('admin'),
    sticker: pick('sticker'),
    bili: pick('bili'),
  }
}

const cfg = loadConfig()
const HOME = path.isAbsolute(cfg.dshHome) ? cfg.dshHome : path.join(ROOT, cfg.dshHome)
const CWD = path.resolve(ROOT, cfg.cwd)
const STATE = path.join(ROOT, 'state')
const LOGS = path.join(ROOT, 'logs')
// 入站图片落盘目录（R2：这是唯一允许写图片的地方）
const ATTACH = path.join(ROOT, 'attachments')
// 表情包目录（用户往里丢图片，文件名就是语义标签）
const STICKERS = path.isAbsolute(cfg.sticker.dir) ? cfg.sticker.dir : path.join(ROOT, cfg.sticker.dir)
// B站日报：dsh-bili-scroll 的报告目录（我们只读）+ 自己的队列/已推账本
const BILI_OUT = cfg.bili.outDir
  ? (path.isAbsolute(cfg.bili.outDir) ? cfg.bili.outDir : path.join(ROOT, cfg.bili.outDir))
  : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'bili-duty', 'out')
const BILI_QUEUE = path.join(STATE, 'bili-queue.json')
const BILI_SENT = path.join(STATE, 'bili-sent.json')
// 推给机主的视频记在这里 —— 下次他回话时要把「那是我发的」放进她的上下文，
// 否则她根本不知道那条视频是什么（她只负责发，没读过报告）。
const BILI_RECENT = path.join(STATE, 'bili-recent.json')
const DSH_BIN = cfg.dshBin
  || path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// 一个微信用户一条会话：state\users\<key>\session.json（key = sha256(userId) 前 12 位）
const USERS = path.join(STATE, 'users')
const USERS_INDEX = path.join(USERS, 'index.json')
const LEGACY_SESSION = path.join(STATE, 'session.json')
// 客人（非机主）用独立 cwd，这样加载的是不带机主记忆的 guests\AGENTS.md
const GUESTS = path.join(ROOT, 'guests')
const GUESTS_AGENTS = path.join(GUESTS, 'AGENTS.md')
const MEM_START = '<!-- MEMORY:BEGIN -->'
const MEM_END = '<!-- MEMORY:END -->'

// 注意 guests\.git 是**故意**的空目录，不是笔误：
// DSH 从 cwd 往上找 `.git` 作为 project root，然后加载 root→cwd 链上每一层目录的 AGENTS.md。
// 有了它，客人会话的链就只有 guests\ 一层；万一哪天有人在 <项目目录> 建了 .git，
// 根 AGENTS.md（带机主记忆）就会被塞进客人会话 —— 这个空目录是那道保险。
for (const d of [STATE, LOGS, HOME, CWD, ATTACH, STICKERS, USERS, GUESTS, path.join(GUESTS, '.git')]) {
  mkdirSync(d, { recursive: true })
}

/**
 * 给模型子进程的环境。
 * 密钥和接口地址由管理台「API 密钥」区写进隔离 home，这里保证它说话算数：
 *   - 凭据文件里有密钥 → 删掉继承来的 DEEPSEEK_API_KEY（DSH 的解析顺序里环境变量优先级更高，会盖过文件）；
 *   - config.json 的 api.baseUrl 非空 → 以 DEEPSEEK_BASE_URL 传下去。
 */
const modelEnv = () => childEnvFor({ home: HOME, baseUrl: cfg.api?.baseUrl, env: process.env })

const nowIso = () => new Date().toISOString()
const cfgTag = () => path.join(ROOT, 'state', 'ilink-state.json')
const statusFile = path.join(STATE, 'status.json')
const lockFile = path.join(STATE, 'bridge.lock')
const DISTILL_JS = path.join(ROOT, 'src', 'distill.mjs')
const LONGTERM = path.join(ROOT, 'memory', 'long-term.md')

/** 本地日期（按配置时区），用于"一天一个会话"。 */
function today() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.session.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地日期 + 时刻（按配置时区）。模型自己没有钟，这一行就是它唯一的时间来源。 */
function localClock(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.session.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(d)
    const g = (t) => parts.find((p) => p.type === t)?.value ?? ''
    const date = `${g('year')}-${g('month')}-${g('day')}`
    return { date, time: `${g('hour')}:${g('minute')}` }
  } catch {
    const iso = d.toISOString()
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
  }
}

/** 由日期字符串算星期几 —— 不依赖语言环境。 */
function weekdayCn(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return ''
  return WEEK_CN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? ''
}

/** 「3 小时 27 分前」这样的人话。 */
function humanGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.round(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return m ? `${h} 小时 ${m} 分前` : `${h} 小时前`
  const day = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${day} 天 ${rh} 小时前` : `${day} 天前`
}

/**
 * 每轮消息前带的一行时间提示。这是机器人「有时间感」的唯一来源：
 * 「3 点说要去睡、6 点半又冒出来」这种判断全靠它。人格段里明确要求不要复述这一行。
 */
function timeHeader(prevInboundAt) {
  const { date, time } = localClock()
  const gap = prevInboundAt ? humanGap(Date.now() - Date.parse(prevInboundAt)) : ''
  const tail = gap ? `；对方上一条消息在 ${gap}` : '；这是重启后的第一条消息'
  return `［现在是 ${date} ${weekdayCn(date)} ${time}${tail}］`
}

/** 推完一条视频就记一笔（她发过什么，自己得记得）。 */
function noteBiliSent(entry) {
  if (!entry) return
  const list = readJsonQuiet(BILI_RECENT, [])
  const arr = Array.isArray(list) ? list : []
  arr.push({
    ts: nowIso(),
    bv: entry.bv,
    title: entry.title || entry.bv,
    reason: entry.reason || '',
  })
  writeJsonQuiet(BILI_RECENT, arr.slice(-5))
}

/**
 * 她之前自己发过、但这轮还没跟她说过的那几条视频。
 * 用一个「她自己的记忆」口径写给模型看（不是系统提示），用过就清 —— 只提醒一次。
 */
function biliRecallHeader() {
  const list = readJsonQuiet(BILI_RECENT, [])
  if (!Array.isArray(list) || !list.length) return ''
  const lines = list.slice(-3).map((x) => {
    const when = x.ts ? humanGap(Date.now() - Date.parse(x.ts)) : ''
    const said = x.reason ? `，你当时说「${x.reason}」` : ''
    return `《${x.title || x.bv}》${when ? `（${when}发的）` : ''}${said}`
  })
  writeJsonQuiet(BILI_RECENT, [])          // 只提醒这一次，别每轮都念
  return `［你自己在微信里发给他过的视频：${lines.join('；')}。那是你自己发的，他要是聊到，你得知道是什么］\n`
}

/** B站的扫码凭证（插件扫过一次就写在它家目录里）。没有就返回空，公开信息照样能查。 */
const BILI_CRED = path.join(process.env.USERPROFILE ?? '', '.dsh', 'bili-duty', 'bili_credential.json')
function videoCookie() {
  try {
    return cookieFromCredential(readFileSync(BILI_CRED, 'utf8'))
  } catch {
    return ''
  }
}

const status = {
  pid: process.pid,
  startedAt: nowIso(),
  updatedAt: nowIso(),
  version: 2,
  online: false,
  paused: false,
  botId: '',
  ownerUserId: '',
  sessionId: '',
  sessionDate: '',
  sessionTurns: 0,
  queueDepth: 0,
  processing: false,
  counters: { received: 0, replied: 0, failed: 0, unsupported: 0 },
  lastInboundAt: '',
  lastInboundText: '',
  lastReplyAt: '',
  lastReplyText: '',
  lastError: '',
  token: '', // 只放前 8 位，方便识别是哪次登录
  budgetWarnedDate: '',
  // 今日 token 用量（跨重启保留：启动时从旧 status.json 里捞回来，只要还是同一天）
  usage: { date: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, turns: 0 },
}

let paused = false
function setPaused(v) {
  paused = !!v
  status.paused = paused
  log(paused ? 'paused' : 'resumed', { by: 'command' })
  writeStatus()
}

/** 累加一次 headless 的 usage（NDJSON 里 step_end 事件的 usage）。 */
function accumulateUsage(list) {
  const d = today()
  if (status.usage.date !== d) {
    status.usage = { date: d, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, turns: 0 }
  }
  for (const u of list ?? []) {
    if (!u) continue
    status.usage.inputTokens += Number(u.inputTokens ?? 0)
    status.usage.outputTokens += Number(u.outputTokens ?? 0)
    status.usage.cacheReadTokens += Number(u.cacheReadTokens ?? 0)
    status.usage.cacheWriteTokens += Number(u.cacheWriteTokens ?? 0)
    status.usage.totalTokens += Number(u.totalTokens ?? 0)
  }
  status.usage.turns += 1
}

/** 预算闸门：超了就先说一声（可选自动暂停），但绝不因此丢消息。 */
function budgetCheck() {
  const cap = Number(cfg.guard?.dailyTokenBudget ?? 0)
  if (!cap || status.usage.totalTokens < cap) return null
  if (cfg.guard?.pauseWhenExceeded && !paused) setPaused(true)
  if (status.budgetWarnedDate === today()) return null   // 一天只唠叨一次
  status.budgetWarnedDate = today()
  log('budget_exceeded', { used: status.usage.totalTokens, cap })
  return `今天已经用了 ${status.usage.totalTokens} token，超过预算 ${cap} 了哦。`
}

/** 日志轮转：删掉超过 log.keepDays 天的东西（headless 的中间输出占地方最多）。 */
function cleanLogs() {
  const keepDays = Number(cfg.log?.keepDays ?? 30)
  if (!Number.isFinite(keepDays) || keepDays <= 0) return 0
  const cutoff = Date.now() - keepDays * 86400000
  let n = 0
  try {
    for (const f of readdirSync(LOGS)) {
      const p = path.join(LOGS, f)
      try { if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); n += 1 } } catch { /* 占用中就算了 */ }
    }
  } catch { /* ignore */ }
  return n
}
let statusTimer = null
function writeStatus() {
  status.updatedAt = nowIso()
  status.bili = { ...biliStats }
  try { writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`, 'utf8') } catch { /* 不阻塞主循环 */ }
}
function scheduleStatus() {
  if (statusTimer) return
  statusTimer = setTimeout(() => { statusTimer = null; writeStatus() }, 500)
}

const logFile = () => path.join(LOGS, `bridge-${today()}.jsonl`)
function log(kind, data = {}) {
  const line = JSON.stringify({ ts: nowIso(), kind, ...data })
  try { appendFileSync(logFile(), `${line}\n`, 'utf8') } catch { /* 日志失败不影响对话 */ }
  const brief = data.text ?? data.reason ?? data.status ?? ''
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${kind}${brief ? ` — ${String(brief).slice(0, 60)}` : ''}`)
}

// ------------------------------------------------------------- DSH headless

/** 跑一次 headless。串行化由调用方保证；输出走文件描述符（见文件头约束 2）。 */
function runHeadless({ task, sessionId, timeoutMs, cwd = CWD }) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
  const outFile = path.join(LOGS, `headless-${stamp}.out.jsonl`)
  const errFile = path.join(LOGS, `headless-${stamp}.err.txt`)
  const args = [DSH_BIN, 'headless', '--json']
  if (sessionId) args.push('--session-id', sessionId)
  args.push(task)

  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  const t0 = Date.now()

  return new Promise((resolve) => {
    let settled = false
    const child = spawn(process.execPath, args, {
      cwd,
      env: modelEnv(),
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已在退出 */ }
      finish(null, 'timeout')
    }, timeoutMs)

    function finish(code, note) {
      clearTimeout(timer)
      try { closeSync(outFd) } catch { /* ignore */ }
      try { closeSync(errFd) } catch { /* ignore */ }
      let events = []
      try {
        events = readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l) } catch { return { type: 'unparsed', line: l } }
        })
      } catch { /* ignore */ }
      const session = events.find((e) => e.type === 'session')
      const final = [...events].reverse().find((e) => e.type === 'final')
      const turnEnd = [...events].reverse()
        .find((e) => e.type === 'status' && e.phase === 'turn_end')
      const usage = events.filter((e) => e.type === 'status' && e.phase === 'step_end')
        .map((e) => e.usage).filter(Boolean)
      let stderr = ''
      try { stderr = readFileSync(errFile, 'utf8').trim() } catch { /* ignore */ }
      resolve({
        exitCode: code,
        note: note ?? '',
        elapsedMs: Date.now() - t0,
        sessionId: session?.sessionId ?? '',
        cwd: session?.cwd ?? '',
        text: (final?.text ?? '').trim(),
        reason: turnEnd?.reason?.kind ?? '',
        usage,
        stderr,
        outFile,
      })
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      log('headless_spawn_error', { error: String(err?.message ?? err) })
      finish(null, 'spawn-error')
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      finish(code)
    })
  })
}

// ------------------------------------------------------------------ 会话管理

/**
 * 机主是谁。从 iLink 登录态里读；还不知道时（没登录过）一律按机主处理，
 * 免得首次启动时把机主自己当成客人、加载空记忆。
 */
let ownerCache = ''
function ownerUserId() {
  if (!ownerCache) {
    try { ownerCache = String(JSON.parse(readFileSync(cfgTag(), 'utf8')).ownerUserId ?? '') } catch { ownerCache = '' }
  }
  return ownerCache
}
function isOwner(userId) {
  const owner = ownerUserId()
  if (!owner) return true
  return String(userId ?? '') === owner
}

/** 白名单（config.json 的 allowUsers）：空 = 谁都可以；非空 = 只回名单里的人。 */
function allowedUser(userId) {
  if (isOwner(userId)) return true
  const v = cfg.allowUsers
  const list = Array.isArray(v) ? v.map(String) : (typeof v === 'string' ? v.split(/[,，\s]+/).filter(Boolean) : [])
  if (!list.length) return true
  return list.includes(String(userId ?? ''))
}

/** 一个用户一个目录：state\users\<sha256(userId) 前 12 位>\ —— userId 不进文件名，避免非法字符。 */
function userKey(userId) {
  return createHash('sha256').update(String(userId ?? 'unknown')).digest('hex').slice(0, 12)
}
function userDir(userId) {
  const d = path.join(USERS, userKey(userId))
  mkdirSync(d, { recursive: true })
  return d
}
function sessionFileOf(userId) { return path.join(userDir(userId), 'session.json') }

function readSession(userId) {
  try { return JSON.parse(readFileSync(sessionFileOf(userId), 'utf8')) } catch { return {} }
}
function saveSession(userId, data) {
  writeFileSync(sessionFileOf(userId), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** 取某人当天的会话 id；跨天或没有则返回 ''（表示要新建）。 */
function currentSessionId(userId) {
  const s = readSession(userId)
  if (!cfg.session.dailyReset) return s.sessionId ?? ''
  return s.date === today() ? (s.sessionId ?? '') : ''
}

/**
 * 一张 userId ↔ key 的对照表，纯粹为了让人看得懂「state\users\<key> 是谁」。
 * 写不进去也不影响聊天。
 */
function touchUser(userId, patch = {}) {
  if (!userId) return
  try {
    let idx = {}
    try { idx = JSON.parse(readFileSync(USERS_INDEX, 'utf8')) } catch { /* 首次 */ }
    const k = userKey(userId)
    const prev = idx[k] ?? {}
    idx[k] = {
      ...prev,
      userId: String(userId),
      owner: isOwner(userId),
      firstSeenAt: prev.firstSeenAt ?? nowIso(),
      lastSeenAt: nowIso(),
      ...patch,
    }
    writeFileSync(USERS_INDEX, `${JSON.stringify(idx, null, 2)}\n`, 'utf8')
  } catch (err) {
    log('user_index_failed', { error: String(err?.message ?? err) })
  }
}

/**
 * 一次性迁移：老版本只有一个 state\session.json。升级后如果不搬，
 * 机主会突然开一条新会话、当天的上下文全丢（表现为"它失忆了"）。
 */
function migrateLegacySession() {
  try {
    if (!existsSync(LEGACY_SESSION)) return
    const raw = JSON.parse(readFileSync(LEGACY_SESSION, 'utf8'))
    const owner = ownerUserId()
    if (owner && raw?.sessionId && !existsSync(sessionFileOf(owner))) {
      writeFileSync(sessionFileOf(owner), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    }
    rmSync(LEGACY_SESSION, { force: true })
    log('session_migrated', { owner: owner ? userKey(owner) : '', sessionId: String(raw?.sessionId ?? '') })
  } catch (err) {
    log('session_migrate_failed', { error: String(err?.message ?? err) })
  }
}

/**
 * 客人的 AGENTS.md：人格段照抄根文件，只把 MEMORY 段清空
 * —— 机主的记忆不该出现在外人那条会话里。
 * 开机同步一次；蒸馏完再同步一次（记忆那时才变）。
 */
function syncGuestsAgents() {
  try {
    const raw = readFileSync(AGENTS_FILE, 'utf8')
    mkdirSync(GUESTS, { recursive: true })
    writeFileSync(GUESTS_AGENTS, raw, 'utf8')
    const r = spliceSection(GUESTS_AGENTS, {
      begin: MEM_START, end: MEM_END, body: '\n（这里没有别人的记忆。）\n', backup: false,
    })
    log('guests_agents_synced', { ok: r.ok, changed: r.changed, error: r.error ?? '' })
    return r
  } catch (err) {
    log('guests_agents_failed', { error: String(err?.message ?? err) })
    return { ok: false, changed: false, error: String(err?.message ?? err) }
  }
}

/**
 * 只在客人消息到来时懒同步：根 AGENTS.md 比客人那份新（比如刚蒸完馏）才重写。
 * 这样不用监听蒸馏进程的退出，机主那条路径也完全不付代价。
 */
function syncGuestsAgentsIfStale() {
  try {
    if (existsSync(GUESTS_AGENTS) && statSync(GUESTS_AGENTS).mtimeMs >= statSync(AGENTS_FILE).mtimeMs) return
  } catch { /* 文件不在 → 同步 */ }
  syncGuestsAgents()
}

// ---------------------------------------------------------------- B站日报

// dsh-bili-scroll 插件把报告写成 Markdown 落在它自己家目录的 out\ 下；我们只读、绝不改。
// 流程：每分钟扫一次目录 → 按「内容指纹」判断新不新 → 排进 state\bili-queue.json →
// 有机会（有机主的 context_token + 到点）就推给机主，正文之后补一张第一个视频的封面。

let biliFlushing = false
// 对方最近一次开口的时间：B站日报要等对方安静一会儿再发，别在人正聊天时插播。
let lastInboundMs = Date.now()
const biliStats = { out: BILI_OUT, pending: 0, pushed: 0, lastPushAt: '', lastError: '' }

function readJsonQuiet(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJsonQuiet(file, data) {
  try {
    // 原子写：先写临时文件再 rename。之前直接 writeFileSync，进程半途被杀会留下截断的 JSON，
    // 读回来静默回落成空对象 → 整批待发日报丢失 / 账本丢失导致重发。
    const dir = path.dirname(file)
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`)
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    log('json_write_failed', { file: path.basename(file), error: String(err?.message ?? err) })
  }
}

/** 现在到点了吗（pushAt 留空 = 一直可推）。 */
function biliTimeOk() {
  const at = String(cfg.bili.pushAt ?? '').trim()
  if (!/^\d{1,2}:\d{2}$/.test(at)) return true
  const [h, m] = at.split(':').map(Number)
  return biliNowMinutes() >= h * 60 + m
}

/** 本地「现在几点几分」（按 session.timeZone）。 */
function biliNowMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.session.timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

/**
 * 睡觉时段内不推。`sleepFrom`/`sleepTo` 留空就关掉。
 * 没有这条的话：报告 22:00 出、dueAt 排到 +240 分钟，就会在凌晨两点把视频甩给人家 ——
 * 「空闲时间」变成「睡着时间」。
 */
function biliQuietNow() {
  const from = String(cfg.bili.sleepFrom ?? '').trim()
  const to = String(cfg.bili.sleepTo ?? '').trim()
  if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) return false
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  const a = fh * 60 + fm
  const b = th * 60 + tm
  const now = biliNowMinutes()
  return a <= b ? (now >= a && now < b) : (now >= a || now < b)   // 支持跨午夜
}

/** 报告目录里最新的那份（/bili 用）。 */
function latestBiliReport() {
  try {
    const files = readdirSync(BILI_OUT).filter((f) => /\.md$/i.test(f)).sort().reverse()
    if (!files.length) return null
    const file = files[0]
    return parseReport(readFileSync(path.join(BILI_OUT, file), 'utf8'), { filename: file })
  } catch { return null }
}

/**
 * 扫报告目录，把没推过的条目排进队列。
 * 幂等：同一个文件内容没变（指纹相同）就跳过；条目级再按 BV 去重一次。
 */
function scanBiliReports() {
  if (cfg.bili.enabled !== true) return 0
  let files = []
  try { files = readdirSync(BILI_OUT).filter((f) => /\.md$/i.test(f)).sort().reverse() } catch { return 0 }
  const sent = readJsonQuiet(BILI_SENT, { bvs: [], keys: [] })
  const queue = readJsonQuiet(BILI_QUEUE, { items: [] })
  if (!Array.isArray(queue.items)) queue.items = []
  // 去重只有一个口径：**BV**。已发过、或还躺在队列里等 dueAt 的，都算「有过了」。
  // （别用报告级指纹判「这份报告排过没有」：队列项的 key 是 `报告key#BV`，永远对不上，
  //   结果就是每分钟把同一份报告重新入队一遍 —— 实测 18 个队列项只有 3 个 BV。）
  const known = new Set([
    ...(Array.isArray(sent.bvs) ? sent.bvs : []),
    ...queue.items.flatMap((i) => (Array.isArray(i.bvs) && i.bvs.length ? i.bvs : [i.bv])).filter(Boolean),
  ])
  let added = 0
  for (const file of files.slice(0, 3)) {
    let md = ''
    try { md = readFileSync(path.join(BILI_OUT, file), 'utf8') } catch { continue }
    const report = parseReport(md, { filename: file })
    if (!report.items.length) {
      log('bili_parse_empty', { file, bytes: md.length })   // 模板改了就解析成 0 条时，至少查得到
      continue
    }
    const key = `${report.date || file}:${reportStamp(md)}`
    const fresh = report.items.filter((it) => !known.has(it.bv))
    if (!fresh.length) continue
    // 一条视频 = 一条队列项 = 一条消息。一次只发一条，其余按 dueAt 散在后面的空闲时段里。
    const picks = fresh.slice(0, Math.max(1, Number(cfg.bili.maxPerPush ?? 3)))
    const due = planDueAt(picks.length, {
      nowMs: Date.now(),
      minDelayMin: Number(cfg.bili.minDelayMin ?? 15),
      maxDelayMin: Number(cfg.bili.maxDelayMin ?? 240),
      gapMin: Number(cfg.bili.gapMin ?? 20),
    })
    picks.forEach((it, i) => {
      const bubbles = itemToMessages(it, { linkStyle: cfg.bili.linkStyle, maxChars: cfg.reply.maxChars })
      if (!bubbles.length) return
      queue.items.push({
        key: `${key}#${it.bv}`,
        date: report.date || file,
        bv: it.bv,
        bvs: [it.bv],
        title: it.title || it.bv,
        reason: it.reason || it.snippet || '',
        messages: bubbles,
        coverBv: cfg.bili.withCover ? it.bv : '',
        dueAt: due[i] ?? Date.now(),
        sent: 0,
        queuedAt: nowIso(),
        attempts: 0,
      })
      known.add(it.bv)
      added += 1
    })
  }
  biliStats.pending = queue.items.length
  if (added) {
    writeJsonQuiet(BILI_QUEUE, queue)
    log('bili_queued', { added, pending: queue.items.length })
  }
  return added
}

/**
 * 把队列推给机主。没 context_token 就等下一次（推消息必须带它）。
 * 规则：对方安静够 idleMinutes 才发；只发 dueAt 到了的那条；每个 tick 最多推 maxPerTick 条；
 * 推不出去就留着，最多记 8 次失败后丢弃。
 */
async function flushBili({ contextToken = '' } = {}) {
  if (cfg.bili.enabled !== true) return 0
  if (biliFlushing) return 0
  const queue = readJsonQuiet(BILI_QUEUE, { items: [] })
  if (!Array.isArray(queue.items) || !queue.items.length) return 0
  const owner = ownerUserId()
  if (!owner) return 0
  const windowKey = `user:${owner}`
  const token = contextToken || store.contextFor(windowKey)
  if (!token) {
    biliStats.pending = queue.items.length
    return 0
  }
  if (!biliTimeOk()) return 0
  if (biliQuietNow()) return 0                            // 睡觉时段一律不推，条目原地等着
  const idleMs = Math.max(0, Number(cfg.bili.idleMinutes ?? 20)) * 60 * 1000
  if (Date.now() - lastInboundMs < idleMs) return 0      // 人家正在聊，别插播
  const maxPerTick = Math.max(1, Number(cfg.bili.maxPerTick ?? 1))
  biliFlushing = true
  let pushed = 0
  try {
    while (pushed < maxPerTick && queue.items.length) {
      // 队列按入队顺序排，dueAt 不一定单调 —— 找第一条真的到点的
      const idx = queue.items.findIndex((e) => Number(e.dueAt ?? 0) <= Date.now())
      if (idx < 0) break
      const entry = queue.items[idx]
      // 兼容老队列项（bubbles → messages）
      const messages = Array.isArray(entry.messages)
        ? entry.messages
        : (Array.isArray(entry.bubbles) ? entry.bubbles : [])
      const gapMs = Math.max(200, Number(cfg.bili.bubbleGapMs ?? 1500))
      let sentCount = Number(entry.sent ?? 0)
      let failed = ''
      while (sentCount < messages.length) {
        try {
          await channel.say(windowKey, messages[sentCount], { contextToken: token, maxChars: cfg.reply.maxChars })
        } catch (err) {
          failed = String(err?.message ?? err)
          break
        }
        sentCount += 1
        entry.sent = sentCount
        writeJsonQuiet(BILI_QUEUE, queue)      // 每发一条就记账：中途崩了重试也不会重复
        if (sentCount < messages.length) await new Promise((r) => { setTimeout(r, gapMs) })
      }
      if (failed) {
        entry.attempts = Number(entry.attempts ?? 0) + 1
        biliStats.lastError = failed
        // 推不出去**不丢**：只把 dueAt 往后推（指数退避，最多 30 分钟；通道级拒绝 -2/-14 直接等 10 分钟）。
        // 之前是 8 次失败就 splice 掉 —— 用户不说话 8 分钟，当天的日报就永久没了。
        const channelLevel = /\-14|\-2|prepare failed|context_token/.test(failed)
        const backoffMin = channelLevel ? 10 : Math.min(30, Math.max(1, 2 ** (entry.attempts - 1)))
        entry.dueAt = Date.now() + backoffMin * 60 * 1000
        entry.lastError = failed
        entry.lastTriedAt = nowIso()
        if (channelLevel) {
          // 通道级拒绝（token 过期 / -2）跟具体条目无关：其他条目也别再试探了，
          // 否则一分钟烧掉一条的 attempts，日志成片都是同一个错。
          for (const other of queue.items) {
            if (other === entry) continue
            const at = Number(other.dueAt ?? 0)
            if (at <= Date.now()) other.dueAt = Date.now() + backoffMin * 60 * 1000
          }
        }
        log('bili_push_failed', {
          date: entry.date, bv: entry.bv, attempts: entry.attempts, sent: sentCount, total: messages.length,
          retryInMin: backoffMin, channelLevel, error: failed,
        })
        writeJsonQuiet(BILI_QUEUE, queue)
        break                               // 通道多半年纪大了，别连着试
      }
      if (entry.coverBv) {
        try {
          const cover = await fetchCover(entry.coverBv)
          if (cover) {
            await new Promise((r) => { setTimeout(r, Math.max(0, Number(cfg.sticker.gapMs ?? 500))) })
            await channel.sendImage(windowKey, cover.bytes, { contextToken: token })
          }
        } catch (err) {
          log('bili_cover_failed', { bv: entry.coverBv, error: String(err?.message ?? err) })
        }
      }
      queue.items.splice(idx, 1)
      pushed += 1
      const sent = readJsonQuiet(BILI_SENT, { bvs: [], keys: [] })
      sent.bvs = [...new Set([...(sent.bvs ?? []), ...(entry.bvs ?? [])])].slice(-500)
      sent.keys = [...new Set([...(sent.keys ?? []), entry.key])].slice(-cfg.bili.keepKeys)
      writeJsonQuiet(BILI_SENT, sent)
      writeJsonQuiet(BILI_QUEUE, queue)
      noteBiliSent(entry)
      biliStats.pushed += 1
      biliStats.lastPushAt = nowIso()
      log('bili_pushed', { date: entry.date, bv: entry.bv, messages: messages.length, chars: messages.join('').length })
    }
  } finally {
    biliFlushing = false
    biliStats.pending = queue.items.length
  }
  if (pushed) writeStatus()
  return pushed
}

/** 每分钟扫一次目录并尝试推送。 */
function startBiliTimer() {
  if (cfg.bili.enabled !== true) return
  const tick = () => {
    try { scanBiliReports(); flushBili().catch(() => {}) } catch (err) {
      log('bili_tick_failed', { error: String(err?.message ?? err) })
    }
  }
  tick()
  setInterval(tick, 60 * 1000).unref()
  log('bili_watch', {
    out: BILI_OUT,
    pushAt: cfg.bili.pushAt || '(随时)',
    withCover: cfg.bili.withCover,
    maxPerPush: cfg.bili.maxPerPush,
    maxPerTick: cfg.bili.maxPerTick,
    idleMinutes: cfg.bili.idleMinutes,
    delayRange: `${cfg.bili.minDelayMin}-${cfg.bili.maxDelayMin}min`,
  })
}

// ------------------------------------------------------------------ 记忆蒸馏（阶段 C）

const DISTILL_STATE = path.join(STATE, 'distill.json')

/**
 * 跨天就把「刚过去的那一天」交给 distill.mjs 蒸馏（fire-and-forget，不挡对话）。
 * 失败只记日志：记忆写不进去也不能影响聊天。
 */
function maybeDistill() {
  try {
    let st = {}
    try { st = JSON.parse(readFileSync(DISTILL_STATE, 'utf8')) } catch { /* 首次 */ }
    const d = today()
    if (st.lastDate === d) return
    const prev = st.lastDate ?? ''
    writeFileSync(DISTILL_STATE, `${JSON.stringify({ lastDate: d, lastDistilled: prev, updatedAt: nowIso() }, null, 2)}\n`, 'utf8')
    if (!prev || prev === d) return
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'distill.mjs'), prev], {
      cwd: ROOT, env: modelEnv(), detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    log('distill_spawned', { date: prev })
  } catch (err) {
    log('distill_spawn_failed', { error: String(err?.message ?? err) })
  }
}

// ------------------------------------------------------------------ 指令处理

const AFF_FILE = path.join(STATE, 'affinity.json')
const AFF_LEVELS = [[30, '还不太熟'], [50, '有点熟了'], [70, '熟'], [85, '亲近'], [101, '特别亲近']]

function readAffinity() {
  try { return JSON.parse(readFileSync(AFF_FILE, 'utf8')) } catch { return { base: 50, value: 50, history: [] } }
}
const affinityLevel = (v) => (AFF_LEVELS.find(([ceil]) => v < ceil) ?? [0, '熟'])[1]

/** 后台跑一次蒸馏（默认今天），不挡聊天。 */
function spawnDistill(date) {
  try {
    const child = spawn(process.execPath, [DISTILL_JS, ...(date ? [date] : [])], {
      cwd: ROOT, env: modelEnv(), detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    return child.pid
  } catch (err) {
    log('distill_spawn_failed', { error: String(err?.message ?? err) })
    return 0
  }
}

/** 按现有 memory\ 重建 AGENTS.md 的记忆段（管理台改完记忆 / /remember 之后用）。 */
function rebuildMemory() {
  try {
    const child = spawn(process.execPath, [DISTILL_JS, '--rebuild-memory'], {
      cwd: ROOT, env: modelEnv(), detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    return true
  } catch (err) {
    log('rebuild_memory_failed', { error: String(err?.message ?? err) })
    return false
  }
}

/**
 * 管理台「测试密钥」：用当前配置真跑一次最小 headless，看密钥通不通。
 * 用**全新会话**（不带 --session-id），所以不碰当天的对话，回复也不会发到微信。
 * 只为了拿一个确定的结论：exitCode 0 = 密钥可用；否则把 stderr 原样带回去给界面显示。
 */
async function testApiKey() {
  const r = await runHeadless({ task: '只回复两个字：收到', timeoutMs: 90000 })
  const usage = r.usage?.[0] ?? {}
  return {
    exitCode: r.exitCode,
    note: r.note,
    elapsedMs: r.elapsedMs,
    text: String(r.text ?? '').slice(0, 60),
    stderr: String(r.stderr ?? '').slice(0, 500),
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    sessionId: r.sessionId,
  }
}

/** 清掉某人当天的会话：下次消息会开一个新的。 */
function newSession(userId, by) {
  saveSession(userId, { date: today(), sessionId: '', resetAt: nowIso() })
  if (isOwner(userId)) {
    status.sessionId = ''
    status.sessionTurns = 0
    writeStatus()
  }
  log('session_reset', { by, user: userKey(userId) })
}

/** 只有机主能用的指令（会改到机主的记忆 / 全局开关 / 全局状态）。 */
const OWNER_ONLY_CMDS = new Set(['/pause', '/resume', '/remember', '/affinity'])

/** 指令（阶段 D）。返回 true 表示已处理，不再进模型。 */
async function handleCommand({ channel, windowKey, contextToken, text, userId }) {
  const raw = text.trim()
  if (!raw.startsWith('/')) return false
  const [word, ...rest] = raw.split(/\s+/)
  const cmd = word.toLowerCase()
  const arg = rest.join(' ').trim()
  const say = (t) => channel.say(windowKey, t, { contextToken, maxChars: cfg.reply.maxChars })
  const owner = isOwner(userId)

  if (!owner && OWNER_ONLY_CMDS.has(cmd)) {
    await say('这个指令只有我哥能用，你别乱按。')
    return true
  }

  switch (cmd) {
    case '/help':
      await say((owner
        ? [
          '本鲸鱼会的：',
          '/status 现在的状态',
          '/new 把今天的会话清空重开',
          '/pause 先别回消息',
          '/resume 恢复回消息',
          '/persona 现在用的人格卡',
          '/remember 要记住的事（例：/remember 喜欢冰美式）',
          '/affinity 好感度',
          '/bili 今天的 B站日报',
          '/ping 还在吗',
        ]
        : [
          '本鲸鱼会的：',
          '/status 现在的状态',
          '/new 把今天的会话清空重开',
          '/persona 现在用的人格卡',
          '/ping 还在吗',
        ]).join('\n'))
      return true
    case '/ping':
      await say('本鲸鱼在呢。')
      return true
    case '/status': {
      const s = readSession(userId)
      if (!owner) {
        await say(`今天的会话：${s.sessionId ? '开着' : '还没开'}`
          + `\n本鲸鱼今天一共收到 ${status.counters.received} 条、回了 ${status.counters.replied} 条`)
        return true
      }
      const u = status.usage
      const aff = readAffinity()
      await say(`今天(${today()})的会话：${s.sessionId ? `${s.sessionId.slice(0, 22)}…` : '还没开'}`
        + `\n聊了 ${status.sessionTurns} 轮，收到 ${status.counters.received} 条、回了 ${status.counters.replied} 条`
        + `\n今天用了 ${u.totalTokens} token（${u.turns} 次）`
        + `\n关系：${affinityLevel(aff.value)}`
        + (paused ? '\n（现在是暂停状态，发 /resume 叫醒本鲸鱼）' : ''))
      return true
    }
    case '/new':
      newSession(userId, 'command')
      await say('嗯……本鲸鱼把脑袋清空了，重新开始吧。')
      return true
    case '/pause':
      setPaused(true)
      await say('好麻烦哦……那本鲸鱼先眯一会儿，你回来喊「/resume」。')
      return true
    case '/resume':
      setPaused(false)
      await say('醒了醒了，说吧。')
      return true
    case '/persona': {
      const name = String(cfg.persona ?? '小鲸鱼')
      const file = path.join(ROOT, 'personas', `${name}.md`)
      await say(`现在用的是「${name}」${existsSync(file) ? '' : '（人格卡文件不在，只有 AGENTS.md 里的摘录）'}。`
        + '\n改人格就改 AGENTS.md 的 PERSONA 段，或者 personas\\ 下那张卡。')
      return true
    }
    case '/remember': {
      if (!arg) { await say('要记什么？这样写：/remember 喜欢喝冰美式'); return true }
      const line = `- [${today()}] ${arg.slice(0, 60)}`
      try {
        appendFileSync(LONGTERM, `${line}\n`, 'utf8')
        rebuildMemory()
        log('remember', { text: arg.slice(0, 60) })
        await say(`记住了：${arg.slice(0, 40)}`)
      } catch (err) {
        log('remember_failed', { error: String(err?.message ?? err) })
        await say('唔……写不进去，本鲸鱼回头再试。')
      }
      return true
    }
    case '/affinity': {
      await say(`本鲸鱼跟你的关系：${affinityLevel(readAffinity().value)}`)
      return true
    }
    case '/bili': {
      if (!owner) { await say('这个只有机主能看。'); return true }
      const report = latestBiliReport()
      if (!report) { await say('还没有日报，等它刷一轮吧。'); return true }
      const view = reportToText(report, { maxPerPush: 9, linkStyle: cfg.bili.linkStyle })
      await say(view.text || '今天的报告里没有条目。')
      return true
    }
    default:
      await say(`不认识「${cmd}」这个指令。发 /help 看看有哪些。`)
      return true
  }
}

// ------------------------------------------------------------------ 主流程

const store = new IlinkStore(cfgTag())
const api = new IlinkApi({ baseUrl: store.baseUrl, token: store.token })
const channel = new IlinkChannel({ api, store, logger: (m) => log('ilink', { text: m }) })

/** 所有 headless 调用串行化：一条 promise 链（约束 4）。 */
let chain = Promise.resolve()
let queueDepth = 0

function enqueue(fn) {
  queueDepth += 1
  status.queueDepth = queueDepth
  scheduleStatus()
  chain = chain.then(fn).catch((err) => {
    log('task_error', { error: String(err?.message ?? err) })
    status.lastError = String(err?.message ?? err)
    status.counters.failed += 1
    writeStatus()
  }).finally(() => { queueDepth -= 1; status.queueDepth = queueDepth; scheduleStatus() })
  return chain
}

/** 处理一条文本消息：typing → headless → 发回。 */
// 把模型回复切成若干条要独立发送的气泡。
// 空行/换行都是分界；最多 max 条，多出来的行并进最后一条（避免把分点技术回答炸成十几条）。
function splitBubbles(text, max = 2) {
  const parts = String(text ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return [String(text ?? '')]
  const keep = Math.max(1, Math.min(Number(max) || 1, parts.length))
  if (parts.length <= keep) return parts
  return [...parts.slice(0, keep - 1), parts.slice(keep - 1).join('\n')]
}

// ---------------------------------------------------------------- 表情包

const STICKER_LOG = path.join(STATE, 'sticker-log.json')
const AGENTS_FILE = path.join(ROOT, 'AGENTS.md')

function stickerRate() {
  const max = Math.max(0, Number(cfg.sticker.maxPerHour ?? 4))
  let sent = []
  try {
    const j = JSON.parse(readFileSync(STICKER_LOG, 'utf8'))
    if (Array.isArray(j?.sent)) sent = j.sent
  } catch { sent = [] }
  const cutoff = Date.now() - 3600 * 1000
  const recent = sent.filter((t) => Number.isFinite(Date.parse(t)) && Date.parse(t) > cutoff)
  return { max, used: recent.length, ok: recent.length < max, recent }
}

function noteStickerSent() {
  const { recent } = stickerRate()
  try {
    writeFileSync(STICKER_LOG, `${JSON.stringify({ sent: [...recent, nowIso()] }, null, 2)}\n`)
  } catch { /* 记账失败不影响发图 */ }
}

/**
 * 记一笔"模型想要、但目录里没有的表情"。
 * 这不是垃圾日志 —— 它就是**下一批该画的素材清单**，所以聚合进 status.json 的 top-N，
 * 而不是只躺在 jsonl 里等人去翻。
 */
function noteStickerMissing(want) {
  const label = String(want).slice(0, 40)
  status.stickerMissing = status.stickerMissing ?? {}
  status.stickerMissing[label] = (status.stickerMissing[label] ?? 0) + 1
  const top = Object.entries(status.stickerMissing)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, 20)
  status.stickerMissing = Object.fromEntries(top)
  scheduleStatus()
}

/** 把清单同步进 AGENTS.md（只动 STICKERS 段，别人写的段一个字节都不碰）。 */
function syncStickerManifest() {
  return syncStickerSection({ file: AGENTS_FILE, dir: STICKERS })
}

async function respond({ windowKey, userId, text, contextToken }) {
  const prevInboundAt = status.lastInboundAt   // 先记住上一条的时间，再覆盖
  const owner = isOwner(userId)
  // 非机主用独立 cwd：加载的是 guests\AGENTS.md（人格段照抄、记忆段清空）
  const cwd = owner ? CWD : GUESTS
  if (!owner) syncGuestsAgentsIfStale()
  touchUser(userId)
  // 只有机主自己的消息才算「不空闲」；客人/陌生人发一句不该把机主的日报推迟 20 分钟
  if (owner) lastInboundMs = Date.now()
  status.processing = true
  status.lastInboundAt = nowIso()
  status.lastInboundText = text.slice(0, 200)
  status.counters.received += 1
  writeStatus()
  log('inbound', { userId, user: userKey(userId), owner, text: text.slice(0, 200), len: text.length })

  if (!allowedUser(userId)) {
    log('ignored_not_allowed', { userId, user: userKey(userId), text: text.slice(0, 80) })
    status.processing = false
    scheduleStatus()
    return
  }

  if (await handleCommand({ channel, windowKey, contextToken, text, userId })) {
    status.processing = false
    scheduleStatus()
    return
  }

  if (paused) {
    log('skipped_paused', { userId, text: text.slice(0, 80) })
    status.processing = false
    scheduleStatus()
    return
  }

  let typingTimer = null
  if (cfg.reply.typing) {
    await channel.setTyping(windowKey, true, { contextToken }).catch(() => {})
    typingTimer = setInterval(() => {
      channel.setTyping(windowKey, true, { contextToken }).catch(() => {})
    }, cfg.reply.typingRefreshMs)
  }

  try {
    let sessionId = currentSessionId(userId)
    const isNewSession = !sessionId
    const clock = timeHeader(prevInboundAt)
    const recall = owner ? biliRecallHeader() : ''
    // 他分享了 B站视频（粘贴链接或分享卡片）→ 先把视频信息取回来，让她「知道自己在说什么」。
    let videoBlock = ''
    let videoInfo = null
    const sharedBv0 = owner ? extractBvs(text)[0] : ''
    const shortUrl = owner ? (String(text).match(/https?:\/\/b23\.tv\/[^\s"'<>]+/i) || [''])[0] : ''
    let sharedBv = sharedBv0
    if (!sharedBv && shortUrl) {
      sharedBv = await resolveB23(shortUrl).catch(() => '')
      log('video_shortlink', { url: shortUrl.slice(0, 80), bv: sharedBv })
    }
    if (sharedBv) {
      try {
        videoInfo = await biliVideoBrief(sharedBv, { cookie: videoCookie() })
        videoBlock = videoTaskText(videoInfo, { clock })
        log('video_brief', {
          bv: sharedBv,
          ok: !videoInfo?.error,
          err: videoInfo?.error ?? '',
          title: String(videoInfo?.title ?? '').slice(0, 60),
          comments: videoInfo?.comments?.length ?? 0,
        })
      } catch (err) {
        log('video_brief_failed', { bv: sharedBv, err: err?.message ?? String(err) })
      }
      if (!videoBlock) {
        // 取不到详情也别让她装作看过：给个「只知道是个视频」的口径
        videoBlock = [
          clock,
          '他刚发给你一个 B 站的视频（他只发了链接，你那边的详情没取回来）。',
          '你不知道里面是什么，别装懂 —— 用你自己的口吻问一句或者随口损一句。',
        ].filter(Boolean).join('\n')
      }
    }
    const task = videoBlock
      ? `${videoBlock}\n${recall ? `\n${recall}` : ''}`
      : `${clock}\n${recall}${text}`
    const r = await runHeadless({ task, sessionId: sessionId || undefined, timeoutMs: cfg.reply.timeoutMs, cwd })
    log('headless_done', {
      exitCode: r.exitCode, note: r.note, ms: r.elapsedMs, reason: r.reason,
      sessionId: r.sessionId, chars: r.text.length, out: r.outFile, clock, recall: recall ? recall.trim().length : 0,
      video: videoInfo ? sharedBv : '', user: userKey(userId), owner,
    })
    accumulateUsage(r.usage)

    if (r.sessionId && isNewSession) {
      sessionId = r.sessionId
      saveSession(userId, { date: today(), sessionId, createdAt: nowIso(), cwd: r.cwd || cwd })
      if (owner) {
        status.sessionId = sessionId
        status.sessionDate = today()
        status.sessionTurns = 0
      }
      log('session_created', { sessionId, cwd: r.cwd || cwd, user: userKey(userId), owner })
    }

    // 会话失效（--session-id 被拒 / 进程异常）→ 清掉当天会话，下一轮自动重建
    if (r.exitCode !== 0 && /--session-id|session-id|会话/.test(r.stderr) && sessionId) {
      saveSession(userId, { date: today(), sessionId: '', brokenAt: nowIso(), reason: r.stderr.slice(0, 200) })
      log('session_invalidated', { sessionId, stderr: r.stderr.slice(0, 200), user: userKey(userId) })
      if (owner) status.sessionId = ''
    } else if (r.sessionId && owner) {
      status.sessionTurns += 1
    }

    // 先把表情包标记剥出来 —— 标记不是要说的话
    const tagged = extractStickerTags(r.text)
    let reply = tagged.text
    if (!reply && !tagged.wanted.length) {
      reply = r.exitCode === 0 ? cfg.reply.emptyText : cfg.reply.errorText
      if (r.exitCode !== 0) status.counters.failed += 1
      log('reply_fallback', { exitCode: r.exitCode, note: r.note, reason: r.reason, stderr: r.stderr.slice(0, 300) })
    }
    const budgetWarn = budgetCheck()
    if (budgetWarn) reply = `${reply}\n\n（${budgetWarn}）`

    // 按换行拆成独立气泡（像真人一条一条发），超过上限的行并进最后一条
    const bubbles = reply ? splitBubbles(reply, cfg.reply.maxBubbles ?? 2) : []
    let chunks = 0
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, cfg.reply.bubbleGapMs ?? 700))
      chunks += await channel.say(windowKey, bubbles[i], { contextToken, maxChars: cfg.reply.maxChars })
    }

    // 表情包：一次最多一张；发了文字就顿一下再发图，像真人随手甩一张
    //
    // 桥接侧兜底（不依赖模型自觉）：正文超过 maxTextChars 字 = 这轮在讲正事，
    // 标记一律丢掉。比起在人格卡里写"认真模式不要发"，这条是硬的。
    const stickerNotes = []
    const stickersSent = []
    const plan = planStickerTags(tagged, {
      enabled: cfg.sticker.enabled !== false,
      maxTextChars: cfg.sticker.maxTextChars ?? 200,
    })
    if (plan.note) {
      stickerNotes.push(plan.note)
      log('sticker_dropped', { note: plan.note, wanted: tagged.wanted })
    }
    const wanted = plan.wanted
    if (wanted.length) {
      const list = listStickers(STICKERS)
      const rate = stickerRate()
      const want = wanted[0]
      const hit = resolveSticker(list, want)
      if (!hit) {
        stickerNotes.push(`missing:${want}`)
        noteStickerMissing(want)
        log('sticker_missing', { want, have: list.map((s) => s.label).slice(0, 40) })
      } else if (!rate.ok) {
        stickerNotes.push(`throttled:${hit.label}`)
        log('sticker_throttled', { label: hit.label, used: rate.used, max: rate.max })
      } else {
        try {
          if (bubbles.length) await new Promise((r) => setTimeout(r, cfg.sticker.gapMs ?? 500))
          await channel.sendImage(windowKey, hit.file, { contextToken })
          stickersSent.push(hit.label)
          noteStickerSent()
          log('sticker_sent', { label: hit.label, file: hit.file, bytes: statSync(hit.file).size })
        } catch (err) {
          stickerNotes.push(`failed:${hit.label}`)
          log('sticker_failed', { label: hit.label, error: String(err?.message ?? err) })
        }
      }
    }

    // 兜底：既没有文字、也没发出去图 → 别让对方干等
    if (!bubbles.length && !stickersSent.length) {
      reply = cfg.reply.emptyText
      chunks += await channel.say(windowKey, reply, { contextToken, maxChars: cfg.reply.maxChars })
    }

    status.counters.replied += 1
    status.lastReplyAt = nowIso()
    status.lastReplyText = (reply || `[表情:${stickersSent.join(',')}]`).slice(0, 200)
    log('reply_sent', {
      userId, chunks, bubbles: bubbles.length, chars: reply.length,
      stickers: stickersSent, stickerNotes, text: reply.slice(0, 200),
    })

    // 这里原本有一个「机主刚说完话就顺手 flush 一次」的 300ms 触发 —— 但它**永远不会推**
    // （respond 开头刚把 lastInboundMs 设成 now，300ms 后必然没过 idleMinutes 门），
    // 而且真推了也会跟回复气泡抢通道（并发 send 正是 -2 prepare failed 的形态）。
    // 日报一律交给 startBiliTimer 的定时器：那时 token 也是最新的（每次入站都会刷新）。
  } catch (err) {
    status.counters.failed += 1
    status.lastError = String(err?.message ?? err)
    log('respond_error', { error: String(err?.message ?? err) })
    try {
      await channel.say(windowKey, cfg.reply.errorText, { contextToken, maxChars: cfg.reply.maxChars })
    } catch { /* 通道也坏了就只能记日志 */ }
  } finally {
    if (typingTimer) clearInterval(typingTimer)
    if (cfg.reply.typing) await channel.setTyping(windowKey, false, { contextToken }).catch(() => {})
    status.processing = false
    writeStatus()
  }
}

channel.on('message', (m) => {
  enqueue(() => respond(m))
})
channel.on('unsupported', (m) => {
  status.counters.unsupported += 1
  log('unsupported', { userId: m.userId, types: JSON.stringify(m.types) })
  if (m.items) {
    // 把非文字 item 的真实结构脱敏记下来 —— 语音/文件/视频的形状只有真机能告诉我们
    try {
      log('unsupported_items', { messageId: String(m.messageId ?? ''), shape: JSON.stringify(shapeOf(m.items)) })
    } catch (err) {
      log('unsupported_items_failed', { err: err?.message ?? String(err) })
    }
  }
  const id = String(m.messageId ?? '')
  const pending = pendingImages.get(id)
  if (pending) {
    // 这条是图片：等它落盘完，把路径当普通消息交给会话（agent 自己用 read_image 打开）
    pendingImages.delete(id)
    enqueue(async () => {
      const files = await pending
      if (!files.length) {
        await channel.say(m.windowKey, cfg.reply.unsupportedText,
          { contextToken: m.contextToken, maxChars: cfg.reply.maxChars }).catch(() => {})
        return
      }
      await respond({ windowKey: m.windowKey, userId: m.userId, contextToken: m.contextToken, text: imageTaskFor(files) })
    })
    return
  }
  enqueue(() => channel.say(m.windowKey, cfg.reply.unsupportedText,
    { contextToken: m.contextToken, maxChars: cfg.reply.maxChars }).catch(() => {}))
})

/** 把任意值压成「字段名全留、值截断」的形状，用于把 iLink 真实结构记进日志。 */
function shapeOf(v, depth = 0) {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) return depth > 3 ? `[Array(${v.length})]` : v.map((x) => shapeOf(x, depth + 1))
  if (typeof v === 'object') {
    if (depth > 3) return '[Object]'
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = shapeOf(val, depth + 1)
    return out
  }
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 12)}…(${v.length}字)` : v
  return v
}

/**
 * 入站图片：下载 → AES-128-ECB 解密 → 落盘到 attachments\。
 * 返回落盘成功的绝对路径列表（回复由调用方决定）。
 */
async function saveInboundImage(m) {
  const t0 = Date.now()
  const files = []
  for (let i = 0; i < m.count; i += 1) {
    const rawId = m.messageId === undefined || m.messageId === null ? String(Date.now()) : String(m.messageId)
    try {
      const r = await m.load(i)
      const name = `${today()}-${rawId}${m.count > 1 ? `-${i + 1}` : ''}.${r.ext}`
      const dest = path.resolve(ATTACH, name)
      // R2：写入白名单硬校验（只允许落在 attachments\ 里）
      if (!dest.startsWith(ATTACH + path.sep)) throw new Error(`拒绝写入白名单外的路径：${dest}`)
      writeFileSync(dest, r.bytes)
      files.push(dest)
      log('image_saved', {
        file: dest, bytes: r.bytes.length, cipherBytes: r.cipherBytes, ext: r.ext, mime: r.mime,
        messageId: rawId, index: i + 1, count: m.count, ms: Date.now() - t0,
      })
    } catch (err) {
      log('image_failed', { messageId: rawId, index: i + 1, error: String(err?.message ?? err) })
    }
  }
  return files
}

/** 图片消息交给会话的任务文本：只给路径，让 agent 自己用 read_image 打开。 */
function imageTaskFor(files) {
  const head = files.length > 1 ? `用户发来 ${files.length} 张图片：` : '用户发来一张图片：'
  return head + files.join('\n')
}

// 图片事件没有正文，所以「图片已落盘」的 Promise 先存起来，等 unsupported 事件来配对。
const pendingImages = new Map()

channel.on('image', (m) => {
  log('image_item', {
    userId: m.userId, messageId: String(m.messageId ?? ''), count: m.count,
    shape: JSON.stringify(shapeOf(m.items)),
  })
  pendingImages.set(
    String(m.messageId ?? ''),
    saveInboundImage(m).catch((err) => {
      log('image_failed', { messageId: String(m.messageId ?? ''), error: String(err?.message ?? err) })
      return []
    }),
  )
})
channel.on('error', (err) => {
  status.lastError = String(err?.message ?? err)
  log('channel_error', { error: String(err?.message ?? err) })
  writeStatus()
})
/** 渲染二维码页；页面每 5 秒自我刷新，所以二维码过期换新码后不用手动刷新。 */
function renderQr(qrcodeUrl, st) {
  const page = path.join(LOGS, 'qr.html')
  writeQrPage(page, qrcodeUrl, {
    status: st,
    note: '这个页面每 5 秒自动刷新；二维码过期会自动换成新的，不用管。',
  })
  try {
    const html = readFileSync(page, 'utf8').replace(
      '<meta charset="utf-8">',
      '<meta charset="utf-8"><meta http-equiv="refresh" content="5">',
    )
    writeFileSync(page, html, 'utf8')
  } catch { /* 注入失败也能扫，只是要手动刷新 */ }
  return page
}

channel.on('scan', ({ status: st, qrcodeUrl }) => {
  const page = renderQr(qrcodeUrl, st)
  log('scan', { status: st, page })
})
channel.on('login', ({ botId, ownerUserId }) => {
  status.online = true
  status.botId = botId
  status.ownerUserId = ownerUserId
  status.token = String(store.token).slice(0, 8)
  ownerCache = String(ownerUserId ?? '')     // 机主是谁这一刻才知道，重算缓存
  touchUser(ownerUserId)
  writeStatus()
  log('login', { botId, ownerUserId })
})
channel.on('logout', async ({ reason }) => {
  status.online = false
  status.sessionId = ''
  writeStatus()
  log('logout', { reason })
  // -14：会话过期，需要重新扫码（通道已清 token，这里重新走一次登录）
  try {
    const r = await channel.startLogin()
    log('relogin', { result: r?.status ?? 'unknown' })
    if (r?.status === 'confirmed') channel.start()
  } catch (err) {
    log('relogin_failed', { error: String(err?.message ?? err) })
  }
})

// -------------------------------------------------------------- 单实例锁

function acquireLock() {
  try {
    const old = JSON.parse(readFileSync(lockFile, 'utf8'))
    if (old?.pid && old.pid !== process.pid) {
      try {
        process.kill(old.pid, 0)
        console.error(`已有实例在运行（pid=${old.pid}），本进程退出。`)
        process.exit(3)
      } catch { /* 进程已死，可以接管 */ }
    }
  } catch { /* 没有锁文件 */ }
  writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`, 'utf8')
}
function releaseLock() {
  try {
    const old = JSON.parse(readFileSync(lockFile, 'utf8'))
    if (old?.pid === process.pid) rmSync(lockFile, { force: true })
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------- 启动

// 自检：只打印这一轮会带在消息前面的时间行，不连网、不锁、不起管理台
if (process.argv.includes('--print-clock')) {
  let prev = ''
  try { prev = JSON.parse(readFileSync(statusFile, 'utf8')).lastInboundAt ?? '' } catch { /* 首次 */ }
  console.log(timeHeader(prev))
  process.exit(0)
}

log('boot', { root: ROOT, home: HOME, cwd: CWD, dshBin: DSH_BIN, today: today(), pid: process.pid })
if (!existsSync(DSH_BIN)) {
  log('fatal', { error: `找不到 dsh 启动器：${DSH_BIN}（可在 config.json 里用 dshBin 指定）` })
  console.error(`找不到 dsh 启动器：${DSH_BIN}`)
  process.exit(1)
}
acquireLock()
status.dshBin = DSH_BIN
migrateLegacySession()
syncGuestsAgents()
touchUser(ownerUserId())      // 恢复登录态时不会再发 login 事件，这里补一次，否则 index.json 建不出来
status.sessionId = currentSessionId(ownerUserId())
status.sessionDate = readSession(ownerUserId()).date ?? ''

// 表情包清单：把 stickers\ 的现状同步进 AGENTS.md（模型靠它知道自己有哪些图可发）
try {
  const synced = syncStickerManifest()
  status.stickers = { count: synced.count, synced: synced.changed === true, error: synced.ok ? '' : synced.error }
  log('stickers_synced', status.stickers)
} catch (err) {
  status.stickers = { count: 0, synced: false, error: String(err?.message ?? err) }
  log('stickers_sync_failed', { error: String(err?.message ?? err) })
}

// B站日报：插件可能在任何时刻写报告，所以启动就开始盯（每分钟一次）
startBiliTimer()

// 同一天内重启（start.cmd 守护循环拉起）时，把今天的用量和计数接上，别清零
try {
  const prev = JSON.parse(readFileSync(statusFile, 'utf8'))
  status.lastInboundAt = prev?.lastInboundAt ?? ''    // 时间感要用，跨天/跨重启都留着
  status.lastInboundText = prev?.lastInboundText ?? ''
  if (prev?.usage?.date === today()) {
    status.usage = { ...status.usage, ...prev.usage }
    status.counters = { ...status.counters, ...(prev.counters ?? {}) }
    status.budgetWarnedDate = prev.budgetWarnedDate ?? ''
    if (prev.paused) { paused = true; status.paused = true }
  }
} catch { /* 首次启动 */ }
status.paused = paused
writeStatus()

const cleaned = cleanLogs()
if (cleaned) log('logs_cleaned', { removed: cleaned, keepDays: cfg.log.keepDays })

// 管理台（阶段 D-2）：起不来只记日志，绝不影响聊天
let adminServer = null

/**
 * 重启：以退出码 42 退出。
 * 42 是约定 —— start.cmd 看到 42 就知道这是「主动重载」而不是崩溃，会立刻拉起来（约 3 秒）。
 */
function restart(reason) {
  log('restart', { reason })
  status.online = false
  status.processing = false
  status.paused = paused
  writeStatus()
  releaseLock()
  try { channel.stop() } catch { /* 本来就没跑 */ }
  setTimeout(() => process.exit(42), 300)
}

/** 主动停止：退出码 0 —— start.cmd 的守护循环看到 0 就不再拉起。 */
function quit(reason) {
  log('quit', { reason })
  status.online = false
  status.processing = false
  status.paused = paused
  writeStatus()
  releaseLock()
  try { channel.stop() } catch { /* ignore */ }
  try { adminServer?.close() } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300)
}

if (cfg.admin?.enabled !== false) {
  startAdmin({
    root: ROOT,
    home: HOME,
    cfg,
    log,
    getStatus: () => status,
    getPaused: () => paused,
    actions: {
      restart,
      quit,
      setPaused,
      newSession: (by) => newSession(by || 'admin'),
      distill: (date) => spawnDistill(date),
      rebuildMemory,
      testKey: testApiKey,
    },
  }).then((r) => { adminServer = r }).catch((err) => {
    log('admin_failed', { error: String(err?.message ?? err) })
  })
}

/**
 * 登录循环：二维码约 90 秒过期，过期就自动取一张新的重来。
 * 页面会自我刷新，所以主人随时扫最新那张都行。
 */
async function loginUntilConfirmed(maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const r = await channel.startLogin()
    if (r?.status === 'confirmed') return r
    log('login_retry', { attempt, result: r?.status ?? 'unknown' })
    console.log(`二维码${r?.status === 'expired' ? '过期' : '超时'}，正在换一张新的……（第 ${attempt} 次）`)
    await new Promise((r2) => setTimeout(r2, 1500))
  }
  return null
}

if (!channel.online) {
  console.log('本地没有 token，开始扫码登录……')
  const r = await loginUntilConfirmed()
  if (!r) {
    log('login_aborted', { attempts: 20 })
    console.error('连续 20 张二维码都没扫上，退出。要重来就再启动一次。')
    releaseLock()
    process.exit(2)
  }
}
status.online = true
status.botId = store.botId
status.ownerUserId = store.ownerUserId
status.token = String(store.token).slice(0, 8)
writeStatus()
console.log(`已登录：bot=${store.botId} owner=${store.ownerUserId}`)
console.log(`二维码/日志目录：${LOGS}`)
console.log('开始长轮询收消息（Ctrl+C 退出）……')

// 记忆蒸馏：启动时先查一次（补上关机期间跨过的天），之后每 5 分钟查一次
maybeDistill()
setInterval(maybeDistill, 5 * 60 * 1000).unref()

channel.start()

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutdown', { signal: sig })
    channel.stop()
    try { adminServer?.close() } catch { /* ignore */ }
    status.online = false
    status.processing = false
    status.paused = paused
    writeStatus()
    releaseLock()
    process.exit(0)
  })
}
