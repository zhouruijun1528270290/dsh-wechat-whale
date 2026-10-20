// 把登录二维码渲染成一个可以直接双击打开的本地网页。
// 之所以不用 qrcode 依赖：插件保持零运行时依赖；
// qrcode_img_content 本身是一个「网页 URL」，需要被编码成二维码给手机扫。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const QR_IMAGE_SERVICE = 'https://api.qrserver.com/v1/create-qr-code/'

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

/**
 * 写一个包含二维码的 HTML 文件。
 * @param {string} target   要写出的 html 路径
 * @param {string} qrUrl    二维码要承载的内容（iLink 返回的 qrcode_img_content）
 * @param {{status?: string, note?: string}} [meta]
 * @returns {{html: string, imageUrl: string}}
 */
export function writeQrPage(target, qrUrl, meta = {}) {
  const imageUrl = `${QR_IMAGE_SERVICE}?size=420x420&margin=16&data=${encodeURIComponent(qrUrl)}`
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>DSH 微信 Bot 登录</title>
<style>
  body{font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:40px;
       background:#111418;color:#e6e6e6;display:flex;flex-direction:column;align-items:center;gap:16px}
  .card{background:#1b1f24;border:1px solid #2b3138;border-radius:14px;padding:28px 32px;text-align:center;max-width:560px}
  h1{font-size:19px;margin:0 0 6px}
  p{margin:6px 0;color:#a9b1ba;font-size:14px}
  .status{font-weight:600;color:#7fd1a8}
  img{background:#fff;border-radius:10px;padding:10px;margin:14px 0;width:420px;height:420px}
  code{display:block;word-break:break-all;background:#0d1013;border:1px solid #2b3138;border-radius:8px;
       padding:10px;font-size:12px;color:#8ab4f8;margin-top:10px}
  .hint{color:#e0b062;font-size:13px}
</style></head><body>
<div class="card">
  <h1>用微信扫描下面的二维码</h1>
  <p>扫码后手机上点确认，这个窗口就可以关掉了。</p>
  <p>当前状态：<span class="status">${escapeHtml(meta.status ?? 'wait')}</span></p>
  <img src="${imageUrl}" alt="登录二维码">
  ${meta.note ? `<p class="hint">${escapeHtml(meta.note)}</p>` : ''}
  <p>二维码加载不出来（离线或图床被墙）时，用任意二维码工具编码下面这段内容：</p>
  <code>${escapeHtml(qrUrl)}</code>
</div>
</body></html>
`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, html, 'utf8')
  return { html: target, imageUrl }
}
