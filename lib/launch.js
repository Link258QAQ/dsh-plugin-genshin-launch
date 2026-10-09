// 启动游戏本体。
//
// 实测过的三条通道（在这台机器上用「靶子程序自己写标记文件」自验证过，不靠数窗口）：
//
//   spawn  — `spawn(exe, { detached, stdio:'ignore' })`
//            ✅ 可用。能拿到 pid，能收到 'error' / 'exit'，所以「起来没有」是可判定的。
//   shell  — `cmd /c start "" <exe>`
//            ✅ 可用。走 ShellExecute，语义等于双击：清单要求管理员时由系统弹 UAC，
//            而不是 CreateProcess 直接报 ERROR_ELEVATION_REQUIRED(740)。
//            ❌ 拿不到子进程句柄，只能靠进程名轮询判活。
//   explorer / rundll32 / Start-Process
//            ❌ 在本机的 DSH 沙箱里起不来（explorer 退 0xC0000142）。宿主里未必如此，
//            但不作为主通道。
//
// 默认用 spawn：它是唯一既验证过、又能给出「秒退」信号（版本过低 / 已在运行 / 被反作弊
// 拦下都会表现为早期退出）的通道，而「秒退就改起启动器」正是需求里要的行为。
import { spawn } from 'node:child_process'
import { basename } from 'node:path'

import { runCaptured } from './exec.js'

/** 与 @deepseek-ai/dsh-subprocess 的 scrubbedParentEnv 保持同一口径。 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * 派生一份「脱敏」的环境变量给游戏进程。
 *
 * 游戏完全不需要 DSH 的任何身份信息，而 `DEEPSEEK_API_KEY` 这类东西一旦被继承，
 * 就等于把它交给了一个我们无法审阅的第三方进程（还带着反作弊驱动）。所以照 DSH
 * 自己的做法：抹掉所有 *KEY* / *PASSWORD* / *SECRET* / *TOKEN* 和 DSH_* 。
 *
 * @param {Record<string,string>} [extra]
 * @returns {Record<string,string>}
 */
export function scrubbedEnv(extra) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return { ...env, ...(extra ?? {}) }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 起一个脱离宿主生命周期的 GUI 进程，并在观察窗内判定它「起来了没有」。
 *
 * 观察窗的语义（照抄 DSH 的 launchDetachedApp）：窗口内就退出的算失败；窗口结束时
 * 还活着的一律算成功，之后绝不主动杀它——启动器类的程序会一直活到用户关掉窗口。
 *
 * @param {string} exePath 可执行文件全路径
 * @param {object} [options]
 * @param {string} [options.cwd] 工作目录（游戏一般要求是自己的目录）
 * @param {number} [options.watchMs] 观察窗长度
 * @param {Record<string,string>} [options.env] 附加环境变量
 * @returns {Promise<{ok: boolean, status: 'running'|'early-exit'|'spawn-error', pid?: number, exitCode?: number|null, detail?: string}>}
 */
export function spawnDetached(exePath, options = {}) {
  const { cwd, watchMs = 3000, env } = options
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd,
        env: scrubbedEnv(env),
      })
    } catch (error) {
      resolve({ ok: false, status: 'spawn-error', detail: error?.message ?? String(error) })
      return
    }

    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      // 已经交给系统了就不要再让宿主盯着它：unref 之后 DSH 退出不会带走游戏。
      try {
        child.unref()
      } catch {
        /* 忽略 */
      }
      // 最后一次兜底，避免 unref 之后的历史性 error 事件把宿主打挂。
      child.on('error', () => {})
      resolve(outcome)
    }

    const watch = setTimeout(() => {
      settle({ ok: true, status: 'running', pid: child.pid })
    }, Math.max(0, watchMs))

    child.on('error', (error) => {
      settle({ ok: false, status: 'spawn-error', pid: child.pid, detail: `${error.code ?? '?'}：${error.message}` })
    })
    child.on('exit', (code, signal) => {
      settle({
        ok: false,
        status: 'early-exit',
        pid: child.pid,
        exitCode: code,
        detail: `启动后 ${watchMs}ms 内就退出了（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`,
      })
    })
  })
}

/**
 * 把启动交给系统 shell（ShellExecute 语义，等于双击）。
 *
 * 代价是拿不到子进程句柄：`cmd /c start` 交出去就返回，成功与否只能靠进程名轮询。
 * 用它有两个场景：用户显式配置 `launchMethod: shell`；或者 spawn 被系统按
 * 「需要提权」拦下时自动回退一次（见 {@link launchExecutable}）——它的价值就在于
 * 「清单要求管理员时由系统弹 UAC」，而不是 CreateProcess 直接失败。
 *
 * @param {string} exePath
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ok: boolean, status: 'handed-off'|'handoff-failed', detail?: string}>}
 */
export async function handOffToShell(exePath, options = {}) {
  const { cwd } = options
  const result = await runCaptured('cmd', ['/c', 'start', '', exePath], { cwd, timeoutMs: 15_000 })
  if (result.timedOut) return { ok: false, status: 'handoff-failed', detail: 'cmd /c start 超时' }
  if (result.status !== 0) {
    return { ok: false, status: 'handoff-failed', detail: result.error ?? `cmd 退出码 ${result.status}` }
  }
  return { ok: true, status: 'handed-off', detail: '已交给系统 shell（等价于双击）' }
}

/**
 * 问一组镜像名里有没有在跑的。
 *
 * 需要「一组」是因为米哈游启动器的进程名不止一个：磁盘上是 `launcher.exe`，
 * 但真正跑起来的是它拉起的 `HYP.exe`（旁边还有 `HYPHelper.exe`）。只查
 * `launcher.exe` 会在启动器其实已经开着的时候漏判，于是又去拉一次。
 *
 * 仍然是尽力而为：全问不到就返回 `undefined`（不知道），绝不把「不知道」当「没在跑」。
 *
 * @param {string[]} imageNames
 * @returns {Promise<boolean|undefined>}
 */
export async function isAnyProcessRunning(imageNames) {
  let unknown
  for (const name of imageNames) {
    const running = await isProcessRunning(name)
    if (running === true) return true
    if (running === undefined) unknown = true
  }
  return unknown ? undefined : false
}

/**
 * 用 tasklist 问「这个镜像名在跑吗」。
 *
 * 尽力而为：DSH 沙箱里 tasklist 会返回 Access denied，宿主进程里通常可以。拿不到答案
 * 时返回 `undefined`（不知道），绝不把「不知道」当成「没在跑」。
 *
 * @param {string} imageName 例如 `YuanShen.exe`
 * @returns {Promise<boolean|undefined>}
 */
export async function isProcessRunning(imageName) {
  if (process.platform !== 'win32') return undefined
  const result = await runCaptured('tasklist.exe', ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV'], { timeoutMs: 10_000 })
  if (result.timedOut || result.status !== 0) return undefined
  const text = result.stdout.toLowerCase()
  if (!text.trim()) return undefined
  if (text.includes('no tasks') || text.includes('没有运行的任务')) return false
  return text.includes(imageName.toLowerCase())
}

/**
 * 轮询等待进程出现。
 * @param {string} imageName
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @returns {Promise<boolean|undefined>} true 出现过且还在；false 一直没出现；undefined 无法判定
 */
export async function waitForProcess(imageName, options = {}) {
  const { timeoutMs = 12_000, pollMs = 1000 } = options
  const deadline = Date.now() + timeoutMs
  let sawUnknown = false
  let appeared = false
  for (;;) {
    const running = await isProcessRunning(imageName)
    if (running === undefined) sawUnknown = true
    else if (running) appeared = true
    else if (appeared) return true // 出现过又没了：至少证明它确实起过
    if (Date.now() >= deadline) break
    if (running === false && sawUnknown) break // 判定能力不可用，别白等
    await sleep(pollMs)
  }
  if (appeared) return true
  if (sawUnknown) return undefined
  return false
}

/**
 * 判断一次启动失败是不是「权限 / 需要提权」类的。
 *
 * 实测：原神本体和米哈游启动器的清单都写着 requireAdministrator。用 spawn
 * （CreateProcess 语义）去起这种程序，系统不会弹 UAC，直接失败；Node 把它报成
 * `EACCES`（底层是 ERROR_ELEVATION_REQUIRED=740，个别版本也会把错误码带在 message 里）。
 * 这类失败值得专门认出来：它意味着「改走 shell 就能让用户自己点 UAC 同意」，
 * 而不是「程序坏了 / 没装」。
 *
 * @param {{status?: string, detail?: string, exitCode?: number|null}} result launchExecutable 的返回
 * @returns {boolean}
 */
export function isElevationDenied(result) {
  if (!result || result.ok || result.status !== 'spawn-error') return false
  const text = `${result.detail ?? ''}`
  // 错误码：EACCES 是 Node 映射；740 / ERROR_ELEVATION_REQUIRED / "requireAdministrator"
  // 是 Windows 侧的原话；「elevat」兜底覆盖英文报错。
  return /\bEACCES\b|740|elevat|requireAdministrator|拒绝访问|权限/i.test(text)
}

/**
 * 统一入口：按配置的方式启动一个 exe，并给出「起来了没有」的判定。
 *
 * 默认 spawn。若 spawn 被系统按「需要提权」拦下（EACCES / 740），且没关掉
 * `retryShellOnElevation`，自动改走一次 shell：等价于双击，由 Windows 弹 UAC，
 * **用户点同意才提权**——插件自己不静默提权，这个口子守得住。
 *
 * @param {string} exePath
 * @param {object} [options]
 * @param {'spawn'|'shell'} [options.method]
 * @param {string} [options.cwd]
 * @param {number} [options.watchMs]
 * @param {boolean} [options.retryShellOnElevation] spawn 因权限失败时自动改走 shell 一次
 * @returns {Promise<{ok: boolean, method: string, status: string, pid?: number, exitCode?: number|null, detail?: string}>}
 */
export async function launchExecutable(exePath, options = {}) {
  const { method = 'spawn', cwd, watchMs = 3000, retryShellOnElevation = true } = options

  if (method === 'shell') {
    const handed = await handOffToShell(exePath, { cwd })
    if (!handed.ok) return { ok: false, method, ...handed }
    // 交出去之后再看一眼它到底有没有出现；判不了就当成功（双击本身也没有回执）。
    const running = await waitForProcess(basename(exePath), { timeoutMs: Math.max(3000, watchMs) })
    if (running === false) {
      return { ok: false, method, status: 'not-started', detail: '已经交给系统，但等待期间没有看到对应进程' }
    }
    return { ok: true, method, status: 'handed-off', detail: handed.detail }
  }

  const spawned = await spawnDetached(exePath, { cwd, watchMs })
  const result = { method, ...spawned }

  if (!result.ok && isElevationDenied(result) && retryShellOnElevation) {
    const retried = await launchExecutable(exePath, { method: 'shell', cwd, watchMs, retryShellOnElevation: false })
    if (retried.ok) {
      return { ...retried, detail: `spawn 被系统按权限拦下（清单要求管理员），已改走 shell 弹 UAC：${retried.detail ?? '已交给系统'}` }
    }
    return {
      ...retried,
      detail: `spawn 因权限失败，shell 也没成（spawn：${result.detail ?? result.status}；shell：${retried.detail ?? retried.status}）`,
    }
  }

  return result
}
