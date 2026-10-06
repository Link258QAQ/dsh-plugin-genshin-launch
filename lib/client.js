// 浏览器半侧：网页右下角的「原神，启动！」面板。
// 由宿主插件通过 /dsh-genshin-launch/client.js 提供，并被注入 index.html。
// 刻意写成无依赖的原生脚本：不需要客户端构建链，改完刷新页面就生效。
//
// 关闭行为（谁先到算谁）：
//   1. 点右上角 ×；
//   2. 到达终态（下载完成 / 失败 / 已打开链接）后，底部倒计时进度条走完 20 秒自动关闭；
//   3. 宿主把插件禁用（phase=disabled）时立即移除。
// 下载/解析进行中不会自动关，只有到终态才开始倒计时。
;(() => {
  'use strict'

  const STATUS_URL = '/dsh-genshin-launch/status'
  const POLL_MS = 1500
  const PANEL_ID = 'dsh-genshin-launch-panel'
  const TERMINAL_PHASES = new Set(['done', 'failed', 'no-link', 'opened-link', 'opened-fallback'])
  if (window.__dshGenshinLaunchLoaded) return
  window.__dshGenshinLaunchLoaded = true

  const state = {
    countdownMs: 20000,
    pollHandle: null,
    tickHandle: null,
    stopped: false,
  }

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
      'padding:12px 14px 14px',
      'border-radius:12px',
      'background:linear-gradient(160deg,rgba(20,24,38,.96),rgba(38,32,22,.96))',
      'border:1px solid rgba(226,192,120,.55)',
      'box-shadow:0 10px 30px rgba(0,0,0,.45)',
      'color:#f3ead6',
      'font:12px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif',
      'backdrop-filter:blur(6px)',
      'pointer-events:auto',
      'overflow:hidden',
    ].join(';')

    // 右上角关闭按钮
    const close = document.createElement('button')
    close.type = 'button'
    close.title = '关闭'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '×'
    close.style.cssText = [
      'position:absolute',
      'top:6px',
      'right:8px',
      'width:20px',
      'height:20px',
      'padding:0',
      'border:0',
      'border-radius:50%',
      'background:transparent',
      'color:#f6dc9c',
      'font-size:16px',
      'line-height:18px',
      'cursor:pointer',
      'opacity:.75',
    ].join(';')
    close.addEventListener('mouseenter', () => {
      close.style.opacity = '1'
      close.style.background = 'rgba(246,220,156,.16)'
    })
    close.addEventListener('mouseleave', () => {
      close.style.opacity = '.75'
      close.style.background = 'transparent'
    })
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      dismiss()
    })

    // 内容区（每次轮询整体重绘）
    const body = document.createElement('div')
    body.id = `${PANEL_ID}-body`

    // 底部倒计时进度条：到终态后走完即自动关闭
    const bar = document.createElement('div')
    bar.id = `${PANEL_ID}-countdown`
    bar.style.cssText = [
      'position:absolute',
      'left:0',
      'right:0',
      'bottom:0',
      'height:3px',
      'background:rgba(255,255,255,.12)',
      'opacity:0',
      'transition:opacity .2s',
    ].join(';')
    const fill = document.createElement('div')
    fill.id = `${PANEL_ID}-countdown-fill`
    fill.style.cssText = 'height:100%;width:100%;background:linear-gradient(90deg,#e2c078,#f6dc9c);transition:width .1s linear'
    bar.appendChild(fill)

    panel.append(close, body, bar)
    document.body.appendChild(panel)
    return panel
  }

  /** 关掉面板：停轮询、清倒计时、摘掉 DOM。 */
  function dismiss() {
    if (state.stopped) return
    state.stopped = true
    if (state.tickHandle) clearInterval(state.tickHandle)
    if (state.pollHandle) clearInterval(state.pollHandle)
    state.tickHandle = null
    state.pollHandle = null
    const panel = document.getElementById(PANEL_ID)
    if (panel) panel.remove()
    window.__dshGenshinLaunchLoaded = false
  }

  /** 到终态：底部进度条开始倒计时，走完自动关闭。 */
  function startCountdown() {
    if (state.tickHandle) return
    const bar = document.getElementById(`${PANEL_ID}-countdown`)
    const fill = document.getElementById(`${PANEL_ID}-countdown-fill`)
    if (bar) bar.style.opacity = '1'
    if (fill) fill.style.width = '100%'
    const startedAt = Date.now()
    state.tickHandle = setInterval(() => {
      const left = Math.max(0, state.countdownMs - (Date.now() - startedAt))
      if (fill) fill.style.width = `${(left / state.countdownMs) * 100}%`
      if (left <= 0) dismiss()
    }, 100)
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

  const PHASE_TEXT = {
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
  }

  function render(status) {
    ensurePanel()
    const body = document.getElementById(`${PANEL_ID}-body`)
    if (!body) return

    const terminal = TERMINAL_PHASES.has(status.phase)
    const percent = typeof status.percent === 'number' ? Math.max(0, Math.min(100, status.percent)) : undefined
    const rejected = Array.isArray(status.rejected) ? status.rejected.length : 0
    const seconds = Math.max(1, Math.round(state.countdownMs / 1000))

    const rows = []
    rows.push('<div style="font-size:14px;font-weight:700;letter-spacing:.06em;color:#f6dc9c;padding-right:18px">原神，启动！</div>')
    rows.push(`<div style="opacity:.75;margin-top:2px">DSH 端口 <b style="color:#f6dc9c">${status.endpoint && status.endpoint.port ? status.endpoint.port : '未知'}</b></div>`)
    rows.push(`<div style="margin-top:6px">${escapeHtml(rejected && status.phase === 'no-link' ? `安全校验拒绝了 ${rejected} 条链接` : (PHASE_TEXT[status.phase] ?? status.phase))}</div>`)
    if (status.message && status.message !== PHASE_TEXT[status.phase]) rows.push(`<div style="opacity:.7">${escapeHtml(status.message)}</div>`)
    if (rejected) rows.push('<div style="margin-top:4px;color:#ffd9a0;opacity:.9">体积与 224MB 预期相差超过 50MB 的链接已被整条拒绝</div>')
    if (percent !== undefined && !terminal) {
      rows.push(
        '<div style="margin-top:8px;height:6px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden">' +
          `<div style="height:100%;width:${percent.toFixed(1)}%;background:linear-gradient(90deg,#e2c078,#f6dc9c);transition:width .4s"></div></div>`,
      )
    }
    if (status.downloaded) rows.push(`<div style="opacity:.7;margin-top:4px">${humanSize(status.downloaded)} / ${status.size ? humanSize(status.size) : '未知大小'}</div>`)
    if (status.fileName) rows.push(`<div style="opacity:.7;margin-top:2px;word-break:break-all">桌面：${escapeHtml(status.fileName)}</div>`)
    if (status.error) rows.push(`<div style="margin-top:6px;color:#ffb4a2;word-break:break-all">${escapeHtml(String(status.error))}</div>`)
    if (terminal) rows.push(`<div style="opacity:.55;margin-top:8px;font-size:11px">${seconds} 秒后自动关闭 · 点右上角 × 立即关闭</div>`)

    body.innerHTML = rows.join('')
    if (terminal) startCountdown()
  }

  let ticks = 0
  let maxTicks = 200

  async function poll() {
    ticks += 1
    // 兜底：万一一直没到终态，最多显示到 noticeSeconds 的 4 倍就收掉
    if (ticks > maxTicks) {
      dismiss()
      return
    }
    try {
      const response = await fetch(STATUS_URL, { cache: 'no-store' })
      if (!response.ok) return
      const status = await response.json()
      if (typeof status.noticeSeconds === 'number' && status.noticeSeconds > 0) {
        state.countdownMs = status.noticeSeconds * 1000
        maxTicks = Math.ceil((state.countdownMs * 4) / POLL_MS)
      }
      if (status.phase === 'disabled') {
        dismiss()
        return
      }
      render(status)
    } catch {
      /* 宿主还没起来或已退出：静默重试 */
    }
  }

  function start() {
    ensurePanel()
    poll()
    state.pollHandle = setInterval(poll, POLL_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
