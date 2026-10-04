# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The status-bar menu no longer lists quota/limit rows (and the now-meaningless "Refresh quota" item) — limits live in the status bar, tooltip and usage report; the menu is for window management only.
- "Rename window" renames the active Kimi window without asking; the picker remains only as a fallback when no active Kimi panel can be determined.
- Booster wallet is read from `boosterWallet` (camelCase, current API) with the legacy `booster_wallet` as a fallback.
- The 5-hour window falls back to the wire `limits[]` rate-window counter when `usages.limit_5h` is absent from the response. The field has appeared and disappeared across API revisions (see 1.3.0 / 1.6.1); whichever source actually carries the 5h data is displayed, with the official `usages.*` field preferred when both exist.
- Quota fetch no longer latches onto an endpoint that answers HTTP 200 but carries no usable limit slots — it tries the next candidate URL, so a stale/emptied endpoint cannot starve the 5-hour window.

### Added

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

[1.6.1]: https://github.com/Lekray/kimi-companion/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/Lekray/kimi-companion/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/Lekray/kimi-companion/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/Lekray/kimi-companion/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Lekray/kimi-companion/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Lekray/kimi-companion/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Lekray/kimi-companion/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lekray/kimi-companion/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Lekray/kimi-companion/releases/tag/v1.0.0
