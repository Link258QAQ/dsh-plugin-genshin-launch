// 安装包体积安全闸。
//
// 背景：启动器安装包（yuanshen_setup_*.exe）是几十 MB 到二百多 MB 的桌面安装器，
// 换游戏版本时体积不会大改。所以一旦拿到的文件与预期体积相差超过容差，
// 就认为这条链接已经不可信（被替换成网页 / 广告安装器 / 别的什么东西），
// **整条链接全部拒绝**，不许下、不许续传、已下了一半的也丢掉。
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { humanSize } from './download.js'

/** 国服启动器安装包的实测体积（2026-08-17 那版是 234,382,248 字节 ≈ 224 MiB）。 */
export const DEFAULT_EXPECTED_BYTES = 224 * 1024 * 1024

/** 默认容差：±50 MiB。 */
export const DEFAULT_TOLERANCE_BYTES = 50 * 1024 * 1024

/**
 * 依据配置算出允许的体积区间。
 * @param {object} config
 * @param {number} [config.expectedInstallerBytes] 预期体积
 * @param {number} [config.sizeToleranceBytes] 容差
 * @param {number} [config.minInstallerBytes] 显式下限（优先于推导值）
 * @param {number} [config.maxInstallerBytes] 显式上限（优先于推导值）
 * @returns {{ min: number, max: number, expected: number, tolerance: number }}
 */
export function sizeBounds(config = {}) {
  const expected = Number(config.expectedInstallerBytes) > 0 ? Number(config.expectedInstallerBytes) : DEFAULT_EXPECTED_BYTES
  const tolerance = Number(config.sizeToleranceBytes) >= 0 ? Number(config.sizeToleranceBytes) : DEFAULT_TOLERANCE_BYTES
  const min = Number(config.minInstallerBytes) > 0 ? Number(config.minInstallerBytes) : Math.max(1, expected - tolerance)
  const max = Number(config.maxInstallerBytes) > 0 ? Number(config.maxInstallerBytes) : expected + tolerance
  return { min, max, expected, tolerance }
}

/** 只判断体积是否越界（不读磁盘）。 */
export function checkSizeAgainstBounds(bytes, bounds) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, known: false, reason: '拿不到体积，无法通过安全校验' }
  }
  if (bytes < bounds.min) {
    return {
      ok: false,
      known: true,
      reason: `体积 ${humanSize(bytes)} 小于下限 ${humanSize(bounds.min)}（预期 ${humanSize(bounds.expected)} ± ${humanSize(bounds.tolerance)}）`,
    }
  }
  if (bytes > bounds.max) {
    return {
      ok: false,
      known: true,
      reason: `体积 ${humanSize(bytes)} 超过上限 ${humanSize(bounds.max)}（预期 ${humanSize(bounds.expected)} ± ${humanSize(bounds.tolerance)}）`,
    }
  }
  return { ok: true, known: true, reason: '' }
}

/**
 * 安全闸总入口：已知体积越界 → 拒绝并清掉该链接的半成品。
 * @param {object} options
 * @param {string} options.url 被拒的链接（用于日志）
 * @param {number} [options.bytes] 已知体积（HEAD 或响应头）
 * @param {{min:number,max:number,expected:number,tolerance:number}} options.bounds
 * @param {string} [options.directory] 目标目录（有半成品时用来清理）
 * @param {string} [options.fileName] 目标文件名
 * @param {boolean} [options.allowUnknown] 体积未知时是否放行（默认不放行）
 * @returns {Promise<{ allowed: boolean, reason?: string, cleaned: string[] }>}
 */
export async function enforceInstallerSize(options) {
  const { url, bytes, bounds, directory, fileName, allowUnknown = false } = options
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    if (allowUnknown) return { allowed: true, cleaned: [] }
    return { allowed: false, reason: '拿不到安装包体积，出于安全考虑拒绝这条链接', cleaned: [] }
  }
  const verdict = checkSizeAgainstBounds(bytes, bounds)
  if (verdict.ok) return { allowed: true, cleaned: [] }

  // 越界 → 这条链接整条作废：把 .part 一起删掉，避免下次被当成断点续传的底子。
  const cleaned = []
  if (directory && fileName) {
    const partial = join(directory, `${fileName}.part`)
    try {
      await rm(partial, { force: true })
      cleaned.push(partial)
    } catch {
      /* 清理失败不影响判决 */
    }
  }
  void url
  return { allowed: false, reason: verdict.reason, cleaned }
}
