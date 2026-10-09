// 插件自有的配置与状态存储。
//
// 为什么不用 DSH 自己的插件配置（cordis.patch.yml）：
//  * 独立窗口里跑的是**普通浏览器页面**（Edge/Chrome --app=），它拿不到 DSH 客户端的
//    settings 服务，只能用 HTTP 打我们这个插件的路由。所以配置的读与写都必须走我们
//    自己的通道，两边才共用一个真相。
//  * 写回 cordis.patch.yml 会触发 patchReload: live 把插件热重载一遍，对一个"记一下
//    路径"的需求来说太重了。
//
// **隐私纪律（v2 起）**：
//  * 内存里（get/snapshot/patch）用的都是明文路径——功能代码要直接能用。
//  * **落盘**时把 `gameExe` + `gamePath` 打包成一个 secrets blob 用 DPAPI（当前用户）
//    加密；除此之外**不落任何路径**（扫盘结果只写进 gameExe，不再有单独的 scanFoundExe）。
//  * DPAPI 不可用时降级明文，并在文件里标 `encryption: "plain"`，让面板/自检看得见。
//  * 老版本（v1）的明文文件会被自动迁移成 v2 加密格式；迁移时顺手丢掉冗余字段。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { protect, unprotect } from './privacy.js'

/** 当前配置文件的格式版本。以后改结构时靠它做迁移。 */
export const STORE_VERSION = 2

/** 体积安全闸出厂基准：国服启动器安装包实测约 224 MiB。 */
export const FACTORY_SIZE_BASELINE = 224 * 1024 * 1024

/** 出厂默认值（内存态，路径为明文）。 */
export function defaultStore() {
  return {
    version: STORE_VERSION,
    /** 用户手填（或扫盘命中自动写入）的游戏本体 exe 全路径——唯一必须保留的本体地址。 */
    gameExe: '',
    /** 用户手填的安装目录。 */
    gamePath: '',
    /**
     * 扫盘同意：unset = 还没问过；allowed = 同意（可以扫一次）；
     * denied = 拒绝（永不再扫）；manual = 用户选了"我自己填路径"（也永不再问）。
     */
    scanConsent: 'unset',
    /** 是否已经扫过一次盘（用户的规则：只扫一次，永远记住）。 */
    scanDone: false,
    /** 上一次扫盘的时间（只留时间，不留结果路径——结果已经在 gameExe 里了）。 */
    scanAt: '',
    /** 体积基准：下载成功后会被覆盖成实际字节数。 */
    sizeBaselineBytes: 0,
    sizeBaselineAt: '',
    sizeBaselineUrl: '',
    updatedAt: '',
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function asPositiveNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

/**
 * 把外来的（可能是手改坏的）对象规整成一份能用的配置。
 * 未知字段一律丢掉——这同时就是"迁移清洗"：老文件里的 scanFoundExe 之类
 * 在写回时自然消失。
 */
export function normalizeStore(raw) {
  const base = defaultStore()
  if (!raw || typeof raw !== 'object') return base
  return {
    version: STORE_VERSION,
    gameExe: asString(raw.gameExe).trim(),
    gamePath: asString(raw.gamePath).trim(),
    scanConsent: ['unset', 'allowed', 'denied', 'manual'].includes(raw.scanConsent) ? raw.scanConsent : 'unset',
    scanDone: asBool(raw.scanDone),
    scanAt: asString(raw.scanAt),
    sizeBaselineBytes: asPositiveNumber(raw.sizeBaselineBytes, 0),
    sizeBaselineAt: asString(raw.sizeBaselineAt),
    sizeBaselineUrl: asString(raw.sizeBaselineUrl),
    updatedAt: asString(raw.updatedAt),
  }
}

/**
 * 把盘上的 JSON 还原成内存态（明文路径）。
 * 兼容两种落盘形状：v1（gameExe/gamePath 明文）与 v2（secrets 加密）。
 * @param {object} parsed
 * @param {(message: string) => void} [onNote]
 * @returns {{ value: object, encryption: 'dpapi' | 'plain' | 'none', reason: string, needsMigration: boolean }}
 */
function decodeStored(parsed, onNote) {
  if (!parsed || typeof parsed !== 'object') {
    return { value: defaultStore(), encryption: 'none', reason: '', needsMigration: false }
  }
  const publicPart = { ...parsed }
  delete publicPart.secrets
  delete publicPart.encryption
  delete publicPart.version

  if (typeof parsed.secrets === 'string' && parsed.secrets) {
    const opened = unprotect(parsed.secrets)
    if (!opened.ok) {
      // 密文解不开（换了用户 / DPAPI 被策略锁了）：路径当"没配置"处理，
      // 让探测重新走一遍——**绝不**把解不开的密文继续留在内存里乱用。
      onNote?.('配置文件里的加密路径解不开，将按零配置重新探测（必要时重填路径）')
      return {
        value: normalizeStore({ ...publicPart, gameExe: '', gamePath: '' }),
        encryption: parsed.encryption === 'plain' ? 'plain' : 'dpapi',
        reason: opened.reason ?? '解密失败',
        needsMigration: true,
      }
    }
    let secrets = {}
    try {
      secrets = JSON.parse(opened.value)
    } catch {
      secrets = {}
    }
    return {
      value: normalizeStore({ ...publicPart, gameExe: secrets?.gameExe, gamePath: secrets?.gamePath }),
      encryption: 'dpapi',
      reason: '',
      needsMigration: false,
    }
  }

  // v1 / 明文：gameExe/gamePath 直接是明文；scanFoundExe 只在 gameExe 为空时补位
  //（老语义：扫盘命中会同时写两者），其余冗余字段丢掉。
  const legacy = normalizeStore(parsed)
  if (!legacy.gameExe && typeof parsed.scanFoundExe === 'string' && parsed.scanFoundExe.trim()) {
    legacy.gameExe = parsed.scanFoundExe.trim()
  }
  const hadPlaintextPath = Boolean(legacy.gameExe || legacy.gamePath)
  return {
    value: legacy,
    encryption: hadPlaintextPath ? 'plain' : 'none',
    reason: '',
    needsMigration: hasStoredPaths(parsed) || hadPlaintextPath,
  }
}

/** 盘上是不是留下了任何明文路径字段（老格式的特征）。 */
function hasStoredPaths(parsed) {
  const suspicious = ['scanFoundExe', 'launcherPath', 'installDir', 'gameDir', 'desktop', 'stateDir', 'configPath', 'filePath']
  return suspicious.some((key) => typeof parsed?.[key] === 'string' && parsed[key].trim())
}

/**
 * 打开（或新建）配置文件。
 *
 * @param {string} file 配置文件全路径
 * @param {object} [options]
 * @param {(message: string) => void} [options.onNote]
 * @returns {{
 *   path: string,
 *   get: () => object,
 *   snapshot: () => object,
 *   patch: (changes: object) => object,
 *   replace: (next: object) => object,
 *   security: () => { encryption: string, reason: string },
 * }}
 */
export function openStore(file, options = {}) {
  const onNote = typeof options.onNote === 'function' ? options.onNote : () => {}
  let value = defaultStore()
  let encryption = 'none'
  let reason = ''
  let needsMigration = false

  if (existsSync(file)) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // 文件坏了：不覆盖它，只是这一次按出厂值跑（下次 patch 才会重写）。
      parsed = undefined
    }
    if (parsed) {
      const decoded = decodeStored(parsed, onNote)
      value = decoded.value
      encryption = decoded.encryption
      reason = decoded.reason
      needsMigration = decoded.needsMigration
    }
  }

  /** 把内存态序列化到盘上：路径进 secrets 加密，别的一律不落。 */
  const write = () => {
    value.updatedAt = new Date().toISOString()
    const secretJson = JSON.stringify({ gameExe: value.gameExe, gamePath: value.gamePath })
    let secrets = ''
    if (value.gameExe || value.gamePath) {
      const sealed = protect(secretJson)
      secrets = sealed.value
      encryption = sealed.encrypted ? 'dpapi' : 'plain'
      reason = sealed.reason ?? ''
      if (!sealed.encrypted) onNote?.(`本机 DPAPI 不可用，路径已降级为明文存储：${sealed.reason}`)
    } else {
      encryption = 'none'
    }
    const payload = {
      version: STORE_VERSION,
      encryption,
      secrets,
      scanConsent: value.scanConsent,
      scanDone: value.scanDone,
      scanAt: value.scanAt,
      sizeBaselineBytes: value.sizeBaselineBytes,
      sizeBaselineAt: value.sizeBaselineAt,
      sizeBaselineUrl: value.sizeBaselineUrl,
      updatedAt: value.updatedAt,
    }
    try {
      writeFileSync(file, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
      needsMigration = false
    } catch {
      // 状态目录不可写时不影响主流程：内存里那份仍然是有效的。
    }
    return value
  }

  // 读到一个含明文路径/冗余字段的老配置 → 立刻升级成加密格式写回（用户无感）。
  if (needsMigration && existsSync(file)) write()

  return {
    path: file,
    get: () => value,
    snapshot: () => ({ ...value }),
    patch(changes) {
      value = normalizeStore({ ...value, ...(changes ?? {}), version: STORE_VERSION })
      return write()
    },
    replace(next) {
      value = normalizeStore(next)
      return write()
    },
    security: () => ({ encryption, reason }),
  }
}

/** 当前生效的体积基准：优先用落盘的（下载成功后自更新的那个），否则用出厂值。 */
export function resolveSizeBaseline(store) {
  const stored = asPositiveNumber(store?.sizeBaselineBytes, 0)
  if (stored > 0) return { bytes: stored, source: 'learned', at: store.sizeBaselineAt, url: store.sizeBaselineUrl }
  return { bytes: FACTORY_SIZE_BASELINE, source: 'factory', at: '', url: '' }
}
