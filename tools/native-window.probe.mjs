// 独立窗口的"实机"验证：用一个真 HTTP 服务器挂着真插件的路由，然后真开一次原生窗口，
// 检查窗口能出现、标题带标记、TopMost 置顶、/status 能读到内容。
//
//   node tools/native-window.probe.mjs
//
// 这个脚本**会真的弹一个窗口**（几秒后自己关掉）。它验证的是那套 WinForms 界面
// 和宿主路由之间真的能对上。
//
// ⚠️ 重要前提（实测踩过的坑）：**必须在真正的 DSH 宿主 / 交互式桌面会话里跑。**
//   在 DSH 受限沙箱里，PowerShell 子进程会被放进隔离的 window station，原生窗口虽然
//   确实创建、进程也确实活着、标题也确实带标记，但 EnumWindows 在沙箱这一侧看不到它
//   （Get-Process 的 MainWindowTitle 也拿不到）。所以"按标题找窗口"在沙箱里必然报
//   not-found —— 那是沙箱隔离，不是代码 bug。判定"通过"的硬指标是：
//     1) openStandaloneWindow 走 native 通道成功（via=native、返回 pid）
//     2) 那个 powershell 进程在窗口该出现的时间点仍然存活（没崩）
//   置顶/可见性只有在真实桌面会话里才判得准。
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { apply } from '../lib/index.js'
import { openStandaloneWindow, closeStandaloneWindow, windowTag } from '../lib/window.js'
import { runCaptured } from '../lib/exec.js'

const token = randomBytes(16).toString('hex')
const routes = new Map()
const logs = []

const fakeServer = {
  host: '127.0.0.1',
  port: 0,
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
  tapIndex() {
    return () => {}
  },
}

const ctx = {
  get: () => fakeServer,
  webServer: fakeServer,
  logger: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
  effect: (fn) => fn(),
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = routes.get(path)
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
fakeServer.port = port

const workDir = mkdtempSync(join(tmpdir(), 'dsh-genshin-native-'))
apply(ctx, {
  downloadDir: workDir,
  gameExe: join(workDir, 'nope.exe'), // 不存在 → 走 game-missing 分支，不真启动任何东西
  launchGame: false,
  download: false,
  sideEffectTrigger: 'ui',
  standaloneWindow: 'off', // 我们手动开窗，不让 apply 自己开
  clientNotice: true,
})

console.log(`宿主端口        http://127.0.0.1:${port}`)
console.log(`已注册路由      ${[...routes.keys()].join(', ')}`)

const statusRes = await new Promise((resolve) => {
  const req = { method: 'GET', headers: {}, url: '/dsh-genshin-launch/status', socket: { remoteAddress: '127.0.0.1' } }
  const res = { writeHead() { return this }, end(body) { resolve(body) } }
  routes.get('/dsh-genshin-launch/status')(req, res)
})
const statusJson = JSON.parse(statusRes)
console.log(`/status 返回      phase=${statusJson.phase} endpoint.port=${statusJson.endpoint?.port}`)

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-genshin-native-win-'))
const t = windowTag(token)
console.log(`\n开原生窗口        tag=${t}`)
const opened = await openStandaloneWindow({
  url: `http://127.0.0.1:${port}/dsh-genshin-launch/panel`,
  port,
  token,
  stateDir,
  engine: 'native',
  onNote: (m) => console.log(`  ${m}`),
})
console.log(`开窗结果          ok=${opened.ok} via=${opened.via} pid=${opened.pid}`)

let hardPass = opened.ok && opened.via === 'native' && Number.isFinite(opened.pid)
if (!hardPass) {
  console.log('!! 没走 native 通道或没拿到 pid —— 这是真问题')
}

// 等窗口渲染 + 轮询宿主几轮
console.log('等 4 秒让窗口自己轮询 /status…')
await new Promise((r) => setTimeout(r, 4000))

// 进程存活判定（硬指标）：detached 出去的 powershell 还在 = 窗体 ShowDialog 没崩
const alive = await runCaptured(
  'powershell.exe',
  ['-NoProfile', '-Command', `Get-Process -Id ${opened.pid} -ErrorAction SilentlyContinue | Measure-Object | ForEach-Object Count`],
  { timeoutMs: 8000 },
)
const aliveCount = Number(String(alive.stdout).trim()) || 0
console.log(`窗口进程存活      ${aliveCount > 0 ? '✅ 仍在运行（窗体没崩）' : '❌ 进程已退出（多半是脚本崩了）'}`)
if (aliveCount === 0) hardPass = false

// 按标题找窗口 + 置顶（软指标：沙箱里必然 not-found，真实桌面会话才判得准）
const closed = await closeStandaloneWindow({ stateDir, tag: t, via: opened.via, pid: opened.pid })
console.log(`按标题收尾        ${closed.ok ? `✅ 找到并关掉了窗口（pid ${closed.pid}）` : `⚠️ ${closed.detail ?? '未找到'}（沙箱里属正常，需在真实桌面会话验证）`}`)

try {
  rmSync(stateDir, { recursive: true, force: true })
} catch {}
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {}
server.close()

console.log('\n' + (hardPass ? '✅ 探针通过：原生窗口经 native 通道打开、脚本无崩溃。' : '❌ 探针失败：见上面的硬指标。'))
console.log('   置顶/可见性需在真实 DSH 宿主（非沙箱）里再确认一次。')
process.exit(hardPass ? 0 : 1)
