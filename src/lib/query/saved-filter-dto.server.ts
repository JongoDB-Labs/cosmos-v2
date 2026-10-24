/**
 * The saved-filter row shape every saved-views route loads, and its JSON.
 * `filter` and `shared` are the legacy fields, derived, kept for one release.
 */
import type { Prisma } from "@prisma/client";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { canDelete, canEdit, legacyFilterOf, storedQuery, type ViewerScope } from "./saved-filters.server";

export const SAVED_VIEW_SELECT = {
  id: true,
  orgId: true,
  ownerId: true,
  name: true,
  description: true,
  filter: true,
  query: true,
  cqlText: true,
  visibility: true,
  projectId: true,
  teamId: true,
  updatedAt: true,
  owner: { select: { displayName: true } },
  project: { select: { id: true, key: true, name: true } },
  team: { select: { id: true, name: true, projectId: true } },
  editors: { select: { userId: true, user: { select: { displayName: true } } } },
} satisfies Prisma.SavedViewSelect;

export type SavedViewRow = Prisma.SavedViewGetPayload<{ select: typeof SAVED_VIEW_SELECT }>;

export interface SavedFilterDto {
  id: string;
  name: string;
  description: string;
  visibility: SavedViewRow["visibility"];
  project: { id: string; key: string; name: string } | null;
  team: { id: string; name: string } | null;
  ownerId: string;
  ownerName: string;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  editors: { id: string; displayName: string }[];
  favorite: boolean;
  favoriteOrder: number | null;
  updatedAt: string;
  /** LEGACY (one release): the WorkItemFilter, `{}` when the query is more than it can say. */
  filter: WorkItemFilter;
  /** LEGACY (one release): visibility === "ORG". */
  shared: boolean;
  /**
   * Something this filter refers to is withheld from the viewer. Here: the
   * project or team it's shared with (`project`/`team` are then null); GET
   * also folds in the query's own ‹restricted› parts.
   */
  partiallyRestricted: boolean;
}

export function toDto(
  s: ViewerScope,
  v: SavedViewRow,
  favorite: { sortOrder: number } | undefined,
  cfTypes: ReadonlyMap<string, string>,
): SavedFilterDto {
  // The target is named only to someone who can read its project. Seeing the
  // filter isn't enough: an editor, or an administrator an ABAC policy keeps
  // out of the project, can see a filter shared with a project they can't.
  const project = v.project && s.readable.has(v.project.id) ? { id: v.project.id, key: v.project.key, name: v.project.name } : null;
  const team = v.team && s.readable.has(v.team.projectId) ? { id: v.team.id, name: v.team.name } : null;
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    visibility: v.visibility,
    // A team-less TEAM filter (its team was deleted) names no team.
    project,
    team,
    ownerId: v.ownerId,
    ownerName: v.owner.displayName,
    mine: v.ownerId === s.ctx.userId,
    canEdit: canEdit(s, v),
    canDelete: canDelete(s, v),
    editors: v.editors.map((e) => ({ id: e.userId, displayName: e.user.displayName })),
    favorite: !!favorite,
    favoriteOrder: favorite?.sortOrder ?? null,
    updatedAt: v.updatedAt.toISOString(),
    filter: v.query ? legacyFilterOf(storedQuery(v), cfTypes) : ((v.filter ?? {}) as WorkItemFilter),
    shared: v.visibility === "ORG",
    partiallyRestricted: (!!v.project && !project) || (!!v.team && !team),
  };
}
