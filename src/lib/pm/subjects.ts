import { prisma } from "@/lib/db/client";

/**
 * PM register entities that can be "drilled into" like a work item — each gets
 * a detail drawer with inline editing, comments, and an activity log. Comments
 * and Activity attach to them polymorphically via (subjectType, subjectId).
 */
export type PmSubjectType =
  | "risk"
  | "change"
  | "blocker"
  | "milestone"
  | "deliverable"
  | "vendor"
  | "staff"
  | "clin";

export const PM_SUBJECT_TYPES: PmSubjectType[] = [
  "risk",
  "change",
  "blocker",
  "milestone",
  "deliverable",
  "vendor",
  "staff",
  "clin",
];

export function isPmSubjectType(v: string): v is PmSubjectType {
  return (PM_SUBJECT_TYPES as string[]).includes(v);
}

export interface PmSubject {
  title: string;
  code: string | null;
  /** The register sub-page segment, for building deep-link URLs. */
  urlSeg: string;
}

/**
 * Verify a subject exists inside this org+project and return display context
 * (title/code + its register page). Returns null if it doesn't belong here —
 * callers treat that as a 404, so comments can't be attached to a foreign id.
 */
export async function resolvePmSubject(
  type: string,
  id: string,
  orgId: string,
  projectId: string,
): Promise<PmSubject | null> {
  const where = { id, orgId, projectId };
  switch (type) {
    case "risk": {
      const r = await prisma.risk.findFirst({ where, select: { title: true, code: true } });
      return r ? { title: r.title, code: r.code, urlSeg: "risks" } : null;
    }
    case "change": {
      const r = await prisma.changeRequest.findFirst({ where, select: { title: true, code: true } });
      return r ? { title: r.title, code: r.code, urlSeg: "changes" } : null;
    }
    case "blocker": {
      const r = await prisma.blocker.findFirst({ where, select: { title: true, code: true } });
      return r ? { title: r.title, code: r.code, urlSeg: "blockers" } : null;
    }
    case "milestone": {
      const r = await prisma.milestone.findFirst({ where, select: { title: true } });
      return r ? { title: r.title, code: null, urlSeg: "schedule" } : null;
    }
    case "deliverable": {
      const r = await prisma.deliverable.findFirst({ where, select: { title: true, code: true } });
      return r ? { title: r.title, code: r.code, urlSeg: "deliverables" } : null;
    }
    case "vendor": {
      const r = await prisma.contract.findFirst({ where, select: { title: true } });
      return r ? { title: r.title, code: null, urlSeg: "vendors" } : null;
    }
    case "staff": {
      const r = await prisma.projectMember.findFirst({
        where: { id, projectId, orgMember: { orgId } },
        select: { orgMember: { select: { user: { select: { displayName: true } } } } },
      });
      return r ? { title: r.orgMember.user.displayName, code: null, urlSeg: "staffing" } : null;
    }
    case "clin": {
      const r = await prisma.clin.findFirst({ where, select: { title: true, code: true } });
      return r ? { title: r.title, code: r.code, urlSeg: "clins" } : null;
    }
    default:
      return null;
  }
}

/**
 * Resolved far-end of a cross-reference link. Same shape as the link API rows:
 * carries the subject's kind + id alongside its display title/code and the
 * register page segment (for deep-linking). `work_item` is included here (it is
 * NOT a PmSubjectType — comments/activity don't attach to it) so a PM entity can
 * link to a board item; its "code" is the `#<ticketNumber>` ticket reference
 * (the schema has no `identifier` column).
 */
export type LinkSubjectType = PmSubjectType | "work_item";

export interface ResolvedLinkSubject {
  type: LinkSubjectType;
  id: string;
  title: string;
  code: string | null;
  urlSeg: string;
}

export async function resolveLinkSubject(
  type: string,
  id: string,
  orgId: string,
  projectId: string,
): Promise<ResolvedLinkSubject | null> {
  if (type === "work_item") {
    const w = await prisma.workItem.findFirst({
      where: { id, orgId, projectId },
      select: { title: true, ticketNumber: true },
    });
    return w
      ? {
          type: "work_item",
          id,
          title: w.title,
          code: w.ticketNumber != null ? `#${w.ticketNumber}` : null,
          urlSeg: "work-items",
        }
      : null;
  }

  if (isPmSubjectType(type)) {
    const s = await resolvePmSubject(type, id, orgId, projectId);
    return s ? { type, id, title: s.title, code: s.code, urlSeg: s.urlSeg } : null;
  }

  return null;
}
