// COSMOS-202: the sharing levels Cosmos publishes a calendar at. Reading an
// org default or a person's choice must survive a config/meta that predates the
// setting, or holds something that isn't a level at all.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHARING_LEVEL,
  effectiveSharingLevel,
  orgSharingLevel,
  userSharingLevel,
  withOrgSharingLevel,
} from "./calendar-sharing";

describe("orgSharingLevel", () => {
  it("defaults to full details for an org that has never chosen", () => {
    expect(DEFAULT_SHARING_LEVEL).toBe("full");
    for (const settings of [null, undefined, {}, { calendarFeeds: { enabled: true } }, { outlookCalendar: {} }]) {
      expect(orgSharingLevel(settings)).toBe("full");
    }
  });

  it("reads a stored level, and ignores anything that isn't one", () => {
    expect(orgSharingLevel({ outlookCalendar: { sharingLevel: "busy" } })).toBe("busy");
    expect(orgSharingLevel({ outlookCalendar: { sharingLevel: "full" } })).toBe("full");
    for (const bad of ["BUSY", "free", "", 1, true, null, {}]) {
      expect(orgSharingLevel({ outlookCalendar: { sharingLevel: bad } })).toBe("full");
    }
  });
});

describe("withOrgSharingLevel", () => {
  it("leaves every other org setting alone", () => {
    expect(withOrgSharingLevel({ calendarFeeds: { enabled: true } }, "busy")).toEqual({
      calendarFeeds: { enabled: true },
      outlookCalendar: { sharingLevel: "busy" },
    });
    expect(withOrgSharingLevel(null, "full")).toEqual({ outlookCalendar: { sharingLevel: "full" } });
  });
});

describe("userSharingLevel", () => {
  it("is null until someone chooses, so they follow the org", () => {
    for (const meta of [null, undefined, {}, { upn: "a@b.test" }, { sharingLevel: "inherit" }]) {
      expect(userSharingLevel(meta)).toBeNull();
    }
  });

  it("reads their choice", () => {
    expect(userSharingLevel({ sharingLevel: "busy" })).toBe("busy");
    expect(userSharingLevel({ sharingLevel: "full" })).toBe("full");
  });
});

describe("effectiveSharingLevel", () => {
  it("is their own choice, else the org's default", () => {
    expect(effectiveSharingLevel("full", null)).toBe("full");
    expect(effectiveSharingLevel("busy", null)).toBe("busy");
    // A choice wins either way: the org default is a default, not a ceiling.
    expect(effectiveSharingLevel("busy", "full")).toBe("full");
    expect(effectiveSharingLevel("full", "busy")).toBe("busy");
  });
});
