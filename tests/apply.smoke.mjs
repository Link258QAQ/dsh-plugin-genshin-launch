// 宿主半侧的集成冒烟测试：不需要真的在 DSH 里跑，用假的 ctx 把 apply() 拉起来，
// 然后像浏览器那样走一遍路由。
//
//   node tests/apply.smoke.mjs [靶子程序路径]
//
// 覆盖：状态/配置路由、一次性 token、同源与回环校验、**副作用门控**（UI 没出现前绝不动手）、
//       **F5 幂等**（重复上报不会开第二个游戏进程）、启动成功与秒退两条路、状态文件落盘。
//
// 注意：会真的把靶子程序启动一次（默认是那个小游戏），跑完自动把它收掉。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const TARGET = process.argv[2] ?? 'D:\\games\\Shawarma\\Shawarma Legend.exe'
if (!existsSync(TARGET)) {
  console.error(`靶子程序不存在：${TARGET}`)
  console.error('用法：node tests/apply.smoke.mjs [某个会自己保持运行的 exe]')
  process.exit(2)
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-genshin-apply-'))
// 隐私整改后，插件默认把状态/配置写到 %LOCALAPPDATA%。测试**必须**用 stateDir
// 把这一切重定向到临时目录——否则会把真实用户的配置读进来（老配置里的 YuanShen.exe
// 会覆盖本测试的 TARGET，甚至真的去启动游戏本体）。
const stateDir = join(workDir, 'state')

// 预检：靶子已经在跑的话，插件会（正确地）判定「已经在运行」而拒绝再开一个，
// 这个测试就没法验证启动路径了。与其给一个看不懂的失败，不如直接说清楚。
{
  const { isProcessRunning } = await import('../lib/launch.js')
  const { basename } = await import('node:path')
  const running = await isProcessRunning(basename(TARGET))
  if (running === true) {
    console.error(`靶子程序已经在运行了（${basename(TARGET)}）。请先关掉它再跑这个测试。`)
    rmSync(workDir, { recursive: true, force: true })
    process.exit(2)
  }
}

const logs = []
const routes = new Map()
const effects = []
let tap

const fakeServer = {
  host: '127.0.0.1',
  port: 3080,
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
  tapIndex(transform) {
    tap = transform
    return () => {
      tap = undefined
    }
  },
}

const ctx = {
  get: () => fakeServer,
  webServer: fakeServer,
  logger: {
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
  },
  effect: (fn) => effects.push(fn),
}

function fakeReq(overrides = {}) {
  const listeners = new Map()
  return {
    method: 'GET',
    headers: {},
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      listeners.set(event, handler)
      return this
    },
    destroy() {},
    /** 手动把 body 灌进去（我们不用真的 http 流）。 */
    feed(body) {
      listeners.get('data')?.(body)
      listeners.get('end')?.()
    },
    ...overrides,
  }
}

function fakeRes() {
  return {
    status: undefined,
    body: '',
    headers: undefined,
    writeHead(code, headers) {
      this.status = code
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

const getRoute = (path) => {
  const handler = routes.get(path)
  assert.ok(handler, `路由 ${path} 应该注册了`)
  return handler
}

async function getStatus() {
  const res = fakeRes()
  await getRoute('/dsh-genshin-launch/status')(fakeReq(), res)
  return JSON.parse(res.body)
}

async function postJson(path, payload, overrides = {}) {
  const res = fakeRes()
  const req = fakeReq({ method: 'POST', ...overrides })
  const promise = getRoute(path)(req, res)
  req.feed(payload === undefined ? '' : JSON.stringify(payload))
  await promise
  return res
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForPhase(phases, tries = 80) {
  let last
  for (let i = 0; i < tries; i += 1) {
    last = await getStatus()
    if (phases.includes(last.phase)) return last
    await sleep(150)
  }
  return last
}

console.log('原神，启动！· 宿主半侧冒烟测试')
console.log(`  靶子程序      ${TARGET}`)
console.log(`  状态目录      ${stateDir}`)
console.log('')

apply(ctx, {
  downloadDir: workDir,
  stateDir,
  gameExe: TARGET,
  launchGame: true,
  launchTrigger: 'gui',
  sideEffectTrigger: 'ui',
  launchMethod: 'spawn',
  launchWatchMs: 2500,
  fallbackToLauncher: false,
  launchOncePerSession: true,
  clientNotice: true,
  clientNoticeSeconds: 5,
  standaloneWindow: 'off',
  download: false,
})

// —— 路由都注册上了吗 ——
for (const path of ['/dsh-genshin-launch/status', '/dsh-genshin-launch/hello', '/dsh-genshin-launch/answer', '/dsh-genshin-launch/config', '/dsh-genshin-launch/rescan', '/dsh-genshin-launch/token', '/dsh-genshin-launch/panel', '/dsh-genshin-launch/client.js']) {
  assert.ok(routes.has(path), `应该注册 ${path}`)
}
assert.equal(typeof tap, 'function')
console.log('✓ 八条浏览器侧接线都注册了（status / hello / answer / config / rescan / token / panel / client.js）')

// —— token 注入 ——
const html = tap('</body>')
assert.ok(html.includes('/dsh-genshin-launch/client.js?token='))
const token = /client\.js\?token=([a-f0-9]+)/.exec(html)?.[1]
assert.ok(token && token.length >= 16)
assert.equal(tap(html), html, '重复注入应该幂等')
console.log(`✓ index 注入带一次性 token（${token.slice(0, 8)}…），且重复调用不会重复注入`)

// —— 独立窗口那个整页 ——
const panelRes = fakeRes()
await getRoute('/dsh-genshin-launch/panel')(fakeReq(), panelRes)
assert.equal(panelRes.status, 200)
assert.ok(panelRes.body.includes('__DSH_GENSHIN_STANDALONE__'), '面板页要标记独立模式')
assert.ok(panelRes.body.includes('mode=standalone'), '面板页要带上 standalone 标记')
console.log('✓ /panel 提供独立窗口用的整页（与网页面板共用同一份 client.js）')

// —— 等探测落定 ——
const detected = await waitForPhase(['game-found', 'game-missing', 'installing'])
assert.equal(detected.game.found, true, '用 gameExe 指定了靶子，应该判定为「找到」')
// 隐私：状态/面板里只回显掩码路径（C:\…\末段），完整路径不进 JSON。
assert.match(detected.game.exePath, /^[A-Za-z]:\\…\\/, `界面上的 exePath 应是掩码形式，实际：${detected.game.exePath}`)
assert.ok(!detected.game.exePath.includes('games'), '掩码结果不该保留中间目录（只留盘符 + 末段文件名）')
assert.ok(detected.game.exePath.endsWith('Shawarma Legend.exe'), '掩码要保留末段文件名')
console.log(`✓ 探测到目标（掩码显示）：${detected.game.exePath}（来源 ${detected.game.source}）`)

// —— 关键：UI 还没出现之前，绝不能有任何副作用 ——
assert.equal(detected.ui.ready, false, '此时还没有 UI 面')
assert.equal(detected.phase, 'game-found', '应该停在「已找到」，等 UI')
assert.ok(!logs.some((line) => line.includes('（方式 ')), 'UI 就绪前不该启动游戏')
console.log('✓ 副作用门控：UI 没出现之前，只是探测，没有启动任何东西')

// —— 路由的四种拒绝 ——
const wrongToken = await postJson('/dsh-genshin-launch/hello', undefined, { headers: { 'x-dsh-genshin-token': 'deadbeef' } })
assert.equal(wrongToken.status, 403)
assert.equal(JSON.parse(wrongToken.body).reason, 'bad-token')

const crossOrigin = await postJson('/dsh-genshin-launch/hello', undefined, { headers: { 'x-dsh-genshin-token': token, origin: 'https://evil.example' } })
assert.equal(crossOrigin.status, 403)
assert.equal(JSON.parse(crossOrigin.body).reason, 'cross-origin')

const wrongMethod = fakeRes()
await getRoute('/dsh-genshin-launch/hello')(fakeReq({ method: 'GET' }), wrongMethod)
assert.equal(wrongMethod.status, 405)

const nonLoopback = await postJson('/dsh-genshin-launch/hello', undefined, { headers: { 'x-dsh-genshin-token': token }, socket: { remoteAddress: '192.168.1.5' } })
assert.equal(nonLoopback.status, 403)
console.log('✓ 挡住了：错 token / 跨站 Origin / 非 POST / 非回环')

// —— token 路由 ——
const tokenRes = fakeRes()
await getRoute('/dsh-genshin-launch/token')(fakeReq(), tokenRes)
assert.equal(tokenRes.status, 200)
assert.equal(JSON.parse(tokenRes.body).token, token, '客户端半边要能拿到同一个 token')
console.log('✓ /token 让 DSH 插件栏的配置卡拿到 token（同源限定）')

// —— 正牌请求：模拟「浏览器把界面打开了」 ——
const hello = await postJson('/dsh-genshin-launch/hello', undefined, {
  headers: { 'x-dsh-genshin-token': token, origin: 'http://127.0.0.1:3080' },
  url: '/dsh-genshin-launch/hello?mode=panel',
})
assert.equal(hello.status, 200)
console.log('✓ 同源回环 POST /hello 被接受（= 界面渲染出来了）')

const final = await waitForPhase(['launched', 'launch-failed', 'already-running'])
assert.equal(final.phase, 'launched', `期望启动成功，实际 phase=${final.phase}（${final.error ?? final.message}）`)
const pid = /pid (\d+)/.exec(final.message)?.[1]
console.log(`✓ 启动成功：${final.message}`)

// —— 核心保证 ①：F5 刷新（重复上报）不会再开一个游戏进程 ——
// 匹配「真正走到 spawn 前」那行日志（形如 `启动原神（ui-open）：…（方式 spawn）`）。
// 这里绝不能匹配得太松——之前用『启动原神：』已经匹配不到任何行，导致两条核心断言
// 变成 0===0 的空断言，热重载真的重开了游戏都没被发现。
const launchAttempts = () => logs.filter((line) => line.includes('（方式 ')).length
const launchesBefore = launchAttempts()
assert.ok(launchesBefore >= 1, `前置校验：此刻应该已经记录到至少一次启动尝试，实际 ${launchesBefore}`)
for (let i = 0; i < 3; i += 1) {
  await postJson('/dsh-genshin-launch/hello', undefined, {
    headers: { 'x-dsh-genshin-token': token, origin: 'http://127.0.0.1:3080' },
    url: '/dsh-genshin-launch/hello?mode=panel',
  })
}
await sleep(400)
const launchesAfterRepeat = launchAttempts()
assert.equal(launchesAfterRepeat, launchesBefore, '重复上报（F5）不能再拉起一个游戏进程')
console.log(`✓ F5 幂等：连点 3 次 /hello，启动尝试仍是 ${launchesAfterRepeat} 次，没有第二个游戏进程`)

// —— 核心保证 ②：即使插件被热重载（uiReady 清零），落盘标记也要挡住重复启动 ——
// 这一条比上一条更重要：patchReload: live 下 apply() 会重跑，内存里的 uiReady 没了，
// 只剩「宿主 pid + 进程启动时刻」这个落盘标记在兜底。
assert.ok(existsSync(join(stateDir, 'dsh-genshin-launch-session.json')), '启动后应该写下会话标记')
apply(ctx, {
  downloadDir: workDir,
  stateDir,
  gameExe: TARGET,
  launchGame: true,
  launchTrigger: 'gui',
  sideEffectTrigger: 'ui',
  launchMethod: 'spawn',
  launchWatchMs: 2000,
  fallbackToLauncher: false,
  launchOncePerSession: true,
  clientNotice: true,
  standaloneWindow: 'off',
  download: false,
})
const reloadToken = /client\.js\?token=([a-f0-9]+)/.exec(tap('</body>'))?.[1]
assert.ok(reloadToken, '热重载后应该有一套新的 token')
await waitForPhase(['game-found', 'game-missing', 'installing'])
const afterReload = await postJson('/dsh-genshin-launch/hello', undefined, {
  headers: { 'x-dsh-genshin-token': reloadToken, origin: 'http://127.0.0.1:3080' },
  url: '/dsh-genshin-launch/hello?mode=panel',
})
assert.equal(afterReload.status, 200)
await sleep(800)
const launchesAfterReload = launchAttempts()
assert.equal(launchesAfterReload, launchesBefore, '热重载之后也不能再拉起一个游戏进程')
assert.ok(
  logs.some((line) => line.includes('已经启动过原神了，跳过')),
  '应该由落盘标记明确挡下，而不是碰巧没触发',
)
console.log('✓ 热重载幂等：apply() 重跑（uiReady 归零）后，落盘标记仍然挡住了第二次启动')

// —— 配置路由 ——
// 注意：上面刚刚热重载过，token 换了，后面都用新的那个。
const activeToken = reloadToken
const configGet = fakeRes()
await getRoute('/dsh-genshin-launch/config')(fakeReq(), configGet)
const initialConfig = JSON.parse(configGet.body).config
assert.equal(initialConfig.gameExe, '', '一开始没有手填路径')
// 隐私：配置回显不再包含配置文件路径；改为报告存储方式。
assert.equal(initialConfig.path, undefined, '不应再把配置文件完整路径回显给界面')
assert.ok(['none', 'plain', 'dpapi'].includes(initialConfig.encryption), `应报告存储方式，实际 ${initialConfig.encryption}`)

// 旧 token 必须失效（热重载换了 token），这同时验证了"token 真的在起作用"
const staleToken = await postJson('/dsh-genshin-launch/config', { gameExe: TARGET }, { headers: { 'x-dsh-genshin-token': token } })
assert.equal(staleToken.status, 403, '热重载前的旧 token 应该失效')
assert.equal(JSON.parse(staleToken.body).reason, 'bad-token')

const badPath = await postJson('/dsh-genshin-launch/config', { gameExe: 'D:\\这个路径不存在\\YuanShen.exe' }, {
  headers: { 'x-dsh-genshin-token': activeToken },
})
assert.equal(badPath.status, 400, '不存在的路径必须被拒')
assert.ok(JSON.parse(badPath.body).reason.includes('不存在'))

const goodPath = await postJson('/dsh-genshin-launch/config', { gameExe: TARGET }, {
  headers: { 'x-dsh-genshin-token': activeToken },
})
assert.equal(goodPath.status, 200)
// 回显是掩码的（写进去的是完整路径，读回来只露「盘符:\…\末段」）。
assert.match(JSON.parse(goodPath.body).config.gameExe, /^[A-Za-z]:\\…\\/, '配置回显应是掩码路径')
const onDiskConfig = JSON.parse(readFileSync(join(stateDir, 'dsh-genshin-launch-config.json'), 'utf8'))
assert.equal(onDiskConfig.version, 2, '配置应是 v2 格式')
// 隐私：盘上明文里不能出现完整路径——路径在 secrets（DPAPI 或降级明文 blob）里。
assert.equal(onDiskConfig.gameExe, undefined, '明文 gameExe 字段不该落盘')
assert.ok(typeof onDiskConfig.secrets === 'string' && onDiskConfig.secrets.length > 0, '路径应存进 secrets')
assert.ok(['dpapi', 'plain'].includes(onDiskConfig.encryption))
if (onDiskConfig.encryption === 'dpapi') {
  assert.ok(!JSON.stringify(onDiskConfig).includes('Shawarma'), '加密模式下整个盘上文件不该能搜到靶子名')
}
console.log(`✓ /config：旧 token 失效、坏路径被拒、好路径写盘生效（落盘 v2，存储方式 ${onDiskConfig.encryption}）`)

// —— 答题路由 ——
const staleAnswer = await postJson('/dsh-genshin-launch/answer', { id: '过期的问题', option: 'allow' }, {
  headers: { 'x-dsh-genshin-token': activeToken },
})
assert.equal(staleAnswer.status, 409, '对不上任何在等的问题要回 409')
console.log('✓ /answer：对不上在等的问题时回 409，不会误判')

// —— 状态文件落盘 ——
const statusFile = join(stateDir, 'dsh-genshin-launch-status.json')
assert.ok(existsSync(statusFile))
const onDisk = JSON.parse(readFileSync(statusFile, 'utf8'))
// 隐私：整份状态文件搜不到完整路径——所有路径字段都是掩码形式。
assert.ok(!JSON.stringify(onDisk).includes('Shawarma\\Shawarma Legend.exe'), '状态文件里不该出现完整靶子路径')
assert.match(onDisk.game.exePath, /^[A-Za-z]:\\…\\/, '状态文件里的 exePath 是掩码的')
assert.match(onDisk.stateDir, /^[A-Za-z]:\\…\\/, '状态文件里的 stateDir 也是掩码的')
// 注意：这里是**热重载之后那个实例**写的状态。它收到了 /hello、经历了一次启动流程，
// 但被落盘标记挡住没有真的再启动 —— 所以停在 game-found，而不是 launched。
// 这本身就是"没有第二个游戏进程"的又一份证据。
assert.equal(onDisk.phase, 'game-found', '热重载后的实例应该停在「已找到」，因为启动被幂等挡住了')
assert.equal(onDisk.ui.ready, true, '"UI 出现过"这件事要落到状态文件里')
assert.equal(onDisk.endpoint.port, 3080)
console.log('✓ 状态文件落盘正确（面板就是靠它渲染的；热重载后的实例停在 game-found 而非 launched）')

// —— 收尾 ——
if (pid) {
  try {
    process.kill(Number(pid))
    console.log(`✓ 已结束靶子程序 pid ${pid}`)
  } catch (error) {
    console.log(`  收尾失败（手动关一下窗口即可）：${error.message}`)
  }
}
for (const effect of effects) {
  const disposer = effect()
  if (typeof disposer === 'function') disposer()
}
rmSync(workDir, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 场景二：靶子秒退（模拟「客户端版本过低」或「已经有实例在跑」）
// ---------------------------------------------------------------------------
const quickExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')
assert.ok(existsSync(quickExe), '找不到用来模拟秒退的系统程序')

const { launchExecutable } = await import('../lib/launch.js')
const quick = await launchExecutable(quickExe, { watchMs: 2500, cwd: tmpdir() })
assert.equal(quick.ok, false, '秒退的程序不该被判成启动成功')
assert.equal(quick.status, 'early-exit', `期望 early-exit，实际 ${quick.status}（${quick.detail}）`)
console.log('')
console.log(`✓ 秒退被正确识别为 early-exit（${quick.detail}）→ 真实场景下会改起米哈游启动器`)

const missing = await launchExecutable(join(tmpdir(), '这个程序不存在-12345.exe'), { watchMs: 500 })
assert.equal(missing.ok, false)
assert.equal(missing.status, 'spawn-error', `期望 spawn-error，实际 ${missing.status}`)
console.log(`✓ 目标不存在时报 spawn-error（${missing.detail}），不会把宿主搞挂`)

console.log('')
console.log('宿主半侧冒烟测试通过。')
