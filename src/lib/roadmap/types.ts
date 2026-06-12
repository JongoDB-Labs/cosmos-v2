import { z } from "zod";

/**
 * Roadmap ingest contract.
 *
 * A project's Roadmap is a tree of nodes (sections → sub-phases / LOEs / risks /
 * decisions / stakeholders / milestones) that issue descriptions deep-link to as
 * source-of-truth. Users bring their OWN roadmap by having an LLM convert their
 * document into this shape and POSTing it to the ingest API (or via the MCP
 * server). The same shape backs the committed demo seed and the (gitignored)
 * real-program loads — see src/lib/roadmap/import.ts.
 *
 * Keep this contract LLM-friendly: only `kind` + `title` are required; anchors,
 * sortOrder and ids are derived server-side so a model never has to invent them.
 */

export const ROADMAP_NODE_KINDS = [
  "SECTION",
  "SUBPHASE",
  "LOE",
  "RISK",
  "DECISION",
  "STAKEHOLDER",
  "MILESTONE",
] as const;

export type RoadmapNodeKind = (typeof ROADMAP_NODE_KINDS)[number];

export const roadmapImportNodeSchema = z.object({
  /** What this node is. Drives grouping + iconography in the Roadmap view. */
  kind: z.enum(ROADMAP_NODE_KINDS),
  /** Display title, e.g. "R-19 — LPI ISSM Not Identified in Time". Required. */
  title: z.string().min(1).max(400),
  /**
   * Stable human id used for deep-links and idempotent re-import, e.g. "R-19",
   * "DP-04", "SP-3", "LOE-2". Unique per project. Optional (some milestones /
   * stakeholders have none).
   */
  externalRef: z.string().max(60).nullish(),
  /** Source section number/label, e.g. "19" or "Phase II". A reading aid. */
  section: z.string().max(80).nullish(),
  /** Category band within a register, e.g. "ATO & AUTHORIZATION". */
  category: z.string().max(160).nullish(),
  /** Markdown body — the ACTUAL content (not just an id). Renders in the view. */
  body: z.string().max(50_000).nullish(),
  /**
   * URL slug for deep-linking. Optional — derived from externalRef||title when
   * omitted, and de-duplicated within the batch.
   */
  anchor: z.string().max(80).nullish(),
  /**
   * The externalRef OR anchor of this node's parent (e.g. a risk's section).
   * Resolved to a real parent id in a second pass; unresolved refs are ignored.
   */
  parentRef: z.string().max(80).nullish(),
  /** Ordering within siblings. Optional — falls back to array order. */
  sortOrder: z.number().int().nullish(),
  /** Kind-specific structured extras (likelihood/impact/owner, dates, …). */
  meta: z.record(z.string(), z.unknown()).nullish(),
});

export type RoadmapImportNode = z.infer<typeof roadmapImportNodeSchema>;

export const roadmapImportSchema = z.object({
  /**
   * "replace" wipes the project's existing roadmap and installs this set (the
   * default — a full re-ingest). "merge" upserts by anchor/externalRef and keeps
   * everything else.
   */
  mode: z.enum(["replace", "merge"]).default("replace"),
  nodes: z.array(roadmapImportNodeSchema).min(1).max(2000),
});

export type RoadmapImportRequest = z.infer<typeof roadmapImportSchema>;

export interface RoadmapImportReport {
  mode: "replace" | "merge";
  total: number;
  created: number;
  updated: number;
  deleted: number;
  parentsLinked: number;
  warnings: string[];
}
