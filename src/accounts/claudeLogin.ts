import { credentialFilePaths } from "../credentials";
import { CredentialSource, LiveLogin, OauthAccount, OauthTokens } from "../types";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface LoginDeps {
  env: Record<string, string | undefined>;
  homedir: () => string;
  platform: NodeJS.Platform;
  username: () => string;
  readFileText: (path: string) => string | null;     // null if missing/unreadable
  writeFileAtomic: (path: string, text: string) => void;   // temp file + rename; throws on failure
  keychainRead: () => { account: string; secret: string } | null;
  keychainWrite: (account: string, secret: string) => void; // throws on failure
}

export function claudeJsonPath(d: Pick<LoginDeps, "env" | "homedir">): string {
  const dir = d.env.CLAUDE_CONFIG_DIR;
  return dir && dir.length > 0 ? `${dir}/.claude.json` : `${d.homedir()}/.claude.json`;
}

function parse(raw: string | null): any {
  if (!raw) { return null; }
  try { return JSON.parse(raw); } catch { return null; }
}

/** The token-bearing object: `claudeAiOauth`, or the top level in the older flat shape. */
export function oauthOf(credentialsRaw: string): OauthTokens | null {
  const j = parse(credentialsRaw);
  const t = j?.claudeAiOauth ?? j;
  return t && typeof t.accessToken === "string" ? (t as OauthTokens) : null;
}

/** Swap in new tokens, keeping the credentials' shape and every other key. */
export function withOauth(credentialsRaw: string, tokens: OauthTokens): string {
  const j = parse(credentialsRaw) ?? {};
  return JSON.stringify(j.claudeAiOauth ? { ...j, claudeAiOauth: tokens } : { ...j, ...tokens });
}

function readOauthAccount(d: LoginDeps): OauthAccount | null {
  const a = parse(d.readFileText(claudeJsonPath(d)))?.oauthAccount;
  return a && typeof a.accountUuid === "string" ? (a as OauthAccount) : null;
}

/** Claude Code's current login, looked up in the same order as `resolveToken`. */
export function readLogin(d: LoginDeps): LiveLogin | null {
  const oauthAccount = readOauthAccount(d);
  if (!oauthAccount) { return null; }
  for (const path of credentialFilePaths(d)) {
    const raw = d.readFileText(path);
    if (raw && oauthOf(raw)) { return { credentialsRaw: raw, oauthAccount, source: { kind: "file", path } }; }
  }
  if (d.platform === "darwin") {
    const kc = d.keychainRead();
    if (kc && oauthOf(kc.secret)) {
      return { credentialsRaw: kc.secret, oauthAccount, source: { kind: "keychain", account: kc.account } };
    }
  }
  return null;
}

/**
 * Where to write credentials when nobody is logged in: the first location that readLogin
 * would read AND that already holds a token. Falls back to the current behavior only if
 * none holds a token (Keychain under d.username() on macOS; first file elsewhere).
 */
export function defaultSource(d: LoginDeps): CredentialSource {
  // Check each file path in order (same order as readLogin)
  for (const path of credentialFilePaths(d)) {
    const raw = d.readFileText(path);
    if (raw && oauthOf(raw)) {
      return { kind: "file", path };
    }
  }
  // Check Keychain on darwin
  if (d.platform === "darwin") {
    const kc = d.keychainRead();
    if (kc && oauthOf(kc.secret)) {
      return { kind: "keychain", account: kc.account };
    }
  }
  // Fall back to current behavior when nothing holds a token
  return d.platform === "darwin"
    ? { kind: "keychain", account: d.username() }
    : { kind: "file", path: credentialFilePaths(d)[0] };
}

export function writeCredentials(d: LoginDeps, source: CredentialSource, credentialsRaw: string): void {
  if (source.kind === "keychain") { d.keychainWrite(source.account, credentialsRaw); return; }
  d.writeFileAtomic(source.path, credentialsRaw);
}

/**
 * Replace only `oauthAccount` in .claude.json. Claude Code rewrites this file
 * often, so it is read fresh here, immediately before writing, never reused.
 */
export function writeOauthAccount(d: LoginDeps, account: OauthAccount): void {
  const path = claudeJsonPath(d);
  const j = parse(d.readFileText(path));
  if (!j || typeof j !== "object") { throw new Error(`${path} is missing or not valid JSON`); }
  j.oauthAccount = account;
  d.writeFileAtomic(path, JSON.stringify(j, null, 2));
}

/**
 * One `security -i` line that creates or updates the item. The secret is
 * hex-encoded (-X), so it needs no quoting and never appears in any process's argv.
 */
export function keychainAddCommand(account: string, secret: string): string {
  if (/["\\\n]/.test(account)) { throw new Error("Unsupported Keychain account name"); }
  const hex = Buffer.from(secret, "utf8").toString("hex");
  return `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -X ${hex}\n`;
}

/** The `acct` attribute from `security find-generic-password` (no -w) output. */
export function parseKeychainAccount(attrs: string): string | null {
  const m = attrs.match(/"acct"<blob>="([^"]*)"/);
  return m ? m[1] : null;
}

// Production deps factory (used by extension.ts).
export function defaultLoginDeps(): LoginDeps {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const cp = require("node:child_process") as typeof import("node:child_process");
  const security = (args: string[]) => cp.execFileSync("security", args,
    { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString();
  return {
    env: process.env,
    homedir: () => os.homedir(),
    platform: process.platform,
    username: () => os.userInfo().username,
    readFileText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    writeFileAtomic: (p, text) => {
      let mode = 0o600;
      try { mode = fs.statSync(p).mode & 0o777; } catch { /* new file keeps 0600 */ }
      const tmp = `${p}.claude-usage-${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode });
      fs.renameSync(tmp, p);
    },
    keychainRead: () => {
      try {
        const secret = security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]).trim();
        const account = parseKeychainAccount(security(["find-generic-password", "-s", KEYCHAIN_SERVICE]));
        return { account: account ?? os.userInfo().username, secret };
      } catch { return null; }
    },
    keychainWrite: (account, secret) => {
      cp.execFileSync("security", ["-i"],
        { input: keychainAddCommand(account, secret), timeout: 5000, stdio: ["pipe", "ignore", "pipe"] });
    },
  };
}
