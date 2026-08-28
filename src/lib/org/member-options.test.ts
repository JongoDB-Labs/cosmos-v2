// COSMOS-171 — "the user names are not sorted". The members route returns rows
// in `joinedAt` order, so every assign-users picker listed people in join order.
// These lock the ordering and the label the sort (and the search) reads.
import { describe, it, expect } from "vitest";

import { memberLabel, memberOptions } from "./member-options";

const member = (userId: string, displayName?: string | null, email?: string) => ({
  userId,
  user: { displayName: displayName ?? null, email: email ?? `${userId}@x.co` },
});

describe("memberOptions", () => {
  it("sorts by display name ascending, regardless of the incoming order", () => {
    const options = memberOptions([
      member("u1", "Zoe Chen"),
      member("u2", "Ada Lovelace"),
      member("u3", "Grace Hopper"),
    ]);

    expect(options).toEqual([
      { value: "u2", label: "Ada Lovelace" },
      { value: "u3", label: "Grace Hopper" },
      { value: "u1", label: "Zoe Chen" },
    ]);
  });

  it("compares case-insensitively, so ALL-CAPS names do not cluster first", () => {
    const options = memberOptions([
      member("u1", "bob"),
      member("u2", "ALICE"),
      member("u3", "Carol"),
    ]);

    expect(options.map((o) => o.label)).toEqual(["ALICE", "bob", "Carol"]);
  });

  it("breaks label ties on the id, so equal names keep a stable order", () => {
    const a = memberOptions([member("u2", "Sam"), member("u1", "Sam")]);
    const b = memberOptions([member("u1", "Sam"), member("u2", "Sam")]);

    expect(a.map((o) => o.value)).toEqual(["u1", "u2"]);
    expect(b.map((o) => o.value)).toEqual(a.map((o) => o.value));
  });

  it("falls back to the email, then to Unknown — never a raw id", () => {
    expect(memberLabel(member("u1", null, "ana@x.co"))).toBe("ana@x.co");
    expect(memberLabel({ userId: "u2" })).toBe("Unknown");
    // A blank display name is not a name; it must not win over the email.
    expect(memberLabel(member("u3", "   ", "kim@x.co"))).toBe("kim@x.co");
  });

  it("sorts by the fallback label too, so email-only members are placed", () => {
    const options = memberOptions([
      member("u1", "Zoe Chen"),
      member("u2", null, "ana@x.co"),
    ]);

    expect(options.map((o) => o.label)).toEqual(["ana@x.co", "Zoe Chen"]);
  });

  it("does not mutate the array it was given", () => {
    const members = [member("u1", "Zoe Chen"), member("u2", "Ada Lovelace")];
    memberOptions(members);
    expect(members.map((m) => m.userId)).toEqual(["u1", "u2"]);
  });
});
