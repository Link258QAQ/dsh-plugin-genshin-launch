// dsh-plugin-genshin-launch —— 宿主半侧
//
// 两条路，按「本机有没有装原神」自动分流：
//
//   方案一（没装）：把《原神》启动器安装包下载到桌面；下载不成，退化成打开官方下载页。
//   方案二（装了）：停止下载，改成「打开 DSH 就启动原神」。
//
// 贯穿全部设计的三条纪律：
//
//  * **只读探测，先快后慢。** 见 lib/detect.js。注册表和文件系统都会残留，读到的路径
//    一律先用文件复核；唯一会"翻磁盘"的那一档必须用户点头（lib/questions.js）。
//
//  * **有副作用的事，等 UI 真的出现了再做。** 下载 224MB、启动游戏、扫盘，全部挂在
//    「某个 UI 面渲染出来了」这一个门上（sideEffectTrigger: 'ui'，默认）。因为
//    `dsh plugin add` 这种命令行调用压根不会开浏览器，Electron 桌面端又走 file://
//    不加载我们的注入 —— 把副作用挂在宿主 apply 上，就会在用户看不见的地方下 224MB。
//
//  * **每个宿主进程最多启动一次游戏。** 标记以「宿主 pid + 进程启动时刻」为键落盘，
//    所以 patchReload: live 的热重载、以及浏览器 F5，都不会再拉起第二个游戏进程。
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectGame, locateLauncherNear } from './detect.js'
import { downloadToFile, fileNameFromUrl, humanSize } from './download.js'
import { runCaptured } from './exec.js'
import { isAnyProcessRunning, launchExecutable } from './launch.js'
import { maskPath, maskPathsInText, protect, sweepTempFiles, unprotect } from './privacy.js'
import { createQuestionHub } from './questions.js'
import { resolveInstaller } from './resolve.js'
import { classifySize, enforceInstallerSize, isOfficialHost, sizeBounds } from './size-guard.js'
import { openStore, resolveSizeBaseline } from './store.js'
import { isElectron, openStandaloneWindow, windowTitle } from './window.js'

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

const CONFIG_FILE_NAME = 'dsh-genshin-launch-config.json'
const STATUS_FILE_NAME = 'dsh-genshin-launch-status.json'
const DETECT_CACHE_NAME = 'dsh-genshin-launch-detect.json'
const SESSION_FILE_NAME = 'dsh-genshin-launch-session.json'
const INSTALLER_CACHE_NAME = '.dsh-genshin-launch-cache.json'

const DEFAULT_CONFIG = {
  enabled: true,
  // —— 方案二：打开 DSH 就启动原神 ——
  launchGame: true,
  /** gui = UI 出现时启动（推荐）；host = 宿主进程一启动就启动 */
  launchTrigger: 'gui',
  /** spawn = 直接起 exe（可判定成败，默认）；shell = cmd /c start，双击语义 */
  launchMethod: 'spawn',
  /** spawn 被系统按「需要提权」拦下（EACCES/740）时，自动改走 shell 弹 UAC 一次 */
  retryShellOnElevation: true,
  /** 观察窗：这段时间内就退出 → 认为没起来，交给回退逻辑 */
  launchWatchMs: 3000,
  /** 本体没起来就改起米哈游启动器（能覆盖「客户端版本过低」这种情况） */
  fallbackToLauncher: true,
  /** 每个 DSH 进程最多启动一次（刷新页面不会重开游戏） */
  launchOncePerSession: true,
  /**
   * 有副作用的事（下载 / 启动 / 扫盘）什么时候允许做：
   *   ui   = 等某个 UI 面（网页面板或独立窗口）真的渲染出来（默认，也最安全）
   *   host = 宿主进程一启动就做（命令行启动且永不开浏览器时会变成"看不见的 224MB"）
   */
  sideEffectTrigger: 'ui',
  /**
   * 独立窗口（网页之外的置顶窗口）：
   *   auto   = 只在 Electron 桌面端开（那里我们的注入不会执行）
   *   always = 哪里都开
   *   off    = 不开
   */
  standaloneWindow: 'auto',
  standaloneAlwaysOnTop: true,
  standaloneWidth: 420,
  standaloneHeight: 620,
  /** 非 Electron 时用什么开独立窗口：native = 原生 WinForms（默认，无浏览器内核）；browser = Edge/Chrome --app= */
  standaloneEngine: 'native',
  /** 独立窗口开不出来时，是否退回"宿主启动就做副作用"（默认不：宁可什么都不做也不要偷偷下 224MB） */
  standaloneFailureFallback: false,
  /** 问用户时的等待上限（毫秒）；超时按最保守的选项收场 */
  questionTimeoutMs: 180000,
  // —— 零配置探测 ——
  /** 手填 exe 全路径：最高优先级，自测时指到别的程序也能用 */
  gameExe: '',
  /** 手填安装目录 */
  gamePath: '',
  /** 允许使用的探测档；不想要扫盘就去掉 'scan' */
  detectSources: ['config', 'registry', 'paths', 'scan'],
  scanMaxDepth: 4,
  scanBudgetMs: 20000,
  /** 额外的扫描 / 候选根目录 */
  extraRoots: [],
  /** 命中结果的缓存时长 */
  detectionCacheHours: 168,
  /** 「没找到」这个结论的缓存时长（只用来跳过最贵的扫盘那一档） */
  negativeCacheHours: 24,
  /** 扫盘同意：ask = 弹窗问（默认）；allow / deny = 预先表态，不弹窗 */
  scanConsent: 'ask',
  // —— 方案一：下载（只在没装原神时走）——
  download: true,
  downloadDir: '',
  /** 状态/配置/缓存目录：留空 = %LOCALAPPDATA%\dsh-genshin-launch（隐私默认）。 */
  stateDir: '',
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
  // 安全闸：默认基准 224 MiB ± 15 MiB；下载成功后基准会自更新成真实字节数。
  expectedInstallerBytes: 0,
  sizeToleranceBytes: 15 * 1024 * 1024,
  sanityMinInstallerBytes: 100 * 1024 * 1024,
  sanityMaxInstallerBytes: 400 * 1024 * 1024,
  /** 下载成功后把基准覆盖成真实字节数（自适应启动器更新） */
  autoUpdateSizeBaseline: true,
  // 显式上下限（0 = 由 expected ± tolerance 推导）。
  minInstallerBytes: 0,
  maxInstallerBytes: 0,
  allowUnknownSize: false,
  clientNotice: true,
  // 网页面板：到终态后用底部进度条倒计时这么多秒，然后自动关闭（0 = 不自动关）。
  clientNoticeSeconds: 20,
  /** 装了原神是否跳过下载（false = 无视安装状态，照旧下载） */
  skipIfInstalled: true,
  timeoutMinutes: 0,
}

function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [])
  config.extraUrls = list(config.extraUrls)
  config.fallbackUrls = list(config.fallbackUrls)
  config.extraRoots = list(config.extraRoots)
  const sources = list(config.detectSources)
  config.detectSources = sources.length ? sources : [...DEFAULT_CONFIG.detectSources]
  if (!config.fallbackUrls.length) config.fallbackUrls = [...DEFAULT_FALLBACK_LINKS]
  if (typeof config.url !== 'string') config.url = ''
  if (!Number.isFinite(config.probeStart)) config.probeStart = 0
  if (config.launchMethod !== 'shell') config.launchMethod = 'spawn'
  if (config.launchTrigger !== 'host') config.launchTrigger = 'gui'
  if (!['ui', 'host'].includes(config.sideEffectTrigger)) config.sideEffectTrigger = 'ui'
  if (!['auto', 'always', 'off'].includes(config.standaloneWindow)) config.standaloneWindow = 'auto'
  if (!['ask', 'allow', 'deny'].includes(config.scanConsent)) config.scanConsent = 'ask'
  if (!['native', 'browser'].includes(config.standaloneEngine)) config.standaloneEngine = 'native'
  // 没有浏览器侧面板，就不可能"等 UI 出现"——这种配置下强制回宿主触发，
  // 否则插件会变成什么都不做的死件。
  if (config.clientNotice === false && config.sideEffectTrigger === 'ui') {
    config.sideEffectTrigger = 'host'
    config.__forcedHostTrigger = true
  }
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

/**
 * 状态 / 配置 / 缓存放哪：**%LOCALAPPDATA%\dsh-genshin-launch**。
 *
 * 以前放桌面——桌面上那些 JSON 里带着用户名和安装路径，是主要的隐私扩散面；
 * 挪到 LOCALAPPDATA 后：别人一眼看不到，同目录下也没有"顺手能翻"的明文路径了
 * （路径本身还进一步做了裁剪 + DPAPI 加密，见 lib/store.js / lib/detectCache）。
 */
function resolveStateDir(explicit) {
  const preferred = (typeof explicit === 'string' && explicit.trim())
    ? explicit.trim()
    : (() => {
      const local = process.env.LOCALAPPDATA
      return local && local.trim() ? join(local, 'dsh-genshin-launch') : join(homedir(), '.dsh-genshin-launch')
    })()
  if (isWritableDirectory(preferred)) return preferred
  const fallback = resolve(process.cwd(), 'dsh-genshin-launch-state')
  try {
    mkdirSync(fallback, { recursive: true })
  } catch {
    /* 下面的写入会自己失败并静默 */
  }
  return fallback
}

/** 老版本把状态文件写在桌面/主目录，前缀都是它自己起的。 */
const LEGACY_PREFIXES = ['dsh-genshin-launch-', '.dsh-genshin-launch-']
function legacyDirectories() {
  const home = homedir()
  return new Set([
    home,
    join(home, 'Desktop'),
    join(home, '桌面'),
    join(home, 'OneDrive', 'Desktop'),
    join(home, 'OneDrive', '桌面'),
    resolve(process.cwd(), 'dsh-genshin-launch-download'),
  ])
}

/**
 * 迁移前先把老配置文件里**用户手填的路径**捞出来。
 * 其余老文件（status/detect/session/window 脚本）只是派生物，没有捞的价值，直接删。
 *
 * @returns {{ gameExe: string, gamePath: string, scanConsent: string, scanDone: boolean, sizeBaselineBytes: number, sizeBaselineUrl: string }}
 */
function readLegacyConfig() {
  const empty = { gameExe: '', gamePath: '', scanConsent: 'unset', scanDone: false, sizeBaselineBytes: 0, sizeBaselineUrl: '' }
  for (const directory of legacyDirectories()) {
    const file = join(directory, 'dsh-genshin-launch-config.json')
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return {
        gameExe: typeof parsed?.gameExe === 'string' ? parsed.gameExe.trim() : '',
        gamePath: typeof parsed?.gamePath === 'string' ? parsed.gamePath.trim() : '',
        scanConsent: ['unset', 'allowed', 'denied', 'manual'].includes(parsed?.scanConsent) ? parsed.scanConsent : 'unset',
        scanDone: parsed?.scanDone === true,
        sizeBaselineBytes: Number(parsed?.sizeBaselineBytes) > 0 ? Math.round(Number(parsed.sizeBaselineBytes)) : 0,
        sizeBaselineUrl: typeof parsed?.sizeBaselineUrl === 'string' ? parsed.sizeBaselineUrl : '',
      }
    } catch {
      /* 坏文件：当没有 */
    }
  }
  return empty
}

/** 删掉老版本留在桌面/主目录/工作区的明文状态文件。 */
function cleanLegacyStateFiles(onNote) {
  let removed = 0
  for (const directory of legacyDirectories()) {
    let entries
    try {
      entries = readdirSync(directory)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!LEGACY_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
      if (!/\.json$|\.ps1$/.test(name)) continue
      try {
        // 只删文件；老目录（工作区兜底建的）留着不碍事。
        unlinkSync(join(directory, name))
        removed += 1
      } catch {
        /* 被占用 / 已不存在：跳过 */
      }
    }
  }
  if (removed) onNote(`已删除 ${removed} 个旧版明文状态文件（桌面/主目录里的 JSON 与脚本）`)
  return removed
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonFile(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, undefined, 2), 'utf8')
    return true
  } catch {
    return false
  }
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

/**
 * 同源校验：浏览器发起的跨站 POST 一定带 Origin，且一定不等于我们自己的源。
 * 这一条挡的是「某个网页偷偷 POST 过来让本机启动游戏 / 改配置」。
 * `null` 源是 file:// 页面（Electron 壳里的插件页），只允许读、不允许写。
 */
function originVerdict(req, endpoint) {
  const origin = req.headers?.origin
  if (!origin) return 'none' // 非浏览器（curl / 自检脚本）
  if (origin === 'null') return 'opaque' // file:// 页面
  const allowed = new Set()
  const host = endpoint.host === '0.0.0.0' ? '127.0.0.1' : endpoint.host
  if (endpoint.port) {
    allowed.add(`http://${host}:${endpoint.port}`)
    allowed.add(`http://localhost:${endpoint.port}`)
  }
  return allowed.has(origin) ? 'same' : 'cross'
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

function readPackageFile(...segments) {
  try {
    return readFileSync(join(PACKAGE_ROOT, ...segments), 'utf8')
  } catch {
    return ''
  }
}

/** 独立窗口里加载的那个整页面板：外壳 HTML + 同一份 client.js。 */
function renderPanelPage(token) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${windowTitle(token)}</title>
<style>
  html,body{margin:0;height:100%;background:linear-gradient(160deg,#141826,#26201a);color:#f3ead6;
    font:13px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;overflow:hidden}
  #dsh-genshin-launch-panel{position:static!important;width:auto!important;max-width:none!important;
    min-width:0!important;right:auto!important;bottom:auto!important;border:0!important;border-radius:0!important;
    box-shadow:none!important;background:transparent!important;backdrop-filter:none!important;height:100%;
    box-sizing:border-box;padding:16px 18px 20px!important}
</style>
</head>
<body>
<script>window.__DSH_GENSHIN_STANDALONE__=true;window.__DSH_GENSHIN_TOKEN__=${JSON.stringify(token)}</script>
<script src="/dsh-genshin-launch/client.js?token=${token}&mode=standalone"></script>
</body>
</html>
`
}

/** 用系统默认程序打开一个 URL 或目录。 */
async function openExternal(target) {
  if (process.platform !== 'win32') {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const result = await runCaptured(command, [target], { timeoutMs: 15_000 })
    return !result.timedOut && result.status === 0
  }
  // `start` 是 cmd 内建命令；第一个参数是窗口标题，必须给一个空串，
  // 否则带引号的 URL 会被当成标题吃掉。整串按 argv 传，不走 shell 字符串拼接。
  const result = await runCaptured('cmd', ['/c', 'start', '', target], { timeoutMs: 15_000 })
  return !result.timedOut && result.status === 0
}

function logInfo(ctx, message) {
  const safe = maskPathsInText(message)
  try {
    ctx.logger?.info?.(safe)
  } catch {
    /* 忽略 */
  }
  console.log(`[genshin-launch] ${safe}`)
}

/**
 * 深度掩码：把对象里所有字符串值（含嵌套数组/对象）过一遍路径掩码。
 * 状态文件与面板回显的唯一出口是 update()，在这里收口。
 */
function maskDeep(value) {
  if (typeof value === 'string') return maskPathsInText(value)
  if (Array.isArray(value)) return value.map(maskDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = maskDeep(item)
    return out
  }
  return value
}

function logWarn(ctx, message) {
  const safe = maskPathsInText(message)
  try {
    ctx.logger?.warn?.(safe)
  } catch {
    /* 忽略 */
  }
  console.warn(`[genshin-launch] ${safe}`)
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const endpoint = detectEndpoint(ctx)
  /** 安装包**下载**目标：显式配置优先，其次桌面（用户要一眼看到安装包）。 */
  const desktop = resolveDesktopDirectory(config.downloadDir)
  /** 状态/配置/缓存目录：默认 %LOCALAPPDATA%，可用 stateDir 覆盖（测试就指到临时目录）。 */
  const stateDir = resolveStateDir(config.stateDir)

  const statusFile = join(stateDir, STATUS_FILE_NAME)
  const detectCacheFile = join(stateDir, DETECT_CACHE_NAME)
  const sessionFile = join(stateDir, SESSION_FILE_NAME)
  const installerCacheFile = join(stateDir, INSTALLER_CACHE_NAME)

  // —— 隐私整改三件事。清理只在用默认状态目录时做（测试/显式指定 stateDir 时
  //    绝不动用户机器上的桌面和主目录）；%TEMP% 清理只删自己前缀的残留，总是做。——
  let legacyConfig
  if (!config.stateDir) {
    // 1) 老配置里用户手填的路径先捞出来，等 openStore 之后写进新格式（自动加密）。
    legacyConfig = readLegacyConfig()
    // 2) 桌面/主目录里老版本留下的明文 JSON 与脚本一律删掉。
    cleanLegacyStateFiles((message) => logInfo(ctx, message))
  }
  // 3) %TEMP% 里可能残留的注册表 dump / 进程列表（上次被强杀留下的）扫掉。
  sweepTempFiles((message) => logInfo(ctx, message))

  const store = openStore(join(stateDir, CONFIG_FILE_NAME), { onNote: (message) => logInfo(ctx, message) })
  if (legacyConfig && (legacyConfig.gameExe || legacyConfig.gamePath)) {
    // 新配置文件里还没有路径、老文件里有 → 迁移一次（写回去时就带上加密）。
    const now = store.get()
    if (!now.gameExe && !now.gamePath) {
      store.patch({
        gameExe: legacyConfig.gameExe,
        gamePath: legacyConfig.gamePath,
        scanConsent: legacyConfig.scanConsent,
        scanDone: legacyConfig.scanDone,
        sizeBaselineBytes: legacyConfig.sizeBaselineBytes,
        sizeBaselineUrl: legacyConfig.sizeBaselineUrl,
      })
      logInfo(ctx, '已把旧版明文配置迁移为加密格式（手填路径进 DPAPI，冗余字段已清除）')
    }
  }

  const abort = new AbortController()
  const questions = createQuestionHub({
    timeoutMs: Number(config.questionTimeoutMs) > 0 ? Number(config.questionTimeoutMs) : 180_000,
    onNote: (message) => logInfo(ctx, message),
  })

  /** 「宿主 pid + 进程启动时刻」——热重载后仍是同一次启动，但 DSH 重启就会变。 */
  const bootStartMs = Math.round(Date.now() - process.uptime() * 1000)
  const bootId = `${process.pid}@${bootStartMs}`
  const previousSession = readJsonFile(sessionFile)
  // 关键：不能用 bootId 字符串严格相等。`Date.now() - uptime` 在同一个进程里两次采样会差
  // ±1ms（热重载时 apply() 重跑，旧值已经落盘、新值现算，字符串就对不上），那样落盘标记
  // 就形同虚设、热重载后还会再开一个游戏进程。所以按「同一个 pid + 启动时刻相差 < 2s」判
  // 定是不是同一次启动：±1ms 抖动被吸收，而真正的 DSH 重启要么 pid 变了、要么相差巨大。
  const sameBoot = (session) => {
    if (!session || session.pid !== process.pid) return false
    const storedStart = Number.isFinite(session.bootStartMs)
      ? session.bootStartMs
      : Number.parseInt(String(session.bootId ?? '').split('@')[1], 10)
    if (!Number.isFinite(storedStart)) return false
    return Math.abs(storedStart - bootStartMs) < 2000
  }
  let launchedThisBoot = sameBoot(previousSession) && Boolean(previousSession?.launchedAt)
  /** 启动流程的互斥锁：两个页面同时上报时，只有一个能走进去。 */
  let launchInFlight
  /** 是否已经有过一个 UI 面渲染出来（独立窗口 / 网页面板 / 桌面端插件卡）。 */
  let uiReady = false
  /** 有副作用的分支是否已经启动过（整个宿主进程只启动一次）。 */
  let sideEffectsStarted = false
  /** 手动「再扫一次」时用来临时绕过扫盘同意与缓存。 */
  let forceScanOnce = false

  /** 一次性 token：只有被我们注入/自己提供的页面才知道，用来挡住跨站伪造请求。 */
  const token = randomBytes(16).toString('hex')

  const status = {
    plugin: name,
    enabled: config.enabled !== false,
    downloadEnabled: config.download !== false && config.enabled !== false,
    endpoint,
    /** 隐私：只露「哪个盘/目录名」级别的掩码，完整路径不进日志、不进状态文件。 */
    desktop: maskPath(desktop),
    stateDir: maskPath(stateDir),
    phase: 'idle',
    message: '待启动',
    game: { found: false },
    launch: { enabled: config.launchGame !== false, trigger: config.launchTrigger, method: config.launchMethod },
    ui: { ready: false, trigger: config.sideEffectTrigger, standalone: config.standaloneWindow },
    question: undefined,
    config: undefined,
    resolvedUrl: undefined,
    size: undefined,
    downloaded: 0,
    percent: undefined,
    filePath: undefined,
    fileName: undefined,
    error: undefined,
    at: new Date().toISOString(),
  }

  const update = (patch) => {
    // 隐私：所有写进状态文件 / 发给面板的字符串统一过一遍路径掩码。
    // （真实路径只活在内存与加密配置里；面板/日志/状态文件只见掩码形式。）
    Object.assign(status, maskDeep(patch), { at: new Date().toISOString() })
    status.question = questions.view()
    status.config = publicStoreConfig()
    writeJsonFile(statusFile, status)
  }

  const publicStoreConfig = () => {
    const value = store.get()
    const security = store.security()
    return {
      /** 隐私：界面上永远只回显掩码路径；写配置仍收完整路径。 */
      gameExe: maskPath(value.gameExe),
      gamePath: maskPath(value.gamePath),
      /** 老面板/插件卡用过 scanFoundExe：并进 gameExe，这里不再回显。 */
      scanConsent: value.scanConsent,
      scanDone: value.scanDone,
      scanAt: value.scanAt,
      sizeBaselineBytes: value.sizeBaselineBytes,
      sizeBaselineAt: value.sizeBaselineAt,
      sizeBaselineSource: resolveSizeBaseline(value).source,
      /** 存储方式（dpapi / plain / none），面板和自检用它确认"有没有加密"。 */
      encryption: security.encryption,
    }
  }

  const banner = [
    '╔══════════════════════════════════════════════════════════╗',
    '║  原神，启动！                                            ║',
    '╚══════════════════════════════════════════════════════════╝',
  ].join('\n')

  logInfo(ctx, banner)
  logInfo(ctx, `识别到 DSH 端口：${endpoint.port ?? '未知'}（${endpoint.url ?? '未知'}）`)
  logInfo(ctx, `状态目录：${stateDir}`)
  logInfo(ctx, `插件配置：${maskPath(store.path)}（完整路径不再出现在任何日志/界面里）`)
  if (config.__forcedHostTrigger) logWarn(ctx, 'clientNotice 关掉了 → 没有 UI 可用，副作用改为宿主启动即做')
  if (isElectron()) logInfo(ctx, '检测到 Electron 宿主（桌面端），网页面板不会生效，将改用独立窗口')

  // ---------------------------------------------------------------- 探测
  /** 进入慢档（扫盘）前的许可。返回 'allow' 才会真的扫。 */
  const onBeforeScan = async () => {
    if (forceScanOnce) {
      forceScanOnce = false
      logInfo(ctx, '这是手动触发的扫盘，跳过同意检查')
      return 'allow'
    }
    if (config.scanConsent === 'allow') return 'allow'
    if (config.scanConsent === 'deny') return 'deny'

    const value = store.get()
    if (value.scanConsent === 'allowed') return 'allow'
    if (value.scanDone) {
      logInfo(ctx, '已经扫过一次盘了（用户规则：只扫一次永远记住），不再扫；需要重扫请用面板上的按钮')
      return 'deny'
    }
    if (value.scanConsent === 'denied' || value.scanConsent === 'manual') return 'deny'

    // 还没问过 → 问。这是唯一一个会让人等的问题，文案必须把"要做什么"和"有没有风险"讲清楚。
    const answer = await questions.ask({
      kind: 'scan-consent',
      title: '需要在磁盘上找一下《原神》装在哪吗？',
      lines: [
        '前面的自动探测（注册表 + 常见安装路径）都没有找到原神。',
        '最后一步是扫盘：只列目录的名字，找名为「Genshin Impact」「原神」这类文件夹。',
        '· 全程在本机进行，不联网、不上传任何东西',
        '· 不读取任何文件内容，只看文件夹和文件名',
        '· 默认最多往下 4 层，有总时间上限，会自动跳过系统目录',
        '· 扫到了会把路径写进插件配置，以后不再扫',
        `也可以跳过扫盘，直接在插件配置页填写游戏 exe 路径（配置文件在：${maskPath(store.path)}）。`,
      ],
      options: [
        { id: 'allow', label: '继续扫盘', tone: 'primary' },
        { id: 'deny', label: '拒绝', tone: 'plain' },
        { id: 'configure', label: '快速配置路径', tone: 'plain' },
      ],
      defaultOption: 'deny',
    })

    if (answer === 'allow') {
      store.patch({ scanConsent: 'allowed' })
      return 'allow'
    }
    if (answer === 'configure') {
      // 用户选了"我自己填"：记下来，以后不再问（面板会打开快速配置弹窗）
      store.patch({ scanConsent: 'manual' })
      return 'configure'
    }
    store.patch({ scanConsent: 'denied' })
    return 'deny'
  }

  let detectionPromise
  let deepDetectionPromise
  /**
   * 探测。分两个"深度"，因为慢档要么很贵、要么要问用户：
   *
   *   fast —— 宿主一启动就跑。注册表 + 官方默认路径 + 常见路径，几百毫秒，全程只读，
   *           不会问任何问题。用来尽早把"装没装"这个结论放进面板。
   *   full —— 等 UI 面出现之后才跑。会带上慢档（卸载记录全量扫描 + 有界扫盘），
   *           并且可能要弹「要不要扫盘」的窗。
   *
   * 为什么必须分开：如果把慢档放在宿主启动时，那个同意弹窗会在**浏览器还没打开的时候**
   * 挂出去，用户在 180 秒里根本看不到它，只能按最保守的"拒绝"收场 —— 等于白问。
   */
  const detect = (options = {}) => {
    const { mode = 'full', refresh = false, forceScan = false } = options
    if (refresh) {
      detectionPromise = undefined
      deepDetectionPromise = undefined
    }
    if (mode === 'fast') {
      if (!detectionPromise) {
        detectionPromise = runDetection({ allowScan: false }).catch((error) => {
          logWarn(ctx, `探测异常：${error?.message ?? error}`)
          return { found: false, registered: false, log: [`探测异常：${error?.message ?? error}`] }
        })
      }
      return detectionPromise
    }
    if (forceScan) forceScanOnce = true
    if (!deepDetectionPromise) {
      deepDetectionPromise = runDetection({ allowScan: true }).catch((error) => {
        logWarn(ctx, `深度探测异常：${error?.message ?? error}`)
        return { found: false, registered: false, log: [`深度探测异常：${error?.message ?? error}`] }
      })
    }
    return deepDetectionPromise
  }

  /**
   * 探测缓存的读与写（隐私口径）。
   * 盘上只存：命中与否的结论 + **加密后的本体 exe 路径**（功能上必须能立刻知道
   * 「装没装、起没起得来」，但整棵目录结构/启动器路径/游戏目录都不留）。
   */
  const readDetectCache = () => {
    const raw = readJsonFile(detectCacheFile)
    if (!raw || typeof raw !== 'object') return undefined
    const out = { ...raw }
    delete out.secrets
    if (typeof raw.secrets === 'string' && raw.secrets) {
      const opened = unprotect(raw.secrets)
      out.exePath = opened.ok ? opened.value : ''
      if (!opened.ok) logWarn(ctx, '探测缓存里的路径解不开，将重新探测')
    } else if (typeof raw.exePath === 'string' && raw.exePath) {
      // 老版本的明文缓存：本次内存里用，下次写回自动变成加密的。
      out.exePath = raw.exePath
    } else {
      out.exePath = ''
    }
    // 老缓存可能带 installDir/gameDir/launcherPath：一律丢，不留旧明文。
    delete out.installDir
    delete out.gameDir
    delete out.launcherPath
    return out
  }

  const writeDetectCache = (result, { skipScan }) => {
    const hasPath = Boolean(result.found && result.exePath)
    const sealed = hasPath ? protect(JSON.stringify({ exePath: result.exePath })) : { value: '', encrypted: false }
    writeJsonFile(detectCacheFile, {
      version: 2,
      encryption: hasPath ? (sealed.encrypted ? 'dpapi' : 'plain') : 'none',
      found: Boolean(result.found),
      registered: Boolean(result.registered),
      incompleteEvidence: result.incompleteEvidence,
      secrets: sealed.value,
      flavor: result.flavor,
      source: result.source,
      checkedAt: Date.now(),
      scanDone: !skipScan,
    })
  }

  const runDetection = async ({ allowScan }) => {
    const cacheTtlMs = Math.max(0, Number(config.detectionCacheHours) || 0) * 3600 * 1000
    const negativeTtlMs = Math.max(0, Number(config.negativeCacheHours) || 0) * 3600 * 1000
    const cached = readDetectCache()
    const age = cached?.checkedAt ? Date.now() - cached.checkedAt : Number.POSITIVE_INFINITY
    const stored = store.get()

    if (cached?.exePath && cached.found !== false && age < cacheTtlMs && existsSync(cached.exePath)) {
      logInfo(ctx, `沿用上次的探测结果（${new Date(cached.checkedAt).toLocaleString('zh-CN')} 确认过）：${cached.exePath}`)
      return {
        ...cached,
        exeName: cached.exeName ?? null,
        // 启动器**不落盘**：缓存命中要用的时候现找一次（本体目录往上走几层）。
        launcherPath: locateLauncherNear(cached.exePath),
        log: ['命中探测缓存'],
      }
    }
    if (cached?.exePath && cached.found !== false) {
      logInfo(ctx, '上次探测到的原神已经不在原处了，重新探测')
    }

    const skipScan = allowScan && cached && cached.found === false && age < negativeTtlMs && !forceScanOnce
    let sources = config.detectSources
    if (!allowScan) sources = sources.filter((item) => item !== 'scan')
    else if (skipScan) sources = sources.filter((item) => item !== 'scan')
    if (!allowScan && config.detectSources.includes('scan')) logInfo(ctx, '快档探测：先不扫盘，等界面出现后再问')
    if (skipScan) logInfo(ctx, '上次探测没找到原神且结论还新鲜，本次跳过最贵的扫盘那一档')

    const result = await detectGame({
      gameExe: stored.gameExe || config.gameExe,
      gamePath: stored.gamePath || config.gamePath,
      sources,
      scanMaxDepth: Number(config.scanMaxDepth) || 4,
      scanBudgetMs: Number(config.scanBudgetMs) || 20_000,
      extraRoots: config.extraRoots,
      allowScan,
      onBeforeScan,
    })
    for (const line of result.log) logInfo(ctx, `探测 · ${line}`)

    // 扫盘（或慢档的卸载记录全量扫描）找到的路径**自动写进插件配置**：这就是用户要的
    // "扫了一次盘后自动写入地址，然后永远不再扫"。
    // 隐私：只写 gameExe（会加密落盘）；不再有单独的 scanFoundExe 冗余字段。
    const fromSlowTier = result.found && (result.source === 'scan' || result.source === 'registry:sweep')
    if (fromSlowTier) {
      store.patch({
        scanDone: true,
        scanAt: new Date().toISOString(),
        gameExe: result.exePath,
      })
      logInfo(ctx, `扫盘找到并已写入插件配置：${result.exePath}`)
    } else if (forceScanOnce === false && sources.includes('scan') && !result.found) {
      // 扫过了但没找到：也记下来，别每次开 DSH 都再翻一遍磁盘
      const before = store.get()
      if (!before.scanDone && before.scanConsent === 'allowed') {
        store.patch({ scanDone: true, scanAt: new Date().toISOString() })
        logInfo(ctx, '扫盘没有找到原神，已记录（不再自动重扫；需要重扫请用面板按钮）')
      }
    }

    writeDetectCache(result, { skipScan })
    return result
  }

  const publicGame = (game) => ({
    found: Boolean(game.found),
    registered: Boolean(game.registered),
    exePath: maskPath(game.exePath),
    installDir: maskPath(game.installDir),
    gameDir: maskPath(game.gameDir),
    exeName: game.exeName,
    launcherPath: maskPath(game.launcherPath),
    flavor: game.flavor,
    source: game.source,
    incompleteEvidence: game.incompleteEvidence,
  })

  // ---------------------------------------------------------------- 启动
  /** 启动原神（含「本体秒退就改起启动器」的回退）。带互斥锁，F5 连点也不会开两个进程。 */
  const launchFlow = (reason) => {
    if (launchInFlight) {
      logInfo(ctx, '已经有一次启动流程在跑了，这次触发直接忽略')
      return launchInFlight
    }
    launchInFlight = doLaunchFlow(reason).finally(() => {
      launchInFlight = undefined
    })
    return launchInFlight
  }

  const doLaunchFlow = async (reason) => {
    if (config.launchGame === false) {
      update({ phase: 'game-found', message: '已检测到原神，但配置里关闭了自动启动（launchGame: false）' })
      return { started: false, reason: 'launch-disabled' }
    }
    // 这一条是 F5 安全的根本：整个宿主进程只启动一次，与页面加载次数无关。
    if (config.launchOncePerSession !== false && launchedThisBoot) {
      logInfo(ctx, '本次 DSH 进程已经启动过原神了，跳过（F5 或重复上报都不会再开一个游戏进程）')
      return { started: false, reason: 'already-launched-this-session' }
    }

    // 深度探测：到这里说明 UI 已经出现了，慢档要问的问题有人看
    const game = await detect({ mode: 'full' })

    let target
    let targetKind
    if (game.found) {
      target = game.exePath
      targetKind = 'game'
    } else if (game.registered && game.launcherPath) {
      target = game.launcherPath
      targetKind = 'launcher'
    }

    if (!target) {
      logInfo(ctx, '被要求启动原神，但本机没有可启动的目标（此时应当正在走下载流程）')
      if (['idle', 'detecting', 'game-found', 'game-missing'].includes(status.phase)) {
        update({ phase: 'game-missing', message: '没有找到可启动的原神，无法启动', game: { found: false } })
      }
      return { started: false, reason: 'not-installed' }
    }

    // 已经在跑了就别再叫一次（这一问是尽力而为：问不到就当没在跑）。
    // 启动器的真实进程名不止 launcher.exe（实测还有 HYP.exe / HYPHelper.exe），所以查一组。
    const exeNames = targetKind === 'game' ? [game.exeName ?? 'YuanShen.exe'] : ['launcher.exe', 'HYP.exe', 'HYPHelper.exe']
    const alreadyRunning = await isAnyProcessRunning(exeNames)
    if (alreadyRunning === true) {
      logInfo(ctx, `原神（${exeNames[0]}）已经在运行了，不重复启动`)
      launchedThisBoot = true
      // 隐私：会话标记只需要「同一次宿主启动」的证据，路径不落盘。
      writeJsonFile(sessionFile, { bootId, bootStartMs, pid: process.pid, launchedAt: new Date().toISOString(), result: 'already-running' })
      update({ phase: 'already-running', game: publicGame(game), message: '原神已经在运行了' })
      return { started: false, reason: 'already-running' }
    }

    const why = targetKind === 'launcher' ? `本体还没装完，先起米哈游启动器（${reason}）` : `启动原神（${reason}）`
    update({ phase: 'launching', game: publicGame(game), message: `${why}…` })
    logInfo(ctx, `${why}：${target}（方式 ${config.launchMethod}）`)

    const options = {
      method: config.launchMethod,
      cwd: dirname(target),
      watchMs: Number(config.launchWatchMs) || 3000,
      retryShellOnElevation: config.retryShellOnElevation !== false,
    }
    let result = await launchExecutable(target, options)
    let usedFallback = false

    if (
      !result.ok
      && targetKind === 'game'
      && config.fallbackToLauncher !== false
      && game.launcherPath
      && game.launcherPath !== game.exePath
      && alreadyRunning !== true
    ) {
      usedFallback = true
      logWarn(ctx, `本体没起来（${result.detail ?? result.status}），改起米哈游启动器：${game.launcherPath}`)
      update({ phase: 'launching', message: '本体没起来，改起米哈游启动器…', game: publicGame(game) })
      const fallback = await launchExecutable(game.launcherPath, { ...options, cwd: dirname(game.launcherPath) })
      if (fallback.ok) result = { ...fallback, detail: `本体没起来（${result.detail ?? result.status}），已改为启动米哈游启动器` }
    }

    launchedThisBoot = true
    const launchedTarget = result.ok && usedFallback ? game.launcherPath : target
    // 隐私：会话标记只需要「同一次宿主启动」的证据，启动目标（含启动器）不落盘。
    writeJsonFile(sessionFile, {
      bootId,
      bootStartMs,
      pid: process.pid,
      launchedAt: new Date().toISOString(),
      result: result.ok ? result.status : result.status,
    })

    if (result.ok) {
      const message = usedFallback
        ? `本体没起来，已改为启动米哈游启动器：${launchedTarget}`
        : `${targetKind === 'launcher' ? '米哈游启动器' : '原神'}已启动（${result.status === 'running' ? `pid ${result.pid}` : result.detail ?? '已交给系统'}）`
      logInfo(ctx, message)
      update({ phase: 'launched', game: publicGame(game), launch: { ...status.launch, at: new Date().toISOString(), detail: message, targetKind }, message })
      return { started: true, reason: result.status }
    }

    // 按用户要求：绝不主动提权。所以这里只把原因写清楚，不做任何 runas 尝试。
    // spawn 因「清单要求管理员」失败时，上面已经自动改走一次 shell（弹 UAC，用户点同意才提权）；
    // 走到这里说明连那条路也没成——把已经试过 shell 这件事也讲明白，省得用户以为没试过。
    const triedShell = config.launchMethod === 'shell' || config.retryShellOnElevation !== false
    const reasonText = result.status === 'early-exit'
      ? `启动后 ${options.watchMs}ms 内就退出了（code=${result.exitCode ?? 'null'}）。常见原因：客户端版本过低需要先更新，或者原神已经在运行。`
      : `启动失败：${result.detail ?? result.status}${triedShell ? '（spawn 与 shell 两条路都试过了）' : ''}。本插件按设计不会静默提权——若这是管理员清单导致的权限问题，请手动「以管理员身份」打开一次米哈游启动器。`
    logWarn(ctx, reasonText)
    update({ phase: 'launch-failed', game: publicGame(game), launch: { ...status.launch, at: new Date().toISOString(), detail: reasonText }, message: '启动原神失败', error: reasonText })
    return { started: false, reason: result.status, detail: reasonText }
  }

  // ---------------------------------------------------------------- 下载（方案一）
  const downloadFlow = async () => {
    const baseline = resolveSizeBaseline(store.get())
    const bounds = sizeBounds(config, { baselineBytes: baseline.bytes })
    const candidates = [config.url, ...config.extraUrls].filter(Boolean)
    const families = config.probeLatest ? buildProbeFamily(config) : []

    update({ phase: 'resolving', message: '正在确认最新安装包链接…' })
    let resolved
    try {
      resolved = await resolveInstaller({
        urls: candidates,
        probeFamilies: families,
        probeAhead: config.probeLatest ? Math.max(0, Number(config.probeAhead ?? 1)) : 0,
        cacheFile: installerCacheFile,
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

    logInfo(
      ctx,
      `体积安全闸：基准 ${humanSize(bounds.expected)}（${baseline.source === 'learned' ? '上次下载学到的' : '出厂值'}）` +
      `，严格档 ±${humanSize(bounds.tolerance)}，宽档 ${humanSize(bounds.sanityMin)} ~ ${humanSize(bounds.sanityMax)}`,
    )

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
        if (await openExternal(target)) update({ phase: 'opened-fallback', message: `已打开下载页：${target}` })
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

    // —— 宽档：体积超出严格档但还在合理范围，且是官方域名 → 问用户，不自己拍板 ——
    let allowSanity = false
    const verdict = classifySize(resolved.size, bounds)
    if (verdict.tier === 'sanity') {
      if (!isOfficialHost(resolved.url)) {
        update({ phase: 'failed', message: `体积不在严格档内，且不是官方域名，拒绝下载`, error: verdict.reason })
        logWarn(ctx, `${verdict.reason}；且域名不是官方 CDN，直接拒绝。`)
        if (config.openFallbackWhenFailed !== false) await openExternal(config.fallbackUrls[0])
        return
      }
      const answer = await questions.ask({
        kind: 'size-baseline',
        title: '发现一个体积和已知版本不一样的安装包',
        lines: [
          verdict.reason,
          `已知基准：${humanSize(bounds.expected)}（${baseline.source === 'learned' ? '上次下载学到的' : '出厂值'}）`,
          `这次的包：${humanSize(resolved.size)}`,
          '域名是官方 CDN，多半是米哈游更新了启动器；但也可能是链接被换掉了。',
          '选择「信任并更新基准」会下载它，并把基准改成这个新大小（以后就按新基准把关）。',
        ],
        options: [
          { id: 'trust', label: '信任并更新基准', tone: 'primary' },
          { id: 'reject', label: '拒绝', tone: 'danger' },
        ],
        defaultOption: 'reject',
      })
      if (answer !== 'trust') {
        logWarn(ctx, '用户拒绝了这个体积的安装包，退化成打开官方下载页')
        update({ phase: 'no-link', message: '用户拒绝了这个体积的安装包', error: verdict.reason })
        if (config.openFallbackWhenFailed !== false) await openExternal(config.fallbackUrls[0])
        return
      }
      allowSanity = true
      logInfo(ctx, '用户选择信任并更新基准')
    } else if (verdict.tier === 'reject') {
      update({ phase: 'failed', message: '安装包体积离谱，拒绝下载', error: verdict.reason })
      logWarn(ctx, `${verdict.reason} → 直接拒绝，退化成打开官方下载页。`)
      if (config.openFallbackWhenFailed !== false) await openExternal(config.fallbackUrls[0])
      return
    }

    if (config.download === false) {
      logInfo(ctx, '配置为只打开链接，不下载（config.download: false）')
      const opened = await openExternal(resolved.url)
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
          await openExternal(config.fallbackUrls[0])
        }
        return
      }
    }

    update({ phase: 'downloading', message: '正在下载安装包…' })
    const startedAt = Date.now()
    const targetName = fileNameFromUrl(resolved.url)
    try {
      // 安全闸（下载前，最后一道）：体积不在允许档位就直接拒绝这条链接，
      // 连同已有半成品一起丢掉——绝不续传一个体积可疑的文件。
      const preCheck = await enforceInstallerSize({
        url: resolved.url,
        bytes: resolved.size,
        bounds,
        directory: destination,
        fileName: targetName,
        allowUnknown: config.allowUnknownSize === true,
        allowSanity,
      })
      if (!preCheck.allowed) throw new Error(`安全校验拒绝下载：${preCheck.reason}`)

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

      // 落盘后复检：先核「盘上的字节数 == 服务端声明的字节数」（完整性与截断），
      // 再按**最新的**基准复核档位（这次下载若成功，基准已经被换成它自己的大小，
      // 所以这一步真正挡的是"文件被写坏/被换掉"这类事）。
      if (resolved.size && result.size !== resolved.size) {
        await rm(result.path, { force: true }).catch(() => {})
        throw new Error(`落盘复检失败：服务端声明 ${resolved.size} 字节，盘上只有 ${result.size} 字节（文件已删除）`)
      }
      const nextBaselineBytes = result.size
      if (config.autoUpdateSizeBaseline !== false && nextBaselineBytes > 0) {
        store.patch({
          sizeBaselineBytes: nextBaselineBytes,
          sizeBaselineAt: new Date().toISOString(),
          sizeBaselineUrl: resolved.url,
        })
        logInfo(ctx, `体积基准已更新为 ${humanSize(nextBaselineBytes)}（下次按新基准把关）`)
      }
      const newBounds = sizeBounds(config, { baselineBytes: nextBaselineBytes })
      const finalCheck = await enforceInstallerSize({
        url: resolved.url,
        bytes: result.size,
        bounds: newBounds,
        allowUnknown: config.allowUnknownSize === true,
        allowSanity: true,
      })
      if (!finalCheck.allowed) {
        await rm(result.path, { force: true }).catch(() => {})
        throw new Error(`落盘复检拒绝：${finalCheck.reason}（文件已删除）`)
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
        if (await openExternal(relocated ? desktop : result.path)) logInfo(ctx, relocated ? '已在资源管理器中打开桌面。' : '已打开安装包所在目录。')
      }
    } catch (error) {
      const reason = error?.message ?? String(error)
      update({ phase: 'failed', message: `下载失败：${reason}`, error: reason })
      logWarn(ctx, `下载失败：${reason}`)
      if (config.openFallbackWhenFailed !== false) {
        const fallback = config.fallbackUrls[0]
        logWarn(ctx, `退化成打开官方下载页：${fallback}`)
        await openExternal(fallback)
      }
    }
  }

  // ---------------------------------------------------------------- UI 面与副作用门控
  /**
   * 某个 UI 面渲染出来了。
   *
   * 这是整个插件唯一允许产生副作用的入口：网页里的面板、独立窗口、桌面端的插件卡，
   * 谁先到算谁。F5 只是重复调用它 —— 幂等，不会重复启动游戏。
   */
  const markUiReady = (mode) => {
    if (uiReady) return
    uiReady = true
    logInfo(ctx, `UI 已就绪（${mode}）→ 允许执行有副作用的分支`)
    // 走 update() 而不是直接改 status.ui：状态文件里也要留下"UI 出现过"这个事实。
    update({ ui: { ...status.ui, ready: true, mode, at: new Date().toISOString() } })
    void startSideEffects('ui-open')
  }

  /** 有副作用的分支（启动游戏 / 下载安装包）：整个宿主进程只跑一次。 */
  const startSideEffects = async (reason) => {
    if (sideEffectsStarted) return
    sideEffectsStarted = true
    // 到这里才跑"深度探测"：慢档会问「要不要扫盘」，而此刻界面上有人看着。
    const game = await detect({ mode: 'full' })
    if (game.found || game.registered) {
      if (config.launchGame !== false) await launchFlow(reason)
      return
    }
    await downloadFlow()
  }

  /** 独立窗口：桌面端里我们的注入不会执行，所以自己开一个窗口把面板显示出来。 */
  const maybeOpenStandaloneWindow = async () => {
    const mode = config.standaloneWindow
    if (mode === 'off') return
    if (mode === 'auto' && !isElectron()) return
    if (!endpoint.port) {
      logWarn(ctx, '拿不到 DSH 端口，开不了独立窗口')
      return
    }
    const host = endpoint.host === '0.0.0.0' ? '127.0.0.1' : endpoint.host
    const url = `http://${host}:${endpoint.port}/dsh-genshin-launch/panel`
    const result = await openStandaloneWindow({
      url,
      port: endpoint.port,
      token,
      stateDir,
      engine: config.standaloneEngine,
      width: Number(config.standaloneWidth) || 420,
      height: Number(config.standaloneHeight) || 620,
      alwaysOnTop: config.standaloneAlwaysOnTop !== false,
      onNote: (message) => logInfo(ctx, message),
    })
    update({ ui: { ...status.ui, standaloneVia: result.via, standaloneOk: result.ok } })
    if (!result.ok && config.standaloneFailureFallback === true) {
      logWarn(ctx, '独立窗口没开出来，按配置退回"宿主启动就做副作用"')
      markUiReady('standalone-failed')
    }
  }

  // ---------------------------------------------------------------- 主流程
  const run = async () => {
    if (config.enabled === false) {
      update({ phase: 'disabled', message: '插件已禁用（config.enabled: false）' })
      return
    }

    if (config.skipIfInstalled === false) {
      logInfo(ctx, '配置要求无视安装状态（skipIfInstalled: false），直接走下载流程')
      update({ phase: 'game-missing', message: '已按配置跳过安装检测', game: { found: false } })
      if (config.sideEffectTrigger === 'host') await startSideEffects('host-start')
      return
    }

    update({ phase: 'detecting', message: '正在确认本机是否已安装原神…' })
    // 快档：宿主一启动就能给出的结论（不扫盘、不提问），用来尽早把面板点亮。
    const game = await detect({ mode: 'fast' })

    if (game.found) {
      const message = `检测到已安装的原神（${game.flavor ?? '版本未知'}）：${game.exePath}`
      if (status.phase === 'detecting') update({ phase: 'game-found', message, game: publicGame(game) })
      logInfo(ctx, message)
      logInfo(ctx, '已安装 → 停止自动下载，改为「打开 DSH 就启动原神」')
    } else if (game.registered) {
      const evidence = game.incompleteEvidence?.length ? `（${game.incompleteEvidence.join('、')}）` : ''
      const message = `原神已经登记在安装位置，但本体还没装完${evidence}——多半正在下载或更新`
      if (status.phase === 'detecting') update({ phase: 'installing', message, game: publicGame(game) })
      logInfo(ctx, message)
      logInfo(ctx, '判定为「安装 / 更新中」→ 停止自动下载安装包，改为启动米哈游启动器让它继续')
    } else {
      if (status.phase === 'detecting') {
        update({ phase: 'game-missing', message: '本机没有检测到原神，待 UI 就绪后走下载流程', game: { found: false } })
      }
      logInfo(ctx, '没有检测到已安装的原神 → 待 UI 就绪后走下载流程')
    }

    if (config.sideEffectTrigger === 'host') {
      await startSideEffects('host-start')
      return
    }
    // 桌面端：没有网页会来加载我们的注入，自己开独立窗口。
    await maybeOpenStandaloneWindow()
  }

  // ---------------------------------------------------------------- 路由
  const disposers = []
  const respondJson = (res, code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  /**
   * 收下一个会改状态/有副作用的请求前，统一过一遍闸门：
   * 回环来源 + 同源 Origin + 一次性 token。
   */
  const guardRequest = (req, res, { allowOpaqueOrigin = false } = {}) => {
    if (!isLoopbackRequest(req)) {
      respondJson(res, 403, { ok: false, reason: 'forbidden' })
      return false
    }
    const origin = originVerdict(req, endpoint)
    if (origin === 'cross') {
      respondJson(res, 403, { ok: false, reason: 'cross-origin' })
      return false
    }
    if (origin === 'opaque' && !allowOpaqueOrigin) {
      respondJson(res, 403, { ok: false, reason: 'opaque-origin-read-only' })
      return false
    }
    if (req.headers?.['x-dsh-genshin-token'] !== token) {
      respondJson(res, 403, { ok: false, reason: 'bad-token' })
      return false
    }
    return true
  }

  if (config.clientNotice !== false) {
    const routes = [
      {
        path: '/dsh-genshin-launch/status',
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return
          }
          status.question = questions.view()
          status.config = publicStoreConfig()
          respondJson(res, 200, { ...status, noticeSeconds: config.clientNoticeSeconds })
        },
      },
      {
        path: '/dsh-genshin-launch/client.js',
        handler: (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(readPackageFile('lib', 'client.js'))
        },
      },
      {
        // 独立窗口加载的整页面板：和网页面板共用同一份 client.js
        path: '/dsh-genshin-launch/panel',
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(renderPanelPage(token))
        },
      },
      {
        // 「某个 UI 面渲染出来了」——副作用的总开关
        path: '/dsh-genshin-launch/hello',
        handler: (req, res) => {
          if (req.method !== 'POST') return respondJson(res, 405, { ok: false, reason: 'method-not-allowed' })
          if (!guardRequest(req, res, { allowOpaqueOrigin: true })) return
          let mode = 'panel'
          try {
            mode = new URL(req.url, 'http://127.0.0.1').searchParams.get('mode') ?? 'panel'
          } catch {
            /* 忽略 */
          }
          respondJson(res, 200, { ok: true, uiReady, sideEffectsStarted })
          markUiReady(mode === 'standalone' ? '独立窗口' : 'DSH 网页面板')
        },
      },
      {
        // 回答宿主挂出来的问题（扫盘同意 / 体积基准）
        path: '/dsh-genshin-launch/answer',
        handler: (req, res) => {
          if (req.method !== 'POST') return respondJson(res, 405, { ok: false, reason: 'method-not-allowed' })
          if (!guardRequest(req, res, { allowOpaqueOrigin: true })) return
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
            if (body.length > 16 * 1024) req.destroy()
          })
          req.on('end', () => {
            let parsed
            try {
              parsed = JSON.parse(body || '{}')
            } catch {
              return respondJson(res, 400, { ok: false, reason: 'bad-json' })
            }
            const accepted = questions.answer(String(parsed.id ?? ''), String(parsed.option ?? ''))
            respondJson(res, accepted ? 200 : 409, { ok: accepted })
          })
        },
      },
      {
        // 客户端半边（DSH 插件栏里的配置卡）拿 token 用。同源 GET，只给本机页面。
        path: '/dsh-genshin-launch/token',
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) return respondJson(res, 403, { ok: false, reason: 'forbidden' })
          const origin = originVerdict(req, endpoint)
          if (origin === 'cross') return respondJson(res, 403, { ok: false, reason: 'cross-origin' })
          respondJson(res, 200, { ok: true, token })
        },
      },
      {
        // 插件自己的配置：面板与独立窗口都读写这里（DSH 插件页的卡片也是）
        path: '/dsh-genshin-launch/config',
        handler: (req, res) => {
          if (req.method === 'GET') {
            if (!isLoopbackRequest(req)) return respondJson(res, 403, { ok: false, reason: 'forbidden' })
            return respondJson(res, 200, { ok: true, config: publicStoreConfig() })
          }
          if (req.method !== 'POST') return respondJson(res, 405, { ok: false, reason: 'method-not-allowed' })
          if (!guardRequest(req, res, { allowOpaqueOrigin: true })) return
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
            if (body.length > 16 * 1024) req.destroy()
          })
          req.on('end', () => {
            let parsed
            try {
              parsed = JSON.parse(body || '{}')
            } catch {
              return respondJson(res, 400, { ok: false, reason: 'bad-json' })
            }
            const changes = {}
            if (typeof parsed.gameExe === 'string') {
              const value = parsed.gameExe.trim()
              if (value && !existsSync(value)) {
                return respondJson(res, 400, { ok: false, reason: `这个 exe 路径不存在：${value}` })
              }
              changes.gameExe = value
            }
            if (typeof parsed.gamePath === 'string') {
              const value = parsed.gamePath.trim()
              if (value && !existsSync(value)) {
                return respondJson(res, 400, { ok: false, reason: `这个目录不存在：${value}` })
              }
              changes.gamePath = value
            }
            if (Object.keys(changes).length === 0) {
              return respondJson(res, 400, { ok: false, reason: '没有可写入的字段' })
            }
            store.patch(changes)
            logInfo(ctx, `插件配置已更新：${JSON.stringify(changes)}`)
            // 配置变了 → 作废探测缓存（快档和深度探测都要重来），下一次探测立刻生效
            void detect({ refresh: true })
            update({ config: publicStoreConfig(), message: '配置已更新，正在重新探测…' })
            respondJson(res, 200, { ok: true, config: publicStoreConfig() })
          })
        },
      },
      {
        // 手动再扫一次（配置页上的按钮）：先二次确认，再绕过"只扫一次"的规则
        path: '/dsh-genshin-launch/rescan',
        handler: (req, res) => {
          if (req.method !== 'POST') return respondJson(res, 405, { ok: false, reason: 'method-not-allowed' })
          if (!guardRequest(req, res, { allowOpaqueOrigin: true })) return
          respondJson(res, 200, { ok: true, accepted: true })
          void (async () => {
            const answer = await questions.ask({
              kind: 'rescan-confirm',
              title: '确认再扫一次盘？',
              lines: [
                '按你的设置，扫盘只做一次。这是你主动触发的又一次。',
                '· 全程在本机进行，不联网、不上传任何东西',
                '· 只列目录名字，不读取文件内容',
                '· 默认最多往下 4 层，有总时间上限',
              ],
              options: [
                { id: 'allow', label: '开始扫盘', tone: 'primary' },
                { id: 'cancel', label: '取消', tone: 'plain' },
              ],
              defaultOption: 'cancel',
            })
            if (answer !== 'allow') return
            update({ phase: 'detecting', message: '正在按你的要求重新扫盘…' })
            const found = await detect({ mode: 'full', refresh: true, forceScan: true })
            if (found.found) {
              store.patch({
                scanDone: true,
                scanAt: new Date().toISOString(),
                gameExe: found.exePath,
              })
              update({ phase: 'game-found', message: `扫盘找到：${found.exePath}`, game: publicGame(found) })
            } else {
              store.patch({ scanDone: true, scanAt: new Date().toISOString() })
              update({ phase: 'game-missing', message: '这次扫盘没有找到原神', game: { found: false } })
            }
          })().catch((error) => logWarn(ctx, `重扫异常：${error?.message ?? error}`))
        },
      },
    ]

    for (const route of routes) {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
    }

    disposers.push(
      ctx.webServer.tapIndex((html) => {
        if (html.includes('/dsh-genshin-launch/client.js')) return html
        const tag = `<script defer src="/dsh-genshin-launch/client.js?token=${token}"></script>`
        return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
      }),
    )
  }

  // 不阻塞 DSH 启动：探测与后续动作都在后台跑。
  const task = run().catch((error) => {
    logWarn(ctx, `后台任务异常：${error?.message ?? error}`)
  })

  ctx.effect(() => () => {
    abort.abort(new Error('plugin disposed'))
    questions.cancelAll('插件被卸载')
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    void task
  })
}

export default { name, inject, apply }
