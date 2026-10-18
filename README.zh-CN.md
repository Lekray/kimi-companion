# Kimi Code Companion

官方 **Kimi Code** VS Code 扩展（`moonshot-ai.kimi-code`）的伴侣扩展，为它补上缺失的实用功能：

- **在「Developer: Reload Window」之后恢复 Kimi 窗口**——包括自定义标题、编辑器列位置以及**对话历史记录**；
- **按钮**：编辑器标题栏中的 Kimi 图标（新建窗口）、旁边的铅笔图标（重命名窗口），以及状态栏右侧的「K Kimi Code」按钮；
- **重命名 Kimi 窗口**（`Kimi Code: Rename Window`）；
- **根据对话主题自动命名窗口**（当窗口仍叫「Kimi Code」时，自动取会话的 `title`/`lastPrompt` 作为标题）；
- **`Kimi Code: Reopen Closed Window`**——重新打开最近关闭的 Kimi 窗口（最多记住 5 个）；
- **`Kimi Code: Usage`**——以单独的报告显示当前订阅额度（5 小时 / 7 天 / 每月限额以及 booster 钱包），并显示消耗速度、耗尽预测以及距重置的倒计时；
- **Usage 报告与状态栏悬停提示中的 DeepSeek 余额**（读取 Kimi Code 配置中的 `[providers.deepseek]` 键）；
- **阈值告警**——带「每个窗口只触发一次」闩锁的原生 VS Code 通知：5 小时窗口 ≥ 80%、月度限额 ≥ 90%、DeepSeek 余额低于 $1（设置项 `kimiCompanion.alerts`、`kimiCompanion.alertThreshold5h`、`kimiCompanion.alertThresholdMonth`、`kimiCompanion.alertDeepseekBelowUsd`）；
- **任务完成提示音与通知**——Kimi 代理在某标签页中正常完成一轮对话时，默认播放短促的提示音，也可单独启用带窗口标题的原生通知（设置项 `kimiCompanion.tabCompletionNotification`、`kimiCompanion.tabCompletionSound`）；
- **标签页标题状态标记**——窗口标题前显示实时状态：`[~]` 进行中，`[V]` 已完成，`[!]` 出错，`[?]` 等待您的批准或回答（`kimiCompanion.tabStatusMarkers`）；
- **状态栏显示用量**——两个数值：先显示月度限额，再显示 5 小时窗口，外加 booster 钱包余额（例如 `M 16% · 5h 82% · 💳 $12.34`），每 5 分钟刷新一次（设置项 `kimiCompanion.usageInStatusBar`）；当短窗口（≤ 1 天）达到 `kimiCompanion.alertThreshold5h` 阈值（默认 80%）时，状态栏变为红色；把鼠标悬停在按钮上会打开 Copilot 风格的丰富面板——每个限额都有带重置日期的标题、大号百分比和图形进度条（真实图像，运行时生成；达到同一阈值时显示为红色）、消耗速度与预测行、booster 钱包和 DeepSeek 余额，底部还有可点击的操作链接（用量报告 / 新建窗口）；
- **状态栏菜单**——点击状态栏按钮打开菜单：操作项（刷新用量、新建窗口、重新打开已关闭的窗口）以及已打开窗口的聚焦列表；菜单中不再重复显示额度——额度显示在状态栏、其悬停提示和 `Kimi Code: Usage` 报告中；「刷新用量」会重新获取数据并再次打开菜单；菜单与悬停提示按 VS Code 界面语言本地化（en / ru / zh-cn，消耗速度相关短语仍为英文）；
- **`Ctrl+Alt+K`**（macOS 为 `Cmd+Alt+K`）——新建 Kimi 窗口；
- **`Kimi Code: Diagnostics`**——状态报告：版本、全部 12 处补丁、钩子、窗口、已保存的状态；
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
| 7 | extension.js | `__kimiCompanionGetUsage` | 通过 `harness.auth.getManagedUsage` 获取订阅额度的钩子（备用路径——伴侣扩展通常直接读取额度） |
| 8 | extension.js | `/*__kimiCompanionTurnSettled__*/` | 回合终态（`emitTerminal`）上报到 `globalThis.__kimiCompanionTurnSettled`——标签页完成通知 |
| 9 | extension.js | `__kimiCompanionTurnStarted` | 提示词开始（`this.activePrompt = active`）上报到 `globalThis.__kimiCompanionTurnStarted`——`[~]` 状态 |
| 10 | extension.js | `/*__kimiCompanionWaitA__*/` | 包装审批处理器：待处理/已解决的审批上报到 `globalThis.__kimiCompanionWaiting`——`[?]` 状态 |
| 11 | extension.js | `/*__kimiCompanionWaitQ__*/` | 同样包装问题处理器——`[?]` 状态 |
| 12 | extension.js | `/*__kimiCompanionPromptSettled__*/` | 每次提示结束（`settlePrompt`）都报告给 `globalThis.__kimiCompanionPromptSettled`——当提示在没有回合终止事件的情况下结束（启动前失败、早期错误、会话关闭）时清除 `[~]`/`[?]` |

原始文件保留在旁：`extension.js.bak-kimi-companion`、`webview.js.bak-kimi-companion`。

**自愈机制：** 每次激活时，伴侣扩展会校验所有标记并补齐缺失的补丁（例如 Kimi 更新之后），然后提示重新加载窗口。如果在新版 Kimi 中找不到锚点，会弹出警告并列出缺失的标记——上表即为修复指南。

## 建议固定（Pin）Kimi 扩展版本

为避免补丁被自动更新冲掉，请在扩展视图中右键 `moonshot-ai.kimi-code` 选择**固定/禁用自动更新**。之后再有意识地手动更新，让伴侣扩展重新打补丁并重新加载窗口即可。

## 安装 / 卸载

安装：`code --install-extension kimi-companion-<version>.vsix`，然后重新加载窗口（首次激活会为 Kimi 扩展打补丁并提示再重载一次）。

卸载：
1. 卸载本扩展；
2. 还原原始文件：把 Kimi 扩展 `dist` 目录下的 `extension.js.bak-kimi-companion` 复制回 `extension.js`，`webview.js.bak-kimi-companion` 复制回 `webview.js`（或者直接从应用商店重装 Kimi Code）；
3. 重新加载窗口。

## 设置项

- `kimiCompanion.restoreTabOnStartup`（默认 `true`）——重载后恢复 Kimi 窗口；
- `kimiCompanion.tabCompletionNotification`（默认 `false`）——Kimi 代理在窗口（标签页）中完成一轮对话时发送原生通知；
- `kimiCompanion.tabCompletionSound`（默认 `true`）——同一完成事件播放内置提示音（仅桌面版）；
- `kimiCompanion.tabStatusMarkers`（默认 `true`）——在 Kimi 窗口标题前显示 `[~]` / `[V]` / `[!]` / `[?]` 前缀；
- `kimiCompanion.statusBarButton`（默认 `true`）——状态栏按钮；
- `kimiCompanion.usageInStatusBar`（默认 `true`）——在状态栏显示订阅额度用量百分比；
- `kimiCompanion.alerts`（默认 `true`）——用量超过阈值时发送原生通知（每个限额窗口一次）；
- `kimiCompanion.alertThreshold5h`（默认 `0.8`）——5 小时窗口的告警阈值（小数 `0..1`）；
- `kimiCompanion.alertThresholdMonth`（默认 `0.9`）——月度限额的告警阈值（小数 `0..1`）；
- `kimiCompanion.alertDeepseekBelowUsd`（默认 `1`）——当 DeepSeek 余额低于此金额（美元）时警告。

## 已知限制

- 历史记录只在标签页窗口和侧边栏中恢复；全新空对话的窗口恢复后仍为空（保留标题）；
- 如果某个对话已从会话列表中删除，对应窗口恢复后为空；
- 状态栏图标为单色（VS Code 限制），因此「K」标志的蓝点在状态栏中显示为单色。
- 完成通知只对在打开的 Kimi 标签页中正常结束的回合生效；侧边栏、已取消或失败的回合、后台与历史回合都不会通知。
- 内置提示音（`resources/completion.wav`）在 Windows 上通过 PowerShell `SoundPlayer` 播放，在 macOS 上使用 `afplay`，在 Linux 上使用 `paplay`（缺少播放器则无声）；Web 与远程会话中不播放声音。
- VS Code 没有可靠的方式让特定窗口闪烁，因此未实现窗口闪烁。
