// 浏览器半侧：右下角的「原神，启动！」面板 + 弹窗 + 独立窗口模式。
//
// 同一份脚本服务两个宿主：
//   * 注入进 DSH 网页 —— 右下角浮层，页面加载完就 POST /hello（这就是"打开 DSH 就启动原神"的那一下）。
//   * 独立窗口（Electron 原生窗口 / Edge --app=）加载 /dsh-genshin-launch/panel —— 整页铺满，
//     功能画面与网页版完全一致（本来就是同一份代码）。
//
// 它做四件事：
//   1. 上报「UI 已经出现了」。宿主把所有有副作用的事（启动游戏 / 下载 / 扫盘）都挂在
//      这一下上，所以纯命令行跑 dsh、或者桌面端根本没开到我们这个页面时，不会发生任何事。
//      重复上报（F5）是幂等的，宿主那边还有"每个进程只启动一次"的落盘标记兜底。
//   2. 轮询 /status 渲染面板。
//   3. 把宿主挂出来的问题（要不要扫盘、要不要信任新版安装包）渲染成弹窗，并把答案 POST 回去。
//   4. 提供「快速配置路径」——自己再开一个更高层级的弹窗填 exe 路径，写进插件配置。
//
// 刻意写成无依赖的原生脚本：不需要客户端构建链，改完刷新页面就生效。
;(() => {
  'use strict'

  const BASE = '/dsh-genshin-launch'
  const STATUS_URL = `${BASE}/status`
  const HELLO_URL = `${BASE}/hello`
  const ANSWER_URL = `${BASE}/answer`
  const CONFIG_URL = `${BASE}/config`
  const RESCAN_URL = `${BASE}/rescan`
  const POLL_MS = 1500
  const PANEL_ID = 'dsh-genshin-launch-panel'
  const QUESTION_ID = 'dsh-genshin-launch-question'
  const QUICK_ID = 'dsh-genshin-launch-quick'

  const TERMINAL_PHASES = new Set([
    'done',
    'failed',
    'no-link',
    'opened-link',
    'opened-fallback',
    'launched',
    'launch-failed',
    'already-running',
  ])

  if (window.__dshGenshinLaunchLoaded) return
  window.__dshGenshinLaunchLoaded = true

  const params = new URLSearchParams(location.search)
  const IS_STANDALONE = window.__DSH_GENSHIN_STANDALONE__ === true || params.get('mode') === 'standalone'

  // 一次性 token：独立窗口由宿主写在页面上；网页里写在脚本 URL 的 ?token= 上。
  const TOKEN = (() => {
    if (typeof window.__DSH_GENSHIN_TOKEN__ === 'string') return window.__DSH_GENSHIN_TOKEN__
    try {
      if (params.get('token')) return params.get('token')
      const src = document.currentScript?.src ?? document.querySelector('script[src*="/dsh-genshin-launch/client.js"]')?.src
      return src ? new URL(src, location.href).searchParams.get('token') ?? '' : ''
    } catch {
      return ''
    }
  })()

  const state = {
    countdownMs: 20000,
    pollHandle: null,
    tickHandle: null,
    stopped: false,
    announced: false,
    questionId: null,
    status: undefined,
  }

  // ---------------------------------------------------------------- 小工具
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

  // token 会随插件热重载变化（host 每次 apply 都新生成一个）。所以写失败且原因是
  // bad-token 时，去 /token 取一份新的重试一次 —— 否则用户改了配置触发热重载之后，
  // 面板上所有按钮就都会 403，看起来像坏了。
  let liveToken = TOKEN

  async function refreshToken() {
    try {
      const response = await fetch(`${BASE}/token`, { cache: 'no-store' })
      if (!response.ok) return ''
      const data = await response.json()
      if (typeof data?.token === 'string' && data.token) liveToken = data.token
      return liveToken
    } catch {
      return ''
    }
  }

  async function postJson(url, payload) {
    const attempt = async (tokenValue) => {
      const response = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(tokenValue ? { 'x-dsh-genshin-token': tokenValue } : {}),
        },
        body: JSON.stringify(payload ?? {}),
      })
      const data = await response.json().catch(() => undefined)
      return { ok: response.ok, status: response.status, data }
    }
    try {
      let result = await attempt(liveToken)
      if (!result.ok && result.status === 403 && result.data?.reason === 'bad-token') {
        const fresh = await refreshToken()
        if (fresh && fresh !== liveToken) result = await attempt(fresh)
      }
      return result
    } catch (error) {
      return { ok: false, status: 0, data: { reason: String(error?.message ?? error) } }
    }
  }

  // ---------------------------------------------------------------- 面板
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

    if (IS_STANDALONE) {
      // 独立窗口里就这一样东西：关掉它页面就空了，所以不给关闭按钮、也不自动关。
      // 注意：**不要**在这里改 document.title —— 宿主已经把标题设成
      // 「原神，启动！ #<标记>」，那个 ASCII 标记是 Win32 置顶/收窗口用来找窗口的钥匙。
    } else {
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
      panel.appendChild(close)
    }

    const body = document.createElement('div')
    body.id = `${PANEL_ID}-body`
    panel.appendChild(body)

    if (!IS_STANDALONE) {
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
      panel.appendChild(bar)
    }

    document.body.appendChild(panel)
    return panel
  }

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

  function startCountdown() {
    if (IS_STANDALONE || state.tickHandle) return
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

  const PHASE_TEXT = {
    idle: '待机',
    disabled: '已禁用',
    detecting: '正在确认本机是否装了原神…',
    'game-found': '检测到原神',
    installing: '原神正在安装 / 更新',
    'game-missing': '本机没有原神',
    launching: '正在启动原神…',
    launched: '原神，启动！',
    'launch-failed': '启动失败',
    'already-running': '原神已经在运行',
    resolving: '正在确认最新链接…',
    'no-link': '没找到可用链接',
    resolved: '已定位安装包',
    downloading: '正在下载…',
    done: '下载完成',
    failed: '下载失败',
    'opened-link': '已打开下载链接',
    'opened-fallback': '已打开官方下载页',
  }

  function buttonCss(tone) {
    const palette = tone === 'primary'
      ? 'background:linear-gradient(135deg,#e2c078,#f6dc9c);color:#241d10;border-color:transparent'
      : tone === 'danger'
        ? 'background:rgba(255,120,100,.16);color:#ffd0c6;border-color:rgba(255,140,120,.5)'
        : 'background:rgba(255,255,255,.08);color:#f3ead6;border-color:rgba(246,220,156,.4)'
    return `padding:6px 12px;border-radius:8px;border:1px solid;font:inherit;font-size:12px;cursor:pointer;${palette}`
  }

  function render(status) {
    state.status = status
    ensurePanel()
    const body = document.getElementById(`${PANEL_ID}-body`)
    if (!body) return

    const terminal = TERMINAL_PHASES.has(status.phase)
    const percent = typeof status.percent === 'number' ? Math.max(0, Math.min(100, status.percent)) : undefined
    const rejected = Array.isArray(status.rejected) ? status.rejected.length : 0
    const seconds = Math.max(1, Math.round(state.countdownMs / 1000))
    const game = status.game ?? {}
    const stored = status.config ?? {}

    const rows = []
    rows.push('<div style="font-size:14px;font-weight:700;letter-spacing:.06em;color:#f6dc9c;padding-right:18px">原神，启动！</div>')
    rows.push(`<div style="opacity:.75;margin-top:2px">DSH 端口 <b style="color:#f6dc9c">${status.endpoint && status.endpoint.port ? status.endpoint.port : '未知'}</b>${IS_STANDALONE ? ' · 独立窗口' : ''}</div>`)
    rows.push(`<div style="margin-top:6px">${escapeHtml(rejected && status.phase === 'no-link' ? `安全校验拒绝了 ${rejected} 条链接` : (PHASE_TEXT[status.phase] ?? status.phase))}</div>`)
    if (status.message && status.message !== PHASE_TEXT[status.phase]) rows.push(`<div style="opacity:.7">${escapeHtml(status.message)}</div>`)

    if (game.found && game.exePath) {
      rows.push(`<div style="opacity:.6;margin-top:6px;word-break:break-all">本体：${escapeHtml(game.exePath)}</div>`)
      if (game.flavor) rows.push(`<div style="opacity:.55">版本：${escapeHtml(game.flavor)}</div>`)
    } else if (game.registered) {
      if (game.installDir) rows.push(`<div style="opacity:.6;margin-top:6px;word-break:break-all">安装位置：${escapeHtml(game.installDir)}</div>`)
      if (game.launcherPath) rows.push(`<div style="opacity:.6;word-break:break-all">启动器：${escapeHtml(game.launcherPath)}</div>`)
    }

    if (rejected) rows.push('<div style="margin-top:4px;color:#ffd9a0;opacity:.9">体积超出安全档的链接已被整条拒绝</div>')
    if (percent !== undefined && !terminal) {
      rows.push(
        '<div style="margin-top:8px;height:6px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden">' +
          `<div style="height:100%;width:${percent.toFixed(1)}%;background:linear-gradient(90deg,#e2c078,#f6dc9c);transition:width .4s"></div></div>`,
      )
    }
    if (status.downloaded) rows.push(`<div style="opacity:.7;margin-top:4px">${humanSize(status.downloaded)} / ${status.size ? humanSize(status.size) : '未知大小'}</div>`)
    if (status.error) rows.push(`<div style="margin-top:6px;color:#ffb4a2;word-break:break-all">${escapeHtml(String(status.error))}</div>`)

    // —— 配置区：手填路径 + 清除 + 再扫一次 ——
    rows.push('<div style="margin-top:10px;border-top:1px solid rgba(246,220,156,.22);padding-top:8px"></div>')
    if (stored.gameExe) rows.push(`<div style="opacity:.65;word-break:break-all">手填 exe：${escapeHtml(stored.gameExe)}</div>`)
    else if (stored.gamePath) rows.push(`<div style="opacity:.65;word-break:break-all">手填目录：${escapeHtml(stored.gamePath)}</div>`)
    if (stored.sizeBaselineBytes) {
      rows.push(`<div style="opacity:.5">体积基准：${humanSize(stored.sizeBaselineBytes)}（${stored.sizeBaselineSource === 'learned' ? '上次下载学到的' : '出厂值'}）</div>`)
    }
    const actions = []
    actions.push(`<button type="button" data-act="quick" style="${buttonCss('plain')}">填写路径</button>`)
    if (stored.gameExe || stored.gamePath) actions.push(`<button type="button" data-act="clear" style="${buttonCss('plain')}">清除手填</button>`)
    actions.push(`<button type="button" data-act="rescan" style="${buttonCss('plain')}">再扫一次</button>`)
    rows.push(`<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${actions.join('')}</div>`)
    // 隐私：不再展示配置文件完整路径；只说明存储方式。
    const encNote = stored.encryption === 'dpapi'
      ? '路径已按当前用户加密存储（DPAPI）'
      : stored.encryption === 'plain'
        ? '本机 DPAPI 不可用，路径暂为明文存储'
        : '尚未存储任何路径'
    rows.push(`<div style="opacity:.42;margin-top:6px;font-size:11px">${escapeHtml(encNote)}；界面显示的路径均已掩码。</div>`)

    if (terminal && !IS_STANDALONE) rows.push(`<div style="opacity:.55;margin-top:8px;font-size:11px">${seconds} 秒后自动关闭 · 点右上角 × 立即关闭</div>`)

    body.innerHTML = rows.join('')
    body.querySelectorAll('button[data-act]').forEach((button) => {
      button.addEventListener('click', () => onAction(button.getAttribute('data-act')))
    })
    if (terminal) startCountdown()
  }

  function onAction(action) {
    if (action === 'quick') return openQuickConfig()
    if (action === 'clear') {
      return void postJson(CONFIG_URL, { gameExe: '', gamePath: '' }).then(() => poll())
    }
    if (action === 'rescan') {
      return void postJson(RESCAN_URL, {}).then(() => poll())
    }
    return undefined
  }

  // ---------------------------------------------------------------- 弹窗（宿主提问）
  function closeQuestion() {
    const node = document.getElementById(QUESTION_ID)
    if (node) node.remove()
    state.questionId = null
  }

  function renderQuestion(question) {
    if (!question) {
      if (state.questionId) closeQuestion()
      return
    }
    if (state.questionId === question.id) return
    state.questionId = question.id
    closeQuestion()

    const overlay = document.createElement('div')
    overlay.id = QUESTION_ID
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483600',
      'background:rgba(8,10,16,.72)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:20px',
      'font:13px/1.7 "Microsoft YaHei","PingFang SC",system-ui,sans-serif',
      'color:#f3ead6',
    ].join(';')

    const card = document.createElement('div')
    card.style.cssText = [
      'width:min(520px,100%)',
      'max-height:86vh',
      'overflow:auto',
      'padding:20px 22px 18px',
      'border-radius:14px',
      'background:linear-gradient(160deg,rgba(22,26,40,.99),rgba(40,33,22,.99))',
      'border:1px solid rgba(226,192,120,.6)',
      'box-shadow:0 18px 50px rgba(0,0,0,.6)',
    ].join(';')

    const rows = []
    rows.push(`<div style="font-size:15px;font-weight:700;color:#f6dc9c;margin-bottom:8px">${escapeHtml(question.title)}</div>`)
    for (const line of question.lines ?? []) {
      rows.push(`<div style="opacity:.85;margin:2px 0;word-break:break-word">${escapeHtml(line)}</div>`)
    }
    rows.push('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;justify-content:flex-end">')
    for (const option of question.options ?? []) {
      rows.push(`<button type="button" data-opt="${escapeHtml(option.id)}" style="${buttonCss(option.tone)}">${escapeHtml(option.label)}</button>`)
    }
    rows.push('</div>')
    card.innerHTML = rows.join('')
    overlay.appendChild(card)
    document.body.appendChild(overlay)

    card.querySelectorAll('button[data-opt]').forEach((button) => {
      button.addEventListener('click', () => {
        const option = button.getAttribute('data-opt')
        closeQuestion()
        void postJson(ANSWER_URL, { id: question.id, option })
        // 「快速配置路径」：问的那个弹窗先收掉，紧接着开一个更高层级的输入弹窗。
        // 它的 z-index 比提问弹窗还高，所以不存在"被挡住"。
        if (question.kind === 'scan-consent' && option === 'configure') openQuickConfig()
      })
    })
  }

  // ---------------------------------------------------------------- 快速配置路径（第二层弹窗）
  function openQuickConfig() {
    const existing = document.getElementById(QUICK_ID)
    if (existing) existing.remove()

    const stored = state.status?.config ?? {}
    const overlay = document.createElement('div')
    overlay.id = QUICK_ID
    // 故意比提问弹窗高一层：用户点「快速配置路径」时提问弹窗可能还在，不能被它盖住。
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483700',
      'background:rgba(8,10,16,.78)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:20px',
      'font:13px/1.7 "Microsoft YaHei","PingFang SC",system-ui,sans-serif',
      'color:#f3ead6',
    ].join(';')

    const card = document.createElement('div')
    card.style.cssText = [
      'width:min(560px,100%)',
      'padding:20px 22px 18px',
      'border-radius:14px',
      'background:linear-gradient(160deg,rgba(24,28,42,.99),rgba(42,35,24,.99))',
      'border:1px solid rgba(246,220,156,.7)',
      'box-shadow:0 22px 60px rgba(0,0,0,.65)',
    ].join(';')

    card.innerHTML = `
      <div style="font-size:15px;font-weight:700;color:#f6dc9c;margin-bottom:6px">快速配置原神路径</div>
      <div style="opacity:.8">填游戏本体的 exe 全路径，或者它所在的安装目录。填了就再也不用扫盘了。</div>
      <div style="opacity:.6;margin-top:6px">例：D:\\某目录\\Genshin Impact Game\\YuanShen.exe</div>
      <div style="opacity:.55;margin-top:6px;font-size:11px">出于隐私，界面上只会显示掩码后的路径；要修改请重新粘贴完整路径。</div>
      <input id="${QUICK_ID}-input" type="text" spellcheck="false" placeholder="粘贴完整路径…"
        style="margin-top:12px;width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid rgba(246,220,156,.45);background:rgba(0,0,0,.35);color:#f3ead6;font:inherit">
      <div id="${QUICK_ID}-error" style="color:#ffb4a2;min-height:18px;margin-top:6px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button type="button" data-q="cancel" style="${buttonCss('plain')}">取消</button>
        <button type="button" data-q="ok" style="${buttonCss('primary')}">确定</button>
      </div>
    `
    overlay.appendChild(card)
    document.body.appendChild(overlay)

    const input = card.querySelector(`#${QUICK_ID}-input`)
    const errorBox = card.querySelector(`#${QUICK_ID}-error`)
    input.focus()
    input.select()

    const close = () => overlay.remove()

    const submit = async () => {
      const value = input.value.trim()
      if (!value) {
        errorBox.textContent = '请填一个路径，或者点取消。'
        return
      }
      // 目录还是 exe：看扩展名。面板会把两者都交给宿主，宿主再做存在性校验。
      const payload = /\.exe$/i.test(value) ? { gameExe: value, gamePath: '' } : { gamePath: value, gameExe: '' }
      const result = await postJson(CONFIG_URL, payload)
      if (!result.ok) {
        errorBox.textContent = result.data?.reason ?? `写入失败（HTTP ${result.status}）`
        return
      }
      close()
      void poll()
    }

    card.querySelector('button[data-q="cancel"]').addEventListener('click', close)
    card.querySelector('button[data-q="ok"]').addEventListener('click', () => void submit())
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void submit()
      if (event.key === 'Escape') close()
    })
  }

  // ---------------------------------------------------------------- 轮询与上报
  let ticks = 0
  let maxTicks = 200

  async function announceOpen() {
    if (state.announced) return
    state.announced = true
    try {
      await fetch(`${HELLO_URL}?mode=${IS_STANDALONE ? 'standalone' : 'panel'}`, {
        method: 'POST',
        cache: 'no-store',
        headers: TOKEN ? { 'x-dsh-genshin-token': TOKEN } : {},
      })
    } catch {
      /* 宿主还没起来或已退出：静默，状态轮询会继续兜底 */
    }
  }

  async function poll() {
    ticks += 1
    if (ticks > maxTicks && !IS_STANDALONE) {
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
        if (!IS_STANDALONE) dismiss()
        return
      }
      render(status)
      renderQuestion(status.question)
    } catch {
      /* 宿主还没起来或已退出：静默重试 */
    }
  }

  function start() {
    ensurePanel()
    // 先把「界面已经打开」报上去，再开始轮询状态。
    announceOpen()
    void poll()
    state.pollHandle = setInterval(poll, POLL_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
