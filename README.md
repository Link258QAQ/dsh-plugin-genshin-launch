# dsh-plugin-genshin-launch

> **原神，启动！** —— 给 DeepSeek Harness（DSH）装一个插件：**每次打开 DSH，先零配置看看本机有没有装《原神》**——
>
> - **装了** → 停止下载，直接把游戏本体拉起来（本体起不来自动改起米哈游启动器）。这就是「打开 DSH 就启动原神」。
> - **正在装 / 更新**（登记了位置但本体还没下完）→ 也不下载，改为启动米哈游启动器让它继续。
> - **没装** → 把启动器安装包下载到桌面，带 224MB 体积安全闸；下载不成退化成打开官方下载页。

一句话简介（可直接用作 GitHub 仓库 About）：

> DSH 插件：打开 DSH 时零配置探测本机《原神》，装了就直接启动游戏本体（起不来自动改起米哈游启动器），没装就下载启动器安装包到桌面。

```
╔══════════════════════════════════════════════════════════╗
║  原神，启动！                                            ║
╚══════════════════════════════════════════════════════════╝
[genshin-launch] 识别到 DSH 端口：3080（http://127.0.0.1:3080）
[genshin-launch] 探测 · HoYoPlay 启动器安装目录：D:\…\miHoYo Launcher
[genshin-launch] 探测 · → 采用 D:\…\YuanShen.exe（来源：registry:hyp:hk4e_cn）
[genshin-launch] 检测到已安装的原神（国服 / B 服）：D:\…\YuanShen.exe
[genshin-launch] 已安装 → 停止自动下载，改为「打开 DSH 就启动原神」
[genshin-launch] 启动原神（gui-open）：D:\…\YuanShen.exe（方式 spawn）
[genshin-launch] 原神已启动（pid 21456）
```

网页右下角还有一个金边小面板，实时显示「原神，启动！ + DSH 端口 + 探测到的本体（掩码路径）+ 启动结果 / 下载进度」。

---

## 特性

### 方案二：打开 DSH 就启动原神

- **零配置探测**：用户什么都不用设置。按「先快后慢、命中即停」的顺序找（见下），最快一档约 **400ms**，实测整条快档 **0.5 秒**跑完。
- **触发时机 = 浏览器真的把界面渲染出来**的那一刻，不是宿主进程启动的那一刻。原因是本 profile 开了 `patchReload: live`：挂在宿主 `apply` 上的话，**你每改一次配置就会再弹一次原神**。
- **每个 DSH 进程只启动一次**：落盘标记以「宿主 pid + 进程启动时刻」为键，热重载不会重复启动，刷新页面也不会重开游戏。
- **秒退就改起启动器**：启动后守一个观察窗（默认 3 秒）。本体在窗口内就退出（典型原因：客户端版本过低要先更新）→ 自动改起米哈游启动器；启动器也起不来才报错。
- **已经在跑就不重复启动**：用进程名问一次（尽力而为，问不到就当没在跑，绝不因为问不到而拒绝启动）。
- **绝不静默提权，但会请你授权**：插件不会用 `runas` 悄悄提权。真机实测：`YuanShen.exe` 与 `launcher.exe` 的清单都是 `requireAdministrator`，用 `spawn`（CreateProcess 语义）去起它不会弹 UAC，系统直接拒绝、Node 报 `EACCES`。所以 `spawn` 一旦被这类权限问题拦下，插件**自动改走一次 `shell`（等价于双击），由 Windows 弹 UAC**——你点同意才提权，点拒绝就不启动。不想回退可以设 `retryShellOnElevation: false`。
- **不把 DSH 的秘密交给游戏**：启动游戏时用脱敏后的环境变量（`*KEY*` / `*PASSWORD*` / `*SECRET*` / `*TOKEN*` / `DSH_*` 全部剔除，口径与 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv` 一致）。游戏不该拿到你的 API key。
- **路径隐私**：日志、网页面板、独立窗口、状态文件里的路径一律掩码成「盘符:\…\末段文件名」；手填/扫盘得到的本体地址在盘上按当前用户 **DPAPI 加密**存储；启动器路径**不落盘**（用时现探测）；详见 [隐私](#隐私)。

### 方案一：没装就把安装包下到桌面

- **端口识别**：注入宿主 `webServer` 服务读 `host/port`，`--port 0` 由系统分配端口也能拿到；`DSH_WEB_URL` 兜底。
- **自动找最新版**：候选直链可用时，还会在同一版本目录里向上探测更新的 `pcbackup` 序号（实测 319 → 320）。
- **体积安全闸**：启动器安装包约 224 MiB。凡是体积与预期**相差超过 50 MiB** 的链接——不管它来自候选、缓存还是探测——都会被**整条拒绝**：不下载、不续传，连已经下了一半的 `.part` 一起删掉。体积拿不到也默认拒绝。
- **断点续传 / 落盘后复检 / 优雅退化 / 零依赖**：同 v0.2。

---

## 怎么找到「已安装的原神」：五档阶梯

全程**本地只读**：读注册表字符串、`existsSync` 判存在、列目录项名字。**不读文件内容、不联网、不发给任何模型**。

| 档 | 做什么 | 实测开销 |
|---|---|---|
| 0 `config` | 配置里手填的 `gameExe` / `gamePath`（最高优先级，自测也用它） | 0ms |
| 1 `registry` | 读 HoYoPlay 的 `HYP` 树，取 `hk4e_*` 键下所有像盘符路径的值；再点查 3 个卸载记录根 × 4 个可能键名 | ~400ms |
| 2 `paths` | 每个盘根 + 每个顶层目录 × 几个常见安装目录名 | ~50ms |
| 3 `scan` | 卸载记录**全量**扫描（3 次 `reg query /s`）+ 有界扫盘（默认深度 ≤ 4，预算 20s） | 数秒 ~ 20s，**只在前两档全落空时才跑，结果落盘** |

想彻底关掉扫盘：`detectSources: ['config','registry','paths']`。首次跑完会把「没找到」这个结论缓存 24 小时，之后每次开 DSH 都秒开。

### 几个实测踩出来的坑（决定了上面的设计）

- **注册表和卸载记录会残留，绝不能单独采信。** 一台机器上「鸣潮」早卸载了卸载记录还在；`HKCU\Software\Classes\BetterGI` 指着一个已经删掉的目录；米哈游自己的 `HYP\standalone\14_0\hk4e_cn` 键存在但**一个值都没有**（现役布局其实在 `HYP\1_1`）。所以任何读到的路径都必须**立刻用文件系统复核**。
- **值名不猜。** 实测现役 HoYoPlay 1.18.0.380 把游戏路径记在 `HKCU\Software\miHoYo\HYP\1_1\hk4e_cn` 的 **`GameInstallPath`** 下；但代码**不按值名取**，只要求「在 `hk4e_*` 键下、长得像盘符路径」——米哈游哪天改了值名也不会瞎。
- **不查 `HKCU\Software\miHoYo\原神`。** 那个键里全是游戏自己的 Unity PlayerPrefs 和 `MIHOYOSDK_*` 加密 blob，**不含安装路径**（把全部 `REG_BINARY` 按 UTF-8/UTF-16 解过一遍找盘符路径，0 命中），而 `reg query` 它要跑 **20 秒**（输出 929KB 的十六进制倾倒）。放进阶梯等于每次开 DSH 塞一颗 20 秒的地雷。
- **`reg.exe` 的输出编码跟着控制台代码页走。** 中文 Windows 常见 936（GBK），也可能是 65001（UTF-8）；直接按 UTF-8 解会把中文安装路径解成乱码。做法：统一先 `chcp 65001` 再查，输出就是确定的 UTF-8。
- **进程启动开销才是大头。** 点查「3 个卸载记录根 × 4 个键名」如果各起一次 `cmd+reg`，全落空时白花 800ms；串成一条 `cmd /c` 之后只剩一次进程启动。同理，固定候选路径从「每个组合一次 `existsSync`（500 多次 stat，4.5 秒）」改成「每个顶层目录只 `readdir` 一次再比对（几十次，50ms）」。

### 「装了」「正在装」「没装」是三件事

中间那档很容易被忽略，但代价很实在：**本体 exe 还没下下来时，如果只判「没装」，插件会去下一个 224MB 的启动器安装包——而启动器早就装好了。**

所以探测结果有三个状态：

| 状态 | 判据 | 插件行为 |
|---|---|---|
| `ready` | `YuanShen.exe`（国服/B服）或 `GenshinImpact.exe`（国际服）在位 | 启动本体 |
| `incomplete` | 结构指纹 ≥ 2 条：有 `YuanShen_Data\`、有 `pkg_version`、有 `mhypbase.dll`/`rtlbase.dll`、`config.ini` 里有 `game_version=` | 不下载，启动米哈游启动器让它继续 |
| 没找到 | 上面都不满足 | 下载启动器安装包（方案一） |

要求「≥ 2 条指纹」是有意的：原神本体 60GB+，把随便一个带 `config.ini` 的目录误判成原神，代价比漏判高得多。

---

## 安装

从 GitHub 直接装（推荐，可固定版本）：

```powershell
dsh plugin --profile web add github:Link258QAQ/dsh-plugin-genshin-launch
# 固定到某个 tag：
dsh plugin --profile web add github:Link258QAQ/dsh-plugin-genshin-launch#v0.4.0
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

- 如果本机装了原神，这个插件**会在你每次打开 DSH 界面时把游戏拉起来**。嫌烦就在配置里把 `launchGame` 设成 `false`，或者直接卸掉插件。
- 没装原神时，它**真的会下 224 MB** 到你的桌面（可以改成别的目录或改成只打开链接）。
- **从 v0.3 及更早版本升级**：首次启动会自动做一次隐私迁移——桌面上老配置的**本体地址**搬进加密存储（`%LOCALAPPDATA%\dsh-genshin-launch`），老配置里的冗余明文路径字段被清除，桌面遗留的 `dsh-genshin-launch-*.json`（status/detect/session）会被删掉。功能不变，只是这些明文文件从此消失。
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

## 自检（装原神之前就能先验证启动链路）

插件带一个不依赖 DSH 的自检命令，把探测阶梯和启动各跑一遍并打印全过程：

```powershell
# 只探测，看每一档查了什么、为什么没命中
node tools/selfcheck.mjs

# 拿任意一个程序当靶子，连「启动」一起验证（--kill 跑完把它收掉，别留窗口）
node tools/selfcheck.mjs --exe "D:\games\Shawarma\Shawarma Legend.exe" --launch --kill

# 换另一种启动通道（cmd /c start，双击语义）
node tools/selfcheck.mjs --exe "...\某程序.exe" --launch --kill --method shell

# 跳过最贵的扫盘那一档
node tools/selfcheck.mjs --no-scan

# 需要拿完整路径排错时（默认掩码成「盘符:\…\末段」，方便把输出直接贴进工单）
node tools/selfcheck.mjs --no-mask
```

退出码：找到（并启动成功）= 0，否则 1。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: genshin-launch
  name: dsh-plugin-genshin-launch
  config:
    # —— 方案二：打开 DSH 就启动原神 ——
    launchGame: true          # false = 不自动启动
    launchTrigger: gui        # gui = 浏览器打开界面时启动；host = 宿主进程一启动就启动
    launchMethod: spawn       # spawn = 直接起 exe（可判定成败）；shell = cmd /c start（双击语义）
    retryShellOnElevation: true # spawn 因「清单要管理员」被拦（EACCES）时，自动改走 shell 弹 UAC 一次
    launchWatchMs: 3000       # 观察窗：这段时间内就退出算失败 → 回退去起启动器
    fallbackToLauncher: true  # 本体没起来就改起米哈游启动器
    launchOncePerSession: true # 每个 DSH 进程最多启动一次
    # —— 零配置探测 ——
    gameExe: ''               # 手填 exe 全路径（最高优先级）
    gamePath: ''              # 手填安装目录
    detectSources: ['config', 'registry', 'paths', 'scan']
    scanMaxDepth: 4
    scanBudgetMs: 20000
    extraRoots: []            # 额外的扫描 / 候选根目录
    detectionCacheHours: 168  # 命中结果的缓存时长
    negativeCacheHours: 24    # 「没找到」的缓存时长（只用来跳过扫盘那一档）
    # —— 方案一：没装时下载 ——
    download: true            # false = 只打开下载链接
    downloadDir: 'C:\Users\你\Desktop'
    stateDir: ''                # 状态/配置/缓存目录；默认隐藏的 %LOCALAPPDATA%\dsh-genshin-launch
    expectedInstallerBytes: 234881024
    sizeToleranceBytes: 52428800
    openFileWhenDone: true
    openFallbackWhenFailed: true
    skipIfInstalled: true     # false = 无视安装状态，照旧下载
```

### 方案二

| 字段 | 默认 | 说明 |
|---|---|---|
| `launchGame` | `true` | 总开关；`false` 时只探测不启动 |
| `launchTrigger` | `gui` | `gui` = 浏览器把界面渲染出来时启动（推荐）；`host` = 宿主进程一启动就启动 |
| `launchMethod` | `spawn` | `spawn` = `spawn(exe, {detached, stdio:'ignore'})`，能拿到 pid 与 error/exit，**是唯一能判定「秒退」的通道**；`shell` = `cmd /c start "" <exe>`，走 ShellExecute（清单要求管理员时由系统弹 UAC），代价是拿不到子进程句柄、只能靠进程名轮询 |
| `retryShellOnElevation` | `true` | `spawn` 被系统按「需要提权」拦下（`EACCES` / 错误码 740）时，自动改走一次 `shell` 弹 UAC。设 `false` 则不自动回退（仍会先试 `spawn`，只是权限失败后不再自己走 shell） |
| `launchWatchMs` | `3000` | 观察窗长度 |
| `fallbackToLauncher` | `true` | 本体没起来就改起米哈游启动器 |
| `launchOncePerSession` | `true` | 每个 DSH 进程最多启动一次 |
| `gameExe` / `gamePath` | 空 | 手填路径，优先级最高（自测 / 特殊布局用）。落盘时按当前用户加密；界面里只回显掩码形式 |
| `detectSources` | 全开 | 想关掉扫盘就删掉 `'scan'` |
| `scanMaxDepth` / `scanBudgetMs` | `4` / `20000` | 有界扫盘的深度与时间预算 |
| `extraRoots` | `[]` | 额外的扫描 / 候选根 |
| `detectionCacheHours` / `negativeCacheHours` | `168` / `24` | 命中缓存 / 未命中缓存时长 |

### 方案一 / 通用

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时插件完全不动作，网页面板也不出现 |
| `download` | `true` | `false` = 只打开直链 |
| `downloadDir` | 桌面 | 目标目录；留空则自动找 `Desktop` / `桌面` / OneDrive 桌面 |
| `stateDir` | `%LOCALAPPDATA%\dsh-genshin-launch` | 状态/配置/缓存目录（含加密后的本体地址）；测试或特殊环境可指到别处 |
| `url` | 内置国服启动器直链 | 第一优先候选 |
| `extraUrls` | `[]` | 追加候选直链 |
| `probeLatest` / `probeStart` / `probeAhead` | `true` / `0` / `1` | `pcbackup` 序号向上探测 |
| `resume` | `true` | 断点续传 |
| **`expectedInstallerBytes`** | **224 MiB** | **体积安全闸的预期值** |
| **`sizeToleranceBytes`** | **50 MiB** | **允许的体积偏差；超出 → 整条链接拒绝** |
| `minInstallerBytes` / `maxInstallerBytes` | `0`（自动推导） | 想直接指定上下限就填这里 |
| `allowUnknownSize` | `false` | 服务端不给 `Content-Length` 时是否放行 |
| `openFileWhenDone` | `false` | 下载完打开文件所在目录 |
| `openFallbackWhenFailed` | `true` | 失败时打开官方下载页 |
| `fallbackUrls` | `['https://ys.mihoyo.com/launcher', ...]` | 兜底打开的页面 |
| `useCache` / `cacheTtlHours` | `true` / `168` | 安装包链接解析缓存 |
| `skipIfInstalled` | `true` | 装了原神是否跳过下载（`false` = 无视安装状态照旧下载） |
| `clientNotice` / `clientNoticeSeconds` | `true` / `20` | 网页右下角面板 / 终态后自动关闭秒数 |

---

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

---

## 隐私与数据处理

本插件只在你**本机**工作，全程**不联网上传任何个人信息**（下载方案一从米哈游官方 CDN 拉公开安装包除外）。v0.4.0 起，对「可能沾到用户隐私的落盘与显示」做了系统整改：

**落盘（磁盘上留什么）**

- 只保留两样必须持久化的东西：① **原神本体地址**（`gameExe`，功能上必须知道它在哪才能启动）；② **没装时下载的安装包地址**（官方 CDN 直链，是公开链接、不含个人信息）。
- 本体地址在盘上**按当前 Windows 用户加密**（DPAPI `CurrentUser` 作用域，见 `lib/privacy.js`）。别的用户 / 别的机器拿到这个文件**解不开**。DPAPI 不可用时（极端受限环境）如实降级为明文并在 `encryption` 字段标出来，绝不假装加密。
- **启动器路径不落盘**：本体起不来要「改起启动器」时，从本体目录现推一次（`locateLauncherNear`），用完即走。
- **配置格式 v1→v2 自动迁移**：老版本把 `scanFoundExe / installDir / gameDir / launcherPath` 等一堆明文路径写在桌面 JSON 里。v0.4 打开老配置时会自动把这些冗余字段清掉、把本体地址并进加密的 `secrets`，并**删除桌面上遗留的老状态文件**（status / detect / session / window 脚本）。
- **临时残留自动清扫**：注册表 / 进程列表的捕获输出（`%TEMP%\dsh-genshin-launch-*.out`）在插件启动时扫一遍，删掉上一进程的残留（60 秒内的在途文件不动，避免抢正在写的那份）。
- 状态目录从**桌面**挪到隐藏的 `%LOCALAPPDATA%\dsh-genshin-launch`（可用 `stateDir` 覆盖；桌面里那种「谁都能翻一眼」的明文 JSON 从此不再产生）。

**显示（日志与界面露什么）**

- 日志和界面（网页面板、DSH 插件卡、独立窗口）里的路径**一律掩码**：完整路径压成「盘符:\…\末段文件名」，例如 `C:\Users\example\Games\…\YuanShen.exe` → `C:\…\YuanShen.exe`。**用户名、中间目录结构都不出现**。
- URL（`http://127.0.0.1:3080`、官方下载页）不受影响——它们不是文件路径，不会被误掩码。
- 想改路径：因为界面只显示掩码，需**重新粘贴完整路径**（不能拿掩码串回填，否则会把 `C:\…\xxx.exe` 当完整路径写回去；这一点在网页面板和独立窗口里都做了处理）。
- 自检 `tools/selfcheck.mjs` **默认也掩码**，方便你把输出直接贴进工单而不泄露本机目录；要排错拿全路径时加 `--no-mask`。

> 一句话：**盘上只留功能必需的两类地址且能加密就加密，其余能不存就不存；日志和界面只显示掩码。**

---

## 已知限制与风险（请在装之前读一遍）

- **反作弊很在意「谁把你拉起来的」。** 社区实测（2025 年「千星奇域」之后）：第三方启动器会在进入游戏约 3 分钟后触发游戏内弹窗「检测到非法工具，请重启机器。错误码：10612-4001」；把自写程序**改名成已知第三方工具的名字**能复现，说明它至少部分依赖**父进程名字黑名单**。DSH/Node 不在已知名单里（Collapse 这类正经第三方启动器据报也不在），所以**判断风险较低，但这属于会动到检测规则的东西，不是我们能保证的**。
  - 想更保守：`launchMethod: shell`（父进程变成短命的 `cmd.exe`，语义等于双击），代价是失去「秒退判定」。
  - 真要完全规避：`launchGame: false`，只用方案一。
- **原神本体与米哈游启动器都要求管理员权限（真机已确认）。** `YuanShen.exe` / `launcher.exe` 的清单是 `requireAdministrator`：用 `spawn` 直接起会被系统拒（`EACCES`），不会弹 UAC。插件的处理是——`spawn` 因权限失败后**自动改走一次 `shell`**，由 Windows 弹 UAC，**你点同意才提权**；点「否」就什么都不做。插件自己从不静默 `runas`（守「绝不主动提权」）。不想自动回退就设 `retryShellOnElevation: false`。
- **直接起游戏本体会跳过启动器的更新检查。** 客户端版本过低时游戏会自己报错退出——这时观察窗会捕获「秒退」并自动改起启动器。
- **`tasklist` 在某些受限环境里会被拒（`Access denied`）。** 这时「是否已在运行」判定退化为「不知道」，插件会选择照常启动而不是拒绝启动。
- **HoYoPlay 的注册表布局会变。** 我们已经见过 `HYP\standalone\14_0\hk4e_cn`（空残留）和 `HYP\1_1\hk4e_cn`（现役）两种；代码枚举整棵树并靠叶子名认游戏，但米哈游再改一次结构仍可能需要更新插件。
- **有界扫盘只认目录名和几个结构指纹**，不读文件内容、不联网。装在极其古怪的目录里仍可能漏；这时用 `gamePath` / `gameExe` 手填，或把它加进 `extraRoots`。

---

## 自测

```powershell
npm test        # 体积安全闸 + 配置 v2 加密/迁移 + 隐私模块（掩码/DPAPI/临时清扫）+ 探测/启动纯逻辑
npm run smoke   # 宿主半侧集成冒烟：会真的启动一次靶子程序，跑完自动收掉（状态隔离在临时目录）
```

`npm run smoke` 用假的 `ctx` 把 `apply()` 拉起来，然后像浏览器那样走一遍路由，覆盖：四条浏览器侧接线是否注册、token 注入与幂等、启动路由的四种拒绝（错 token / 跨站 Origin / 非 POST / 非回环）、GUI 触发、启动成功、幂等（第二次触发不重复拉起）、状态文件落盘、秒退识别、目标不存在时报错而非崩溃。

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
| index 注入 | 带 token 打开页面，HTML 里确实多出 `<script defer src="/dsh-genshin-launch/client.js?token=…"></script>` |
| 安装/卸载 | `dsh plugin add/remove` 均干净，卸载后 profile 的依赖与 bundles 完全还原 |
| **零配置探测（真实安装）** | 真机装了 HoYoPlay 1.18.0.380 + 原神：从 `HYP\1_1\hk4e_cn\GameInstallPath` 读到游戏目录，并从 `HYP\1_1\InstallPath` 精确找到 `launcher.exe`；快档 **0.5 秒**跑完 |
| **「安装中」识别** | 真机在本体还没下完时（有 `YuanShen_Data\`、`pkg_version`、`mhypbase.dll`、`rtlbase.dll`、`config.ini` 里 `game_version=`，但 `YuanShen.exe` 不在）→ 判定 `incomplete`，不会去白下 224MB 安装包 |
| **启动通道自验证** | 用「靶子程序自己写标记文件」的方式验证（不靠数窗口）：`spawn` ✅、`cmd /c start` ✅、`explorer.exe file-uri` ❌、`rundll32 FileProtocolHandler` ❌、`Start-Process` ❌（后三者在 DSH 沙箱内起不来；宿主里未必如此，但不作为主通道） |
| **真启动一次** | `spawn` 起真实 GUI 程序 → 拿到 pid、窗口出现、`MainWindowTitle` 正确；`shell` 通道 → `cmd` 退出码 0 |
| **注册表编码** | 中文 Windows 下 `reg.exe` 按 OEM 代码页输出：实测本机是 65001 而常见中文机是 936；统一 `chcp 65001` 后输出确定为 UTF-8 |
| **性能** | 探测快档 21s → **0.5s**（砍掉 20 秒的 `HKCU\Software\miHoYo\原神`、把 12 次注册表查询合成 1 次、固定候选路径从 500+ 次 stat 改成几十次 readdir） |
| **环境变量脱敏** | 单测断言 `*KEY*` / `*TOKEN*` / `DSH_*` 不会传给游戏进程，`PATH` 保留 |
| **幂等** | 标记文件以「宿主 pid + 进程启动时刻」为键；`patchReload: live` 下热重载不会重复启动 |
| **宿主半侧集成冒烟** | `npm run smoke`：四条浏览器接线注册 ✅、token 注入且幂等 ✅、启动路由 4 种拒绝 ✅、GUI 触发→启动成功（拿到真实 pid）✅、第二次触发被幂等挡住 ✅、状态文件落盘 ✅、秒退识别为 `early-exit` ✅、目标不存在报 `spawn-error` 不崩 ✅ |
| **路径掩码（日志+界面+状态文件）** | `tests/privacy.test.mjs` + 冒烟实测：宿主日志 / 状态 JSON / 网页面板 / 独立窗口 / DSH 配置卡 / 自检输出都只见 `盘符:\…\末段`；断言盘上没有用户名和中间目录；URL（`http://127.0.0.1:3080`）不被误伤 ✅ |
| **配置 v2 加密落盘 + v1 自动迁移** | 单测：`gameExe`/`gamePath` 不再以明文字段落盘（进 `secrets`，DPAPI 可用=`dpapi` 前缀密文，不可用=标注 `plain`）；老 v1 明文配置（含 `scanFoundExe`/`launcherPath`/`installDir` 等冗余字段）打开即迁移、冗余字段清除、桌面遗留老文件删除（`stateDir` 为默认时）✅ |
| **启动器不落盘** | 代码走查：探测缓存 v2 只留 `{found,registered,secrets(加密 exePath),flavor,source,checkedAt,scanDone}`，读旧缓存时 installDir/gameDir/launcherPath 一律丢弃；回退起启动器走 `locateLauncherNear` 现场推 ✅ |
| **%TEMP% 残留清扫** | `tests/privacy.test.mjs`：造一个 5 分钟前的 `dsh-genshin-launch-*.out` 与一个新鲜的，跑一次 sweep——旧的删、新的（60s 内）不动 ✅ |
| **DPAPI 真机** | 沙箱里 `spawnSync powershell.exe` EPERM → 按设计降级明文（round-trip 仍通，测试两种分支都覆盖）；真机 DPAPI 加密路径由用户自行验证（本轮整改后首次在真机打开 DSH 时看 `%LOCALAPPDATA%\dsh-genshin-launch\dsh-genshin-launch-config.json` 的 `encryption` 字段应为 `dpapi`） |

## 目录结构

```
dsh-plugin-genshin-launch/
├── package.json         # dsh.bundle.patch 声明，DSH 凭它识别为 profile 层
├── cordis.patch.yml     # 挂载声明（insert 一行 genshin-launch）
├── lib/
│   ├── index.js         # 宿主半侧：编排、分流、路由、index 注入、启动路由
│   ├── detect.js        # 零配置探测阶梯 + 结构指纹复核 + 有界扫盘 + 启动器现探（不落盘）
│   ├── registry.js      # 只读注册表：编码处理、解析、批量查询
│   ├── launch.js        # 启动通道：spawn / shell、观察窗、进程轮询、环境变量脱敏
│   ├── download.js      # 下载器：Range 续传、进度、大小校验（方案一）
│   ├── size-guard.js    # 体积安全闸：224MB ± 50MB，越界整条拒绝（方案一）
│   ├── resolve.js       # 链接解析：候选校验 + pcbackup 向上探测 + 缓存（方案一）
│   ├── exec.js          # 子进程执行 + 文件式输出捕获（避开沙箱的管道限制）
│   ├── store.js         # 配置持久化：v2 格式，路径进 DPAPI 加密 secrets，v1 明文自动迁移
│   ├── privacy.js       # 隐私原语：maskPath / maskPathsInText / protect / unprotect / sweepTempFiles
│   ├── questions.js     # 问答通道（扫盘同意、体积宽档确认——面板和独立窗口共用）
│   ├── window.js        # 独立 WinForms 窗口的拉起 / 置顶 / 收尾
│   └── client.js        # 浏览器半侧：右下角面板 + 「界面已打开」上报
├── client/
│   └── index.js         # DSH 插件栏里的 React 配置卡
├── assets/
│   └── standalone-window.ps1  # 独立窗口的 WinForms 脚本（渲染掩码状态、不回填掩码路径）
├── tools/
│   └── selfcheck.mjs    # 不依赖 DSH 的自检命令（默认掩码，--no-mask 看全路径）
└── tests/
    ├── size-guard.test.mjs
    ├── store.test.mjs    # v2 加密格式、v1→v2 迁移、坏文件兜底
    ├── privacy.test.mjs  # 掩码不泄露 / DPAPI round-trip 或降级 / 临时残留清理
    ├── detect.test.mjs
    └── apply.smoke.mjs   # 宿主半侧集成冒烟（用 stateDir 隔离到临时目录）
```

## 免责声明

本项目是 DSH 的第三方插件，与米哈游 / HoYoverse / DeepSeek 无任何关联。
它做两件事：零配置定位本机**已安装**的《原神》并按你的设置启动它；或在没装时把官方 CDN 上的**公开安装包直链**下载到你指定目录（下载不成则打开官方下载页）。
《原神》及相关名称、素材归米哈游所有；请遵守游戏官方的用户协议。使用本插件启动游戏所产生的任何后果（包括但不限于反作弊判定）由使用者自行承担。

## License

[MIT](LICENSE)
