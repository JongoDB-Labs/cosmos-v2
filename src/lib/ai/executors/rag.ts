import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import {
  cosineSimilarity,
  embedText,
  isSearchVector,
  type SearchVector,
} from "@/lib/rag/embed";
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

/**
 * Score a list of candidate rows against the query vector. Rows whose
 * `searchVector` is null/malformed are skipped — they'll be picked up by
 * the next embed-on-write or by `scripts/backfill-embeddings.ts`.
 */
function rankCandidates<T extends { searchVector: unknown }>(
  candidates: T[],
  qv: SearchVector
): Array<{ row: T; similarity: number }> {
  const scored: Array<{ row: T; similarity: number }> = [];
  for (const c of candidates) {
    if (!isSearchVector(c.searchVector)) continue;
    const sim = cosineSimilarity(qv, c.searchVector);
    if (sim > 0) scored.push({ row: c, similarity: sim });
  }
  return scored;
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

  const queryVector = await embedText(query);
  if (queryVector.tokens.length === 0) {
    return {
      query,
      count: 0,
      results: [],
      message:
        "Query contains only stopwords or symbols — try a more specific search.",
    };
  }

  const slug = await orgSlug(ctx.orgId);
  const hits: SemanticHit[] = [];

  // ── Notes ─────────────────────────────────────────────────────────────
  if (enabledTypes.has("note")) {
    const notes = await prisma.note.findMany({
      where: {
        orgId: ctx.orgId,
        // Private notes only visible to author; ORG/PROJECT visible to all
        // members of the org (cosmos doesn't gate PROJECT notes by project
        // membership today — see notes/route.ts GET for parity).
        OR: [
          { visibility: "PRIVATE", authorId: ctx.userId },
          { visibility: { in: ["ORG", "PROJECT"] } },
        ],
        searchVector: { not: null as never },
      },
      select: {
        id: true,
        title: true,
        content: true,
        searchVector: true,
      },
    });
    for (const { row, similarity } of rankCandidates(notes, queryVector)) {
      hits.push({
        type: "note",
        id: row.id,
        title: row.title || "(untitled note)",
        snippet: snippetOf(row.content),
        similarity,
        url: `/${slug}/notes`,
      });
    }
  }

  // ── Work items ────────────────────────────────────────────────────────
  if (enabledTypes.has("work_item")) {
    // Scope to projects the user is a member of (or all projects in the org
    // if they're a privileged role). Mirrors the access pattern used by the
    // boards UI: project membership is the visibility gate.
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

    if (projectIds === null || projectIds.length > 0) {
      const items = await prisma.workItem.findMany({
        where: {
          orgId: ctx.orgId,
          ...(projectIds ? { projectId: { in: projectIds } } : {}),
          searchVector: { not: null as never },
        },
        select: {
          id: true,
          title: true,
          description: true,
          projectId: true,
          ticketNumber: true,
          searchVector: true,
        },
      });
      for (const { row, similarity } of rankCandidates(items, queryVector)) {
        hits.push({
          type: "work_item",
          id: row.id,
          title: `#${row.ticketNumber} ${row.title}`,
          snippet: snippetOf(row.description),
          similarity,
          url: `/${slug}/projects/${row.projectId}`,
        });
      }
    }
  }

  // ── Contracts ─────────────────────────────────────────────────────────
  if (enabledTypes.has("contract")) {
    const contracts = await prisma.contract.findMany({
      where: {
        orgId: ctx.orgId,
        searchVector: { not: null as never },
      },
      select: {
        id: true,
        title: true,
        terms: true,
        notes: true,
        searchVector: true,
      },
    });
    for (const { row, similarity } of rankCandidates(contracts, queryVector)) {
      hits.push({
        type: "contract",
        id: row.id,
        title: row.title,
        snippet: snippetOf(row.terms ?? row.notes ?? ""),
        similarity,
        // No dedicated contracts page yet — CRM hosts them.
        url: `/${slug}/crm`,
      });
    }
  }

  // ── Meetings ──────────────────────────────────────────────────────────
  if (enabledTypes.has("meeting")) {
    const meetings = await prisma.syncMeeting.findMany({
      where: {
        orgId: ctx.orgId,
        searchVector: { not: null as never },
      },
      select: {
        id: true,
        title: true,
        notes: true,
        transcript: true,
        aiSummary: true,
        searchVector: true,
      },
    });
    for (const { row, similarity } of rankCandidates(meetings, queryVector)) {
      hits.push({
        type: "meeting",
        id: row.id,
        title: row.title || "(untitled meeting)",
        snippet: snippetOf(row.aiSummary ?? row.notes ?? row.transcript ?? ""),
        similarity,
        url: `/${slug}/meetings`,
      });
    }
  }

  // Combine + sort + cap.
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
