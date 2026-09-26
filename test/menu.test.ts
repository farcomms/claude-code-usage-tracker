import { describe, it, expect } from "vitest";
import { switcherItems } from "../src/accounts/menu";
import { SavedAccountMeta } from "../src/types";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const acct = (uuid: string, email: string, lastUsedAt: string | null, extra: Partial<SavedAccountMeta> = {}): SavedAccountMeta =>
  ({ accountUuid: uuid, email, displayName: null, organizationName: null, subscriptionType: null, lastUsedAt, ...extra });

describe("switcherItems", () => {
  it("puts the active account first with a check, others by most recent use, then actions", () => {
    const items = switcherItems([
      acct("old", "old@x.com", "2026-09-20T12:00:00Z"),
      acct("me", "me@x.com", "2026-09-27T11:00:00Z", { displayName: "Me", subscriptionType: "max" }),
      acct("new", "new@x.com", "2026-09-24T12:00:00Z", { organizationName: "Team" }),
      acct("never", "never@x.com", null),
    ], "me", NOW);

    expect(items.map((i) => i.label)).toEqual([
      "$(check) me@x.com", "$(blank) new@x.com", "$(blank) old@x.com", "$(blank) never@x.com",
      "", "$(add) Add account…", "$(trash) Remove saved account…",
    ]);
    expect(items[0]).toMatchObject({ description: "Me · Max · active", action: { kind: "active" } });
    expect(items[1]).toMatchObject({ description: "Team · last used 3d ago", action: { kind: "switch", uuid: "new" } });
    expect(items[3].description).toBe("never used here");
    expect(items[4].action).toEqual({ kind: "separator" });
    expect(items[5].action).toEqual({ kind: "add" });
    expect(items[6].action).toEqual({ kind: "remove" });
  });

  it("with no saved accounts, offers only Add", () => {
    expect(switcherItems([], null, NOW).map((i) => i.action.kind)).toEqual(["add"]);
  });

  it("offers Remove only when there is a non-active account to remove", () => {
    expect(switcherItems([acct("me", "me@x.com", null)], "me", NOW).map((i) => i.action.kind))
      .toEqual(["active", "separator", "add"]);
  });
});
