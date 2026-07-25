import { describe, it, expect, beforeEach } from "vitest";
import {
  registerModelCredentialProvider,
  resolveModelCredential,
  type ModelCredentialResolver,
} from "./model-credential-provider";

// The registry is process-wide module state; reset it between cases by registering
// a known resolver (there is no unregister — last write wins, which is the contract).
describe("model-credential-provider", () => {
  beforeEach(() => {
    // Reset to a "no provider" equivalent for the fail-safe case.
    registerModelCredentialProvider(async () => null);
  });

  it("returns the registered provider's credential", async () => {
    registerModelCredentialProvider(async (orgId) => ({ accessToken: `tok-${orgId}` }));
    expect(await resolveModelCredential("org-1")).toEqual({ accessToken: "tok-org-1" });
  });

  it("returns null when the provider yields null (fail-safe degrade)", async () => {
    registerModelCredentialProvider(async () => null);
    expect(await resolveModelCredential("org-1")).toBeNull();
  });

  it("swallows a throwing provider to null (never hard-fails an intake judge)", async () => {
    const boom: ModelCredentialResolver = async () => {
      throw new Error("subscription lookup failed");
    };
    registerModelCredentialProvider(boom);
    expect(await resolveModelCredential("org-1")).toBeNull();
  });

  it("last registration wins", async () => {
    registerModelCredentialProvider(async () => ({ accessToken: "first" }));
    registerModelCredentialProvider(async () => ({ accessToken: "second" }));
    expect(await resolveModelCredential("org-1")).toEqual({ accessToken: "second" });
  });
});
