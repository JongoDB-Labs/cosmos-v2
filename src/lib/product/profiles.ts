import type { ModuleKey, SectorKey } from "@/lib/entitlements/modules";

export type ProductKey = "cosmos" | "pontis";

export type ProductProfile = {
  key: ProductKey;
  /** User-facing product name, e.g. "COSMOS", "Pontis". */
  name: string;
  /** Browser tab / <title> + metadata title. */
  title: string;
  /** One-line description (metadata + manifest). */
  description: string;
  /** Short tagline shown under the mark on the login screen. */
  tagline: string;
  /** Path under /public to the square brand mark PNG. */
  markSrc: string;
  /** PWA + browser theme color (top-of-viewport chrome). */
  themeColor: string;
  /** PWA manifest background color. */
  backgroundColor: string;
  /** Name of the in-app AI assistant, e.g. "COSMOS Agent". */
  agentName: string;
  /** Spoken wake phrase, lowercase, matched by the recognizer. */
  wakePhrase: string;
  /** Display form of the wake phrase, e.g. "Hey COSMOS". */
  wakeWord: string;
  /** Default TenantClass for orgs created on this product. */
  defaultTenantClass: "GOV" | "COMMERCIAL";
  /** Container signing mode used by the release pipeline. */
  signingMode: "kms" | "keyless";
  /** Default module allowlist for a new org on this product. `null` = all modules. */
  defaultEnabledModules: ModuleKey[] | null;
  /** Default sector allowlist for a new org. `null` = all sectors. */
  defaultEnabledSectors: SectorKey[] | null;
};

export const PRODUCT_PROFILES: Record<ProductKey, ProductProfile> = {
  cosmos: {
    key: "cosmos",
    name: "COSMOS",
    title: "COSMOS — Enterprise Project Management",
    description:
      "Multi-tenant project management platform with boards, OKRs, CRM, and more.",
    tagline: "Enterprise Project Management",
    markSrc: "/cosmos-mark.png",
    themeColor: "#0B0E1A",
    backgroundColor: "#0B0E1A",
    agentName: "COSMOS Agent",
    wakePhrase: "hey cosmos",
    wakeWord: "Hey COSMOS",
    defaultTenantClass: "GOV",
    signingMode: "kms",
    defaultEnabledModules: null,
    defaultEnabledSectors: null,
  },
  pontis: {
    key: "pontis",
    name: "Pontis",
    title: "Pontis — one interface for your practice",
    description:
      "One interface for an architecture practice — projects, proposals, billing, and client portal in one AI-native place.",
    tagline: "Architecture & Design",
    markSrc: "/pontis-mark.png",
    themeColor: "#f9f7f4",
    backgroundColor: "#f9f7f4",
    agentName: "Pontis Agent",
    wakePhrase: "hey pontis",
    wakeWord: "Hey Pontis",
    defaultTenantClass: "COMMERCIAL",
    signingMode: "keyless",
    defaultEnabledModules: null,
    defaultEnabledSectors: ["aec"],
  },
};
