// 隐私与凭据处理。
//
// 这个文件只干三件事，都跟"别把用户的东西留下"有关：
//
//  1) **掩码**（maskPath / maskPathsInText）：给宿主日志、面板、配置卡、原生窗口用。
//     绝对路径里把用户名、中间目录全藏起来，只留「盘符 + 末段名字」——
//     `C:\Users\alice\Games\Genshin Impact\YuanShen.exe` → `C:\…\YuanShen.exe`。
//     够用户认出"是这个"，又不会把"装在哪个用户哪个目录"写进日志/界面。
//
//  2) **加密**（protect / unprotect）：剩下"功能必须留"的敏感项（游戏本体 exe 全路径、
//     手填安装目录）落盘前用 Windows DPAPI（当前用户范围）加密。
//     - 不引任何原生依赖：直接 `spawnSync powershell` 调 .NET 的 ProtectedData。
//     - DPAPI 不可用（非 Windows / 企业策略锁了 ConstrainedLanguage / .NET 缺失）
//       → **降级为明文**，并记下原因，由调用方在文档/日志里讲明白。绝不因为加密失败就丢数据。
//     - 落盘格式带前缀 `enc:v1:` 标记；没前缀的按明文读（兼容老配置，下次写回自动升级）。
//
//  3) **临时残留清理**（sweepTempFiles）：exec.js 把 reg.exe / tasklist 的 stdout 接到
//     `%TEMP%\dsh-genshin-launch-*.out`，正常跑完就删；但进程被强杀 / 崩溃会**永久残留**
//     一份含本机其它软件安装路径、进程列表的明文 dump。插件一启动就把这个前缀的旧文件扫掉。
//
// DPAPI 用 spawnSync 是刻意的：调用方（store.js）大量在同步路径里读配置，异步加解密会把
// 整条探测链路改成 Promise 串、牵连所有测试。一次短字符串加解密约 100~200ms，只在插件启动
// 和写配置时各发生一次，可接受。
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 加密落盘的标记前缀。带它 = DPAPI blob(base64)；不带 = 明文（老配置或降级）。 */
export const ENC_PREFIX = 'enc:v1:'

const TEMP_PREFIX = 'dsh-genshin-launch-'

// ------------------------------------------------------------------ 掩码

/**
 * 把一个 Windows 绝对路径压成「盘符 + 末段」。
 * 非绝对路径 / 太短的路径原样返回（没什么可藏的）。
 *
 * @param {string} value
 * @returns {string}
 */
export function maskPath(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  // 只认「盘符:\」或 UNC 开头才算绝对路径。
  const drive = /^[A-Za-z]:[\\/]/.test(text)
  const unc = /^\\\\[^\\]+\\[^\\]+/.test(text)
  if (!drive && !unc) return text
  const parts = text.split(/[\\/]+/).filter(Boolean)
  const tail = parts[parts.length - 1] ?? ''
  if (drive) {
    const driveLabel = `${text[0].toUpperCase()}:`
    // 末段就是盘符本身（如 "D:\"）：没有可藏的东西。
    return parts.length <= 1 ? `${driveLabel}\\` : `${driveLabel}\\…\\${tail}`
  }
  // UNC：保留服务器 + 共享名，藏掉其后所有层级。
  const head = `\\\\${parts[0]}\\${parts[1] ?? ''}`
  return parts.length <= 2 ? head : `${head}\\…\\${tail}`
}

// 文本里任意「盘符:\…\末段」形式的连续路径片段（不含空格，够覆盖典型报错文案）。
const PATH_IN_TEXT = /[A-Za-z]:[\\/][^\s"'`<>|]*$/gm

/**
 * 把一段日志/文案里出现的所有绝对路径就地掩码。
 * 用于写宿主日志前过一遍，省得每条 logInfo 都要手动脱。
 *
 * 注意负向后顾：只有「盘符」前面不是字母/数字时才认。
 * 否则 `http://127.0.0.1:3080` 里的 `p://…` 会被当路径掩码成 `P:\…\…`（把 URL 打烂）。
 *
 * @param {string} text
 * @returns {string}
 */
export function maskPathsInText(text) {
  if (typeof text !== 'string' || !text) return text
  return text.replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|]*/g, (match) => maskPath(match))
}

// ------------------------------------------------------------------ 加密（DPAPI）

/** PowerShell 侧的 ProtectedData 调用（加密）。输入走 argv，输出 base64 到 stdout。 */
const PS_PROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Text.Encoding]::UTF8.GetBytes($env:DSH_GENSHIN_PLAIN)
$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($e)
`.trim()

/** PowerShell 侧的 ProtectedData 调用（解密）。 */
const PS_UNPROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$e=[Convert]::FromBase64String($env:DSH_GENSHIN_CIPHER)
$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($b)
`.trim()

/** DPAPI 可用性缓存：undefined = 还没试过，true/false = 已判定。 */
let dpapiAvailable

/** 上一次加/解密失败的原因，供日志/文档说明"为什么是明文"。 */
let dpapiReason = ''

/** 当前是不是跑在 Windows 上（非 Windows 直接判 DPAPI 不可用）。 */
export function isWindows() {
  return process.platform === 'win32'
}

/** 跑一次 powershell，把 stdout 收回来（用 argv 传明文，避免命令行泄露——见 runDPAPI）。 */
function runDPAPI(script, envName, value) {
  if (!isWindows()) return { ok: false, output: '', reason: '非 Windows' }
  if (dpapiAvailable === false) return { ok: false, output: '', reason: dpapiReason || 'DPAPI 已知不可用' }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    // 明文只经环境变量传给这一个子进程，不落命令行、不落磁盘。
    env: { ...process.env, [envName]: value },
  })
  if (result.error) {
    return { ok: false, output: '', reason: result.error.message }
  }
  const stdout = String(result.stdout ?? '').trim()
  if (result.status !== 0 || !stdout) {
    return { ok: false, output: '', reason: (result.stderr ?? '').toString().trim().slice(0, 200) || `powershell 退出码 ${result.status}` }
  }
  return { ok: true, output: stdout, reason: '' }
}

/**
 * 加密一段字符串。成功返回 `enc:v1:<base64>`；不可用返回 `{plain:true}`（降级）。
 * @param {string} plain
 * @returns {{ value: string, encrypted: boolean, reason?: string }}
 */
export function protect(plain) {
  if (typeof plain !== 'string' || plain === '') return { value: '', encrypted: false }
  const ran = runDPAPI(PS_PROTECT, 'DSH_GENSHIN_PLAIN', plain)
  if (!ran.ok) {
    dpapiAvailable = false
    dpapiReason = ran.reason
    return { value: plain, encrypted: false, reason: ran.reason }
  }
  dpapiAvailable = true
  dpapiReason = ''
  return { value: `${ENC_PREFIX}${ran.output}`, encrypted: true }
}

/**
 * 解密一段落盘值。无前缀（明文/老配置）原样返回；有前缀但解不开返回空串（调用方按未配置处理）。
 * @param {string} stored
 * @returns {{ value: string, wasEncrypted: boolean, ok: boolean, reason?: string }}
 */
export function unprotect(stored) {
  if (typeof stored !== 'string' || stored === '') return { value: '', wasEncrypted: false, ok: true }
  if (!stored.startsWith(ENC_PREFIX)) return { value: stored, wasEncrypted: false, ok: true }
  const ran = runDPAPI(PS_UNPROTECT, 'DSH_GENSHIN_CIPHER', stored.slice(ENC_PREFIX.length))
  if (!ran.ok) return { value: '', wasEncrypted: true, ok: false, reason: ran.reason }
  dpapiAvailable = true
  return { value: ran.output, wasEncrypted: true, ok: true }
}

/** DPAPI 当前判定：true / false / undefined（还没试过）。 */
export function dpapiStatus() {
  return dpapiAvailable
}

/** 最近一次 DPAPI 失败原因（用于日志/文档说明降级）。 */
export function dpapiFailureReason() {
  return dpapiReason
}

// ------------------------------------------------------------------ 临时残留清理

/**
 * 删掉 %TEMP% 下我们插件前缀的 *.out 残留（reg dump / tasklist 输出）。
 * 只删**自己前缀 + .out 后缀 + 普通文件 + 早于本次进程启动**的，避免误删正在写的。
 *
 * @param {(message: string) => void} [onNote]
 * @returns {{ removed: number, failed: number }}
 */
export function sweepTempFiles(onNote) {
  const removed = { removed: 0, failed: 0 }
  if (!isWindows()) return removed
  let entries
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return removed
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith('.out')) continue
    const full = join(tmpdir(), name)
    try {
      const info = statSync(full)
      if (!info.isFile()) continue
      // 留给正在跑的实例：太新的（60s 内）不动，免得抢掉一个在途 runCaptured 的捕获文件。
      if (now - info.mtimeMs < 60_000) continue
      unlinkSync(full)
      removed.removed += 1
    } catch {
      removed.failed += 1
    }
  }
  if (removed.removed) onNote?.(`已清理 ${removed.removed} 个上次的临时捕获残留（含注册表/进程列表）`)
  if (removed.failed) onNote?.(`有 ${removed.failed} 个临时残留没删掉（可能被占用）`)
  return removed
}
