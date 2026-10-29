# Kimi Code Companion

Companion extension for the official **Kimi Code** VS Code extension (`moonshot-ai.kimi-code`). It adds the quality-of-life features the stock extension lacks:

- **Restores Kimi windows after "Developer: Reload Window"** — with their custom titles, editor column, and **conversation history**;
- **Buttons**: a Kimi icon in the editor title bar (new window), a pencil next to it (rename window), a list icon (Open Chats), and a "K Kimi Code" button on the right side of the status bar;
- **Rename Kimi windows** (`Kimi Code: Rename Window`) — a title typed by hand is saved and survives a reload, and auto-naming never replaces it again;
- **Windows named after the project** — a window opened by the companion (button, `Ctrl+Alt+K`, menu) starts with the current workspace name instead of "Kimi Code";
- **Automatic window titles from the conversation topic** (while a window still carries a default title — "Kimi Code" or the project name it was opened with — the title is taken from the session's `title`/`lastPrompt`);
- **`Kimi Code: Reopen Closed Window`** — reopens the last closed Kimi window (remembers up to 5); if reopening fails, the entry stays in the history so it can be retried;
- **`Kimi Code: Open Chats`** — a live, searchable picker of the open Kimi chats: chats waiting for input first, then errors, then the rest in tab order; the search stays native (typing filters the list and the query survives live refreshes), and the picked chat is revalidated against the live list before it is revealed; also available from the editor title bar and the status bar menu;
- **`Kimi Code: Next Waiting Chat`** / **`Kimi Code: Next Chat Needing Attention`** — reveal the next waiting chat (or the next waiting/error chat), cycling through the list and wrapping around; a chat that disappears restarts the cycle;
- **[? N] counter** in the status bar — how many Kimi chats wait for input; it appears only while N > 0, and clicking it opens the next waiting chat;
- **`Kimi Code: Usage`** — the current subscription quota (5h / 7d / monthly limits plus the booster wallet) as a separate report, with pace, depletion forecast and reset countdown;
- **DeepSeek balance in the Usage report and status bar tooltip** (reads the `[providers.deepseek]` key from the Kimi Code config; `kimiCompanion.deepseekBalance`, on by default);
- **Threshold alerts** — native VS Code notifications with a per-window latch: the 5-hour window at ≥ 80%, the monthly limit at ≥ 90%, and the DeepSeek balance below $1 (`kimiCompanion.alerts`, `kimiCompanion.alertThreshold5h`, `kimiCompanion.alertThresholdMonth`, `kimiCompanion.alertDeepseekBelowUsd`); they fire even when the usage percent is hidden from the status bar, and re-arm after the limit resets or usage falls back below the threshold;
- **Turn-completion alert** — a short chime by default and an optional native notification with the window title when a Kimi agent turn finishes normally in a tab (`kimiCompanion.tabCompletionNotification`, `kimiCompanion.tabCompletionSound`);
- **Tab status markers** — the window title is prefixed with its live state: `[~]` working, `[V]` done, `[!]` error, `[?]` waiting for your approval or answer (`kimiCompanion.tabStatusMarkers`);
- **Usage in the status bar** — two values, the monthly limit first and then the 5-hour window, plus the booster wallet balance (e.g. `M 16% · 5h 82% · 💳 $12.34`), refreshed every 5 minutes (`kimiCompanion.usageInStatusBar`); the bar turns red when a short window (≤ 1 day) reaches the `kimiCompanion.alertThreshold5h` threshold (80% by default) and the snapshot is fresh; **hovering the button opens a rich Copilot-style panel** — for every limit a header with its reset date, a large percent and a graphical progress bar (a real image generated at runtime, red at the same threshold), a pace/forecast line, the booster wallet and the DeepSeek balance, and clickable action links (usage report / new window); stale data is labelled `⚠ stale` or `↻ refresh needed`;
- **Status bar menu** — clicking the button opens a QuickPick with the actions (Refresh quota, New window, Reopen closed window, Open windows) and the list of open windows to focus; "Open windows" opens the searchable picker described above; limits are not repeated there — they live in the status bar, its tooltip and the `Kimi Code: Usage` report; Refresh quota refetches the data and reopens the menu; the menu and the tooltip are localized to the VS Code UI language (en / ru / zh-cn; pace phrases stay English);
- **`Ctrl+Alt+K`** (`Cmd+Alt+K` on macOS) — new Kimi window;
- **`Kimi Code: Diagnostics`** — a state report: versions, all 12 patches, the last patch operation with its backup, hooks, windows, saved state;
- **`Kimi Code: Check Compatibility`**, **`Kimi Code: Install / Repair Patches`**, **`Kimi Code: Restore Original Files`** — hash-verified, transactional patching against a manifest of Kimi Code **0.8.2**, **0.8.3** and **0.8.4**; an unknown Kimi version is reported and never patched;
- Restores the conversation in the Kimi **sidebar** as well.

Activity log: View → Output → channel **"Kimi Code Companion"**.

## Screenshots

![Editor title bar buttons](docs/img/title-buttons.png)

*Editor title bar buttons*

![Status bar button with usage percent](docs/img/statusbar.png)

*Status bar button with usage percent*

![Restored windows with custom titles and history](docs/img/windows.png)

*Restored windows with custom titles and history*

> **Unofficial project.** Not affiliated with Moonshot AI. "Kimi" and the Kimi logo belong to Moonshot AI. Distributed under the MIT license; the bundled `kimi-icon.svg` comes from the Apache-2.0-licensed Kimi Code extension (see `NOTICE`).

## How it works (and why it patches the Kimi extension)

VS Code does not let one extension touch another extension's webview panels (neither retitle them nor read their session). So the companion applies twelve tiny patches to the Kimi extension's `dist` — they register panels and hooks in `globalThis` (the shared extension-host scope):

| # | File | Marker | Purpose |
|---|------|--------|---------|
| 1 | extension.js | `__kimiCompanionNextTitle` | new tab title is taken from `globalThis.__kimiCompanionNextTitle` |
| 2 | extension.js | `/*__kimiCompanion__*/` | created panels are tracked in `globalThis.__kimiCompanionPanels` |
| 3 | extension.js | `__kimiCompanionNextColumn` | new tab column from `globalThis.__kimiCompanionNextColumn` |
| 4 | extension.js | `/*__kimiCompanion2__*/` | hooks `__kimiCompanionGetSessionId / GetWebviewId / LoadSession` |
| 5 | extension.js | `__kimiCompanionGetSidebarId` | sidebar webview id hook |
| 6 | webview.js | `__kimiCompanionLoadSessionInUi` | webview handler for `__kimiCompanionLoadSession` — the stock `loadSessionHistory → loadSession` flow |
| 7 | extension.js | `__kimiCompanionGetUsage` | subscription quota hook via `harness.auth.getManagedUsage` — the first path; the companion falls back to a direct HTTPS read with the local credentials |
| 8 | extension.js | `/*__kimiCompanionTurnSettled__*/` | the turn terminal (`emitTerminal`) is reported to `globalThis.__kimiCompanionTurnSettled` — the tab-completion notification |
| 9 | extension.js | `__kimiCompanionTurnStarted` | a prompt start (`this.activePrompt = active`) is reported to `globalThis.__kimiCompanionTurnStarted` — the `[~]` status |
| 10 | extension.js | `/*__kimiCompanionWaitA__*/` | the approval handler is wrapped: pending/resolved approvals are reported to `globalThis.__kimiCompanionWaiting` — the `[?]` status |
| 11 | extension.js | `/*__kimiCompanionWaitQ__*/` | same wrapper on the question handler — the `[?]` status |
| 12 | extension.js | `/*__kimiCompanionPromptSettled__*/` | every prompt end (`settlePrompt`) is reported to `globalThis.__kimiCompanionPromptSettled` — clears `[~]`/`[?]` when a prompt ends without a turn terminal (preflight failure, early error, session close) |

The only anchor that moved between these releases is the webview unit: in 0.8.2/0.8.3 the session-history store of the bundle is `Qe`, while 0.8.4 renamed it to `Ve`. The companion therefore keeps one webview anchor variant per bundle shape and picks the variant by Kimi version.

**Self-healing:** on every activation the companion runs the install operation. For a supported version it verifies the dist against the manifest and applies only what is missing (e.g. after a Kimi update); if the bytes match no known pristine, patched or proven partial stage, nothing is written and a warning names the problem. If an anchor can't be found for a new Kimi version, the patch table above is the repair guide.

## Patch commands and the verified manifest

The companion only patches a Kimi Code version listed in `resources/patch-manifest.json` (schema 1). It currently covers **0.8.2**, **0.8.3** and **0.8.4**; for both dist files the manifest records the SHA-256 and size of the pristine and of the patched file, plus a fingerprint of the patch units selected for that version (0.8.4 carries its own, because of the webview anchor above).

Every install and restore is transactional:

- a lock file in the backup directory serializes patch operations (a lock whose process is gone, or that is 10 minutes old, is broken);
- files are written through a temporary file, `fsync` and a rename, so an interrupted operation leaves the previous file intact instead of a half-written one;
- the result is checked before writing (every anchor occurs exactly once and the patched text parses) and after writing (file hashes, all twelve markers, parse);
- if anything fails, the exact previous bytes are put back; a file changed by another process after the write is preserved and reported instead of being overwritten.

An **unknown Kimi version is never patched**: the operation reports `state: unknown`, writes nothing, and the hooks stay unavailable until the manifest gets an entry for that version. A dist that matches no known pristine/patched/partial stage is refused the same way.

The pristine originals live in the companion's `globalStorage`: `…/User/globalStorage/lekra.kimi-companion/patches/<kimi-version>/` holds `extension.js`, `webview.js` and `backup.json` as the commit marker (a half-written backup without the marker is ignored). A restore uses these files only if every byte matches the manifest hash. The old `*.bak-kimi-companion` files next to the dist are no longer written; they are read only when they hash-match the manifest, to migrate them into that store or to restore from a complete verified set.

Commands:

- **`Kimi Code: Check Compatibility`** — analyses the dist and the backup without writing anything, then opens the Diagnostics report with the patch state, its issues and the backup details;
- **`Kimi Code: Install / Repair Patches`** — applies the missing units; offers a reload when files changed, and warns (writing nothing) when the state cannot be patched safely;
- **`Kimi Code: Restore Original Files`** — asks for confirmation (the dialog button is "Restore Original Files"), writes the verified originals back and offers a reload. It needs the verified backup; without one it warns and leaves the dist alone.

## Pin your Kimi extension version (recommended)

To keep the patches from being wiped by a random auto-update, pin `moonshot-ai.kimi-code` (Extensions view → right-click the extension → **Pin** / disable auto-update for it). Update consciously and run **`Kimi Code: Check Compatibility`** afterwards: a version that is not in the manifest is reported as unknown and left untouched, so the companion's features stay off until the manifest covers it.

## Install / uninstall

Install: `code --install-extension kimi-companion-<version>.vsix` (the Kimi Code extension must be installed as well), then reload the window — the first activation verifies and patches the Kimi extension and offers one more reload.

Uninstall:
1. Run **`Kimi Code: Restore Original Files`** and confirm. Do not reload yet — while the companion is still installed, its next activation would apply the patches again.
2. Remove this extension.
3. Reload the window.

Manual fallback, if the command cannot help (for example the companion is already gone): copy `extension.js.bak-kimi-companion` over `extension.js` and `webview.js.bak-kimi-companion` over `webview.js` in the Kimi extension's `dist`, or reinstall Kimi Code from the Marketplace; then reload the window.

## Settings

- `kimiCompanion.restoreTabOnStartup` (default `true`) — restore Kimi windows after a reload, and save the window snapshot while enabled (turning it off leaves the saved snapshot untouched);
- `kimiCompanion.tabCompletionNotification` (default `false`) — native notification when a Kimi agent turn finishes normally in a window/tab;
- `kimiCompanion.tabCompletionSound` (default `true`) — bundled chime on the same completion (desktop sessions only);
- `kimiCompanion.tabStatusMarkers` (default `true`) — prefix Kimi window titles with `[~]` / `[V]` / `[!]` / `[?]`;
- `kimiCompanion.statusBarButton` (default `true`) — the status bar button;
- `kimiCompanion.usageInStatusBar` (default `true`) — show the subscription usage percent in the status bar;
- `kimiCompanion.deepseekBalance` (default `true`) — read the DeepSeek balance with the key from the Kimi Code config and show it in the usage report and tooltip; turning it off stops the request and the DeepSeek low-balance alert;
- `kimiCompanion.alerts` (default `true`) — native notifications when a usage threshold is crossed (once per limit window; they do not require `usageInStatusBar`);
- `kimiCompanion.alertThreshold5h` (default `0.8`) — alert threshold for the 5-hour window (fraction `0..1`);
- `kimiCompanion.alertThresholdMonth` (default `0.9`) — alert threshold for the monthly limit (fraction `0..1`);
- `kimiCompanion.alertDeepseekBelowUsd` (default `1`) — warn when the DeepSeek balance drops below this amount (USD).

Thresholds are fractions; a percent typed by hand (`80`) is read as `0.8` instead of disabling the alert.

## Saved state and multiple windows

The open windows (title, editor column, session) and the sidebar session are saved in the workspace state; closed windows are kept in a separate history of up to 5.

One window owns that snapshot at a time. The lease lives in the companion's `globalStorage` (`window-restore.lease`), is refreshed by a heartbeat every 5 s and is considered abandoned after 15 s; it is released when the owning window deactivates. **Only the lease owner restores and writes the shared snapshot — every other window leaves it unchanged** and does not record its own windows for it.

The saved state is preserved, not overwritten, whenever it cannot be rebuilt safely:

- `kimiCompanion.restoreTabOnStartup` is off;
- the hooks are unavailable (the Kimi version is unpatched or unknown);
- this activation just patched files, so a reload is still pending;
- another window holds the lease;
- restoration failed (a window could not be opened, or a conversation could not be attached).

The next reload then retries from the same snapshot.

Restored: the title, the editor column and the conversation. Not restored: the live tab status markers (they are recomputed after the reload) and unsent input — per-tab drafts are not saved.

## Usage data and freshness

`Kimi Code: Usage` and the status bar read the quota through the Kimi hook (`harness.auth.getManagedUsage`) first and fall back to a direct HTTPS request with the local Kimi credentials; every direct request times out after 12 s, and triggers that arrive during a refresh coalesce into a single re-read, so a stalled endpoint cannot block the timer or duplicate alerts. A snapshot is marked `stale` when it is older than 2 minutes (or comes from the future) and `refresh-needed` when a limit's reset time has already passed; while the percent is shown, the status bar appends `⚠ stale` / `↻ refresh needed`, and only fresh data can paint the red highlight. Threshold alerts are evaluated regardless of `kimiCompanion.usageInStatusBar`.

## Known limitations

- Only Kimi Code **0.8.2**, **0.8.3** and **0.8.4** are covered by the patch manifest; any other version is reported as unknown and left untouched, so the patch-dependent features stay unavailable until the manifest covers it.
- History is restored in tab windows and in the sidebar; a window that had a brand-new empty conversation restores empty (titled).
- If a conversation was deleted from the session list, its window restores empty.
- Multiple windows: only the lease owner restores and persists the shared snapshot; other windows leave it unchanged, so their titles, columns and history are not recorded while another window owns the lease.
- The Open Chats picker and the `[? N]` counter only know Kimi windows open in the current VS Code window.
- Status markers and the counter reflect events seen since activation: no status is restored after a reload, and per-tab drafts/unsent input are not saved.
- `Kimi Code: Restore Original Files` writes the verified originals, but while the companion stays installed its next activation applies the patches again; use it right before uninstalling or while troubleshooting.
- Status bar icons are single-color (VS Code limitation), so the blue dot of the "K" mark is monochrome there.
- The turn-completion notification fires only for turns that end normally in an open Kimi tab; the sidebar, cancelled or failed turns, and background or history turns stay silent.
- The bundled chime (`resources/completion.wav`) is played through PowerShell `SoundPlayer` on Windows, `afplay` on macOS and `paplay` on Linux (a missing player means silence); web and remote sessions stay silent.
- VS Code has no reliable API to flash the specific window on completion, so window flashing is not implemented.
