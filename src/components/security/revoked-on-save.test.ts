import { describe, it, expect } from "vitest";
import { revokedOnSaveText } from "./revoked-on-save";

describe("revokedOnSaveText", () => {
  it("says nothing when a save revoked nothing", () => {
    expect(revokedOnSaveText(undefined)).toBeNull();
    expect(revokedOnSaveText({ apiKeysRevoked: 0, calendarFeedsRevoked: 0 })).toBeNull();
  });

  it("counts keys, links, or both, in one sentence", () => {
    expect(revokedOnSaveText({ apiKeysRevoked: 1 })).toBe("Saved. 1 API key was revoked.");
    expect(revokedOnSaveText({ apiKeysRevoked: 3, calendarFeedsRevoked: 0 })).toBe("Saved. 3 API keys were revoked.");
    expect(revokedOnSaveText({ calendarFeedsRevoked: 1 })).toBe("Saved. 1 calendar link was revoked.");
    expect(revokedOnSaveText({ apiKeysRevoked: 2, calendarFeedsRevoked: 1 })).toBe("Saved. 2 API keys and 1 calendar link were revoked.");
  });
});
