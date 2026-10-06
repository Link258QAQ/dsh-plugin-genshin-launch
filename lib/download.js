// 下载器：支持断点续传（HTTP Range）、重定向、进度回调、取消。
// 只依赖 Node 标准库（Node >= 20，自带 fetch/undici）。
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** 人类可读的字节数（保留精确字节数，方便核对体积边界）。 */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)
  return `${shown} ${units[unit]}（${bytes} 字节）`
}

/** 从 URL 里取一个安全的文件名（去掉查询串）。 */
export function fileNameFromUrl(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    const name = basename(path)
    // 真安装包：直接用它自己的名字（例如 yuanshen_setup_20260817.exe）
    if (name && name !== '/' && /\.[a-z0-9]{2,5}$/i.test(name)) return name
  } catch {
    /* 忽略：交给下面的兜底 */
  }
  // 直链没有文件名（例如 .../download?id=1）：用启动器安装包的默认名
  return 'yuanshen_setup.exe'
}

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : -1
  } catch {
    return -1
  }
}

/**
 * 下载一个直链到目标目录，支持续传。
 * @param {object} options
 * @param {string} options.url 直链
 * @param {string} options.directory 目标目录
 * @param {string} [options.fileName] 目标文件名（默认按 URL 推导）
 * @param {string} [options.expectedSize] 预期总大小（来自 HEAD），用于完成校验
 * @param {boolean} [options.resume] 是否续传，默认 true
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {(progress: object) => void} [options.onProgress] 进度回调
 * @returns {Promise<{ path: string, fileName: string, size: number, resumedFrom: number, done: boolean }>}
 */
export async function downloadToFile(options) {
  const {
    url,
    directory,
    fileName = fileNameFromUrl(url),
    expectedSize,
    resume = true,
    signal,
    onProgress,
  } = options

  await mkdir(directory, { recursive: true })
  const target = join(directory, fileName)
  const partial = `${target}.part`

  let offset = 0
  if (resume) {
    const partSize = await fileSize(partial)
    const targetSize = await fileSize(target)
    if (targetSize >= 0 && (expectedSize === undefined || targetSize === expectedSize)) {
      // 目标文件已存在且大小对得上：本轮视作已完成，不再重复下载。
      return { path: target, fileName, size: targetSize, resumedFrom: 0, done: true }
    }
    if (partSize > 0) offset = partSize
  } else {
    await rm(partial, { force: true })
  }

  const sendRange = offset > 0
  if (expectedSize !== undefined && sendRange && offset >= expectedSize) {
    // 半成品已经比预期还大：说明预期变了，重下。
    await rm(partial, { force: true })
    offset = 0
  }

  /** @type {Response} */
  let response
  try {
    response = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: sendRange ? { Range: `bytes=${offset}-` } : undefined,
    })
  } catch (error) {
    throw new Error(`请求失败：${error?.message ?? error}`)
  }

  if (response.status === 416 && offset > 0) {
    // 服务端认为我们请求的范围越界：半成品其实已经完整。
    await rename(partial, target).catch(async () => {
      /* 目标已存在等情况忽略 */
    })
    const size = await fileSize(target)
    return { path: target, fileName, size: size < 0 ? offset : size, resumedFrom: 0, done: true }
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  let start = offset
  if (sendRange && response.status === 206) {
    const contentRange = response.headers.get('content-range')
    const match = contentRange ? /bytes\s+(\d+)-/i.exec(contentRange) : null
    if (match) start = Number(match[1])
  } else if (response.status === 200) {
    // 服务端不支持 Range：从头重下。
    start = 0
    await rm(partial, { force: true })
  }

  const lenHeader = Number(response.headers.get('content-length'))
  const knownLength = Number.isFinite(lenHeader) && lenHeader > 0 ? lenHeader : undefined
  const total = knownLength !== undefined ? start + knownLength : expectedSize
  // 从 0 开始、且服务端给了长度时，这个长度就是权威的大小；expectedSize 只作兜底。
  const authoritativeSize = start === 0 && knownLength !== undefined ? knownLength : undefined

  const file = createWriteStream(partial, { flags: start > 0 ? 'r+' : 'w', start })
  const reader = response.body?.getReader()
  if (!reader) {
    file.destroy()
    throw new Error('响应没有可读的 body')
  }

  // 写流自身出错（磁盘满、权限被拒、路径不可写……）必须被 await 到，
  // 否则会变成未处理的 'error' 事件直接把宿主进程打挂。
  let streamError
  const ended = new Promise((resolve, reject) => {
    file.on('error', (error) => {
      streamError = error
      reader.cancel(error).catch(() => {})
      reject(error)
    })
    file.on('finish', resolve)
  })
  ended.catch(() => {})

  let written = start
  let lastReport = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < 1000) return
    lastReport = now
    onProgress?.({ downloaded: written, total, offset: start, percent: total ? Math.min(100, (written / total) * 100) : undefined })
  }
  report(true)

  try {
    for (;;) {
      if (streamError) throw streamError
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength) {
        written += value.byteLength
        if (!file.write(Buffer.from(value))) {
          await new Promise((resolve) => file.once('drain', resolve))
        }
        report()
      }
    }
    file.end()
    await ended
  } catch (error) {
    file.destroy()
    throw error
  }

  if (authoritativeSize !== undefined && written !== authoritativeSize) {
    throw new Error(`大小校验失败：服务端声明 ${authoritativeSize} 字节，实际收到 ${written} 字节`)
  }
  if (total !== undefined && expectedSize !== undefined && written !== total && written !== expectedSize) {
    throw new Error(`大小校验失败：期望 ${total} 字节，实际 ${written} 字节`)
  }

  await rename(partial, target)
  report(true)
  return { path: target, fileName, size: written, resumedFrom: start, done: false }
}

/** 删除残缺文件（下载彻底失败时保留 .part 反而更好用，这里只在需要时调用）。 */
export async function discardPartial(path) {
  if (!path) return
  await rm(`${path}.part`, { force: true }).catch(() => {})
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
}
