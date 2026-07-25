export const Permission = {
  // Organization
  ORG_READ:           1n << 0n,
  ORG_UPDATE:         1n << 1n,
  ORG_DELETE:         1n << 2n,
  ORG_MANAGE_MEMBERS: 1n << 3n,
  ORG_MANAGE_BILLING: 1n << 4n,
  ORG_MANAGE_SETTINGS:1n << 5n,
  ORG_MANAGE_TEMPLATES:1n << 8n,

  // Projects
  PROJECT_CREATE:     1n << 10n,
  PROJECT_READ:       1n << 11n,
  PROJECT_UPDATE:     1n << 12n,
  PROJECT_DELETE:     1n << 13n,
  PROJECT_MANAGE:     1n << 14n,

  // Boards
  BOARD_CREATE:       1n << 20n,
  BOARD_READ:         1n << 21n,
  BOARD_UPDATE:       1n << 22n,
  BOARD_DELETE:       1n << 23n,
  BOARD_MANAGE:       1n << 24n,

  // Work Items
  ITEM_CREATE:        1n << 30n,
  ITEM_READ:          1n << 31n,
  ITEM_UPDATE:        1n << 32n,
  ITEM_DELETE:        1n << 33n,
  ITEM_ASSIGN:        1n << 34n,
  ITEM_BULK_EDIT:     1n << 35n,

  // Sprints
  SPRINT_CREATE:      1n << 40n,
  SPRINT_READ:        1n << 41n,
  SPRINT_UPDATE:      1n << 42n,
  SPRINT_COMPLETE:    1n << 43n,

  // Comments & Activity
  COMMENT_CREATE:     1n << 50n,
  COMMENT_READ:       1n << 51n,

  // OKRs
  OKR_CREATE:         1n << 55n,
  OKR_READ:           1n << 56n,
  OKR_UPDATE:         1n << 57n,
  OKR_DELETE:         1n << 58n,

  // Finance
  EXPENSE_APPROVE:    1n << 59n,
  FINANCE_READ:       1n << 60n,
  FINANCE_MANAGE:     1n << 61n,

  // CRM
  CRM_READ:           1n << 62n,
  CRM_CREATE:         1n << 63n,
  CRM_UPDATE:         1n << 64n,
  CRM_DELETE:         1n << 65n,

  // Notes
  NOTE_CREATE:        1n << 66n,
  NOTE_READ:          1n << 67n,
  NOTE_UPDATE:        1n << 68n,
  NOTE_DELETE:        1n << 69n,

  // Integrations
  INTEGRATION_MANAGE: 1n << 70n,

  // Notifications
  NOTIFICATION_READ:  1n << 72n,

  // Templates & Custom Fields
  TEMPLATE_READ:      1n << 73n,
  TEMPLATE_MANAGE:    1n << 74n,

  // Admin
  AUDIT_LOG_READ:     1n << 75n,
  API_KEY_MANAGE:     1n << 76n,
  CUSTOM_FIELD_MANAGE:1n << 77n,

  // Time Tracking
  TIME_CREATE:        1n << 80n,
  TIME_READ:          1n << 81n,
  TIME_UPDATE:        1n << 82n,
  TIME_DELETE:        1n << 83n,
  TIME_APPROVE:       1n << 84n,

  // Meetings
  MEETING_CREATE:     1n << 85n,
  MEETING_READ:       1n << 86n,
  MEETING_UPDATE:     1n << 87n,
  MEETING_DELETE:     1n << 88n,

  // Webhooks
  WEBHOOK_MANAGE:     1n << 90n,

  // Themes & Branding
  THEME_READ:         1n << 91n,
  THEME_MANAGE:       1n << 92n,

  // Compliance & Security (Phase 6)
  COMPLIANCE_READ:    1n << 95n,
  COMPLIANCE_MANAGE:  1n << 96n,
  SECURITY_MANAGE:    1n << 97n,
  SESSION_MANAGE:     1n << 98n,
  SCIM_MANAGE:        1n << 99n,
  CLASSIFICATION_READ:  1n << 100n,
  CLASSIFICATION_MANAGE:1n << 101n,

  // AI Chat + Analytics (Phase 7)
  CHAT_USE:           1n << 105n,
  ANALYTICS_READ:     1n << 106n,
  REPORT_CREATE:      1n << 107n,
  REPORT_MANAGE:      1n << 108n,

  // Data Export / Import (Phase 8)
  ORG_EXPORT:         1n << 110n,
  ORG_IMPORT:         1n << 111n,

  // MCP (Phase 5a) — manage external MCP servers exposed to the chat
  MCP_MANAGE:         1n << 112n,

  // Accounting / General Ledger
  ACCOUNTING_READ:   1n << 113n,
  ACCOUNTING_MANAGE: 1n << 114n,
  ACCOUNTING_CLOSE:  1n << 115n,

  // AI Agent Policy (design D9/§8) — manage the per-org AgentPolicy (the middle gate of
  // RBAC ∩ AgentPolicy ∩ Classification: which tools/domains the agent may call + arg bounds).
  AGENT_POLICY_MANAGE: 1n << 116n,

  // Plugins (ADR 0003) — enable/disable/configure org plugins (Settings → Plugins).
  // Dedicated bit (not ORG_MANAGE_SETTINGS): enabling a plugin flips whole feature
  // surfaces and runs provisioning hooks — scope-able to a WorkRole without handing
  // over all org settings.
  PLUGIN_MANAGE: 1n << 117n,
} as const;

export type PermissionKey = keyof typeof Permission;

// ─── DB boundary ────────────────────────────────────────────────────────────
// Permission masks are stored as decimal STRINGS in TEXT columns
// (OrgMember.permissions, WorkRole.grants) because the bitfield above assigns
// bits >= 63 (CRM_CREATE onward), which overflow Postgres BIGINT (63 usable
// bits). ALL in-memory math stays on `bigint`; convert only when crossing the
// DB boundary — read with maskFromDb(), write with maskToDb().

/** Parse a mask read from the DB (a decimal string) back into a bigint. Tolerant
 *  of null/undefined/"" (→ 0n) and of a raw bigint passthrough, so transitional
 *  callers and test mocks that still hand over a bigint keep working. */
export function maskFromDb(v: string | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  return BigInt(v);
}

/** Serialize an in-memory mask to the decimal-string form the TEXT column holds. */
export function maskToDb(m: bigint): string {
  return m.toString();
}

function combine(...perms: bigint[]): bigint {
  return perms.reduce((acc, p) => acc | p, 0n);
}

export const RolePermissions = {
  OWNER: combine(
    ...Object.values(Permission)
  ),

  ADMIN: combine(
    Permission.ORG_READ,
    Permission.ORG_UPDATE,
    Permission.ORG_MANAGE_MEMBERS,
    Permission.ORG_MANAGE_SETTINGS,
    Permission.ORG_MANAGE_TEMPLATES,
    Permission.PROJECT_CREATE,
    Permission.PROJECT_READ,
    Permission.PROJECT_UPDATE,
    Permission.PROJECT_DELETE,
    Permission.PROJECT_MANAGE,
    Permission.BOARD_CREATE,
    Permission.BOARD_READ,
    Permission.BOARD_UPDATE,
    Permission.BOARD_DELETE,
    Permission.BOARD_MANAGE,
    Permission.ITEM_CREATE,
    Permission.ITEM_READ,
    Permission.ITEM_UPDATE,
    Permission.ITEM_DELETE,
    Permission.ITEM_ASSIGN,
    Permission.ITEM_BULK_EDIT,
    Permission.SPRINT_CREATE,
    Permission.SPRINT_READ,
    Permission.SPRINT_UPDATE,
    Permission.SPRINT_COMPLETE,
    Permission.COMMENT_CREATE,
    Permission.COMMENT_READ,
    Permission.OKR_CREATE,
    Permission.OKR_READ,
    Permission.OKR_UPDATE,
    Permission.OKR_DELETE,
    Permission.CRM_READ,
    Permission.CRM_CREATE,
    Permission.CRM_UPDATE,
    Permission.CRM_DELETE,
    Permission.NOTE_CREATE,
    Permission.NOTE_READ,
    Permission.NOTE_UPDATE,
    Permission.NOTE_DELETE,
    Permission.NOTIFICATION_READ,
    Permission.FINANCE_READ,
    Permission.FINANCE_MANAGE,
    Permission.EXPENSE_APPROVE,
    Permission.ACCOUNTING_READ,
    Permission.ACCOUNTING_MANAGE,
    Permission.ACCOUNTING_CLOSE,
    Permission.INTEGRATION_MANAGE,
    Permission.TEMPLATE_READ,
    Permission.TEMPLATE_MANAGE,
    Permission.AUDIT_LOG_READ,
    Permission.API_KEY_MANAGE,
    Permission.CUSTOM_FIELD_MANAGE,
    Permission.TIME_CREATE,
    Permission.TIME_READ,
    Permission.TIME_UPDATE,
    Permission.TIME_DELETE,
    Permission.TIME_APPROVE,
    Permission.MEETING_CREATE,
    Permission.MEETING_READ,
    Permission.MEETING_UPDATE,
    Permission.MEETING_DELETE,
    Permission.WEBHOOK_MANAGE,
    Permission.THEME_READ,
    Permission.THEME_MANAGE,
    Permission.COMPLIANCE_READ,
    Permission.COMPLIANCE_MANAGE,
    Permission.SECURITY_MANAGE,
    Permission.SESSION_MANAGE,
    Permission.SCIM_MANAGE,
    Permission.CLASSIFICATION_READ,
    Permission.CLASSIFICATION_MANAGE,
    Permission.CHAT_USE,
    Permission.ANALYTICS_READ,
    Permission.REPORT_CREATE,
    Permission.REPORT_MANAGE,
    Permission.ORG_EXPORT,
    Permission.ORG_IMPORT,
    Permission.MCP_MANAGE,
    Permission.AGENT_POLICY_MANAGE,
    Permission.PLUGIN_MANAGE,
  ),

  BILLING_ADMIN: combine(
    Permission.ORG_READ,
    Permission.ORG_MANAGE_BILLING,
    Permission.FINANCE_READ,
    Permission.FINANCE_MANAGE,
    Permission.EXPENSE_APPROVE,
    Permission.ACCOUNTING_READ,
    Permission.ACCOUNTING_MANAGE,
    Permission.ACCOUNTING_CLOSE,
  ),

  MEMBER: combine(
    Permission.ORG_READ,
    Permission.PROJECT_READ,
    Permission.BOARD_READ,
    Permission.BOARD_CREATE,
    Permission.ITEM_CREATE,
    Permission.ITEM_READ,
    Permission.ITEM_UPDATE,
    Permission.ITEM_ASSIGN,
    Permission.SPRINT_READ,
    Permission.COMMENT_CREATE,
    Permission.COMMENT_READ,
    Permission.OKR_CREATE,
    Permission.OKR_READ,
    Permission.OKR_UPDATE,
    Permission.CRM_READ,
    Permission.CRM_CREATE,
    Permission.CRM_UPDATE,
    Permission.NOTE_CREATE,
    Permission.NOTE_READ,
    Permission.NOTE_UPDATE,
    Permission.NOTIFICATION_READ,
    Permission.TEMPLATE_READ,
    Permission.TIME_CREATE,
    Permission.TIME_READ,
    Permission.TIME_UPDATE,
    Permission.MEETING_CREATE,
    Permission.MEETING_READ,
    Permission.MEETING_UPDATE,
    Permission.THEME_READ,
    Permission.COMPLIANCE_READ,
    Permission.CLASSIFICATION_READ,
    Permission.CHAT_USE,
    Permission.ANALYTICS_READ,
    Permission.REPORT_CREATE,
  ),

  VIEWER: combine(
    Permission.ORG_READ,
    Permission.PROJECT_READ,
    Permission.BOARD_READ,
    Permission.ITEM_READ,
    Permission.SPRINT_READ,
    Permission.COMMENT_READ,
    Permission.OKR_READ,
    Permission.CRM_READ,
    Permission.NOTE_READ,
    Permission.NOTIFICATION_READ,
    Permission.TEMPLATE_READ,
    Permission.TIME_READ,
    Permission.MEETING_READ,
    Permission.THEME_READ,
    Permission.COMPLIANCE_READ,
    Permission.CLASSIFICATION_READ,
    Permission.ANALYTICS_READ,
  ),

  GUEST: combine(
    Permission.ITEM_READ,
    Permission.COMMENT_READ,
    Permission.COMMENT_CREATE,
  ),
} as const;

export function hasPermission(
  userPermissions: bigint,
  required: bigint
): boolean {
  return (userPermissions & required) === required;
}

export function hasAnyPermission(
  userPermissions: bigint,
  ...required: bigint[]
): boolean {
  return required.some((p) => hasPermission(userPermissions, p));
}

export function getEffectivePermissions(
  role: keyof typeof RolePermissions,
  overrides: bigint = 0n
): bigint {
  return RolePermissions[role] | overrides;
}

export function permissionNames(permissions: bigint): PermissionKey[] {
  return (Object.entries(Permission) as [PermissionKey, bigint][])
    .filter(([, value]) => (permissions & value) === value)
    .map(([key]) => key);
}

/** Build a permission bitmask from a list of permission KEYS. Unknown keys are
 *  ignored (so untrusted input can't set bogus bits). Inverse of permissionNames. */
export function permissionMaskFromKeys(keys: string[]): bigint {
  let mask = 0n;
  for (const k of keys) {
    const bit = (Permission as Record<string, bigint | undefined>)[k];
    if (typeof bit === "bigint") mask |= bit;
  }
  return mask;
}

/** True if `subset` grants nothing beyond `superset` (every set bit in subset
 *  is also set in superset). Used to stop an admin minting a work-role that
 *  grants permissions they don't themselves hold. */
export function isPermissionSubset(subset: bigint, superset: bigint): boolean {
  return (subset & ~superset) === 0n;
}
