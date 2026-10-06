# dsh-plugin-genshin-launch

> **原神，启动！** —— 给 DeepSeek Harness（DSH）装一个插件：**每次启动 DSH，先识别自己的端口，再把《原神》启动器安装包下载到桌面**；下载不成（链接失效 / 目录不可写 / 体积可疑）就退化成**打开官方下载页**。

一句话简介（可直接用作 GitHub 仓库 About）：

> DSH 插件：启动 DSH 时识别端口，并把《原神》启动器安装包下载到桌面，带 224MB 体积安全闸，下载失败自动改为打开官方下载页。

```
╔══════════════════════════════════════════════════════════╗
║  原神，启动！                                            ║
╚══════════════════════════════════════════════════════════╝
[genshin-launch] 识别到 DSH 端口：3080（http://127.0.0.1:3080）
[genshin-launch] 安装包目标目录：C:\Users\你\Desktop
[genshin-launch] 体积安全闸：只接受 174 MB ~ 274 MB（预期 224 MB ± 50.0 MB）
[genshin-launch] 直链可用：https://autopatchcn.yuanshen.com/.../pcbackup319/yuanshen_setup_20260817.exe
[genshin-launch] 发现更新一档的安装包：pcbackup319 → pcbackup320
[genshin-launch] 安装包链接：https://autopatchcn.yuanshen.com/.../pcbackup320/yuanshen_setup_20260817.exe
[genshin-launch] 安装包大小：223.5 MB（234381736 字节）
[genshin-launch] 下载完成：223.5 MB（234381736 字节），用时 15s
[genshin-launch] 文件位置：C:\Users\你\Desktop\yuanshen_setup_20260817.exe
```

网页右下角还有一个金边小面板，实时显示「原神，启动！ + DSH 端口 + 下载进度 + 被安全闸拒了几条链接」。

---

## 特性

- **端口识别**：注入宿主 `webServer` 服务读 `host/port`，`--port 0` 由系统分配端口也能拿到；`DSH_WEB_URL` 兜底。
- **自动找最新版**：候选直链可用时，还会在同一版本目录里向上探测更新的 `pcbackup` 序号（实测 319 → 320）。
- **体积安全闸（重点）**：启动器安装包约 224 MiB，换版本不会大改。凡是体积与预期**相差超过 50 MiB** 的链接——不管它来自候选、缓存还是探测——都会被**整条拒绝**：不下载、不续传，连已经下了一半的 `.part` 一起删掉。体积拿不到也默认拒绝。
- **断点续传**：HTTP `Range`，网络抖动重开一次 DSH 会接着下，不会重头再来。
- **落盘后复检**：下载完成再核一次体积，不在区间内就把文件删掉，绝不留一个可疑安装器给你双击。
- **优雅退化**：目标目录不可写 → 改到工作区目录 + 打开资源管理器；没有可用链接 / 下载失败 → 打开官方下载页。
- **已装就跳过**：本机检测到原神（`YuanShen.exe` / `GenshinImpact.exe`）时直接跳过 224MB 下载。
- **零依赖**：只用 Node 内置模块（`node:fs` / `node:http` / 内置 `fetch`），不需要编译，改代码即生效。

## 安装

从 GitHub 直接装（推荐，可固定版本）：

```powershell
dsh plugin --profile web add github:Link258QAQ/dsh-plugin-genshin-launch
# 固定到某个 tag：
dsh plugin --profile web add github:Link258QAQ/dsh-plugin-genshin-launch#v0.2.0
```

本地开发用 `link:`：

```powershell
dsh plugin --profile web add "link:D:\path\to\dsh-plugin-genshin-launch"
```

装完**下一次 `dsh --profile web` 启动时自动跑一遍**。

卸载：

```powershell
dsh plugin --profile web remove dsh-plugin-genshin-launch
```

> 插件 ID 是 `genshin-launch`，包名 `dsh-plugin-genshin-launch`。
> 用 `link:` 安装时，改本目录的代码下次启动就生效，不用重装。
> 也可以在 DSH Market 里搜 `dsh-plugin-genshin-launch`（收录审核通过后可见）。

### 装之前请注意

- 这个插件**真的会下 224 MB** 到你的桌面（可以在配置里改成别的目录或改成只打开链接）。
- 如果安装时 pnpm 需要重新解析依赖树，而你的网络访问不了 GitHub（`codeload.github.com`），安装会失败并回滚。**先确认 GitHub 通**，或者按下面的「不动 pnpm 的装法」手工接线。

<details>
<summary>不动 pnpm 的装法（离线、零依赖重算）</summary>

`link:` 安装本质就是「package.json 加一条依赖 + bundles 登记 + 目录联接」，可以手工做：

1. 在 `$DSH_HOME\profiles\web\package.json` 的 `dependencies` 里加：
   ```json
   "dsh-plugin-genshin-launch": "link:D:/path/to/dsh-plugin-genshin-launch"
   ```
   并在 `dsh.profile.bundles` 数组里加一项 `"dsh-plugin-genshin-launch"`。
2. 建目录联接：
   ```powershell
   cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-genshin-launch" "D:\path\to\dsh-plugin-genshin-launch"
   ```
3. 重启 DSH。

</details>

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: genshin-launch
  name: dsh-plugin-genshin-launch
  config:
    download: true                            # false = 只打开下载链接，不下载
    downloadDir: 'C:\Users\你\Desktop'        # 目标目录（默认桌面）
    expectedInstallerBytes: 234881024         # 预期体积（默认 224 MiB）
    sizeToleranceBytes: 52428800              # 体积容差（默认 50 MiB）
    openFileWhenDone: true                    # 下完打开所在目录
    openFallbackWhenFailed: true              # 失败时打开官方下载页
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时插件完全不动作，网页面板也不出现 |
| `download` | `true` | `false` = 只打开直链（「下载不了也没关系」形态） |
| `downloadDir` | 桌面 | 目标目录；留空则自动找 `Desktop` / `桌面` / OneDrive 桌面 |
| `url` | 内置国服启动器直链 | 第一优先候选 |
| `extraUrls` | `[]` | 追加候选直链 |
| `probeLatest` | `true` | 是否在同一版本目录里向上找更新的 `pcbackup` 序号 |
| `probeStart` | `0` | 探测起点序号；`0` = 用 `url` 里的序号 |
| `probeAhead` | `1` | 种子可用时额外向上探几步 |
| `resume` | `true` | 断点续传 |
| **`expectedInstallerBytes`** | **224 MiB（234881024）** | **体积安全闸的预期值**（换成新版本、体积确实变了就改这里） |
| **`sizeToleranceBytes`** | **50 MiB** | **允许的体积偏差；超出 → 整条链接拒绝** |
| `minInstallerBytes` / `maxInstallerBytes` | `0`（自动推导） | 想直接指定上下限就填这里（覆盖容差推导） |
| `allowUnknownSize` | `false` | 服务端不给 `Content-Length` 时是否放行（默认拒绝，更安全） |
| `openFileWhenDone` | `false` | 下载完打开文件所在目录 |
| `openFallbackWhenFailed` | `true` | 失败时打开官方下载页 |
| `fallbackUrls` | `['https://ys.mihoyo.com/launcher', 'https://www.mihoyo.com/download']` | 兜底打开的页面 |
| `useCache` / `cacheTtlHours` | `true` / `168` | 解析结果缓存 |
| `skipIfInstalled` | `true` | 本机已装原神则跳过下载 |
| `clientNotice` / `clientNoticeSeconds` | `true` / `600` | 网页右下角面板 / 显示时长 |

## 链接为什么会「自动更新」

米哈游**没有**给启动器安装包提供公开的“最新版”接口：游戏包有 `hyp-connect` API
（`getGamePackages` / `getGameBranches`），但启动器安装包只挂在 CDN 的版本目录下，
目录名是「时间戳_随机 token」，无法推导。实际可用的规律是：

1. 你给的直链只要还活着就继续用（`HEAD` 检查 200 + 体积检查）；
2. 同一版本目录下的 `pcbackup<NNN>` 是**顺序发布**的安装包备份序号，**号越大越新**
   （同一个安装器版本会同时挂 316/317/318/319/320 多个备份）。

所以插件先用你的直链，再顺手往上探一位，能拿到更新的就用更新的（实测 319 → 320）；
如果你的直链失效了，就一直往上找到还存在的最大的序号。探测结果缓存 7 天。

**诚实的边界**：如果米哈游换了**整个版本目录**（新的时间戳 + token）并下掉旧目录，
`pcbackup` 往上探也没用，这时插件会按设计退化成**打开官方下载页**。
要覆盖这种情况，把新链接填进 `url` / `extraUrls` 即可。

## 自测

```powershell
node tests/size-guard.test.mjs
```

## 验证记录

| 项 | 结果 |
|---|---|
| 端口识别 | 真实启动 `dsh --profile web --no-open --port 3099`，插件打印 `识别到 DSH 端口：3099`；`/dsh-genshin-launch/status` 返回 `endpoint.port = 3099` |
| 最新版解析 | 种子 `pcbackup319` 可用 → 向上探测发现 `pcbackup320` → 实际下载 320 那份 |
| 下载 | 223.5 MB 用时约 15s，落盘字节数与 CDN 一致，文件头是 `MZ`（合法 PE） |
| 体积安全闸 | 2 MiB / 900 MiB / 体积未知 → 全部拒绝；234382248 字节的真实安装包 → 放行；把预期改成 2 MiB 后同一文件放行（闸门可配置，不是写死） |
| 断点续传 | 造 1.5 MiB `.part` 后重跑，最终字节数与完整下载一致 |
| 落盘复检 | 体积不符会删文件并报错，不会把半截文件当成功 |
| 桌面不可写 | 自动改到工作区下载并打开资源管理器（模拟不可写目录实测通过） |
| index 注入 | 带 token 打开页面，HTML 里确实多出 `<script defer src="/dsh-genshin-launch/client.js"></script>` |
| 安装/卸载 | `dsh plugin add/remove` 均干净，卸载后 profile 的依赖与 bundles 完全还原 |

## 目录结构

```
dsh-plugin-genshin-launch/
├── package.json         # dsh.bundle.patch 声明，DSH 凭它识别为 profile 层
├── cordis.patch.yml     # 挂载声明（insert 一行 genshin-launch）
├── lib/
│   ├── index.js         # 宿主半侧：端口识别、路由、index 注入、下载编排、兜底
│   ├── resolve.js       # 链接解析：候选校验 + pcbackup 向上探测 + 缓存
│   ├── size-guard.js    # 体积安全闸：224MB ± 50MB，越界整条拒绝
│   ├── download.js      # 下载器：Range 续传、进度、大小校验
│   └── client.js        # 浏览器半侧：右下角「原神，启动！」进度面板
└── tests/
    └── size-guard.test.mjs
```

## 免责声明

本项目是 DSH 的第三方插件，与米哈游 / HoYoverse / DeepSeek 无任何关联。
它只做一件事：把官方 CDN 上的**公开安装包直链**下载到你指定目录（或打开官方下载页）。
《原神》及相关名称、素材归米哈游所有；请遵守游戏官方的用户协议。

## License

[MIT](LICENSE)
