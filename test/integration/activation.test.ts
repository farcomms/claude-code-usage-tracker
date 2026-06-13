import * as assert from "node:assert";
import * as vscode from "vscode";

suite("activation", () => {
  test("registers commands", async () => {
    const ext = vscode.extensions.getExtension("farcomms.farcomms-claude-code-quota-dashboard");
    assert.ok(ext, "extension present");
    await ext!.activate();
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes("claudeUsage.refresh"));
    assert.ok(cmds.includes("claudeUsage.showDashboard"));
    assert.ok(cmds.includes("claudeUsage.openSection"));
  });
});
