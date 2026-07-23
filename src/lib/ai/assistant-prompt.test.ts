import { describe, it, expect } from "vitest";
import { BASE_SYSTEM_PROMPT, buildAssistantSystemPrompt } from "./assistant-prompt";

describe("buildAssistantSystemPrompt — requesting-user identity injection", () => {
  const identity = {
    userId: "11111111-1111-1111-1111-111111111111",
    name: "Jon Rannabargar",
    role: "OWNER",
  };

  it("includes the base Cosmo prompt", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p).toContain(BASE_SYSTEM_PROMPT);
  });

  it("tells the model exactly who it is talking to (name, id, role) and keeps email out of it", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p).toContain("Jon Rannabargar");
    expect(p).toContain(identity.userId);
    expect(p).toContain("OWNER");
    // GOV-mode withholds member email as PII from tool data (egress/projection.ts);
    // the acting user's own email must not leak into the model context either —
    // the identity block carries name + id + role only.
    const identityBlock = p.slice(BASE_SYSTEM_PROMPT.length);
    expect(identityBlock).not.toContain("@");
    expect(identityBlock.toLowerCase()).not.toContain("email");
  });

  it("instructs the model NOT to ask who the user is or for their id", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p.toLowerCase()).toMatch(/never ask|already know/);
    // the user id must be presented as the current-user default for "assign to me"
    expect(p.toLowerCase()).toMatch(/\bme\b|assign to me|"my"|current user/);
  });

  it("does not crash on a missing/blank name (falls back to the user id, not email)", () => {
    const p = buildAssistantSystemPrompt({ userId: "u1", name: "", role: "MEMBER" });
    expect(p).toContain("u1");
    expect(p.slice(BASE_SYSTEM_PROMPT.length)).not.toContain("@");
  });
});

describe("BASE_SYSTEM_PROMPT — CUI-blind operating guidance (bug #3 symptom fix)", () => {
  it("teaches the model that withheld content is a privacy boundary, not corruption", () => {
    const lower = BASE_SYSTEM_PROMPT.toLowerCase();
    // must NOT invite the model to describe data as encrypted/corrupted/obfuscated
    expect(lower).toMatch(/withheld|structural|redact|privacy|classification/);
    expect(lower).toMatch(/never.*(encrypted|corrupted|obfuscated|broken)/);
  });

  it("points the model at server-side resolution (list_projects query / semantic_search)", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("list_projects");
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toMatch(/query|semantic_search|resolve/);
  });
});

describe("buildAssistantSystemPrompt — date awareness (relative-date fix)", () => {
  it("injects the current date so the model does relative-date math from a real anchor", () => {
    const now = new Date("2026-07-23T18:00:00Z"); // 2:00 PM US Eastern (EDT)
    const p = buildAssistantSystemPrompt(
      { userId: "u1", name: "Jon", role: "OWNER" },
      now,
    );
    expect(p).toContain("2026-07-23");
    expect(p.toLowerCase()).toMatch(/current date|today's date/);
    // and tells the model to emit day-safe calendar dates
    expect(p).toContain("YYYY-MM-DD");
  });

  it("defaults `now` to the real clock when not supplied (no crash, one-arg call)", () => {
    const p = buildAssistantSystemPrompt({ userId: "u1", name: "", role: "MEMBER" });
    expect(p.toLowerCase()).toContain("today's date");
  });
});

describe("BASE_SYSTEM_PROMPT — ask-when-unsure + sprint assignment", () => {
  it("tells the model to clarify under ambiguity instead of guessing or half-finishing", () => {
    const lower = BASE_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/ambiguous|clarify/);
    expect(lower).toMatch(/never guess|half-done|half-finish/);
  });

  it("tells the model to offer sprint assignment for items inside a sprint window", () => {
    const lower = BASE_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("list_cycles");
    expect(lower).toMatch(/sprint/);
  });
});
