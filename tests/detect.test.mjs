// 探测与启动的纯逻辑自测（零依赖，Node >= 20）
//   node tests/detect.test.mjs
//
// 只测不依赖真机状态的部分：注册表解析、路径校验、指纹识别、环境变量脱敏。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectInstallDir, listDriveRoots, scanForInstall, validateInstallDir } from '../lib/detect.js'
import { isElevationDenied, scrubbedEnv } from '../lib/launch.js'
import {
  expandEnvironment,
  extractWindowsPaths,
  looksLikeWindowsPath,
  parseRegistryDump,
  stripQuotesAndIconIndex,
} from '../lib/registry.js'

// ---------------------------------------------------------------- 注册表解析
const dump = [
  '',
  'HKEY_CURRENT_USER\\Software\\miHoYo\\HYP\\standalone\\14_0\\hk4e_cn',
  '    (默认)    REG_SZ    D:\\youxi\\Genshin Impact',
  '    game_install_path    REG_SZ    D:\\youxi\\Genshin Impact',
  '    带 空格 的值名    REG_EXPAND_SZ    %SystemDrive%\\Genshin',
  '    SomeBlob    REG_BINARY    DEADBEEF',
  '',
  'HKEY_CURRENT_USER\\Software\\miHoYo\\HYP\\standalone\\14_0\\hk4e_global',
  '    game_install_path    REG_SZ    C:\\Program Files\\Genshin Impact',
  '',
].join('\r\n')

const parsed = parseRegistryDump(dump)
assert.equal(parsed.size, 2, '应该解析出两个键')
const cn = parsed.get('HKEY_CURRENT_USER\\Software\\miHoYo\\HYP\\standalone\\14_0\\hk4e_cn')
assert.equal(cn.get('(Default)'), 'D:\\youxi\\Genshin Impact', '默认值要归一到 (Default)')
assert.equal(cn.get('game_install_path'), 'D:\\youxi\\Genshin Impact')
assert.equal(cn.get('带 空格 的值名'), '%SystemDrive%\\Genshin', '含空格的值名也要能解析')
assert.equal(cn.has('SomeBlob'), false, 'REG_BINARY 不该被收进来（米哈游塞了一堆加密 blob）')

// ---------------------------------------------------------------- 路径工具
assert.equal(looksLikeWindowsPath('D:\\youxi\\原神'), true)
assert.equal(looksLikeWindowsPath('"D:\\youxi\\原神"'), true, '带引号也要认')
assert.equal(looksLikeWindowsPath('relative\\path'), false)
assert.equal(looksLikeWindowsPath(''), false)

assert.equal(stripQuotesAndIconIndex('"D:\\a\\b.exe",0'), 'D:\\a\\b.exe')
assert.equal(stripQuotesAndIconIndex('  D:\\a\\b.exe  '), 'D:\\a\\b.exe')

// %VAR% 展开：能解出来的解，解不出来的原样留着（交给后续文件校验否决）。
assert.equal(expandEnvironment('%SystemDrive%\\Genshin'), `${process.env.SystemDrive ?? '%SystemDrive%'}\\Genshin`)
assert.equal(expandEnvironment('没有变量的字符串'), '没有变量的字符串')
assert.equal(expandEnvironment('%不存在的变量%\\x'), '%不存在的变量%\\x')

assert.deepEqual(extractWindowsPaths('"D:\\a\\uninst.exe" /S'), ['D:\\a\\uninst.exe'])
assert.deepEqual(extractWindowsPaths('D:\\Program Files\\原神\\uninst.exe,0'), ['D:\\Program Files\\原神\\uninst.exe,0'])

// ---------------------------------------------------------------- 安装目录指纹
const root = mkdtempSync(join(tmpdir(), 'dsh-genshin-test-'))
try {
  // 官方布局：<root>\launcher.exe + <root>\Genshin Impact Game\YuanShen.exe
  const official = join(root, 'official')
  const gameDir = join(official, 'Genshin Impact Game')
  mkdirSync(gameDir, { recursive: true })
  writeFileSync(join(official, 'launcher.exe'), 'x')
  writeFileSync(join(gameDir, 'YuanShen.exe'), 'x')
  writeFileSync(join(gameDir, 'config.ini'), 'game_version=5.0.0')

  const hit = validateInstallDir(official)
  assert.ok(hit, '应该认出官方布局')
  assert.equal(hit.exePath, join(gameDir, 'YuanShen.exe'))
  assert.equal(hit.gameDir, gameDir)
  assert.equal(hit.launcherPath, join(official, 'launcher.exe'), '应该找到上一层的米哈游启动器')
  assert.equal(hit.hasConfigIni, true)

  // 直接指向游戏目录也要认（等价于用户手填 <root>\Genshin Impact Game）
  const direct = validateInstallDir(gameDir)
  assert.ok(direct, '直接给游戏目录也要认')
  assert.equal(direct.exePath, join(gameDir, 'YuanShen.exe'))

  // 国际服 exe
  const global = join(root, 'global')
  const globalGame = join(global, 'Genshin Impact Game')
  mkdirSync(globalGame, { recursive: true })
  writeFileSync(join(globalGame, 'GenshinImpact.exe'), 'x')
  assert.equal(validateInstallDir(global)?.exeName, 'GenshinImpact.exe')

  // 只有启动器、没有游戏本体：必须认不出来（这正是需求里说的「本体不是启动器」）
  const launcherOnly = join(root, 'launcher-only')
  mkdirSync(launcherOnly, { recursive: true })
  writeFileSync(join(launcherOnly, 'launcher.exe'), 'x')
  assert.equal(validateInstallDir(launcherOnly), undefined, '只有启动器不能算装了原神')

  // 「登记了但本体还没下完」：必须能和「压根没装」区分开，否则插件会白下一个 224MB 安装包。
  // 指纹照抄真实安装中的目录：YuanShen_Data\ + config.ini(game_version=) + pkg_version + mhypbase.dll
  const installing = join(root, 'installing')
  const installingGame = join(installing, 'miHoYo Launcher', 'games', 'Genshin Impact Game')
  mkdirSync(join(installingGame, 'YuanShen_Data'), { recursive: true })
  writeFileSync(join(installingGame, 'config.ini'), 'channel=1\nsub_channel=0\ngame_version=5.0.0\n')
  writeFileSync(join(installingGame, 'pkg_version'), 'x')
  writeFileSync(join(installingGame, 'mhypbase.dll'), 'x')
  writeFileSync(join(installing, 'miHoYo Launcher', 'launcher.exe'), 'x')

  const inspecting = validateInstallDir(installing)
  assert.equal(inspecting, undefined, '本体 exe 不在时 validateInstallDir 不该说「装好了」')
  const partial = inspectInstallDir(installingGame)
  assert.ok(partial, '应该认出「安装中」这个状态')
  assert.equal(partial.level, 'incomplete')
  assert.ok(partial.evidence.length >= 2, `证据应该至少两条，实际：${partial.evidence?.join('、')}`)
  assert.equal(
    partial.launcherPath,
    join(installing, 'miHoYo Launcher', 'launcher.exe'),
    '安装中的情况也要能往上找到米哈游启动器（隔了两层）',
  )

  // 光有一个 config.ini 的普通目录不能被当成原神（原神本体 60GB+，误判代价很高）
  const decoy = join(root, 'decoy')
  mkdirSync(decoy, { recursive: true })
  writeFileSync(join(decoy, 'config.ini'), 'setting=1')
  assert.equal(inspectInstallDir(decoy), undefined, '只有 config.ini 不算数')

  // 空目录、不存在的目录
  const empty = join(root, 'empty')
  mkdirSync(empty)
  assert.equal(validateInstallDir(empty), undefined)
  assert.equal(validateInstallDir(join(root, '不存在')), undefined)
  assert.equal(validateInstallDir(''), undefined)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 环境变量脱敏
// 继承来的敏感变量必须被抹掉；显式交进来的额外变量则是有意为之的口子（与 DSH 一致）。
const saved = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  MY_LEAK_TOKEN: process.env.MY_LEAK_TOKEN,
  DSH_HOME: process.env.DSH_HOME,
}
process.env.DEEPSEEK_API_KEY = 'sk-leak'
process.env.MY_LEAK_TOKEN = 't'
process.env.DSH_HOME = 'C:\\Users\\x\\.dsh'
try {
  const env = scrubbedEnv()
  // Windows 上环境变量名大小写不敏感，Node 保留原始拼写（常见是 `Path`）。
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH')
  assert.ok(pathKey, 'PATH 应该存在')
  assert.equal(env[pathKey], process.env[pathKey], 'PATH 必须保留，否则游戏找不到依赖')
  assert.equal(env.DEEPSEEK_API_KEY, undefined, 'API key 不能交给游戏进程')
  assert.equal(env.MY_LEAK_TOKEN, undefined, 'TOKEN 不能交给游戏进程')
  assert.equal(env.DSH_HOME, undefined, 'DSH_* 不能交给游戏进程')
  assert.equal(scrubbedEnv({ MY_FLAG: 'v' }).MY_FLAG, 'v', '显式传入的额外变量要能进去')
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// ---------------------------------------------------------------- 提权类失败的识别
// 原神本体 / 启动器清单都是 requireAdministrator：spawn（CreateProcess）不会弹 UAC，
// 直接失败，Node 报 EACCES。这条识别决定要不要自动回退 shell（弹 UAC，用户同意才提权）。
assert.ok(isElevationDenied({ status: 'spawn-error', detail: 'EACCES：spawn C:\\...\\YuanShen.exe EACCES' }), 'EACCES 应识别为提权类失败')
assert.ok(isElevationDenied({ status: 'spawn-error', detail: '740：需要提升权限' }), '错误码 740（ERROR_ELEVATION_REQUIRED）应识别')
assert.ok(isElevationDenied({ status: 'spawn-error', detail: 'The requested operation requires elevation.' }), '英文 elevation 报错应识别')
assert.equal(isElevationDenied({ status: 'spawn-error', detail: 'ENOENT：spawn C:\\不存在.exe ENOENT' }), false, '找不到文件（ENOENT）不是提权问题，不该误触发 shell 回退')
assert.equal(isElevationDenied({ ok: true, status: 'running' }), false, '成功的不用判')
assert.equal(isElevationDenied({ status: 'early-exit', detail: 'EACCES' }), false, '秒退不算提权问题（它是版本低 / 已在运行）')

// ---------------------------------------------------------------- 盘符枚举
const drives = listDriveRoots()
assert.ok(Array.isArray(drives))
assert.ok(drives.every((root2) => /^[A-Z]:\\$/.test(root2)))
assert.ok(drives.includes('C:\\'), 'C: 总该在')

// ---------------------------------------------------------------- 扫盘「容器多放一层」
// HoYoPlay 把游戏装在 <盘>\...\miHoYo Launcher\games\Genshin Impact Game。当 games 恰好
// 落在深度上限那一层时，常规规则（depth+1 < maxDepth）会挡住它，扫不到游戏。SCAN_DESCEND_ANYWAY
// 让 games / miHoYo Launcher / hoyoplay 这类容器即使到上限也再放一层。
{
  const scanRoot = mkdtempSync(join(tmpdir(), 'dsh-scan-'))
  try {
    const mk = (...segs) => {
      const dir = join(scanRoot, ...segs)
      mkdirSync(dir, { recursive: true })
      return dir
    }
    // 容器路径：games 在深度上限那一层，其下才是游戏目录
    mk('a', 'b', 'c', 'games', 'Genshin Impact Game')
    // 非容器路径：同样深度，但中间目录不是容器 → 应该被深度上限挡住、扫不到
    mk('a', 'b', 'c', 'not-a-container', '原神')
    const logs = []
    const hit = scanForInstall({ roots: [scanRoot], maxDepth: 4, budgetMs: 5000, log: (m) => logs.push(m) })
    assert.ok(hit, '容器路径应该扫到（games 到上限也再放一层）')
    assert.ok(/games/i.test(hit) && /Genshin Impact Game/i.test(hit), `命中的应是 games\\Genshin Impact Game，实际 ${hit}`)
    // 单独验证非容器那条被挡住了：把容器那条删掉后应扫不到
    rmSync(join(scanRoot, 'a', 'b', 'c', 'games'), { recursive: true, force: true })
    const hit2 = scanForInstall({ roots: [scanRoot], maxDepth: 4, budgetMs: 5000, log: () => {} })
    assert.equal(hit2, undefined, '非容器目录到深度上限就该停，不能无限往下钻（规则要有界）')
  } finally {
    rmSync(scanRoot, { recursive: true, force: true })
  }
}

console.log('探测/启动纯逻辑自测通过：注册表解析、指纹校验、环境变量脱敏、扫盘容器多放一层都对。')
