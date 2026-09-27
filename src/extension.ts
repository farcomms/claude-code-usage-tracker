import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { QuotaData, QuotaError, UsageSummary, PriceMap, FileIndex, SavedAccountMeta } from "./types";
import { quotaAgeMs, quotaForAccount, accountDetail } from "./format";
import { resolveToken, defaultCredentialDeps } from "./credentials";
import { fetchQuota, defaultHttpGet } from "./quotaClient";
import { loadPrices, defaultFetcher } from "./pricing";
import { discoverTranscripts, indexFile, readFileFrom, FileStat } from "./transcriptIndexer";
import { summarize } from "./aggregator";
import { StatusBarManager } from "./statusBar";
import { UsageTreeProvider, Section } from "./treeProvider";
import { DashboardPanel } from "./dashboard/panel";
import { AccountStore } from "./accounts/accountStore";
import { defaultLoginDeps, readLogin } from "./accounts/claudeLogin";
import { defaultHttpPost } from "./accounts/tokenRefresh";
import { syncActive, switchTo, waitForNewLogin } from "./accounts/switcher";
import { switcherItems, MenuAction } from "./accounts/menu";
import { findClaude, defaultCliDeps, loginTerminal, installerCommand, installTerminal, INSTALL_GUIDE_URL, TerminalSpec } from "./accounts/claudeCli";
import { AccountStatusBar } from "./accountStatusBar";

const QUOTA_CACHE = "claudeUsage.quotaCache";
const PRICE_CACHE = "claudeUsage.priceCache";
const FILE_INDEX = "claudeUsage.fileIndex";

// How long Add Account waits for the login to appear; longer when it installs Claude Code first.
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const SECTIONS: { section: Section; label: string }[] = [
  { section: "overview", label: "Overview" }, { section: "quota", label: "Quota" },
  { section: "projects", label: "Project Usage" }, { section: "models", label: "Model Usage" },
  { section: "sessions", label: "Sessions" },
];

export function activate(context: vscode.ExtensionContext): void {
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

  const statusBar = new StatusBarManager();
  const tree = new UsageTreeProvider();
  context.subscriptions.push(statusBar, vscode.window.registerTreeDataProvider("claudeUsage.tree", tree));

  const accountBar = new AccountStatusBar();
  const accounts = new AccountStore(context.secrets, context.globalState);
  const loginDeps = defaultLoginDeps();
  let activeAccount: SavedAccountMeta | null = null;
  let accountBusy = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  context.subscriptions.push(accountBar);

  let quota: QuotaData | null = context.globalState.get<QuotaData>(QUOTA_CACHE) ?? null;
  let quotaError: QuotaError | null = null;
  let summary: UsageSummary | null = null;
  let prices: PriceMap = context.globalState.get<PriceMap>(PRICE_CACHE) ?? {};
  let fileIndex: FileIndex = context.globalState.get<FileIndex>(FILE_INDEX) ?? {};

  const dashboard = new DashboardPanel(
    context.extensionUri,
    () => { void refreshAll(); },
    () => ({
      summary, quota: quotaForAccount(quota, activeAccount?.accountUuid ?? null), error: quotaError,
      stale: quotaError != null && quota != null, account: activeAccount?.email ?? null,
    }),
  );
  context.subscriptions.push(dashboard);

  function pushUi(): void {
    const shown = quotaForAccount(quota, activeAccount?.accountUuid ?? null);
    accountBar.update(activeAccount);
    statusBar.update(shown, quotaError);
    tree.setData(summary, shown, activeAccount?.email ?? null);
    dashboard.update();
  }

  // Auto-save (spec §4.3): runs on every quota refresh: startup, poll, focus.
  async function refreshAccount(): Promise<void> {
    if (accountBusy) { return; } // an account change in progress owns the login until it finishes
    try {
      const live = await syncActive(loginDeps, accounts, sleep);
      activeAccount = live ? accounts.list().find((m) => m.accountUuid === live.oauthAccount.accountUuid) ?? null : null;
    } catch { /* keep the last known account; saving is retried on the next refresh */ }
  }

  async function refreshQuota(): Promise<void> {
    await refreshAccount();
    const creds = resolveToken(defaultCredentialDeps());
    const res = await fetchQuota({ token: creds.token }, defaultHttpGet(), () => new Date().toISOString());
    if (res.ok) {
      quota = { ...res.data, accountUuid: activeAccount?.accountUuid ?? null }; quotaError = null;
      await context.globalState.update(QUOTA_CACHE, quota);
    } else {
      quotaError = res.error; // keep last-good `quota` for the stale badge
    }
  }

  async function refreshPrices(): Promise<void> {
    const url = vscode.workspace.getConfiguration("claudeUsage")
      .get<string>("pricingUrl", "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json");
    const r = await loadPrices(url, defaultFetcher(), Object.keys(prices).length ? prices : null);
    prices = r.prices;
    if (!r.fromCache) { await context.globalState.update(PRICE_CACHE, prices); }
  }

  function rebuildSummary(): void {
    const entries = Object.values(fileIndex);
    const all = entries.flatMap((e) => e.records);
    const errorIds = new Set(entries.flatMap((e) => e.errorIds ?? []));
    const edits = entries.flatMap((e) => e.edits ?? []).filter((x) => !errorIds.has(x.toolUseId));
    summary = summarize(all, prices, new Date(), edits);
  }

  async function refreshTranscripts(): Promise<void> {
    for (const file of discoverTranscripts(projectsDir)) {
      let stat: FileStat;
      try { const s = fs.statSync(file); stat = { size: s.size, mtimeMs: s.mtimeMs }; } catch { continue; }
      const prev = fileIndex[file] ?? null;
      if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) { continue; }
      fileIndex[file] = indexFile(prev, stat, (off) => readFileFrom(file, off));
    }
    await context.globalState.update(FILE_INDEX, fileIndex);
    rebuildSummary();
  }

  async function refreshAll(): Promise<void> {
    await Promise.allSettled([refreshQuota(), refreshTranscripts()]);
    pushUi();
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsage.refresh", () => refreshAll()),
    vscode.commands.registerCommand("claudeUsage.showDashboard", () => dashboard.show()),
    vscode.commands.registerCommand("claudeUsage.openSection", async (section?: Section) => {
      const s = section ?? (await vscode.window.showQuickPick(
        SECTIONS.map((x) => ({ label: x.label, section: x.section })), { placeHolder: "Open a dashboard section" }))?.section;
      if (s) { dashboard.show(s); }
    }),
    vscode.commands.registerCommand("claudeUsage.switchAccount", () => switchAccount()),
    vscode.commands.registerCommand("claudeUsage.addAccount", () => addAccount()),
    vscode.commands.registerCommand("claudeUsage.removeAccount", () => removeAccount()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("claudeUsage")) { pushUi(); } }),
  );

  // Transcript file watcher (debounced)
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectsDir, "**/*.jsonl"));
  let debounce: NodeJS.Timeout | undefined;
  const onChange = () => {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(() => { void refreshTranscripts().then(pushUi); }, 1500);
  };
  watcher.onDidChange(onChange); watcher.onDidCreate(onChange); watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  // Quota polling: every N seconds while the window is focused, with simple backoff on error.
  let pollTimer: NodeJS.Timeout | undefined;
  let backoffSteps = 0;
  const BACKOFF = [4 * 60_000, 8 * 60_000, 16 * 60_000];
  function scheduleQuotaPoll(): void {
    if (pollTimer) { clearTimeout(pollTimer); }
    const base = vscode.workspace.getConfiguration("claudeUsage").get<number>("pollIntervalSeconds", 120) * 1000;
    const delay = quotaError ? BACKOFF[Math.min(backoffSteps, BACKOFF.length - 1)] : base;
    pollTimer = setTimeout(async () => {
      if (vscode.window.state.focused) {
        await refreshQuota();
        backoffSteps = quotaError ? backoffSteps + 1 : 0;
        pushUi();
      }
      scheduleQuotaPoll();
    }, delay);
  }
  context.subscriptions.push({ dispose: () => pollTimer && clearTimeout(pollTimer) });
  context.subscriptions.push({ dispose: () => { if (debounce) { clearTimeout(debounce); } } });

  // Refetch when the window regains focus, so the status bar is never stale
  // right after switching back. Guarded by a minimum age so rapid alt-tabbing
  // can't hammer the API; rescheduling the poll keeps the timer a full
  // interval away from this fetch.
  const FOCUS_REFRESH_MIN_AGE_MS = 30_000;
  context.subscriptions.push(vscode.window.onDidChangeWindowState((e) => {
    if (!e.focused || quotaAgeMs(quota, new Date()) < FOCUS_REFRESH_MIN_AGE_MS) { return; }
    void refreshQuota().then(() => {
      if (!quotaError) { backoffSteps = 0; }
      pushUi();
      scheduleQuotaPoll();
    });
  }));

  // ---------- Accounts ----------
  async function afterAccountChange(): Promise<void> {
    await refreshQuota();
    if (!quotaError) { backoffSteps = 0; }
    pushUi();
    scheduleQuotaPoll();
  }

  async function switchAccount(): Promise<void> {
    const items = switcherItems(accounts.list(), activeAccount?.accountUuid ?? null, Date.now())
      .map((it): vscode.QuickPickItem & { action: MenuAction } => it.action.kind === "separator"
        ? { label: "", kind: vscode.QuickPickItemKind.Separator, action: it.action }
        : { label: it.label, description: it.description, action: it.action });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Switch Claude Code account" });
    if (!pick) { return; }
    if (pick.action.kind === "add") { return addAccount(); }
    if (pick.action.kind === "remove") { return removeAccount(); }
    if (pick.action.kind === "switch") { return runSwitch(pick.action.uuid); }
  }

  // One account change at a time. Returns undefined when another is running.
  async function exclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (accountBusy) { void vscode.window.showInformationMessage("An account change is already in progress."); return undefined; }
    accountBusy = true;
    try { return await fn(); } finally { accountBusy = false; }
  }

  async function runSwitch(uuid: string): Promise<void> {
    const target = accounts.list().find((m) => m.accountUuid === uuid);
    if (!target) { return; }
    const previous = activeAccount;
    const res = await exclusive(async () => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Switching to ${target.email}…` },
      () => switchTo(uuid, { login: loginDeps, store: accounts, httpPost: defaultHttpPost(), now: Date.now, sleep })));
    if (!res) { return; }

    if (res.ok) {
      await afterAccountChange();
      void vscode.window.showInformationMessage(
        `Switched to ${res.account.email}. Restart any running Claude Code sessions so they pick it up.`);
    } else if (res.reason === "expired") {
      const again = await vscode.window.showWarningMessage(`${target.email}'s saved login has expired.`, "Log in again");
      if (again) { await addAccount(); }
    } else {
      const tail = res.restored === true ? " Your previous account was restored."
        : res.restored === false && previous
          ? ` Claude Code's login may be incomplete. Your previous account (${previous.email}) is still saved; pick it from Switch Account to go back.`
        : res.restored === false ? " Claude Code's login may be incomplete. Run `claude /login` if it stops working." : "";
      void vscode.window.showErrorMessage(`Couldn't switch to ${target.email}: ${res.message.replace(/\.$/, "")}.${tail}`);
      await afterAccountChange();
    }
  }

  async function addAccount(): Promise<void> {
    if (accountBusy) { void vscode.window.showInformationMessage("An account change is already in progress."); return; }
    // Log in with the installed `claude` (by full path, so it works even when
    // it isn't on PATH), or, with the user's consent, install it first.
    const claude = findClaude(defaultCliDeps());
    let spec: TerminalSpec;
    let timeoutMs = LOGIN_TIMEOUT_MS;
    if (claude) {
      spec = loginTerminal(claude, process.platform);
    } else {
      const pathNote = process.platform === "win32" ? ", adds it to your user PATH," : ",";
      const choice = await vscode.window.showWarningMessage(
        "Claude Code isn't installed. Adding an account needs it to sign in. Install it now?",
        { modal: true, detail: `This runs Anthropic's official installer in a terminal${pathNote} then starts the login:\n\n${installerCommand(process.platform)}` },
        "Install and log in", "Open install guide");
      if (choice === "Open install guide") { void vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE_URL)); return; }
      if (choice !== "Install and log in") { return; }
      spec = installTerminal(process.platform);
      timeoutMs = INSTALL_TIMEOUT_MS;
    }

    const added = await exclusive(async () => {
      const start = await syncActive(loginDeps, accounts, sleep);
      const term = vscode.window.createTerminal({
        name: claude ? "Claude login" : "Install Claude Code", shellPath: spec.shellPath, shellArgs: spec.shellArgs, env: spec.env,
      });
      term.show();
      if (spec.text) { term.sendText(spec.text); }
      let closed = false;
      const sub = vscode.window.onDidCloseTerminal((t) => { if (t === term) { closed = true; } });
      try {
        const live = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "Waiting for Claude login…" },
          () => waitForNewLogin({
            readLogin: () => readLogin(loginDeps),
            sleep,
            now: Date.now,
            cancelled: () => closed,
          }, start, 2000, timeoutMs));
        if (live) {
          await accounts.save({ credentialsRaw: live.credentialsRaw, oauthAccount: live.oauthAccount });
          await accounts.touch(live.oauthAccount.accountUuid, new Date().toISOString());
        }
        return live;
      } finally { sub.dispose(); }
    });
    if (!added) { return; }

    await afterAccountChange();
    const email = accounts.list().find((m) => m.accountUuid === added.oauthAccount.accountUuid)?.email ?? "account";
    void vscode.window.showInformationMessage(`Added ${email}.`);
  }

  async function removeAccount(): Promise<void> {
    const removable = accounts.list().filter((m) => m.accountUuid !== activeAccount?.accountUuid);
    if (removable.length === 0) {
      void vscode.window.showInformationMessage("No saved accounts to remove. The active account can't be removed while it's logged in.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      removable.map((m) => ({ label: m.email, description: accountDetail(m), uuid: m.accountUuid })),
      { placeHolder: "Remove a saved account" });
    if (!pick) { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Remove the saved login for ${pick.label}? This doesn't log you out of Claude Code.`, { modal: true }, "Remove");
    if (confirm !== "Remove") { return; }
    await exclusive(async () => { // never while a switch is writing this account
      await accounts.remove(pick.uuid);
      pushUi();
    });
  }

  // Initial load
  pushUi();
  void refreshAccount().then(pushUi);
  void refreshPrices().then(() => refreshAll()).then(scheduleQuotaPoll);
}

export function deactivate(): void { /* subscriptions disposed by VSCode */ }
