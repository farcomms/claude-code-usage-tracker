import { describe, it, expect } from "vitest";
import { AccountStore, ACCOUNTS_INDEX, metaFor, secretKey } from "../src/accounts/accountStore";
import { MemorySecrets, MemoryState } from "./helpers/memoryStores";
import { creds } from "./helpers/fakeLogin";

const A = { accountUuid: "uuid-a", emailAddress: "a@x.com", displayName: "Ann", organizationName: "Personal" };
const secretA = { credentialsRaw: creds("tok-a"), oauthAccount: A };

function fresh() {
  const secrets = new MemorySecrets(), state = new MemoryState();
  return { secrets, state, store: new AccountStore(secrets, state) };
}

describe("AccountStore", () => {
  it("adds, then reports unchanged, then updated when tokens change", async () => {
    const { store } = fresh();
    expect(await store.save(secretA)).toBe("added");
    expect(await store.save(secretA)).toBe("unchanged");
    expect(await store.save({ ...secretA, credentialsRaw: creds("tok-a2") })).toBe("updated");
    expect(store.list()).toHaveLength(1);
    expect(await store.get("uuid-a")).toEqual({ ...secretA, credentialsRaw: creds("tok-a2") });
  });

  it("builds a token-free index entry", async () => {
    const { store, state } = fresh();
    await store.save(secretA);
    expect(store.list()).toEqual([{
      accountUuid: "uuid-a", email: "a@x.com", displayName: "Ann", organizationName: "Personal",
      subscriptionType: "max", lastUsedAt: null,
    }]);
    const indexJson = JSON.stringify(state.map.get(ACCOUNTS_INDEX));
    expect(indexJson).not.toContain("tok-a");
    expect(indexJson).not.toContain("r-tok-a");
  });

  it("keeps lastUsedAt across saves, and touch sets it", async () => {
    const { store } = fresh();
    await store.save(secretA);
    await store.touch("uuid-a", "2026-09-27T10:00:00.000Z");
    await store.save({ ...secretA, credentialsRaw: creds("tok-a2") });
    expect(store.list()[0].lastUsedAt).toBe("2026-09-27T10:00:00.000Z");
  });

  it("removes both the secret and the index entry", async () => {
    const { store, secrets } = fresh();
    await store.save(secretA);
    await store.remove("uuid-a");
    expect(store.list()).toEqual([]);
    expect(secrets.map.has(secretKey("uuid-a"))).toBe(false);
    expect(await store.get("uuid-a")).toBeNull();
  });

  it("returns null for a corrupt secret", async () => {
    const { store, secrets } = fresh();
    secrets.map.set(secretKey("uuid-z"), "{oops");
    expect(await store.get("uuid-z")).toBeNull();
  });
});

describe("metaFor", () => {
  it("falls back when email is missing: display name, then a uuid prefix", () => {
    expect(metaFor({ credentialsRaw: "{}", oauthAccount: { accountUuid: "abcdef123456", displayName: "Bo" } }, null).email).toBe("Bo");
    expect(metaFor({ credentialsRaw: "{}", oauthAccount: { accountUuid: "abcdef123456" } }, null).email).toBe("abcdef12");
    expect(metaFor({ credentialsRaw: "{}", oauthAccount: { accountUuid: "abcdef123456", emailAddress: "" } }, null).email).toBe("abcdef12");
  });
});
