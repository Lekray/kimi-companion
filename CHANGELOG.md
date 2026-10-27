# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `Kimi Code: Open Chats` — a live, searchable picker of the open Kimi chats: waiting for input first, then errors, then the rest in tab order. The search stays native (the full list is handed to VS Code on every refresh and the query is kept), and accepting revalidates the chat against the live list. Also reachable from the editor title bar and the status bar menu.
- `Kimi Code: Next Waiting Chat` and `Kimi Code: Next Chat Needing Attention` — cycle through waiting (or waiting and error) chats with wrap-around; a chat that disappears restarts the cycle.
- A `[? N]` status bar counter of chats waiting for input, shown only while N > 0; clicking it opens the next waiting chat.
- `Kimi Code: Check Compatibility`, `Kimi Code: Install / Repair Patches` and `Kimi Code: Restore Original Files` commands.
- A verified patch manifest (`resources/patch-manifest.json`, schema 1): pristine and patched SHA-256 hashes and sizes for both dist files of Kimi Code 0.8.2 and 0.8.3, plus a fingerprint of the twelve patch units.
- Transactional patching (`lib/patch-dist.js`): a serializing lock, atomic writes (temporary file, `fsync`, rename), pre-write anchor/parse checks, post-write hash/marker/parse checks and rollback to the exact previous bytes.
- A hash-verified pristine backup in the companion's `globalStorage` (`patches/<version>/` with `backup.json` as the commit marker); legacy `.bak-kimi-companion` files are migrated only when their hashes match the manifest.
- A single-owner window lease for the saved snapshot: one window restores and persists titles, columns and sessions, other windows leave the snapshot unchanged.
- Manually renamed windows are persisted as user-named and are never overwritten by auto-naming, even when the title is "Kimi Code".
- New windows opened by the companion (button, `Ctrl+Alt+K`, menu, usage report link) are named after the current project by default: the VS Code workspace name, or the name of the only workspace folder, normalized to single spaces; "Kimi Code" stays the title when neither exists.
- Usage freshness (`fresh` / `stale` / `refresh needed`) in the usage report and the status bar.
- `kimiCompanion.deepseekBalance` (default `true`) to switch the DeepSeek balance request off.

### Fixed

- Saved window state is no longer overwritten when it cannot be rebuilt safely: restoration disabled, hooks unavailable (unpatched or unknown Kimi version), a just-applied patch awaiting reload, another window holding the lease, or a failed restoration. The next reload retries from the same snapshot.
- A failed "Reopen closed window" keeps the entry in the closed history instead of consuming it.
- Direct quota requests time out after 12 s and never overlap; a trigger during an in-flight refresh coalesces into one re-read.
- Quota alerts are evaluated before the `usageInStatusBar` check, so hiding the percent no longer suppresses notifications; the latch re-arms after a limit reset or when usage falls below 90% of the threshold (DeepSeek: once the balance recovers above 1.5× the alert amount).
- DeepSeek balance is not requested when `kimiCompanion.deepseekBalance` is off.
- Consecutive open commands are serialized, so a title/column pair cannot be mixed between windows.
- Auto-naming from the conversation topic now also replaces the project-name default, while restored, hand-typed and other titles stay untouched.

### Changed

- The Kimi dist is patched only for versions in the manifest: an unknown version reports `state: unknown` and writes nothing; a dist matching no known pristine/patched/proven-partial stage is refused as well.
- Quota is read through the Kimi hook (`__kimiCompanionGetUsage`) first and by a direct HTTPS request with the local credentials only as a fallback; direct candidates must be HTTPS, and an endpoint answering without usable limit slots is skipped.
- The 5-hour value keeps preferring the official `usages.limit_5h` field and falls back to the live `limits[]` counter when the official value is frozen, stale-zero or missing; the choice is now tracked across successive responses (`lib/usage-state.js`).
- The status bar appends `⚠ stale` / `↻ refresh needed` when the snapshot is old or past its reset; only fresh data can paint the red highlight.
- Diagnostics reports the last patch operation state, its issues and the backup details.
- Offline unit tests for the patcher, the window lease, the open-chats controller, usage freshness and the restore/persistence rules; CI and `npm test` run them.
- README (en / ru / zh-cn) documents the verified manifest, the patch commands, the backup location, the Open Chats picker and the multi-window behavior.

### Security

- Install and restore only write bytes whose SHA-256 is verified against the manifest; unknown files and unproven partial states are refused without writing.
- Rollback never overwrites a file changed by another process after our write — the change is preserved and reported.
- Backup files are created with owner-only permissions where supported, and patch operations are serialized by a PID-guarded lock that is only broken when its owner is gone or the lock is 10 minutes old.
- Direct quota requests accept only HTTPS endpoints.

## [1.7.2] - 2026-10-18

### Added

- The status bar also shows the booster wallet balance after the quota percents (`$(credit-card) $12.34`), whenever the wallet is present in the usage response.

## [1.7.1] - 2026-10-18

### Fixed

- "Reopen closed window" no longer fills up with windows that are still open: closed history is keyed by session, so auto-naming or renaming a window does not record its old title as a closed window (and a session closed twice is kept once).
- A `[~]` / `[?]` tab marker no longer sticks when a prompt ends without a turn terminal (failure before the turn starts, early error, session close): a twelfth patch (`/*__kimiCompanionPromptSettled__*/` on `settlePrompt`) resolves it to `[V]` / `[!]` / no marker.
- Windows: the completion chime no longer flashes a PowerShell console window (`windowsHide: true`).
- Duplicate quota warnings: status refreshes from the timer, settings changes and the menu now run one at a time, so the alert latch is never read twice.
- A threshold typed as a percent (`80`) is read as `0.8` instead of silently disabling the alert and the red highlight; the settings now declare `minimum` / `maximum`.
- A window renamed by hand to "Kimi Code" is no longer overwritten by auto-naming.

### Security

- The status bar tooltip trusts only the two commands it links to (`kimiCompanion.usage`, `kimiCompanion.open`) instead of all commands, and server-provided window labels, counters and currency codes are reduced to plain text before they reach it.

### Changed

- The Kimi dist (~9 MB) is read and patched asynchronously, so activation no longer blocks the shared extension host; Diagnostics reads each dist file once instead of once per patch unit, and a session without a topic is re-checked for its name every 10 s instead of every 2 s poll.
- Diagnostics lists only the hooks installed by the patches (the companion's own callbacks are always present and told nothing).
- Offline unit tests (`node --test "test/**/*.test.js"`) for quota parsing, slot selection, pace, thresholds, closed history, status markers and patch-unit consistency; run in CI and by `scripts/release.ps1`.
- `scripts/build-vsix.py` registers the `wav` content type and takes the manifest description and engine from `package.nls.json` / `package.json` instead of hardcoded copies.
- README (en / ru / zh-cn): the status bar menu and the red highlight are described as they actually work since 1.6.2, `kimiCompanion.tabStatusMarkers` is listed under Settings, and the patch table has the twelfth unit.

## [1.7.0] - 2026-10-18

### Added

- Tab title status markers (`kimiCompanion.tabStatusMarkers`, default `true`): the title of a Kimi window is prefixed with `[~]` while a turn is running, `[V]` when it completes, `[!]` on failure and `[?]` while the agent waits for an approval or an answer. Fed by three new patches on the Kimi extension (`__kimiCompanionTurnStarted` on the prompt start and `__kimiCompanionWaitA__` / `__kimiCompanionWaitQ__` on the approval/question handlers); a cancelled turn clears the marker. Markers are kept out of persisted window entries, renaming and the completion notification, and auto-naming still works while a marker is shown.

## [1.6.2] - 2026-10-05

### Fixed

- The status-bar menu no longer lists quota/limit rows (and the now-meaningless "Refresh quota" item) — limits live in the status bar, tooltip and usage report; the menu is for window management only.
- "Rename window" renames the active Kimi window without asking; the picker remains only as a fallback when no active Kimi panel can be determined.
- Booster wallet is read from `boosterWallet` (camelCase, current API) with the legacy `booster_wallet` as a fallback.
- The 5-hour window falls back to the wire `limits[]` rate-window counter when `usages.limit_5h` is absent from the response. The field has appeared and disappeared across API revisions (see 1.3.0 / 1.6.1); whichever source actually carries the 5h data is displayed, with the official `usages.*` field preferred when both exist.
- Quota fetch no longer latches onto an endpoint that answers HTTP 200 but carries no usable limit slots — it tries the next candidate URL, so a stale/emptied endpoint cannot starve the 5-hour window.

### Added

- Optional native notification when a Kimi agent turn finishes normally in a tab (`kimiCompanion.tabCompletionNotification`, default `false`), fed by an eighth patch (`__kimiCompanionTurnSettled`) on the Kimi turn terminal; cancelled, failed, background and history turns stay silent.
- Bundled completion chime, independent of the notification and enabled by default (`kimiCompanion.tabCompletionSound`): `resources/completion.wav` played through PowerShell `SoundPlayer` on Windows, `afplay` on macOS and `paplay` on Linux; desktop sessions only. No window flashing — VS Code has no reliable API to flash a specific window.
- The usage report ends with a `Debug:` line and the Output channel logs the fetch path (endpoint keys + slot counts, or the hook fallback) — what the server actually sent is visible without hunting through logs.

### Changed

- The status-bar hot highlight now starts at the configured 5-hour threshold (`kimiCompanion.alertThreshold5h`, default 0.8 = 80% of the window) instead of the depletion forecast, which could flip the color as early as ~73% on a fast pace. The forecast remains as text in the tooltip.

## [1.6.1] - 2026-10-05

### Fixed

- The 5-hour limit is read from the official `usages.limit_5h` field again (same source as the CLI `/usage` and the subscription page); the `limits[]` rate-window counter introduced in 1.3.0 is no longer displayed — it reset on its own schedule and kept the status bar "hot" after the quota had reset. The used/limit counters were removed from the usage report.

## [1.6.0] - 2026-10-04

### Added

- Copilot-style rich tooltip: MarkdownString hover with real progress bar images (dependency-free PNG bars generated at runtime), per-limit pace/forecast lines, booster wallet and DeepSeek balance, and clickable command links (usage report / new window).

### Changed

- The plain-text multi-line status bar tooltip was replaced by the rich markdown tooltip.

## [1.5.1] - 2026-10-04

### Changed

- The status bar menu no longer opens a separate usage document: quota rows are informational and the «Usage report» menu item was removed (the `Kimi Code: Usage` command stays available in the command palette).

## [1.5.0] - 2026-10-04

### Added

- Copilot-style status bar menu: quota rows with right-side values, usage bars and pace/reset details, actions (Usage report, Refresh quota, New window, Reopen closed window) and open-window focus list; menu is localized to the VS Code UI language (en/ru/zh-cn).

### Changed

- The status bar now shows two values, monthly limit first then the 5-hour window (`M 16% · 5h 82%`), instead of a single max value.

## [1.4.0] - 2026-10-04

### Added

- Pace indicator with depletion forecast and reset countdown in the `Kimi Code: Usage` report and in the status bar tooltip: every quota window shows its spend pace (`fast` / `normal` / `slow` / `idle`), whether it will last until the reset or depletes in ~X, and the time left until the reset.
- Red status bar background (`errorBackground`) when a short window (≤ 1 day) is projected to deplete before its reset at the current pace.
- Threshold alerts with a per-window latch: native VS Code notifications when the 5-hour window reaches its threshold (default 80%), the monthly limit reaches 90%, or the DeepSeek balance drops below $1 — fired once per window and re-armed after the reset / recovery.
- Settings `kimiCompanion.alerts` (default `true`), `kimiCompanion.alertThreshold5h` (default `0.8`), `kimiCompanion.alertThresholdMonth` (default `0.9`), `kimiCompanion.alertDeepseekBelowUsd` (default `1`).

### Fixed

- The quota endpoint is no longer hardcoded: `base_url` is read from the Kimi Code config (`[providers."managed:kimi-code"]`) and from `KIMI_CODE_BASE_URL`, with fallback across the mirrors (`api.kimi.com` / `api.kimi.ai`) and caching of the working URL — fixes quota for accounts where only one of the mirrors works.

## [1.3.0] - 2026-10-04

### Added

- DeepSeek balance in the `Kimi Code: Usage` report and in the status bar tooltip (uses the `[providers.deepseek]` key from the Kimi Code config, `api.deepseek.com/user/balance`).
- Live rate-window counters (used/limit) in the usage report.

### Fixed

- 5-hour usage no longer shows 0%: it is now computed from the live `limits[].detail` counter of `api.kimi.com/coding/v1/usages` instead of the stale `limit_5h.used_ratio` field; quota is fetched directly with the local OAuth token, the in-extension hook remains a fallback.

## [1.2.0] - 2026-10-04

### Added

- `Kimi Code: Usage` — the current subscription quota (5h / 7d / monthly limits plus the booster wallet) as a separate report.
- Usage percent of the limit in the status bar, refreshed every 5 minutes (`kimiCompanion.usageInStatusBar`, default `true`).
- Status bar button click opens a QuickPick menu: Usage, New window, Reopen closed window, and the list of open windows to focus.
- `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS) — open a new Kimi window.
- `Kimi Code: Diagnostics` — a state report: versions, status of all 7 patches, hooks, windows, saved state.
- A 7th patch to the Kimi extension: the `__kimiCompanionGetUsage` hook in `extension.js` (subscription quota via `harness.auth.getManagedUsage`).

## [1.1.0] - 2026-10-04

### Added

- Localization EN / RU / ZH (`package.nls.json`, `package.nls.ru.json`, `package.nls.zh-cn.json`).
- English runtime UI strings.
- README in three languages (`README.md`, `README.ru.md`, `README.zh-CN.md`).
- MIT `LICENSE` and `NOTICE`.
- Gallery banner and the public GitHub release.

## [1.0.0] - 2026-10-04

### Added

- Restore Kimi windows after "Developer: Reload Window" — with their titles, editor column, and conversation history (tabs and sidebar).
- Rename Kimi windows (`Kimi Code: Rename Window`).
- Automatic window titles from the conversation topic.
- Reopen the last closed Kimi windows (up to 5).
- Editor title bar buttons (open, rename) and a status bar button.
- Self-healing patches for the Kimi extension.
- Recommended pinned Kimi extension version.

[1.7.2]: https://github.com/Lekray/kimi-companion/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/Lekray/kimi-companion/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/Lekray/kimi-companion/compare/v1.6.2...v1.7.0
[1.6.2]: https://github.com/Lekray/kimi-companion/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/Lekray/kimi-companion/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/Lekray/kimi-companion/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/Lekray/kimi-companion/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/Lekray/kimi-companion/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Lekray/kimi-companion/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Lekray/kimi-companion/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Lekray/kimi-companion/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lekray/kimi-companion/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Lekray/kimi-companion/releases/tag/v1.0.0
