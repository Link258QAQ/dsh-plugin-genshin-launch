// dsh-plugin-genshin-launch —— 宿主半侧
//
// 需求：装完插件后，DSH 每次启动都识别自己的端口，并把《原神》启动器安装包
// 下载到桌面；下载不成，退化成打开官方下载链接。
//
// 实现要点：
//  * 端口识别：inject 'webServer'，读 ctx.webServer.host / ctx.webServer.port
//    （宿主半侧的注入在 web 服务器 listen 之后解析，所以拿到的是真实监听端口，
//    即使 --port 0 由系统分配也能拿到）。环境变量 DSH_WEB_URL 作为兜底。
//  * 触发时机：插件 apply 即 DSH 启动一次，所以“每次开 DSH 下一次”。
//  * 下载不阻塞启动：apply 里起一个后台任务，失败只记录状态，不影响宿主。
//  * 浏览器侧：注入一小段脚本，右下角显示「原神，启动！」进度条。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { downloadToFile, fileNameFromUrl, humanSize } from './download.js'
import { resolveInstaller } from './resolve.js'
import { DEFAULT_EXPECTED_BYTES, DEFAULT_TOLERANCE_BYTES, enforceInstallerSize, sizeBounds } from './size-guard.js'

export const name = 'genshin-launch'

/** 需要 webServer 才能识别端口、注册状态路由、往 index.html 注入脚本。 */
export const inject = ['webServer']

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 内置候选：国服《原神》启动器安装包。
 * 第一个是「已知可用」的直链；探测族会用同一版本目录里更大的 pcbackup 序号
 * 覆盖它（见 lib/resolve.js 的说明）。
 */
const DEFAULT_INSTALLER_URL =
  'https://autopatchcn.yuanshen.com/client_app/download/launcher/20260817103614_ioLXDt6rqSXYqxou/pcbackup319/yuanshen_setup_20260817.exe'

/** 兜底链接：解析不出直链、或者下载失败时，直接打开这个页面。 */
const DEFAULT_FALLBACK_LINKS = [
  'https://ys.mihoyo.com/launcher',
  'https://www.mihoyo.com/download',
]

const DEFAULT_CONFIG = {
  enabled: true,
  download: true,
  downloadDir: '',
  url: DEFAULT_INSTALLER_URL,
  extraUrls: [],
  probeLatest: true,
  probeStart: 0,
  probeAhead: 1,
  resume: true,
  openFileWhenDone: false,
  openFallbackWhenFailed: true,
  fallbackUrls: DEFAULT_FALLBACK_LINKS,
  useCache: true,
  cacheTtlHours: 168,
  // 安全闸：启动器安装包约 224 MiB，相差超过 50 MiB 就整条链接拒绝。
  expectedInstallerBytes: DEFAULT_EXPECTED_BYTES,
  sizeToleranceBytes: DEFAULT_TOLERANCE_BYTES,
  // 显式上下限（0 = 由 expected ± tolerance 推导）。默认交给推导，避免把闸门写死。
  minInstallerBytes: 0,
  maxInstallerBytes: 0,
  allowUnknownSize: false,
  clientNotice: true,
  // 网页面板：到终态后用底部进度条倒计时这么多秒，然后自动关闭（0 = 不自动关）。
  clientNoticeSeconds: 20,
  skipIfInstalled: true,
  timeoutMinutes: 0,
}

function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [])
  config.extraUrls = list(config.extraUrls)
  config.fallbackUrls = list(config.fallbackUrls)
  if (!config.fallbackUrls.length) config.fallbackUrls = [...DEFAULT_FALLBACK_LINKS]
  if (typeof config.url !== 'string') config.url = ''
  if (!Number.isFinite(config.probeStart)) config.probeStart = 0
  return config
}

/** 桌面目录：显式配置优先，其次常见路径，最后退回用户主目录。 */
function resolveDesktopDirectory(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit
  const home = homedir()
  const candidates = [join(home, 'Desktop'), join(home, '桌面'), join(home, 'OneDrive', 'Desktop'), join(home, 'OneDrive', '桌面')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return home
}

/** 端口识别：以宿主 webServer 为准，环境变量兜底。 */
function detectEndpoint(ctx) {
  const server = ctx.get('webServer') ?? ctx.webServer
  let host = '127.0.0.1'
  let port
  if (server) {
    try {
      if (typeof server.host === 'string' && server.host) host = server.host
    } catch {
      /* 忽略：用默认回环地址 */
    }
    try {
      if (Number.isFinite(server.port) && server.port > 0) port = server.port
    } catch {
      /* 忽略：走环境变量兜底 */
    }
  }
  let url
  if (port) {
    url = `http://${host}:${port}`
  } else if (process.env.DSH_WEB_URL) {
    url = process.env.DSH_WEB_URL
    try {
      const parsed = new URL(url)
      port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
      host = parsed.hostname
    } catch {
      /* 忽略 */
    }
  }
  return { host, port, url }
}

/** 本机回环来源校验：这些路由只给同一台机器的页面用。 */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  if (!address) return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

// 内置候选族：从用户给的直链里推导出 {base, file, start}。
function buildProbeFamily(config) {
  const seed = config.url || DEFAULT_INSTALLER_URL
  const match = /^(.*\/pcbackup)(\d+)\/([^/?#]+)$/i.exec(seed)
  if (!match) return []
  const start = config.probeStart > 0 ? config.probeStart : Number(match[2])
  if (!Number.isFinite(start)) return []
  return [{ base: `${match[1]}{index}`, file: match[3], start }]
}

function writeStatusFile(file, status) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(status, undefined, 2), 'utf8')
  } catch {
    /* 状态文件写不进去不影响主流程 */
  }
}

function readClientScript() {
  try {
    return readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  } catch {
    return ''
  }
}

/** 探测目录是否真的可写（桌面可能被权限或沙箱挡住）。 */
function isWritableDirectory(directory) {
  try {
    mkdirSync(directory, { recursive: true })
    const probe = join(directory, `.dsh-genshin-launch-write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 已装好的原神（国服）常见位置：命中就不必再拉 224MB 安装包。 */
function findExistingInstall() {
  if (!isWindows()) return undefined
  const home = homedir()
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], join(home, 'AppData', 'Local'), join(home, 'Desktop'), 'D:\\', 'E:\\']
  for (const root of roots) {
    if (!root) continue
    for (const name of ['原神', 'Genshin Impact']) {
      const dir = join(root, name)
      if (existsSync(join(dir, 'YuanShen.exe')) || existsSync(join(dir, 'GenshinImpact.exe'))) return dir
    }
  }
  return undefined
}

function isWindows() {
  return process.platform === 'win32'
}

/**
 * 状态文件路径：优先放在目标目录（桌面）旁边，方便用户直接看；
 * 目标目录不可写时退到工作区，保证状态一定留得下来。
 */
function statusFileFor(desktop, config) {
  const name = 'dsh-genshin-launch-status.json'
  if (isWritableDirectory(desktop)) return join(desktop, name)
  const fallbackDir = resolve(process.cwd(), 'dsh-genshin-launch-download')
  try {
    mkdirSync(fallbackDir, { recursive: true })
  } catch {
    /* 下面的写入会自己失败并静默 */
  }
  void config
  return join(fallbackDir, name)
}

/** 用系统默认程序打开一个 URL 或目录。 */
function openExternal(target) {
  const platform = process.platform
  try {
    if (platform === 'win32') {
      // `start` 是 cmd 内建命令，URL 里带 & 时必须走 cmd /c + 引号参数
      const child = spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false })
      child.unref()
      return true
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [target], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function logInfo(ctx, message) {
  try {
    ctx.logger?.info?.(message)
  } catch {
    /* 忽略 */
  }
  console.log(`[genshin-launch] ${message}`)
}

function logWarn(ctx, message) {
  try {
    ctx.logger?.warn?.(message)
  } catch {
    /* 忽略 */
  }
  console.warn(`[genshin-launch] ${message}`)
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const endpoint = detectEndpoint(ctx)
  const desktop = resolveDesktopDirectory(config.downloadDir)

  const status = {
    plugin: name,
    enabled: config.enabled !== false,
    downloadEnabled: config.download !== false && config.enabled !== false,
    endpoint,
    desktop,
    phase: 'idle',
    message: '待启动',
    resolvedUrl: undefined,
    size: undefined,
    downloaded: 0,
    percent: undefined,
    filePath: undefined,
    fileName: undefined,
    error: undefined,
    at: new Date().toISOString(),
  }

  const statusFile = statusFileFor(desktop, config)
  const cacheFile = join(desktop, '.dsh-genshin-launch-cache.json')
  const bounds = sizeBounds(config)
  const abort = new AbortController()
  let finished = false

  const update = (patch) => {
    Object.assign(status, patch, { at: new Date().toISOString() })
    writeStatusFile(statusFile, status)
  }

  const banner = [
    '╔══════════════════════════════════════════════════════════╗',
    '║  原神，启动！                                            ║',
    '╚══════════════════════════════════════════════════════════╝',
  ].join('\n')

  logInfo(ctx, banner)
  logInfo(ctx, `识别到 DSH 端口：${endpoint.port ?? '未知'}（${endpoint.url ?? '未知'}）`)
  logInfo(ctx, `安装包目标目录：${desktop}`)

  // —— 浏览器侧：状态路由 + index.html 注入 ——
  const disposers = []
  if (config.clientNotice !== false) {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-genshin-launch/status',
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ ...status, noticeSeconds: config.clientNoticeSeconds }))
        },
      }),
    )
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-genshin-launch/client.js',
        handler: (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(readClientScript())
        },
      }),
    )
    disposers.push(
      ctx.webServer.tapIndex((html) => {
        if (html.includes('/dsh-genshin-launch/client.js')) return html
        const tag = '<script defer src="/dsh-genshin-launch/client.js"></script>'
        return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
      }),
    )
  }

  const run = async () => {
    if (config.enabled === false) {
      update({ phase: 'disabled', message: '插件已禁用（config.enabled: false）' })
      return
    }

    if (config.skipIfInstalled !== false) {
      const installed = findExistingInstall()
      if (installed) {
        const message = `检测到已安装的原神，跳过下载：${installed}`
        update({ phase: 'done', message, alreadyInstalled: true })
        logInfo(ctx, message)
        return
      }
    }

    const candidates = [config.url, ...config.extraUrls].filter(Boolean)
    const families = config.probeLatest ? buildProbeFamily(config) : []

    update({ phase: 'resolving', message: '正在确认最新安装包链接…' })
    let resolved
    try {
      resolved = await resolveInstaller({
        urls: candidates,
        probeFamilies: families,
        probeAhead: config.probeLatest ? Math.max(0, Number(config.probeAhead ?? 1)) : 0,
        cacheFile,
        useCache: config.useCache !== false,
        minBytes: Number(config.minInstallerBytes) > 0 ? Number(config.minInstallerBytes) : undefined,
        sizeBounds: bounds,
        cacheTtlMs: Math.max(0, Number(config.cacheTtlHours) || 0) * 3600 * 1000,
        signal: abort.signal,
        onNote: (message) => logInfo(ctx, message),
      })
    } catch (error) {
      resolved = { source: 'error', url: undefined, tried: [] }
      logWarn(ctx, `链接解析异常：${error?.message ?? error}`)
    }

    logInfo(ctx, `体积安全闸：只接受 ${humanSize(bounds.min)} ~ ${humanSize(bounds.max)}（预期 ${humanSize(bounds.expected)} ± ${humanSize(bounds.tolerance)}）`)

    if (!resolved.url) {
      const rejectedNote = resolved.rejected?.length ? `，其中 ${resolved.rejected.length} 条链接被体积安全闸拒绝` : ''
      update({
        phase: 'no-link',
        message: `没有解析到可用的安装包直链${rejectedNote}`,
        error: resolved.rejected?.length
          ? `安全校验拒绝：${resolved.rejected.map((item) => item.reason).join('；')}`
          : '所有候选链接都不可用',
        rejected: resolved.rejected ?? [],
      })
      logWarn(ctx, `没有解析到可用的安装包直链${rejectedNote}。`)
      if (config.openFallbackWhenFailed !== false) {
        const target = config.fallbackUrls[0]
        logWarn(ctx, `退化成打开官方下载页：${target}`)
        if (openExternal(target)) update({ phase: 'opened-fallback', message: `已打开下载页：${target}` })
        else update({ phase: 'failed', message: `请手动打开：${target}`, error: '无法唤起默认浏览器' })
      }
      return
    }

    update({
      phase: 'resolved',
      message: `已定位安装包（${resolved.source}）`,
      resolvedUrl: resolved.url,
      size: resolved.size,
    })
    logInfo(ctx, `安装包链接：${resolved.url}`)
    if (resolved.size) logInfo(ctx, `安装包大小：${humanSize(resolved.size)}`)

    if (config.download === false) {
      logInfo(ctx, '配置为只打开链接，不下载（config.download: false）')
      const opened = openExternal(resolved.url)
      update({
        phase: opened ? 'opened-link' : 'failed',
        message: opened ? `已打开下载链接：${resolved.url}` : `请手动打开：${resolved.url}`,
        error: opened ? undefined : '无法唤起默认浏览器',
      })
      return
    }

    // 目标目录可能不可写（桌面权限、或宿主被文件沙箱限制）。先探测，不可写就
    // 退到工作区目录下载，然后用资源管理器把「桌面上的那份」展示出来。
    let destination = desktop
    let relocated = false
    if (!isWritableDirectory(desktop)) {
      const fallbackDir = resolve(process.cwd(), 'dsh-genshin-launch-download')
      logWarn(ctx, `目标目录不可写（${desktop}），改为下载到：${fallbackDir}`)
      if (isWritableDirectory(fallbackDir)) {
        destination = fallbackDir
        relocated = true
      } else {
        const reason = `目标目录不可写：${desktop}`
        update({ phase: 'failed', message: `下载失败：${reason}`, error: reason })
        logWarn(ctx, reason)
        if (config.openFallbackWhenFailed !== false) {
          logWarn(ctx, `退化成打开官方下载页：${config.fallbackUrls[0]}`)
          openExternal(config.fallbackUrls[0])
        }
        return
      }
    }

    update({ phase: 'downloading', message: '正在下载安装包…' })
    const startedAt = Date.now()
    const targetName = fileNameFromUrl(resolved.url)
    try {
      // 安全闸（下载前，最后一道）：体积对不上就直接拒绝这条链接，
      // 连同已有半成品一起丢掉——绝不续传一个体积可疑的文件。
      const verdict = await enforceInstallerSize({
        url: resolved.url,
        bytes: resolved.size,
        bounds,
        directory: destination,
        fileName: targetName,
        allowUnknown: config.allowUnknownSize === true,
      })
      if (!verdict.allowed) {
        throw new Error(`安全校验拒绝下载：${verdict.reason}`)
      }

      const result = await downloadToFile({
        url: resolved.url,
        directory: destination,
        fileName: targetName,
        expectedSize: resolved.size,
        resume: config.resume !== false,
        signal: abort.signal,
        onProgress: ({ downloaded, total, percent }) => {
          update({ downloaded, size: total ?? status.size, percent })
        },
      })
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      // 落盘后再核一次体积：不在允许区间就删掉，绝不留一个可疑安装器给用户双击。
      const finalCheck = await enforceInstallerSize({
        url: resolved.url,
        bytes: result.size,
        bounds,
        allowUnknown: config.allowUnknownSize === true,
      })
      if (!finalCheck.allowed) {
        await rm(result.path, { force: true }).catch(() => {})
        throw new Error(`安全校验拒绝：${finalCheck.reason}（文件已删除）`)
      }
      const doneMessage = result.done
        ? `安装包已存在，无需重复下载（${humanSize(result.size)}）`
        : `下载完成：${humanSize(result.size)}，用时 ${seconds}s`
      update({
        phase: 'done',
        message: relocated ? `${doneMessage}（桌面不可写，已放到工作区）` : doneMessage,
        fileName: result.fileName,
        filePath: result.path,
        downloaded: result.size,
        size: result.size,
        percent: 100,
        relocated,
      })
      logInfo(ctx, doneMessage)
      logInfo(ctx, `文件位置：${result.path}`)
      if (config.openFileWhenDone || relocated) {
        // 让用户直接看到成果：把桌面（或安置目录）在资源管理器里打开。
        if (openExternal(relocated ? desktop : result.path)) logInfo(ctx, relocated ? '已在资源管理器中打开桌面。' : '已打开安装包所在目录。')
      }
    } catch (error) {
      const reason = error?.message ?? String(error)
      update({ phase: 'failed', message: `下载失败：${reason}`, error: reason })
      logWarn(ctx, `下载失败：${reason}`)
      if (config.openFallbackWhenFailed !== false) {
        const fallback = config.fallbackUrls[0]
        logWarn(ctx, `退化成打开官方下载页：${fallback}`)
        openExternal(fallback)
      }
    } finally {
      finished = true
    }
  }

  // 不阻塞 DSH 启动：下载在后台跑。
  const task = run().catch((error) => {
    logWarn(ctx, `后台任务异常：${error?.message ?? error}`)
  })

  ctx.effect(() => () => {
    abort.abort(new Error('plugin disposed'))
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    void task
    void finished
  })
}

export default { name, inject, apply }
