// 微信 ClawBot / iLink 官方机器人协议的客户端 + 长轮询通道 + 本地状态存储。
// 零运行时依赖，只用 Node 内置模块与全局 fetch（Node >= 22）。
//
// 协议事实（社区文档 + 官方 @tencent-weixin/openclaw-weixin 实现交叉确认）：
//   基座        https://ilinkai.weixin.qq.com
//   取二维码    POST /ilink/bot/get_bot_qrcode?bot_type=3
//   扫码状态    GET  /ilink/bot/get_qrcode_status?qrcode=<token>[&verify_code=<digits>]
//   收消息      POST /ilink/bot/getupdates        （35s 长轮询，靠 get_updates_buf 游标）
//   发消息      POST /ilink/bot/sendmessage       （必须回传 context_token）
//   拉配置      POST /ilink/bot/getconfig         （拿 typing_ticket）
//   输入中      POST /ilink/bot/sendtyping        （status 1=开始 2=结束）
//   生命周期    POST /ilink/bot/msg/notifystart | notifystop
//   发图片      POST /ilink/bot/getuploadurl  →  POST <cdn>/c2c/upload  →  POST /ilink/bot/sendmessage
//               （图片先 AES-128-ECB 加密再传 CDN，发消息时带 image_item）
// 关键约束：单条消息上限约 2000 字符；ret/errcode = -14 表示会话过期，要清游标重扫码。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CHANNEL_VERSION = '1.0.0'
export const MAX_CHUNK_CHARS = 2000
// 图片走 CDN：入站 item 给的是「加密查询参数 + AES 密钥」，不是内联字节。
export const IMAGE_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_CDN_HOST = 'novac2c.cdn.weixin.qq.com'
const APP_ID = 'bot'
const APP_CLIENT_VERSION = '1'
const SEEN_RING = 200
const STALE_TOKEN_CODE = -14

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** X-WECHAT-UIN：每次请求随机，值是「uint32 十进制字符串」的 base64。 */
function randomUin() {
  const n = Math.floor(Math.random() * 0xffffffff) >>> 0
  return Buffer.from(String(n), 'utf8').toString('base64')
}

export function newClientId(tag = 'dsh-wechat') {
  return `${tag}:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

/** 按字符数分片，优先在换行处断开（微信单条上限约 2000 字符）。 */
export function chunkText(text, maxChars = MAX_CHUNK_CHARS) {
  const src = String(text ?? '')
  if (src.length <= maxChars) return src ? [src] : []
  const out = []
  let rest = src
  while (rest.length > maxChars) {
    let cut = maxChars
    const nl = rest.lastIndexOf('\n', cut)
    if (nl > cut * 0.5) cut = nl + 1
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

// ── 图片入站：解析 / 下载 / 解密 ────────────────────────────────────────────
// 逻辑与 dsh-im 的 src/channels/weixin/weixin-api.mjs:128-206 一致（社区实测形状）：
//   image_item.aeskey            = 32 位 hex（直接给密钥）
//   image_item.media.aes_key     = base64；解出来 16 字节 = 原始密钥；解出来 32 hex 字符 = 密钥的 hex 文本
//   image_item.media.encrypt_query_param → https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=…
//   image_item.media.full_url    → 同域 /c2c/ 开头的备用直链
// 拿到密文后用 AES-128-ECB（无 IV）解密即得原图字节。

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 从 image_item 里取出 16 字节 AES 密钥。 */
export function parseImageAesKey(imageItem) {
  const directHex = nonEmptyString(imageItem?.aeskey)
  if (directHex) {
    if (!/^[0-9a-fA-F]{32}$/.test(directHex)) throw new IlinkError('图片的 aeskey 不是 32 位 hex', 'invalid-image-key')
    return Buffer.from(directHex, 'hex')
  }
  const raw = nonEmptyString(imageItem?.media?.aes_key)
  const encoded = raw && raw.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, 'base64') : null
  if (encoded?.length === 16) return encoded
  if (encoded?.length === 32 && /^[0-9a-fA-F]{32}$/.test(encoded.toString('ascii'))) {
    return Buffer.from(encoded.toString('ascii'), 'hex')
  }
  throw new IlinkError('图片的加密密钥无效（aeskey / media.aes_key 都读不出 16 字节）', 'invalid-image-key')
}

/** 图片下载地址（只信任微信 CDN 域）。 */
export function imageDownloadUrl(media) {
  const query = nonEmptyString(media?.encrypt_query_param)
  if (query) return `${IMAGE_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(query)}`
  const full = nonEmptyString(media?.full_url)
  if (!full) throw new IlinkError('图片没有可用的下载地址', 'missing-image-url')
  let url
  try {
    url = new URL(full)
  } catch {
    throw new IlinkError('图片下载地址不是合法 URL', 'invalid-image-url')
  }
  if (url.protocol !== 'https:' || url.hostname !== IMAGE_CDN_HOST
    || (url.port && url.port !== '443') || !url.pathname.startsWith('/c2c/')) {
    throw new IlinkError(`图片下载地址不受信任：${url.host}`, 'untrusted-image-url')
  }
  url.username = ''; url.password = ''; url.hash = ''
  return url.toString()
}

/** AES-128-ECB 解密（微信图片用 ECB、无 IV、PKCS#7 填充）。 */
export function decryptImage(ciphertext, key) {
  const enc = Buffer.from(ciphertext)
  const aesKey = Buffer.from(key)
  if (aesKey.length !== 16) throw new IlinkError('AES 密钥长度不是 16 字节', 'invalid-image-key')
  if (!enc.length || enc.length % 16 !== 0) throw new IlinkError(`密文长度非法：${enc.length}`, 'invalid-image-ciphertext')
  try {
    const d = createDecipheriv('aes-128-ecb', aesKey, null)
    return Buffer.concat([d.update(enc), d.final()])
  } catch (err) {
    throw new IlinkError(`图片解密失败：${err?.message ?? err}`, 'image-decryption-failed')
  }
}

/** 按魔数认图片类型（微信不给扩展名）。 */
export function sniffImage(buf) {
  const b = Buffer.from(buf)
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { ext: 'gif', mime: 'image/gif' }
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' }
  return { ext: 'bin', mime: 'application/octet-stream' }
}

/** 下载 + 解密一张入站图片；返回原始字节（**不落盘**，落盘由调用方按自己的白名单做）。 */
export async function fetchImage(imageItem, { maxBytes = MAX_IMAGE_BYTES, timeoutMs = 30000 } = {}) {
  const key = parseImageAesKey(imageItem)
  const url = imageDownloadUrl(imageItem?.media)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let ciphertext
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal })
    if (!res.ok) throw new IlinkError(`图片下载失败 HTTP ${res.status}`, 'file-download-failed')
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len && len > maxBytes + 16) throw new IlinkError(`图片太大：${len} 字节`, 'image-too-large')
    ciphertext = Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
  if (ciphertext.length > maxBytes + 16) throw new IlinkError(`图片太大：${ciphertext.length} 字节`, 'image-too-large')
  const bytes = decryptImage(ciphertext, key)
  const { ext, mime } = sniffImage(bytes)
  return { bytes, ext, mime, url, cipherBytes: ciphertext.length }
}

// ---------------------------------------------------------------- 发出图片

export const MAX_OUT_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * 发出去语音的上限。
 * 微信语音本来就是短气泡，2 MiB 的 16 位 24kHz 单声道 PCM 大约 40 秒，足够。
 */
export const MAX_OUT_VOICE_BYTES = 2 * 1024 * 1024

/**
 * 解析 16 位 PCM 单声道 WAV，拿出发语音要声明的 sample_rate / playtime。
 *
 * 只认 `audioFormat = 1`（PCM）且 16 位 —— 微信语音的标准编码是 SILK（encode_type 6），
 * 我们没有 SILK 编码器，只能拿 PCM 去试；能不能播要真机看，所以这里把字段都读准，方便失败时定位。
 * 结构不对就抛错，不猜。
 */
export function parsePcmWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.byteLength < 44) throw new IlinkError('语音文件太小，不像 WAV', 'invalid-wav')
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new IlinkError('语音文件不是 WAV（缺 RIFF/WAVE 头）', 'invalid-wav')
  }
  let off = 12
  let fmt = null
  let dataSize = 0
  while (off + 8 <= buf.byteLength) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      dataSize = Math.min(size, buf.byteLength - off - 8)
    }
    off += 8 + size + (size % 2) // 块按偶数字节对齐
  }
  if (!fmt) throw new IlinkError('WAV 里找不到 fmt 块', 'invalid-wav')
  if (fmt.audioFormat !== 1) throw new IlinkError(`只支持未压缩 PCM，收到 audioFormat=${fmt.audioFormat}`, 'unsupported-wav')
  if (fmt.bitsPerSample !== 16) throw new IlinkError(`只支持 16 位，收到 ${fmt.bitsPerSample} 位`, 'unsupported-wav')
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataBytes: dataSize,
    playtimeMs: Math.round((dataSize / bytesPerSec) * 1000),
  }
}


/** AES-ECB 加密 + PKCS#7 之后的字节数（与 node 的 createCipheriv 默认行为一致）。 */
export function aesEcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16
}

/** 用 AES-128-ECB 加密（createCipheriv 自带 PKCS#7 填充，不要再手动补）。 */
export function encryptForUpload(bytes, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(bytes), cipher.final()])
}

function trustedUploadUrl(value, fileKey) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new IlinkError('微信返回了无效的图片上传地址', 'invalid-upload-url')
  }
  if (url.protocol !== 'https:' || url.hostname !== IMAGE_CDN_HOST
    || (url.port && url.port !== '443') || url.pathname !== '/c2c/upload'
    || url.username || url.password) {
    throw new IlinkError('微信返回了不受信任的图片上传地址', 'untrusted-upload-url')
  }
  url.hash = ''
  return url
}

function cdnUploadUrl(response, fileKey) {
  const full = nonEmptyString(response?.upload_full_url)
  if (full) return trustedUploadUrl(full, fileKey)
  const param = nonEmptyString(response?.upload_param)
  if (!param) throw new IlinkError('微信没有返回图片上传地址', 'missing-upload-url')
  const url = new URL(`${IMAGE_CDN_BASE_URL}/upload`)
  url.searchParams.set('encrypted_query_param', param)
  url.searchParams.set('filekey', fileKey)
  return trustedUploadUrl(url, fileKey)
}

export class IlinkError extends Error {
  constructor(message, code, payload) {
    super(message)
    this.name = 'IlinkError'
    this.code = code
    this.payload = payload
  }
}

// ---------------------------------------------------------------- 状态存储

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultStateFile() {
  return join(dshHome(), 'storages', 'dsh-wechat-bot', 'ilink-state.json')
}

/**
 * 落盘：token / baseUrl / 账号 id / 长轮询游标 / 最近上下文 token / 去重环。
 * 权限 0600；不做加密（与社区实现一致，属于本机凭据）。
 */
export class IlinkStore {
  constructor(file = defaultStateFile()) {
    this.file = file
    this.data = this.#load()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return { stateVersion: 1, seen: [], contexts: {}, ...parsed }
    } catch {
      return { stateVersion: 1, seen: [], contexts: {} }
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    try { chmodSync(this.file, 0o600) } catch { /* Windows 上可忽略 */ }
  }

  get token() { return this.data.token || '' }
  get baseUrl() { return this.data.baseUrl || DEFAULT_BASE_URL }
  get botId() { return this.data.botId || '' }
  get ownerUserId() { return this.data.ownerUserId || '' }
  get cursor() { return this.data.getUpdatesBuf || '' }

  get online() { return Boolean(this.data.token) }

  acceptLogin({ token, baseUrl, botId, ownerUserId }) {
    this.data.token = token
    this.data.baseUrl = baseUrl || DEFAULT_BASE_URL
    this.data.botId = botId || ''
    this.data.ownerUserId = ownerUserId || ''
    this.data.getUpdatesBuf = ''
    this.save()
  }

  clearToken() {
    delete this.data.token
    this.data.getUpdatesBuf = ''
    this.save()
  }

  setCursor(buf) {
    if (!buf || buf === this.data.getUpdatesBuf) return
    this.data.getUpdatesBuf = buf
    this.save()
  }

  /** 去重：返回 true 表示这条消息没见过。 */
  markSeen(id) {
    const key = String(id ?? '')
    if (!key) return true
    const seen = this.data.seen ?? []
    if (seen.includes(key)) return false
    seen.push(key)
    while (seen.length > SEEN_RING) seen.shift()
    this.data.seen = seen
    this.save()
    return true
  }

  rememberContext(windowKey, contextToken) {
    if (!contextToken) return
    this.data.contexts = this.data.contexts ?? {}
    if (this.data.contexts[windowKey] === contextToken) return
    this.data.contexts[windowKey] = contextToken
    this.save()
  }

  contextFor(windowKey) {
    return this.data.contexts?.[windowKey] || ''
  }
}

// ---------------------------------------------------------------- 协议客户端

export class IlinkApi {
  constructor({ baseUrl = DEFAULT_BASE_URL, token = '', logger } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.token = token
    this.log = logger ?? (() => {})
  }

  setToken(token) { this.token = token ?? '' }
  setBaseUrl(baseUrl) { this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') }

  #headers() {
    const headers = {
      'content-type': 'application/json',
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': APP_CLIENT_VERSION,
      'SKRouteTag': '1001',
      'X-WECHAT-UIN': randomUin(),
    }
    if (this.token) {
      headers.AuthorizationType = 'ilink_bot_token'
      headers.Authorization = `Bearer ${this.token}`
    }
    return headers
  }

  async #send(method, path, { body, timeoutMs = 20000 } = {}) {
    const url = `${this.baseUrl}/${String(path).replace(/^\/+/, '')}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: this.#headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let json
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        throw new IlinkError(`iLink 返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200)}`, undefined, text)
      }
      const code = json?.errcode ?? json?.ret
      if (code !== undefined && code !== null && code !== 0) {
        throw new IlinkError(`iLink 错误 ${code}${json.errmsg ? `：${json.errmsg}` : ''}`, code, json)
      }
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  getBotQrcode() {
    return this.#send('POST', 'ilink/bot/get_bot_qrcode?bot_type=3', { timeoutMs: 20000 })
  }

  getQrcodeStatus(qrcode, verifyCode) {
    const qs = new URLSearchParams({ qrcode: String(qrcode) })
    if (verifyCode) qs.set('verify_code', String(verifyCode))
    return this.#send('GET', `ilink/bot/get_qrcode_status?${qs.toString()}`, { timeoutMs: 40000 })
  }

  getUpdates(buf, timeoutMs = 40000) {
    return this.#send('POST', 'ilink/bot/getupdates', {
      timeoutMs,
      body: {
        get_updates_buf: buf ?? '',
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
  }

  getConfig(ilinkUserId, contextToken) {
    return this.#send('POST', 'ilink/bot/getconfig', {
      body: {
        ilink_user_id: ilinkUserId,
        ...(contextToken ? { context_token: contextToken } : {}),
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
  }

  sendTyping({ ilinkUserId, typingTicket, status }) {
    return this.#send('POST', 'ilink/bot/sendtyping', {
      body: {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
  }

  sendMessage({ toUserId, contextToken, text, clientId }) {
    return this.#send('POST', 'ilink/bot/sendmessage', {
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId ?? newClientId(),
          message_type: 2, // BOT
          message_state: 2, // FINISH
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: String(text) } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
  }

  /**
   * 把图片字节传到微信 CDN，返回发消息时要带的下载凭据。
   * 三步里的前两步：getuploadurl → c2c/upload（AES-128-ECB 加密后上传）。
   */
  async uploadImage({ toUserId, bytes, aesKey, fileKey, timeoutMs = 60000 }) {
    if (!Buffer.isBuffer(bytes) || !bytes.byteLength) throw new IlinkError('要上传的图片是空的', 'empty-image')
    if (bytes.byteLength > MAX_OUT_IMAGE_BYTES) {
      throw new IlinkError(`图片太大：${bytes.byteLength} 字节（上限 ${MAX_OUT_IMAGE_BYTES}）`, 'image-too-large')
    }
    const up = await this.#send('POST', 'ilink/bot/getuploadurl', {
      timeoutMs,
      body: {
        filekey: fileKey,
        media_type: 1, // 1 = 图片
        to_user_id: toUserId,
        rawsize: bytes.byteLength,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: aesEcbPaddedSize(bytes.byteLength),
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
    const url = cdnUploadUrl(up, fileKey)
    const ciphertext = encryptForUpload(bytes, aesKey)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(ciphertext.byteLength),
        },
        body: ciphertext,
        redirect: 'error',
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (res.status !== 200) {
      throw new IlinkError(`图片上传失败（HTTP ${res.status}）`, 'upload-failed', { status: res.status })
    }
    const downloadParam = nonEmptyString(res.headers.get('x-encrypted-param'))
    if (!downloadParam) throw new IlinkError('图片上传响应缺少 x-encrypted-param', 'invalid-upload-response')
    return { downloadParam, ciphertextSize: ciphertext.byteLength }
  }

  /** 三步里的第三步：发一条 image_item 消息（必须带 context_token）。 */
  async sendImage({ toUserId, bytes, contextToken, clientId, timeoutMs = 60000 }) {
    const fileKey = randomBytes(16).toString('hex')
    const aesKey = randomBytes(16)
    const { downloadParam, ciphertextSize } = await this.uploadImage({ toUserId, bytes, aesKey, fileKey, timeoutMs })
    return this.#send('POST', 'ilink/bot/sendmessage', {
      timeoutMs,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId ?? newClientId('dsh-wechat-img'),
          message_type: 2, // BOT
          message_state: 2, // FINISH
          context_token: contextToken,
          item_list: [{
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                // 注意：是 base64(密钥的 hex 文本)，不是 base64(16 字节密钥)
                aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
                encrypt_type: 1,
              },
              mid_size: ciphertextSize,
            },
          }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
  }

  /**
   * 把语音字节传到微信 CDN（media_type = 4），返回发消息时要带的下载凭据。
   *
   * ⚠️ 出站语音是协议的灰区：官方 openclaw 实现只做了接收/下载，没有验证过发送。
   * 能不能在微信里播出来要真机看，所以这里不做任何"应该能行"的假设。
   */
  async uploadVoice({ toUserId, bytes, aesKey, fileKey, timeoutMs = 60000 }) {
    if (!Buffer.isBuffer(bytes) || !bytes.byteLength) throw new IlinkError('要上传的语音是空的', 'empty-voice')
    if (bytes.byteLength > MAX_OUT_VOICE_BYTES) {
      throw new IlinkError(`语音太大：${bytes.byteLength} 字节（上限 ${MAX_OUT_VOICE_BYTES}）`, 'voice-too-large')
    }
    const up = await this.#send('POST', 'ilink/bot/getuploadurl', {
      timeoutMs,
      body: {
        filekey: fileKey,
        media_type: 4, // 4 = 语音
        to_user_id: toUserId,
        rawsize: bytes.byteLength,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: aesEcbPaddedSize(bytes.byteLength),
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
    const url = cdnUploadUrl(up, fileKey)
    const ciphertext = encryptForUpload(bytes, aesKey)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(ciphertext.byteLength),
        },
        body: ciphertext,
        redirect: 'error',
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (res.status !== 200) {
      throw new IlinkError(`语音上传失败（HTTP ${res.status}）`, 'upload-failed', { status: res.status })
    }
    const downloadParam = nonEmptyString(res.headers.get('x-encrypted-param'))
    if (!downloadParam) throw new IlinkError('语音上传响应缺少 x-encrypted-param', 'invalid-upload-response')
    return { downloadParam, ciphertextSize: ciphertext.byteLength }
  }

  /** 发一条 voice_item 消息（type = 3）。`encodeType` 默认 1 = pcm。 */
  async sendVoice({
    toUserId,
    bytes,
    contextToken,
    sampleRate = 24000,
    playtimeMs = 0,
    encodeType = 1,
    bitsPerSample = 16,
    clientId,
    timeoutMs = 60000,
    voiceItemExtra, // 只在真机探协议时用：往 voice_item 里补字段试探客户端要什么
  }) {
    const fileKey = randomBytes(16).toString('hex')
    const aesKey = randomBytes(16)
    const { downloadParam } = await this.uploadVoice({ toUserId, bytes, aesKey, fileKey, timeoutMs })
    return this.#send('POST', 'ilink/bot/sendmessage', {
      timeoutMs,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId ?? newClientId('dsh-wechat-voice'),
          message_type: 2, // BOT
          message_state: 2, // FINISH
          context_token: contextToken,
          item_list: [{
            type: 3,
            voice_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
                encrypt_type: 1,
              },
              encode_type: encodeType,
              bits_per_sample: bitsPerSample,
              sample_rate: sampleRate,
              playtime: Math.max(1, Math.round(Number(playtimeMs) || 0)),
              ...(voiceItemExtra ?? {}),
            },
          }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
    })
  }

  notify(action) {
    const path = action === 'start' ? 'ilink/bot/msg/notifystart' : 'ilink/bot/msg/notifystop'
    return this.#send('POST', path, { body: { base_info: { channel_version: CHANNEL_VERSION } } })
  }
}

// ---------------------------------------------------------------- 长轮询通道

/**
 * 从任意结构里递归捞出 http(s) 链接（分享卡片的正文常常藏在嵌套字段里）。
 * 只保留看起来像「页面地址」的，去掉明显的图片/静态资源后缀。
 */
export function harvestUrls(value, { max = 6 } = {}) {
  const out = []
  const seen = new Set()
  const BAD = /\.(png|jpe?g|gif|webp|bmp|ico|svg|mp4|m4a|mp3|wav|css|js)(\?|#|$)/i
  const walk = (v, depth) => {
    if (!v || depth > 12 || out.length >= max) return
    if (typeof v === 'string') {
      // 链接里不会出现中文，遇到中文标点/汉字就截断（微信分享文案常是「链接，然后一句话」）
      const hits = v.match(/https?:\/\/[^\s"'<>\\，。；：、（）【】「」『』！？…]+/g) || []
      for (const raw of hits) {
        const url = raw.replace(/[),.;，。；：）】」』]+$/, '')
        if (BAD.test(url)) continue
        const key = url.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(url)
        if (out.length >= max) return
      }
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (typeof v === 'object') {
      for (const x of Object.values(v)) walk(x, depth + 1)
    }
  }
  walk(value, 0)
  return out
}

/**
 * 事件：
 *   'message' { windowKey, userId, text, contextToken, messageId, shared? }
 *   'image'  { windowKey, userId, contextToken, messageId, count, items, load }
 *   'unsupported' { windowKey, userId, types, messageId, items }
 *   'login'  { botId, ownerUserId }
 *   'logout' { reason }
 *   'scan'   { status, qrcodeUrl }
 *   'error'  Error
 */
export class IlinkChannel extends EventEmitter {
  constructor({ api, store, logger } = {}) {
    super()
    this.api = api
    this.store = store
    this.log = logger ?? (() => {})
    this.running = false
    this.loggingIn = false
    this.abort = null
    this.typingTickets = new Map()
  }

  get online() { return this.store.online }

  /** 首次使用：取二维码 → 轮询扫码状态 → 落盘凭证。返回二维码内容供渲染。 */
  async startLogin({ timeoutMs = 300000 } = {}) {
    const qr = await this.api.getBotQrcode()
    const qrcode = qr.qrcode ?? qr.qrcode_token ?? qr.qrcode_id
    const qrUrl = qr.qrcode_img_content ?? qr.qrcode_url ?? ''
    if (!qrcode) throw new IlinkError('取二维码失败：响应里没有 qrcode 字段', undefined, qr)
    this.emit('scan', { status: 'wait', qrcodeUrl: qrUrl, qrcode })
    this.log('请扫码登录（二维码内容已渲染到本地网页）')

    const deadline = Date.now() + timeoutMs
    this.loggingIn = true
    let lastStatus = ''
    try {
      while (this.loggingIn && Date.now() < deadline) {
        let status
        try {
          status = await this.api.getQrcodeStatus(qrcode)
        } catch (err) {
          if (err?.name === 'AbortError') continue // 客户端本地超时 = 继续等
          throw err
        }
        const state = status?.status ?? 'wait'
        if (state !== lastStatus) {
          lastStatus = state
          this.emit('scan', { status: state, qrcodeUrl: qrUrl, qrcode })
          this.log(`扫码状态：${state}`)
        }
        if (state === 'confirmed') {
          this.api.setToken(status.bot_token)
          this.api.setBaseUrl(status.baseurl || status.base_url || this.api.baseUrl)
          this.store.acceptLogin({
            token: status.bot_token,
            baseUrl: status.baseurl || status.base_url,
            botId: status.ilink_bot_id,
            ownerUserId: status.ilink_user_id,
          })
          this.log(`登录成功：bot=${status.ilink_bot_id} owner=${status.ilink_user_id}`)
          this.emit('login', { botId: status.ilink_bot_id, ownerUserId: status.ilink_user_id })
          return { status: 'confirmed', ...status }
        }
        if (state === 'expired') return { status: 'expired' }
        if (state === 'need_verifycode' || state === 'verify_code_blocked') {
          this.emit('scan', { status: state, qrcodeUrl: qrUrl, qrcode })
          this.log('微信要求输入验证码，请手动处理后再继续（见 README「排错」）')
        }
        await sleep(2000)
      }
    } finally {
      this.loggingIn = false
    }
    return { status: 'timeout' }
  }

  start() {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    this.loop().catch((err) => this.emit('error', err))
  }

  stop() {
    this.running = false
    this.loggingIn = false
    this.abort?.abort()
  }

  async loop() {
    let failures = 0
    while (this.running) {
      try {
        const res = await this.api.getUpdates(this.store.cursor)
        failures = 0
        if (res.get_updates_buf) this.store.setCursor(res.get_updates_buf)
        for (const msg of res.msgs ?? []) this.handleInbound(msg)
      } catch (err) {
        if (!this.running) break
        if (err?.name === 'AbortError') continue // 本地超时 → 当作空轮询，立刻续上
        if (err instanceof IlinkError && err.code === STALE_TOKEN_CODE) {
          this.store.clearToken()
          this.emit('logout', { reason: 'stale-token' })
          this.log('会话已过期（-14），已清空本地游标与 token，需要重新扫码')
          await sleep(15000)
          continue
        }
        failures += 1
        this.emit('error', err)
        const backoff = Math.min(30000, 1000 * 2 ** Math.min(failures, 5))
        this.log(`轮询失败（第 ${failures} 次），${backoff}ms 后重试：${err?.message ?? err}`)
        await sleep(backoff + Math.floor(Math.random() * 500))
      }
    }
  }

  handleInbound(msg) {
    if (!msg) return
    const self = this.store.botId
    if (self && msg.from_user_id === self) return
    if (msg.message_type === 2) return // 自己发的
    const id = msg.message_id ?? msg.seq ?? msg.client_id
    if (!this.store.markSeen(id)) return

    const userId = msg.from_user_id
    const windowKey = `user:${userId}`
    const contextToken = msg.context_token ?? ''
    if (contextToken) this.store.rememberContext(windowKey, contextToken)

    const items = msg.item_list ?? []
    // 图片：只「解出来 + 抛事件」，落盘/回复由上层决定（行为与以前保持一致）。
    const images = items
      .filter((it) => it?.image_item && typeof it.image_item === 'object')
      .map((it) => it.image_item)
    if (images.length) {
      this.emit('image', {
        windowKey,
        userId,
        contextToken,
        messageId: id,
        count: images.length,
        items: images,
        load: (index = 0, opts) => fetchImage(images[index], opts),
      })
    }
    const texts = items.filter((it) => it?.type === 1 && it?.text_item?.text).map((it) => it.text_item.text)
    if (texts.length) {
      this.emit('message', { windowKey, userId, text: texts.join('\n').trim(), contextToken, messageId: id })
      return
    }
    // 分享卡片（B站视频、公众号文章、小程序…）不是文本 item，但里面带链接。
    // 把链接捞出来当普通消息交上去 —— 上层就能像收到一句话那样处理。
    // 只在「没有图片之外的 item」上捞：图片自己的 CDN 地址不能被当成分享链接。
    const urls = harvestUrls(items.filter((it) => !it?.image_item))
    if (urls.length) {
      this.emit('message', {
        windowKey,
        userId,
        text: urls.slice(0, 3).join('\n'),
        contextToken,
        messageId: id,
        shared: true,
      })
      return
    }
    this.emit('unsupported', {
      windowKey,
      userId,
      types: items.map((it) => it?.type),
      messageId: id,
      items,
    })
  }

  /** 发送文本（自动分片 + 片间限速）。 */
  async say(windowKey, text, { contextToken, maxChars = MAX_CHUNK_CHARS, gapMs = 900 } = {}) {
    const userId = windowKey.replace(/^user:/, '')
    const token = contextToken || this.store.contextFor(windowKey)
    if (!token) throw new IlinkError('缺少 context_token，无法确定要回复哪个会话窗口（等对方先说一句话）')
    const chunks = chunkText(text, maxChars)
    for (let i = 0; i < chunks.length; i += 1) {
      if (i > 0) await sleep(gapMs + Math.floor(Math.random() * 300))
      await this.api.sendMessage({ toUserId: userId, contextToken: token, text: chunks[i] })
    }
    return chunks.length
  }

  /**
   * 发一张图片。`image` 可以是文件路径，也可以是 Buffer / { bytes }。
   * 与文本不同，图片不能分片；一次调用发一张。
   */
  async sendImage(windowKey, image, { contextToken, timeoutMs = 60000 } = {}) {
    const userId = windowKey.replace(/^user:/, '')
    const token = contextToken || this.store.contextFor(windowKey)
    if (!token) throw new IlinkError('缺少 context_token，无法发图片（等对方先说一句话）')
    let bytes
    if (Buffer.isBuffer(image)) bytes = image
    else if (image && Buffer.isBuffer(image.bytes)) bytes = image.bytes
    else bytes = readFileSync(String(image))
    const { ext } = sniffImage(bytes)
    if (ext === 'bin') throw new IlinkError(`这个文件看起来不是图片：${String(image)}`, 'not-an-image')
    return this.api.sendImage({ toUserId: userId, bytes, contextToken: token, timeoutMs })
  }

  /**
   * 发一条语音。`audio` 可以是 WAV 文件路径，也可以是 Buffer / `{ bytes, sampleRate, playtimeMs }`。
   * 只认 16 位 PCM WAV（不猜、不转码）—— 微信的标准语音编码是 SILK，PCM 能不能播是灰区。
   */
  async sendVoice(windowKey, audio, { contextToken, timeoutMs = 60000 } = {}) {
    const userId = windowKey.replace(/^user:/, '')
    const token = contextToken || this.store.contextFor(windowKey)
    if (!token) throw new IlinkError('缺少 context_token，无法发语音（等对方先说一句话）')
    let bytes
    let meta = null
    if (Buffer.isBuffer(audio)) {
      bytes = audio
    } else if (audio && Buffer.isBuffer(audio.bytes)) {
      bytes = audio.bytes
      meta = audio
    } else {
      bytes = readFileSync(String(audio))
    }
    const wav = parsePcmWav(bytes)
    if (wav.channels !== 1) throw new IlinkError(`语音必须是单声道，收到 ${wav.channels} 声道`, 'unsupported-wav')
    if (wav.playtimeMs < 300) throw new IlinkError(`语音太短（${wav.playtimeMs}ms）`, 'voice-too-short')
    return this.api.sendVoice({
      toUserId: userId,
      bytes,
      contextToken: token,
      sampleRate: meta?.sampleRate ?? wav.sampleRate,
      playtimeMs: meta?.playtimeMs ?? wav.playtimeMs,
      timeoutMs,
    })
  }

  async setTyping(windowKey, on, { contextToken } = {}) {
    const userId = windowKey.replace(/^user:/, '')
    try {
      let ticket = this.typingTickets.get(userId)
      if (!ticket) {
        const cfg = await this.api.getConfig(userId, contextToken || this.store.contextFor(windowKey))
        ticket = cfg?.typing_ticket ?? cfg?.typingTicket ?? ''
        if (ticket) this.typingTickets.set(userId, ticket)
      }
      if (!ticket) return false
      await this.api.sendTyping({ ilinkUserId: userId, typingTicket: ticket, status: on ? 1 : 2 })
      return true
    } catch (err) {
      this.log(`发送「正在输入」状态失败（不影响对话）：${err?.message ?? err}`)
      return false
    }
  }
}
