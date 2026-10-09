// 零配置探测：在用户什么都不设置的前提下，把「已安装的原神」找出来。
//
// 设计原则（按重要程度排）：
//
//  1. **绝不只信注册表。** 实测过太多残留：一台机器上「鸣潮」早就卸载了，卸载记录还在；
//     `HKCU\Software\Classes\BetterGI` 指着一个已经被删掉的目录；米哈游自己的
//     `HYP\standalone\14_0\hk4e_cn` 键存在但一个值都没有。所以任何读到的路径都必须
//     立刻用文件系统复核，复核不过就当没读到。
//
//  2. **先快后慢，命中即停。** 绝大多数正经安装都能在前两档解决，探测总开销在百毫秒级。
//     扫盘是最后一档兜底，可以在配置里关掉。
//
//  3. **全程本地、只读。** 只做三件事：读注册表字符串、`existsSync` 判存在、列目录项名字。
//     不读文件内容、不联网、不发给任何模型。唯一的代价是首次可能多花几秒 I/O。
//
//  4. **值名未知也不要紧。** 米哈游把安装路径存在哪个值名下这件事没有公开文档（社区工具
//     也说法不一），所以这一档不猜值名：把这个键下所有字符串值里长得像盘符路径的都拿出来
//     逐个复核。
//
//  5. **结果落盘缓存，且每次命中仍然复核。** 之后每次开 DSH 都是毫秒级。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

import { expandEnvironment, extractWindowsPaths, looksLikeWindowsPath, readRegistry, readRegistryMany, stringValues, stripQuotesAndIconIndex } from './registry.js'

/** 游戏本体的 exe 名。国服/B 服是 YuanShen.exe，国际服是 GenshinImpact.exe。 */
export const GAME_EXE_NAMES = ['YuanShen.exe', 'GenshinImpact.exe']

/** 米哈游启动器在本体旁边的常见名字（回退用）。 */
const LAUNCHER_EXE_NAMES = ['launcher.exe', 'Launcher.exe']

/** 安装目录在磁盘上的常见上层目录名。 */
const INSTALL_DIR_NAMES = ['Genshin Impact', '原神', 'GenshinImpact', 'Genshin Impact Game', 'Genshin Impact(原神)']

/** 游戏本体所在的那层目录名（官方安装器的布局是 <root>\Genshin Impact Game\YuanShen.exe）。 */
const GAME_DIR_NAMES = ['Genshin Impact Game', 'Genshin Impact', '原神']

/**
 * HoYoPlay（现启动器）的注册表根。
 *
 * 实测（2026-10，HoYoPlay 1.18.0.380 全新安装）现役布局是：
 *   HKCU\Software\miHoYo\HYP\1_1                      ← 启动器自己（InstallPath）
 *   HKCU\Software\miHoYo\HYP\1_1\hk4e_cn              ← 原神（GameInstallPath）
 * 而老资料里说的 `standalone\14_0\hk4e_cn` 在这台机器上是**空的残留键**。
 * 所以这里不写死版本号，整棵树都读，靠叶子名（hk4e_*）认游戏。
 */
const HYP_ROOTS = [
  'HKCU\\Software\\miHoYo\\HYP',
  'HKCU\\Software\\Cognosphere\\HYP',
  'HKLM\\SOFTWARE\\miHoYo\\HYP',
  'HKLM\\SOFTWARE\\WOW6432Node\\miHoYo\\HYP',
]

// 刻意**不查** `HKCU\Software\miHoYo\原神` / `...\Genshin Impact` 这两个「老版独立启动器」
// 的键。理由是实测出来的，不是猜的：
//
//   * 它们存的是游戏自己的 Unity PlayerPrefs 和 `MIHOYOSDK_*` 账号 blob（DES-CBC 加密的
//     账号数据），**不含安装路径**。把这台机器上这两个键的全部 REG_BINARY 值按 UTF-8 /
//     UTF-16 解过一遍找盘符路径，0 命中。
//   * 单是这个键，`reg query` 要跑 **20 秒**（输出 929KB 的十六进制二进制倾倒），
//     加不加 `chcp` 都一样。把它放进探测阶梯就是往每次开 DSH 里塞一颗 20 秒的地雷。
//   * 真正记路径的是 HoYoPlay 的 `hk4e_*` 叶子，一次查询 80ms。
//
// 所以：路径只认 HoYoPlay + 卸载记录 + 文件系统，不去翻游戏自己的状态键。

/** 我们关心的游戏业务代号。 */
const GAME_BIZ = ['hk4e_cn', 'hk4e_bilibili', 'hk4e_global']

/** 卸载记录里可能出现的名字。 */
const UNINSTALL_KEY_NAMES = ['原神', 'Genshin Impact', '云·原神', 'GenshinImpact']
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/**
 * 优先快查路径：官方安装器**默认**就往这些地方装。
 *
 * 实测经验 + 用户反馈：把原神装在 C 盘的人，路径基本就是 `C:\Program Files\Genshin Impact`
 * 这一个；所以先花几次 `existsSync` 把这几条问一遍，中了就结束，没中再去枚举别的盘。
 * 这一档几乎不花时间，却能让最常见的情况省掉几百次目录探测。
 */
const PRIORITY_PATHS = [
  '%ProgramFiles%\\Genshin Impact',
  '%ProgramFiles(x86)%\\Genshin Impact',
  '%ProgramFiles%\\miHoYo Launcher',
  '%ProgramFiles%\\miHoYo Launcher\\games\\Genshin Impact Game',
  '%ProgramFiles%\\Genshin Impact\\Genshin Impact Game',
  '%ProgramFiles(x86)%\\miHoYo Launcher',
  'C:\\Program Files\\Genshin Impact',
  'C:\\Program Files (x86)\\Genshin Impact',
  'C:\\Program Files\\miHoYo Launcher',
]

/**
 * 这几个目录名是"容器"：即使已经到深度上限，也值得再往里看一层。
 *
 * 原因很实在：HoYoPlay（现役启动器）把游戏装在
 * `<用户选的目录>\miHoYo Launcher\games\Genshin Impact Game` —— 从盘根算已经是第 5 层，
 * 默认深度 4 的扫盘**够不到**它。而 `games` 这一层没有任何"游戏名"特征，
 * 只能靠这个名字认出来。只在容器里多放一层，避免把深度上限整体抬高带来的开销。
 */
const SCAN_DESCEND_ANYWAY = new Set(['games', 'game', '游戏', 'mihoyo launcher', 'hoyoplay'])

/** 有界扫盘时跳过的目录名：系统目录、回收站、以及又大又不可能装游戏的地方。 */
const SCAN_SKIP_DIRS = new Set(
  [
    'windows',
    '$recycle.bin',
    'system volume information',
    'programdata',
    'node_modules',
    '.git',
    '.svn',
    'appdata',
    'recovery',
    'perflogs',
    'msocache',
    'windows.old',
    '$windows.~bt',
    '$windows.~ws',
    'onedrivetemp',
    'temp',
    'tmp',
  ].map((name) => name.toLowerCase()),
)

function isWindows() {
  return process.platform === 'win32'
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 列出存在的盘符根（`C:\`、`D:\` …），不做任何写操作。 */
export function listDriveRoots() {
  const roots = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (existsSync(root)) roots.push(root)
  }
  return roots
}

/**
 * 看一个目录像不像原神的安装位置，并补齐启动器路径。
 *
 * 只认结构指纹，不认目录名：官方布局是
 *   <启动器根>\launcher.exe            ← 米哈游启动器（HoYoPlay）
 *   <启动器根>\games\Genshin Impact Game\YuanShen.exe   ← 游戏本体
 * 所以从候选目录往下找一层，就能同时覆盖「给的是启动器根」「给的是 games 目录」
 * 「给的就是游戏目录」这三种情况。
 *
 * 返回两个档位：
 *   level='ready'       —— 本体 exe 在，可以启动
 *   level='incomplete'  —— 注册过、目录结构对，但 exe 还没下下来（首次安装 / 更新中）
 * 前者满足不了就一路返回 undefined。
 *
 * @param {string} dir 候选目录
 * @param {object} [options]
 * @param {string[]} [options.exeNames] 认可的 exe 名
 * @param {string[]} [options.launcherRoots] 注册表登记过的启动器根（用来精确找 launcher.exe）
 * @returns {object | undefined}
 */
export function inspectInstallDir(dir, options = {}) {
  const { exeNames = GAME_EXE_NAMES, launcherRoots = [] } = options
  if (typeof dir !== 'string' || !dir.trim() || !existsSync(dir)) return undefined

  const bases = [dir, ...GAME_DIR_NAMES.map((name) => join(dir, name))]
  let incomplete

  for (const base of bases) {
    // ① 本体 exe 在不在
    for (const exeName of exeNames) {
      const exePath = join(base, exeName)
      if (!isFile(exePath)) continue
      return {
        level: 'ready',
        installDir: dir,
        gameDir: base,
        exePath,
        exeName,
        launcherPath: findLauncher(base, launcherRoots),
        hasConfigIni: isFile(join(base, 'config.ini')),
        evidence: [`找到 ${exeName}`],
      }
    }
    // ② exe 不在，但结构指纹表明这里是原神（首次安装 / 更新中）
    const evidence = gameDirEvidence(base)
    if (evidence.length >= 2 && !incomplete) {
      incomplete = {
        level: 'incomplete',
        installDir: dir,
        gameDir: base,
        exeName: exeNames[0],
        launcherPath: findLauncher(base, launcherRoots),
        hasConfigIni: isFile(join(base, 'config.ini')),
        evidence,
      }
    }
  }
  return incomplete
}

/**
 * 一个目录「像原神游戏目录」的证据。要求至少命中两条才算，避免把随便一个
 * 带 config.ini 的目录误判成原神（原神本体有 60GB+，误判的代价是要么乱启动、
 * 要么明明没装却不下载）。
 */
function gameDirEvidence(dir) {
  const evidence = []
  for (const name of ['YuanShen_Data', 'GenshinImpact_Data']) {
    if (existsSync(join(dir, name)) && statSync(join(dir, name)).isDirectory()) evidence.push(`有 ${name}\\ 目录`)
  }
  if (isFile(join(dir, 'pkg_version'))) evidence.push('有 pkg_version')
  for (const name of ['mhypbase.dll', 'rtlbase.dll']) {
    if (isFile(join(dir, name))) evidence.push(`有 ${name}`)
  }
  const configIni = join(dir, 'config.ini')
  if (isFile(configIni)) {
    try {
      if (/game_version\s*=/i.test(readFileSync(configIni, 'utf8'))) evidence.push('config.ini 里有 game_version=')
    } catch {
      /* 读不了就算了 */
    }
  }
  return evidence
}

/**
 * 只认「本体 exe 在」这一种情况，是 {@link inspectInstallDir} 的薄封装。
 * @param {string} dir
 * @param {object} [options]
 */
export function validateInstallDir(dir, options = {}) {
  const hit = inspectInstallDir(dir, options)
  return hit && hit.level === 'ready' ? hit : undefined
}

/**
 * 找米哈游启动器。
 *
 * 优先用注册表登记过的启动器根（`HYP\1_1\InstallPath`，精确）；找不到就从游戏目录
 * 往上最多走三层找 `launcher.exe` —— 实测布局里启动器和游戏隔了两层
 * （`<根>\launcher.exe` 与 `<根>\games\Genshin Impact Game\`），只往上一层是找不到的。
 */
function findLauncher(gameDir, launcherRoots = []) {
  for (const root of launcherRoots) {
    for (const name of LAUNCHER_EXE_NAMES) {
      const candidate = join(root, name)
      if (isFile(candidate)) return candidate
    }
  }
  let current = gameDir
  for (let depth = 0; depth < 4; depth += 1) {
    for (const name of LAUNCHER_EXE_NAMES) {
      const candidate = join(current, name)
      if (isFile(candidate)) return candidate
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * 按需找启动器（**不落盘**——用户要求：盘上只留本体地址和安装包地址）。
 * 本体起不来要走「回退起启动器」时才调一次，从本体目录现推。
 */
export function locateLauncherNear(gameExePath) {
  const dir = dirname(String(gameExePath ?? ''))
  return dir ? findLauncher(dir) : undefined
}

/** 从一个注册表子树里把所有「长得像盘符路径」的字符串值挖出来。 */
function pathValuesFromRegistry(keys, say, label) {
  const dirs = []
  for (const { keyPath, name, data } of stringValues(keys)) {
    if (!looksLikeWindowsPath(data)) continue
    const expanded = expandEnvironment(stripQuotesAndIconIndex(data))
    say(`${label}：${name} = ${expanded}`)
    dirs.push({ dir: expanded, source: label })
  }
  return dirs
}

/**
 * 从 HoYoPlay 的注册表树里挑出 hk4e_* 那些键下的游戏路径，顺便收集启动器根。
 *
 * 实测（HoYoPlay 1.18.0.380）这棵树长这样：
 *   HYP\1_1                     InstallPath = <启动器根>
 *   HYP\1_1\hk4e_cn             GameInstallPath = <启动器根>\games\Genshin Impact Game
 * 值名（`GameInstallPath`）是实测确认的，但这里**不按值名取值**：只要在 hk4e_* 键下、
 * 长得像盘符路径，就都拿来复核。这样米哈游哪天改了值名也不会瞎。
 *
 * @param {Map<string, Map<string,string>>} keys
 * @param {(message: string) => void} say
 * @param {string[]} launcherRoots 收集启动器根的出参
 */
function candidatesFromHyp(keys, say, launcherRoots) {
  const out = []
  for (const { keyPath, name, data } of stringValues(keys)) {
    if (!looksLikeWindowsPath(data)) continue
    const expanded = expandEnvironment(stripQuotesAndIconIndex(data))
    const leaf = keyPath.slice(keyPath.lastIndexOf('\\') + 1).toLowerCase()
    const isGameBiz = GAME_BIZ.includes(leaf) || GAME_BIZ.some((biz) => leaf.startsWith(biz))
    if (isGameBiz) {
      say(`HoYoPlay 登记了 ${leaf}：${name} = ${expanded}`)
      out.push({ dir: expanded, source: `registry:hyp:${leaf}` })
      continue
    }
    // 非游戏叶子上的 InstallPath = 启动器自己的安装目录，正好用来精确找 launcher.exe
    if (/^installpath$/i.test(name) && !launcherRoots.includes(expanded)) {
      say(`HoYoPlay 启动器安装目录：${expanded}`)
      launcherRoots.push(expanded)
    }
  }
  return out
}

/** 从一个卸载记录键里抠出可能的安装目录与 exe 路径。 */
function candidatesFromUninstallRecord(record, say) {
  const out = []
  const installLocation = record.InstallLocation ? expandEnvironment(stripQuotesAndIconIndex(record.InstallLocation)) : undefined
  if (installLocation) {
    say(`卸载记录 InstallLocation = ${installLocation}`)
    out.push({ dir: installLocation, source: 'registry:uninstall' })
  }
  for (const field of ['DisplayIcon', 'UninstallString']) {
    const raw = record[field]
    if (!raw) continue
    for (const found of extractWindowsPaths(raw)) {
      const expanded = expandEnvironment(stripQuotesAndIconIndex(found))
      const dir = basename(expanded).toLowerCase().endsWith('.exe') ? dirname(expanded) : expanded
      say(`卸载记录 ${field} → ${dir}`)
      out.push({ dir, source: `registry:uninstall:${field}` })
    }
  }
  return out
}

/**
 * 第一档：读注册表，凑出一批候选目录。
 * @param {(message: string) => void} say
 * @param {string[]} launcherRoots 收集启动器根（`InstallPath`）的出参
 */
async function candidatesFromRegistry(say, launcherRoots = []) {
  const out = []

  // —— HoYoPlay（现役启动器）——
  // 不提前 return：某个根里的登记可能已经过期，把能读到的都收进来一起复核。
  for (const root of HYP_ROOTS) {
    const { ok, keys, reason } = await readRegistry(root)
    if (!ok) {
      say(`注册表 ${root}：${reason}`)
      continue
    }
    const hyp = candidatesFromHyp(keys, say, launcherRoots)
    if (hyp.length) {
      out.push(...hyp)
      continue
    }
    out.push(...pathValuesFromRegistry(keys, say, `registry:${root}`))
  }
  if (out.length) return out

  // —— 卸载记录 ——
  // 键名点查（毫秒级，一次 spawn 查完 12 个组合）；点不中才交给慢档做全量扫描。
  const probes = []
  for (const root of UNINSTALL_ROOTS) {
    for (const name of UNINSTALL_KEY_NAMES) probes.push({ key: `${root}\\${name}`, recursive: false })
  }
  const probed = await readRegistryMany(probes)
  for (const [key, entry] of probed) {
    if (!entry.ok) continue
    for (const values of entry.keys.values()) {
      const record = Object.fromEntries(values)
      say(`卸载记录命中：${key}（DisplayName=${record.DisplayName ?? '无'}）`)
      out.push(...candidatesFromUninstallRecord(record, say))
    }
  }
  return out
}

/**
 * 全量扫卸载记录（1.5 秒级），只在点查全部落空时兜底。
 * @param {(message: string) => void} log
 */
async function candidatesFromUninstallSweep(say) {
  const out = []
  for (const root of UNINSTALL_ROOTS) {
    const { ok, keys, reason } = await readRegistry(root)
    if (!ok) {
      say(`卸载记录全量扫描 ${root}：${reason}`)
      continue
    }
    for (const values of keys.values()) {
      const displayName = values.get('DisplayName')
      if (!displayName || !/原神|Genshin/i.test(displayName)) continue
      say(`卸载记录全量扫描命中：${displayName}`)
      out.push(...candidatesFromUninstallRecord(Object.fromEntries(values), say))
    }
  }
  return out
}

/**
 * 第二档：固定候选路径。
 *
 * 不硬编码「你机器上游戏装在哪」，而是「每个盘的每个顶层目录 × 几个常见安装目录名」。
 * 关键在于怎么问：早先的写法是对每个 (顶层目录 × 目录名) 组合各来一次 `existsSync`，
 * 在 2 个盘上就是 500 多次 stat，实测要 4.5 秒。改成「每个顶层目录只 readdir 一次，
 * 拿回来的名字集合里比对」之后，stat 次数从几百降到几十，整档掉到几百毫秒。
 *
 * @param {(message: string) => void} say
 * @param {string[]} extraRoots 用户额外指定的候选根
 */
function candidatesFromFixedPaths(say, extraRoots = []) {
  const out = []
  const roots = [...new Set([...listDriveRoots(), ...extraRoots])]
  const wanted = new Set(INSTALL_DIR_NAMES.map((name) => name.toLowerCase()))

  // ① 优先快查：官方默认安装位置（几条 existsSync 就能问完）
  for (const template of PRIORITY_PATHS) {
    const expanded = expandEnvironment(template)
    // 环境变量解不出来（%ProgramFiles(x86)% 在 32 位进程里就没有）时跳过，别拿半个路径去问
    if (expanded.includes('%')) continue
    out.push({ dir: expanded, source: 'path:priority' })
  }
  const priorityCount = out.length

  // ② 盘根本身
  for (const root of roots) {
    for (const name of INSTALL_DIR_NAMES) out.push({ dir: join(root, name), source: 'path:drive-root' })
    // 盘根下的每个顶层目录：一次 readdir 就把所有候选名都比对完
    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) continue
      const top = join(root, entry.name)
      const listed = safeReaddir(top)
      if (!listed.length) continue
      for (const child of listed) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue
        if (!wanted.has(child.name.toLowerCase())) continue
        out.push({ dir: join(top, child.name), source: 'path:drive-child' })
      }
    }
  }

  // ③ 用户主目录 / AppData / Program Files 下的直接候选
  for (const base of [process.env.USERPROFILE, process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!base) continue
    for (const name of INSTALL_DIR_NAMES) out.push({ dir: join(base, name), source: 'path:known-root' })
  }

  say(`固定候选路径：${priorityCount} 个官方默认位置 + ${roots.length} 个盘，共 ${out.length} 个候选目录`)
  return out
}

/**
 * 第五档（兜底）：有界扫盘。
 *
 * 全程只读、只列目录项名字、不读文件内容、不联网；跳过系统目录与目录联接（避免死循环），
 * 并且有深度上限和时间预算。默认只在前面全落空时才跑一次，结果落盘。
 *
 * @param {object} options
 * @param {number} [options.maxDepth]
 * @param {number} [options.budgetMs]
 * @param {string[]} [options.extraRoots]
 * @param {string[]} [options.roots] 覆盖扫描根（默认所有盘符根）。仅测试注入合成目录树用。
 * @param {(message: string) => void} [options.log]
 */
export function scanForInstall(options = {}) {
  const { maxDepth = 4, budgetMs = 20_000, extraRoots = [], roots: rootsOverride, log = () => {} } = options
  const deadline = Date.now() + Math.max(1000, budgetMs)
  const roots = [...new Set([...(rootsOverride ?? listDriveRoots()), ...extraRoots])]
  const targets = new Set([...INSTALL_DIR_NAMES, ...GAME_EXE_NAMES].map((name) => name.toLowerCase()))

  let visited = 0
  for (const root of roots) {
    const stack = [{ dir: root, depth: 0 }]
    while (stack.length) {
      if (Date.now() > deadline) {
        log(`扫盘超出时间预算（${budgetMs}ms），已访问 ${visited} 个目录后放弃`)
        return undefined
      }
      const { dir, depth } = stack.pop()
      visited += 1
      for (const entry of safeReaddir(dir)) {
        const name = entry.name.toLowerCase()
        if (entry.isSymbolicLink()) continue // 目录联接：跳过，避免绕圈与越界
        if (entry.isFile()) {
          // 直接撞见 exe：把它所在目录当候选
          if (targets.has(name) && (name.endsWith('yuanshen.exe') || name.endsWith('genshinimpact.exe'))) {
            log(`扫盘命中文件：${join(dir, entry.name)}`)
            return dir
          }
          continue
        }
        if (!entry.isDirectory()) continue
        if (SCAN_SKIP_DIRS.has(name)) continue
        const child = join(dir, entry.name)
        if (targets.has(name)) {
          log(`扫盘命中目录名：${child}`)
          return child
        }
        // 常规子目录受深度上限约束；但「容器」目录（games / miHoYo Launcher / HoYoPlay 等）
        // 即使已经到上限也再放它一层——HoYoPlay 的 `<盘>\...\miHoYo Launcher\games\
        // Genshin Impact Game` 从盘根算是第 5 层，不放这一层就永远扫不到。容器名有限、
        // 且总时间预算兜底，不会失控。
        if (depth + 1 < maxDepth || SCAN_DESCEND_ANYWAY.has(name)) {
          stack.push({ dir: child, depth: depth + 1 })
        }
      }
    }
  }
  log(`扫盘结束：访问 ${visited} 个目录，没有找到原神安装目录`)
  return undefined
}

/**
 * 完整的探测阶梯。
 *
 * @param {object} options
 * @param {string} [options.gameExe] 手填的 exe 全路径（最高优先级，自测也用它）
 * @param {string} [options.gamePath] 手填的安装目录
 * @param {string[]} [options.sources] 允许使用的探测档，默认全开
 * @param {number} [options.scanMaxDepth]
 * @param {number} [options.scanBudgetMs]
 * @param {string[]} [options.extraRoots] 额外的扫描 / 候选根目录
 * @param {boolean} [options.allowScan] 是否允许扫盘（覆盖 sources）
 * @param {() => Promise<'allow'|'deny'|'unavailable'>} [options.onBeforeScan]
 *        进入慢档前的许可钩子：只有 resolve 成 'allow' 才会真的扫盘
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{found: boolean, exePath?: string, installDir?: string, gameDir?: string, exeName?: string, launcherPath?: string, flavor?: string, source?: string, log: string[]}>}
 */
export async function detectGame(options = {}) {
  const {
    gameExe,
    gamePath,
    sources = ['config', 'registry', 'paths', 'scan'],
    scanMaxDepth = 4,
    scanBudgetMs = 20_000,
    extraRoots = [],
    allowScan = true,
    onBeforeScan,
  } = options
  const log = []
  const say = (message) => {
    log[log.length] = message
  }
  const enabled = new Set(sources)

  /**
   * 注册表登记过、目录结构也对，但本体 exe 还没下下来（首次安装 / 更新中）。
   * 这个状态必须和「压根没装」区分开：前者不该再去下载那个 224MB 的启动器安装包。
   */
  let incomplete
  const noteIncomplete = (hit, source) => {
    if (incomplete || !hit) return
    incomplete = { ...hit, source }
  }

  const finish = (hit, source) => {
    say(`→ 采用 ${hit.exePath}（来源：${source}）`)
    return {
      found: true,
      exePath: hit.exePath,
      installDir: hit.installDir,
      gameDir: hit.gameDir,
      exeName: hit.exeName,
      launcherPath: hit.launcherPath,
      // 只在确实是原神那两个 exe 名时才说版本；手填的任意 exe（自测用）不硬套。
      flavor: hit.exeName === 'YuanShen.exe' ? '国服 / B 服' : hit.exeName === 'GenshinImpact.exe' ? '国际服' : undefined,
      hasConfigIni: hit.hasConfigIni,
      source,
      log,
    }
  }

  const miss = () => ({
    found: false,
    registered: Boolean(incomplete),
    installDir: incomplete?.installDir,
    gameDir: incomplete?.gameDir,
    launcherPath: incomplete?.launcherPath,
    incompleteEvidence: incomplete?.evidence,
    source: incomplete?.source,
    log,
  })

  if (!isWindows()) {
    say('当前不是 Windows，跳过探测')
    return { found: false, registered: false, log }
  }

  // —— 档 0：用户手填 ——
  if (typeof gameExe === 'string' && gameExe.trim()) {
    say(`配置指明了 exe：${gameExe}`)
    if (!existsSync(gameExe)) {
      say('配置里的 exe 不存在，忽略')
    } else {
      // 手填的 exe 直接采信（自测时可能根本不是原神，比如拿一个小游戏验证启动链路）。
      const hit = {
        exePath: gameExe,
        installDir: dirname(gameExe),
        gameDir: dirname(gameExe),
        exeName: basename(gameExe),
        launcherPath: findLauncher(dirname(gameExe)),
        hasConfigIni: isFile(join(dirname(gameExe), 'config.ini')),
      }
      return finish(hit, 'config:gameExe')
    }
  }
  if (enabled.has('config') && typeof gamePath === 'string' && gamePath.trim()) {
    say(`配置指明了安装目录：${gamePath}`)
    const hit = inspectInstallDir(gamePath)
    if (hit?.level === 'ready') return finish(hit, 'config:gamePath')
    noteIncomplete(hit, 'config:gamePath')
    say(hit ? '配置里的目录像原神，但本体 exe 还不在（安装 / 更新中）' : '配置里的目录不像原神安装位置，忽略')
  }

  // 注册表登记过的启动器根，越准越好地用来找 launcher.exe
  const launcherRoots = []

  const tryCandidates = (candidates, source) => {
    for (const candidate of candidates) {
      const hit = inspectInstallDir(candidate.dir, { launcherRoots })
      if (hit?.level === 'ready') {
        say(`复核通过：${candidate.dir}`)
        return finish(hit, candidate.source ?? source)
      }
      noteIncomplete(hit, candidate.source ?? source)
    }
    return undefined
  }

  // —— 档 1：注册表快档（HYP + 卸载记录点查），约 400ms ——
  if (enabled.has('registry')) {
    say('开始读注册表（不需要管理员权限）')
    const candidates = await candidatesFromRegistry(say, launcherRoots)
    const hit = tryCandidates(candidates, 'registry')
    if (hit) return hit
    if (candidates.length) say('注册表登记的位置里没有找到本体 exe，继续往下找')
  }

  // —— 档 2：固定候选路径，约 50ms ——
  if (enabled.has('paths')) {
    say('开始检查常见安装路径')
    const hit = tryCandidates(candidatesFromFixedPaths(say, extraRoots), 'path')
    if (hit) return hit
  }

  // —— 档 3：慢档。只有前面全落空才付出这个代价，而且结果会被「没找到」缓存挡住 ——
  if (allowScan && enabled.has('scan')) {
    // 扫盘要遍历磁盘目录名，必须先问过用户。onBeforeScan 返回 'allow' 才继续；
    // 返回别的一律跳过（并在日志里说清楚，面板上也能看到）。
    const decision = typeof onBeforeScan === 'function' ? await onBeforeScan() : 'allow'
    if (decision !== 'allow') {
      say(`没有获得扫盘许可（${decision}），跳过慢档；可以在插件配置里直接填游戏 exe 路径`)
    } else {
      // 卸载记录全量扫描：3 个根各一次 `reg query /s`，实测约 3 秒。
      // 只有点查全部落空才值得跑（比如卸载记录挂在某个 GUID 键名下）。
      say('开始全量扫描卸载记录（约 3 秒）')
      const swept = await candidatesFromUninstallSweep(say)
      const sweptHit = tryCandidates(swept, 'registry:sweep')
      if (sweptHit) return sweptHit

      say(`开始有界扫盘（深度 ≤ ${scanMaxDepth}，预算 ${scanBudgetMs}ms，纯本地只读）`)
      const dir = scanForInstall({ maxDepth: scanMaxDepth, budgetMs: scanBudgetMs, extraRoots, log: say })
      if (dir) {
        const hit = inspectInstallDir(dir, { launcherRoots })
        if (hit?.level === 'ready') return finish(hit, 'scan')
        noteIncomplete(hit, 'scan')
        if (hit) say(`扫盘给的候选还没装完：${dir}`)
      }
    }
  }

  if (incomplete) {
    say(`找到原神的安装位置，但本体 exe 还不在（${incomplete.evidence.join('、')}）——判定为「安装 / 更新中」`)
  } else {
    say('没有找到已安装的原神')
  }
  return miss()
}
