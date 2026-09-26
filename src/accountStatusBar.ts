import * as vscode from "vscode";
import { SavedAccountMeta } from "./types";
import { accountLabel, accountDetail, AccountDisplay } from "./format";

export class AccountStatusBar {
  private item: vscode.StatusBarItem;
  constructor() {
    // Priority 101 > the quota badge's 100, so this sits to its left.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  }

  update(account: SavedAccountMeta | null): void {
    const mode = vscode.workspace.getConfiguration("claudeUsage").get<AccountDisplay>("account.display", "email");
    const text = accountLabel(account, mode);
    if (!text) { this.item.hide(); return; }
    this.item.text = text;
    this.item.command = account ? "claudeUsage.switchAccount" : "claudeUsage.addAccount";
    const md = new vscode.MarkdownString();
    if (account) {
      md.appendText([account.email, accountDetail(account)].filter(Boolean).join(" · "));
      md.appendMarkdown("\n\nClick to switch accounts");
    } else {
      md.appendMarkdown("Claude Code isn't logged in.\n\nClick to add an account");
    }
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void { this.item.dispose(); }
}
