// @vitest-environment node
//
// Microsoft 365 executor — locks the connector contract:
//   - reads via graphFetch (which owns the sealed-cred resolve + client-credentials token
//     exchange) — here graphFetch is MOCKED so the executor is tested in isolation;
//   - "not connected" (graphFetch returns {ok:false}) → graceful { error }, never a throw;
//   - a Graph error → graceful, TOKEN-FREE { error };
//   - success → a shallow shape (subject/name/etc. INCLUDED — the egress gate, not the
//     executor, decides what the model sees);
//   - no access token / client secret ever appears in any returned value (graphFetch never
//     surfaces them; the executor never adds them).
//
// Plus a PROJECTION CONTRACT assertion: a gov m365_message is structural-only (no subject/
// body/from) and a gov m365_user is structural-only (no displayName/mail).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { graphFetch } = vi.hoisted(() => ({ graphFetch: vi.fn() }));

vi.mock("@/lib/integrations/microsoft-graph", () => ({ graphFetch }));

import {
  m365ListUsers,
  m365ListMessages,
  m365ListEvents,
  m365ListDriveItems,
  M365_TOOL_NAMES,
  executeMicrosoft365Tool,
} from "./microsoft365";
import { projectStructural } from "../egress/projection";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000bb";
const TOKEN = "AAD-ACCESS-TOKEN-XYZ"; // must never leak into a result

function ok(data: unknown) {
  return { ok: true as const, data };
}
function err(error: string) {
  return { ok: false as const, error };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("not connected (graphFetch reports it)", () => {
  it("m365_list_users returns a graceful error, never throws", async () => {
    graphFetch.mockResolvedValue(err("Microsoft 365 is not connected for this organization."));
    const res = (await m365ListUsers({}, { orgId: ORG, userId: USER })) as { error?: string };
    expect(res.error).toContain("not connected");
  });

  it("m365_list_messages requires a userId (before any Graph call)", async () => {
    const res = (await m365ListMessages({}, { orgId: ORG, userId: USER })) as { error?: string };
    expect(res.error).toContain("userId");
    expect(graphFetch).not.toHaveBeenCalled();
  });
});

describe("m365ListUsers (success)", () => {
  it("hits /users with a $select and returns a shallow shape", async () => {
    graphFetch.mockResolvedValue(
      ok({
        value: [
          { id: "u1", accountEnabled: true, displayName: "Jane Doe", mail: "jane@acme.us", userPrincipalName: "jane@acme.us", jobTitle: "PM" },
        ],
      }),
    );
    const res = (await m365ListUsers({ limit: 5 }, { orgId: ORG, userId: USER })) as {
      count: number;
      users: Array<Record<string, unknown>>;
    };
    const [orgIdArg, path] = graphFetch.mock.calls[0];
    expect(orgIdArg).toBe(ORG);
    expect(path).toContain("/users?$top=5");
    expect(path).toContain("$select=id,accountEnabled");
    expect(res.count).toBe(1);
    expect(res.users[0]).toMatchObject({ id: "u1", accountEnabled: true, displayName: "Jane Doe" });
  });
});

describe("m365ListMessages (success)", () => {
  it("hits the user's /messages, returns id/flags + content (gate withholds content)", async () => {
    graphFetch.mockResolvedValue(
      ok({
        value: [
          {
            id: "m1",
            receivedDateTime: "2026-06-01T12:00:00Z",
            isRead: false,
            hasAttachments: true,
            importance: "high",
            subject: "CUI//SP exfil path",
            bodyPreview: "secret repro",
            from: { emailAddress: { address: "boss@acme.us", name: "Boss" } },
          },
        ],
      }),
    );
    const res = (await m365ListMessages({ userId: "u1" }, { orgId: ORG, userId: USER })) as {
      count: number;
      messages: Array<Record<string, unknown>>;
    };
    expect(graphFetch.mock.calls[0][1]).toContain("/users/u1/messages");
    expect(res.count).toBe(1);
    expect(res.messages[0]).toMatchObject({
      id: "m1",
      isRead: false,
      hasAttachments: true,
      importance: "high",
      subject: "CUI//SP exfil path",
      from: "boss@acme.us",
    });
  });
});

describe("m365ListEvents (success)", () => {
  it("hits the user's /calendar/events and returns structural fields + content", async () => {
    graphFetch.mockResolvedValue(
      ok({
        value: [
          {
            id: "e1",
            start: { dateTime: "2026-06-02T09:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-06-02T10:00:00", timeZone: "UTC" },
            isAllDay: false,
            isCancelled: false,
            showAs: "busy",
            subject: "Classified review",
            location: { displayName: "SCIF 3" },
          },
        ],
      }),
    );
    const res = (await m365ListEvents({ userId: "u1" }, { orgId: ORG, userId: USER })) as {
      count: number;
      events: Array<Record<string, unknown>>;
    };
    expect(graphFetch.mock.calls[0][1]).toContain("/users/u1/calendar/events");
    expect(res.events[0]).toMatchObject({ id: "e1", isAllDay: false, isCancelled: false, showAs: "busy", subject: "Classified review", location: "SCIF 3" });
  });
});

describe("m365ListDriveItems (success)", () => {
  it("hits /drive/root/children and derives isFolder from the folder facet", async () => {
    graphFetch.mockResolvedValue(
      ok({
        value: [
          { id: "f1", name: "Secret Plans", size: 0, createdDateTime: "c", lastModifiedDateTime: "m", folder: { childCount: 3 }, webUrl: "https://x" },
          { id: "f2", name: "budget.xlsx", size: 4096, createdDateTime: "c", lastModifiedDateTime: "m", webUrl: "https://y" },
        ],
      }),
    );
    const res = (await m365ListDriveItems({ userId: "u1" }, { orgId: ORG, userId: USER })) as {
      count: number;
      items: Array<Record<string, unknown>>;
    };
    expect(graphFetch.mock.calls[0][1]).toContain("/users/u1/drive/root/children");
    expect(res.items[0]).toMatchObject({ id: "f1", size: 0, isFolder: true, name: "Secret Plans" });
    expect(res.items[1]).toMatchObject({ id: "f2", size: 4096, isFolder: false });
  });
});

describe("Graph error handling (graceful, token-free)", () => {
  it("a Graph 403 becomes a clean error with no token leak", async () => {
    graphFetch.mockResolvedValue(err("Microsoft Graph API error (HTTP 403): Authorization_RequestDenied"));
    const res = (await m365ListUsers({}, { orgId: ORG, userId: USER })) as { error?: string };
    expect(res.error).toContain("HTTP 403");
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("a thrown graphFetch (unexpected) is caught → graceful error", async () => {
    graphFetch.mockRejectedValue(new Error("boom"));
    const res = (await m365ListMessages({ userId: "u1" }, { orgId: ORG, userId: USER })) as { error?: string };
    expect(res.error).toContain("boom");
  });
});

describe("dispatch", () => {
  it("M365_TOOL_NAMES lists exactly the four tools", () => {
    expect([...M365_TOOL_NAMES].sort()).toEqual(
      ["m365_list_drive_items", "m365_list_events", "m365_list_messages", "m365_list_users"].sort(),
    );
  });

  it("executeMicrosoft365Tool routes a known tool and returns null for a non-m365 tool", async () => {
    graphFetch.mockResolvedValue(ok({ value: [] }));
    const routed = (await executeMicrosoft365Tool("m365_list_users", {}, { orgId: ORG, userId: USER })) as {
      success?: boolean;
    };
    expect(routed.success).toBe(true);
    expect(await executeMicrosoft365Tool("send_email", {}, { orgId: ORG, userId: USER })).toBeNull();
  });
});

describe("PROJECTION CONTRACT — gov m365 results are structural-only", () => {
  it("a gov m365_message exposes id/flags/timestamps; subject/body/from WITHHELD", () => {
    const msg = {
      id: "m1",
      receivedDateTime: "2026-06-01T12:00:00Z",
      isRead: false,
      hasAttachments: true,
      importance: "high",
      subject: "CUI//SP exfil path",
      bodyPreview: "secret repro",
      from: "boss@acme.us",
    };
    const mv = projectStructural(msg, "m365_message") as Record<string, unknown>;
    expect(mv).toEqual({
      id: "m1",
      receivedDateTime: "2026-06-01T12:00:00Z",
      isRead: false,
      hasAttachments: true,
      importance: "high",
    });
    expect("subject" in mv).toBe(false);
    expect("from" in mv).toBe(false);
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("boss@acme.us");
  });

  it("a gov m365_user exposes id/accountEnabled; displayName/mail WITHHELD", () => {
    const u = { id: "u1", accountEnabled: true, displayName: "Jane Doe", mail: "jane@acme.us", userPrincipalName: "jane@acme.us", jobTitle: "PM" };
    const mv = projectStructural(u, "m365_user") as Record<string, unknown>;
    expect(mv).toEqual({ id: "u1", accountEnabled: true });
    expect(JSON.stringify(mv)).not.toContain("Jane");
    expect(JSON.stringify(mv)).not.toContain("jane@acme.us");
  });

  it("a gov m365_event exposes id/start/end/flags; subject/location WITHHELD", () => {
    const e = {
      id: "e1",
      start: { dateTime: "2026-06-02T09:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-06-02T10:00:00", timeZone: "UTC" },
      isAllDay: false,
      isCancelled: false,
      showAs: "busy",
      subject: "Classified review",
      location: "SCIF 3",
    };
    const mv = projectStructural(e, "m365_event") as Record<string, unknown>;
    expect("subject" in mv).toBe(false);
    expect("location" in mv).toBe(false);
    expect(mv.id).toBe("e1");
    expect(mv.showAs).toBe("busy");
    expect(JSON.stringify(mv)).not.toContain("Classified");
    expect(JSON.stringify(mv)).not.toContain("SCIF");
  });

  it("a gov m365_drive_item exposes id/size/timestamps/isFolder; name/webUrl WITHHELD", () => {
    const d = { id: "f1", size: 4096, createdDateTime: "c", lastModifiedDateTime: "m", isFolder: false, name: "budget.xlsx", webUrl: "https://x" };
    const mv = projectStructural(d, "m365_drive_item") as Record<string, unknown>;
    expect(mv).toEqual({ id: "f1", size: 4096, createdDateTime: "c", lastModifiedDateTime: "m", isFolder: false });
    expect(JSON.stringify(mv)).not.toContain("budget.xlsx");
    expect(JSON.stringify(mv)).not.toContain("https://x");
  });
});
