import { describe, it, expect } from "vitest";
import { BASE_SYSTEM_PROMPT, buildAssistantSystemPrompt } from "./assistant-prompt";

describe("buildAssistantSystemPrompt — requesting-user identity injection", () => {
  const identity = {
    userId: "11111111-1111-1111-1111-111111111111",
    name: "Ada Lovelace",
    role: "OWNER",
  };

  it("includes the base Cosmo prompt", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p).toContain(BASE_SYSTEM_PROMPT);
  });

  it("tells the model exactly who it is talking to (name, id, role) and keeps email out of it", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p).toContain("Ada Lovelace");
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

  // COSMOS-192: asked to assign a ticket, Cosmo reported the assignment by
  // pasting the assignee's GUID, because the id was the only thing it had.
  // The tools now hand it a name; the prompt has to say to use it.
  it("tells the model to report people by name, never by raw id", () => {
    const lower = BASE_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("assigneename");
    expect(lower).toMatch(/name people|use the name/);
    expect(lower).toContain("list_org_members");
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
    expect(lower).toContain("list_intervals");
    expect(lower).toMatch(/sprint/);
  });
});

describe("BASE_SYSTEM_PROMPT — how Cosmo handles a refusal", () => {
  // The server deliberately answers "not found" for BOTH a missing resource and
  // one outside the caller's access (see executors/_ctx.ts assertProjectRead),
  // so that a refusal cannot be used to discover what exists. That contract only
  // holds if the model does not then guess which it was — "that project doesn't
  // exist" would give the game away just as surely as the server saying so.
  it("tells the model tools run AS THE USER, with their access", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/runs? AS THIS USER/i);
  });

  it("forbids asserting that a refused thing does not exist", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/never assert that it does not exist/i);
  });

  it("points the user at an admin rather than leaving them stuck", () => {
    // A refusal the user cannot act on is a dead end — the same reason a
    // returned timesheet requires a reason.
    expect(BASE_SYSTEM_PROMPT).toMatch(/owner or admin/i);
  });

  it("forbids probing with other ids after a refusal", () => {
    // Otherwise the model treats a denial as an obstacle and sweeps ids, which
    // turns a closed door into an enumeration oracle.
    expect(BASE_SYSTEM_PROMPT).toMatch(/never retry a refused call/i);
  });

  it("forbids calling the platform broken when access is denied", () => {
    // Same failure mode the protected-data section already guards against: the
    // model narrating a deliberate boundary as a malfunction.
    expect(BASE_SYSTEM_PROMPT).toMatch(/never claim the platform is broken/i);
  });

  it("warns against passing a partial view off as the whole picture", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/partial result as the whole picture/i);
  });
});
