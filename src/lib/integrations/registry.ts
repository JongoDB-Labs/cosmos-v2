export const INTEGRATION_CATEGORIES = [
  "video", "messaging", "email_calendar", "dev", "pm", "crm",
  "finance", "hr", "support", "storage", "docs_esign", "marketing",
  "analytics", "identity", "automation", "gov",
] as const;

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const CATEGORY_META: Record<
  IntegrationCategory,
  { label: string; order: number; tint: string }
> = {
  video:          { label: "Video & Meetings",        order: 1,  tint: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  messaging:      { label: "Messaging & Chat",        order: 2,  tint: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  email_calendar: { label: "Email & Calendar",        order: 3,  tint: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  dev:            { label: "Dev & Code",              order: 4,  tint: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  pm:             { label: "Project & Work Mgmt",     order: 5,  tint: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" },
  crm:            { label: "CRM & Sales",             order: 6,  tint: "bg-pink-500/15 text-pink-600 dark:text-pink-400" },
  finance:        { label: "Finance & Accounting",    order: 7,  tint: "bg-green-500/15 text-green-600 dark:text-green-400" },
  hr:             { label: "HR & People",             order: 8,  tint: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  support:        { label: "Support & Helpdesk",      order: 9,  tint: "bg-teal-500/15 text-teal-600 dark:text-teal-400" },
  storage:        { label: "Storage & Files",         order: 10, tint: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  docs_esign:     { label: "Docs & eSign",            order: 11, tint: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
  marketing:      { label: "Marketing",               order: 12, tint: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400" },
  analytics:      { label: "Analytics & BI",          order: 13, tint: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  identity:       { label: "Identity & SSO",          order: 14, tint: "bg-slate-500/15 text-slate-600 dark:text-slate-400" },
  automation:     { label: "Automation & iPaaS",      order: 15, tint: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400" },
  gov:            { label: "Government & Defense",     order: 16, tint: "bg-red-500/15 text-red-600 dark:text-red-400" },
};

export interface IntegrationProvider {
  slug: string;
  name: string;
  description: string;
  icon: string;                 // BRAND_ICONS key (usually == slug)
  category: IntegrationCategory;
  status: "available" | "coming_soon";
  connect: "google" | "config" | "none";
  authType: "oauth2" | "api_key" | "webhook";
  sector?: string[];
  docsUrl?: string;
  scopes?: string[];
  // `secret: true` marks a field whose submitted value is a SECRET (API key / PAT /
  // password). The install/config API splits these OUT of the plaintext
  // `Integration.config` and seals them into the vault via setOrgCredential — they
  // are NEVER written to `Integration.config`. Non-secret fields (owner/repo/URL)
  // stay in `Integration.config` as before. (A `type:"secret"` field SHOULD also set
  // `secret:true`; the split keys off `secret`, while `type` only drives the input UI.)
  configFields?: {
    key: string;
    label: string;
    type: "text" | "url" | "secret";
    required: boolean;
    secret?: boolean;
  }[];
  events?: string[];
}

const registry = new Map<string, IntegrationProvider>();

export const IntegrationRegistry = {
  register(provider: IntegrationProvider) {
    registry.set(provider.slug, provider);
  },

  get(slug: string): IntegrationProvider | undefined {
    return registry.get(slug);
  },

  getAll(): IntegrationProvider[] {
    return Array.from(registry.values());
  },

  getByCategory(category: IntegrationProvider["category"]): IntegrationProvider[] {
    return Array.from(registry.values()).filter((p) => p.category === category);
  },
};
