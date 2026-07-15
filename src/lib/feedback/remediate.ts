import { prisma } from "@/lib/db/client";
import { runModelTurn } from "@/lib/ai/egress";
import { getAiProviderStatus } from "@/lib/ai/ai-credentials";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { teamsNotify } from "@/lib/integrations/teams-notify";
import { createNotification } from "@/lib/notifications/create";
import { readAutomationConfig } from "@/lib/feedback/automation-config";
import {
  scanFeedback,
  delimitUntrustedFeedback,
  redactSecrets,
  type GuardrailResult,
} from "@/lib/feedback/guardrails";
import { judgeFeedbackSecurity, raiseWithJudge } from "@/lib/feedback/security-judge";
import {
  detectLowQuality,
  findFeedbackDuplicate,
  judgeFeedbackScope,
  lowQualityResult,
  duplicateResult,
  scopeResult,
  type IntakeResult,
} from "@/lib/feedback/intake-guardrails";
import type { Candidate } from "@/lib/foreman/dedup";
import {
  planIntake,
  readIntakeLimits,
  throttleMessage,
  type ThrottleReason,
} from "@/lib/feedback/rate-limits";
import {
  canRoleAutoTrigger,
  readRoleGateConfig,
  roleGateMessage,
} from "@/lib/feedback/role-gating";
import type { OrgRole, Prisma } from "@prisma/client";

/**
 * Auto-remediation loop (FR 695aa097) — the in-app half.
 *
 * A scheduled poller (see .github/workflows/feedback-remediation.yml) calls the
 * trigger endpoint, which invokes `runFeedbackRemediation`. For each OPEN,
 * not-yet-delivered feedback item it: routes to a target project (the item's
 * own project if that's in scope, else the org's default — see
 * `resolveDeliveryTarget`), runs a best-effort AI triage, creates a linked work
 * item there (so the item enters the normal board → scheduling → fix
 * workflow), stamps the feedback delivered, and notifies the reporter that their
 * request was picked up. It NEVER merges, deploys, or edits code — delivery into
 * the backlog is the whole job; the actual fix
 * stays a human/agent step downstream (the optional PR-drafting bridge is a
 * separate, opt-in workflow).
 *
 * Guardrails: opt-in per org (settings.autoRemediation.enabled + a non-empty
 * projectIds scope — see `@/lib/feedback/automation-config`), idempotent (only
 * picks up deliveredAt IS NULL, stamps it on success), and per-run capped.
 */

export interface Triage {
  classification: "BUG" | "FEATURE";
  severity: "low" | "medium" | "high" | "critical";
  effort: "S" | "M" | "L" | "XL";
  rationale: string;
  acceptanceCriteria: string[];
  /** How the classification was produced — "ai" or the "heuristic" fallback. */
  source: "ai" | "heuristic";
}

export interface RemediationSummary {
  skipped?: "not-enabled" | "no-ai-credential" | "no-target-project";
  delivered: number;
  scanned: number;
  // Items whose per-item routing (own project / org default) landed outside the
  // scoped + resolvable project set, so they were left undelivered for a later
  // run to retry (e.g. once the org adds that project to scope, or gives it a
  // TODO column). Distinct from a plain no-type skip, which stays uncounted.
  skippedNoTarget: number;
  // Intake-guardrail outcomes (COSMOS-112): items the pre-triage security gate
  // pulled OUT of the autonomous build path. `held` = routed to the human review
  // queue (prompt-injection, malicious intent, a pasted secret, or a high-risk
  // touch zone); `rejected` = content-safety violation. Neither ever produces a
  // work item.
  held: number;
  rejected: number;
  // Intake rate-limit / abuse-throttle outcomes (COSMOS-119, Phase 3a): items a
  // per-user / per-org / queue-depth / build-budget cap or the near-duplicate
  // flood throttle held BACK this run. They stay OPEN (never delivered, never
  // flagged) and a later run re-evaluates them once capacity frees.
  throttled: number;
  // Role-based auto-trigger gating (COSMOS-120, Phase 3b): items whose submitter's
  // org role isn't cleared to auto-trigger a build (e.g. GUEST / VIEWER, or a
  // submitter whose membership no longer resolves). Routed to the human triage
  // queue (IN_REVIEW) instead of the autonomous build path — never a work item.
  gated: number;
  items: { feedbackId: string; workItemId: string; ticketKey: string; triage: Triage }[];
  flagged: { feedbackId: string; decision: "hold" | "reject"; categories: string[]; score: number }[];
  throttledItems: { feedbackId: string; reason: ThrottleReason }[];
  gatedItems: { feedbackId: string; role: OrgRole | null }[];
  // Intake duplicate/redundancy outcomes (COSMOS-113, Phase 2): near-duplicate
  // feedback that was LINKED to an existing item (votes merged) instead of
  // spawning a second ticket. Never produces a work item.
  duplicates: number;
  duplicateItems: { feedbackId: string; dupOf: string; reason: string }[];
}

/** A dedup candidate — an existing feedback item or an open/recently-shipped work
 *  item the new feedback is checked against (COSMOS-113). `ref` is a stable token
 *  echoed by the judge; the discriminator drives how a match is linked/merged. */
export interface DedupCandidate {
  ref: string;
  title: string;
  kind: "feedback" | "work-item";
  feedbackId?: string;
  ticketKey?: string;
  createdAt: Date;
}

/** A project resolved as a valid delivery destination this run: it's in scope,
 *  not archived, and has a usable (TODO, or first-fallback) board column. */
interface DeliveryTarget {
  id: string;
  key: string;
  projectTemplateId: string | null;
  columnKey: string;
}

/** Which project a feedback item is delivered into: its own project if that's in
 *  scope, else the org default if that's in scope, else null (skip — leave undelivered). */
export function resolveDeliveryTarget(
  itemProjectId: string | null,
  projectIds: string[],
  defaultProjectId: string | null,
): string | null {
  if (itemProjectId && projectIds.includes(itemProjectId)) return itemProjectId;
  if (defaultProjectId && projectIds.includes(defaultProjectId)) return defaultProjectId;
  return null;
}

const SEVERITY_TO_PRIORITY: Record<Triage["severity"], string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  critical: "CRITICAL",
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const CLASSIFY_TOOL = {
  name: "classify_feedback",
  description:
    "Return a triage classification for a single product feedback item. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      classification: {
        type: "string",
        enum: ["BUG", "FEATURE"],
        description: "Whether this is a defect (BUG) or a new capability (FEATURE).",
      },
      severity: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
        description: "User impact / urgency.",
      },
      effort: {
        type: "string",
        enum: ["S", "M", "L", "XL"],
        description: "Rough implementation size.",
      },
      rationale: {
        type: "string",
        description: "One or two sentences justifying the classification.",
      },
      acceptanceCriteria: {
        type: "array",
        items: { type: "string" },
        description: "2-5 concrete, checkable criteria the fix must satisfy.",
      },
    },
    required: ["classification", "severity", "effort", "rationale", "acceptanceCriteria"],
  },
} as const;

const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const EFFORTS = new Set(["S", "M", "L", "XL"]);

/** Heuristic classification used when AI triage is unavailable or fails — the
 *  delivery must never depend on the model being reachable. Exported for tests. */
export function heuristicTriage(item: {
  type: "BUG" | "FEATURE";
  telemetry: Prisma.JsonValue;
}): Triage {
  const tel = (item.telemetry ?? {}) as Record<string, unknown>;
  const hasError = !!(tel.stack || tel.errorSignature || tel.digest);
  return {
    classification: item.type,
    severity: item.type === "BUG" && hasError ? "high" : "medium",
    effort: "M",
    rationale: "Heuristic classification (AI triage unavailable).",
    acceptanceCriteria: [],
    source: "heuristic",
  };
}

/** Best-effort AI triage for one item; falls back to the heuristic on any error
 *  or malformed tool output. */
async function triageOne(
  orgId: string,
  tenantClass: "gov" | "commercial",
  item: {
    id: string;
    title: string;
    description: string;
    type: "BUG" | "FEATURE";
    telemetry: Prisma.JsonValue;
  },
): Promise<Triage> {
  try {
    const result = await runModelTurn({
      ctx: {
        orgId,
        conversationId: `feedback-triage-${item.id}`,
        turn: 0,
        tenantClass,
        mode: "enforced",
      },
      system:
        "You are a product-triage assistant for a project-management platform. " +
        "Classify one piece of user feedback so it can be delivered into the work " +
        "backlog. Be decisive and concise. Always call classify_feedback exactly once.",
      messages: [
        {
          role: "user",
          content:
            // The feedback is untrusted user input; delimit it as DATA so the
            // triage model classifies it rather than obeying anything embedded in
            // it (COSMOS-112 §A.2). Secrets are redacted before the model sees them.
            `Reported type: ${item.type}\n` +
            `Client telemetry: ${redactSecrets(JSON.stringify(item.telemetry ?? {}).slice(0, 1200))}\n\n` +
            delimitUntrustedFeedback(`Title: ${item.title}\nDescription: ${item.description || "(none)"}`) +
            "\n\nClassify the feedback above via the classify_feedback tool.",
        },
      ],
      tools: [CLASSIFY_TOOL],
      // Opus 4.8 for triage quality (per maintainer directive) — the alias
      // resolves to claude-opus-4-8 at the egress. Triage is a single
      // classify tool call, so a modest token budget is ample.
      model: "opus",
      maxTokens: 2048,
    });

    const input = result.toolUses.find((t) => t.name === "classify_feedback")?.input as
      | Record<string, unknown>
      | undefined;
    if (input) {
      const classification = input.classification === "BUG" ? "BUG" : "FEATURE";
      const severity = SEVERITIES.has(input.severity as string)
        ? (input.severity as Triage["severity"])
        : "medium";
      const effort = EFFORTS.has(input.effort as string)
        ? (input.effort as Triage["effort"])
        : "M";
      const acceptanceCriteria = Array.isArray(input.acceptanceCriteria)
        ? (input.acceptanceCriteria as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8)
        : [];
      return {
        classification,
        severity,
        effort,
        rationale: typeof input.rationale === "string" ? input.rationale : "",
        acceptanceCriteria,
        source: "ai",
      };
    }
  } catch {
    // fall through to the heuristic — delivery must not depend on the model
  }
  return heuristicTriage(item);
}

/** Resolve a built-in work-item-type id for a feedback classification in the
 *  target project's sector. Cascades through progressively looser matches so an
 *  item is ALWAYS deliverable as long as the sector has ANY built-in type — a
 *  project with no dedicated "bug" type (common) still receives the item as a
 *  task rather than dropping it. Returns null only if the sector has no built-in
 *  types at all. Mirrors the work-items POST resolution, then widens. */
async function resolveTypeId(
  projectTemplateId: string | null,
  classification: "BUG" | "FEATURE",
): Promise<string | null> {
  let sector = "software";
  if (projectTemplateId) {
    const tpl = await prisma.projectTemplate.findUnique({
      where: { id: projectTemplateId },
      select: { sector: true },
    });
    if (tpl?.sector) sector = tpl.sector;
  }

  // Preference order: the classification's own type, then a generic story/task,
  // scoped to the sector first and any sector second.
  const names = classification === "BUG" ? ["bug", "task", "story"] : ["story", "task"];
  for (const name of names) {
    const scoped = await prisma.workItemType.findFirst({
      where: { isBuiltIn: true, key: `${sector}.${name}` },
      select: { id: true },
    });
    if (scoped) return scoped.id;
  }
  for (const name of names) {
    const any = await prisma.workItemType.findFirst({
      where: { isBuiltIn: true, key: { endsWith: `.${name}` } },
      select: { id: true },
    });
    if (any) return any.id;
  }
  // Last resort: any built-in type in this sector, else any built-in type.
  const anyInSector = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: { startsWith: `${sector}.` } },
    select: { id: true },
  });
  if (anyInSector) return anyInSector.id;
  const anyBuiltIn = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true },
    select: { id: true },
  });
  return anyBuiltIn?.id ?? null;
}

function buildDescription(
  item: { title: string; description: string; id: string; voteCount: number },
  triage: Triage,
  authorName: string | null,
): string {
  // STRUCTURAL DEFENSE (COSMOS-112 §A.2): the submitter's own words end up in the
  // coding agent's brief, so DELIMIT them as untrusted data with an explicit
  // instruction hierarchy — the agent must never execute feedback text as
  // commands. Secrets are redacted inside `delimitUntrustedFeedback`.
  const lines = [
    item.description ? delimitUntrustedFeedback(item.description) : "_(no description provided)_",
    "",
    "---",
    `**Auto-triaged from feedback** · ${triage.classification} · severity **${triage.severity}** · effort **${triage.effort}** · ${triage.source === "ai" ? "AI-classified" : "heuristic"}`,
    triage.rationale ? `> ${triage.rationale}` : "",
  ];
  if (triage.acceptanceCriteria.length > 0) {
    lines.push("", "**Acceptance criteria**");
    for (const ac of triage.acceptanceCriteria) lines.push(`- [ ] ${ac}`);
  }
  lines.push("", `Source feedback: \`${item.id}\` (${item.voteCount} vote${item.voteCount === 1 ? "" : "s"})`);
  // Surface the submitter on the delivered ticket so the origin is visible
  // without cross-referencing the feedback board. Omitted when the author
  // couldn't be resolved (e.g. their User row no longer exists).
  if (authorName) lines.push("", `_Reported by ${authorName}_`);
  return lines.filter((l) => l !== undefined).join("\n");
}

/**
 * Deliver the org's OPEN, not-yet-delivered feedback into the work backlog.
 * Returns a summary; `skipped` is set (and `delivered` is 0) when the org hasn't
 * opted in or the target project is unusable.
 */
export async function runFeedbackRemediation(
  orgId: string,
  opts: { actorUserId: string; limit?: number },
): Promise<RemediationSummary> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const empty = (skipped: RemediationSummary["skipped"]): RemediationSummary => ({
    skipped,
    delivered: 0,
    scanned: 0,
    skippedNoTarget: 0,
    held: 0,
    rejected: 0,
    throttled: 0,
    gated: 0,
    items: [],
    flagged: [],
    throttledItems: [],
    gatedItems: [],
    duplicates: 0,
    duplicateItems: [],
  });

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true, settings: true, tenantClass: true },
  });
  if (!org) return empty("not-enabled");

  const { autoRemediation } = readAutomationConfig(org.settings);
  if (!autoRemediation.enabled || autoRemediation.projectIds.length === 0) return empty("not-enabled");

  // ROLE-BASED AUTO-TRIGGER GATING (COSMOS-120, Phase 3b) — which submitter roles
  // may auto-trigger a build vs. route to human triage first. Configurable per
  // org (settings.autoTriggerRoles); default is members-and-above.
  const roleGate = readRoleGateConfig(org.settings);

  // Gate on a connected model provider (per maintainer directive): the loop must
  // NOT deliver on the heuristic fallback — that produced low-signal tickets when
  // no real model was reachable. Require a Claude subscription (OAuth) or a model
  // key connected via Settings → AI, so every delivery reflects actual AI triage.
  // The heuristic remains only as a per-item safety net for a transient model error.
  const ai = await getAiProviderStatus(orgId);
  const hasAi =
    ai.claudeOAuth.connected || ai.anthropic.configured || ai.openai.configured;
  if (!hasAi) return empty("no-ai-credential");

  // Resolve every project in scope ONCE (not just one hardcoded target): each
  // becomes a delivery target if it's live in this org and has a usable board
  // column. A project in scope but missing either is simply absent from the
  // map — its items fall through to the org default (or are skipped) below,
  // rather than aborting the whole run.
  const projects = await prisma.project.findMany({
    where: { id: { in: autoRemediation.projectIds }, orgId, archived: false },
    select: {
      id: true,
      key: true,
      projectTemplateId: true,
      boards: {
        select: { columns: { select: { key: true, category: true, sortOrder: true } } },
        orderBy: { sortOrder: "asc" },
        take: 1,
      },
    },
  });

  const targets = new Map<string, DeliveryTarget>();
  for (const project of projects) {
    // Land new items in the first board's leftmost TODO column (fallback: its
    // first column outright).
    const columns = project.boards[0]?.columns ?? [];
    const sorted = [...columns].sort((a, b) => a.sortOrder - b.sortOrder);
    const columnKey = (sorted.find((c) => c.category === "TODO") ?? sorted[0])?.key;
    if (!columnKey) continue; // no usable column — this project's items skip below
    targets.set(project.id, { id: project.id, key: project.key, projectTemplateId: project.projectTemplateId, columnKey });
  }
  if (targets.size === 0) return empty("no-target-project");

  const tenantClass = org.tenantClass === "COMMERCIAL" ? "commercial" : "gov";

  const pending = await prisma.feedbackItem.findMany({
    where: { orgId, status: "OPEN", deliveredAt: null },
    orderBy: [{ voteCount: "desc" }, { createdAt: "asc" }],
    take: limit,
    select: {
      id: true,
      title: true,
      description: true,
      type: true,
      telemetry: true,
      voteCount: true,
      projectId: true,
      authorId: true,
      // Ordering key for intake dedup: a new item is only ever linked to an
      // OLDER candidate, so two near-duplicate items filed together can't
      // annihilate each other (the newer one merges into the older).
      createdAt: true,
      // Needed to detect whether an item was ALREADY told it's queued, so a
      // still-throttled item on a later run isn't re-notified every pass.
      triage: true,
    },
  });

  // Resolve submitter display names once for the whole batch (FeedbackItem has
  // no User relation — same migration-free side-query pattern as GET /feedback
  // and work-item comments), so each delivered ticket can carry "Reported by
  // <name>". Falls back to email; a lean select never touches
  // OrgMember.permissions (BigInt).
  const authorIds = [...new Set(pending.map((i) => i.authorId))];
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, displayName: true, email: true },
      })
    : [];
  const authorNameById = new Map(authors.map((u) => [u.id, u.displayName || u.email]));

  // Resolve each submitter's ORG ROLE for the role-based auto-trigger gate
  // (COSMOS-120). A lean select — `userId` + `role` only — never touches
  // OrgMember.permissions (the decimal-string bitmask). A submitter with no
  // membership row (left the org after filing) is absent from the map → treated
  // as lowest-trust by the gate and routed to human triage.
  const memberRoleByUserId = new Map<string, OrgRole>();
  if (authorIds.length) {
    const members = await prisma.orgMember.findMany({
      where: { orgId, userId: { in: authorIds } },
      select: { userId: true, role: true },
    });
    for (const m of members) memberRoleByUserId.set(m.userId, m.role);
  }

  // INTAKE RATE-LIMITS + ABUSE THROTTLING (COSMOS-119, Phase 3a) — decide which
  // candidates this run may admit BEFORE any (expensive) triage / security-judge
  // model call, so a per-user / per-org / queue-depth / build-budget cap or a
  // near-duplicate flood can't turn the whole OPEN backlog into work items and
  // starve everyone else of build capacity. Deterministic + pure; the caps hold
  // even when the model is down. `pending` is already in priority order (votes
  // desc, age asc), so under contention the highest-signal items win the slots.
  //
  // Queue-depth = the org's in-flight build queue: items already delivered into
  // the backlog (deliveredAt set) that haven't reached DONE/DECLINED yet. Guardrail
  // -parked items (IN_REVIEW with deliveredAt still null) are NOT counted — they
  // never entered the build path.
  const queueDepth = await prisma.feedbackItem.count({
    where: { orgId, deliveredAt: { not: null }, status: { in: ["PLANNED", "IN_PROGRESS", "IN_REVIEW"] } },
  });
  const limits = readIntakeLimits(org.settings);
  const plan = planIntake(
    pending.map((i) => ({ id: i.id, authorId: i.authorId, type: i.type, title: i.title, description: i.description })),
    { queueDepth },
    limits,
  );
  const admittedIds = new Set(plan.admit);
  const throttleReasonById = new Map(plan.throttled.map((t) => [t.id, t.reason]));

  // Hold the throttled items back: leave them OPEN (a later run re-evaluates once
  // capacity frees) and tell the submitter ONCE that their request is queued.
  const throttledItems: RemediationSummary["throttledItems"] = [];
  for (const item of pending) {
    const reason = throttleReasonById.get(item.id);
    if (!reason) continue;
    throttledItems.push({ feedbackId: item.id, reason });
    await notifyThrottledFeedback(org, item, reason, opts.actorUserId);
  }

  const delivered: RemediationSummary["items"] = [];
  const flagged: RemediationSummary["flagged"] = [];
  const gatedItems: RemediationSummary["gatedItems"] = [];
  const duplicateItems: RemediationSummary["duplicateItems"] = [];
  const byProject = new Map<string, { key: string; count: number }>();
  let skippedNoTarget = 0;

  // INTAKE DUPLICATE POOL (COSMOS-113, Phase 2) — build the candidate set the new
  // feedback is deduped against ONCE per run: existing feedback (any live status)
  // plus open / recently-shipped work items. Each carries a stable `ref` the LLM
  // judge echoes and a discriminator so a match is linked/merged correctly. Only
  // materialized when something was admitted this run.
  const dedupPool: DedupCandidate[] = [];
  if (admittedIds.size > 0) {
    const recentlyShippedSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const feedbackPool = await prisma.feedbackItem.findMany({
      where: { orgId, status: { in: ["OPEN", "PLANNED", "IN_PROGRESS", "IN_REVIEW", "DONE"] } },
      select: { id: true, title: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 400,
    });
    const workItemPool = await prisma.workItem.findMany({
      where: { orgId, updatedAt: { gte: recentlyShippedSince } },
      // WorkItem has no `project` relation field (only `projectId`), so ticket
      // keys are resolved via a project-key side lookup below.
      select: { id: true, title: true, ticketNumber: true, projectId: true, createdAt: true },
      orderBy: { updatedAt: "desc" },
      take: 400,
    });
    const projectKeyById = new Map<string, string>();
    if (workItemPool.length > 0) {
      const keyRows = await prisma.project.findMany({
        where: { id: { in: [...new Set(workItemPool.map((w) => w.projectId))] } },
        select: { id: true, key: true },
      });
      for (const p of keyRows) projectKeyById.set(p.id, p.key);
    }
    for (const f of feedbackPool) {
      dedupPool.push({ ref: `F:${f.id}`, title: f.title, kind: "feedback", feedbackId: f.id, createdAt: f.createdAt });
    }
    for (const w of workItemPool) {
      const projectKey = projectKeyById.get(w.projectId);
      if (!projectKey) continue;
      const ticketKey = `${projectKey}-${w.ticketNumber}`;
      dedupPool.push({ ref: ticketKey, title: w.title, kind: "work-item", ticketKey, createdAt: w.createdAt });
    }
  }
  const dedupByRef = new Map(dedupPool.map((c) => [c.ref, c]));

  // Candidates for one item: every work item, plus feedback items OLDER than it
  // (never itself). The older-only rule keeps a duplicate pair deterministic — the
  // newer of the two is the one linked away.
  const candidatesFor = (item: { id: string; createdAt: Date }): Candidate[] =>
    dedupPool
      .filter(
        (c) =>
          c.kind === "work-item" ||
          (c.feedbackId !== item.id && c.createdAt.getTime() < item.createdAt.getTime()),
      )
      .map((c) => ({ ref: c.ref, title: c.title }));

  for (const item of pending) {
    // Throttled this run — held back for a later pass (see the rate-limit plan
    // above). Never runs the guardrail / triage / delivery below.
    if (!admittedIds.has(item.id)) continue;

    // INTAKE GUARDRAIL (COSMOS-112 §A, Phase 1) — runs on EVERY item BEFORE it can
    // become a work item. All feedback is untrusted input: prompt-injection /
    // agent-manipulation, malicious/sabotage intent, pasted secrets, and
    // high-risk touch zones are pulled out of the autonomous build path and
    // routed to the human review queue; content-safety violations are rejected.
    // Deterministic + pure, so the security gate holds even when AI triage is down.
    let guardrail = scanFeedback({ title: item.title, description: item.description });

    // The deterministic gate is authoritative first: a content-safety reject or a
    // regex hold pulls the item out of the build path immediately (and records the
    // specific security reason), before the role gate or the AI judge run.
    if (guardrail.decision !== "allow") {
      await parkFlaggedFeedback(org, item, guardrail, opts.actorUserId);
      flagged.push({
        feedbackId: item.id,
        decision: guardrail.decision,
        categories: guardrail.categories,
        score: guardrail.score,
      });
      continue;
    }

    // ROLE-BASED AUTO-TRIGGER GATE (COSMOS-120, Phase 3b) — the item is benign, but
    // a lower-trust submitter (GUEST / VIEWER, or one whose membership no longer
    // resolves) doesn't get to auto-trigger a build: route it to human triage
    // (IN_REVIEW) first. Runs BEFORE the (expensive) AI security-judge and delivery,
    // so a gated item never burns a model call. Configurable per org.
    const role = memberRoleByUserId.get(item.authorId) ?? null;
    if (!canRoleAutoTrigger(role, roleGate)) {
      await parkForHumanTriage(org, item, role, opts.actorUserId);
      gatedItems.push({ feedbackId: item.id, role });
      continue;
    }

    // SECONDARY, HIGHER-RECALL LAYER (COSMOS-117) — an optional LLM security-judge
    // on Foreman's own subscription runs AFTER the deterministic gate to catch
    // sophisticated injection / malicious intent the regex missed, RAISING a
    // would-be "allow" to "hold". Fail-safe: on model outage / no subscription /
    // malformed output the verdict is null and the deterministic decision stands
    // (never fail-open). The structural delimiter remains the primary control.
    const verdict = await judgeFeedbackSecurity({
      orgId,
      tenantClass,
      title: item.title,
      description: item.description,
      feedbackId: item.id,
    });
    guardrail = raiseWithJudge(guardrail, verdict);

    if (guardrail.decision !== "allow") {
      await parkFlaggedFeedback(org, item, guardrail, opts.actorUserId);
      flagged.push({
        feedbackId: item.id,
        decision: guardrail.decision,
        categories: guardrail.categories,
        score: guardrail.score,
      });
      continue;
    }

    // INTAKE QUALITY FLOOR (COSMOS-113, Phase 2) — deterministic reject of empty /
    // nonsense / spam feedback BEFORE any routing or model call. Pure + free, so
    // junk never consumes a delivery slot or an AI turn, even when the model is down.
    const lowQuality = detectLowQuality({ title: item.title, description: item.description });
    if (lowQuality) {
      const result = lowQualityResult(lowQuality);
      await parkFlaggedFeedback(org, item, result, opts.actorUserId);
      flagged.push({ feedbackId: item.id, decision: "reject", categories: result.categories, score: result.score });
      continue;
    }

    // Route BEFORE triaging: an item with no resolvable target never needs an
    // (expensive) AI call — it's left undelivered for a later run either way.
    const targetId = resolveDeliveryTarget(item.projectId, autoRemediation.projectIds, autoRemediation.defaultProjectId);
    const target = targetId ? targets.get(targetId) : undefined;
    if (!target) {
      skippedNoTarget++;
      continue;
    }

    // INTAKE DUPLICATE + SCOPE (COSMOS-113, Phase 2) — once a target is confirmed,
    // decide whether this should become a NEW ticket at all. Fail-safe: on model
    // outage / no Foreman subscription these judges yield unique + actionable, so a
    // genuine request keeps flowing to normal triage below.
    //   - duplicate  → link + merge votes into the canonical item (no new ticket)
    //   - needs-decision / out-of-scope → human review queue (hold)
    //   - low-quality (LLM-caught nonsense) → reject
    const intake = await evaluateIntake(item, candidatesFor(item), { orgId, tenantClass });
    if (intake) {
      if (intake.duplicateOf) {
        const match = dedupByRef.get(intake.duplicateOf.ref);
        if (match) {
          await mergeDuplicateFeedback(org, item, match, intake.duplicateOf.reason, opts.actorUserId);
          duplicateItems.push({ feedbackId: item.id, dupOf: intake.duplicateOf.ref, reason: intake.duplicateOf.reason });
          continue;
        }
        // Ref we can't resolve (shouldn't happen — the judge only returns offered
        // refs) → fall through to normal delivery rather than dropping the item.
      } else {
        await parkFlaggedFeedback(org, item, intake, opts.actorUserId);
        flagged.push({
          feedbackId: item.id,
          decision: intake.decision as "hold" | "reject",
          categories: intake.categories,
          score: intake.score,
        });
        continue;
      }
    }

    const triage = await triageOne(orgId, tenantClass, item);
    const typeId = await resolveTypeId(target.projectTemplateId, triage.classification);
    if (!typeId) {
      // No matching built-in type in this sector — skip this item (leave it
      // un-delivered so a later run can retry once types are seeded).
      continue;
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const maxTicket = await tx.workItem.aggregate({
          where: { orgId, projectId: target.id },
          _max: { ticketNumber: true },
        });
        const ticketNumber = (maxTicket._max.ticketNumber ?? 0) + 1;
        const maxSort = await tx.workItem.aggregate({
          where: { orgId, projectId: target.id, columnKey: target.columnKey },
          _max: { sortOrder: true },
        });
        const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

        const workItem = await tx.workItem.create({
          data: {
            orgId,
            projectId: target.id,
            workItemTypeId: typeId,
            title: item.title,
            description: buildDescription(item, triage, authorNameById.get(item.authorId) ?? null),
            columnKey: target.columnKey,
            priority: SEVERITY_TO_PRIORITY[triage.severity] as never,
            ticketNumber,
            sortOrder,
            columnEnteredAt: new Date(),
            tags: ["auto-triaged", `feedback:${triage.classification.toLowerCase()}`],
            createdById: opts.actorUserId,
          },
          select: { id: true, ticketNumber: true },
        });

        await tx.activity.create({
          data: { orgId, workItemId: workItem.id, userId: opts.actorUserId, action: "created" },
        });

        // Stamp the feedback delivered in the SAME transaction — the deliveredAt
        // filter above makes the whole loop idempotent, so a stamp + create must
        // be atomic (a committed work item without a stamp would be re-created).
        await tx.feedbackItem.update({
          where: { id: item.id },
          data: {
            deliveredAt: new Date(),
            workItemId: workItem.id,
            triage: triage as unknown as Prisma.InputJsonValue,
            status: "PLANNED",
          },
        });

        return workItem;
      });

      const ticketKey = `${target.key}-${created.ticketNumber}`;
      delivered.push({ feedbackId: item.id, workItemId: created.id, ticketKey, triage });
      const bucket = byProject.get(target.id) ?? { key: target.key, count: 0 };
      bucket.count += 1;
      byProject.set(target.id, bucket);

      // Everything from here on is a POST-COMMIT side-effect — the work item and
      // the delivered stamp already committed in the transaction above. Each is
      // best-effort and independently guarded: an audit or realtime hiccup must
      // never abort the run or skip the reporter notification that follows.
      try {
        await logAudit({
          orgId,
          userId: opts.actorUserId,
          action: "feedback.delivered",
          entity: "feedback_item",
          entityId: item.id,
          metadata: {
            workItemId: created.id,
            ticketKey,
            classification: triage.classification,
            severity: triage.severity,
            source: triage.source,
          } as Record<string, string>,
        });
      } catch {
        /* audit is best-effort post-commit */
      }
      try {
        publishToOrg(orgId, "feedback.delivered", {
          feedbackId: item.id,
          workItemId: created.id,
          ticketKey,
        });
      } catch {
        /* realtime is best-effort */
      }

      // Close the loop with the reporter: whoever filed this FR/BR is notified
      // the moment it's picked up and turned into a tracked ticket, so "did
      // anyone see this?" is answered without them watching the board. Rides the
      // existing notification pipeline (bell + SSE + web push) and deep-links to
      // the feedback board (reporters watch feedback status, not the board).
      // Best-effort by contract — a notify hiccup must never fail the delivery.
      try {
        await createNotification({
          orgId,
          userId: item.authorId,
          type: "feedback.delivered",
          title: `Your ${item.type === "BUG" ? "bug report" : "feature request"} is being worked on`,
          message: `"${item.title}" has been triaged into the backlog as ${ticketKey}.`,
          relatedId: item.id,
          relatedType: "feedback_item",
          url: `/${org.slug}/feedback`,
        });
      } catch {
        /* reporter notification is best-effort */
      }
    } catch {
      // A single item's failure must not abort the run — leave it un-delivered
      // for the next pass and continue.
      continue;
    }
  }

  // Teams notification (FR 8a162fe7): one summary post per run, gated on the
  // feedbackDelivered toggle. Fire-and-forget. Grouped by target project so a
  // multi-project run reads as "3 items — TEST: 2, OPS: 1" rather than a flat
  // count; a project with zero delivered items just never appears (no divide,
  // no empty-bucket rendering to guard against).
  if (delivered.length > 0) {
    const lines = delivered
      .map((d) => `<b>${d.ticketKey}</b> — ${d.triage.classification} · ${d.triage.severity}`)
      .join("<br/>");
    const perProject = [...byProject.values()].map((p) => `${p.key}: ${p.count}`).join(", ");
    void teamsNotify(
      orgId,
      "feedbackDelivered",
      `🛠️ <b>${delivered.length} feedback item${delivered.length === 1 ? "" : "s"}</b> triaged into the backlog (${perProject}):<br/>${lines}`,
    );
  }

  return {
    delivered: delivered.length,
    scanned: pending.length,
    skippedNoTarget,
    held: flagged.filter((f) => f.decision === "hold").length,
    rejected: flagged.filter((f) => f.decision === "reject").length,
    throttled: throttledItems.length,
    gated: gatedItems.length,
    items: delivered,
    flagged,
    throttledItems,
    gatedItems,
    duplicates: duplicateItems.length,
    duplicateItems,
  };
}

/**
 * Run the Phase-2 intake judges (COSMOS-113) over one item that has already
 * cleared the security gate + quality floor and has a resolvable delivery target.
 * Returns an `IntakeResult` when the item should NOT become a new ticket (a
 * duplicate, a decision-required hold, an out-of-scope hold, or an LLM-caught
 * nonsense reject), or `null` when it's a unique, actionable request that should
 * proceed to triage. Fail-safe: both judges return unique/actionable on model
 * outage, so this only ever pulls items OUT of the build path, never blocks a
 * genuine request on model availability.
 */
async function evaluateIntake(
  item: { id: string; title: string; description: string; createdAt: Date },
  candidates: Candidate[],
  ctx: { orgId: string; tenantClass: "gov" | "commercial" },
): Promise<IntakeResult | null> {
  const judgeInput = {
    orgId: ctx.orgId,
    tenantClass: ctx.tenantClass,
    feedbackId: item.id,
    title: item.title,
    description: item.description,
  };

  // Duplicate first: a redundant request should be linked, not scope-classified.
  const dup = await findFeedbackDuplicate(judgeInput, candidates);
  if (dup) return duplicateResult(dup.dupOf, dup.reason);

  // Necessity / scope / actionability.
  const scope = await judgeFeedbackScope(judgeInput);
  if (scope) return scopeResult(scope);

  return null;
}

/**
 * Link a near-duplicate feedback item to the canonical item it matched and merge
 * its votes, instead of spawning a second ticket (COSMOS-113 acceptance §1). The
 * duplicate is DECLINED (drops out of the OPEN "to-deliver" scan → idempotent),
 * `deliveredAt` stays NULL (it was never delivered), and the link is recorded on
 * `triage.duplicate`. When the match is another FEEDBACK item, its distinct voters
 * are moved onto the canonical item and the denormalized `voteCount` is bumped by
 * the number actually merged (overlapping voters aren't double-counted). A
 * work-item match is linked only (work items have no votes). Every post-commit
 * side-effect is best-effort/guarded — a logging or notify hiccup must never abort
 * the run or re-process the item.
 */
export async function mergeDuplicateFeedback(
  org: { id: string; slug: string },
  item: { id: string; title: string; type: "BUG" | "FEATURE"; authorId: string },
  match: DedupCandidate,
  reason: string,
  actorUserId: string,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const data: Prisma.FeedbackItemUpdateInput = {
        status: "DECLINED",
        triage: {
          duplicate: {
            ref: match.ref,
            kind: match.kind,
            reason,
            targetFeedbackId: match.feedbackId ?? null,
            ticketKey: match.ticketKey ?? null,
          },
        } as unknown as Prisma.InputJsonValue,
      };

      if (match.kind === "feedback" && match.feedbackId) {
        const targetId = match.feedbackId;
        const [dupVotes, targetVotes] = await Promise.all([
          tx.feedbackVote.findMany({ where: { feedbackItemId: item.id }, select: { userId: true } }),
          tx.feedbackVote.findMany({ where: { feedbackItemId: targetId }, select: { userId: true } }),
        ]);
        const alreadyVoted = new Set(targetVotes.map((v) => v.userId));
        const toMove = dupVotes.filter((v) => !alreadyVoted.has(v.userId));
        if (toMove.length > 0) {
          await tx.feedbackVote.createMany({
            data: toMove.map((v) => ({ feedbackItemId: targetId, userId: v.userId })),
            skipDuplicates: true,
          });
          await tx.feedbackItem.update({
            where: { id: targetId },
            data: { voteCount: { increment: toMove.length } },
          });
        }
        // Votes now live on the canonical item; drop the duplicate's own rows +
        // zero its denormalized count so nothing is double-represented.
        await tx.feedbackVote.deleteMany({ where: { feedbackItemId: item.id } });
        data.voteCount = 0;
      }

      await tx.feedbackItem.update({ where: { id: item.id }, data });
    });
  } catch {
    // Couldn't persist the merge — leave the item OPEN for a clean retry.
    return;
  }

  try {
    await logAudit({
      orgId: org.id,
      userId: actorUserId,
      action: "feedback.intake_duplicate",
      entity: "feedback_item",
      entityId: item.id,
      metadata: { dupOf: match.ref, kind: match.kind, reason } as Record<string, string>,
    });
  } catch {
    /* audit is best-effort */
  }

  try {
    publishToOrg(org.id, "feedback.duplicate", { feedbackId: item.id, dupOf: match.ref });
  } catch {
    /* realtime is best-effort */
  }

  // Tell the submitter what their request matched — and that their vote carried
  // over — so a duplicate reads as "we already have this" rather than a silent drop.
  try {
    const matchedLabel = match.ticketKey ? `${match.ticketKey} ("${match.title}")` : `"${match.title}"`;
    await createNotification({
      orgId: org.id,
      userId: item.authorId,
      type: "feedback.duplicate",
      title: `Your ${item.type === "BUG" ? "bug report" : "feature request"} matches an existing one`,
      message:
        `"${item.title}" looks like a duplicate of ${matchedLabel}. ` +
        `We linked it and merged your vote instead of opening a second ticket.`,
      relatedId: item.id,
      relatedType: "feedback_item",
      url: `/${org.slug}/feedback`,
    });
  } catch {
    /* reporter notification is best-effort */
  }
}

/**
 * An item held back by an intake rate-limit / abuse throttle (COSMOS-119). Unlike
 * a guardrail park, this is NOT a safety decision and NOT terminal: the item stays
 * OPEN with `deliveredAt` NULL, so a later run picks it up automatically once
 * capacity frees. We only tell the submitter ONCE — a `triage.throttle` marker
 * records that we already did, so a still-throttled item isn't re-notified every
 * pass. Every write is best-effort/guarded — a notify or audit hiccup must never
 * abort the run.
 */
async function notifyThrottledFeedback(
  org: { id: string; slug: string },
  item: { id: string; title: string; type: "BUG" | "FEATURE"; authorId: string; triage: Prisma.JsonValue },
  reason: ThrottleReason,
  actorUserId: string,
): Promise<void> {
  // Idempotent notification: skip if we already told this submitter it's queued.
  const existing = (item.triage ?? null) as { throttle?: unknown } | null;
  const alreadyNotified = !!(existing && typeof existing === "object" && existing.throttle);
  if (alreadyNotified) return;

  try {
    await prisma.feedbackItem.update({
      where: { id: item.id },
      data: {
        // Record the throttle WITHOUT changing status or stamping deliveredAt —
        // the item must remain in the OPEN "to-deliver" scan for the next run.
        triage: { throttle: { reason } } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch {
    // If we can't persist the marker, don't notify — a later run retries cleanly.
    return;
  }

  try {
    await logAudit({
      orgId: org.id,
      userId: actorUserId,
      action: "feedback.intake_throttled",
      entity: "feedback_item",
      entityId: item.id,
      metadata: { reason } as Record<string, string>,
    });
  } catch {
    /* audit is best-effort */
  }

  try {
    publishToOrg(org.id, "feedback.throttled", { feedbackId: item.id, reason });
  } catch {
    /* realtime is best-effort */
  }

  try {
    await createNotification({
      orgId: org.id,
      userId: item.authorId,
      type: "feedback.throttled",
      title: `Your ${item.type === "BUG" ? "bug report" : "feature request"} is queued`,
      message: `"${item.title}" is queued — ${throttleMessage(reason)}.`,
      relatedId: item.id,
      relatedType: "feedback_item",
      url: `/${org.slug}/feedback`,
    });
  } catch {
    /* reporter notification is best-effort */
  }
}

/**
 * A benign feedback item whose submitter's org role isn't cleared to auto-trigger
 * a build (COSMOS-120, Phase 3b) — pull it OUT of the autonomous build path and
 * into the HUMAN TRIAGE queue, where a person decides whether it becomes work.
 * Distinct from a guardrail park: this is a TRUST decision about the submitter, not
 * a safety decision about the content. NEVER creates a work item and NEVER stamps
 * `deliveredAt`:
 *   - status → IN_REVIEW so the item drops out of the OPEN "to-deliver" scan and
 *     the run stays idempotent (a later run won't re-gate it).
 * The gate decision (the submitter's role) is recorded on `triage.roleGate`,
 * audit-logged for accountability, and surfaced to the submitter as "a human will
 * look first". Every write is best-effort/guarded — a logging or notify hiccup
 * must never abort the run.
 */
async function parkForHumanTriage(
  org: { id: string; slug: string },
  item: { id: string; title: string; type: "BUG" | "FEATURE"; authorId: string },
  role: OrgRole | null,
  actorUserId: string,
): Promise<void> {
  try {
    await prisma.feedbackItem.update({
      where: { id: item.id },
      data: {
        // The status change alone makes the run idempotent (the poller only scans
        // status: "OPEN"). deliveredAt is deliberately LEFT NULL — a gated item was
        // never delivered into the backlog.
        status: "IN_REVIEW",
        triage: {
          roleGate: {
            decision: "human-triage",
            role: role ?? "none",
            reason: `Submitter role ${role ?? "none"} is not cleared to auto-trigger a build.`,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch {
    // If we can't persist the decision, do NOT log/notify — a later run re-evaluates
    // the still-OPEN item deterministically.
    return;
  }

  try {
    await logAudit({
      orgId: org.id,
      userId: actorUserId,
      action: "feedback.auto_trigger_gated",
      entity: "feedback_item",
      entityId: item.id,
      metadata: { role: role ?? "none" } as Record<string, string>,
    });
  } catch {
    /* audit is best-effort */
  }

  try {
    publishToOrg(org.id, "feedback.gated", { feedbackId: item.id, role: role ?? null });
  } catch {
    /* realtime is best-effort */
  }

  // Tell the submitter their request went to a human first — without echoing their
  // (possibly secret-bearing) text back, and without naming internal roles.
  try {
    await createNotification({
      orgId: org.id,
      userId: item.authorId,
      type: "feedback.gated",
      title: `Your ${item.type === "BUG" ? "bug report" : "feature request"} needs a human review`,
      message: `"${item.title}" was routed to a teammate — ${roleGateMessage()}.`,
      relatedId: item.id,
      relatedType: "feedback_item",
      url: `/${org.slug}/feedback`,
    });
  } catch {
    /* reporter notification is best-effort */
  }
}

/**
 * A feedback item the intake guardrail flagged — pull it OUT of the autonomous
 * build path and into the human review queue (COSMOS-112 §A/§D). NEVER creates a
 * work item:
 *   - `hold`   → status IN_REVIEW (a human security review; distinct from the
 *                build queue) so it drops out of the OPEN "to-deliver" scan and
 *                the run is idempotent.
 *   - `reject` → status DECLINED (content-safety violation; not actionable).
 * The full guardrail verdict (decision + categories + score + reason) is stored
 * on `triage.guardrail`, audit-logged for accountability, and surfaced back to
 * the submitter. Every write is best-effort/guarded — a logging or notify hiccup
 * must never abort the run or re-flag the item on the next pass.
 */
async function parkFlaggedFeedback(
  org: { id: string; slug: string },
  item: { id: string; title: string; type: "BUG" | "FEATURE"; authorId: string },
  guardrail: GuardrailResult,
  actorUserId: string,
): Promise<void> {
  const nextStatus = guardrail.decision === "reject" ? "DECLINED" : "IN_REVIEW";
  try {
    await prisma.feedbackItem.update({
      where: { id: item.id },
      data: {
        // The status change alone makes the run idempotent: the poller only ever
        // scans `status: "OPEN"`, so IN_REVIEW / DECLINED items drop out and are
        // never re-picked. `deliveredAt` is deliberately LEFT NULL — a flagged
        // item was never delivered into the backlog, and stamping it would
        // mis-count it as "delivered" in the Teams digest / metrics.
        status: nextStatus,
        triage: {
          guardrail: {
            decision: guardrail.decision,
            categories: guardrail.categories,
            score: guardrail.score,
            reason: guardrail.reason,
            findings: guardrail.findings.map((f) => ({ category: f.category, label: f.label })),
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch {
    // If we can't persist the decision, do NOT log/notify — a later run will
    // re-evaluate the still-OPEN item deterministically.
    return;
  }

  // Audit EVERY intake decision for accountability (COSMOS-112 §D).
  try {
    await logAudit({
      orgId: org.id,
      userId: actorUserId,
      action: guardrail.decision === "reject" ? "feedback.intake_rejected" : "feedback.intake_flagged",
      entity: "feedback_item",
      entityId: item.id,
      metadata: {
        decision: guardrail.decision,
        categories: guardrail.categories.join(","),
        score: String(guardrail.score),
        reason: guardrail.reason,
      } as Record<string, string>,
    });
  } catch {
    /* audit is best-effort */
  }

  try {
    publishToOrg(org.id, "feedback.flagged", {
      feedbackId: item.id,
      decision: guardrail.decision,
      categories: guardrail.categories,
    });
  } catch {
    /* realtime is best-effort */
  }

  // Tell the submitter what happened — without echoing their (possibly
  // secret-bearing) text back. A held item is "under review", a rejected one is
  // declined for a policy reason.
  try {
    await createNotification({
      orgId: org.id,
      userId: item.authorId,
      type: guardrail.decision === "reject" ? "feedback.rejected" : "feedback.flagged",
      title:
        guardrail.decision === "reject"
          ? `Your ${item.type === "BUG" ? "bug report" : "feature request"} couldn't be accepted`
          : `Your ${item.type === "BUG" ? "bug report" : "feature request"} needs a human review`,
      message:
        guardrail.decision === "reject"
          ? `"${item.title}" was declined at intake and won't be actioned automatically.`
          : `"${item.title}" was routed to a human reviewer before any automated work — our intake checks flagged it for a closer look.`,
      relatedId: item.id,
      relatedType: "feedback_item",
      url: `/${org.slug}/feedback`,
    });
  } catch {
    /* reporter notification is best-effort */
  }
}
