#!/usr/bin/env node
// 自检：把「零配置探测 + 启动」的整条链路在本机跑一遍并打印全过程。
//
// 用法（在插件目录下）：
//   node tools/selfcheck.mjs
//       只探测，打印每一档查了什么、为什么没命中。
//
//   node tools/selfcheck.mjs --exe "D:\youxi\Genshin Impact\Genshin Impact Game\YuanShen.exe"
//       指定 exe 再探测（最高优先级那一档）。
//
//   node tools/selfcheck.mjs --exe "C:\Windows\System32\notepad.exe" --launch
//       连启动一起验证 —— 拿一个随便什么程序当靶子，确认「启动」这一环是通的。
//
//   node tools/selfcheck.mjs --no-scan
//       跳过最贵的扫盘那一档（默认会跑，最多几十秒）。
//
//   node tools/selfcheck.mjs --window
//       只验证「独立窗口 + 置顶」这一环：起一个临时页面、用 Edge/Chrome 的 --app=
//       开一个独立窗口、跑一次 Win32 置顶，然后把这个窗口收掉。不碰游戏。
//
//   node tools/selfcheck.mjs --no-mask
//       打印完整路径（默认掩码成「盘符:\…\末段」，好让输出能直接贴进工单/日志）。
//
// 退出码：找到并（如有 --launch）启动成功 = 0；否则 1。
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { detectGame, GAME_EXE_NAMES } from '../lib/detect.js'
import { maskPath } from '../lib/privacy.js'
import { isProcessRunning, launchExecutable } from '../lib/launch.js'
import { closeStandaloneWindow, findChromiumBrowser, isElectron, openStandaloneWindow, windowTag, windowTitle } from '../lib/window.js'

function parseArgs(argv) {
  const options = { launch: false, method: 'spawn', scan: true, exe: '', path: '', watchMs: 3000, kill: false, window: false, mask: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--launch') options.launch = true
    else if (arg === '--no-scan') options.scan = false
    else if (arg === '--kill') options.kill = true
    else if (arg === '--window') options.window = true
    else if (arg === '--no-mask') options.mask = false
    else if (arg === '--exe') options.exe = next() ?? ''
    else if (arg === '--path') options.path = next() ?? ''
    else if (arg === '--method') options.method = next() ?? 'spawn'
    else if (arg === '--watch-ms') options.watchMs = Number(next()) || 3000
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

/**
 * 隐私：自检默认把探测到的完整路径掩码成「盘符:\…\末段」，方便把输出直接贴进
 * issue / 日志而不泄露用户名和目录结构。要拿全路径排错时加 --no-mask。
 */
const show = (value) => (options.mask ? maskPath(value) : value)

if (options.help) {
  console.log('用法：node tools/selfcheck.mjs [--exe <exe全路径>] [--path <安装目录>] [--launch] [--method spawn|shell] [--watch-ms 3000] [--kill] [--no-scan] [--window]')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// --window：只验证独立窗口这一环（起临时页面 → Edge/Chrome --app= 开窗 → Win32 置顶 → 收尾）
// ---------------------------------------------------------------------------
if (options.window) {
  const tag = windowTag(randomBytes(8).toString('hex'))
  console.log('═'.repeat(64))
  console.log('原神，启动！· 独立窗口自检')
  console.log('═'.repeat(64))
  console.log(`平台            ${process.platform}`)
  console.log(`在 Electron 里  ${isElectron()}`)
  const browser = findChromiumBrowser()
  console.log(`找到的浏览器    ${browser ?? '(没找到 Edge/Chrome，会退化成默认浏览器标签页)'}`)
  console.log(`窗口标题标记    ${tag}`)
  console.log('')

  // 起一个临时页面：标题必须带上标记，置顶脚本就是靠它找窗口的
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${windowTitle(tag)}</title></head>` +
      '<body style="background:#141826;color:#f6dc9c;font:16px sans-serif;padding:24px">独立窗口自检页<br>' +
      '<span style="opacity:.6;font-size:13px">看到这个窗口就说明 --app= 通道可用</span></body></html>',
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/`
  console.log(`临时页面        ${url}`)

  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-genshin-window-'))
  let openResult
  try {
    openResult = await openStandaloneWindow({ url, token: tag, stateDir, alwaysOnTop: true, onNote: (m) => console.log(`  ${m}`) })
    console.log(`开窗结果        ${openResult.ok ? '成功' : '失败'}（via=${openResult.via}）`)

    if (openResult.via === 'browser-app') {
      // 置顶脚本是异步跑的，这里等一会儿再独立跑一次，单独验证"窗口到底找不找得到"
      await new Promise((resolve) => setTimeout(resolve, 8000))
      const verify = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(stateDir, 'dsh-genshin-launch-window.ps1'), '-Action', 'topmost', '-Tag', tag],
        { encoding: 'utf8', timeout: 25000, windowsHide: true },
      )
      const lines = String(verify.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
      const found = lines.some((line) => line.startsWith('found '))
      const topmost = lines.includes('topmost-ok')
      console.log(`找到窗口        ${found ? `✅ ${lines.find((line) => line.startsWith('found '))}` : '❌ 没找到'}`)
      console.log(`置顶            ${topmost ? '✅ topmost-ok' : '❌ 没置顶'}`)
      if (!found) {
        console.log('  提示：Edge/Chrome 首次用新 profile 时可能先弹自己的引导页，导致标题对不上。')
        console.log('        再跑一次通常会正常（profile 已经建好了）。')
      }
    }
  } finally {
    server.close()
    // 收窗口不能按 spawn 的 pid（那一个早退了），得按标题找到窗口所属进程再杀
    if (openResult?.via === 'browser-app') {
      const closed = await closeStandaloneWindow({ stateDir, tag, via: openResult.via, pid: openResult.pid })
      console.log(`收尾            ${closed.ok ? `已关掉自检窗口（pid ${closed.pid}）` : `关闭失败（${closed.detail}），手动关一下即可`}`)
    }
    // 浏览器 profile 里的文件可能还被占用，删不掉就算了（在系统临时目录里）
    try {
      rmSync(stateDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  console.log('')
  console.log('═'.repeat(64))
  process.exit(openResult?.ok ? 0 : 1)
}

console.log('═'.repeat(64))
console.log('原神，启动！· 自检')
console.log('═'.repeat(64))
console.log(`平台            ${process.platform}`)
console.log(`Node            ${process.version}`)
console.log(`认得的 exe 名   ${GAME_EXE_NAMES.join(', ')}`)
if (options.exe) {
  console.log(`指定 exe        ${options.exe}（存在？${existsSync(options.exe)}）`)
}
console.log('')
console.log('—— 探测阶梯 ——')

const sources = ['config', 'registry', 'paths', ...(options.scan ? ['scan'] : [])]
const startedAt = Date.now()
const result = await detectGame({
  gameExe: options.exe,
  gamePath: options.path,
  sources,
  scanMaxDepth: 4,
  scanBudgetMs: 20_000,
})
const elapsed = Date.now() - startedAt

for (const line of result.log) console.log(`  ${show(line)}`)
console.log('')
console.log(`探测结论        ${result.found ? '找到本体' : result.registered ? '登记了，但本体还没装完（安装 / 更新中）' : '没找到'}（用时 ${elapsed} ms）`)
if (result.found) {
  console.log(`  本体          ${show(result.exePath)}`)
  console.log(`  安装目录      ${show(result.installDir)}`)
  console.log(`  游戏目录      ${show(result.gameDir)}`)
  console.log(`  启动器        ${show(result.launcherPath ?? '(没找到，本体起不来时无法回退)')}`)
  console.log(`  版本          ${result.flavor}`)
  console.log(`  证据来源      ${result.source}`)
  console.log(`  config.ini    ${result.hasConfigIni ? '有' : '没有'}`)
} else if (result.registered) {
  console.log(`  安装目录      ${show(result.installDir)}`)
  console.log(`  游戏目录      ${show(result.gameDir)}`)
  console.log(`  启动器        ${show(result.launcherPath ?? '(没找到)')}`)
  console.log(`  判定依据      ${(result.incompleteEvidence ?? []).join('、')}`)
  console.log('  说明          这种情况插件不会再去下载启动器安装包，而是启动米哈游启动器让它继续。')
}
console.log('')

let exitCode = result.found ? 0 : 1

if (options.launch) {
  // 本体装好了就起本体；只登记了位置（正在安装 / 更新）就起启动器。
  const target = result.exePath ?? result.launcherPath
  if (!target) {
    console.log('要 --launch 但没有可启动的目标（探测没找到，也没给 --exe）。')
    process.exit(1)
  }
  const exeName = basename(target)
  const before = await isProcessRunning(exeName)
  console.log(`—— 启动 ——`)
  console.log(`  目标          ${show(target)}`)
  console.log(`  方式          ${options.method}`)
  console.log(`  启动前进程     ${before === undefined ? '问不到（宿主沙箱里 tasklist 会被拒，属正常）' : before ? '已经在跑' : '没在跑'}`)

  const launch = await launchExecutable(target, { method: options.method, watchMs: options.watchMs, cwd: dirname(target) })
  console.log(`  结果          ${launch.ok ? '成功' : '失败'}（status=${launch.status}${launch.pid ? `, pid=${launch.pid}` : ''}）`)
  if (launch.detail) console.log(`  说明          ${show(launch.detail)}`)

  const after = await isProcessRunning(exeName)
  console.log(`  启动后进程     ${after === undefined ? '问不到' : after ? '在跑' : '没在跑'}`)

  // 自测时把它收掉，别在屏幕上留个窗口
  if (options.kill && launch.pid) {
    try {
      process.kill(launch.pid)
      console.log(`  已结束        pid ${launch.pid}`)
    } catch (error) {
      console.log(`  结束失败      ${error.message}`)
    }
  }
  console.log('')
  if (!launch.ok) {
    console.log('提示：status=early-exit 表示它在观察窗内就退出了——对原神来说通常意味着')
    console.log('      「客户端版本过低要先更新」或「已经有一个实例在跑」，这时插件会改起米哈游启动器。')
    console.log('      如果拿一个小游戏当靶子来测，请确认它不会自己秒退。')
    exitCode = 1
  }
}

console.log('═'.repeat(64))
process.exit(exitCode)
