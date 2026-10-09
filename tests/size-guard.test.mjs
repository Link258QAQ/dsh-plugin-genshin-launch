// 体积安全闸的自测（零依赖，Node >= 20）
//   node tests/size-guard.test.mjs
//
// 两档模型：
//   严格档 = 基准 ± 15MB        → 直接放行
//   宽档   = 100MB ~ 400MB      → 只有官方域名 + 调用方明确放行才算通过（正常是先问用户）
//   档外                        → 直接拒绝
import assert from 'node:assert/strict'

import {
  DEFAULT_EXPECTED_BYTES,
  DEFAULT_SANITY_MAX_BYTES,
  DEFAULT_SANITY_MIN_BYTES,
  DEFAULT_TOLERANCE_BYTES,
  checkSizeAgainstBounds,
  classifySize,
  enforceInstallerSize,
  isOfficialHost,
  sizeBounds,
} from '../lib/size-guard.js'

const MB = 1024 * 1024
/** 真实国服启动器安装包（2026-08-17 那版）实测字节数。 */
const REAL_INSTALLER = 234382248

// ---------------------------------------------------------------- 区间推导
const bounds = sizeBounds({})
assert.equal(bounds.expected, DEFAULT_EXPECTED_BYTES, '没配基准时用出厂值')
assert.equal(bounds.tolerance, DEFAULT_TOLERANCE_BYTES, '默认容差应该是 ±15MB')
assert.equal(bounds.tolerance, 15 * MB)
assert.equal(bounds.min, DEFAULT_EXPECTED_BYTES - 15 * MB)
assert.equal(bounds.max, DEFAULT_EXPECTED_BYTES + 15 * MB)
assert.equal(bounds.sanityMin, DEFAULT_SANITY_MIN_BYTES)
assert.equal(bounds.sanityMax, DEFAULT_SANITY_MAX_BYTES)

// 学习到的基准优先于配置值（这就是"下载成功后自适应"）
const learned = sizeBounds({ expectedInstallerBytes: 100 * MB }, { baselineBytes: 300 * MB })
assert.equal(learned.expected, 300 * MB, '落盘学到的基准要压过配置里的值')
assert.equal(learned.min, 285 * MB)
assert.equal(learned.max, 315 * MB)

// 没有学习值时退到配置值
const configured = sizeBounds({ expectedInstallerBytes: 200 * MB })
assert.equal(configured.expected, 200 * MB)

// 显式上下限覆盖推导
const explicit = sizeBounds({ expectedInstallerBytes: 200 * MB, minInstallerBytes: 190 * MB, maxInstallerBytes: 210 * MB })
assert.equal(explicit.min, 190 * MB)
assert.equal(explicit.max, 210 * MB)

// ---------------------------------------------------------------- 分档
assert.equal(classifySize(REAL_INSTALLER, bounds).tier, 'strict', '真实安装包落在出厂基准的严格档内')
assert.equal(classifySize(bounds.min, bounds).tier, 'strict', '下界含在内')
assert.equal(classifySize(bounds.max, bounds).tier, 'strict', '上界含在内')
assert.equal(classifySize(bounds.max + 1, bounds).tier, 'sanity', '刚出严格档 → 宽档，交给用户裁决')
assert.equal(classifySize(bounds.min - 1, bounds).tier, 'sanity')
assert.equal(classifySize(2 * MB, bounds).tier, 'reject', '2MB 的"安装包"直接拒绝')
assert.equal(classifySize(900 * MB, bounds).tier, 'reject', '900MB 直接拒绝')
assert.equal(classifySize(undefined, bounds).tier, 'unknown')
assert.equal(classifySize(Number.NaN, bounds).tier, 'unknown')

// 这就是"收窄到 ±15MB 也不会把自己锁死"的关键：更大的新版本落在宽档而不是被拒
const newerInstaller = 250 * MB
assert.equal(classifySize(newerInstaller, bounds).tier, 'sanity', '米哈游把包改大 26MB → 宽档（可以问用户）')

// 兼容旧接口：只看严格档
assert.equal(checkSizeAgainstBounds(REAL_INSTALLER, bounds).ok, true)
assert.equal(checkSizeAgainstBounds(newerInstaller, bounds).ok, false, '旧接口仍然只认严格档')
assert.equal(checkSizeAgainstBounds(undefined, bounds).ok, false)

// ---------------------------------------------------------------- 官方域名
assert.equal(isOfficialHost('https://autopatchcn.yuanshen.com/a/b.exe'), true)
assert.equal(isOfficialHost('https://ys.mihoyo.com/launcher'), true)
assert.equal(isOfficialHost('https://sdk-static.mihoyo.com/x'), true)
assert.equal(isOfficialHost('https://yuanshen.com.evil.example/x.exe'), false, '后缀伪装必须识破')
assert.equal(isOfficialHost('https://evil.example/yuanshen.com/x.exe'), false)
assert.equal(isOfficialHost('http://127.0.0.1:8080/x.exe'), false)
assert.equal(isOfficialHost('not a url'), false)

// ---------------------------------------------------------------- 执行闸门
const officialUrl = 'https://autopatchcn.yuanshen.com/client_app/download/x/yuanshen_setup.exe'

// 严格档：直接放行
assert.equal((await enforceInstallerSize({ url: officialUrl, bytes: REAL_INSTALLER, bounds })).allowed, true)

// 宽档：默认不放行（要先问用户），调用方明确 allowSanity 才放行
assert.equal((await enforceInstallerSize({ url: officialUrl, bytes: newerInstaller, bounds })).allowed, false)
assert.equal((await enforceInstallerSize({ url: officialUrl, bytes: newerInstaller, bounds, allowSanity: true })).allowed, true)
// 宽档 + 非官方域名：即使调用方放行也不算通过
assert.equal(
  (await enforceInstallerSize({ url: 'https://evil.example/yuanshen_setup.exe', bytes: newerInstaller, bounds, allowSanity: true })).allowed,
  false,
  '宽档只在官方域名上才允许放行',
)

// 体积未知：默认拒绝，显式 allowUnknownSize 才放行
assert.equal((await enforceInstallerSize({ url: officialUrl, bytes: undefined, bounds })).allowed, false)
assert.equal((await enforceInstallerSize({ url: officialUrl, bytes: undefined, bounds, allowUnknown: true })).allowed, true)

// 档外：拒绝
assert.equal((await enforceInstallerSize({ url: officialUrl, bytes: 2 * MB, bounds })).allowed, false)

console.log(
  `体积安全闸自测通过：严格档 ${bounds.min} ~ ${bounds.max} 字节（基准 ${bounds.expected} ± ${bounds.tolerance}），` +
  `宽档 ${bounds.sanityMin} ~ ${bounds.sanityMax} 字节（只在官方域名上征求用户同意）。`,
)
