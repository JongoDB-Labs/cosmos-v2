/**
 * VITL issue-description backfill (COSMOS-35, "Part B").
 *
 * APPENDS a populated **Roadmap context** block to each backlog item's description:
 * for every roadmap short-ref the item carries (Sprint / LOE / Labels / imported
 * Description — e.g. "DP-04", "R-19", "SP-3", "LOE-2") it emits a deep-link to the
 * matching RoadmapNode PLUS an expanded gloss of what it is (a decision's default,
 * a risk's likelihood/impact + mitigation) — never a bare id. Optionally folds in
 * the matching COA-1 POA&M activities. Idempotent (HTML-comment markers); a re-run
 * refreshes the block and never duplicates. The user's own prose is preserved.
 *
 * The transform lives in src/lib/roadmap/description-context.ts (unit-tested). This
 * driver only wires it to the tenant DB. Content flows in from the DB + operator
 * files at runtime — NO customer roadmap/POA&M content is committed to the repo.
 *
 * Usage (dry-run prints coverage + samples; --apply writes):
 *   DATABASE_URL=... tsx scripts/roadmap/backfill-descriptions.ts \
 *     --org defcon-ai --project VITLBMA \
 *     [--poam ~/vitl-roadmap-data/poam_tasks.json] \
 *     [--aliases ~/vitl-roadmap-data/ref-aliases.json] [--apply]
 *
 *   --poam     JSON array of { loe, sp?, task, owner?, target?, status? }.
 *   --aliases  JSON object mapping a backlog-only ref to real node refs,
 *              e.g. { "DP-33": ["SP-BG-1", "DP-13a"] }.
 */
import { readFileSync } from "node:fs";
import { makePrismaClient } from "../../prisma/seed/shared/prisma-client";
import {
  deriveRoadmapRefs,
  buildRoadmapContextBlock,
  applyRoadmapContext,
  stripRoadmapContext,
  resolveRef,
  type RoadmapContextNode,
  type PoamActivity,
} from "../../src/lib/roadmap/description-context";

function loadEnvLocal(): string | undefined {
  let dbUrl: string | undefined;
  try {
    const txt = readFileSync(process.cwd() + "/.env.local", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
      if (m[1] === "DATABASE_URL") dbUrl = v;
    }
  } catch {
    /* no .env.local — rely on the ambient env */
  }
  return dbUrl;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function field(rec: Record<string, unknown> | null, key: string): string {
  const v = rec?.[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function readJson<T>(path: string | undefined): T | undefined {
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function main() {
  const dbUrl = arg("db") || process.env.DATABASE_URL || loadEnvLocal();
  const orgSlug = arg("org");
  const projectKey = arg("project");
  const apply = has("apply");
  if (!orgSlug || !projectKey) {
    throw new Error("Usage: --org <slug> --project <key> [--poam <file>] [--aliases <file>] [--apply]");
  }

  const poam = readJson<PoamActivity[]>(arg("poam")) ?? [];
  const aliases = readJson<Record<string, string[]>>(arg("aliases")) ?? {};

  const prisma = makePrismaClient(dbUrl);
  try {
    const org = await prisma.organization.findFirst({ where: { slug: orgSlug }, select: { id: true } });
    if (!org) throw new Error(`Organization "${orgSlug}" not found`);
    const project = await prisma.project.findFirst({
      where: { orgId: org.id, key: projectKey },
      select: { id: true },
    });
    if (!project) throw new Error(`Project "${projectKey}" not found in org "${orgSlug}"`);

    const basePath = `/${orgSlug}/projects/${projectKey}/roadmap`;

    const nodeRows = await prisma.roadmapNode.findMany({
      where: { orgId: org.id, projectId: project.id },
      select: { externalRef: true, anchor: true, title: true, body: true, meta: true },
    });
    const nodesByRef = new Map<string, RoadmapContextNode>();
    for (const n of nodeRows) {
      if (!n.externalRef) continue;
      nodesByRef.set(n.externalRef, {
        externalRef: n.externalRef,
        anchor: n.anchor,
        title: n.title,
        body: n.body,
        meta: asRecord(n.meta),
      });
    }
    if (!nodesByRef.size) {
      throw new Error(
        `No RoadmapNodes with an externalRef for ${orgSlug}/${projectKey}. Ingest the roadmap first ` +
          `(tsx prisma/seed/roadmap-import.ts --org ${orgSlug} --project ${projectKey} --file <json>).`,
      );
    }

    const items = await prisma.workItem.findMany({
      where: { projectId: project.id },
      select: { id: true, title: true, description: true, sourceRecord: true },
      orderBy: { ticketNumber: "asc" },
    });

    const updates: { id: string; description: string }[] = [];
    const unresolved = new Set<string>();
    let withDecisions = 0;
    let withRisks = 0;
    let skipped = 0;
    const samples: string[] = [];

    for (const item of items) {
      const src = asRecord(item.sourceRecord);
      // Only touch imported backlog items (they carry an ExternalID).
      if (!src || !field(src, "ExternalID")) {
        skipped++;
        continue;
      }
      // Scan the description with any prior context block stripped, so a re-run
      // never picks up refs that only appeared inside the block it appended.
      const baseDescription = stripRoadmapContext(item.description);
      const text = [
        field(src, "Summary"),
        field(src, "Source"),
        field(src, "Description"),
        field(src, "EpicLink"),
        baseDescription,
      ].join(" ");
      const refs = deriveRoadmapRefs({
        loe: field(src, "LOE"),
        sprint: field(src, "Sprint"),
        labels: field(src, "Labels"),
        text,
      });
      const block = buildRoadmapContextBlock({ refs, nodesByRef, basePath, poam, aliases });
      if (!block) {
        skipped++;
        continue;
      }
      for (const r of [...refs.decisions, ...refs.risks]) {
        if (!resolveRef(r, nodesByRef, aliases).length) unresolved.add(r);
      }
      if (block.includes("**Decisions")) withDecisions++;
      if (block.includes("**Risks")) withRisks++;

      const next = applyRoadmapContext(item.description, block);
      if (next !== item.description) {
        updates.push({ id: item.id, description: next });
        if (samples.length < 4 && (block.includes("**Decisions") || block.includes("**Risks"))) {
          samples.push(`--- ${field(src, "ExternalID")}  ${item.title.slice(0, 60)} ---\n${block}`);
        }
      }
    }

    console.log(`=== VITL description backfill (${apply ? "APPLY" : "DRY-RUN"}) ===`);
    console.log(`org/project: ${orgSlug}/${projectKey}  roadmap-nodes(with ref): ${nodesByRef.size}`);
    console.log(`items: ${items.length}  will-update: ${updates.length}  skipped(no refs/unchanged): ${skipped}`);
    console.log(`  blocks with decisions: ${withDecisions}  with risks: ${withRisks}`);
    console.log(`  unresolved refs (not in roadmap): ${[...unresolved].sort().join(", ") || "none"}`);
    console.log("");
    for (const s of samples) console.log(s + "\n");

    if (!apply) {
      console.log("DRY-RUN: no changes written. Re-run with --apply to update descriptions.");
      return;
    }
    if (!updates.length) {
      console.log("Nothing to update.");
      return;
    }

    await prisma.$transaction(
      updates.map((u) => prisma.workItem.update({ where: { id: u.id }, data: { description: u.description } })),
    );
    console.log(`APPLIED: updated ${updates.length} descriptions in ${orgSlug}/${projectKey}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
