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

/** Where to write credentials when nobody is logged in: where Claude Code looks first. */
export function defaultSource(d: LoginDeps): CredentialSource {
  return d.platform === "darwin"
    ? { kind: "keychain", account: d.username() }
    : { kind: "file", path: credentialFilePaths(d)[0] };
}
