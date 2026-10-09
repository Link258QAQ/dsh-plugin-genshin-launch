// 隐私模块自测（零依赖，Node >= 20）
//   node tests/privacy.test.mjs
//
// DPAPI 在受限环境（DSH 沙箱/ConstrainedLanguage）里会**按设计降级为明文**，
// 这里的断言同时覆盖两条路：加密成功要能 round-trip；降级要标记出来且数据不丢。
import assert from 'node:assert/strict'
import { utimesSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ENC_PREFIX, maskPath, maskPathsInText, protect, unprotect } from '../lib/privacy.js'

// ------------------------------------------------------------ maskPath
assert.equal(maskPath('C:\\Users\\alice\\Games\\Genshin Impact Game\\YuanShen.exe'), 'C:\\…\\YuanShen.exe')
assert.equal(maskPath('D:\\原神\\GenshinImpact.exe'), 'D:\\…\\GenshinImpact.exe')
assert.equal(maskPath('D:\\'), 'D:\\', '只剩盘符时没有可藏的')
assert.equal(maskPath('YuanShen.exe'), 'YuanShen.exe', '相对路径原样返回')
assert.equal(maskPath(''), '', '空串安全')
assert.equal(maskPath(undefined), '', '非字符串安全')
// UNC：留服务器 + 共享名，藏其后层级
assert.equal(maskPath('\\\\NAS\\games\\Genshin Impact\\YuanShen.exe'), '\\\\NAS\\games\\…\\YuanShen.exe')
assert.ok(!maskPath('\\\\NAS\\games\\secret-share\\YuanShen.exe').includes('secret-share'), 'UNC 深层目录也要藏')
// 用户名绝不从掩码结果里泄露
assert.ok(!maskPath('C:\\Users\\zhangsan\\x\\YuanShen.exe').includes('zhangsan'))
assert.ok(!maskPath('C:\\Users\\zhangsan\\x\\YuanShen.exe').includes('Users'))

// ------------------------------------------------------------ maskPathsInText
const line = maskPathsInText('状态目录：C:\\Users\\alice\\Desktop\\dsh-genshin-launch-config.json，安装包在 D:\\a\\b\\yuanshen_setup.exe')
assert.ok(!line.includes('alice'), `掩码后不该有用户名：${line}`)
assert.ok(!line.includes('Desktop'), `掩码后不该有中间目录：${line}`)
assert.ok(line.includes('…\\dsh-genshin-launch-config.json'), '保留盘符 + 末段文件名')
assert.ok(line.includes('D:\\…\\yuanshen_setup.exe'))
assert.equal(maskPathsInText('没有路径的一行'), '没有路径的一行')
// 回归：URL 不能被当路径打烂（曾经 http://127.0.0.1:3080 里的 p:// 被误认成盘符）
assert.equal(maskPathsInText('识别到 DSH 端口：http://127.0.0.1:3080'), '识别到 DSH 端口：http://127.0.0.1:3080')
assert.equal(maskPathsInText('退化成打开官方下载页：https://ys.mihoyo.com/main/'), '退化成打开官方下载页：https://ys.mihoyo.com/main/')

// ------------------------------------------------------------ protect / unprotect
const plain = 'D:\\youxi\\Genshin Impact Game\\YuanShen.exe'
const sealed = protect(plain)
assert.equal(typeof sealed.value, 'string')
if (sealed.encrypted) {
  // 真加密：带前缀、看不到原文、能解回来
  assert.ok(sealed.value.startsWith(ENC_PREFIX), '加密值要带 enc:v1: 前缀')
  assert.ok(!sealed.value.includes('YuanShen'), '密文里不应出现原文')
  const opened = unprotect(sealed.value)
  assert.ok(opened.ok, `解密应成功：${opened.reason}`)
  assert.equal(opened.value, plain, 'round-trip 要拿回原值')
  assert.equal(opened.wasEncrypted, true)
} else {
  // 降级：明文透传，但必须把原因带出来，且 unprotect 对无前缀值原样返回。
  assert.ok(sealed.reason, '降级必须给原因')
  assert.equal(sealed.value, plain)
  assert.equal(unprotect(plain).value, plain)
  assert.equal(unprotect(plain).wasEncrypted, false)
  console.log(`  （本机 DPAPI 不可用，按设计走明文降级：${sealed.reason}）`)
}
// 解不开的密文：返回 ok:false，调用方按未配置处理
const broken = unprotect(`${ENC_PREFIX}这不是合法base64!!`)
assert.equal(broken.ok, false, '坏密文要如实报告失败')

// ------------------------------------------------------------ 空值
assert.equal(protect('').value, '')
assert.equal(unprotect('').value, '')

// ------------------------------------------------------------ sweepTempFiles
// exec.js 的泄漏点是 %TEMP% 顶层的 dsh-genshin-launch-*.out；sweepTempFiles 也只扫顶层。
// 在真实 %TEMP% 顶层造一个"几分钟前的"残留，跑一次清理应删掉；60s 内的新文件不动。
const staleName = 'dsh-genshin-launch-stale-test.out'
const freshName = 'dsh-genshin-launch-fresh-test.out'
const stalePath = join(tmpdir(), staleName)
const freshPath = join(tmpdir(), freshName)
try {
  writeFileSync(stalePath, 'x')
  writeFileSync(freshPath, 'x')
  const past = new Date(Date.now() - 5 * 60_000)
  utimesSync(stalePath, past, past)

  const { sweepTempFiles } = await import('../lib/privacy.js')
  const swept = sweepTempFiles()
  assert.ok(swept.removed >= 1, `应至少清掉 1 个残留（实际 ${swept.removed}）`)
  assert.ok(!readdirSync(tmpdir()).includes(staleName), '旧残留应被删除')
  assert.ok(readdirSync(tmpdir()).includes(freshName), '60 秒内的新文件不应被删（可能正在用）')
  console.log(`临时残留清理自测通过：删了 ${swept.removed} 个（含本次造的 1 个）`)
} finally {
  rmSync(stalePath, { force: true })
  rmSync(freshPath, { force: true })
}

console.log(`隐私模块自测通过：掩码不泄露用户名/中间目录（${sealed.encrypted ? 'DPAPI 加密 round-trip' : 'DPAPI 降级明文'}）、临时残留可清理。`)
