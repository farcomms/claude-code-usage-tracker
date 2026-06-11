export interface CredentialDeps {
  env: Record<string, string | undefined>;
  homedir: () => string;
  readFileText: (path: string) => string | null;   // null if missing/unreadable
  platform: NodeJS.Platform;
  runKeychain: () => string | null;                 // raw stdout of the security command, or null
}
export type TokenResult = { token: string } | { token: null; reason: "no-credentials" };

function tokenFromJson(raw: string | null): string | null {
  if (!raw) { return null; }
  try {
    const j = JSON.parse(raw);
    return j?.accessToken ?? j?.claudeAiOauth?.accessToken ?? null;
  } catch { return null; }
}

function credentialFilePaths(d: CredentialDeps): string[] {
  const paths: string[] = [];
  const env = d.env.CLAUDE_CONFIG_DIR;
  if (env && env.length > 0) { paths.push(`${env}/.credentials.json`); }
  paths.push(`${d.homedir()}/.claude/.credentials.json`);
  return paths;
}

export function resolveToken(d: CredentialDeps): TokenResult {
  for (const p of credentialFilePaths(d)) {
    const t = tokenFromJson(d.readFileText(p));
    if (t) { return { token: t }; }
  }
  if (d.platform === "darwin") {
    const kcToken = tokenFromJson(d.runKeychain());
    if (kcToken) { return { token: kcToken }; }
  }
  return { token: null, reason: "no-credentials" };
}

// Production deps factory (used by extension.ts).
export function defaultCredentialDeps(): CredentialDeps {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const cp = require("node:child_process") as typeof import("node:child_process");
  return {
    env: process.env,
    homedir: () => os.homedir(),
    readFileText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    platform: process.platform,
    runKeychain: () => {
      try {
        return cp.execFileSync("security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      } catch { return null; }
    },
  };
}
