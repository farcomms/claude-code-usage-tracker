import { SavedAccountMeta, SavedAccountSecret } from "../types";
import { oauthOf } from "./claudeLogin";

// Structural subsets of vscode.SecretStorage and vscode.Memento, so this module
// stays free of `vscode` and unit-tests with in-memory fakes.
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const ACCOUNTS_INDEX = "claudeUsage.accounts";
export const secretKey = (uuid: string): string => `claudeUsage.account.${uuid}`;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function metaFor(s: SavedAccountSecret, lastUsedAt: string | null): SavedAccountMeta {
  const a = s.oauthAccount;
  return {
    accountUuid: a.accountUuid,
    email: str(a.emailAddress) ?? str(a.displayName) ?? a.accountUuid.slice(0, 8),
    displayName: str(a.displayName),
    organizationName: str(a.organizationName),
    subscriptionType: str(oauthOf(s.credentialsRaw)?.subscriptionType),
    lastUsedAt,
  };
}

/** Saved accounts: secrets in SecretStorage, a token-free index in globalState. */
export class AccountStore {
  constructor(private readonly secrets: SecretStore, private readonly state: KeyValueStore) {}

  list(): SavedAccountMeta[] { return this.state.get<SavedAccountMeta[]>(ACCOUNTS_INDEX) ?? []; }

  async get(uuid: string): Promise<SavedAccountSecret | null> {
    const raw = await this.secrets.get(secretKey(uuid));
    if (!raw) { return null; }
    try { return JSON.parse(raw) as SavedAccountSecret; } catch { return null; }
  }

  async save(s: SavedAccountSecret): Promise<"added" | "updated" | "unchanged"> {
    const uuid = s.oauthAccount.accountUuid;
    const value = JSON.stringify({ credentialsRaw: s.credentialsRaw, oauthAccount: s.oauthAccount });
    const prev = this.list().find((m) => m.accountUuid === uuid);
    if (prev && (await this.secrets.get(secretKey(uuid))) === value) { return "unchanged"; }
    await this.secrets.store(secretKey(uuid), value);
    await this.writeIndex(uuid, metaFor(s, prev?.lastUsedAt ?? null));
    return prev ? "updated" : "added";
  }

  async remove(uuid: string): Promise<void> {
    await this.secrets.delete(secretKey(uuid));
    await this.state.update(ACCOUNTS_INDEX, this.list().filter((m) => m.accountUuid !== uuid));
  }

  async touch(uuid: string, nowIso: string): Promise<void> {
    const m = this.list().find((x) => x.accountUuid === uuid);
    if (m) { await this.writeIndex(uuid, { ...m, lastUsedAt: nowIso }); }
  }

  private async writeIndex(uuid: string, meta: SavedAccountMeta): Promise<void> {
    await this.state.update(ACCOUNTS_INDEX, [...this.list().filter((m) => m.accountUuid !== uuid), meta]);
  }
}
