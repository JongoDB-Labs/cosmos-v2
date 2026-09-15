import { describe, it, expect } from "vitest";

import {
  filterMemberOptions,
  matchesMemberQuery,
  memberDisplayName,
  memberPickerOptions,
} from "@/lib/org/member-picker";

const member = (
  userId: string,
  displayName: string | null,
  email?: string | null,
) => ({ userId, user: { displayName, email } });

describe("memberPickerOptions (COSMOS-171)", () => {
  it("sorts by displayed name, ascending and case-insensitively", () => {
    const options = memberPickerOptions([
      member("u1", "zoe adams", "zoe@x.co"),
      member("u2", "Ana Beltran", "ana@x.co"),
      member("u3", "bob Carr", "bob@x.co"),
    ]);

    expect(options.map((o) => o.label)).toEqual([
      "Ana Beltran",
      "bob Carr",
      "zoe adams",
    ]);
  });

  it("falls back to email, then the user id, and sorts on that fallback", () => {
    const options = memberPickerOptions([
      member("u1", "Mia", "mia@x.co"),
      member("u2", null, "abe@x.co"),
      { userId: "zz-no-user" },
    ]);

    expect(options.map((o) => o.label)).toEqual(["abe@x.co", "Mia", "zz-no-user"]);
    expect(memberDisplayName(member("u9", "   ", "fallback@x.co"))).toBe(
      "fallback@x.co",
    );
  });

  it("breaks ties on user id so equal names keep a stable order", () => {
    const options = memberPickerOptions([
      member("u2", "Alex"),
      member("u1", "alex"),
    ]);

    expect(options.map((o) => o.value)).toEqual(["u1", "u2"]);
  });

  it("makes the email searchable without rendering it in the label", () => {
    const [option] = memberPickerOptions([member("u1", "Ana", "ana@x.co")]);

    expect(option.label).toBe("Ana");
    expect(option.searchText).toBe("Ana ana@x.co");
  });

  it("does not repeat an email that is already the label", () => {
    const [option] = memberPickerOptions([member("u1", null, "solo@x.co")]);

    expect(option.searchText).toBe("solo@x.co");
  });
});

describe("member search matching (COSMOS-171)", () => {
  const options = memberPickerOptions([
    member("u1", "Ana Beltran", "ana@x.co"),
    member("u2", "Bob Carr", "robert@x.co"),
  ]);

  it("matches a case-insensitive substring of the name", () => {
    expect(filterMemberOptions(options, "belt").map((o) => o.value)).toEqual([
      "u1",
    ]);
    expect(filterMemberOptions(options, "ANA").map((o) => o.value)).toEqual([
      "u1",
    ]);
  });

  it("matches the email even when the label is a display name", () => {
    expect(filterMemberOptions(options, "robert@").map((o) => o.value)).toEqual([
      "u2",
    ]);
  });

  it("keeps every option for a blank or whitespace query", () => {
    expect(filterMemberOptions(options, "").map((o) => o.value)).toEqual([
      "u1",
      "u2",
    ]);
    expect(filterMemberOptions(options, "   ").map((o) => o.value)).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("returns nothing when nobody matches", () => {
    expect(filterMemberOptions(options, "nobody")).toEqual([]);
    expect(matchesMemberQuery({ label: "Ana", searchText: "Ana" }, "zz")).toBe(
      false,
    );
  });
});
