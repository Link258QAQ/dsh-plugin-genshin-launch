// 只读注册表读取。
//
// 用 Windows 自带的 reg.exe，不需要管理员、不需要任何原生依赖、不需要 C++ 编译。
// 这条路线不是我们发明的：DSH 自己的 open-in-app 插件在 Windows 上就是 `reg.exe
// query <root> /s` 读卸载记录来发现已安装程序的。
//
// 两个实测踩过的坑，都在这里一次性处理掉：
//
//  1) 输出编码。reg.exe 按「控制台输出代码页」写字节：中文 Windows 上常见是
//     936（GBK），也可能是 65001（UTF-8）。直接按 UTF-8 解会把中文安装路径解成
//     乱码 —— 而中文路径恰恰是这个插件最需要读对的东西。
//     做法：统一先 `chcp 65001` 再查，输出就是确定的 UTF-8，不用去猜当前代码页。
//     实测这一步不增加耗时（1529ms vs 1537ms）。
//
//  2) 输出格式。reg.exe 的输出以空行开头；默认值在不同语言下叫 `(默认)` 或
//     `(Default)`；值名本身可以含空格。所以解析时按 `REG_*` 类型标记定位列，
//     而不是按固定列宽切。
import { runCaptured } from './exec.js'

// 单次查询的上限。设得偏小是有意的：任何一条查询跑到几秒以上都属于病态
// （实测 `HKCU\Software\miHoYo\原神` 会跑 20 秒），宁可跳过这一条也不要拖住启动。
const READ_TIMEOUT_MS = 8_000

/** 把输出接到 UTF-8 上：先切代码页，再跑真正的命令。 */
const CHCP_PREFIX = 'chcp 65001>nul & '

/**
 * 解析 `reg query` 的输出为「子键路径 -> { 值名: 值 }」。
 * 只收 REG_SZ / REG_EXPAND_SZ：我们只关心字符串，二进制值（米哈游塞了一堆
 * MIHOYOSDK_* 的加密 blob）既不必要又会把内存撑大。
 *
 * @param {string} dump reg.exe 的 stdout（已按 UTF-8 解码）
 * @returns {Map<string, Map<string, string>>}
 */
export function parseRegistryDump(dump) {
  const keys = new Map()
  let current
  for (const line of dump.split(/\r?\n/)) {
    if (/^HK/i.test(line)) {
      current = new Map()
      keys.set(line.trim(), current)
      continue
    }
    const match = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (!match || current === undefined) continue
    const name = /^\(.*\)$/.test(match[1]) ? '(Default)' : match[1]
    current.set(name, match[3].trim())
  }
  return keys
}

/** 键名安全校验：会被塞进 `cmd /c` 的整串命令里，所以必须挡住 cmd 的元字符。 */
function isSafeRegistryKey(key) {
  return typeof key === 'string' && /^HK[A-Z_]*\\[^\r\n"&|<>^%]*$/i.test(key)
}

/** 批量查询时的分隔行。挑一个几乎不可能出现在注册表数据里的字符串。 */
const BATCH_SEPARATOR = '---DSH-GENSHIN-LAUNCH-SEP---'

/**
 * 一次 spawn 查多个键。
 *
 * 为什么值得单独做：每次 `cmd /c chcp … & reg query …` 的进程启动开销约 67ms。
 * 「3 个卸载记录根 × 4 个可能的键名」全落空时就是 12 次 ≈ 800ms，纯白花。
 * 串成一条 `cmd /c` 之后只剩一次进程启动（约 70ms），快了十倍。
 *
 * @param {Array<{key: string, recursive?: boolean}>} items
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Map<string, {ok: boolean, keys: Map<string, Map<string, string>>, reason?: string}>>}
 */
export async function readRegistryMany(items, options = {}) {
  const { timeoutMs = READ_TIMEOUT_MS } = options
  const result = new Map()
  const usable = []
  for (const item of items) {
    if (!isSafeRegistryKey(item?.key)) {
      result.set(item?.key, { ok: false, keys: new Map(), reason: `键名不合法：${String(item?.key)}` })
      continue
    }
    usable.push(item)
  }
  if (!usable.length) return result

  const parts = usable.map((item) => `reg query "${item.key}"${item.recursive === false ? '' : ' /s'}`)
  const command = `${CHCP_PREFIX}${parts.join(` & echo ${BATCH_SEPARATOR} & `)}`
  const captured = await runCaptured('cmd', ['/c', command], { timeoutMs, windowsVerbatimArguments: true })

  const segments = captured.stdout ? captured.stdout.split(new RegExp(`^\\s*${BATCH_SEPARATOR}\\s*$`, 'm')) : []
  usable.forEach((item, index) => {
    const segment = segments[index] ?? ''
    if (!segment.trim()) {
      result.set(item.key, { ok: false, keys: new Map(), reason: `${item.key} 不存在或没有值` })
      return
    }
    const keys = parseRegistryDump(segment)
    if (!keys.size) {
      result.set(item.key, { ok: false, keys, reason: `${item.key} 不存在` })
      return
    }
    result.set(item.key, { ok: true, keys })
  })
  return result
}

/**
 * 读一棵注册表子树（或单个键）。
 *
 * @param {string} key 形如 `HKCU\Software\miHoYo\HYP`
 * @param {object} [options]
 * @param {boolean} [options.recursive] 是否 `/s` 递归
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, keys: Map<string, Map<string, string>>, reason?: string}>}
 */
export async function readRegistry(key, options = {}) {
  const { recursive = true, timeoutMs = READ_TIMEOUT_MS } = options
  if (!isSafeRegistryKey(key)) {
    return { ok: false, keys: new Map(), reason: `键名不合法：${String(key)}` }
  }
  const command = `reg query "${key}"${recursive ? ' /s' : ''}`
  const result = await runCaptured('cmd', ['/c', CHCP_PREFIX + command], {
    timeoutMs,
    windowsVerbatimArguments: true,
  })
  if (result.timedOut) return { ok: false, keys: new Map(), reason: `${key} 查询超时` }
  if (!result.stdout) {
    return { ok: false, keys: new Map(), reason: result.error ? `${key} 读取失败：${result.error}` : `${key} 不存在或没有值` }
  }
  const keys = parseRegistryDump(result.stdout)
  // reg.exe 在键不存在时退出码非 0 且没有输出；存在但没有值时会打印键名。
  if (!keys.size) return { ok: false, keys, reason: `${key} 不存在` }
  return { ok: true, keys }
}

/** 把一个键下所有字符串值摊平出来，方便「值名未知」时盲取路径。 */
export function stringValues(keys) {
  const out = []
  for (const [keyPath, values] of keys) {
    for (const [name, data] of values) out.push({ keyPath, name, data })
  }
  return out
}

/** 展开 `%VAR%`；有变量解不出来时返回原串（不丢信息，交由后续文件校验否决）。 */
export function expandEnvironment(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/%([^%]+)%/g, (token, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? token)
}

/** 去掉外层的引号与 `,0` 这类图标索引后缀。 */
export function stripQuotesAndIconIndex(value) {
  return String(value ?? '')
    .trim()
    .replace(/,-?\d+$/, '')
    .replace(/^"|"$/g, '')
    .trim()
}

const WINDOWS_PATH = /[A-Za-z]:[\\/][^\r\n"<>|*?]*/g

/**
 * 从一段文本里抠出所有 Windows 路径（用于 UninstallString / DisplayIcon 这类
 * 混着参数和引号的字段）。
 * @param {string} text
 * @returns {string[]}
 */
export function extractWindowsPaths(text) {
  const found = String(text ?? '').match(WINDOWS_PATH)
  return found ? found.map((item) => item.trim()).filter(Boolean) : []
}

/** 这个字符串是不是一个「盘符开头的路径」。 */
export function looksLikeWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(stripQuotesAndIconIndex(value))
}
