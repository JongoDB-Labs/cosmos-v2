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
