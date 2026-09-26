import { LoginDeps } from "../../src/accounts/claudeLogin";

export const CLAUDE_JSON = "/home/u/.claude.json";
export const CRED_FILE = "/home/u/.claude/.credentials.json";

export interface FakeLogin {
  deps: LoginDeps;
  files: Map<string, string>;
  keychain: { account: string; secret: string } | null;
  writes: string[];            // targets written, in order: a file path or "keychain"
}

export interface FakeLoginOpts {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  keychain?: { account: string; secret: string } | null;
  /** Return true to make the write to this target (path or "keychain") throw. */
  failWrite?: (target: string) => boolean;
  /** Keychain writes "succeed" but change nothing (like `security -i` swallowing an error). */
  keychainNoop?: boolean;
}

export function fakeLogin(opts: FakeLoginOpts = {}): FakeLogin {
  const files = new Map(Object.entries(opts.files ?? {}));
  const f: FakeLogin = { files, keychain: opts.keychain ?? null, writes: [], deps: undefined as unknown as LoginDeps };
  f.deps = {
    env: opts.env ?? {},
    homedir: () => "/home/u",
    platform: opts.platform ?? "linux",
    username: () => "u",
    readFileText: (p) => files.get(p) ?? null,
    writeFileAtomic: (p, text) => {
      f.writes.push(p);
      if (opts.failWrite?.(p)) { throw new Error(`EACCES: ${p}`); }
      files.set(p, text);
    },
    keychainRead: () => f.keychain,
    keychainWrite: (account, secret) => {
      f.writes.push("keychain");
      if (opts.failWrite?.("keychain")) { throw new Error("keychain write failed"); }
      if (!opts.keychainNoop) { f.keychain = { account, secret }; }
    },
  };
  return f;
}

export function creds(accessToken: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: {
    accessToken, refreshToken: `r-${accessToken}`, expiresAt: 10_000_000,
    scopes: ["user:inference", "user:profile"], subscriptionType: "max", ...extra,
  } });
}

export function claudeJson(
  account: Record<string, unknown> | null,
  other: Record<string, unknown> = { numStartups: 7, projects: { "/p": { allowedTools: [] } } },
): string {
  return JSON.stringify(account ? { ...other, oauthAccount: account } : other);
}
