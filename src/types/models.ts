export interface Project {
  id: string;
  orgId: string;
  name: string;
  key: string;
  description: string | null;
  settings: Record<string, unknown>;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  boards?: Board[];
  cycles?: Cycle[];
}

export interface Board {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  type:
    | "KANBAN"
    | "SCRUM"
    | "BACKLOG"
    | "TABLE"
    | "CALENDAR"
    | "TIMELINE"
    | "OKR"
    | "DASHBOARD"
    | "PORTFOLIO"
    | "RAID"
    | "ROADMAP"
    | "CFD"
    | "PROGRAM";
  config: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  columns?: BoardColumn[];
}

export interface BoardColumn {
  id: string;
  boardId: string;
  name: string;
  key: string;
  color: string;
  wipLimit: number | null;
  sortOrder: number;
  category: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
}

export interface WorkItemTypeInfo {
  id: string;
  key: string;
  name: string;
  icon: string | null;
  color: string | null;
  celebrateOnComplete?: boolean;
}

export interface WorkItem {
  id: string;
  orgId: string;
  projectId: string;
  workItemTypeId: string;
  title: string;
  description: string;
  columnKey: string;
  assigneeId: string | null;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  cycleId: string | null;
  parentId: string | null;
  ticketNumber: number;
  storyPoints: number | null;
  sortOrder: number;
  dueDate: string | null;
  startDate: string | null;
  /** Gantt baseline (frozen planned dates); the ghost bar draws from these. */
  baselineStart: string | null;
  baselineEnd: string | null;
  /** Unified date model: actual start (auto-captured on first in-progress). */
  actualStart: string | null;
  completedAt: string | null;
  /** SAFe classification: main-effort value vs enabling work. */
  workCategory: "BUSINESS" | "ENABLER";
  tags: string[];
  customFields: Record<string, unknown>;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  workItemType?: WorkItemTypeInfo;
  /** Populated by routes that `include` the hierarchy (detail + list GET). */
  parent?: WorkItemRef | null;
  children?: WorkItemRef[];
  /** Multi-assign (FR 1d38496a): the FULL assignee set, primary first.
   *  `assigneeId` stays the primary/owner. */
  assignees?: WorkItemAssigneeRef[];
}

/** One member of a work item's assignee set. */
export interface WorkItemAssigneeRef {
  userId: string;
  user?: { id: string; displayName: string; avatarUrl: string | null };
}

/** Lightweight work-item reference used for parent/children links. */
export interface WorkItemRef {
  id: string;
  title: string;
  ticketNumber: number;
  workItemTypeId: string;
  columnKey?: string;
}

export interface Cycle {
  id: string;
  orgId: string;
  projectId: string;
  cycleKind: string;
  number: number;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  report: Record<string, unknown> | null;
}

export interface Comment {
  id: string;
  orgId: string;
  workItemId: string;
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  author?: OrgMember;
  /** Resolved server-side (comments GET) — author name + per-actor CRUD flags. */
  authorName?: string | null;
  authorAvatarUrl?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
}

export interface Activity {
  id: string;
  orgId: string;
  workItemId: string;
  userId: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  user?: OrgMember;
}

export interface OrgMember {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  user?: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    email: string;
  };
}

export interface ProjectMember {
  id: string;
  projectId: string;
  orgMemberId: string;
  role: "MANAGER" | "LEAD" | "MEMBER" | "VIEWER";
  orgMember?: OrgMember;
}

/** @deprecated OKRs are now managed as WorkItems with an objective/key-result work-item type. */
export interface Objective {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string | null;
  ownerId: string | null;
  period: string | null;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  progress: number;
  /** Target/end date for health (FR a94ff583); null = no dated signal. */
  targetDate?: string | null;
  /** Server-derived stoplight: progress vs. time toward targetDate. */
  health?: "done" | "on_track" | "at_risk" | "behind" | "no_date";
  /** Manual display order within the project (drag-to-reorder). */
  sortOrder: number;
  /** Alignment: the objective this one ladders up to (null = top-level). */
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  keyResults?: KeyResult[];
  owner?: OrgMember;
}

/** A ticket linked to a Key Result (as returned in the objectives payload). */
export interface KeyResultLinkedItem {
  id: string;
  ticketNumber: number;
  title: string;
  columnKey: string;
  completedAt: string | null;
}

/** @deprecated Key results are now managed as WorkItems. */
export interface KeyResult {
  id: string;
  objectiveId: string;
  title: string;
  description: string | null;
  startValue: number;
  currentValue: number;
  targetValue: number;
  unit: string;
  /** true = metric improves going down (latency/cost); progress runs start→target descending. */
  lowerIsBetter: boolean;
  status: "NOT_STARTED" | "IN_PROGRESS" | "AT_RISK" | "ON_TRACK" | "DONE";
  ownerId: string | null;
  sortOrder: number;
  /** Latest check-in snapshot (null until the first check-in). */
  confidence: number | null;
  rag: "GREEN" | "YELLOW" | "RED" | null;
  createdAt: string;
  updatedAt: string;
  owner?: OrgMember;
  /** OKR→tickets (FR a94ff583): when the KR has linked tickets it AUTO-tracks —
   *  currentValue = linkedDone. These are populated by the objectives GET. */
  autoTracked?: boolean;
  linkedTotal?: number;
  linkedDone?: number;
  linkedItems?: KeyResultLinkedItem[];
}

/** A point-in-time key-result check-in (OKR health over time). */
export interface KeyResultCheckin {
  id: string;
  keyResultId: string;
  value: number;
  confidence: number;
  rag: "GREEN" | "YELLOW" | "RED";
  note: string | null;
  blockers: string | null;
  checkedInById: string | null;
  createdAt: string;
}

export interface CrmContact {
  id: string;
  orgId: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  stage: "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION" | "CLOSED_WON" | "CLOSED_LOST";
  dealValue: string | null;
  ownerId: string | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  owner?: OrgMember;
}

export interface Note {
  id: string;
  orgId: string;
  projectId: string | null;
  authorId: string;
  title: string;
  content: string;
  visibility: "PRIVATE" | "PROJECT" | "ORG";
  createdAt: string;
  updatedAt: string;
  author?: OrgMember;
}

export interface Notification {
  id: string;
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  refType: string | null;
  refId: string | null;
  read: boolean;
  url?: string | null;
  createdAt: string;
}

export interface Partner {
  id: string;
  orgId: string;
  name: string;
  type: "PRIME" | "SUB" | "TEAMING" | "VENDOR" | "OTHER";
  contactName: string | null;
  contactEmail: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  sku: string | null;
  price: string | null;
  currency: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export interface Contract {
  id: string;
  orgId: string;
  title: string;
  contractNumber: string | null;
  type: "FIXED_PRICE" | "TIME_MATERIALS" | "COST_PLUS" | "IDIQ" | "BPA" | "OTHER";
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "TERMINATED";
  value: string | null;
  startDate: string | null;
  endDate: string | null;
  partnerId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  partner?: Partner;
}

export interface BoardTemplate {
  slug: string;
  name: string;
  category: "agile" | "planning" | "strategy" | "analytics" | "tracking" | "enterprise";
  methodology?: string;
  description: string;
  icon: string;
  boardType: string;
}

export interface DashboardWidget {
  id: string;
  type: string;
  config: Record<string, unknown>;
  layout: { x: number; y: number; w: number; h: number };
}

export interface BuilderWidget {
  id: string;
  type: string;
  config: Record<string, unknown>;
  layout: { x: number; y: number; w: number; h: number };
}

export type CustomFieldType =
  | "TEXT"
  | "NUMBER"
  | "DATE"
  | "SELECT"
  | "MULTI_SELECT"
  | "CHECKBOX"
  | "URL"
  | "EMAIL"
  | "USER";

/** A custom field's binding to a specific work-item type. When a field has one
 *  or more bindings it only renders for items of those types; no bindings ⇒ the
 *  field shows on every item. */
export interface WorkItemTypeFieldBinding {
  id: string;
  workItemTypeId: string;
  customFieldId: string;
  required: boolean;
  sortOrder: number;
}

export interface CustomField {
  id: string;
  orgId: string;
  /** null ⇒ org-wide; otherwise scoped to a single project. */
  projectId: string | null;
  name: string;
  key: string;
  fieldType: CustomFieldType;
  options: string[];
  required: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt?: string;
  /** Populated when the defs API `include`s type bindings. */
  typeBindings?: WorkItemTypeFieldBinding[];
}

// Phase 4: Time Tracking, Finance, Sync Meetings

export interface TimeEntry {
  id: string;
  orgId: string;
  userId: string;
  projectId: string | null;
  workItemId: string | null;
  clinId: string | null;
  date: string;
  hours: number;
  rate: string | null;
  client: string | null;
  description: string;
  billableType: "BILLABLE" | "NON_BILLABLE" | "INTERNAL";
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  approvedById: string | null;
  approvedAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Revenue {
  id: string;
  orgId: string;
  amount: string;
  currency: string;
  date: string;
  client: string | null;
  product: string | null;
  type: "RECURRING" | "ONE_TIME" | "PROJECT_BASED";
  description: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface Expense {
  id: string;
  orgId: string;
  amount: string;
  currency: string;
  date: string;
  category: string;
  vendor: string | null;
  description: string;
  recurring: boolean;
  clinId: string | null;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  approvedById: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncMeeting {
  id: string;
  orgId: string;
  title: string;
  projectId: string | null;
  sprintId: string | null;
  meetingDate: string;
  meetingType: "STANDUP" | "SPRINT_PLANNING" | "SPRINT_REVIEW" | "RETROSPECTIVE" | "OTHER";
  status: "SCHEDULED" | "IN_PROGRESS" | "MEETING_COMPLETED" | "CANCELLED";
  transcript: string | null;
  aiSummary: string | null;
  aiTickets: Record<string, unknown>[];
  notes: string;
  meetingUrl: string | null;
  videoProvider: string | null;
  meetSpaceName: string | null;
  meetConferenceName: string | null;
  artifacts: unknown;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  attendees?: MeetingAttendee[];
  /** Org-defined custom meeting-type label, synthesized onto the API response
   *  from the MeetingTypeOption relation (the Prisma model carries only the FK).
   *  Present on both the list and single-meeting GET responses. */
  customTypeLabel?: string | null;
}

export interface MeetingAttendee {
  id: string;
  meetingId: string;
  userId: string;
  doneSinceLast: string;
  workingOn: string;
  blockers: string;
  notes: string;
  user?: OrgMember;
}

// Phase 5: Integrations, Webhooks, Theming

export interface Integration {
  id: string;
  orgId: string;
  provider: string;
  displayName: string;
  config: Record<string, unknown>;
  status: "ACTIVE" | "INACTIVE" | "ERROR";
  installedById: string;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Webhook {
  id: string;
  orgId: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  status: "PENDING" | "SUCCESS" | "FAILED";
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  createdAt: string;
}

export interface Theme {
  id: string;
  orgId: string | null;
  slug: string;
  name: string;
  mode: "LIGHT" | "DARK" | "HIGH_CONTRAST";
  colors: Record<string, string>;
  typography: Record<string, string>;
  spacing: Record<string, string>;
  branding: Record<string, string>;
  isBuiltIn: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserPreferences {
  id: string;
  userId: string;
  themeId: string | null;
  themeMode: "LIGHT" | "DARK" | "HIGH_CONTRAST" | null;
  sidebarPosition: "LEFT" | "RIGHT";
  navigationStyle: "TABS" | "BREADCRUMBS" | "BOTH";
  density: "COMPACT" | "COMFORTABLE" | "SPACIOUS";
  defaultBoardId: string | null;
  methodology: string | null;
  voiceCloseWord: string | null;
  skinId: string | null;
  bgDarkUrl: string | null;
  bgLightUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// Phase 6: Gov/Defense + Enterprise

export type ComplianceFramework = "NIST_800_53" | "NIST_800_171" | "CMMC_L2" | "FEDRAMP_MOD" | "CUSTOM";
export type ControlStatus = "NOT_ASSESSED" | "IN_PROGRESS" | "IMPLEMENTED" | "PARTIALLY_IMPLEMENTED" | "NOT_APPLICABLE" | "FAILED";
export type ClassificationLevel = "PUBLIC" | "UNCLASSIFIED" | "FOUO" | "CUI" | "CONFIDENTIAL";

export interface ComplianceControl {
  id: string;
  orgId: string;
  framework: ComplianceFramework;
  controlId: string;
  title: string;
  description: string;
  status: ControlStatus;
  evidence: Record<string, unknown>[];
  notes: string;
  assessedAt: string | null;
  assessedById: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataClassification {
  id: string;
  orgId: string;
  projectId: string | null;
  level: ClassificationLevel;
  markings: string[];
  handlingInstructions: string;
  appliedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  orgId: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  lastActiveAt: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface IpAllowlistEntry {
  id: string;
  orgId: string;
  cidr: string;
  label: string;
  createdAt: string;
}

export interface OrgSecuritySettings {
  id: string;
  orgId: string;
  mfaRequired: boolean;
  sessionTimeoutMins: number;
  ipAllowlistEnabled: boolean;
  scimEnabled: boolean;
  ssoEnforced: boolean;
  ssoConnectionId: string | null;
  allowedDomains: string[];
  auditRetentionDays: number;
  createdAt: string;
  updatedAt: string;
}

// Phase 7: AI Chat + Advanced Analytics

export interface AssistantConversation {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages?: AssistantMessage[];
}

export interface AssistantMessage {
  id: string;
  conversationId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  content: string;
  toolCalls: Record<string, unknown>[];
  toolCallId: string | null;
  createdAt: string;
}

export interface SavedReport {
  id: string;
  orgId: string;
  createdById: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  schedule: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CycleAnalytics {
  cycleId: string;
  cycleName: string;
  velocity: number;
  completedPoints: number;
  totalPoints: number;
  completedItems: number;
  totalItems: number;
  avgCycleTimeDays: number;
  avgLeadTimeDays: number;
}

export interface PortfolioProject {
  projectId: string;
  projectName: string;
  projectKey: string;
  totalItems: number;
  completedItems: number;
  inProgressItems: number;
  overdueItems: number;
  completionPercent: number;
  activeSprint: string | null;
}
