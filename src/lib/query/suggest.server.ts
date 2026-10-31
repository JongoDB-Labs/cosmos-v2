/**
 * Value suggestions for the CQL editor and the chips: "what could go after
 * `assignee = da`?". Scoped exactly like the resolver (readable projects only,
 * current org members only), so a suggestion list can never name something a
 * query couldn't resolve, and never anything restricted.
 *
 * Each suggestion carries `insert`: the text that reads back as that value
 * (quoted when it needs to be, an email when two people share a name).
 */
import { IntervalKind } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { lookupField, type ValueKind } from "./fields";
import { FUNCTIONS } from "./functions";
import { quote } from "./print";
import { cqlLexer, Identifier, KEYWORDS } from "./lexer";
import { loadSchemaCustomFields } from "./resolve.server";

export interface Suggestion {
  label: string;
  insert: string;
  detail?: string;
  kind: "user" | "project" | "type" | "status" | "sprint" | "team" | "label" | "item" | "value" | "function" | "keyword";
}

const KEYWORD_WORDS = new Set(KEYWORDS.map((k) => k.name.toLowerCase()));

/** Bare when it lexes back as one plain identifier; quoted otherwise. */
function asValue(s: string): string {
  const { tokens, errors } = cqlLexer.tokenize(s);
  const bare =
    errors.length === 0 && tokens.length === 1 && tokens[0].tokenType === Identifier && tokens[0].image === s
    && !KEYWORD_WORDS.has(s.toLowerCase()) && !["me", "true", "false"].includes(s.toLowerCase());
  return bare ? s : quote(s);
}

const contains = (prefix: string) => ({ contains: prefix, mode: "insensitive" as const });

function functionsFor(kind: ValueKind, prefix: string): Suggestion[] {
  const returns =
    kind.kind === "ref"
      ? { user: "user", interval: "interval", team: "team", project: "project", item: "item" }[kind.entity as string]
      : kind.kind === "date" || kind.kind === "datetime"
        ? "datetime"
        : undefined;
  if (!returns) return [];
  const p = prefix.toLowerCase();
  return FUNCTIONS.filter((f) => f.returns === returns && !f.pending)
    // `me` is how people write currentUser(), so it answers to either.
    .filter((f) => f.name.toLowerCase().startsWith(p) || (f.name === "currentUser" && "me".startsWith(p)))
    .sort((a, b) => Number(b.name === "currentUser") - Number(a.name === "currentUser"))
    .map((f) => ({
      label: f.name === "currentUser" ? "me" : `${f.name}()`,
      insert: f.name === "currentUser" ? "me" : `${f.name}()`,
      detail: f.description,
      kind: "function" as const,
    }));
}

export async function suggestValues(
  ctx: AuthContext,
  args: { field: string; prefix: string; limit: number },
): Promise<Suggestion[]> {
  const prefix = args.prefix.trim().replace(/^["']/, "");
  const limit = Math.min(Math.max(args.limit, 1), 100);
  const orgId = ctx.orgId;

  let kind: ValueKind | null = null;
  let allowEmpty = false;
  let options: string[] | undefined;
  const def = lookupField(args.field);
  if (def) {
    if (def.pending) return [];
    kind = def.value;
    allowEmpty = def.ops.includes("empty");
  }

  const readable = await getReadableProjectIds(ctx);
  if (!def) {
    const cfs = await loadSchemaCustomFields(orgId, readable);
    const cf = cfs.find((c) => c.key.toLowerCase() === args.field.toLowerCase() || c.name.toLowerCase() === args.field.toLowerCase());
    if (!cf) return [];
    options = cf.options;
    kind =
      cf.fieldType === "USER"
        ? { kind: "ref", entity: "user" }
        : cf.fieldType === "CHECKBOX"
          ? { kind: "bool" }
          : cf.fieldType === "NUMBER"
            ? { kind: "number" }
            : cf.fieldType === "DATE"
              ? { kind: "date" }
              : { kind: "string" };
  }
  if (!kind) return [];

  const out: Suggestion[] = [...functionsFor(kind, prefix)];
  const p = prefix.toLowerCase();

  switch (kind.kind) {
    case "enum":
      out.push(...kind.values.filter((v) => v.toLowerCase().startsWith(p)).map((v) => ({ label: v, insert: v, kind: "value" as const })));
      break;
    case "bool":
      out.push(...["true", "false"].filter((v) => v.startsWith(p)).map((v) => ({ label: v, insert: v, kind: "value" as const })));
      break;
    case "string":
      for (const o of options ?? []) if (o.toLowerCase().includes(p)) out.push({ label: o, insert: asValue(o), kind: "value" });
      break;
    case "ref":
      out.push(...(await refSuggestions(kind.entity, prefix, readable, orgId, limit, def?.id)));
      break;
    default:
      break;
  }
  if (allowEmpty && "empty".startsWith(p)) out.push({ label: "EMPTY", insert: "EMPTY", detail: "No value", kind: "keyword" });
  return out.slice(0, limit);
}

async function refSuggestions(
  entity: string,
  prefix: string,
  readable: string[],
  orgId: string,
  limit: number,
  /**
   * Which field asked. Two fields share the `interval` entity and mean
   * different halves of it, so the entity alone cannot scope the list.
   */
  field?: string,
): Promise<Suggestion[]> {
  const where = prefix ? contains(prefix) : undefined;
  switch (entity) {
    case "user": {
      const rows = await prisma.orgMember.findMany({
        where: {
          orgId,
          ...(prefix ? { user: { OR: [{ displayName: where }, { email: where }] } } : {}),
        },
        select: { user: { select: { id: true, displayName: true, email: true } } },
        take: limit,
        orderBy: { user: { displayName: "asc" } },
      });
      const byName = new Map<string, number>();
      for (const r of rows) byName.set(r.user.displayName.toLowerCase(), (byName.get(r.user.displayName.toLowerCase()) ?? 0) + 1);
      return rows.map(({ user: u }) => ({
        label: u.displayName,
        // Two people with one name: insert the email, which is unambiguous.
        insert: asValue((byName.get(u.displayName.toLowerCase()) ?? 0) > 1 ? u.email : u.displayName),
        detail: u.email,
        kind: "user" as const,
      }));
    }
    case "project": {
      const rows = await prisma.project.findMany({
        where: { orgId, id: { in: readable }, ...(prefix ? { OR: [{ key: where }, { name: where }] } : {}) },
        select: { key: true, name: true },
        take: limit,
        orderBy: { key: "asc" },
      });
      return rows.map((r) => ({ label: r.key, insert: asValue(r.key), detail: r.name, kind: "project" as const }));
    }
    case "type": {
      const rows = await prisma.workItemType.findMany({
        where: { OR: [{ orgId }, { orgId: null }], ...(prefix ? { AND: [{ OR: [{ key: where }, { name: where }] }] } : {}) },
        select: { name: true, key: true },
        take: limit * 2,
        orderBy: { name: "asc" },
      });
      const seen = new Set<string>();
      return rows
        .filter((r) => !seen.has(r.name.toLowerCase()) && seen.add(r.name.toLowerCase()))
        .map((r) => ({ label: r.name, insert: asValue(r.name), detail: r.key, kind: "type" as const }));
    }
    case "status": {
      // The project's statuses, not board columns (a ceremony board's prompts
      // are not statuses). Archived ones are not offered.
      const rows = await prisma.workflowStatus.findMany({
        where: { projectId: { in: readable }, archivedAt: null, ...(prefix ? { OR: [{ name: where }, { key: where }] } : {}) },
        select: { name: true, key: true, project: { select: { key: true } } },
        take: 200,
        orderBy: { sortOrder: "asc" },
      });
      const byName = new Map<string, { label: string; projects: Set<string> }>();
      for (const r of rows) {
        const k = r.name.toLowerCase();
        const e = byName.get(k) ?? { label: r.name, projects: new Set<string>() };
        e.projects.add(r.project.key);
        byName.set(k, e);
      }
      return [...byName.values()].slice(0, limit).map((e) => ({
        label: e.label,
        insert: asValue(e.label),
        detail: [...e.projects].slice(0, 4).join(", "),
        kind: "status" as const,
      }));
    }
    case "interval": {
      // `pi` is "items in this PI or any sprint inside it", so only a PROGRAM_
      // INCREMENT is a legal value; `sprint` means the contained timeboxes, so
      // a PI is not one. Unscoped, both pickers listed every interval in the
      // org and the detail line named no kind — a flat list where a PI, a
      // sprint and a phase are indistinguishable, which is what "I can't choose
      // a specific named PI, sprint or phase" looks like from outside.
      const kindWhere =
        field === "pi"
          ? { intervalKind: IntervalKind.PROGRAM_INCREMENT }
          : field === "sprint"
            ? { intervalKind: { not: IntervalKind.PROGRAM_INCREMENT } }
            : {};
      const rows = await prisma.interval.findMany({
        where: { orgId, projectId: { in: readable }, ...kindWhere, ...(prefix ? { name: where } : {}) },
        select: { name: true, status: true, intervalKind: true, project: { select: { key: true } } },
        take: limit,
        orderBy: [{ status: "asc" }, { startDate: "desc" }],
      });
      return rows.map((r) => ({
        label: r.name,
        insert: asValue(r.name),
        // The kind is the distinguishing fact when one field spans several —
        // "ACME · phase · active" beside "ACME · sprint · active".
        detail: `${r.project.key} · ${r.intervalKind.toLowerCase().replace(/_/g, " ")} · ${r.status.toLowerCase()}`,
        kind: "sprint" as const,
      }));
    }
    case "team": {
      const rows = await prisma.team.findMany({
        where: { orgId, projectId: { in: readable }, ...(prefix ? { name: where } : {}) },
        select: { name: true, project: { select: { key: true } } },
        take: limit,
        orderBy: { name: "asc" },
      });
      return rows.map((r) => ({ label: r.name, insert: asValue(r.name), detail: r.project.key, kind: "team" as const }));
    }
    case "label": {
      const rows = await prisma.label.findMany({
        where: { orgId, ...(prefix ? { name: where } : {}) },
        select: { name: true },
        take: limit,
        orderBy: { name: "asc" },
      });
      return rows.map((r) => ({ label: r.name, insert: asValue(r.name), kind: "label" as const }));
    }
    case "item": {
      // `ACME-12` or words from the title.
      const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d*)$/.exec(prefix);
      const projects = await prisma.project.findMany({ where: { orgId, id: { in: readable } }, select: { id: true, key: true } });
      const keyOf = new Map(projects.map((p) => [p.id, p.key]));
      const project = m ? projects.find((p) => p.key.toLowerCase() === m[1].toLowerCase()) : undefined;
      const rows = await prisma.workItem.findMany({
        where: {
          orgId,
          projectId: project ? project.id : { in: readable },
          archivedAt: null,
          ...(project && m?.[2] ? { ticketNumber: Number(m[2]) } : !project && prefix ? { title: where } : {}),
        },
        select: { projectId: true, ticketNumber: true, title: true },
        take: limit,
        orderBy: { updatedAt: "desc" },
      });
      return rows.map((r) => {
        const key = `${keyOf.get(r.projectId) ?? "?"}-${r.ticketNumber}`;
        return { label: key, insert: key, detail: r.title, kind: "item" as const };
      });
    }
    default:
      return [];
  }
}
