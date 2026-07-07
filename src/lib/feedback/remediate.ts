import { prisma } from "@/lib/db/client";
import { runModelTurn } from "@/lib/ai/egress";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { teamsNotify } from "@/lib/integrations/teams-notify";
import type { Prisma } from "@prisma/client";

/**
 * Auto-remediation loop (FR 695aa097) — the in-app half.
 *
 * A scheduled poller (see .github/workflows/feedback-remediation.yml) calls the
 * trigger endpoint, which invokes `runFeedbackRemediation`. For each OPEN,
 * not-yet-delivered feedback item it: runs a best-effort AI triage, creates a
 * linked work item in the org's configured triage project (so the item enters
 * the normal board → scheduling → fix workflow), and stamps the feedback
 * delivered. It NEVER merges, deploys, or edits code — delivery into the backlog
 * is the whole job; the actual fix stays a human/agent step downstream (the
 * optional PR-drafting bridge is a separate, opt-in workflow).
 *
 * Guardrails: opt-in per org (settings.autoRemediation.enabled + targetProjectId),
 * idempotent (only picks up deliveredAt IS NULL, stamps it on success), and
 * per-run capped.
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
  skipped?: "not-enabled" | "no-target-project" | "no-column" | "no-type";
  delivered: number;
  scanned: number;
  items: { feedbackId: string; workItemId: string; ticketKey: string; triage: Triage }[];
}

interface AutoRemediationConfig {
  enabled?: boolean;
  targetProjectId?: string;
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
            `Title: ${item.title}\n` +
            `Reported type: ${item.type}\n` +
            `Description: ${item.description || "(none)"}\n` +
            `Client telemetry: ${JSON.stringify(item.telemetry ?? {}).slice(0, 1200)}\n\n` +
            "Classify this feedback via the classify_feedback tool.",
        },
      ],
      tools: [CLASSIFY_TOOL],
      model: "sonnet",
      maxTokens: 1024,
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
): string {
  const lines = [
    item.description || "_(no description provided)_",
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
    items: [],
  });

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, settings: true, tenantClass: true },
  });
  if (!org) return empty("not-enabled");

  const cfg = ((org.settings as Record<string, unknown>)?.autoRemediation ??
    {}) as AutoRemediationConfig;
  if (!cfg.enabled || !cfg.targetProjectId) return empty("not-enabled");

  const project = await prisma.project.findFirst({
    where: { id: cfg.targetProjectId, orgId, archived: false },
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
  if (!project) return empty("no-target-project");

  // Land new items in the first board's leftmost TODO column (fallback: its
  // first column outright).
  const columns = project.boards[0]?.columns ?? [];
  const sorted = [...columns].sort((a, b) => a.sortOrder - b.sortOrder);
  const columnKey = (sorted.find((c) => c.category === "TODO") ?? sorted[0])?.key;
  if (!columnKey) return empty("no-column");

  const tenantClass = org.tenantClass === "COMMERCIAL" ? "commercial" : "gov";

  const pending = await prisma.feedbackItem.findMany({
    where: { orgId, status: "OPEN", deliveredAt: null },
    orderBy: [{ voteCount: "desc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true, title: true, description: true, type: true, telemetry: true, voteCount: true },
  });

  const delivered: RemediationSummary["items"] = [];

  for (const item of pending) {
    const triage = await triageOne(orgId, tenantClass, item);
    const typeId = await resolveTypeId(project.projectTemplateId, triage.classification);
    if (!typeId) {
      // No matching built-in type in this sector — skip this item (leave it
      // un-delivered so a later run can retry once types are seeded).
      continue;
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const maxTicket = await tx.workItem.aggregate({
          where: { orgId, projectId: project.id },
          _max: { ticketNumber: true },
        });
        const ticketNumber = (maxTicket._max.ticketNumber ?? 0) + 1;
        const maxSort = await tx.workItem.aggregate({
          where: { orgId, projectId: project.id, columnKey },
          _max: { sortOrder: true },
        });
        const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

        const workItem = await tx.workItem.create({
          data: {
            orgId,
            projectId: project.id,
            workItemTypeId: typeId,
            title: item.title,
            description: buildDescription(item, triage),
            columnKey,
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

      const ticketKey = `${project.key}-${created.ticketNumber}`;
      delivered.push({ feedbackId: item.id, workItemId: created.id, ticketKey, triage });

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
      try {
        publishToOrg(orgId, "feedback.delivered", {
          feedbackId: item.id,
          workItemId: created.id,
          ticketKey,
        });
      } catch {
        /* realtime is best-effort */
      }
    } catch {
      // A single item's failure must not abort the run — leave it un-delivered
      // for the next pass and continue.
      continue;
    }
  }

  // Teams notification (FR 8a162fe7): one summary post per run, gated on the
  // feedbackDelivered toggle. Fire-and-forget.
  if (delivered.length > 0) {
    const lines = delivered
      .map((d) => `<b>${d.ticketKey}</b> — ${d.triage.classification} · ${d.triage.severity}`)
      .join("<br/>");
    void teamsNotify(
      orgId,
      "feedbackDelivered",
      `🛠️ <b>${delivered.length} feedback item${delivered.length === 1 ? "" : "s"}</b> triaged into the backlog:<br/>${lines}`,
    );
  }

  return { delivered: delivered.length, scanned: pending.length, items: delivered };
}
