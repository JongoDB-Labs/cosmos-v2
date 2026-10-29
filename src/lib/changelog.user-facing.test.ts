// The "What's new" modal is mounted in (dashboard)/[orgSlug]/layout.tsx for
// EVERY signed-in user in every org — it is not admin-gated. So changelog.ts's
// own rule ("Keep it USER-FACING — describe the value, not the implementation")
// is a product constraint, not a style note.
//
// This file guards the one way that rule got broken in practice, in 2.499.0:
// an entry that told the reader to "Reply on the ticket" to change a scope
// decision Foreman had settled itself. A customer has no ticket and nowhere to
// reply; that sentence addressed the internal reviewer through a dialog shown
// to every org, and it advertised an open decision as unresolved.
//
// It deliberately does NOT ban delivery vocabulary at large. This changelog
// describes Foreman's own delivery as a product surface ("the ticket" ×35,
// pull requests, commits, reviewers, even ticket keys like COSMOS-141), and
// recording an assumption here is established house style — see 2.371.0 and
// 2.368.11. The line is between stating what was assumed about the PRODUCT,
// which a reader can check against what they see, and narrating process or
// issuing instructions they cannot act on.
import { describe, it, expect } from "vitest";
import { CHANGELOG } from "./changelog";

const entries = CHANGELOG.flatMap((r) => r.highlights.map((h) => ({ version: r.version, text: h.text })));

describe("the What's new modal stays user-facing", () => {
  it("has entries to check at all", () => {
    // Guards the assertions below against passing on an empty corpus.
    expect(entries.length).toBeGreaterThan(100);
  });

  it("never tells a reader to reply on a ticket they cannot see", () => {
    const directive = /\b(reply|respond|comment)\s+(on|to)\s+(the|this)\s+ticket\b/i;
    const offenders = entries.filter((e) => directive.test(e.text)).map((e) => e.version);
    expect(offenders, "say it in the commit message and the PR body; the modal reaches every customer").toEqual([]);
  });

  it("records an assumption in the house form, so it reads as product rather than process", () => {
    // 2.371.0 and 2.368.11 set this pattern: the marker, then what was assumed
    // about the product's BEHAVIOUR — never who decided it, or why nobody answered.
    const assuming = entries.filter((e) => /\bASSUMED\b/.test(e.text));
    expect(assuming.length).toBeGreaterThan(0);
    expect(assuming.filter((e) => !e.text.startsWith("ASSUMED, and worth confirming:")).map((e) => e.version)).toEqual([]);
    const process = /\b(settled automatically|rather than waiting for an answer|nobody (replied|answered)|auto-settled)\b/i;
    expect(assuming.filter((e) => process.test(e.text)).map((e) => e.version)).toEqual([]);
  });
});
