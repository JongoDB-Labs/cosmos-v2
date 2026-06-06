import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { embedText, toVectorLiteral } from "@/lib/rag/embed";
import { z } from "zod";
import { assertPermission, type ToolContext } from "./_ctx";

const semanticSearchSchema = z.object({
  query: z.string().min(1).max(2000),
  types: z
    .array(z.enum(["note", "work_item", "contract", "meeting"]))
    .optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

type ResultType = "note" | "work_item" | "contract" | "meeting";

interface SemanticHit {
  type: ResultType;
  id: string;
  title: string;
  snippet: string;
  similarity: number;
  url: string;
}

/**
 * Snippet builder — first ~240 chars of the body, single line, ellipsized.
 * Keeps the tool output compact for the model to summarize.
 */
function snippetOf(text: string | null | undefined): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? flat.slice(0, 240) + "…" : flat;
}

/**
 * Resolve the org's URL slug once per call so result deep links use the
 * human path (`/acme/notes/<id>`) the user is actually browsing.
 */
async function orgSlug(orgId: string): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { slug: true },
  });
  return org?.slug ?? orgId;
}

/** A pgvector ANN row: the entity id + cosine similarity (1 - distance). */
interface VectorRow {
  id: string;
  similarity: number;
  // entity-specific projection fields follow (selected per table below)
  [k: string]: unknown;
}

export async function semanticSearch(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  // ORG_READ is the floor — everything below is further filtered by
  // per-type visibility (private notes / project membership / etc).
  const denied = await assertPermission(ctx, Permission.ORG_READ);
  if (denied) return denied;

  const parsed = semanticSearchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const { query, types, limit } = parsed.data;
  const enabledTypes = new Set<ResultType>(
    types && types.length > 0 ? types : ["note", "work_item", "contract", "meeting"]
  );
  const cap = limit ?? 10;

  // Embed the query ONCE. The text is turned into a vector parameter — it is
  // never concatenated into SQL.
  const qv = toVectorLiteral(await embedText(query));

  const slug = await orgSlug(ctx.orgId);
  const hits: SemanticHit[] = [];

  // ── Notes ─────────────────────────────────────────────────────────────
  // RBAC preserved EXACTLY from the prior executor:
  //   orgId = ctx.orgId AND (
  //     (visibility = 'PRIVATE' AND authorId = ctx.userId)
  //     OR visibility IN ('ORG','PROJECT')
  //   )
  // (cosmos doesn't gate PROJECT notes by project membership today — see
  // notes/route.ts GET for parity.) The vector ANN runs WITHIN this filter.
  if (enabledTypes.has("note")) {
    const rows = await prisma.$queryRawUnsafe<VectorRow[]>(
      `SELECT "id", "title", "content",
              1 - ("embedding" <=> $1::vector) AS similarity
         FROM "notes"
        WHERE "org_id" = $2::uuid
          AND "embedding" IS NOT NULL
          AND (
            ("visibility"::text = 'PRIVATE' AND "author_id" = $3::uuid)
            OR "visibility"::text IN ('ORG', 'PROJECT')
          )
        ORDER BY "embedding" <=> $1::vector
        LIMIT $4`,
      qv,
      ctx.orgId,
      ctx.userId,
      cap
    );
    for (const row of rows) {
      hits.push({
        type: "note",
        id: row.id,
        title: (row.title as string) || "(untitled note)",
        snippet: snippetOf(row.content as string),
        similarity: Number(row.similarity),
        url: `/${slug}/notes`,
      });
    }
  }

  // ── Work items ────────────────────────────────────────────────────────
  // RBAC preserved EXACTLY: scope to projects the user is a member of, OR all
  // projects in the org if they're a privileged role (OWNER/ADMIN). Mirrors the
  // boards UI: project membership is the visibility gate. Non-members see none.
  if (enabledTypes.has("work_item")) {
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
      select: { id: true, role: true },
    });
    let projectIds: string[] | null = null;
    if (member && (member.role === "OWNER" || member.role === "ADMIN")) {
      projectIds = null; // all projects in org
    } else if (member) {
      const projects = await prisma.projectMember.findMany({
        where: { orgMemberId: member.id },
        select: { projectId: true },
      });
      projectIds = projects.map((p) => p.projectId);
    } else {
      projectIds = [];
    }

    // Identical gate to the prior executor: null = all org projects; empty = none.
    if (projectIds === null || projectIds.length > 0) {
      let rows: VectorRow[];
      if (projectIds === null) {
        // Privileged: all projects in the org.
        rows = await prisma.$queryRawUnsafe<VectorRow[]>(
          `SELECT "id", "title", "description", "project_id" AS "projectId",
                  "ticket_number" AS "ticketNumber",
                  1 - ("embedding" <=> $1::vector) AS similarity
             FROM "work_items"
            WHERE "org_id" = $2::uuid
              AND "embedding" IS NOT NULL
            ORDER BY "embedding" <=> $1::vector
            LIMIT $3`,
          qv,
          ctx.orgId,
          cap
        );
      } else {
        // Member: only their project ids (bound as a uuid[] param).
        rows = await prisma.$queryRawUnsafe<VectorRow[]>(
          `SELECT "id", "title", "description", "project_id" AS "projectId",
                  "ticket_number" AS "ticketNumber",
                  1 - ("embedding" <=> $1::vector) AS similarity
             FROM "work_items"
            WHERE "org_id" = $2::uuid
              AND "embedding" IS NOT NULL
              AND "project_id" = ANY($3::uuid[])
            ORDER BY "embedding" <=> $1::vector
            LIMIT $4`,
          qv,
          ctx.orgId,
          projectIds,
          cap
        );
      }
      for (const row of rows) {
        hits.push({
          type: "work_item",
          id: row.id,
          title: `#${row.ticketNumber} ${row.title}`,
          snippet: snippetOf(row.description as string),
          similarity: Number(row.similarity),
          url: `/${slug}/projects/${row.projectId}`,
        });
      }
    }
  }

  // ── Contracts ─────────────────────────────────────────────────────────
  // RBAC preserved EXACTLY: org-scoped (orgId = ctx.orgId), no further gate.
  if (enabledTypes.has("contract")) {
    const rows = await prisma.$queryRawUnsafe<VectorRow[]>(
      `SELECT "id", "title", "terms", "notes",
              1 - ("embedding" <=> $1::vector) AS similarity
         FROM "contracts"
        WHERE "org_id" = $2::uuid
          AND "embedding" IS NOT NULL
        ORDER BY "embedding" <=> $1::vector
        LIMIT $3`,
      qv,
      ctx.orgId,
      cap
    );
    for (const row of rows) {
      hits.push({
        type: "contract",
        id: row.id,
        title: row.title as string,
        snippet: snippetOf((row.terms as string) ?? (row.notes as string) ?? ""),
        similarity: Number(row.similarity),
        // No dedicated contracts page yet — CRM hosts them.
        url: `/${slug}/crm`,
      });
    }
  }

  // ── Meetings ──────────────────────────────────────────────────────────
  // RBAC preserved EXACTLY: org-scoped (orgId = ctx.orgId), no further gate.
  if (enabledTypes.has("meeting")) {
    const rows = await prisma.$queryRawUnsafe<VectorRow[]>(
      `SELECT "id", "title", "notes", "transcript", "ai_summary" AS "aiSummary",
              1 - ("embedding" <=> $1::vector) AS similarity
         FROM "sync_meetings"
        WHERE "org_id" = $2::uuid
          AND "embedding" IS NOT NULL
        ORDER BY "embedding" <=> $1::vector
        LIMIT $3`,
      qv,
      ctx.orgId,
      cap
    );
    for (const row of rows) {
      hits.push({
        type: "meeting",
        id: row.id,
        title: (row.title as string) || "(untitled meeting)",
        snippet: snippetOf(
          (row.aiSummary as string) ?? (row.notes as string) ?? (row.transcript as string) ?? ""
        ),
        similarity: Number(row.similarity),
        url: `/${slug}/meetings`,
      });
    }
  }

  // Combine + sort by similarity + cap (each per-type query already capped, but
  // the cross-type merge needs a final global sort + slice).
  hits.sort((a, b) => b.similarity - a.similarity);
  const top = hits.slice(0, cap);

  return {
    query,
    count: top.length,
    results: top.map((h) => ({
      ...h,
      similarity: Math.round(h.similarity * 1000) / 1000,
    })),
  };
}
