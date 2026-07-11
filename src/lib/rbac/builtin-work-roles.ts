import type { PermissionKey } from "./permissions";

/** Reserved key prefix — custom roles must never use it (enforced in the API). */
export const BUILTIN_KEY_PREFIX = "builtin.";

export type BuiltinWorkRole = {
  key: string;
  name: string;
  description: string;
  permissions: PermissionKey[];
};

/**
 * Out-of-the-box work roles: generalized across project types (not
 * software-specific). Seeded per org with isBuiltIn=true (see
 * builtin-work-roles-seed.ts); read-only in the API; cloneable in the UI.
 */
export const BUILTIN_WORK_ROLES: BuiltinWorkRole[] = [
  {
    key: "builtin.project-manager",
    name: "Project Manager",
    description: "Plan and run projects end to end — boards, work items, sprints, OKRs, meetings, and approvals.",
    permissions: [
      "PROJECT_CREATE", "PROJECT_READ", "PROJECT_UPDATE", "PROJECT_MANAGE",
      "BOARD_CREATE", "BOARD_READ", "BOARD_UPDATE", "BOARD_DELETE", "BOARD_MANAGE",
      "ITEM_CREATE", "ITEM_READ", "ITEM_UPDATE", "ITEM_DELETE", "ITEM_ASSIGN", "ITEM_BULK_EDIT",
      "SPRINT_CREATE", "SPRINT_READ", "SPRINT_UPDATE", "SPRINT_COMPLETE",
      "OKR_CREATE", "OKR_READ", "OKR_UPDATE", "OKR_DELETE",
      "MEETING_CREATE", "MEETING_READ", "MEETING_UPDATE", "MEETING_DELETE",
      "TIME_READ", "TIME_APPROVE",
      "COMMENT_CREATE", "COMMENT_READ",
      "NOTE_CREATE", "NOTE_READ", "NOTE_UPDATE", "NOTE_DELETE",
      "ANALYTICS_READ", "REPORT_CREATE", "TEMPLATE_READ", "NOTIFICATION_READ", "CHAT_USE",
    ],
  },
  {
    key: "builtin.contributor",
    name: "Contributor",
    description: "Do the work: create and update work items, comment, take notes, and track time.",
    permissions: [
      "ITEM_CREATE", "ITEM_READ", "ITEM_UPDATE",
      "BOARD_READ", "SPRINT_READ", "PROJECT_READ",
      "COMMENT_CREATE", "COMMENT_READ",
      "NOTE_CREATE", "NOTE_READ", "NOTE_UPDATE",
      "TIME_CREATE", "TIME_READ", "TIME_UPDATE",
      "MEETING_READ", "NOTIFICATION_READ", "CHAT_USE",
    ],
  },
  {
    key: "builtin.reviewer-approver",
    name: "Reviewer / Approver",
    description: "Review and approve without authoring — update statuses, comment, and sign off on time and expenses.",
    permissions: [
      "ITEM_READ", "ITEM_UPDATE",
      "BOARD_READ", "SPRINT_READ", "PROJECT_READ",
      "COMMENT_CREATE", "COMMENT_READ",
      "TIME_READ", "TIME_APPROVE", "EXPENSE_APPROVE",
      "MEETING_READ", "ANALYTICS_READ", "NOTIFICATION_READ",
    ],
  },
  {
    key: "builtin.operations-coordinator",
    name: "Operations Coordinator",
    description: "Keep the trains running — meetings, notes, assignments, and board upkeep.",
    permissions: [
      "MEETING_CREATE", "MEETING_READ", "MEETING_UPDATE", "MEETING_DELETE",
      "NOTE_CREATE", "NOTE_READ", "NOTE_UPDATE", "NOTE_DELETE",
      "ITEM_READ", "ITEM_UPDATE", "ITEM_ASSIGN",
      "BOARD_READ", "BOARD_UPDATE", "SPRINT_READ", "PROJECT_READ",
      "COMMENT_CREATE", "COMMENT_READ",
      "TIME_READ", "NOTIFICATION_READ", "CHAT_USE",
    ],
  },
  {
    key: "builtin.finance-manager",
    name: "Finance Manager",
    description: "Own the money: finance and accounting management, expense approval, and financial reporting.",
    permissions: [
      "FINANCE_READ", "FINANCE_MANAGE",
      "ACCOUNTING_READ", "ACCOUNTING_MANAGE", "ACCOUNTING_CLOSE",
      "EXPENSE_APPROVE", "CRM_READ",
      "ANALYTICS_READ", "REPORT_CREATE",
      "PROJECT_READ", "COMMENT_CREATE", "COMMENT_READ", "NOTIFICATION_READ",
    ],
  },
  {
    key: "builtin.analyst",
    name: "Analyst",
    description: "See everything, change nothing — read across the org plus comments and report building.",
    permissions: [
      "PROJECT_READ", "BOARD_READ", "ITEM_READ", "SPRINT_READ",
      "OKR_READ", "CRM_READ", "NOTE_READ", "MEETING_READ",
      "TIME_READ", "FINANCE_READ", "ANALYTICS_READ",
      "REPORT_CREATE", "COMMENT_CREATE", "COMMENT_READ",
      "TEMPLATE_READ", "NOTIFICATION_READ",
    ],
  },
  {
    key: "builtin.client-stakeholder",
    name: "Client / Stakeholder",
    description: "External collaborator: follow progress on shared projects and join the conversation.",
    permissions: [
      "PROJECT_READ", "BOARD_READ", "ITEM_READ",
      "COMMENT_CREATE", "COMMENT_READ",
      "MEETING_READ", "NOTIFICATION_READ",
    ],
  },
  {
    key: "builtin.compliance-officer",
    name: "Compliance Officer",
    description: "Oversight without delivery writes — compliance and classification management plus the audit log.",
    permissions: [
      "COMPLIANCE_READ", "COMPLIANCE_MANAGE",
      "CLASSIFICATION_READ", "CLASSIFICATION_MANAGE",
      "AUDIT_LOG_READ",
      "PROJECT_READ", "ITEM_READ", "BOARD_READ",
      "COMMENT_CREATE", "COMMENT_READ",
      "ANALYTICS_READ", "NOTIFICATION_READ",
    ],
  },
];
