# Kimi Code Companion

官方 **Kimi Code** VS Code 扩展（`moonshot-ai.kimi-code`）的伴侣扩展，为它补上缺失的实用功能：

- **在「Developer: Reload Window」之后恢复 Kimi 窗口**——包括自定义标题、编辑器列位置以及**对话历史记录**；
- **按钮**：编辑器标题栏中的 Kimi 图标（新建窗口）、旁边的铅笔图标（重命名窗口）、列表图标（打开的聊天），以及状态栏右侧的「K Kimi Code」按钮；
- **重命名 Kimi 窗口**（`Kimi Code: Rename Window`）——手动输入的标题会被保存并跨重载保留，自动命名不会再覆盖它；
- **按项目命名的窗口**——由伴侣扩展打开的窗口（按钮、`Ctrl+Alt+K`、菜单）直接以当前工作区名称命名，而不是「Kimi Code」；
- **根据对话主题自动命名窗口**（当窗口仍使用默认标题——「Kimi Code」或打开时使用的项目名——且其中打开了会话时，自动取会话的 `title`/`lastPrompt` 作为标题）；
- **`Kimi Code: Reopen Closed Window`**——重新打开最近关闭的 Kimi 窗口（最多记住 5 个）；若重新打开失败，该记录会保留在历史中，可以再次尝试；
- **`Kimi Code: Open Chats`**——实时、可搜索的已打开聊天列表：先列出等待输入的聊天，其次是出错的，其余按标签页顺序；搜索保持原生（输入即过滤，实时刷新不会重置查询），选中的聊天在显示前会与实时列表核对；也可以从编辑器标题栏和状态栏菜单打开；
- **`Kimi Code: Next Waiting Chat`** / **`Kimi Code: Next Chat Needing Attention`**——跳到下一个等待输入的聊天（或下一个等待/出错的聊天），循环切换并回到开头；聊天消失后循环会重新开始；
- **状态栏 `[? N]` 计数器**——有多少个 Kimi 聊天正在等待输入；仅在 N > 0 时显示，点击可打开下一个等待中的聊天；
- **`Kimi Code: Usage`**——以单独的报告显示当前订阅额度（5 小时 / 7 天 / 每月限额以及 booster 钱包），并显示消耗速度、耗尽预测以及距重置的倒计时；
- **Usage 报告与状态栏悬停提示中的 DeepSeek 余额**（读取 Kimi Code 配置中的 `[providers.deepseek]` 键；设置项 `kimiCompanion.deepseekBalance`，默认开启）；
- **阈值告警**——带「每个窗口只触发一次」闩锁的原生 VS Code 通知：5 小时窗口 ≥ 80%、月度限额 ≥ 90%、DeepSeek 余额低于 $1（设置项 `kimiCompanion.alerts`、`kimiCompanion.alertThreshold5h`、`kimiCompanion.alertThresholdMonth`、`kimiCompanion.alertDeepseekBelowUsd`）；即使状态栏隐藏了用量百分比也会触发，并在限额重置或用量回落到阈值以下后重新武装；
- **任务完成提示音与通知**——Kimi 代理在某标签页中正常完成一轮对话时，默认播放短促的提示音，也可单独启用带窗口标题的原生通知（设置项 `kimiCompanion.tabCompletionNotification`、`kimiCompanion.tabCompletionSound`）；
- **标签页标题状态标记**——窗口标题前显示实时状态：`[~]` 进行中，`[V]` 已完成，`[!]` 出错，`[?]` 等待您的批准或回答（`kimiCompanion.tabStatusMarkers`）；
- **状态栏显示用量**——两个数值：先显示月度限额，再显示 5 小时窗口，外加 booster 钱包余额（例如 `M 16% · 5h 82% · 💳 $12.34`），每 5 分钟刷新一次（设置项 `kimiCompanion.usageInStatusBar`）；当短窗口（≤ 1 天）达到 `kimiCompanion.alertThreshold5h` 阈值（默认 80%）且数据新鲜时，状态栏变为红色；数据过期时显示 `⚠ stale` / `↻ refresh needed`；把鼠标悬停在按钮上会打开 Copilot 风格的丰富面板——每个限额都有带重置日期的标题、大号百分比和图形进度条（真实图像，运行时生成；达到同一阈值时显示为红色）、消耗速度与预测行、booster 钱包和 DeepSeek 余额，底部还有可点击的操作链接（用量报告 / 新建窗口）；
- **状态栏菜单**——点击状态栏按钮打开菜单：操作项（刷新用量、新建窗口、重新打开已关闭的窗口、已打开的窗口）以及已打开窗口的聚焦列表；其中「已打开的窗口」会打开上面描述的搜索列表；菜单中不再重复显示额度——额度显示在状态栏、其悬停提示和 `Kimi Code: Usage` 报告中；「刷新用量」会重新获取数据并再次打开菜单；菜单与悬停提示按 VS Code 界面语言本地化（en / ru / zh-cn，消耗速度相关短语仍为英文）；
- **`Ctrl+Alt+K`**（macOS 为 `Cmd+Alt+K`）——新建 Kimi 窗口；
- **`Kimi Code: Diagnostics`**——状态报告：版本、全部 12 处补丁、最近一次补丁操作及其备份、钩子、窗口、已保存的状态；
- **`Kimi Code: Check Compatibility`**、**`Kimi Code: Install / Repair Patches`**、**`Kimi Code: Restore Original Files`**——基于补丁清单的哈希校验与事务式打补丁，覆盖 Kimi Code **0.8.2**、**0.8.3** 和 **0.8.4**；未知的 Kimi 版本不会被修改；
- 同时恢复 Kimi **侧边栏**中的对话。

运行日志：视图 → 输出 → 通道 **「Kimi Code Companion」**。

## 截图

![编辑器标题栏按钮](docs/img/title-buttons.png)

*编辑器标题栏按钮*

![状态栏按钮与用量百分比](docs/img/statusbar.png)

*状态栏按钮与用量百分比*

![恢复后的窗口（自定义标题与历史记录）](docs/img/windows.png)

*恢复后的窗口（自定义标题与历史记录）*

> **非官方项目。** 与 Moonshot AI 没有任何隶属关系。「Kimi」及 Kimi 标志为 Moonshot AI 的商标。本项目以 MIT 许可证分发；内置的 `kimi-icon.svg` 来自采用 Apache-2.0 许可证的 Kimi Code 扩展（见 `NOTICE`）。

## 工作原理（为什么要给 Kimi 扩展打补丁）

VS Code 不允许一个扩展访问另一个扩展的 webview 面板（既不能改标题，也不能读取会话）。因此伴侣扩展会对 Kimi 扩展的 `dist` 目录做十二处极小的补丁，把面板和钩子注册到 `globalThis`（扩展宿主进程的共享作用域）：

| # | 文件 | 标记 | 作用 |
|---|------|------|------|
| 1 | extension.js | `__kimiCompanionNextTitle` | 新标签页标题取自 `globalThis.__kimiCompanionNextTitle` |
| 2 | extension.js | `/*__kimiCompanion__*/` | 创建的面板注册到 `globalThis.__kimiCompanionPanels` |
| 3 | extension.js | `__kimiCompanionNextColumn` | 新标签页列位置取自 `globalThis.__kimiCompanionNextColumn` |
| 4 | extension.js | `/*__kimiCompanion2__*/` | 钩子 `__kimiCompanionGetSessionId / GetWebviewId / LoadSession` |
| 5 | extension.js | `__kimiCompanionGetSidebarId` | 侧边栏 webview id 钩子 |
| 6 | webview.js | `__kimiCompanionLoadSessionInUi` | webview 端处理 `__kimiCompanionLoadSession` 事件——走原生 `loadSessionHistory → loadSession` 流程 |
| 7 | extension.js | `__kimiCompanionGetUsage` | 通过 `harness.auth.getManagedUsage` 获取订阅额度的钩子——首选路径；失败时回退到使用本地凭据的直接 HTTPS 请求 |
| 8 | extension.js | `/*__kimiCompanionTurnSettled__*/` | 回合终态（`emitTerminal`）上报到 `globalThis.__kimiCompanionTurnSettled`——标签页完成通知 |
| 9 | extension.js | `__kimiCompanionTurnStarted` | 提示词开始（`this.activePrompt = active`）上报到 `globalThis.__kimiCompanionTurnStarted`——`[~]` 状态 |
| 10 | extension.js | `/*__kimiCompanionWaitA__*/` | 包装审批处理器：待处理/已解决的审批上报到 `globalThis.__kimiCompanionWaiting`——`[?]` 状态 |
| 11 | extension.js | `/*__kimiCompanionWaitQ__*/` | 同样包装问题处理器——`[?]` 状态 |
| 12 | extension.js | `/*__kimiCompanionPromptSettled__*/` | 每次提示结束（`settlePrompt`）都报告给 `globalThis.__kimiCompanionPromptSettled`——当提示在没有回合终止事件的情况下结束（启动前失败、早期错误、会话关闭）时清除 `[~]`/`[?]` |

这些版本之间唯一发生移动的锚点是 webview 补丁：0.8.2/0.8.3 中打包文件的会话历史存储名为 `Qe`，而 0.8.4 将其改名为 `Ve`。因此伴侣扩展为每种打包形态保留一个 webview 锚点变体，并按 Kimi 版本选择。

**自愈机制：** 每次激活时，伴侣扩展都会执行安装操作。对于受支持的版本，它会用清单核对 `dist`，只补上缺失的补丁（例如 Kimi 更新之后）；如果字节与任何已知状态（原始、已打补丁、可证明的中间状态）都不匹配，则不会写入任何内容，并在警告中说明原因。如果新版 Kimi 中找不到锚点，上表就是修复指南。

## 补丁命令与校验清单

伴侣扩展只修改 `resources/patch-manifest.json`（schema 1）中列出的 Kimi Code 版本，目前是 **0.8.2**、**0.8.3** 和 **0.8.4**：清单为两个 `dist` 文件分别记录了原始文件与已打补丁文件的 SHA-256 和大小，以及为该版本选定的补丁单元指纹（0.8.4 有自己的指纹，原因见上面的 webview 锚点）。

每次安装和恢复都是事务式的：

- 备份目录中的锁文件把补丁操作串行化（进程已不存在或超过 10 分钟的锁会被清除）；
- 文件通过临时文件、`fsync` 和重命名写入，因此中断的操作会保留原文件，而不是留下写了一半的文件；
- 写入前检查结果（每个锚点恰好出现一次，补丁后的文本可以解析），写入后再检查（文件哈希、全部十二个标记、解析）；
- 任何失败都会还原为完全相同的原始字节；写入后被其他进程改动过的文件会被保留并上报，而不是被覆盖。

**未知的 Kimi 版本不会被修改**：操作报告 `state: unknown`，不写入任何内容，钩子保持不可用，直到清单中加入该版本。与任何已知原始/已打补丁/中间状态都不匹配的 `dist` 同样会被拒绝。

原始文件存放在伴侣扩展的 `globalStorage` 中：`…/User/globalStorage/lekra.kimi-companion/patches/<Kimi 版本>/`，包含 `extension.js`、`webview.js` 以及作为完成标记的 `backup.json`（没有标记的未完成备份会被忽略）。只有在每个字节都与清单哈希一致时，恢复才会使用这些文件。`dist` 旁的旧 `*.bak-kimi-companion` 文件不再写入；只有在哈希与清单一致时才会读取它们——用于迁移到该存储，或从完整的已校验文件集恢复。

命令：

- **`Kimi Code: Check Compatibility`**——分析 `dist` 和备份，不写入任何内容，然后打开诊断报告，显示补丁状态、发现的问题和备份详情；
- **`Kimi Code: Install / Repair Patches`**——补上缺失的补丁单元；文件发生变化时提示重新加载，无法安全打补丁时给出警告且不写入；
- **`Kimi Code: Restore Original Files`**——请求确认（对话框按钮为 `Restore Original Files`），写回经过校验的原始文件并提示重新加载。它需要经过校验的备份；没有备份时会警告并保持 `dist` 不变。

## 建议固定（Pin）Kimi 扩展版本

为避免补丁被自动更新冲掉，请在扩展视图中右键 `moonshot-ai.kimi-code` 选择**固定/禁用自动更新**。之后再有意识地手动更新，并运行 **`Kimi Code: Check Compatibility`**：清单中没有的版本会被报告为未知并保持原样，伴侣扩展的相关功能会一直不可用，直到清单覆盖该版本。

## 安装 / 卸载

安装：`code --install-extension kimi-companion-<version>.vsix`（同时必须安装 Kimi Code 扩展），然后重新加载窗口（首次激活会校验并为 Kimi 扩展打补丁，并提示再重载一次）。

卸载：
1. 运行 **`Kimi Code: Restore Original Files`** 并确认。此时先不要重载——只要伴侣扩展仍处于安装状态，下次激活就会重新写入补丁。
2. 卸载本扩展。
3. 重新加载窗口。

手动备用方案（例如伴侣扩展已被删除、命令无法使用）：把 Kimi 扩展 `dist` 目录下的 `extension.js.bak-kimi-companion` 复制回 `extension.js`，`webview.js.bak-kimi-companion` 复制回 `webview.js`；或者直接从应用商店重装 Kimi Code，然后重新加载窗口。

## 设置项

- `kimiCompanion.restoreTabOnStartup`（默认 `true`）——重载后恢复 Kimi 窗口，并在开启期间保存窗口快照（关闭后已保存的快照保持不变）；
- `kimiCompanion.tabCompletionNotification`（默认 `false`）——Kimi 代理在窗口（标签页）中完成一轮对话时发送原生通知；
- `kimiCompanion.tabCompletionSound`（默认 `true`）——同一完成事件播放内置提示音（仅桌面版）；
- `kimiCompanion.tabStatusMarkers`（默认 `true`）——在 Kimi 窗口标题前显示 `[~]` / `[V]` / `[!]` / `[?]` 前缀；
- `kimiCompanion.statusBarButton`（默认 `true`）——状态栏按钮；
- `kimiCompanion.usageInStatusBar`（默认 `true`）——在状态栏显示订阅额度用量百分比；
- `kimiCompanion.deepseekBalance`（默认 `true`）——使用 Kimi Code 配置中的密钥读取 DeepSeek 余额，并显示在用量报告和悬停提示中；关闭后不再发起请求，也不再触发 DeepSeek 低余额告警；
- `kimiCompanion.alerts`（默认 `true`）——用量超过阈值时发送原生通知（每个限额窗口一次；不依赖 `usageInStatusBar`）；
- `kimiCompanion.alertThreshold5h`（默认 `0.8`）——5 小时窗口的告警阈值（小数 `0..1`）；
- `kimiCompanion.alertThresholdMonth`（默认 `0.9`）——月度限额的告警阈值（小数 `0..1`）；
- `kimiCompanion.alertDeepseekBelowUsd`（默认 `1`）——当 DeepSeek 余额低于此金额（美元）时警告。

阈值是小数；手动输入的百分数（`80`）会按 `0.8` 读取，而不是让告警失效。

## 保存的状态与多窗口

已打开的窗口（标题、编辑器列位置、会话）和侧边栏会话保存在工作区状态中；已关闭的窗口另有一份最多 5 条的历史记录。

同一时刻只有一个窗口拥有该快照。租约位于伴侣扩展的 `globalStorage`（`window-restore.lease`），每 5 秒续约一次，超过 15 秒视为已放弃；拥有者窗口停用时释放。**只有租约拥有者会恢复并写入共享快照——其他窗口保持其不变**，也不会把自己的窗口记录进去。

在无法安全重建时，已保存的状态不会被覆盖：

- `kimiCompanion.restoreTabOnStartup` 已关闭；
- 钩子不可用（Kimi 版本未打补丁或未知）；
- 本次激活刚写入补丁，仍需重新加载；
- 另一个窗口持有租约；
- 恢复失败（窗口无法打开，或对话无法挂接）。

下一次重载会从同一快照重试。

会恢复：标题、编辑器列和对话。不会恢复：标签页的实时状态（重载后会重新计算），以及未发送的输入——伴侣扩展不保存按标签页的草稿。

## 用量数据与新鲜度

`Kimi Code: Usage` 和状态栏先通过 Kimi 钩子（`harness.auth.getManagedUsage`）读取额度，失败时回退到使用本地 Kimi 凭据的直接 HTTPS 请求；每个直接请求 12 秒后超时，刷新进行期间到达的触发会合并为一次重新读取，因此卡住的服务器不会阻塞定时器或重复告警。快照超过 2 分钟（或来自未来）时标记为 `stale`；某个限额的重置时间已过时标记为 `refresh-needed`。显示百分比时，状态栏会附加 `⚠ stale` / `↻ refresh needed`，且只有新鲜数据才会触发红色高亮。阈值告警的检查与 `kimiCompanion.usageInStatusBar` 无关。

## 已知限制

- 补丁清单只覆盖 Kimi Code **0.8.2**、**0.8.3** 和 **0.8.4**；其他版本会被报告为未知并保持原样，依赖补丁的功能在清单覆盖该版本前一直不可用。
- 历史记录只在标签页窗口和侧边栏中恢复；全新空对话的窗口恢复后仍为空（保留标题）。
- 如果某个对话已从会话列表中删除，对应窗口恢复后为空。
- 多窗口：只有租约拥有者会恢复并写入共享快照；其他窗口保持其不变，因此在另一个窗口持有租约期间，它们的标题、列位置和历史不会被记录。
- 打开的聊天列表和 `[? N]` 计数器只知道当前 VS Code 窗口中打开的 Kimi 窗口。
- 状态标记和计数器只反映激活之后看到的事件：重载后不会恢复任何状态，也不保存按标签页的草稿或未发送的输入。
- `Kimi Code: Restore Original Files` 会写回经过校验的原始文件，但只要伴侣扩展仍安装，下次激活就会再次打补丁；请在卸载前或排查问题时使用它。
- 状态栏图标为单色（VS Code 限制），因此「K」标志的蓝点在状态栏中显示为单色。
- 完成通知只对在打开的 Kimi 标签页中正常结束的回合生效；侧边栏、已取消或失败的回合、后台与历史回合都不会通知。
- 内置提示音（`resources/completion.wav`）在 Windows 上通过 PowerShell `SoundPlayer` 播放，在 macOS 上使用 `afplay`，在 Linux 上使用 `paplay`（缺少播放器则无声）；Web 与远程会话中不播放声音。
- VS Code 没有可靠的方式让特定窗口闪烁，因此未实现窗口闪烁。
