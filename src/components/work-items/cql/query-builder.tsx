"use client";

/**
 * The Issues query bar where the org has CQL on: one query, two views.
 *
 *   Basic     the free-text box ("Search issues", writes `text ~ "…"`) and
 *             chips for everything else; each change applies at once, like
 *             the filter bar it replaces
 *   Advanced  the CQL editor (CodeMirror, loaded only when opened); "Run
 *             query" or Enter applies. Under 640px it is a plain textarea with
 *             the server's diagnostics instead (design §8.6).
 *
 * Both edit the same text, which lives in the URL (`?cql=`). Basic is offered
 * only when the query fits in chips (basic.ts); otherwise the button is
 * disabled and says why and where, instead of silently rewriting the query.
 * The mode is a view preference: `&mode=` when present, else what this viewer
 * last chose.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { Play, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CQL_VERSION, type CqlNode, type CqlQuery } from "@/lib/query/ast";
import { fromChips, toChips, type Chip } from "@/lib/query/basic";
import { lineCol, type CqlDiagnostic } from "@/lib/query/errors";
import { normalize } from "@/lib/query/normalize";
import { parseCql } from "@/lib/query/parser";
import { printCql } from "@/lib/query/print";
import { QueryChips } from "./query-chips";
import type { CqlClientSchema, QueryMode } from "./use-cql";

const CqlEditor = dynamic(() => import("./cql-editor"), {
  ssr: false,
  loading: () => <div className="h-9 flex-1 animate-pulse rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)]" />,
});

const MODE_KEY = "cosmos:issues:query-mode";

function storedMode(): QueryMode | null {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === "basic" || v === "advanced" ? v : null;
  } catch {
    return null;
  }
}

function rememberMode(m: QueryMode) {
  try {
    window.localStorage.setItem(MODE_KEY, m);
  } catch {
    /* private window: the URL still carries it */
  }
}

const NARROW = "(max-width: 639px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(NARROW);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

const isTextBox = (c: Chip) => c.kind === "text" && c.field.kind === "sys" && c.field.id === "text" && !c.negate;

export interface QueryBuilderProps {
  orgId: string;
  schema: CqlClientSchema;
  /** The applied query text (from the URL). */
  cql: string;
  onCqlChange: (cql: string) => void;
  /** `&mode=` from the URL, if any. */
  mode: QueryMode | null;
  onModeChange: (mode: QueryMode) => void;
  /** The server's findings on the applied text (unknown values and the like). */
  serverDiagnostics?: CqlDiagnostic[];
}

export function QueryBuilder({ orgId, schema, cql, onCqlChange, mode, onModeChange, serverDiagnostics = [] }: QueryBuilderProps) {
  const parsed = useMemo(() => parseCql(cql), [cql]);
  const chips = useMemo(
    () => (parsed.diagnostics.some((d) => d.severity === "error") ? ({ ok: false, reason: "has a syntax error" } as const) : toChips(parsed.query)),
    [parsed],
  );
  const basicBlocked = chips.ok
    ? null
    : (() => {
        const span = chips.ok === false && "at" in chips && chips.at ? parsed.spans.get(chips.at) : undefined;
        const where = span ? ` (col ${lineCol(cql, span.from).column})` : "";
        return `This query ${chips.reason}${where}, which chips can't show. Edit it in Advanced.`;
      })();

  const [preferred, setPreferred] = useState<QueryMode | null>(null);
  useEffect(() => {
    // After mount only: localStorage doesn't exist on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferred(storedMode());
  }, []);
  const wanted = mode ?? preferred ?? "basic";
  const effective: QueryMode = wanted === "basic" && chips.ok ? "basic" : "advanced";

  const choose = (m: QueryMode) => {
    rememberMode(m);
    setPreferred(m);
    onModeChange(m);
  };

  return (
    <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--border)] text-xs" role="group" aria-label="Query mode">
          <button
            type="button"
            aria-pressed={effective === "basic"}
            disabled={!chips.ok}
            title={basicBlocked ?? "Filter with chips"}
            onClick={() => choose("basic")}
            className={cn(
              "px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-50",
              effective === "basic" ? "bg-[var(--primary)] text-[var(--primary-foreground,white)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            Basic
          </button>
          <button
            type="button"
            aria-pressed={effective === "advanced"}
            title="Write the query in CQL"
            onClick={() => choose("advanced")}
            className={cn(
              "px-2.5 py-1.5",
              effective === "advanced" ? "bg-[var(--primary)] text-[var(--primary-foreground,white)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            Advanced
          </button>
        </div>
        {effective === "basic" && chips.ok ? (
          <BasicMode orgId={orgId} schema={schema} query={parsed.query} chips={chips.chips} matchAny={chips.matchAny} onQuery={(q) => onCqlChange(printCql(q))} />
        ) : (
          <AdvancedMode orgId={orgId} schema={schema} cql={cql} onRun={onCqlChange} serverDiagnostics={serverDiagnostics} />
        )}
        {cql.trim() !== "" && (
          <Button variant="ghost" size="sm" onClick={() => onCqlChange("")} className="gap-1">
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>
      {effective === "advanced" && !chips.ok && basicBlocked && cql.trim() !== "" && (
        <p className="text-xs text-[var(--text-muted)]">{basicBlocked}</p>
      )}
      <Diagnostics items={serverDiagnostics} text={cql} />
    </div>
  );
}

function BasicMode({
  orgId,
  schema,
  query,
  chips,
  matchAny,
  onQuery,
}: {
  orgId: string;
  schema: CqlClientSchema;
  query: CqlQuery;
  chips: Chip[];
  matchAny: boolean;
  onQuery: (q: CqlQuery) => void;
}) {
  // The free-text box IS the `text ~` chip, so it isn't shown twice.
  const textChip = chips.find(isTextBox);
  const rest = chips.filter((c) => !isTextBox(c));
  const text = textChip && textChip.kind === "text" ? textChip.query : "";
  const [draft, setDraft] = useState(text);
  const [shown, setShown] = useState(text);
  if (text !== shown) {
    setShown(text);
    setDraft(text);
  }

  const emit = (next: Chip[], any: boolean, t: string) => {
    const all: Chip[] = t.trim() ? [...next, { kind: "text", field: { kind: "sys", id: "text" }, query: t.trim() }] : next;
    onQuery(fromChips(all, any, query.orderBy));
  };
  const commitText = () => draft.trim() !== text && emit(rest, matchAny, draft);

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText();
          }}
          onBlur={commitText}
          placeholder="Search title, description or comments…"
          className="pl-8"
          aria-label="Search issues"
        />
      </div>
      <QueryChips orgId={orgId} schema={schema} chips={rest} matchAny={matchAny} onChange={(c, any) => emit(c, any, text)} />
    </div>
  );
}

function AdvancedMode({
  orgId,
  schema,
  cql,
  onRun,
  serverDiagnostics,
}: {
  orgId: string;
  schema: CqlClientSchema;
  cql: string;
  onRun: (cql: string) => void;
  serverDiagnostics: CqlDiagnostic[];
}) {
  const narrow = useNarrow();
  const [draft, setDraft] = useState(cql);
  const [shown, setShown] = useState(cql);
  if (cql !== shown) {
    setShown(cql);
    setDraft(cql);
  }
  const run = (text = draft) => onRun(text.trim());

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
      {narrow ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              run();
            }
          }}
          rows={2}
          aria-label="Query"
          placeholder="assignee = me AND priority IN (HIGH, CRITICAL)"
          className="min-w-0 flex-1 font-mono text-sm"
          spellCheck={false}
        />
      ) : (
        <CqlEditor
          orgId={orgId}
          value={draft}
          onChange={setDraft}
          onRun={(t) => run(t)}
          schema={schema}
          serverDiagnostics={draft === cql ? serverDiagnostics : []}
        />
      )}
      <Button size="sm" onClick={() => run()} className="gap-1.5">
        <Play className="h-3.5 w-3.5" aria-hidden /> Run query
      </Button>
    </div>
  );
}

function Diagnostics({ items, text }: { items: CqlDiagnostic[]; text: string }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-0.5 text-xs" aria-label="Query problems">
      {items.slice(0, 5).map((d, i) => (
        <li key={i} className={d.severity === "error" ? "text-[var(--destructive)]" : "text-[var(--status-blocked-text,var(--text-muted))]"}>
          {d.message}
          {d.hint ? ` ${d.hint}` : ""}
          <span className="ml-1 text-[var(--text-muted)]">(col {lineCol(text, d.from).column})</span>
        </li>
      ))}
    </ul>
  );
}

/** Text for an empty query with one clause added — used by the Watching / Archived toggles. */
export function withClause(cql: string, toggle: (q: CqlQuery) => CqlQuery): string {
  const q = cql.trim() ? parseCql(cql).query : { v: CQL_VERSION, where: null as CqlNode | null };
  return printCql(normalize(toggle(q)));
}
