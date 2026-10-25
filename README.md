# Achievement Watcher NG (aw2)

成就解锁实时通知工具：游戏里每跳出一个成就，屏幕右下角滑入一张样式卡片，附带音效、稀有度标注和本地成就墙。

> **来源声明（Attribution）**：本项目改造自 [xan105/Achievement-Watcher](https://github.com/xan105/Achievement-Watcher)（LGPL-3.0）。成就存档格式的解析知识（Goldberg / CODEX / 3DM / SmartSteamEmu 等路径与文件结构）、Steam Web API 缓存策略、通知形态均源自原项目的设计；代码为独立重写（Node ESM、零原生依赖），未复制原项目源码，故同样以 [LGPL-3.0](LICENSE) 发布。感谢原作者 xan105。

仅支持 **Windows 10/11**。

---
## 代码为AI重写
###修改了什么：
1.系统图标放右下角，开机自启选项可见，能在图标处打开面板
2.成就提示弹窗，根据成就稀有程度修改成就音效（自备xbox成就音频文件）
3.删除多余的时长与截图功能（建议用其他软件入playnite管理）
###新增了什么：
1.给游戏打Goldberg补丁，对于新的游戏，打补丁功能可以提前检测该游戏是否受到支持
2.增加对RUNE组的成就文件的支持
3.对新游戏第一个成就的支持。原程序需要先生成成就文件后（通常是第一个成就解锁瞬间文件才生成），才能监控文件。现在系统对于新游戏进行特别处理，60秒监控一次是否生成新文件。
4.成就文件标准化。不同模拟器生成的成就文件不一样，现在系统会把他全部翻译成steam成就格式，并导出到\data\AchievementWall目录，供你别的程序使用。


- **实时弹通知**：监视本机成就存档文件，解锁瞬间右下角滑入 Steam 风格卡片（普通 5 秒 / 稀有 10 秒带金色标记），全屏游戏也能覆盖显示；同一时间只弹一张，按顺序排队播放。
- **稀有成就识别**：联网查询 Steam 全球解锁率（本地缓存 30 天），解锁率 ≤ 10%（可调）判定为稀有，播放专属音效并标注「全球仅 x% 玩家解锁」；达成全成就（100%）固定按稀有处理。
- **游戏库与成就详情**：本地网页面板列出所有识别到的游戏（封面、完成度、排序、搜索），点进去看每个成就的图标、描述、解锁时间与进度。
- **一键打补丁**：选一个游戏目录，自动识别 AppID、备份原 DLL（`.aw2bak`）、放入 Goldberg 模拟器并生成成就清单——打过补丁的游戏才能被监视到成就。能识别已打过的状态，不重复操作。
- **成就墙导出**：把所有游戏的成就归一化为 Steam 字段标准导出到本地目录，可作为自建成就墙/展示页的数据源。
- **完全便携**：单文件 exe 免安装，配置、缓存、成就墙全部落在 exe 旁的 `data\` 文件夹，删掉 exe + data 即彻底卸载。

---

## 使用方法（一步一步）

### 第 1 步：下载并运行

拿到 `aw2-desktop-portable.exe`（绿色单文件，无需安装、无需 Node.js），**放到一个固定的空目录**（数据会生成在旁边），双击运行。

启动后没有任何窗口弹出——看**屏幕右下角托盘区**（可能藏在 `^` 溢出图标里），出现一个奖杯图标即启动成功。

### 第 2 步：填 Steam API Key

**左键点击托盘图标**打开配置面板 → 左侧「⚙ 设置」→ 粘贴你的 Steam Web API Key → 保存。

> 没有 Key？去 [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) 免费申请一个（注册 Steam 账号即可，随便填个域名）。

不填 Key 程序也能跑，但成就名称/图标/全球解锁率拿不到，通知会缺失信息。

### 第 3 步：让游戏被监视到

程序只监视**打过 Goldberg 系模拟器补丁**的游戏。打开面板「🔧 打补丁」页：

1. 点「选择文件夹」，选中**游戏根目录**（能看到游戏 exe 或 `steam_appid.txt` 的那一层即可，不用找 DLL，程序会递归搜索）
2. 程序自动检测并显示当前状态：

   | 提示 | 含义 | 你要做什么 |
   | --- | --- | --- |
   | ✅ 已是 Goldberg 系模拟器 | 打过补丁（含 RUNE/CODEX/3DM/SSE 等兼容格式） | 什么都不用做，直接玩 |
   | 🟢 Xbox / 微软商店版 | 非 Steam 游戏 | 成就去 Xbox App 里看，本工具不支持 |
   | ⚠ 可能非 Steam 游戏 | 网游/Epic 等无标记 | 本工具不支持 |
   | ⚪ 未打补丁 | 干净的 Steam 游戏 | 点「开始打补丁」，自动完成备份+安装+配置 |
   | 其他模拟器（Goldberg 之外） | 已有其他模拟器但格式不同 | 可选：重新打补丁换成 Goldberg |

3. 打补丁完成后**重新启动游戏**即可。

也可以用「⬇ 下载成就」按钮批量扫描所有游戏目录、预取成就数据（推荐，之后离线也能弹通知）。

### 第 4 步（可选）：音效、自启、成就墙

- **音效**：自备两个音频，放到 exe 旁 `data\sounds\` 下，命名为 `normal.mp3`（普通）和 `rare.mp3`（稀有）。没有文件时用系统默认提示音。项目不附带音效（版权原因）。也可在设置页改路径或静音。
- **开机自启**：托盘图标**右键** → 勾选「开机自启」。
- **成就墙**：面板里点「导出成就墙」，数据导出到 `data\AchievementWall\`（可在设置页改目录）。
- **退出**：托盘图标右键 →「退出」。

---

## 程序原理

### 整体架构

整个程序是一个 Electron 进程组（一个主进程 + 若干渲染/工具子进程），主进程内同时跑四样东西：

```
┌─ Achievement Watcher NG.exe（Electron 主进程）─────────────────┐
│                                                                │
│  ① watchdog（文件监视）   fs.watch 监视所有成就存档，           │
│                           每 60 秒重扫一次新游戏目录            │
│  ② 面板服务（HTTP 5179）  本地网页面板（配置/游戏库/打补丁），  │
│                           只监听 127.0.0.1，不对外             │
│  ③ 广播服务（WS 8083）    成就事件实时推给弹窗和外部工具        │
│  ④ 通知弹窗               无边框透明置顶窗口，自绘卡片队列      │
│                           （Steam 蓝调样式，悬停暂停自动消失）  │
└────────────────────────────────────────────────────────────────┘
```

### 成就是怎么被发现的

1. **存档格式解析**：支持 Goldberg / gbe_fork / SmartSteamEmu / CODEX / 3DM / RUNE / OnlineFix 等常见模拟器的成就存档格式（文本/二进制 ini 均可）。
2. **文件监视**：`fs.watch` 盯住所有存档文件，文件变化后解析内容，与上次状态比对找出**新解锁**（按修改时间去重，不会把打开旧存档误报成新成就）。
3. **与 Steam 数据比对**：成就的名称、图标、描述、全球解锁率来自 Steam Web API，本地缓存 6 个月/30 天，启动时后台预热，避免解锁瞬间才联网。
4. **稀有判定**：全球解锁率 ≤ 阈值（默认 10%）或达成全成就 → 按稀有处理（金色卡片 + 专属音效）。
5. **通知播放**：事件经 WebSocket 推给透明弹窗窗口，卡片**按顺序逐张**滑入（一次一张，防刷屏），音效随卡片登场。

### 打补丁是怎么回事

「打补丁」= 给游戏安装 [gbe_fork](https://github.com/Detanup01/gbe_fork)（Goldberg 系）Steam 模拟器，让成就存档落在本地可被监视的位置：

1. 递归搜索游戏目录找到原 `steam_api64.dll`，备份为 `.aw2bak`
2. 放入 gbe_fork 模拟器 DLL（内置于程序 vendor 目录，零下载）
3. 在 `steam_settings\` 生成成就清单（achievements.json + 预下载的图标）
4. 之后游戏运行时把成就写入本地存档，watchdog 就能监视到了

> 这是纯本地的存档模拟，不修改游戏本体逻辑、不联网作弊。**担心补丁弄坏游戏？** 打补丁页有「恢复原样」按钮，一键还原到打补丁前的状态（原文件自动备份为 `.aw2bak`，即使配置丢失也能凭备份还原）；命令行对应 `node src\cli.js emu-restore <appid>`。

---

## 数据在哪、怎么卸载

| 位置 | 内容 |
| --- | --- |
| `exe 旁\data\aw2.json` | 全部配置（含加密的 API Key） |
| `exe 旁\data\steam_cache\` | 成就 schema 与图标缓存 |
| `exe 旁\data\track\` | 解锁状态（防重复通知） |
| `exe 旁\data\AchievementWall\` | 成就墙导出 |
| `exe 旁\data\sounds\` | 自定义音效（自备） |
| `exe 旁\data\logs\` | 运行日志（排查问题先看这里） |

卸载：托盘退出 → 删 exe + `data\` 文件夹，系统里不留任何东西。

---

## 给开发者

### 源码运行

1. 装 Node.js 18+，项目目录执行 `npm install`，再进 `electron\` 执行一次 `npm install`
2. 双击 `aw2-desktop.vbs`（静默启动桌面版，效果与 exe 相同）

常用命令：

```cmd
node src\cli.js scan              :: 扫描本机成就存档
node src\cli.js list <appid>      :: 查看某游戏成就状态
node src\cli.js setkey <KEY>      :: 设置 API Key
node src\cli.js watch             :: 只跑后台监视（无界面，配合 start-ui 场景）
node src\cli.js emu-apply <appid> [目录]   :: 命令行打补丁
node src\cli.js emu-restore <appid>        :: 回滚补丁
npm test                          :: 格式解析/匹配单测
```

### 构建 exe

```cmd
build-portable.bat          :: 压缩版（约 124MB，分发用，需几分钟）
build-portable.bat fast     :: 不压缩（约 388MB，本地秒级出包测试用）
```

脚本已内置 npmmirror 镜像（绕开 GitHub 直连超时）；构建前会自动结束残留进程。只改了 `src/web/electron` 源码时可用 `scripts\fastpack.ps1`（约 10 秒重打 asar，直接跑 `dist\win-unpacked\` 里的 exe 验证）。

### 代码结构

```
src/
├─ shared/    ini解析 / fs工具 / 日志 / 单实例锁
├─ core/      存档格式解析(normalize) / Steam schema 缓存 / 成就比对
│             / 打补丁(emuinstall) / 成就清单生成(emugen) / 成就墙(wall)
├─ watchdog/  文件监视主循环 / 通知通道（WebSocket 广播）
├─ server.js  本地 HTTP API（面板后端）
├─ cli.js     命令行入口
electron/     桌面版：main.js(主进程/托盘/面板窗口) + overlay(通知弹窗)
web/          面板前端（原生 DOM，零框架零构建）
```

### 兼容性设计

- 兼容原版数据：`AW2_DATA_ROOT` 指向旧版 `%APPDATA%\Achievement Watcher\` 可复用其缓存与配置（key 沿用原 AES 混淆格式）
- 去服务器化：不再依赖已关停的 `api.xan105.com`，schema 直接走 Steam Web API
- WebSocket 通知格式与原版一致（`{appID, game, achievement, ...}`），OBS overlay 等原版配套工具可直接对接

### 已知限制

- 仅 Windows（弹窗虽为自绘，音效/部分通知路径依赖 Windows）
- 游戏时长统计、截图/录像、GNTP 未移植
- Xbox / 微软商店、网游（无本地成就存档）的游戏不支持

<details>
<summary>更新记录（点开）</summary>

### 2026-10-24

- **稀有成就检测 + 双音效**：全球解锁率 ≤ 阈值判稀有，专属音效 +「全球仅 x% 玩家解锁」标注；全成就固定按稀有处理。
- **桌面版（Electron）上线**：后台监视 + 自绘弹窗卡片 + 内置面板 + 托盘图标四合一，替代旧版「Toast + 浏览器面板 + 分开启动脚本」的组合。
- **顺序队列播放**：一次一张卡片，播完再弹下一张；音效跟随登场；悬停暂停、点击开面板。
- **portable exe 打包**：electron-builder 单文件绿色版，数据落 exe 旁 `data\`；`build-portable.bat` 双模式构建（压缩/快速）。
- **打补丁页重做**：原生文件夹选择、递归搜索 DLL（时间预算兜底）、打补丁前自动检测状态（Goldberg/其他模拟器/Xbox/UE/非 Steam），提示友好化。
- **成就墙导出**：面板一键导出 Steam 字段标准数据。
- **修复**：preload ESM 语法错导致弹窗无卡片；新游戏目录 60 秒重扫才被监视；`rename` 事件丢弃解锁；overlay 路径 `ERR_FILE_NOT_FOUND` 导致弹窗从未加载；托盘退出可能假退出（进程残留）。

</details>
