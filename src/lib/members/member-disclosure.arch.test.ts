import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeMask } from "@/lib/auth/api-key";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { Permission } from "@/lib/rbac/permissions";

/**
 * Every org route that sends a person's email address, and why an API key
 * cannot use it to read emails or people it should not.
 *
 * Two rules, for any response that lists members: a key sees emails only with
 * `members:read`, and a project-scoped key sees only the people in its roster
 * (`scopedRosterUserIds`). `memberDisclosure(ctx)` applies both. A route that
 * sends emails must go through it, through a contract's `scopedFields`, or be
 * out of every key's reach. A new route that mentions an email fails here
 * until it is listed, so the decision is made on purpose.
 *
 * `member-disclosure.db.test.ts` drives the main routes against a database.
 */

const ROOT = "src/app/api/v1/orgs/[orgId]";

type Rule =
  /** Calls `memberDisclosure(ctx)`: both rules. */
  | { via: "disclosure" }
  /** `respond()` strips emails through the contract's `scopedFields`; `roster` says how the ceiling holds. */
  | { via: "contract"; roster: "scopedRosterUserIds" | { why: string } }
  /** Gated on a bit no API key scope grants, so no key gets an answer. */
  | { via: "keyless"; bit: keyof typeof Permission; why: string }
  /** Chat: `mayUseChat(ctx)`, CHAT_USE, which no key scope grants. */
  | { via: "chat"; why: string }
  /** Refuses API keys outright. */
  | { via: "refuses-keys"; why: string };

const ROUTES: Record<string, Rule> = {
  "route.ts": { via: "disclosure" },
  "audit-logs/export/route.ts": { via: "disclosure" },
  "projects/[projectId]/members/route.ts": { via: "disclosure" },
  "projects/[projectId]/teams/route.ts": { via: "disclosure" },
  "projects/[projectId]/intervals/[intervalId]/capacity/route.ts": { via: "disclosure" },

  "members/route.ts": { via: "contract", roster: "scopedRosterUserIds" },
  "projects/[projectId]/route.ts": {
    via: "contract",
    roster: { why: "the members of one project the key can read, who are in its roster by definition" },
  },

  "account-requests/route.ts": { via: "keyless", bit: "ORG_MANAGE_MEMBERS", why: "requests to join, for admins" },
  "invitations/route.ts": { via: "keyless", bit: "ORG_MANAGE_MEMBERS", why: "invitees, for admins" },
  "invitations/[invitationId]/route.ts": { via: "keyless", bit: "ORG_MANAGE_MEMBERS", why: "an invitee, for admins" },
  "members/[memberId]/route.ts": { via: "keyless", bit: "ORG_MANAGE_MEMBERS", why: "one member, for admins" },
  "members/[memberId]/password-reset/route.ts": { via: "keyless", bit: "ORG_MANAGE_MEMBERS", why: "admin reset" },
  "email-settings/test/route.ts": { via: "keyless", bit: "ORG_MANAGE_SETTINGS", why: "a test send" },
  "chat/bots/route.ts": { via: "chat", why: "chat's bot members" },
  "chat/channels/[channelId]/route.ts": { via: "chat", why: "a channel's members" },
  "feedback/route.ts": { via: "keyless", bit: "ORG_READ", why: "who sent feedback" },
  "feedback/[feedbackId]/route.ts": { via: "keyless", bit: "ORG_READ", why: "who sent feedback" },
  "crm/contacts/route.ts": { via: "keyless", bit: "CRM_READ", why: "customer contacts, not members" },
  "crm/contacts/[contactId]/route.ts": { via: "keyless", bit: "CRM_READ", why: "a customer contact" },
  "clients/route.ts": { via: "keyless", bit: "CRM_READ", why: "client contacts, not members" },
  "clients/[clientId]/route.ts": { via: "keyless", bit: "CRM_UPDATE", why: "a client contact" },
  "partners/route.ts": { via: "keyless", bit: "CRM_READ", why: "partner contacts, not members" },
  "partners/[partnerId]/route.ts": { via: "keyless", bit: "CRM_READ", why: "a partner contact" },
  "contracts/[contractId]/signature/route.ts": { via: "keyless", bit: "CRM_UPDATE", why: "a signer" },
  "export/json/route.ts": { via: "keyless", bit: "ORG_EXPORT", why: "the whole-org archive, for admins" },
  "slack/route.ts": { via: "keyless", bit: "INTEGRATION_MANAGE", why: "every member's Slack link, for admins" },

  "meetings/[meetingId]/outlook-invite/route.ts": { via: "refuses-keys", why: "sends invites as the signed-in user" },
  "meetings/[meetingId]/teams/route.ts": { via: "refuses-keys", why: "a meeting's Teams host, for signed-in people" },
};

/** Library code that answers a route with people in it. */
const LIBRARY: Record<string, string> = {
  "src/lib/query/suggest.server.ts": "people suggestions in the query editor (cql/suggest)",
  "src/lib/mentions/registry.server.ts": "people in search and @-mentions",
  "src/lib/query/resolve.server.ts": "people named in a query (cql/validate, search, saved filters)",
  "src/lib/query/saved-filters.server.ts": "people printed in a saved filter's text",
};

/** Comments out, so a doc comment naming a field cannot satisfy or trip a rule. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const read = (file: string) => stripComments(readFileSync(file, "utf8"));

/** Reads, selects or writes an email field, or loads a whole user row (which carries one). */
const SENDS_EMAIL = /\bemail\s*:|\.email\b|\buser\s*:\s*true\b/;

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, acc);
    else if (entry.name === "route.ts") acc.push(full);
  }
  return acc;
}

const KEY_REACH = scopeMask([...API_KEY_SCOPES]);
const call = (name: string) => new RegExp(`\\b${name}\\s*\\(`);

describe("routes that send email addresses", () => {
  const found = routeFiles(ROOT)
    .filter((f) => SENDS_EMAIL.test(read(f)))
    .map((f) => f.slice(ROOT.length + 1));

  it("found them at all", () => {
    // Guards the guard: an empty scan passes every rule below.
    expect(found.length).toBeGreaterThan(20);
    expect(found).toContain("members/route.ts");
  });

  it("are each listed with the rule that keeps keys out", () => {
    expect(found.filter((f) => !(f in ROUTES))).toEqual([]);
  });

  it("list nothing that no longer sends one", () => {
    expect(Object.keys(ROUTES).filter((f) => !found.includes(f))).toEqual([]);
  });

  it.each(Object.entries(ROUTES))("%s keeps its rule", (file, rule) => {
    const src = read(join(ROOT, file));
    switch (rule.via) {
      case "disclosure":
        expect(src).toMatch(call("memberDisclosure"));
        break;
      case "contract": {
        const contract = join(ROOT, file.replace(/route\.ts$/, "route.contract.ts"));
        expect(existsSync(contract)).toBe(true);
        expect(readFileSync(contract, "utf8")).toMatch(/scopedFields:\s*\[\s*\{\s*scope:\s*"members:read"/);
        expect(src).toMatch(call("respond"));
        if (rule.roster === "scopedRosterUserIds") expect(src).toMatch(call("scopedRosterUserIds"));
        break;
      }
      case "keyless":
        expect(src).toContain(`Permission.${rule.bit}`);
        expect(KEY_REACH & Permission[rule.bit]).toBe(0n);
        break;
      case "chat":
        expect(src).toMatch(/\bmayUseChat\s*\(\s*ctx\s*\)/);
        expect(KEY_REACH & Permission.CHAT_USE).toBe(0n);
        break;
      case "refuses-keys":
        expect(src).toMatch(/\bisApiKey\b/);
        break;
    }
  });

  it.each(Object.keys(LIBRARY))("%s applies both rules", (file) => {
    expect(read(file)).toMatch(call("memberDisclosure"));
  });
});
