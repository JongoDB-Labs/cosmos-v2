import type { IntegrationProvider } from "../registry";

/**
 * Hand-maintained connector entries that aren't produced by the generator
 * (`catalog.generated.ts` comes from gitignored research JSON, so it can't be
 * regenerated in CI). Registered alongside CATALOG in ./index.ts; a manual entry
 * with the same slug OVERRIDES the generated one (see the register loop).
 *
 * Microsoft Teams (FR 8a162fe7): overrides the generated `microsoft-teams-messaging`
 * `coming_soon` placeholder with a live `config` connector so an admin can enter
 * the Entra app credentials (client id / secret / tenant) via the Integrations
 * UI — the secrets are sealed exactly like Microsoft 365. `defaultTeamId` /
 * `defaultChannelId` are non-secret and pick where notifications post. (The
 * separate `microsoft-teams-video` entry stays coming_soon.)
 */
export const MANUAL_CATALOG: IntegrationProvider[] = [
  // Outlook Calendar (COSMOS-202 B): overrides the generated coming_soon
  // placeholder. Installing it is the org switch; each person then connects
  // their own calendar from Preferences. The app credentials are the
  // instance's Microsoft sign-in app (Admin, Sign-in providers), so the only
  // field is the tenant every connection is pinned to.
  {
    slug: "microsoft-365-calendar",
    name: "Outlook Calendar",
    description:
      "Let people connect their own Microsoft 365 calendar. Uses the instance's Microsoft sign-in app with the delegated Calendars.ReadWrite permission (an Entra admin grants consent once). Connections are limited to the tenant below.",
    icon: "microsoftoutlook",
    category: "email_calendar",
    status: "available",
    connect: "config",
    authType: "oauth2",
    sector: ["general"],
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/calendar",
    configFields: [{ key: "tenantId", label: "Directory (tenant) ID", type: "text", required: true }],
  },
  // Cosmos for Teams (COSMOS-202 T1): the org switch for the Teams app (link
  // cards, "Create Cosmos item" from a message, item search). Answers only for
  // the tenant Outlook Calendar is pinned to, and only for people who connected
  // Outlook Calendar, so it has no fields of its own.
  {
    slug: "microsoft-teams-app",
    name: "Cosmos for Teams",
    description:
      "Cosmos inside Microsoft Teams: pasted item links become cards, any message can become a Cosmos item, and items can be searched and shared from the compose box. Needs Outlook Calendar installed; people use it after connecting Outlook Calendar.",
    icon: "microsoftteams",
    category: "messaging",
    status: "available",
    connect: "config",
    authType: "oauth2",
    sector: ["general"],
    docsUrl: "https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/what-are-messaging-extensions",
    configFields: [],
  },
  {
    slug: "microsoft-teams-messaging",
    name: "Microsoft Teams",
    description:
      "Post Cosmos notifications and updates to a Microsoft Teams channel via Microsoft Graph, using an org-app (client-credentials) Entra app registration. Enter the Entra app credentials below; works on the commercial and GCC-High gov clouds.",
    icon: "microsoftteams",
    category: "messaging",
    status: "available",
    connect: "config",
    authType: "api_key",
    sector: ["general", "gov"],
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/channel-post-messages",
    configFields: [
      { key: "clientId", label: "Entra app (client) ID", type: "text", required: true, secret: true },
      { key: "clientSecret", label: "Client secret", type: "secret", required: true, secret: true },
      { key: "tenantId", label: "Directory (tenant) ID", type: "text", required: true, secret: true },
      { key: "cloud", label: "Cloud (commercial or gov)", type: "text", required: false },
      { key: "defaultTeamId", label: "Default Team ID (where to post)", type: "text", required: false },
      { key: "defaultChannelId", label: "Default Channel ID (where to post)", type: "text", required: false },
    ],
  },
];
