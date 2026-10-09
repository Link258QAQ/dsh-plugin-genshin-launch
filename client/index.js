// dsh-plugin-genshin-launch —— 浏览器客户端半边（DSH 插件栏里的配置卡）。
//
// 契约（照 DSH 官方 client 插件，参考本机已装的 @eghrhegpe/dsh-connect-qoder 与 gal-view）：
//   * 文件是一个 `window.__ModuleLoader__.load({ id, factory })` 包；
//   * factory 收到 `require`，`react` 由平台的模块表提供（必须与宿主渲染器共用同一个实例，
//     否则 hooks 会炸），所以这里只 `require('react')`，不打包 React 本身；
//   * factory 返回 `{ name, inject, apply }`，客户端内核挂载时调用 `apply(ctx)`；
//   * 插件页的配置卡通过 `plugins.row.config` / `plugins.bundle.config` 插槽注册，
//     key 是 `<包名>#<行 id>`。
//
// 刻意**不做构建**：没有 JSX，全部用 React.createElement，所以这份文件就是最终产物，
// 改完刷新页面即可。代价是写法啰嗦，换来的是"零依赖、零工具链"。
//
// 数据通道：直接打插件自己的 HTTP 路由（/dsh-genshin-launch/*）。这样网页版、独立窗口、
// 插件栏卡片读写的是**同一份**插件配置，不会出现两个真相。
// 唯一的例外是 Electron 桌面端：那里页面来自 file://，跨源打不到我们的 HTTP，此时退化成
// 一张说明卡（真正的配置入口是桌面端自动打开的独立窗口）。
;(() => {
  'use strict'

  window.__ModuleLoader__.load({
    id: 'dsh-plugin-genshin-launch',
    factory: (require) => {
      const React = require('react')
      const h = React.createElement

      const BASE = '/dsh-genshin-launch'

      /** 当前页面的源能不能直接打我们的 HTTP 路由。 */
      const apiBase = (() => {
        try {
          if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin + BASE
        } catch {
          /* 忽略 */
        }
        return undefined
      })()

      let tokenPromise
      function getToken() {
        if (!apiBase) return Promise.resolve('')
        if (!tokenPromise) {
          tokenPromise = fetch(`${apiBase}/token`, { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((data) => (typeof data?.token === 'string' ? data.token : ''))
            .catch(() => '')
        }
        return tokenPromise
      }

      async function call(path, options = {}) {
        if (!apiBase) throw new Error('当前页面不是 HTTP 源，打不到插件路由')
        const token = await getToken()
        const response = await fetch(`${apiBase}${path}`, {
          ...options,
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'x-dsh-genshin-token': token } : {}),
            ...(options.headers ?? {}),
          },
        })
        const data = await response.json().catch(() => undefined)
        if (!response.ok) throw new Error(data?.reason ?? `HTTP ${response.status}`)
        return data
      }

      const S = {
        root: { display: 'flex', flexDirection: 'column', gap: '8px' },
        muted: { opacity: 0.7, fontSize: '12px', wordBreak: 'break-all' },
        faint: { opacity: 0.5, fontSize: '11px', wordBreak: 'break-all' },
        row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      }

      function button(style, extra) {
        return {
          padding: '5px 11px',
          borderRadius: '7px',
          border: '1px solid rgba(246,220,156,.4)',
          background: 'rgba(255,255,255,.07)',
          color: 'inherit',
          font: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
          opacity: 1,
          ...style,
          ...extra,
        }
      }

      /**
       * 插件栏里的配置卡。
       * @param props.view - 'summary' 只要一句话；'page' 渲染完整表单
       */
      function GenshinLaunchConfigCard(props) {
        const view = props && props.view
        const [config, setConfig] = React.useState(undefined)
        const [draft, setDraft] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')
        const [note, setNote] = React.useState('')

        const refresh = React.useCallback(async () => {
          if (!apiBase) return
          try {
            const data = await call('/config')
            setConfig(data.config)
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          }
        }, [])

        React.useEffect(() => {
          void refresh()
        }, [refresh])

        const save = async () => {
          const value = draft.trim()
          if (!value) {
            setError('先填一个路径。')
            return
          }
          setBusy(true)
          setError('')
          setNote('')
          try {
            const isExe = /\.exe$/i.test(value)
            const data = await call('/config', {
              method: 'POST',
              body: JSON.stringify(isExe ? { gameExe: value, gamePath: '' } : { gamePath: value, gameExe: '' }),
            })
            setConfig(data.config)
            setDraft('')
            setNote('已写入。插件会立刻按新路径重新探测。')
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(false)
          }
        }

        const clear = async () => {
          setBusy(true)
          setError('')
          setNote('')
          try {
            const data = await call('/config', { method: 'POST', body: JSON.stringify({ gameExe: '', gamePath: '' }) })
            setConfig(data.config)
            setNote('已清除手填路径。')
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(false)
          }
        }

        const rescan = async () => {
          setBusy(true)
          setError('')
          setNote('')
          try {
            await call('/rescan', { method: 'POST', body: '{}' })
            setNote('已请求重新扫盘 —— 请到面板上确认。')
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(false)
          }
        }

        if (view === 'summary') {
          const path = config?.gameExe || config?.gamePath
          return h('span', null, path ? `原神已配置：${path}` : '零配置探测原神；也可以在这里手填 exe 路径')
        }

        if (!apiBase) {
          return h(
            'div',
            { style: S.root },
            h('div', null, '这个页面不是通过 HTTP 打开的（桌面端走 file://），打不到插件的本地接口。'),
            h('div', { style: S.muted }, '桌面端请用插件自动打开的「原神，启动！」独立窗口来配置；路径请优先用上方输入框填写（保存后按当前用户加密存储）。'),
          )
        }

        const children = []
        children.push(h('div', { key: 'title', style: { fontWeight: 700 } }, '原神游戏路径'))
        children.push(
          h(
            'div',
            { key: 'hint', style: S.muted },
            '留空就零配置自动探测（注册表 → 官方默认路径 → 其他盘 → 经你同意的扫盘）。手填优先级最高。',
          ),
        )

        if (config) {
          if (config.gameExe) children.push(h('div', { key: 'exe', style: S.muted }, `当前手填 exe：${config.gameExe}`))
          else if (config.gamePath) children.push(h('div', { key: 'path', style: S.muted }, `当前手填目录：${config.gamePath}`))
          else children.push(h('div', { key: 'none', style: S.faint }, '当前没有手填路径，走自动探测。'))

          const scanText = config.scanDone
            ? `扫盘状态：已扫过一次（${config.scanAt || '时间未知'}）${config.gameExe ? '，已找到并写入本体地址' : '，没有找到'}`
            : `扫盘状态：${config.scanConsent === 'unset' ? '还没问过' : config.scanConsent}`
          children.push(h('div', { key: 'scan', style: S.faint }, scanText))
          if (config.sizeBaselineBytes) {
            children.push(
              h(
                'div',
                { key: 'baseline', style: S.faint },
                `安装包体积基准：${Math.round(config.sizeBaselineBytes / 1024 / 1024)} MB（${config.sizeBaselineSource === 'learned' ? '上次下载学到的' : '出厂值'}）`,
              ),
            )
          }
          if (config.encryption) {
            children.push(
              h(
                'div',
                { key: 'enc', style: S.faint },
                config.encryption === 'dpapi'
                  ? '存储方式：路径已按当前用户加密（DPAPI）；界面显示均为掩码。'
                  : config.encryption === 'plain'
                    ? '存储方式：本机 DPAPI 不可用，路径暂为明文；界面显示为掩码。'
                    : '存储方式：尚未存储任何路径。',
              ),
            )
          }
        }

        children.push(
          h('input', {
            key: 'input',
            type: 'text',
            spellCheck: false,
            placeholder: '粘贴游戏本体 exe 路径，或它所在的安装目录…',
            value: draft,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void save()
            },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              borderRadius: '7px',
              border: '1px solid rgba(246,220,156,.4)',
              background: 'rgba(0,0,0,.28)',
              color: 'inherit',
              font: 'inherit',
            },
          }),
        )

        children.push(
          h(
            'div',
            { key: 'buttons', style: S.row },
            h('button', { type: 'button', style: button(null, { fontWeight: 700 }), disabled: busy, onClick: () => void save() }, '保存'),
            h('button', { type: 'button', style: button(), disabled: busy, onClick: () => void clear() }, '清除'),
            h('button', { type: 'button', style: button(), disabled: busy, onClick: () => void rescan() }, '再扫一次'),
            h('button', { type: 'button', style: button(), disabled: busy, onClick: () => void refresh() }, '刷新'),
          ),
        )

        if (error) children.push(h('div', { key: 'error', style: { color: '#ffb4a2', fontSize: '12px' } }, error))
        if (note) children.push(h('div', { key: 'note', style: { color: '#ffd9a0', fontSize: '12px' } }, note))
        if (config?.path) children.push(h('div', { key: 'file', style: S.faint }, `配置文件：${config.path}`))

        return h('div', { style: S.root }, children)
      }

      const name = 'genshin-launch-config'
      const inject = ['slots']

      function apply(ctx) {
        // 只在插件页真的需要时注册；register 抛错不影响宿主半侧。
        const registerCard = (slotName, key) => {
          try {
            ctx.slots.inject(slotName, () =>
              ctx.slots.register(
                {
                  name: slotName,
                  key,
                  priority: 30,
                  inject: () => ({}),
                },
                GenshinLaunchConfigCard,
              ),
            )
          } catch (error) {
            console.error(`[genshin-launch] 配置卡插槽 "${slotName}" 注册失败（宿主半侧不受影响）：`, error)
          }
        }
        // 行配置是主入口；顺带注册 bundle 配置，这样在包详情页也能看到同一张卡。
        registerCard('plugins.row.config', 'dsh-plugin-genshin-launch#genshin-launch')
        registerCard('plugins.bundle.config', 'dsh-plugin-genshin-launch')
      }

      return { name, inject, apply }
    },
  })
})()
