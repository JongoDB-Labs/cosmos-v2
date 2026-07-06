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
