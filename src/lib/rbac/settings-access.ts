import type { LucideIcon } from "lucide-react";
import {
  User, SlidersHorizontal, KeyRound, Building2, UserCog,
  Sparkles, Bot, Gavel, Server, Cpu, Puzzle, Webhook, ShieldEllipsis,
  LayoutGrid, ListFilter, Tag, Shield, ShieldCheck, ScrollText,
} from "lucide-react";
import { Permission, hasPermission } from "./permissions";
import type { AuthContext } from "./check";

export type SettingsAccess = {
  /** Permission(s) to VIEW the page (and see it in the nav). null = personal/always. Array = any-of. */
  view: bigint | bigint[] | null;
  /** Permission to MANAGE/edit, when stricter than view. */
  manage?: bigint;
};

/** Source of truth: route href -> access. Keep in sync with SETTINGS_NAV_GROUPS. */
export const SETTINGS_ACCESS: Record<string, SettingsAccess> = {
  "/settings": { view: null },
  "/settings/profile": { view: null },
  "/settings/preferences": { view: null },
  "/settings/account-security": { view: null },
  "/settings/organization": { view: [Permission.ORG_UPDATE, Permission.THEME_MANAGE] },
  "/settings/roles": { view: Permission.ORG_MANAGE_MEMBERS },
  "/settings/ai": { view: Permission.ORG_MANAGE_SETTINGS },
  "/settings/agent-policy": { view: Permission.AGENT_POLICY_MANAGE },
  "/settings/agent-governance": { view: Permission.SECURITY_MANAGE },
  "/settings/mcp-servers": { view: Permission.MCP_MANAGE },
  "/settings/runtime-config": { view: Permission.INTEGRATION_MANAGE },
  "/settings/integrations": { view: Permission.INTEGRATION_MANAGE },
  "/settings/webhooks": { view: Permission.WEBHOOK_MANAGE },
  "/settings/api-keys": { view: Permission.API_KEY_MANAGE },
  "/settings/templates": { view: Permission.TEMPLATE_READ, manage: Permission.TEMPLATE_MANAGE },
  "/settings/custom-fields": { view: Permission.CUSTOM_FIELD_MANAGE },
  "/settings/classifications": { view: Permission.CLASSIFICATION_READ, manage: Permission.CLASSIFICATION_MANAGE },
  "/settings/compliance": { view: Permission.COMPLIANCE_READ, manage: Permission.COMPLIANCE_MANAGE },
  "/settings/security": { view: Permission.SECURITY_MANAGE },
  "/settings/audit-logs": { view: Permission.AUDIT_LOG_READ },
};

export function canViewSettings(ctx: Pick<AuthContext, "permissions">, href: string): boolean {
  const access = SETTINGS_ACCESS[href];
  if (!access || access.view === null) return true;
  const req = Array.isArray(access.view) ? access.view : [access.view];
  return req.some((p) => hasPermission(ctx.permissions, p));
}

export type SettingsNavItem = { icon: LucideIcon; label: string; href: string };
export type SettingsNavGroup = { label: string; items: SettingsNavItem[] };

/** The grouped, audience-first nav. Phase 2 renders this filtered by canViewSettings. */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  { label: "Account", items: [
    { icon: User, label: "Profile", href: "/settings/profile" },
    { icon: SlidersHorizontal, label: "Preferences", href: "/settings/preferences" },
    { icon: KeyRound, label: "Account security", href: "/settings/account-security" },
  ]},
  { label: "Organization", items: [
    { icon: Building2, label: "Organization", href: "/settings/organization" },
    { icon: UserCog, label: "Roles & Access", href: "/settings/roles" },
  ]},
  { label: "AI & Integrations", items: [
    { icon: Sparkles, label: "AI / Model", href: "/settings/ai" },
    { icon: Bot, label: "Agent Policy", href: "/settings/agent-policy" },
    { icon: Gavel, label: "Agent Governance", href: "/settings/agent-governance" },
    { icon: Server, label: "MCP Servers", href: "/settings/mcp-servers" },
    { icon: Cpu, label: "Runtime Config", href: "/settings/runtime-config" },
    { icon: Puzzle, label: "Integrations", href: "/settings/integrations" },
    { icon: Webhook, label: "Webhooks", href: "/settings/webhooks" },
    { icon: ShieldEllipsis, label: "API Keys", href: "/settings/api-keys" },
  ]},
  { label: "Workspace & Data", items: [
    { icon: LayoutGrid, label: "Templates", href: "/settings/templates" },
    { icon: ListFilter, label: "Custom Fields", href: "/settings/custom-fields" },
    { icon: Tag, label: "Classifications", href: "/settings/classifications" },
  ]},
  { label: "Security & Compliance", items: [
    { icon: Shield, label: "Security", href: "/settings/security" },
    { icon: ShieldCheck, label: "Compliance", href: "/settings/compliance" },
    { icon: ScrollText, label: "Audit Logs", href: "/settings/audit-logs" },
  ]},
];
