/**
 * The CQL function registry: the closed set of functions a query may call.
 *
 * Functions stay symbolic in a stored query (`openSprints()` is re-evaluated on
 * every run) and are expanded by the resolver at execution time. Pure and
 * client-safe.
 */

export const FUNCTION_NAMES = [
  "currentUser",
  "membersOf",
  "myTeams",
  "openSprints",
  "currentSprint",
  "closedSprints",
  "futureSprints",
  "currentProject",
  "now",
  "startOfDay",
  "startOfWeek",
  "startOfMonth",
  "startOfYear",
  "endOfDay",
  "endOfWeek",
  "endOfMonth",
  "endOfYear",
  "sinceLastStandup",
  "watchedItems",
  "linkedItems",
  "childrenOf",
  "descendantsOf",
  "updatedBy",
] as const;
export type FunctionName = (typeof FUNCTION_NAMES)[number];

/** What a function stands for, which decides the fields it may be used with. */
export type FunctionReturns = "user" | "team" | "interval" | "project" | "datetime" | "item";

export type ArgKind = "rel" | "item" | "team" | "user" | "linkType" | "date";

export interface FunctionDef {
  name: FunctionName;
  returns: FunctionReturns;
  /** Returns a SET (usable with IN) rather than one value. */
  many: boolean;
  args: { kind: ArgKind; optional?: boolean }[];
  /** Phase that compiles it, when not yet. */
  pending?: string;
  description: string;
}

const PERIOD = (name: FunctionName, description: string): FunctionDef => ({
  name,
  returns: "datetime",
  many: false,
  args: [{ kind: "rel", optional: true }],
  description,
});

export const FUNCTIONS: readonly FunctionDef[] = [
  { name: "currentUser", returns: "user", many: false, args: [], description: "You. `me` is the same thing. In a subscription, the recipient." },
  { name: "membersOf", returns: "user", many: true, args: [{ kind: "team" }], description: "Everyone on a team." },
  { name: "myTeams", returns: "team", many: true, args: [], description: "The teams you are on." },
  { name: "openSprints", returns: "interval", many: true, args: [], description: "Active sprints in projects you can see." },
  { name: "currentSprint", returns: "interval", many: true, args: [], description: "Active sprint(s), limited to the current project when there is one." },
  { name: "closedSprints", returns: "interval", many: true, args: [], description: "Completed sprints." },
  { name: "futureSprints", returns: "interval", many: true, args: [], description: "Planned sprints." },
  { name: "currentProject", returns: "project", many: false, args: [], description: "The project this query runs in (a board, a project page)." },
  { name: "now", returns: "datetime", many: false, args: [], description: "This instant." },
  PERIOD("startOfDay", "Start of today, or `startOfDay(-1d)` for yesterday."),
  PERIOD("startOfWeek", "Monday 00:00 this week; `startOfWeek(-1w)` for last week."),
  PERIOD("startOfMonth", "First of this month."),
  PERIOD("startOfYear", "1 January this year."),
  PERIOD("endOfDay", "End of today."),
  PERIOD("endOfWeek", "End of Sunday this week."),
  PERIOD("endOfMonth", "End of this month."),
  PERIOD("endOfYear", "End of this year."),
  { name: "sinceLastStandup", returns: "datetime", many: false, args: [], description: "When this dashboard was last presented; otherwise the start of the previous working day." },
  { name: "watchedItems", returns: "item", many: true, args: [], description: "Items you watch." },
  { name: "linkedItems", returns: "item", many: true, args: [{ kind: "item" }, { kind: "linkType", optional: true }], description: "Items linked to KEY, optionally by link type: `linkedItems(ACME-1, BLOCKS)`." },
  { name: "childrenOf", returns: "item", many: true, args: [{ kind: "item" }], description: "Direct children of KEY." },
  { name: "descendantsOf", returns: "item", many: true, args: [{ kind: "item" }], pending: "query phase 4", description: "Everything under KEY, any depth." },
  { name: "updatedBy", returns: "item", many: true, args: [{ kind: "user" }, { kind: "date", optional: true }, { kind: "date", optional: true }], description: "Items a person changed, optionally between two dates." },
];

const byName = new Map(FUNCTIONS.map((f) => [f.name.toLowerCase(), f]));

export function lookupFunction(name: string): FunctionDef | undefined {
  return byName.get(name.toLowerCase());
}

export function functionDef(name: FunctionName): FunctionDef {
  return byName.get(name.toLowerCase())!;
}
