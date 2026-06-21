import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { QuotaData, QuotaError, UsageSummary, PriceMap, FileIndex } from "./types";
import { quotaAgeMs } from "./format";
import { resolveToken, defaultCredentialDeps } from "./credentials";
import { fetchQuota, defaultHttpGet } from "./quotaClient";
import { loadPrices, defaultFetcher } from "./pricing";
import { discoverTranscripts, indexFile, readFileFrom, FileStat } from "./transcriptIndexer";
import { summarize } from "./aggregator";
import { StatusBarManager } from "./statusBar";
import { UsageTreeProvider, Section } from "./treeProvider";
import { DashboardPanel } from "./dashboard/panel";

const QUOTA_CACHE = "claudeUsage.quotaCache";
const PRICE_CACHE = "claudeUsage.priceCache";
const FILE_INDEX = "claudeUsage.fileIndex";

export function activate(context: vscode.ExtensionContext): void {
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

  const statusBar = new StatusBarManager();
  const tree = new UsageTreeProvider();
  context.subscriptions.push(statusBar, vscode.window.registerTreeDataProvider("claudeUsage.tree", tree));

  let quota: QuotaData | null = context.globalState.get<QuotaData>(QUOTA_CACHE) ?? null;
  let quotaError: QuotaError | null = null;
  let summary: UsageSummary | null = null;
  let prices: PriceMap = context.globalState.get<PriceMap>(PRICE_CACHE) ?? {};
  let fileIndex: FileIndex = context.globalState.get<FileIndex>(FILE_INDEX) ?? {};

  const dashboard = new DashboardPanel(
    context.extensionUri,
    () => { void refreshAll(); },
    () => ({ summary, quota, error: quotaError, stale: quotaError != null && quota != null }),
  );
  context.subscriptions.push(dashboard);

  function pushUi(): void {
    statusBar.update(quota, quotaError);
    tree.setData(summary, quota);
    dashboard.update();
  }

  async function refreshQuota(): Promise<void> {
    const creds = resolveToken(defaultCredentialDeps());
    const res = await fetchQuota({ token: creds.token }, defaultHttpGet(), () => new Date().toISOString());
    if (res.ok) {
      quota = res.data; quotaError = null;
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
    vscode.commands.registerCommand("claudeUsage.openSection", (section: Section) => dashboard.show(section)),
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

  // Initial load
  pushUi();
  void refreshPrices().then(() => refreshAll()).then(scheduleQuotaPoll);
}

export function deactivate(): void { /* subscriptions disposed by VSCode */ }
