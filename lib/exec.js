// 子进程执行 + 输出捕获。
//
// 为什么不用管道：DSH 在受限沙箱里运行时，子进程无法打开命名管道（EPERM）。
// 插件本身跑在 DSH 宿主进程里通常不受影响，但自检脚本、以及任何受限运行环境都会
// 踩到这个坑。所以统一改成「stdout 重定向到临时文件，跑完再读回」——顺带也避免了
// 管道背压把大输出卡死（`reg query /s` 一次能有几百 KB）。
//
// 只做两件事：跑一条命令、把 stdout 拿回来。不做 shell 解析、不做重试。
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let counter = 0

/**
 * 跑一条命令并捕获它的 stdout。
 *
 * @param {string} command 可执行文件（可执行文件名走 PATH）
 * @param {string[]} args argv 数组；永远不拼 shell 字符串
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 超时（到点杀进程，status 记为 null）
 * @param {string} [options.cwd] 工作目录
 * @param {Record<string,string>} [options.env] 环境变量（默认继承）
 * @param {boolean} [options.windowsVerbatimArguments] 原样传参（只给 cmd /c 的整串命令用）
 * @param {'utf8'|'buffer'} [options.decode] 解码方式；utf8 是默认
 * @returns {Promise<{status: number|null, stdout: string, buffer: Buffer, error?: string, timedOut: boolean}>}
 */
export function runCaptured(command, args, options = {}) {
  const { timeoutMs = 15_000, cwd, env, windowsVerbatimArguments = false, decode = 'utf8' } = options
  const captureFile = join(tmpdir(), `dsh-genshin-launch-${process.pid}-${counter++}.out`)

  return new Promise((resolve) => {
    let fd
    try {
      fd = openSync(captureFile, 'w')
    } catch (error) {
      // 临时目录都写不了：退化成「跑命令但拿不到输出」，至少别把宿主搞挂。
      try {
        const child = spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments })
        child.on('error', (spawnError) => resolve({ status: null, stdout: '', buffer: Buffer.alloc(0), error: spawnError.message, timedOut: false }))
        child.on('close', (status) => resolve({ status, stdout: '', buffer: Buffer.alloc(0), error: error.message, timedOut: false }))
      } catch (spawnError) {
        resolve({ status: null, stdout: '', buffer: Buffer.alloc(0), error: spawnError?.message ?? String(spawnError), timedOut: false })
      }
      return
    }

    let child
    let timedOut = false
    let settled = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        try {
          child?.kill()
        } catch {
          /* 进程可能已经没了 */
        }
      }, timeoutMs)
      : undefined

    const finish = (extra) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
      let buffer = Buffer.alloc(0)
      try {
        buffer = readFileSync(captureFile)
      } catch {
        /* 文件没生成就是空输出 */
      }
      try {
        unlinkSync(captureFile)
      } catch {
        /* 忽略 */
      }
      resolve({
        status: extra.status,
        stdout: decode === 'buffer' ? '' : buffer.toString('utf8'),
        buffer,
        error: extra.error,
        timedOut,
      })
    }

    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments,
        stdio: ['ignore', fd, 'ignore'],
      })
    } catch (error) {
      finish({ status: null, error: error?.message ?? String(error) })
      return
    }

    child.on('error', (error) => finish({ status: null, error: error?.message ?? String(error) }))
    child.on('close', (status) => finish({ status, error: status === 0 ? undefined : `退出码 ${status}` }))
  })
}
