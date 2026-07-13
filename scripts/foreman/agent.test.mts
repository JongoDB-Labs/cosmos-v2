// Unit tests for runAgent's strict subscription gate. assertSubscription no longer
// looks at ~/.claude — the per-org Foreman token resolution (getForemanClaudeCreds)
// + the `!creds → throw NoForemanCredentialError` in runAgent are the auth source
// now — but it MUST still refuse any metered/cloud-billing env, verbatim.
import { describe, it, expect } from "vitest";
import { assertSubscription, NoForemanCredentialError } from "./agent.mjs";

describe("assertSubscription — metered refusal kept verbatim", () => {
  it("refuses when a metered / cloud-billing var is present", () => {
    expect(() => assertSubscription({ NODE_ENV: "test", ANTHROPIC_API_KEY: "x" })).toThrow(/ANTHROPIC_API_KEY/);
    for (const v of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
      expect(() => assertSubscription({ NODE_ENV: "test", [v]: "1" })).toThrow(new RegExp(v));
    }
  });

  it("does NOT throw on a clean allowlisted env — the ~/.claude existence check is gone", () => {
    // Previously this threw "no ~/.claude credentials"; the strict token resolver
    // replaces that check, so a clean env with no metered vars must pass the gate.
    expect(() =>
      assertSubscription({ PATH: "/usr/bin", HOME: "/tmp/foreman-home-x", NODE_ENV: "test" }),
    ).not.toThrow();
  });
});

describe("NoForemanCredentialError", () => {
  it("is an Error carrying the orgId in field + message", () => {
    const e = new NoForemanCredentialError("org-123");
    expect(e).toBeInstanceOf(Error);
    expect(e.orgId).toBe("org-123");
    expect(e.message).toContain("org-123");
  });
});
