import { describe, it, expect } from "vitest";
import { BASE_SYSTEM_PROMPT, buildAssistantSystemPrompt } from "./assistant-prompt";

describe("buildAssistantSystemPrompt — requesting-user identity injection", () => {
  const identity = {
    userId: "11111111-1111-1111-1111-111111111111",
    name: "Jon Rannabargar",
    email: "jon@fightingsmartcyber.com",
    role: "OWNER",
  };

  it("includes the base Cosmo prompt", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p).toContain(BASE_SYSTEM_PROMPT);
  });

  it("tells the model exactly who it is talking to (name, email, id, role)", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p).toContain("Jon Rannabargar");
    expect(p).toContain("jon@fightingsmartcyber.com");
    expect(p).toContain(identity.userId);
    expect(p).toContain("OWNER");
  });

  it("instructs the model NOT to ask who the user is or for their id", () => {
    const p = buildAssistantSystemPrompt(identity);
    expect(p.toLowerCase()).toMatch(/never ask|already know/);
    // the user id must be presented as the current-user default for "assign to me"
    expect(p.toLowerCase()).toMatch(/\bme\b|assign to me|"my"|current user/);
  });

  it("does not crash on a missing/blank name (falls back gracefully)", () => {
    const p = buildAssistantSystemPrompt({ userId: "u1", name: "", email: "x@y.z", role: "MEMBER" });
    expect(p).toContain("u1");
    expect(p).toContain("x@y.z");
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
