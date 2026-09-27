# Changelog

All notable changes to **Claude Code Usage & Quota Dashboard** are listed here.

## [0.3.1] — 2026-09-27

### Added
- **Add Account can install Claude Code for you.** If Claude Code isn't installed, Add Account asks whether to install it with Anthropic's official installer, then starts the login. Nothing is installed unless you confirm, and **Open install guide** is offered instead if you'd rather do it yourself.
- On Windows, the install also adds Claude Code's folder (`%USERPROFILE%\.local\bin`) to your user PATH if it's missing, so `claude` works in new terminals.

### Fixed
- **Add Account works when `claude` isn't on your PATH.** It now finds Claude Code in its default install folder and runs it from there, instead of failing with "claude is not recognized".
- **Windows: project names.** Project Usage and Sessions show the folder name (`myproject`) instead of the full Windows path.
- **Windows: lines-of-code file types** are detected correctly for Windows file paths.
- **Windows: switching accounts** retries briefly when Windows reports Claude Code's login file as busy, instead of failing straight away.
- **macOS and Linux:** Add Account no longer depends on your default terminal shell.

## [0.3.0] — 2026-09-27

### Added
- **Multiple Claude accounts.** Every account you log into is saved, and you can switch Claude Code between them from the status bar. Switching changes Claude Code's own login, so the `claude` CLI and the quota view both move to the chosen account.
  - **Claude Usage: Switch Account** lists your saved accounts. The active one is checked, and the rest are sorted by when you last used them.
  - **Claude Usage: Add Account** opens a terminal to log in to another account, and saves it automatically.
  - **Claude Usage: Remove Saved Account** forgets a saved account without logging you out.
  - If a saved account's login has expired, it's renewed automatically when you switch to it.
  - If a switch fails partway, your previous login is put back.
- **Account on the status bar.** The current account's email is shown to the left of the quota badge. Choose the email, the display name, or nothing with the new `claudeUsage.account.display` setting.
- **7-day usage on the status bar.** The badge now ends with your 7-day usage percentage, after the 5-hour countdown.
- The Quota section and dashboard tab show which account the numbers belong to.
- All commands are grouped under **Claude Usage** in the Command Palette, and **Open Section** asks which section to open.

### Changed
- After a switch, the quota badge shows `—` until the new account's quota arrives, instead of briefly showing the previous account's numbers.

### Notes
- Saved logins are kept only in VS Code's SecretStorage, which is encrypted by your operating system's keychain.
- Restart any Claude Code sessions that are already running after you switch accounts, so they pick up the new login.
- Usage and cost figures cover everything on this machine, not each account separately, because Claude Code's logs don't record which account made each request.

## [0.2.0] — 2026-06-22

### Added
- Lines of code written by Claude (accepted edits), by project and model.
- A token-usage-over-time graph on the dashboard.

### Changed
- Dashboard tabs reordered. Clicking the status-bar badge opens the Quota tab.

## [0.1.0] — 2026-06-13

### Added
- First release: your Claude Code subscription quota (5-hour, 7-day and per-model windows, plus extra credits) on the status bar and in a dashboard.
- Token usage and estimated cost by project, model and session, calculated from your local Claude Code logs.
- The quota refreshes when the VS Code window regains focus.
