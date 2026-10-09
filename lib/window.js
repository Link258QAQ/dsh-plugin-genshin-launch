// 独立窗口：在**网页之外**开一个真正的 OS 窗口来显示面板。
//
// 什么时候需要它：DSH 桌面端是 Electron，界面走 `file://` 加载，我们的 `<script>` 注入
// （只作用于 HTTP 提供的 index.html）在那儿不会执行。所以桌面端必须有别的办法把面板
// 显示出来 —— 就是这个独立窗口。
//
// 三级降级，都是本机现有的东西，不引入任何依赖：
//
//   1) Electron 原生窗口。在 Electron 里 `process.versions.electron` 有值，`electron` 的
//      `BrowserWindow` 支持 `alwaysOnTop`，是唯一能做到"真置顶"的通道。
//   2) Edge / Chrome 的 `--app=` 模式。拿到的就是一个没有地址栏和标签栏的独立窗口，
//      画面和网页版完全一致（它就是我们的同一张页面）。置顶再补一次 Win32 调用。
//   3) 默认浏览器新标签页。最不济也得让人看得见。
//
// 两个实测踩出来的坑，决定了下面为什么长这样：
//
//   * **窗口标题必须带一个纯 ASCII 的唯一标记。** 置顶/关闭都要靠"按标题找窗口"，
//     而 `powershell.exe`（5.1）读 .ps1 文件时默认按 ANSI 解码 —— 脚本里写中文标题
//     会变成乱码，`FindWindow` 永远找不到。所以脚本内容全 ASCII，只匹配
//     `#<hex>` 这个标记，窗口标题则是 `原神，启动！ #<hex>`。
//   * **不能按 spawn 拿到的 pid 收窗口。** Edge/Chrome 用 `--user-data-dir` 起新实例时，
//     被 spawn 的那个进程会立刻退出、真正的浏览器进程是另一个 pid。所以收窗口也得
//     "按标题找窗口 → 拿窗口所属 pid → 杀那个 pid"。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCaptured } from './exec.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 独立窗口标题的固定前缀（展示用）。 */
export const WINDOW_TITLE_BASE = '原神，启动！'

/** 由 token 派生一个 ASCII 标记，用来在系统里唯一标识我们这次开的窗口。 */
export function windowTag(token) {
  return `#${String(token ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 10) || 'dshgenshin'}`
}

/** 完整窗口标题：给人看的中文 + 给脚本匹配的 ASCII 标记。 */
export function windowTitle(token) {
  return `${WINDOW_TITLE_BASE} ${windowTag(token)}`
}

/** 常见浏览器位置（Edge 优先：Windows 上一定有）。 */
function browserCandidates() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean)
}

/** 找一个支持 `--app=` 的 Chromium 系浏览器。 */
export function findChromiumBrowser() {
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 我们在不在 Electron 里（桌面端）。 */
export function isElectron() {
  return Boolean(process.versions?.electron)
}

/** 试着拿到 Electron 的 BrowserWindow。拿不到就返回 undefined（比如宿主跑在 utility 进程里）。 */
async function electronApi() {
  if (!isElectron()) return undefined
  try {
    const mod = await import('electron')
    const api = mod?.default ?? mod
    if (api && typeof api.BrowserWindow === 'function') return api
  } catch {
    /* 不在主进程 / 模块解析不到：走浏览器那条路 */
  }
  return undefined
}

/**
 * 生成「按标题找窗口 → 置顶 / 报出所属 pid」的 PowerShell 脚本。
 *
 * 全 ASCII（见文件头说明），靠 `EnumWindows` + 标题子串匹配，比 `FindWindow` 精确标题
 * 匹配稳得多（浏览器有时会往标题后面追加东西）。
 *
 * 输出协议（一行，好解析）：
 *   found <pid>      找到了，pid 是窗口所属进程
 *   not-found        重试次数用完还没找到
 *   topmost-ok       已置顶
 */
function windowScriptSource(attempts, intervalMs) {
  return `param([string]$Action = 'topmost', [string]$Tag = 'x')
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshGenshinWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  static string needle = "";
  static IntPtr found = IntPtr.Zero;
  static uint owner = 0;
  public static string Find(string tag) {
    needle = tag; found = IntPtr.Zero; owner = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      if (t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h;
      uint pid; GetWindowThreadProcessId(h, out pid); owner = pid;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return "not-found";
    return "found " + owner;
  }
  public static string Topmost() {
    if (found == IntPtr.Zero) return "no-window";
    SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    return "topmost-ok";
  }
}
"@
$result = 'not-found'
for ($i = 0; $i -lt ${attempts}; $i++) {
  $result = [DshGenshinWin]::Find($Tag)
  if ($result -like 'found*') { break }
  Start-Sleep -Milliseconds ${intervalMs}
}
if ($result -like 'found*') {
  if ($Action -eq 'topmost') { Write-Output ([DshGenshinWin]::Topmost()) }
  Write-Output $result
} else {
  Write-Output 'not-found'
}
`
}

/** 把脚本写到状态目录（内容全 ASCII，PowerShell 5.1 按 ANSI 读也不会坏）。 */
function writeWindowScript(stateDir) {
  const dir = stateDir ?? process.cwd()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'dsh-genshin-launch-window.ps1')
  writeFileSync(file, windowScriptSource(20, 500), 'ascii')
  return file
}

/**
 * 置顶（后台跑，不阻塞主流程）。
 * @param {string} stateDir
 * @param {string} tag
 * @param {(message: string) => void} [onNote]
 */
export function makeTopmost(stateDir, tag, onNote) {
  if (process.platform !== 'win32') return
  try {
    const script = writeWindowScript(stateDir)
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'topmost', '-Tag', tag],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.on('error', (error) => onNote?.(`置顶脚本启动失败：${error.message}`))
    child.unref()
  } catch (error) {
    onNote?.(`置顶脚本写入失败：${error?.message ?? error}`)
  }
}

/**
 * 把我们开的那个窗口关掉。
 *
 * 原生窗口直接按 pid 收（powershell 进程就是窗体的宿主）；浏览器窗口不能按 spawn 的 pid
 * 收（Edge/Chrome 会把窗口交给已有进程、被 spawn 的那个立刻退出），得按标题找到窗口
 * 所属进程再杀。
 *
 * @param {object} options
 * @param {string} [options.stateDir]
 * @param {string} [options.tag]
 * @param {number} [options.pid] 原生窗口的进程号
 * @param {string} [options.via] 开窗时走的通道
 * @returns {Promise<{ok: boolean, pid?: number, detail?: string}>}
 */
export async function closeStandaloneWindow(options = {}) {
  if (process.platform !== 'win32') return { ok: false, detail: '仅 Windows 支持' }
  const { stateDir, tag, pid, via } = options

  if (via !== 'browser-app' && Number.isFinite(pid)) {
    const killed = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    const code = await new Promise((resolve) => killed.on('close', resolve))
    return code === 0 ? { ok: true, pid } : { ok: false, pid, detail: `taskkill 退出码 ${code}` }
  }

  try {
    const script = writeWindowScript(stateDir)
    const result = await runCaptured(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'close', '-Tag', tag ?? ''],
      { timeoutMs: 20_000 },
    )
    const match = /found (\d+)/.exec(result.stdout)
    if (!match) return { ok: false, detail: `没找到窗口（${result.stdout.trim() || '无输出'}）` }
    const foundPid = Number(match[1])
    const killed = spawn('taskkill', ['/PID', String(foundPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    const code = await new Promise((resolve) => killed.on('close', resolve))
    return code === 0 ? { ok: true, pid: foundPid } : { ok: false, pid: foundPid, detail: `taskkill 退出码 ${code}` }
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) }
  }
}

/**
 * 把原生窗口脚本写到状态目录。
 *
 * **必须带 UTF-8 BOM**：Windows PowerShell 5.1 读 .ps1 时默认按 ANSI 解码，没有 BOM 的话
 * 脚本里所有中文（界面文案、按钮文字）都会变成乱码。这个坑在置顶脚本上已经踩过一次。
 */
function materializeNativeScript(stateDir) {
  const source = readFileSync(join(PACKAGE_ROOT, 'assets', 'standalone-window.ps1'), 'utf8')
  const dir = stateDir ?? process.cwd()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'dsh-genshin-launch-window-native.ps1')
  writeFileSync(file, `\uFEFF${source.replace(/^\uFEFF/, '')}`, 'utf8')
  return file
}

/**
 * 原生窗口（WinForms，不经任何浏览器内核）。
 *
 * 相对浏览器 `--app=` 的好处：不需要浏览器 profile，因此**不会有"首次使用 / 隐私收集"
 * 向导**；启动更快；置顶是窗体自己的属性，不用去 Win32 里按标题捞窗口。
 * 代价是它是一套独立的原生界面，长得和网页面板不完全一样（功能一致）。
 */
function openNativeWindow(options) {
  const { port, token, tag, stateDir, width, height, alwaysOnTop, onNote } = options
  const script = materializeNativeScript(stateDir)
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Port',
      String(port),
      '-Token',
      token,
      '-Tag',
      tag,
    ],
    // windowsHide 只藏掉 powershell 自己的控制台窗口；WinForms 窗体照常显示。
    { detached: true, stdio: 'ignore', windowsHide: true },
  )
  child.on('error', (error) => onNote?.(`原生窗口启动失败：${error.message}`))
  child.unref()
  void width
  void height
  void alwaysOnTop // 窗体自己在脚本里设了 TopMost
  onNote?.('已用原生 Windows 窗口打开面板（无浏览器内核、无首次向导）')
  return { ok: true, via: 'native', pid: child.pid }
}

/**
 * 打开独立窗口。
 *
 * @param {object} options
 * @param {string} [options.url] 网页面板地址（浏览器引擎与兜底用）
 * @param {number} [options.port] DSH 端口（原生窗口要打 HTTP 接口）
 * @param {string} options.token 一次性 token
 * @param {'native'|'browser'} [options.engine] 非 Electron 时用哪个引擎，默认 native
 * @param {string} [options.stateDir] 放脚本与浏览器 profile 的目录
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {boolean} [options.alwaysOnTop]
 * @param {(message: string) => void} [options.onNote]
 * @returns {Promise<{ok: boolean, via: 'electron'|'native'|'browser-app'|'default-browser'|'none', detail?: string, pid?: number}>}
 */
export async function openStandaloneWindow(options) {
  const { url, port, token = '', stateDir, engine = 'native', width = 420, height = 620, alwaysOnTop = true, onNote } = options
  const title = token ? windowTitle(token) : WINDOW_TITLE_BASE
  const tag = windowTag(token)

  // —— ① Electron 原生窗口 ——
  const electron = await electronApi()
  if (electron) {
    try {
      const win = new electron.BrowserWindow({
        width,
        height,
        title,
        alwaysOnTop,
        autoHideMenuBar: true,
        resizable: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      })
      await win.loadURL(url)
      onNote?.('已用 Electron 原生窗口打开面板（置顶）')
      return { ok: true, via: 'electron' }
    } catch (error) {
      onNote?.(`Electron 开窗失败，改用其它引擎：${error?.message ?? error}`)
    }
  }

  // —— ② 原生 WinForms 窗口（默认）——
  if (engine !== 'browser' && process.platform === 'win32' && port) {
    try {
      return openNativeWindow({ port, token, tag, stateDir, width, height, alwaysOnTop, onNote })
    } catch (error) {
      onNote?.(`原生窗口不可用，改用浏览器窗口：${error?.message ?? error}`)
    }
  }

  // —— ③ Edge / Chrome 的 --app= 独立窗口 ——
  const browser = findChromiumBrowser()
  if (browser) {
    try {
      // 刻意**不**加 --user-data-dir：用全新 profile 首次启动一定会弹浏览器的
      // "首次使用 / 隐私收集"向导，那对一个游戏小面板来说不可接受。用用户自己的
      // 默认 profile 就没有这个向导，而且能直接复用已经在跑的浏览器进程、开窗更快。
      const args = [
        `--app=${url}`,
        `--window-size=${width},${height}`,
        '--no-first-run',
        '--no-default-browser-check',
      ]
      const child = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', (error) => onNote?.(`浏览器启动失败：${error.message}`))
      child.unref()
      onNote?.(`已用 ${browser.split('\\').pop()} 的 --app= 模式打开独立窗口`)
      if (alwaysOnTop) makeTopmost(stateDir, tag, onNote)
      // pid 可能很快退出（浏览器会把窗口交给已有进程），收尾请用 closeStandaloneWindow。
      return { ok: true, via: 'browser-app', detail: browser, pid: child.pid }
    } catch (error) {
      onNote?.(`浏览器开窗失败，改用默认浏览器：${error?.message ?? error}`)
    }
  }

  // —— ④ 默认浏览器新标签页 ——
  if (process.platform === 'win32') {
    const result = await runCaptured('cmd', ['/c', 'start', '', url], { timeoutMs: 15_000 })
    if (!result.timedOut && result.status === 0) {
      onNote?.('没能开出独立窗口，已用默认浏览器打开面板')
      return { ok: true, via: 'default-browser' }
    }
  }
  onNote?.('打不开任何窗口，请手动访问面板地址')
  return { ok: false, via: 'none', detail: url }
}
