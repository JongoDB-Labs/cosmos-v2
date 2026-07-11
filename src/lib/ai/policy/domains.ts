// src/lib/ai/policy/domains.ts
//
// The TOOL → coarse DATA-DOMAIN map for the AgentPolicy DOMAIN axis (design D9/§8).
//
// `deniedDomains` on an org's AgentPolicy blocks every tool whose coarse domain is listed
// (e.g. deny `finance` ⇒ no `query_finance`/`log_revenue`/`get_trial_balance`/… can run).
// This is a COARSE grouping over the same tool taxonomy the egress projection uses
// (TOOL_ENTITY in egress/projection.ts) — but it covers EVERY tool (native + connector),
// including ones with no egress entity mapping (finance/google/...), because the domain axis
// is about WHICH TOOL the agent may CALL, not what the model may SEE.
//
// MAINTAINABILITY: this is a flat, explicit, exhaustive record so a reviewer can audit the
// blast radius of each domain at a glance, and a NEW tool surfaces here as a deliberate
// edit (it isn't auto-denied — an UNKNOWN tool falls back to DEFAULT_DOMAIN, see below).
// An arch/contract test (domains.test.ts) asserts every registered tool name has an entry.

/** The known coarse data-domains. `deniedDomains` is validated against this set in the API. */
export const KNOWN_DOMAINS = [
  "work_items",
  "notes",
  "comments",
  "time",
  "finance",
  "crm",
  "compliance",
  "projects",
  "cycles",
  "search",
  "google",
  "github",
  "jira",
  "slack",
  "microsoft365",
  "nango",
  "utility",
] as const;

export type AgentDomain = (typeof KNOWN_DOMAINS)[number];

export const KNOWN_DOMAIN_SET: ReadonlySet<string> = new Set(KNOWN_DOMAINS);

/**
 * The DEFAULT domain for a tool with no explicit mapping. A NEW/unknown tool is NOT
 * auto-denied — it resolves to `utility`, which an org can still block deliberately if it
 * wants a strict allowlist posture (paired with `allowedTools`). Never deny-by-default here:
 * the load-bearing PERMISSIVE default lives in the policy loader, and a missing-from-the-map
 * tool must keep running unless an org explicitly denies `utility` (or the tool by name).
 */
export const DEFAULT_DOMAIN: AgentDomain = "utility";

/**
 * Every tool (native + connector) → its coarse data-domain. Keep EXHAUSTIVE (domains.test.ts
 * enforces it against the live tool catalog). Grouped by domain for auditability.
 */
export const TOOL_DOMAIN: Record<string, AgentDomain> = {
  // ── work_items ──────────────────────────────────────────────────────────────
  query_work_items: "work_items",
  list_work_items: "work_items",
  create_work_item: "work_items",
  update_work_item: "work_items",
  delete_work_item: "work_items",
  // Work-item dependency links are work-item edges — same coarse domain.
  list_item_links: "work_items",
  link_items: "work_items",
  unlink_items: "work_items",

  // ── notes ───────────────────────────────────────────────────────────────────
  create_note: "notes",
  update_note: "notes",
  delete_note: "notes",

  // ── comments ────────────────────────────────────────────────────────────────
  add_comment: "comments",
  list_comments: "comments",
  delete_comment: "comments",
  add_pm_comment: "comments", // PM-dashboard register comments — a comment is a comment

  // ── time ────────────────────────────────────────────────────────────────────
  log_time: "time",
  list_time_entries: "time",

  // ── finance (incl. accounting/GL) ────────────────────────────────────────────
  query_finance: "finance",
  get_finance_summary: "finance",
  log_revenue: "finance",
  log_expense: "finance",
  get_trial_balance: "finance",
  get_profit_and_loss: "finance",

  // ── crm ─────────────────────────────────────────────────────────────────────
  query_crm: "crm",
  create_crm_contact: "crm",
  update_crm_contact: "crm",
  list_partners: "crm",
  list_products: "crm",

  // ── compliance ──────────────────────────────────────────────────────────────
  query_compliance_controls: "compliance",
  update_compliance_control: "compliance",

  // ── projects (incl. govcon PM Dashboard registers, OKRs, planning) ────────────
  list_projects: "projects",
  list_org_members: "projects",
  create_project: "projects",
  update_project: "projects",
  // PM Dashboard register tools (risk/blocker/deliverable/change) — project-management
  // data, grouped under `projects` so an org denies the whole PM agent via one coarse
  // lever (paired with `comments` for add_pm_comment).
  list_risks: "projects",
  create_risk: "projects",
  update_risk: "projects",
  list_blockers: "projects",
  list_deliverables: "projects",
  list_changes: "projects",
  create_blocker: "projects",
  update_blocker: "projects",
  create_deliverable: "projects",
  update_deliverable: "projects",
  create_change_request: "projects",
  update_change_request: "projects",
  // OKRs, milestones, goals, KPIs — project planning/objectives data, same coarse lever.
  list_objectives: "projects",
  create_objective: "projects",
  update_objective: "projects",
  delete_objective: "projects",
  create_key_result: "projects",
  update_key_result: "projects",
  add_kr_checkin: "projects",
  link_key_result_item: "projects",
  list_milestones: "projects",
  create_milestone: "projects",
  update_milestone: "projects",
  delete_milestone: "projects",
  list_goals: "projects",
  create_goal: "projects",
  update_goal: "projects",
  list_kpis: "projects",
  create_kpi: "projects",
  update_kpi: "projects",
  // Boards, documents, meetings, and the product-feedback backlog — project-scoped /
  // product-management surfaces, grouped under `projects` for one coarse deny lever.
  list_boards: "projects",
  list_documents: "projects",
  list_meetings: "projects",
  create_meeting: "projects",
  update_meeting: "projects",
  delete_meeting: "projects",
  list_feedback: "projects",
  create_feedback: "projects",
  set_feedback_status: "projects",

  // ── cycles ──────────────────────────────────────────────────────────────────
  query_cycles: "cycles",
  list_cycles: "cycles",
  create_cycle: "cycles",
  update_cycle: "cycles",
  complete_cycle: "cycles",
  generate_cycle_brief: "cycles",

  // ── search / RAG ─────────────────────────────────────────────────────────────
  semantic_search: "search",

  // ── google workspace ─────────────────────────────────────────────────────────
  read_email: "google",
  search_emails: "google",
  send_email: "google",
  read_google_doc: "google",
  search_contacts: "google",
  list_calendar_events: "google",
  create_calendar_event: "google",
  update_calendar_event: "google",
  delete_calendar_event: "google",
  list_drive_files: "google",
  create_drive_folder: "google",

  // ── github ───────────────────────────────────────────────────────────────────
  github_list_issues: "github",
  github_get_issue: "github",
  github_list_pull_requests: "github",

  // ── jira ─────────────────────────────────────────────────────────────────────
  jira_search_issues: "jira",
  jira_get_issue: "jira",
  jira_create_issue: "jira",
  jira_list_projects: "jira",

  // ── slack ────────────────────────────────────────────────────────────────────
  slack_list_channels: "slack",
  slack_post_message: "slack",
  slack_search_messages: "slack",

  // ── microsoft 365 ─────────────────────────────────────────────────────────────
  m365_list_messages: "microsoft365",
  m365_list_events: "microsoft365",
  m365_list_drive_items: "microsoft365",
  m365_list_users: "microsoft365",

  // ── nango (commercial breadth broker) ─────────────────────────────────────────
  nango_list_connections: "nango",
  nango_get_connection: "nango",
  nango_proxy_request: "nango",

  // ── utility ──────────────────────────────────────────────────────────────────
  fetch_url: "utility",
  process_transcript: "utility",
};

/**
 * Resolve a tool name to its coarse data-domain. An UNKNOWN tool ⇒ {@link DEFAULT_DOMAIN}
 * (`utility`) — NOT auto-denied. A pure lookup; safe to call with any string.
 */
export function domainForTool(toolName: string): AgentDomain {
  return TOOL_DOMAIN[toolName] ?? DEFAULT_DOMAIN;
}
