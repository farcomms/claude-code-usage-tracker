#!/usr/bin/env node
// Manual pre-flight for multi-account switching (spec §2). Never prints a token.
//
//   1. While logged in as account A:   node scripts/verify-account-switching.mjs snapshot
//   2. Log in as account B:            claude /login
//   3. Then:                           node scripts/verify-account-switching.mjs check
//
// `check` uses up A's snapshotted refresh token (renewal rotates it), so log in
// as A again normally afterwards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SNAP = path.join(os.homedir(), ".claude-usage-verify.json");
const envDir = process.env.CLAUDE_CONFIG_DIR;
const credFiles = [...(envDir ? [path.join(envDir, ".credentials.json")] : []), path.join(os.homedir(), ".claude", ".credentials.json")];
const claudeJson = envDir ? path.join(envDir, ".claude.json") : path.join(os.homedir(), ".claude.json");

function readCreds() {
  for (const p of credFiles) {
    try { return { where: `file ${p}`, json: JSON.parse(fs.readFileSync(p, "utf8")) }; } catch { /* next */ }
  }
  if (process.platform === "darwin") {
    try {
      const raw = cp.execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      return { where: "macOS Keychain", json: JSON.parse(raw) };
    } catch { /* none */ }
  }
  return null;
}
const tokensOf = (c) => c?.claudeAiOauth ?? (c?.accessToken ? c : null);
function account() {
  try { return JSON.parse(fs.readFileSync(claudeJson, "utf8")).oauthAccount ?? null; } catch { return null; }
}

const cmd = process.argv[2];
if (cmd === "snapshot") {
  const c = readCreds(), t = tokensOf(c?.json), a = account();
  if (!t?.refreshToken || !a?.accountUuid) { console.log("No complete Claude Code login found. Log in with `claude` first."); process.exit(1); }
  fs.rmSync(SNAP, { force: true });
  fs.writeFileSync(SNAP, JSON.stringify({ uuid: a.accountUuid, email: a.emailAddress, refreshToken: t.refreshToken, scopes: t.scopes ?? [] }), { mode: 0o600 });
  console.log(`Saved a snapshot of ${a.emailAddress ?? a.accountUuid}.`);
  console.log(`Credentials found in: ${c.where}; shape: ${c.json.claudeAiOauth ? "{ claudeAiOauth: {...} }" : "flat"}`);
  console.log(`Credential fields: ${Object.keys(t).sort().join(", ")}`);
  console.log(`oauthAccount fields: ${Object.keys(a).sort().join(", ")}`);
  console.log("\nNow run `claude /login`, log in as a DIFFERENT account, then run this script with `check`.");
} else if (cmd === "check") {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(SNAP, "utf8")); } catch { console.log("No snapshot. Run `snapshot` first."); process.exit(1); }
  const now = account();
  if (!now || now.accountUuid === snap.uuid) { console.log(`Still logged in as ${snap.email}. Log in as a different account first.`); process.exit(1); }
  const body = { grant_type: "refresh_token", refresh_token: snap.refreshToken, client_id: CLIENT_ID };
  if (snap.scopes.length) { body.scope = snap.scopes.join(" "); }
  let res, text;
  try {
    res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    text = await res.text();
  } catch (err) {
    console.log(`NO: could not reach the token endpoint (${err.message}). The snapshot was kept — fix the network and run \`check\` again.`);
    process.exit(1);
  }
  fs.unlinkSync(SNAP);
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status === 200 && typeof j?.access_token === "string") {
    console.log(`YES: ${snap.email}'s saved refresh token still works after logging in as ${now.emailAddress ?? now.accountUuid}.`);
    console.log(`Response fields: ${Object.keys(j).sort().join(", ")}; expires_in = ${j.expires_in}s; new refresh_token returned: ${typeof j.refresh_token === "string"}`);
    console.log(`\nLog in as ${snap.email} again with \`claude /login\` when you want it back (this check used up its snapshotted token).`);
  } else {
    console.log(`NO: token endpoint answered HTTP ${res.status}${j?.error ? ` (${j.error})` : ""}.`);
    console.log(j?.error === "invalid_grant"
      ? "The saved refresh token was revoked by logging in as another account."
      : "This may be an endpoint/request problem rather than revocation; report this output.");
  }
} else {
  console.log("Usage: node scripts/verify-account-switching.mjs snapshot|check");
}
