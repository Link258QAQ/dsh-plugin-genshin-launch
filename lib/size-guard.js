// 安装包体积安全闸。
//
// 背景：启动器安装包（yuanshen_setup_*.exe）是几十 MB 到二百多 MB 的桌面安装器，
// 换游戏版本时体积不会大改。所以一旦拿到的文件与预期体积相差太多，就认为这条链接
// 已经不可信（被替换成网页 / 广告安装器 / 别的什么东西）。
//
// 但闸门不能一味收紧，否则会把自己锁死：如果闸门是「基准 ± 15MB」，而米哈游把安装包
// 从 224MB 改成 240MB，那么新包**在下载前就会被拒**，我们永远下载不到它、也就永远
// 学不到新的大小 —— 功能永久卡死。所以这里用**两档**：
//
//   严格档：基准 ± strictTolerance（默认 15MB）
//           → 直接在区间内，静默下载；下载成功后把基准更新成真实字节数。
//   宽档：  [sanityMin, sanityMax]（默认 100MB ~ 400MB）且**域名是官方 CDN**
//           → 不自己拍板，交给用户回答「信任并更新基准 / 拒绝」。
//   档外：  直接拒绝（体积离谱，连问都不值得问）。
//
// 落盘复检的基准与严格档同步：下载成功那一刻就把基准换成真实字节数，所以复检用的
// 是**最新**基准，而不是出厂那个 224MB。
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { humanSize } from './download.js'

/** 国服启动器安装包的出厂基准（2026-08-17 那版是 234,382,248 字节 ≈ 224 MiB）。 */
export const DEFAULT_EXPECTED_BYTES = 224 * 1024 * 1024

/** 默认严格档容差：±15 MiB。 */
export const DEFAULT_TOLERANCE_BYTES = 15 * 1024 * 1024

/** 宽档下限 / 上限：一个桌面游戏启动器不可能小于 100MB，也不可能大于 400MB。 */
export const DEFAULT_SANITY_MIN_BYTES = 100 * 1024 * 1024
export const DEFAULT_SANITY_MAX_BYTES = 400 * 1024 * 1024

/** 官方下载域名后缀。宽档只在官方域名上才允许「问用户」。 */
export const OFFICIAL_HOST_SUFFIXES = [
  '.yuanshen.com',
  '.mihoyo.com',
  '.hoyoverse.com',
  '.hoyolab.com',
]

/**
 * 依据配置与「当前基准」算出允许的体积区间。
 *
 * 基准的优先级：调用方传入的 `baselineBytes`（通常来自落盘的、下载成功后自更新的那个）
 * 优先于配置里的 `expectedInstallerBytes`，再退到出厂值。想手动锁死就把
 * `autoUpdateSizeBaseline` 关掉并显式配 `expectedInstallerBytes`。
 *
 * @param {object} config
 * @param {number} [config.expectedInstallerBytes]
 * @param {number} [config.sizeToleranceBytes]
 * @param {number} [config.minInstallerBytes]
 * @param {number} [config.maxInstallerBytes]
 * @param {object} [options]
 * @param {number} [options.baselineBytes] 学习到的基准（0 / undefined = 用配置或出厂值）
 * @returns {{min:number,max:number,expected:number,tolerance:number,sanityMin:number,sanityMax:number}}
 */
export function sizeBounds(config = {}, options = {}) {
  const configured = Number(config.expectedInstallerBytes) > 0 ? Number(config.expectedInstallerBytes) : 0
  const learned = Number(options.baselineBytes) > 0 ? Number(options.baselineBytes) : 0
  const expected = learned > 0 ? learned : configured > 0 ? configured : DEFAULT_EXPECTED_BYTES

  const tolerance = Number(config.sizeToleranceBytes) >= 0 ? Number(config.sizeToleranceBytes) : DEFAULT_TOLERANCE_BYTES
  const min = Number(config.minInstallerBytes) > 0 ? Number(config.minInstallerBytes) : Math.max(1, expected - tolerance)
  const max = Number(config.maxInstallerBytes) > 0 ? Number(config.maxInstallerBytes) : expected + tolerance

  const sanityMin = Number(config.sanityMinInstallerBytes) > 0 ? Number(config.sanityMinInstallerBytes) : DEFAULT_SANITY_MIN_BYTES
  const sanityMax = Number(config.sanityMaxInstallerBytes) > 0 ? Number(config.sanityMaxInstallerBytes) : DEFAULT_SANITY_MAX_BYTES

  return { min, max, expected, tolerance, sanityMin, sanityMax }
}

/**
 * 这个 URL 的域名是不是官方下载站（决定宽档能不能"问用户"）。
 * @param {string} url
 * @returns {boolean}
 */
export function isOfficialHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return OFFICIAL_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
  } catch {
    return false
  }
}

/** 只判断体积落在哪一档（不读磁盘）。 */
export function classifySize(bytes, bounds) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return { tier: 'unknown', reason: '拿不到安装包体积' }
  }
  if (bytes >= bounds.min && bytes <= bounds.max) return { tier: 'strict', reason: '' }
  if (bytes >= bounds.sanityMin && bytes <= bounds.sanityMax) {
    return {
      tier: 'sanity',
      reason: `体积 ${humanSize(bytes)} 超出严格档 ${humanSize(bounds.min)} ~ ${humanSize(bounds.max)}，但仍在合理范围 ${humanSize(bounds.sanityMin)} ~ ${humanSize(bounds.sanityMax)} 内`,
    }
  }
  return {
    tier: 'reject',
    reason: `体积 ${humanSize(bytes)} 连合理范围 ${humanSize(bounds.sanityMin)} ~ ${humanSize(bounds.sanityMax)} 都不在`,
  }
}

/**
 * 兼容旧接口：只做「在不在严格档内」的布尔判断。
 * @deprecated 新代码用 {@link classifySize}
 */
export function checkSizeAgainstBounds(bytes, bounds) {
  const verdict = classifySize(bytes, bounds)
  if (verdict.tier === 'unknown') return { ok: false, known: false, reason: '拿不到体积，无法通过安全校验' }
  if (verdict.tier === 'strict') return { ok: true, known: true, reason: '' }
  return { ok: false, known: true, reason: verdict.reason }
}

/**
 * 安全闸总入口：体积不合格就清掉该链接的半成品。
 *
 * @param {object} options
 * @param {string} options.url 被裁决的链接（用于判断是否官方域名）
 * @param {number} [options.bytes] 已知体积
 * @param {object} options.bounds
 * @param {string} [options.directory] 目标目录（有半成品时用来清理）
 * @param {string} [options.fileName] 目标文件名
 * @param {boolean} [options.allowUnknown] 体积未知时是否放行（默认不放行）
 * @param {boolean} [options.allowSanity] 宽档是否算通过（默认**不**算：宽档要用户点头）
 * @returns {Promise<{allowed: boolean, tier: string, reason?: string, cleaned: string[]}>}
 */
export async function enforceInstallerSize(options) {
  const { url, bytes, bounds, directory, fileName, allowUnknown = false, allowSanity = false } = options
  const verdict = classifySize(bytes, bounds)

  if (verdict.tier === 'unknown') {
    if (allowUnknown) return { allowed: true, tier: 'unknown', cleaned: [] }
    return { allowed: false, tier: 'unknown', reason: '拿不到安装包体积，出于安全考虑拒绝这条链接', cleaned: [] }
  }
  if (verdict.tier === 'strict') return { allowed: true, tier: 'strict', cleaned: [] }
  // 宽档只有调用方明确放行才通过（正常路径是先去问用户，用户同意后才带着 allowSanity 再调一次）
  if (verdict.tier === 'sanity' && allowSanity && isOfficialHost(url)) return { allowed: true, tier: 'sanity', cleaned: [] }

  // 不放行 → 这条链接整条作废：把 .part 一起删掉，避免下次被当成断点续传的底子。
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
  return { allowed: false, tier: verdict.tier, reason: verdict.reason, cleaned }
}
