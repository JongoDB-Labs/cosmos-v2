import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string }> };

const querySchema = z.object({
  q: z.string().min(1).max(200),
  channelId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type SearchHit = {
  messageId: string;
  channelId: string;
  channelName: string | null;
  channelKind: "CHANNEL" | "DM" | "GROUP_DM";
  authorId: string;
  snippet: string;
  rank: number;
  createdAt: Date;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SearchFilters = {
  from?: string;
  in?: string;
  has?: string;
  before?: string;
  after?: string;
};

/**
 * Slack-style search operators parsed out of the raw query:
 *   from:<name>  in:<channel>  has:link  before:YYYY-MM-DD  after:YYYY-MM-DD
 * Anything not matching an operator is the free-text query (FTS). A leading
 * '#'/'@' on the value is stripped so `in:#general` / `from:@alice` work.
 */
export function parseSearchQuery(raw: string): { text: string; filters: SearchFilters } {
  const filters: SearchFilters = {};
  const terms: string[] = [];
  for (const tok of raw.trim().split(/\s+/)) {
    const m = tok.match(/^(from|in|has|before|after):(.*)$/i);
    if (m && m[2]) {
      filters[m[1].toLowerCase() as keyof SearchFilters] = m[2].replace(/^[#@]/, "");
    } else if (tok) {
      terms.push(tok);
    }
  }
  return { text: terms.join(" "), filters };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      q: url.searchParams.get("q") ?? "",
      channelId: url.searchParams.get("channelId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const { text, filters } = parseSearchQuery(parsed.data.q);
    const hasValidFilter =
      !!filters.from ||
      !!filters.in ||
      filters.has === "link" ||
      (!!filters.before && DATE_RE.test(filters.before)) ||
      (!!filters.after && DATE_RE.test(filters.after));
    // Nothing actionable (e.g. a bare "from:" with no value and no free text).
    if (!text.trim() && !hasValidFilter) return success({ hits: [] });

    // Positional bindings: $queryRawUnsafe is parameterized, so every value
    // (including operator values) is bound, never string-interpolated. Only
    // `limit` is interpolated, as a zod-validated int(1..50).
    const bind: unknown[] = [];
    const p = (v: unknown) => {
      bind.push(v);
      return `$${bind.length}`;
    };

    // The chat_channel_members join keeps results to channels the user joined
    // (private content stays private).
    const conds: string[] = [`c.org_id = ${p(orgId)}::uuid`, `m.deleted_at IS NULL`];
    const userBind = p(ctx.userId);

    // Free-text FTS is now optional: an operators-only query (e.g. "from:alice
    // in:general") filters without a tsquery. When present it drives ranking +
    // the highlighted snippet; when absent we return a plain prefix by recency.
    let snippetExpr = `left(m.content, 200)`;
    let rankExpr = `0::float`;
    if (text.trim()) {
      const tq = p(text);
      conds.push(`m.content_tsv @@ plainto_tsquery('english', ${tq})`);
      snippetExpr = `ts_headline('english', m.content, plainto_tsquery('english', ${tq}), 'MaxFragments=2,MinWords=3,MaxWords=15')`;
      rankExpr = `ts_rank_cd(m.content_tsv, plainto_tsquery('english', ${tq}))`;
    }
    if (parsed.data.channelId) conds.push(`m.channel_id = ${p(parsed.data.channelId)}::uuid`);
    if (filters.in) conds.push(`c.name ILIKE ${p(`%${filters.in}%`)}`);
    if (filters.from) conds.push(`u.display_name ILIKE ${p(`%${filters.from}%`)}`);
    if (filters.has === "link") conds.push(`m.content ~* 'https?://'`);
    if (filters.before && DATE_RE.test(filters.before)) conds.push(`m.created_at < ${p(filters.before)}::date`);
    if (filters.after && DATE_RE.test(filters.after)) conds.push(`m.created_at >= ${p(filters.after)}::date`);

    const sql = `
      SELECT
        m.id AS "messageId",
        m.channel_id AS "channelId",
        c.name AS "channelName",
        c.kind AS "channelKind",
        m.author_id AS "authorId",
        ${snippetExpr} AS snippet,
        ${rankExpr} AS rank,
        m.created_at AS "createdAt"
      FROM chat_messages m
      JOIN chat_channels c ON c.id = m.channel_id
      JOIN chat_channel_members cm
        ON cm.channel_id = m.channel_id AND cm.user_id = ${userBind}::uuid
      LEFT JOIN users u ON u.id = m.author_id
      WHERE ${conds.join("\n        AND ")}
      ORDER BY rank DESC, m.created_at DESC
      LIMIT ${parsed.data.limit}
    `;

    const hits = await prisma.$queryRawUnsafe<SearchHit[]>(sql, ...bind);
    return success({ hits });
  } catch (e) {
    return handleApiError(e);
  }
}
