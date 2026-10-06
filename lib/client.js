// 浏览器半侧：在网页右下角显示「原神，启动！」的下载进度。
// 由宿主插件通过 /dsh-genshin-launch/client.js 提供，并被注入 index.html。
// 刻意写成无依赖的原生脚本：不需要客户端构建链，HMR 之外也能直接生效。
;(() => {
  'use strict'

  const STATUS_URL = '/dsh-genshin-launch/status'
  const POLL_MS = 1500
  const PANEL_ID = 'dsh-genshin-launch-panel'
  if (window.__dshGenshinLaunchLoaded) return
  window.__dshGenshinLaunchLoaded = true

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID)
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = PANEL_ID
    panel.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483000',
      'min-width:250px',
      'max-width:340px',
      'padding:12px 14px',
      'border-radius:12px',
      'background:linear-gradient(160deg,rgba(20,24,38,.96),rgba(38,32,22,.96))',
      'border:1px solid rgba(226,192,120,.55)',
      'box-shadow:0 10px 30px rgba(0,0,0,.45)',
      'color:#f3ead6',
      'font:12px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif',
      'backdrop-filter:blur(6px)',
      'pointer-events:auto',
    ].join(';')
    document.body.appendChild(panel)
    return panel
  }

  function render(panel, status) {
    const percent = typeof status.percent === 'number' ? Math.max(0, Math.min(100, status.percent)) : undefined
    const phaseText = {
      idle: '待机',
      disabled: '已禁用',
      resolving: '正在确认最新链接…',
      'no-link': '没找到可用链接',
      resolved: '已定位安装包',
      downloading: '正在下载…',
      done: '下载完成',
      failed: '下载失败',
      'opened-link': '已打开下载链接',
      'opened-fallback': '已打开官方下载页',
    }[status.phase] ?? status.phase

    const rows = []
    rows.push(`<div style="font-size:14px;font-weight:700;letter-spacing:.06em;color:#f6dc9c">原神，启动！</div>`)
    rows.push(`<div style="opacity:.75;margin-top:2px">DSH 端口 <b style="color:#f6dc9c">${status.endpoint && status.endpoint.port ? status.endpoint.port : '未知'}</b></div>`)
    const rejected = Array.isArray(status.rejected) ? status.rejected.length : 0
    rows.push(`<div style="margin-top:6px">${escapeHtml(rejected && status.phase === 'no-link' ? `安全校验拒绝了 ${rejected} 条链接` : phaseText)}</div>`)
    if (status.message && status.message !== phaseText) rows.push(`<div style="opacity:.7">${escapeHtml(status.message)}</div>`)
    if (rejected) rows.push(`<div style="margin-top:4px;color:#ffd9a0;opacity:.9">体积与 224MB 预期相差超过 50MB 的链接已被整条拒绝</div>`)
    if (percent !== undefined) {
      rows.push(
        `<div style="margin-top:8px;height:6px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden">` +
          `<div style="height:100%;width:${percent.toFixed(1)}%;background:linear-gradient(90deg,#e2c078,#f6dc9c);transition:width .4s"></div></div>`,
      )
    }
    if (status.downloaded) rows.push(`<div style="opacity:.7;margin-top:4px">${humanSize(status.downloaded)} / ${status.size ? humanSize(status.size) : '未知大小'}</div>`)
    if (status.fileName) rows.push(`<div style="opacity:.7;margin-top:2px;word-break:break-all">桌面：${escapeHtml(status.fileName)}</div>`)
    if (status.error) rows.push(`<div style="margin-top:6px;color:#ffb4a2;word-break:break-all">${escapeHtml(String(status.error))}</div>`)
    panel.innerHTML = rows.join('')
  }

  function humanSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '未知大小'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  }

  let ticks = 0
  let maxTicks = 400
  let timer

  async function poll() {
    ticks += 1
    if (ticks > maxTicks) {
      clearInterval(timer)
      const panel = document.getElementById(PANEL_ID)
      if (panel) panel.style.display = 'none'
      return
    }
    try {
      const response = await fetch(STATUS_URL, { cache: 'no-store' })
      if (!response.ok) return
      const status = await response.json()
      if (typeof status.noticeSeconds === 'number' && status.noticeSeconds > 0) {
        maxTicks = Math.ceil((status.noticeSeconds * 1000) / POLL_MS)
      }
      const panel = ensurePanel()
      if (status.phase === 'disabled') {
        panel.remove()
        window.__dshGenshinLaunchLoaded = false
        clearInterval(timer)
        return
      }
      render(panel, status)
    } catch {
      /* 宿主还没起来或已退出：静默重试 */
    }
  }

  function start() {
    poll()
    timer = setInterval(poll, POLL_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
