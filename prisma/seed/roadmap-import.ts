/**
 * Generic roadmap loader — installs a roadmap node set into one project.
 *
 * Single tool for every load path:
 *   • demo (committed mock):  tsx prisma/seed/roadmap-import.ts --demo
 *   • real program (gitignored data, prod only):
 *       DATABASE_URL=... tsx prisma/seed/roadmap-import.ts \
 *         --org defcon-ai --project VITLBMA --file ~/vitl-roadmap-data/roadmap_nodes.json
 *   • verification (e2e):
 *       DATABASE_URL=postgres://cosmos:e2epw@localhost:55440/cosmos \
 *         tsx prisma/seed/roadmap-import.ts --org test-org --project TEST --file <json>
 *
 * Real program content is NEVER committed — only mock demo data lives in the repo.
 * Idempotent: re-running replaces (default) or merges the project's roadmap.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { upsertRoadmapNodes } from "../../src/lib/roadmap/import";
import type { RoadmapImportNode } from "../../src/lib/roadmap/types";
import { DEMO_APEX_ROADMAP, DEMO_APEX } from "./demo-defense-roadmap";

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
    /* ignore */
  }
  return dbUrl;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const CORE_KEYS = new Set([
  "kind", "title", "externalRef", "section", "category", "body", "anchor", "parentRef", "sortOrder", "meta",
]);

/** Map a raw record into the import contract; non-core keys fold into `meta`. */
function toImportNode(raw: Record<string, unknown>): RoadmapImportNode {
  const meta: Record<string, unknown> = { ...((raw.meta as Record<string, unknown>) ?? {}) };
  for (const [k, v] of Object.entries(raw)) {
    if (!CORE_KEYS.has(k) && v != null && v !== "") meta[k] = v;
  }
  return {
    kind: raw.kind as RoadmapImportNode["kind"],
    title: String(raw.title ?? ""),
    externalRef: (raw.externalRef as string | null) ?? null,
    section: (raw.section as string | null) ?? null,
    category: (raw.category as string | null) ?? null,
    body: (raw.body as string | null) ?? "",
    anchor: (raw.anchor as string | null) ?? null,
    parentRef: (raw.parentRef as string | null) ?? null,
    sortOrder: (raw.sortOrder as number | null) ?? null,
    meta,
  };
}

async function main() {
  const explicitDb = arg("db");
  const envLocalDb = loadEnvLocal();
  const dbUrl = explicitDb || process.env.DATABASE_URL || envLocalDb;
  const prisma = new PrismaClient(dbUrl ? { datasourceUrl: dbUrl } : undefined);

  try {
    const demo = has("demo");
    const orgSlug = arg("org") ?? (demo ? DEMO_APEX.orgSlug : undefined);
    const projectKey = arg("project") ?? (demo ? DEMO_APEX.projectKey : undefined);
    const mode = (arg("mode") as "replace" | "merge") ?? "replace";

    if (!orgSlug || !projectKey) {
      throw new Error("Usage: --org <slug> --project <key> (--file <json> | --demo) [--mode replace|merge]");
    }

    const raw: Record<string, unknown>[] = demo
      ? (DEMO_APEX_ROADMAP as unknown as Record<string, unknown>[])
      : (JSON.parse(readFileSync(arg("file")!, "utf8")) as Record<string, unknown>[]);
    const nodes = raw.map(toImportNode);

    const org = await prisma.organization.findFirst({ where: { slug: orgSlug }, select: { id: true } });
    if (!org) throw new Error(`Organization "${orgSlug}" not found`);
    const project = await prisma.project.findFirst({
      where: { orgId: org.id, key: projectKey },
      select: { id: true, enabledFeatures: true },
    });
    if (!project) throw new Error(`Project "${projectKey}" not found in org "${orgSlug}"`);

    const report = await upsertRoadmapNodes(prisma, org.id, project.id, nodes, mode);

    // Surface the Roadmap tab on this project.
    if (!project.enabledFeatures.includes("roadmap")) {
      await prisma.project.update({
        where: { id: project.id },
        data: { enabledFeatures: { set: [...project.enabledFeatures, "roadmap"] } },
      });
    }

    console.log(
      `[roadmap-import] ${orgSlug}/${projectKey}: ${report.total} nodes ` +
        `(+${report.created} created, ~${report.updated} updated, -${report.deleted} replaced, ` +
        `${report.parentsLinked} parents linked, mode=${report.mode}).`,
    );
    if (report.warnings.length) console.warn(`[roadmap-import] warnings:\n  - ${report.warnings.join("\n  - ")}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
