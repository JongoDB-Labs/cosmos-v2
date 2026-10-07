// @vitest-environment node
//
// The per-cloud Entra/Graph endpoint table (authority host, client-credentials
// scope, Graph base URL) is ONE table, exported from microsoft-graph.ts.
//
// teams.ts mints its own token, against its own `microsoft-teams-messaging` sealed
// credential and with no cache — but it must resolve the cloud through that same
// table. It used to carry a byte-identical private copy, which is exactly how a
// GCC-High endpoint change ships to the Microsoft 365 connector and silently not to
// Teams. These tests pin Teams' outbound URLs to `endpointsFor(...)` rather than to
// hardcoded hosts, so the two can no longer drift apart.
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the sealed-credential + prisma seams so only the injected fetch runs.
const getOrgCredential = vi.fn();
vi.mock("@/lib/integrations/credentials", () => ({
  getOrgCredential: (...a: unknown[]) => getOrgCredential(...a),
}));
const findFirst = vi.fn();
vi.mock("@/lib/db/client", () => ({
  prisma: { integration: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

import { endpointsFor, type GraphCloud } from "./microsoft-graph";
import { postTeamsChannelMessage } from "./teams";

type Call = { url: string; body?: string };

/** An injectable fetch that records every call and answers token-then-post. */
function recordingFetch() {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, body: init?.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "tok", expires_in: 3600 }),
      text: async () => "{}",
    };
  };
  return { fetchImpl, calls };
}

const GOOD_CRED = { clientId: "cid", clientSecret: "sec", tenantId: "tid" };

beforeEach(() => {
  getOrgCredential.mockReset();
  findFirst.mockReset();
});

describe("endpointsFor — the single cloud endpoint table", () => {
  it("resolves the commercial triple", () => {
    expect(endpointsFor("commercial")).toEqual({
      authorityHost: "login.microsoftonline.com",
      scope: "https://graph.microsoft.com/.default",
      graphBaseUrl: "https://graph.microsoft.com/v1.0",
    });
  });

  it("resolves the GCC-High / Azure Government triple", () => {
    expect(endpointsFor("gov")).toEqual({
      authorityHost: "login.microsoftonline.us",
      scope: "https://graph.microsoft.us/.default",
      graphBaseUrl: "https://graph.microsoft.us/v1.0",
    });
  });
});

describe("teams routes through the shared endpoint table", () => {
  for (const cloud of ["commercial", "gov"] as GraphCloud[]) {
    it(`posts a ${cloud} message against endpointsFor("${cloud}")`, async () => {
      const expected = endpointsFor(cloud);
      getOrgCredential.mockResolvedValue(GOOD_CRED);
      findFirst.mockResolvedValue({
        config: { cloud, defaultTeamId: "team-1", defaultChannelId: "chan-1" },
      });

      const { fetchImpl, calls } = recordingFetch();
      const res = await postTeamsChannelMessage("org1", { html: "<p>hi</p>" }, { fetchImpl });
      expect(res).toEqual({ ok: true });

      // 1st call: the Entra token exchange — authority host AND scope come from the table.
      expect(calls).toHaveLength(2);
      expect(new URL(calls[0].url).host).toBe(expected.authorityHost);
      expect(new URLSearchParams(calls[0].body ?? "").get("scope")).toBe(expected.scope);

      // 2nd call: the Graph channel-message POST — base URL comes from the table.
      expect(calls[1].url).toBe(
        `${expected.graphBaseUrl}/teams/team-1/channels/chan-1/messages`,
      );
    });
  }
});
