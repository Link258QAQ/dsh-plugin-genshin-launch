// 宿主侧问答通道：插件要问用户一句话，用户在面板（或独立窗口）上点一个按钮。
//
// 为什么需要它：有几件事**必须有人的判断**才能继续——
//   * 要不要扫盘（扫盘会遍历磁盘目录名，得先讲清楚再问）；
//   * 发现一个比已知版本大不少的安装包，要不要信任并更新体积基准。
// 这类问题不能默认"答应"（那是替用户做危险决定），也不能默认"拒绝"到没有任何出路
// （那是功能坏死）。所以做法是：挂一个问题出去、等回答、超时按最保守的那个选项收场。
//
// 同一时刻只允许一个问题（我们的流程本来就是串行的）；新的问题到来时旧问题按其
// defaultOption 收场，不会有两个弹窗互相盖住。
import { randomBytes } from 'node:crypto'

/** 默认超时：够人看一眼，又不至于让流程永远悬着。 */
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {(message: string) => void} [options.onNote]
 */
export function createQuestionHub(options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, onNote } = options
  let pending
  let counter = 0

  const settle = (id, optionId, reason) => {
    if (!pending || pending.id !== id) return false
    const current = pending
    pending = undefined
    if (current.timer) clearTimeout(current.timer)
    onNote?.(`问题 ${current.kind} → ${optionId}（${reason}）`)
    current.resolve(optionId)
    return true
  }

  return {
    /** 面板要渲染的那个问题（没有就是 undefined）。 */
    view() {
      if (!pending) return undefined
      return {
        id: pending.id,
        kind: pending.kind,
        title: pending.title,
        lines: pending.lines,
        options: pending.options,
        askedAt: pending.askedAt,
        expiresAt: pending.expiresAt,
      }
    },

    /**
     * 问一个问题并等回答。
     * @param {object} spec
     * @param {string} spec.kind 机器可读的种类（客户端据此决定特殊行为，比如打开快速配置）
     * @param {string} spec.title
     * @param {string[]} [spec.lines]
     * @param {Array<{id: string, label: string, tone?: 'primary'|'danger'|'plain'}>} spec.options
     * @param {string} spec.defaultOption 超时/被顶掉时用的选项（务必选最保守的那个）
     * @param {number} [spec.timeoutMs]
     * @returns {Promise<string>} 被选中的选项 id
     */
    ask(spec) {
      const id = `q${++counter}-${randomBytes(4).toString('hex')}`
      const waitMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs >= 0 ? spec.timeoutMs : timeoutMs

      // 顶掉上一个：它自己的 defaultOption 就是它的下场。
      if (pending) settle(pending.id, pending.defaultOption, '被新问题顶掉')

      return new Promise((resolve) => {
        const askedAt = Date.now()
        pending = {
          id,
          kind: spec.kind,
          title: spec.title,
          lines: Array.isArray(spec.lines) ? spec.lines.filter((line) => typeof line === 'string') : [],
          options: Array.isArray(spec.options) ? spec.options : [],
          defaultOption: spec.defaultOption,
          resolve,
          askedAt,
          expiresAt: waitMs > 0 ? askedAt + waitMs : undefined,
          timer: undefined,
        }
        onNote?.(`提问 ${spec.kind}：${spec.title}`)

        if (waitMs > 0) {
          // 刻意**不** unref：这个计时器必须真的会响。宿主退出时由 cancelAll 负责清掉它
          //（插件卸载的 effect 里会调），所以不会拖着进程不放。
          pending.timer = setTimeout(() => {
            settle(id, spec.defaultOption, `${Math.round(waitMs / 1000)} 秒没人回答，按最保守的选项收场`)
          }, waitMs)
        }
      })
    },

    /**
     * 面板回了答案。
     * @returns {boolean} 是否匹配到一个在等的问题（不匹配就是过期/伪造，直接忽略）
     */
    answer(id, optionId) {
      if (!pending || pending.id !== id) return false
      if (!pending.options.some((option) => option.id === optionId)) return false
      return settle(id, optionId, '用户选择')
    },

    /** 收尾：插件被卸载时把所有还挂着的问题放掉。 */
    cancelAll(reason = '插件已卸载') {
      if (pending) settle(pending.id, pending.defaultOption, reason)
    },
  }
}
