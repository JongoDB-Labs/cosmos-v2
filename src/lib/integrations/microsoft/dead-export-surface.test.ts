// @vitest-environment node
//
// CLEANUP-25 removed unreachable surfaces from src/lib/integrations/microsoft.
// An export with no importer reads as a supported API — the next person wires a
// feature to it and inherits code nothing has ever exercised, and a "test hook"
// no test calls is worse still: it looks like the isolation the suite relies on.
// These tests pin the module surfaces so a deleted entry point cannot quietly
// reappear, and assert the LIVE neighbours that must survive alongside it.
// Sibling of src/lib/integrations/dead-export-surface.test.ts (CLEANUP-14).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import * as connect from "./calendar-connect";
import * as sync from "./calendar-sync.server";
import * as conversations from "./teams-app/conversations.server";
import * as entra from "./teams-app/entra-auth.server";
import * as identity from "./teams-app/identity.server";
import * as notify from "../teams-notify";

describe("calendar-connect surface", () => {
  it("has no reset hook: calendar-connect.test.ts isolates by minting a fresh state", () => {
    expect(Object.keys(connect)).not.toContain("_resetUsedConnectStates");
  });

  it("keeps the live connect helpers", () => {
    expect(Object.keys(connect).sort()).toEqual([
      "ADMIN_CONSENT_STATE",
      "MS_CALENDAR",
      "MS_CALENDAR_CALLBACK_PATH",
      "MS_CALENDAR_SCOPES",
      "MS_CALENDAR_STATE_COOKIE",
      "calendarAdminConsentUrl",
      "calendarAuthorizeUrl",
      "idTokenClaims",
      "newConnectState",
      "openConnectState",
    ]);
  });
});

describe("calendar-sync.server surface", () => {
  const keys = Object.keys(sync);

  it("keeps the Graph wiring and the title constant module-private", () => {
    // No other module — not even calendar-sync.server.test.ts, which re-types
    // the extended-property id as a literal string — reaches for these.
    for (const name of [
      "RESTRICTED_TITLE",
      "COSMOS_CALENDAR_PROP",
      "COSMOS_CALENDAR_TAG",
      "meetingEvent",
      "orgEmailDomains",
    ]) {
      expect(keys).not.toContain(name);
    }
  });

  it("keeps the sync entry points its callers use", () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        "ensureCosmosCalendar",
        "pullChanges",
        "runCalendarPulls",
        "setMeetingInvite",
        "syncMeeting",
        "syncUserNow",
      ]),
    );
  });
});

describe("teams-app conversations.server surface", () => {
  const keys = Object.keys(conversations);

  it("does not re-export identity.server's tenant lookup", () => {
    // handlers.server, notify.server and tab-session.server all import
    // teamsOrgsForTenant straight from ./identity.server.
    expect(keys).not.toContain("teamsOrgsForTenant");
    expect(Object.keys(identity)).toContain("teamsOrgsForTenant");
  });

  it("drops forgetPersonal: disconnectCalendar deletes the chat in its own transaction", () => {
    expect(keys).not.toContain("forgetPersonal");
  });

  it("keeps the inbound-activity handlers the bot route calls", () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        "capturePersonal",
        "forgetConversation",
        "forgetOrgConversations",
        "handleChannelMessage",
        "handlePersonalMessage",
        "parseCommand",
      ]),
    );
  });
});

describe("teams-app entra-auth.server surface", () => {
  const keys = Object.keys(entra);

  it("does not re-export the Teams client ids", () => {
    // teams-app-setup.tsx imports them straight from ./teams-clients.
    expect(keys).not.toContain("TEAMS_CLIENT_IDS");
  });

  it("keeps the tab-token verifier and its neighbours", () => {
    expect(keys).toEqual(
      expect.arrayContaining(["EntraAuthError", "TAB_SCOPE", "_resetEntraKeys", "tabAppIdUri", "verifyTabToken"]),
    );
  });
});

describe("teams-app identity.server surface", () => {
  const keys = Object.keys(identity);

  it("has no tenant-cache reset hook, unlike the sibling hooks tests do call", () => {
    expect(keys).not.toContain("_resetTeamsAppTenants");
    // _resetEntraKeys is the shape that earns its keep: entra-auth.server.test.ts uses it.
    expect(Object.keys(entra)).toContain("_resetEntraKeys");
  });

  it("keeps the identity lookups", () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        "MS_TEAMS_APP",
        "teamsAppEnabled",
        "teamsAppTenants",
        "teamsBotAppId",
        "teamsOrgsForTenant",
        "teamsUserById",
        "teamsUsers",
      ]),
    );
  });
});

describe("teams-notify re-export block", () => {
  it("re-exports only what is imported through it", () => {
    // integrations-manager.tsx, the single consumer of TEAMS_EVENTS and
    // TEAMS_EVENT_LABELS, imports them from teams-notify-config directly.
    expect(Object.keys(notify).sort()).toEqual([
      "TEAMS_NOTIFY_DEFAULTS",
      "escapeHtmlBasic",
      "teamsEventEnabled",
      "teamsNotify",
    ]);
  });
});

describe("teams.ts has one FetchLike", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/integrations/teams.ts"), "utf8");

  it("takes the type from microsoft-graph instead of re-declaring it", () => {
    expect(src).not.toMatch(/type FetchLike\s*=/);
    expect(src).toMatch(/import \{[^}]*type FetchLike[^}]*\} from "@\/lib\/integrations\/microsoft-graph"/);
  });
});
