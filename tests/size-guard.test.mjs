// 体积安全闸的自测（零依赖，Node >= 20）
//   node tests/size-guard.test.mjs
import assert from 'node:assert/strict'
import { checkSizeAgainstBounds, enforceInstallerSize, sizeBounds, DEFAULT_EXPECTED_BYTES } from '../lib/size-guard.js'

const bounds = sizeBounds({})
assert.equal(bounds.expected, DEFAULT_EXPECTED_BYTES)
assert.equal(bounds.min, DEFAULT_EXPECTED_BYTES - 50 * 1024 * 1024)
assert.equal(bounds.max, DEFAULT_EXPECTED_BYTES + 50 * 1024 * 1024)

// 真实启动器安装包（2026-08-17 那版）必须通过
assert.equal(checkSizeAgainstBounds(234382248, bounds).ok, true)

// 边界：含上下限，越界即拒
assert.equal(checkSizeAgainstBounds(bounds.min, bounds).ok, true)
assert.equal(checkSizeAgainstBounds(bounds.min - 1, bounds).ok, false)
assert.equal(checkSizeAgainstBounds(bounds.max, bounds).ok, true)
assert.equal(checkSizeAgainstBounds(bounds.max + 1, bounds).ok, false)

// 离谱体积直接拒绝
assert.equal(checkSizeAgainstBounds(2 * 1024 * 1024, bounds).ok, false)
assert.equal(checkSizeAgainstBounds(900 * 1024 * 1024, bounds).ok, false)

// 体积未知：默认拒绝，显式 allowUnknownSize 才放行
assert.equal(checkSizeAgainstBounds(undefined, bounds).ok, false)
assert.equal((await enforceInstallerSize({ url: 'x', bytes: 2 * 1024 * 1024, bounds })).allowed, false)
assert.equal((await enforceInstallerSize({ url: 'x', bytes: undefined, bounds })).allowed, false)
assert.equal((await enforceInstallerSize({ url: 'x', bytes: undefined, bounds, allowUnknown: true })).allowed, true)

// 预期体积可配置：把预期调成 2MB 后，同一个 2MB 文件就合法了
const small = sizeBounds({ expectedInstallerBytes: 2 * 1024 * 1024 })
assert.equal(checkSizeAgainstBounds(2 * 1024 * 1024, small).ok, true)
assert.equal(checkSizeAgainstBounds(234382248, small).ok, false)

console.log('size-guard 自测通过：体积闸门在 ' + bounds.min + ' ~ ' + bounds.max + ' 字节之间放行。')
