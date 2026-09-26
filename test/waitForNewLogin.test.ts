import { describe, it, expect } from "vitest";
import { waitForNewLogin, WaitDeps } from "../src/accounts/switcher";
import { LiveLogin } from "../src/types";
import { creds, CRED_FILE } from "./helpers/fakeLogin";

const login = (uuid: string, tok: string): LiveLogin =>
  ({ credentialsRaw: creds(tok), oauthAccount: { accountUuid: uuid }, source: { kind: "file", path: CRED_FILE } });

function deps(reads: (LiveLogin | null)[], cancelAfter = Infinity): WaitDeps & { calls: () => number } {
  let t = 0, i = 0;
  return {
    readLogin: () => reads[Math.min(i++, reads.length - 1)],
    sleep: async (ms) => { t += ms; },
    now: () => t,
    cancelled: () => i >= cancelAfter,
    calls: () => i,
  };
}

const A = login("uuid-a", "tok-a");

describe("waitForNewLogin", () => {
  it("returns the new login once the account changes", async () => {
    const d = deps([A, A, login("uuid-b", "tok-b")]);
    expect((await waitForNewLogin(d, A))?.oauthAccount.accountUuid).toBe("uuid-b");
    expect(d.calls()).toBe(3);
  });

  it("ignores a half-written login (new account block, old tokens) until the tokens change too", async () => {
    const d = deps([login("uuid-b", "tok-a"), login("uuid-b", "tok-b")]);
    const got = await waitForNewLogin(d, A);
    expect(got?.credentialsRaw).toBe(creds("tok-b"));
    expect(d.calls()).toBe(2);
  });

  it("returns null after the timeout", async () => {
    const d = deps([A]);
    expect(await waitForNewLogin(d, A, 2000, 10_000)).toBeNull();
    expect(d.calls()).toBe(5);
  });

  it("checks once more after cancel, so closing the terminal right after logging in still counts", async () => {
    const d = deps([login("uuid-b", "tok-b")], 0); // terminal already closed before the first check
    expect((await waitForNewLogin(d, A))?.oauthAccount.accountUuid).toBe("uuid-b");
    expect(d.calls()).toBe(1);
  });

  it("stops when cancelled with no new login", async () => {
    const d = deps([A], 1);
    expect(await waitForNewLogin(d, A)).toBeNull();
    expect(d.calls()).toBe(1);
  });

  it("with nobody logged in at the start, any login counts", async () => {
    const d = deps([null, login("uuid-b", "tok-b")]);
    expect((await waitForNewLogin(d, null))?.oauthAccount.accountUuid).toBe("uuid-b");
  });
});
