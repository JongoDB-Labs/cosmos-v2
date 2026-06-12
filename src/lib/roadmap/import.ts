import type { PrismaClient, Prisma } from "@prisma/client";
import {
  type RoadmapImportNode,
  type RoadmapImportReport,
} from "./types";

/** Pure slug — no DB dependency, safe in seed scripts + the API. */
export function roadmapSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

interface Normalized extends RoadmapImportNode {
  anchor: string;
  sortOrder: number;
}

/**
 * Derive anchors + sortOrder and guarantee per-batch uniqueness of anchor and
 * externalRef. Anchor falls back to slug(externalRef||title); collisions get a
 * numeric suffix. Duplicate non-null externalRefs are a hard error (they'd break
 * the @@unique([orgId,projectId,external_ref]) constraint).
 */
function normalize(nodes: RoadmapImportNode[]): {
  normalized: Normalized[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const usedAnchors = new Set<string>();
  const seenRefs = new Set<string>();
  const normalized: Normalized[] = [];

  nodes.forEach((n, i) => {
    const ref = n.externalRef?.trim() || null;
    if (ref) {
      if (seenRefs.has(ref)) {
        throw new Error(`Duplicate externalRef "${ref}" in import set`);
      }
      seenRefs.add(ref);
    }

    const base = roadmapSlug(n.anchor || ref || n.title) || `node-${i + 1}`;
    let anchor = base;
    let suffix = 2;
    while (usedAnchors.has(anchor)) {
      anchor = `${base}-${suffix++}`;
    }
    usedAnchors.add(anchor);
    if (anchor !== (n.anchor || "") && n.anchor) {
      warnings.push(`Anchor "${n.anchor}" collided; stored as "${anchor}"`);
    }

    normalized.push({
      ...n,
      externalRef: ref,
      anchor,
      sortOrder: n.sortOrder ?? i,
    });
  });

  return { normalized, warnings };
}

function nodeData(
  orgId: string,
  projectId: string,
  n: Normalized,
): Prisma.RoadmapNodeUncheckedCreateInput {
  return {
    orgId,
    projectId,
    kind: n.kind,
    externalRef: n.externalRef ?? null,
    section: n.section ?? null,
    category: n.category ?? null,
    title: n.title,
    body: n.body ?? "",
    anchor: n.anchor,
    meta: (n.meta ?? {}) as Prisma.InputJsonValue,
    sortOrder: n.sortOrder,
  };
}

/**
 * Upsert a roadmap node set for one project. Single source of truth for the
 * ingest API, the demo seed, and the (gitignored) real-program loads.
 *
 * Two passes inside one transaction:
 *   1. delete-all (replace) then upsert every node by (orgId,projectId,anchor),
 *      building a {anchor|externalRef → id} resolution map.
 *   2. wire parentId from each node's parentRef (matched against anchor OR
 *      externalRef). Unresolvable parentRefs are warned, not fatal.
 */
export async function upsertRoadmapNodes(
  client: PrismaClient,
  orgId: string,
  projectId: string,
  nodes: RoadmapImportNode[],
  mode: "replace" | "merge" = "replace",
): Promise<RoadmapImportReport> {
  const { normalized, warnings } = normalize(nodes);

  const report: RoadmapImportReport = {
    mode,
    total: normalized.length,
    created: 0,
    updated: 0,
    deleted: 0,
    parentsLinked: 0,
    warnings,
  };

  await client.$transaction(async (tx) => {
    if (mode === "replace") {
      const del = await tx.roadmapNode.deleteMany({ where: { orgId, projectId } });
      report.deleted = del.count;
    }

    // Pass 1 — upsert nodes (parentId left null for now).
    const idByKey = new Map<string, string>();
    for (const n of normalized) {
      const data = nodeData(orgId, projectId, n);
      const existing = await tx.roadmapNode.findFirst({
        where: { orgId, projectId, anchor: n.anchor },
        select: { id: true },
      });
      let id: string;
      if (existing) {
        await tx.roadmapNode.update({ where: { id: existing.id }, data });
        id = existing.id;
        report.updated++;
      } else {
        const row = await tx.roadmapNode.create({ data, select: { id: true } });
        id = row.id;
        report.created++;
      }
      idByKey.set(n.anchor, id);
      if (n.externalRef) idByKey.set(n.externalRef, id);
    }

    // Pass 2 — resolve parents. Match against this batch first, then (for merge
    // mode) fall back to an existing node in the DB by anchor or externalRef.
    for (const n of normalized) {
      if (!n.parentRef) continue;
      const childId = idByKey.get(n.anchor);
      if (!childId) continue;
      const ref = n.parentRef.trim();
      let parentId = idByKey.get(ref);
      if (!parentId && mode === "merge") {
        const existingParent = await tx.roadmapNode.findFirst({
          where: { orgId, projectId, OR: [{ anchor: ref }, { externalRef: ref }] },
          select: { id: true },
        });
        if (existingParent) parentId = existingParent.id;
      }
      if (!parentId) {
        report.warnings.push(`parentRef "${n.parentRef}" not found for "${n.anchor}"`);
        continue;
      }
      if (parentId === childId) continue;
      await tx.roadmapNode.update({ where: { id: childId }, data: { parentId } });
      report.parentsLinked++;
    }
  });

  return report;
}
