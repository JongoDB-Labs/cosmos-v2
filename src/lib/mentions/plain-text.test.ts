import { describe, it, expect } from "vitest";
import { mentionsToPlainText, userMentionLabels } from "./plain-text";
import { refKey } from "./refs";

const BOB = "516528f3-ff55-4f62-b3d9-3aa73f1c62cc";
const ALICE = "aefc3fab-0aa7-479f-aa9a-6ba37e04ce14";
const LABELS = userMentionLabels([
  { id: BOB, displayName: "Bob" },
  { id: ALICE, displayName: "Alice" },
]);

describe("mentionsToPlainText — the reported defect", () => {
  it("renders the person's NAME, not a hardcoded '@user'", () => {
    const out = mentionsToPlainText(`<@${BOB}> please review`, LABELS);
    expect(out).toBe("@Bob please review");
    // The exact string that shipped, asserted as gone.
    expect(out).not.toContain("@user");
  });

  it("resolves several distinct people in one body", () => {
    const out = mentionsToPlainText(`<@${BOB}> and <@${ALICE}> — thoughts?`, LABELS);
    expect(out).toBe("@Bob and @Alice — thoughts?");
  });

  it("resolves the same person mentioned twice", () => {
    // A module-level /g regex whose lastIndex leaks would drop the second hit.
    expect(mentionsToPlainText(`<@${BOB}> ping <@${BOB}>`, LABELS)).toBe("@Bob ping @Bob");
  });

  it("does not leak a raw uuid when the person cannot be resolved", () => {
    const out = mentionsToPlainText(`<@${BOB}> hi`, new Map());
    expect(out).toBe("@someone hi");
    expect(out).not.toContain(BOB);
  });
});

describe("mentionsToPlainText — the typed tokens the old regex missed", () => {
  // The shipped `/<@[0-9a-f-]{36}>/` matched ONLY the legacy people form, so
  // these survived verbatim into notification bodies.
  it("resolves a typed entity when a label is supplied", () => {
    const labels = new Map([[refKey("workItem", "W1"), "Falcon radar upgrade"]]);
    expect(mentionsToPlainText("see <@workItem:W1>", labels)).toBe(
      "see #Falcon radar upgrade",
    );
  });

  it("degrades an unresolved typed entity to its type, never the raw id", () => {
    const out = mentionsToPlainText("see <@workItem:abc123>", new Map());
    expect(out).toBe("see #work item");
    expect(out).not.toContain("abc123");
  });

  it("leaves no angle-bracket token behind for any entity type", () => {
    const body = "<@project:p1> <@note:n1> <@milestone:m1> <@risk:r1>";
    const out = mentionsToPlainText(body, new Map());
    expect(out).not.toContain("<@");
    expect(out).not.toContain(">");
  });

  it("treats an unknown type prefix as a person rather than throwing", () => {
    expect(mentionsToPlainText("<@wat:xyz>", new Map())).toBe("@someone");
  });
});

describe("mentionsToPlainText — leaves everything else alone", () => {
  it("returns text with no mentions unchanged", () => {
    expect(mentionsToPlainText("no mentions here", LABELS)).toBe("no mentions here");
  });

  it("handles empty and missing content", () => {
    expect(mentionsToPlainText("", LABELS)).toBe("");
    expect(mentionsToPlainText("")).toBe("");
  });

  it("works with no label map at all", () => {
    expect(mentionsToPlainText(`<@${BOB}> hi`)).toBe("@someone hi");
  });

  it("does not mangle an email address or a stray '<@'", () => {
    expect(mentionsToPlainText("mail bob@test.local", LABELS)).toBe("mail bob@test.local");
    expect(mentionsToPlainText("a < b @ c", LABELS)).toBe("a < b @ c");
  });
});

describe("userMentionLabels", () => {
  it("keys by refKey so it drops straight into the resolver", () => {
    expect(LABELS.get(refKey("user", BOB))).toBe("Bob");
  });

  it("is case-insensitive on the id, matching refKey's lowercasing", () => {
    const upper = userMentionLabels([{ id: BOB.toUpperCase(), displayName: "Bob" }]);
    expect(mentionsToPlainText(`<@${BOB}>`, upper)).toBe("@Bob");
  });

  it("is empty for an empty list", () => {
    expect(userMentionLabels([]).size).toBe(0);
  });
});
