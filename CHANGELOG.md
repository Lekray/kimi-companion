# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.3.0]: https://github.com/Lekray/kimi-companion/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Lekray/kimi-companion/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lekray/kimi-companion/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Lekray/kimi-companion/releases/tag/v1.0.0
