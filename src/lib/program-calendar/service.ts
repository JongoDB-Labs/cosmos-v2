import { Prisma, type EventRecurrence } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { visibleProjectRecordsWhere, hiddenProjectIds } from "@/lib/rbac/project-access";
import { ProblemError } from "@/lib/openapi/problem";
import { DEFAULT_CATEGORIES } from "./categories";
import { normalizeRange } from "./time";

/**
 * Reading and writing the program calendar.
 *
 * PROJECT VISIBILITY runs through every read here. A program event may carry a
 * project, and that project may be team-scoped — so the same rule that governs
 * invoices, expenses and bills governs events: `visibleProjectRecordsWhere`
 * returns `{ projectId: null } OR { projectId: notIn hidden }`, which keeps
 * org-level events (the majority, with no project at all) visible to everyone
 * while hiding the ones that hang off a project the reader cannot see. Putting
 * it in the service rather than in each route is deliberate: the equivalent
 * rule on bills was correct in one place and missing in three.
 */

export interface EventFilters {
  categoryIds?: string[];
  /** Owner lane keys: "team:<id>", "member:<id>", or "unassigned". */
  ownerKeys?: string[];
  showOnDashboardOnly?: boolean;
  customerAttending?: boolean;
  hasDeliverable?: boolean;
  projectId?: string;
}

export const eventSelect = {
  id: true,
  title: true,
  startsAt: true,
  endsAt: true,
  allDay: true,
  timeZone: true,
  location: true,
  attendees: true,
  recurrence: true,
  customerAttending: true,
  description: true,
  showOnDashboard: true,
  externalId: true,
  projectId: true,
  deliverableId: true,
  category: { select: { id: true, name: true, tintRgb: true, tintAlpha: true, textColor: true } },
  ownerTeam: { select: { id: true, name: true } },
  ownerMember: { select: { id: true, user: { select: { displayName: true } } } },
} satisfies Prisma.ProgramEventSelect;

export type ProgramEventRow = Prisma.ProgramEventGetPayload<{ select: typeof eventSelect }>;

/** The lane an event sits in: its team, else its owner, else Unassigned. */
export function ownerKeyOf(ev: Pick<ProgramEventRow, "ownerTeam" | "ownerMember">): string {
  if (ev.ownerTeam) return `team:${ev.ownerTeam.id}`;
  if (ev.ownerMember) return `member:${ev.ownerMember.id}`;
  return "unassigned";
}

export function ownerLabelOf(ev: Pick<ProgramEventRow, "ownerTeam" | "ownerMember">): string {
  return ev.ownerTeam?.name ?? ev.ownerMember?.user.displayName ?? "Unassigned";
}

function ownerWhere(keys: string[]): Prisma.ProgramEventWhereInput | null {
  if (!keys.length) return null;
  const teamIds = keys.filter((k) => k.startsWith("team:")).map((k) => k.slice(5));
  const memberIds = keys.filter((k) => k.startsWith("member:")).map((k) => k.slice(7));
  const or: Prisma.ProgramEventWhereInput[] = [];
  if (teamIds.length) or.push({ ownerTeamId: { in: teamIds } });
  if (memberIds.length) or.push({ ownerMemberId: { in: memberIds } });
  // "Unassigned" means neither is set — not merely a null team, since an event
  // owned by a person has a null team and would otherwise be swept in here.
  if (keys.includes("unassigned")) or.push({ ownerTeamId: null, ownerMemberId: null });
  return or.length ? { OR: or } : null;
}

async function scopeWhere(
  ctx: AuthContext,
  f: EventFilters,
): Promise<Prisma.ProgramEventWhereInput> {
  const visible = await visibleProjectRecordsWhere(ctx);
  const owner = ownerWhere(f.ownerKeys ?? []);
  // ONE `AND` array, built once. Spreading two conditional `AND` keys into the
  // same object literal lets the later one silently replace the earlier — it
  // happens to be harmless only while every branch remembers to re-include
  // what it overwrote, which is not a property worth relying on.
  const and: Prisma.ProgramEventWhereInput[] = [];
  if (visible.OR) and.push(visible);
  if (owner) and.push(owner);
  return {
    orgId: ctx.orgId,
    ...(and.length ? { AND: and } : {}),
    ...(f.categoryIds?.length ? { categoryId: { in: f.categoryIds } } : {}),
    ...(f.projectId ? { projectId: f.projectId } : {}),
    ...(f.showOnDashboardOnly ? { showOnDashboard: true } : {}),
    ...(f.customerAttending ? { customerAttending: true } : {}),
    ...(f.hasDeliverable ? { deliverableId: { not: null } } : {}),
  };
}

/**
 * Events touching the half-open window [from, to).
 *
 * The overlap test is `startsAt < to AND endsAt > from`, which is what makes a
 * multi-day event appear in every window it crosses. The naive
 * `startsAt BETWEEN from AND to` drops an event that began last month and
 * is still running — the single most common way a program calendar loses the
 * events that matter most.
 */
export async function listProgramEvents(
  ctx: AuthContext,
  from: Date,
  to: Date,
  f: EventFilters = {},
): Promise<ProgramEventRow[]> {
  return prisma.programEvent.findMany({
    where: { ...(await scopeWhere(ctx, f)), startsAt: { lt: to }, endsAt: { gt: from } },
    select: eventSelect,
    orderBy: [{ startsAt: "asc" }, { title: "asc" }],
  });
}

/** Per-category totals for the same window and filters, for the overlay menu's
 *  counts. Counts ignore the CATEGORY filter itself, so a category you have
 *  switched off still shows how much it would bring back. */
export async function categoryCounts(
  ctx: AuthContext,
  from: Date,
  to: Date,
  f: EventFilters = {},
): Promise<Record<string, number>> {
  const rows = await prisma.programEvent.groupBy({
    by: ["categoryId"],
    where: {
      ...(await scopeWhere(ctx, { ...f, categoryIds: undefined })),
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.categoryId, r._count._all]));
}

/** The org's categories, seeding the defaults the first time one is asked for.
 *  Seeding here rather than at org creation means every existing org gets them
 *  too, without a backfill that would have to guess at orgs created later. */
export async function listCategories(orgId: string) {
  const existing = await prisma.eventCategory.findMany({
    where: { orgId, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  if (existing.length) return existing;

  await prisma.eventCategory.createMany({
    data: DEFAULT_CATEGORIES.map((c, i) => ({ ...c, orgId, sortOrder: i })),
    skipDuplicates: true, // two first-visits racing is fine; both end up correct
  });
  return prisma.eventCategory.findMany({
    where: { orgId, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export interface EventInput {
  title: string;
  categoryId: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timeZone?: string;
  location?: string | null;
  ownerTeamId?: string | null;
  ownerMemberId?: string | null;
  attendees?: string;
  recurrence?: EventRecurrence;
  deliverableId?: string | null;
  customerAttending?: boolean;
  description?: string;
  showOnDashboard?: boolean;
  projectId?: string | null;
  externalId?: string | null;
}

/** An event is owned by a team OR a person, never both — two owners means two
 *  lanes and the swimlane view would have to pick one arbitrarily. */
function oneOwner(input: EventInput): { ownerTeamId: string | null; ownerMemberId: string | null } {
  if (input.ownerTeamId) return { ownerTeamId: input.ownerTeamId, ownerMemberId: null };
  return { ownerTeamId: null, ownerMemberId: input.ownerMemberId ?? null };
}


/**
 * Every id an event REFERENCES must belong to this org, and to a project this
 * caller can see.
 *
 * None of these are free: `ownerTeam` and `deliverable` are selected back and
 * rendered, so an id borrowed from another tenant would print that tenant's
 * team or deliverable NAME into this org's calendar. A foreign `projectId`
 * would attach the event to a project outside the org entirely, where the
 * visibility rule — which is computed from THIS org's hidden projects — has
 * nothing to say about it.
 *
 * It lives in the service, next to the write, rather than in the routes. The
 * category check started life in the route and was therefore one copy of a
 * rule with two call sites, which is the shape that keeps costing us: put it
 * where the write happens and no caller can forget it.
 */
async function assertReferencesInOrg(ctx: AuthContext, input: EventInput): Promise<void> {
  const bad = (what: string) => new ProblemError(400, "invalid_request", `Unknown ${what}`);

  const category = await prisma.eventCategory.findFirst({
    where: { id: input.categoryId, orgId: ctx.orgId, archivedAt: null },
    select: { id: true },
  });
  if (!category) throw bad("category");

  const needsHidden = input.projectId || input.deliverableId || input.ownerTeamId;
  const hidden = needsHidden ? await hiddenProjectIds(ctx) : [];
  const teamHidden = hidden;

  if (input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, orgId: ctx.orgId },
      select: { id: true },
    });
    // Same answer whether the project belongs to another org or is simply one
    // this caller cannot see — the response must not distinguish them.
    // Checked separately rather than as a second `id` key in the same object:
    // two `id` keys in one literal silently collapse to the later one, which
    // would have dropped the id match entirely and accepted ANY project.
    if (!project || hidden.includes(input.projectId)) throw bad("project");
  }

  if (input.ownerTeamId) {
    // A team belongs to a project (`Team.projectId` is not nullable), so a
    // team on a hidden project is itself hidden. Its NAME is rendered as the
    // lane label, so accepting one here would leak it to someone who cannot
    // open the project it belongs to — the same leak the deliverable check
    // below prevents, which is exactly why it has to be made in both places.
    const team = await prisma.team.findFirst({
      where: {
        id: input.ownerTeamId,
        orgId: ctx.orgId,
        ...(teamHidden.length ? { projectId: { notIn: teamHidden } } : {}),
      },
      select: { id: true },
    });
    if (!team) throw bad("owner");
  }

  if (input.ownerMemberId) {
    const member = await prisma.orgMember.findFirst({
      where: { id: input.ownerMemberId, orgId: ctx.orgId, removedAt: null },
      select: { id: true },
    });
    if (!member) throw bad("owner");
  }

  if (input.deliverableId) {
    const deliverable = await prisma.deliverable.findFirst({
      where: {
        id: input.deliverableId,
        orgId: ctx.orgId,
        ...(hidden.length ? { projectId: { notIn: hidden } } : {}),
      },
      select: { id: true },
    });
    if (!deliverable) throw bad("deliverable");
  }
}

export async function createProgramEvent(ctx: AuthContext, createdById: string, input: EventInput) {
  await assertReferencesInOrg(ctx, input);
  const range = normalizeRange(input);
  return prisma.programEvent.create({
    data: {
      orgId: ctx.orgId,
      createdById,
      title: input.title,
      categoryId: input.categoryId,
      ...range,
      allDay: input.allDay,
      timeZone: input.timeZone ?? "America/New_York",
      location: input.location ?? null,
      ...oneOwner(input),
      attendees: input.attendees ?? "",
      recurrence: input.recurrence ?? "NONE",
      deliverableId: input.deliverableId ?? null,
      customerAttending: input.customerAttending ?? false,
      description: input.description ?? "",
      showOnDashboard: input.showOnDashboard ?? false,
      projectId: input.projectId ?? null,
      externalId: input.externalId ?? null,
    },
    select: eventSelect,
  });
}

/** Load an event the caller may actually see, or null.
 *
 *  Visibility is applied to the single-entity read too, not just the list. A
 *  guard that narrows a list but lets any id through by direct fetch is the
 *  shape that leaked bills by id while the list was correct. */
export async function visibleEvent(ctx: AuthContext, eventId: string) {
  const visible = await visibleProjectRecordsWhere(ctx);
  return prisma.programEvent.findFirst({
    where: { id: eventId, orgId: ctx.orgId, ...(visible.OR ? { AND: [visible] } : {}) },
    select: eventSelect,
  });
}

export async function updateProgramEvent(ctx: AuthContext, eventId: string, input: EventInput) {
  const current = await visibleEvent(ctx, eventId);
  if (!current) return null;
  await assertReferencesInOrg(ctx, input);
  const range = normalizeRange(input);
  return prisma.programEvent.update({
    where: { id: eventId },
    data: {
      title: input.title,
      categoryId: input.categoryId,
      ...range,
      allDay: input.allDay,
      timeZone: input.timeZone ?? "America/New_York",
      location: input.location ?? null,
      ...oneOwner(input),
      attendees: input.attendees ?? "",
      recurrence: input.recurrence ?? "NONE",
      deliverableId: input.deliverableId ?? null,
      customerAttending: input.customerAttending ?? false,
      description: input.description ?? "",
      showOnDashboard: input.showOnDashboard ?? false,
      projectId: input.projectId ?? null,
    },
    select: eventSelect,
  });
}

export async function deleteProgramEvent(ctx: AuthContext, eventId: string): Promise<boolean> {
  const current = await visibleEvent(ctx, eventId);
  if (!current) return false;
  await prisma.programEvent.delete({ where: { id: eventId } });
  return true;
}
