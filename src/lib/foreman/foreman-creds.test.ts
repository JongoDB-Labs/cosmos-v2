import { describe, it, expect } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { materializeForemanHome, cleanupForemanHome } from "./foreman-creds";

describe("materializeForemanHome / cleanupForemanHome", () => {
  it("writes a 0600 claudeAiOauth creds file the SDK reads, then cleanup removes it", () => {
    const dir = materializeForemanHome({ accessToken: "AT", refreshToken: "RT", expiresAt: 1783969315076 });
    const credPath = join(dir, ".claude", ".credentials.json");
    const j = JSON.parse(readFileSync(credPath, "utf8"));
    // The Agent SDK's native subscription-auth path reads claudeAiOauth.* here.
    expect(j.claudeAiOauth.accessToken).toBe("AT");
    expect(j.claudeAiOauth.refreshToken).toBe("RT");
    expect(j.claudeAiOauth.expiresAt).toBe(1783969315076);
    // REGRESSION GUARD: the runtime rejects the token triple ALONE as "Not logged
    // in" — the credentials file MUST also carry the granted scopes (incl.
    // user:sessions:claude_code) and a subscriptionType, or the daemon idles on
    // every pass. A direct SDK probe confirmed the triple-only shape fails and
    // this shape logs in.
    expect(j.claudeAiOauth.scopes).toContain("user:sessions:claude_code");
    expect(j.claudeAiOauth.scopes).toContain("user:inference");
    expect(typeof j.claudeAiOauth.subscriptionType).toBe("string");
    expect(j.claudeAiOauth.subscriptionType.length).toBeGreaterThan(0);
    // A live OAuth token on disk MUST be owner-only.
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
    cleanupForemanHome(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("cleanupForemanHome on an already-removed dir is a no-op (never throws)", () => {
    const dir = materializeForemanHome({ accessToken: "A", refreshToken: null, expiresAt: 0 });
    cleanupForemanHome(dir);
    expect(() => cleanupForemanHome(dir)).not.toThrow();
  });
});
