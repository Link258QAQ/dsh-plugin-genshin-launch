// 链接解析：把「一个可能过期的直链」变成「一个当前可用的直链」。
//
// 米哈游没有给启动器安装包提供公开的“最新版”接口：游戏包有 hyp-connect API
// （getGamePackages / getGameBranches），但启动器安装包只挂在 CDN 的版本目录下面，
// 目录名是「时间戳_随机 token」，无法推导。实际可用的规律有两个：
//
//   1. 用户手上的直链只要还存在，就继续用（HEAD 校验 200）；
//   2. 同一版本目录下的 `pcbackup<NNN>` 是顺序发布的安装包备份序号，号越大越新
//      （同一个 launcher_setup 版本会同时挂 316/317/318/319/320 多个备份）。
//      所以可以从已知序号向上探测，取还存在的最大的那个。
//
// 探测结果会落盘缓存（默认 7 天），避免每次开 DSH 都发一串 HEAD 请求。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { classifySize } from './size-guard.js'

const PROBE_TIMEOUT_MS = 15_000
const MIN_INSTALLER_BYTES = 1 * 1024 * 1024

/** HEAD 请求一个候选链接，返回可用性与元数据。 */
export async function probeUrl(url, options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, signal, checkType = false, minBytes = MIN_INSTALLER_BYTES } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
    if (!response.ok) return { ok: false, status: response.status, url, reason: `HTTP ${response.status}` }
    const contentType = String(response.headers.get('content-type') ?? '')
    const size = Number(response.headers.get('content-length'))
    if (checkType && contentType && contentType.includes('text/html')) {
      return { ok: false, status: response.status, url, reason: `返回的是网页（${contentType}）而不是安装包` }
    }
    if (Number.isFinite(size) && size > 0 && size < minBytes) {
      return { ok: false, status: response.status, url, reason: `体积只有 ${size} 字节，不像是安装包` }
    }
    return {
      ok: true,
      status: response.status,
      url,
      finalUrl: response.url,
      contentType,
      size: Number.isFinite(size) && size > 0 ? size : undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      acceptRanges: (response.headers.get('accept-ranges') ?? '').includes('bytes'),
    }
  } catch (error) {
    return { ok: false, url, reason: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 展开一个「探测族」：同一版本目录下从 start 向上找还存在的最大的 pcbackup 序号。
 * @param {object} family
 * @param {string} family.base 形如 https://host/..../pcbackup{index}
 * @param {string} family.file 该目录下的文件名
 * @param {number} family.start 起点序号（通常取用户给的链接里的序号）
 */
export async function expandProbeFamily(family, options = {}) {
  const { signal, maxMisses = 3, maxSteps = 40, onNote } = options
  let best = null
  let misses = 0
  for (let step = 0; step <= maxSteps && misses < maxMisses; step += 1) {
    const index = family.start + step
    const url = `${family.base.replace('{index}', String(index))}/${family.file}`
    const probe = await probeUrl(url, { signal })
    if (probe.ok) {
      best = { ...probe, index }
      misses = 0
    } else {
      misses += 1
      if (misses === 1 && step === 0) onNote?.(`起点 pcbackup${index} 已失效（${probe.reason}），继续向上找`)
    }
    if (misses >= maxMisses) break
  }
  return best
}

async function readCache(cacheFile) {
  if (!cacheFile) return undefined
  try {
    const raw = await readFile(cacheFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.url === 'string') return parsed
  } catch {
    /* 没有缓存或缓存坏了都重新探测 */
  }
  return undefined
}

async function writeCache(cacheFile, value) {
  if (!cacheFile) return
  try {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(value, undefined, 2), 'utf8')
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

/**
 * 解析出一个当前可用的安装包链接。
 *
 * 顺序：
 *   1. 缓存（命中且仍 200 就直接用，只花一次 HEAD）；
 *   2. 候选直链（按优先级，第一个 200 的胜出，记为 seed）；
 *   3. 探测族：在「种子的同族」里从 seed 序号向上找更新的安装包，找到就用更新的那个
 *      （这就是「自动找到最新版」的部分：pcbackup 序号只会往上长）。
 *      向上探测失败不影响已拿到的 seed，所以最坏情况就是退化成用户给的那条链接。
 *
 * @param {object} options
 * @param {string[]} options.urls 候选直链（按优先级）
 * @param {Array<{base: string, file: string, start: number}>} [options.probeFamilies] 探测族
 * @param {number} [options.probeAhead] 种子可用时额外向上探测的步数（0 = 只在种子失效时探测）
 * @param {string} [options.cacheFile] 缓存文件路径
 * @param {number} [options.cacheTtlMs] 缓存有效期
 * @param {boolean} [options.useCache] 是否使用缓存
 * @param {number} [options.minBytes] probeUrl 的体积下限（防呆）
 * @param {{min:number,max:number,expected:number,tolerance:number}} [options.sizeBounds]
 *        体积安全闸：最终选定链接的体积必须落在 [min, max] 内，否则整条链接作废
 * @param {AbortSignal} [options.signal]
 * @param {(message: string) => void} [options.onNote]
 * @returns {Promise<{ source: string, url?: string, size?: number, contentType?: string, lastModified?: string, rejected?: Array<object>, tried: Array<object> }>}
 */
export async function resolveInstaller(options) {
  const {
    urls = [],
    probeFamilies = [],
    probeAhead = 1,
    cacheFile,
    cacheTtlMs = 7 * 24 * 3600 * 1000,
    useCache = true,
    minBytes,
    sizeBounds,
    signal,
    onNote,
  } = options

  const tried = []
  const rejected = []
  const head = (url) => probeUrl(url, minBytes ? { signal, minBytes } : { signal })

  /**
   * 体积安全闸（解析期）。
   *
   * 这里只把**连合理范围都不在**的链接整条作废。落在「宽档」（超出严格档但仍在
   * 合理范围内）的候选会**留下来**，并把档位记在结果上交给下载流程去问用户 ——
   * 否则米哈游一改安装包大小，我们就会在解析阶段把它拒掉、永远学不到新大小。
   *
   * @returns {boolean} 是否继续把这个候选当成可用链接
   */
  const passSizeGuard = (candidate) => {
    if (!sizeBounds) return true
    const verdict = classifySize(candidate.size, sizeBounds)
    if (verdict.tier === 'strict' || verdict.tier === 'sanity') return true
    rejected.push({ url: candidate.url, size: candidate.size, reason: verdict.reason })
    onNote?.(`安全校验拒绝整条链接：${verdict.reason} → ${candidate.url}`)
    return false
  }

  /** 记下候选体积落在哪一档，供下载流程决定要不要问用户。 */
  const sizeTierOf = (size) => (sizeBounds ? classifySize(size, sizeBounds).tier : 'strict')

  const build = (source, probe, url) => ({
    source,
    url: probe.finalUrl ?? url,
    size: probe.size,
    sizeTier: sizeTierOf(probe.size),
    contentType: probe.contentType,
    lastModified: probe.lastModified,
    rejected,
    tried,
  })

  if (useCache) {
    const cached = await readCache(cacheFile)
    if (cached && (!cached.checkedAt || Date.now() - cached.checkedAt < cacheTtlMs)) {
      const probe = await head(cached.url)
      if (probe.ok && passSizeGuard({ url: cached.url, size: probe.size })) {
        onNote?.(`沿用缓存链接（${new Date(cached.checkedAt ?? Date.now()).toLocaleString('zh-CN')} 校验过）`)
        return build('cache', probe, cached.url)
      }
      if (probe.ok) onNote?.('缓存链接被安全校验拒绝，重新探测')
      else onNote?.(`缓存链接已失效（${probe.reason}），重新探测`)
    }
  }

  // 第 2 步：候选直链
  let seed
  for (const url of urls) {
    const probe = await head(url)
    tried.push({ url, ok: probe.ok, reason: probe.reason })
    if (!probe.ok) {
      onNote?.(`候选不可用（${probe.reason}）：${url}`)
      continue
    }
    if (!passSizeGuard({ url, size: probe.size })) continue
    seed = { url: probe.finalUrl ?? url, probe }
    onNote?.(`直链可用：${seed.url}`)
    break
  }
  if (seed) {
    if (probeAhead > 0 && probeFamilies.length) {
      // 第 3 步（a）：种子可用，仍向上看 probeAhead 步，能拿到更新的版本就用它
      for (const family of probeFamilies) {
        const newer = await expandProbeFamily(family, { signal, maxSteps: probeAhead, maxMisses: probeAhead + 1, onNote })
        if (newer && newer.index > family.start && passSizeGuard({ url: newer.url, size: newer.size })) {
          const resolved = build(`probe:pcbackup${newer.index}`, newer, newer.url)
          await writeCache(cacheFile, { url: resolved.url, checkedAt: Date.now(), size: resolved.size })
          onNote?.(`发现更新一档的安装包：pcbackup${family.start} → pcbackup${newer.index}`)
          return resolved
        }
      }
    }
    const resolved = build('url', seed.probe, seed.url)
    await writeCache(cacheFile, { url: resolved.url, checkedAt: Date.now(), size: resolved.size })
    return resolved
  }

  // 第 3 步（b）：候选全都失效，向上一直找还存在的最大的序号
  for (const family of probeFamilies) {
    onNote?.(`候选全部失效，开始向上探测（从 pcbackup${family.start} 开始）`)
    const found = await expandProbeFamily(family, { signal, onNote })
    if (found) {
      if (!passSizeGuard({ url: found.url, size: found.size })) continue
      tried.push({ url: found.url, ok: true, reason: `pcbackup${found.index}` })
      const resolved = build(`probe:pcbackup${found.index}`, found, found.url)
      await writeCache(cacheFile, { url: resolved.url, checkedAt: Date.now(), size: resolved.size })
      onNote?.(`找到可用的安装包：pcbackup${found.index}（${found.url}）`)
      return resolved
    }
    onNote?.('探测族里没有找到可用安装包')
  }

  return { source: 'none', url: undefined, rejected, tried }
}

/** 把候选 URL 里的版本号提出来，做「同族」判断（仅用于日志提示）。 */
export function describeCandidate(url) {
  const match = /\/pcbackup(\d+)\//i.exec(url ?? '')
  return match ? `pcbackup${match[1]}` : '直链'
}
