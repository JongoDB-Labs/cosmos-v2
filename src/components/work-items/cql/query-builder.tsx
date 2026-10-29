"use client";

/**
 * The Issues query bar where the org has CQL on: one query, two ways in.
 *
 *   Filters  dropdown chips and the free-text box ("Search issues", which
 *            writes `text ~ "…"`); each change applies at once, like the
 *            filter bar it replaces
 *   CQL      the CQL editor (CodeMirror, loaded only when opened); "Run
 *            query" or Enter applies. Under 640px it is a plain textarea with
 *            the server's diagnostics instead (design §8.6).
 *
 * They were called Basic and Advanced, which named the mechanism and not the
 * job — reported as "i'm not sure what the difference between basic and
 * advanced is" (FR ad579c82). Two things follow from that report:
 *
 *   - the names now say what each one DOES, and
 *   - "Add filter" is in both. It used to exist only in chips, so a query with
 *     a group, an OR or a history operator — exactly the queries that force
 *     this bar into the text editor — had no filter dropdown at all. Beside
 *     the editor it appends `AND <clause>` to the text (append-clause.ts)
 *     rather than reprinting the tree, which is what makes it safe on a query
 *     chips cannot represent.
 *
 * Only the LABELS changed. `?mode=basic` / `?mode=advanced` still mean what
 * they did, because links people have already shared carry them, and the code
 * keeps `BasicMode` / `AdvancedMode` to match.
 *
 * Both edit the same text, which lives in the URL (`?cql=`). Chips are offered
 * only when the query fits in them (basic.ts); otherwise the button is
 * disabled and says why and where, instead of silently rewriting the query.
 * The mode is a view preference: `&mode=` when present, else what this viewer
 * last chose.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { CircleHelp, Filter, Play, Search, Sparkles, WandSparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CQL_VERSION, type CqlNode, type CqlQuery } from "@/lib/query/ast";
import { fromChips, toChips, type Chip } from "@/lib/query/basic";
import { lineCol, type CqlDiagnostic, type Span } from "@/lib/query/errors";
import { normalize } from "@/lib/query/normalize";
import { parseCql } from "@/lib/query/parser";
import { printCql, printNode } from "@/lib/query/print";
import { CQL_EXAMPLES } from "@/lib/query/describe";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { looksLikeQuery } from "@/lib/query/looks-like-query";
import { appendChip, fieldsIn } from "@/lib/query/append-clause";
import { toast } from "sonner";
import { QueryChips } from "./query-chips";
import { useCqlValidate, type CqlClientSchema, type QueryMode } from "./use-cql";

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

/**
 * Where `target` (a node of the NORMALIZED query, which toChips works on) was
 * written: the first node of the parsed tree that prints the same.
 */
function spanOf(root: CqlNode | null, target: CqlNode, spans: WeakMap<object, Span>): Span | undefined {
  const want = printNode(target);
  const stack: CqlNode[] = root ? [root] : [];
  while (stack.length) {
    const n = stack.shift()!;
    if (printNode(n) === want) return spans.get(n);
    if (n.op === "and" || n.op === "or") stack.push(...n.args);
    else if (n.op === "not") stack.push(n.arg);
  }
  return undefined;
}

const isTextBox = (c: Chip) => c.kind === "text" && c.field.kind === "sys" && c.field.id === "text" && !c.negate;

export interface QueryBuilderProps {
  orgId: string;
  schema: CqlClientSchema;
  /** The applied query text (from the URL). */
  cql: string;
  /**
   * Apply the query, optionally switching mode in the SAME navigation.
   * Writing the text and then the mode separately loses the text: both writes
   * are built from one `useSearchParams` snapshot (the bar has not re-rendered
   * yet), so the second `replaceState` drops the first's `cql`.
   */
  onCqlChange: (cql: string, mode?: QueryMode) => void;
  /** `&mode=` from the URL, if any. */
  mode: QueryMode | null;
  onModeChange: (mode: QueryMode) => void;
  /** The server's findings on the applied text (unknown values and the like). */
  serverDiagnostics?: CqlDiagnostic[];
  /**
   * The viewer's saved filters, matched by name against what they type in the
   * search box: "search/save filters in the search bar" (FR ad579c82). Left
   * out where there are none to run — boards, for one.
   */
  savedFilters?: SavedFilterOption[];
  onRunFilter?: (f: SavedFilterOption) => void;
}

/** Enough of a saved filter to offer it and run it. */
export interface SavedFilterOption {
  id: string;
  name: string;
}

export function QueryBuilder({
  orgId,
  schema,
  cql,
  onCqlChange,
  mode,
  onModeChange,
  serverDiagnostics = [],
  savedFilters,
  onRunFilter,
}: QueryBuilderProps) {
  const parsed = useMemo(() => parseCql(cql), [cql]);
  const chips = useMemo(
    () => (parsed.diagnostics.some((d) => d.severity === "error") ? ({ ok: false, reason: "has a syntax error" } as const) : toChips(parsed.query)),
    [parsed],
  );
  const basicBlocked = chips.ok
    ? null
    : (() => {
        const span = !chips.ok && "at" in chips && chips.at ? spanOf(parsed.query.where, chips.at, parsed.spans) : undefined;
        const where = span ? ` (col ${lineCol(cql, span.from).column})` : "";
        return `This query ${chips.reason}${where}, which chips can't show. Edit it under CQL.`;
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
  /** Remember the mode without writing the URL: the caller carries it instead. */
  const prefer = (m: QueryMode) => {
    rememberMode(m);
    setPreferred(m);
  };

  return (
    <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--border)] text-xs" role="group" aria-label="How to filter">
          <button
            type="button"
            aria-pressed={effective === "basic"}
            disabled={!chips.ok}
            title={basicBlocked ?? "Pick filters from dropdowns and search the text"}
            onClick={() => choose("basic")}
            className={cn(
              "px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-50",
              effective === "basic" ? "bg-[var(--primary)] text-[var(--primary-foreground,white)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            Filters
          </button>
          <button
            type="button"
            aria-pressed={effective === "advanced"}
            title="Write the filter as text, for grouping, OR and history. You can still add filters from the dropdown."
            onClick={() => choose("advanced")}
            className={cn(
              "px-2.5 py-1.5",
              effective === "advanced" ? "bg-[var(--primary)] text-[var(--primary-foreground,white)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            CQL
          </button>
        </div>
        {effective === "basic" && chips.ok ? (
          <BasicMode
            orgId={orgId}
            schema={schema}
            query={parsed.query}
            chips={chips.chips}
            matchAny={chips.matchAny}
            onQuery={(q) => onCqlChange(printCql(q))}
            onRunAsQuery={(text) => {
              // The text and the mode in ONE navigation (see onCqlChange):
              // two writes in a row race, and the query is what gets lost.
              prefer("advanced");
              onCqlChange(text, "advanced");
            }}
            savedFilters={savedFilters}
            onRunFilter={onRunFilter}
          />
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
  onRunAsQuery,
  savedFilters,
  onRunFilter,
}: {
  orgId: string;
  schema: CqlClientSchema;
  query: CqlQuery;
  chips: Chip[];
  matchAny: boolean;
  onQuery: (q: CqlQuery) => void;
  /** Take what they typed and run it as a QUERY rather than as a phrase. */
  onRunAsQuery: (text: string) => void;
  savedFilters?: SavedFilterOption[];
  onRunFilter?: (f: SavedFilterOption) => void;
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

  // "search/save filters in the search bar": a saved filter whose NAME matches
  // what they are typing. The box itself searches issue text, so a filter's
  // name typed here otherwise finds nothing and says nothing about why.
  const needle = draft.trim().toLowerCase();
  const filterHits =
    onRunFilter && needle.length >= 2
      ? (savedFilters ?? []).filter((f) => f.name.toLowerCase().includes(needle)).slice(0, 3)
      : [];

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
      {filterHits.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => onRunFilter!(f)}
          title={`Run the saved filter “${f.name}”`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--primary)] hover:text-[var(--text)]"
        >
          <Filter className="h-3.5 w-3.5" aria-hidden />
          <span className="max-w-[12rem] truncate">{f.name}</span>
        </button>
      ))}
      {looksLikeQuery(draft) && (
        // This box searches for what you type as a PHRASE. A query typed here
        // matches nothing and says nothing about why, because nothing was
        // parsed — which is exactly how "type == feature showed nothing"
        // happened. Offer the other reading rather than silently finding none.
        <button
          type="button"
          onClick={() => onRunAsQuery(draft.trim())}
          className="shrink-0 rounded-md border border-[var(--primary)] px-2.5 py-1.5 text-xs text-[var(--primary)] hover:bg-[var(--primary)] hover:text-[var(--primary-foreground,white)]"
        >
          Run as a query
        </button>
      )}
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
  const [help, setHelp] = useState(false);
  const [ask, setAsk] = useState(false);
  if (cql !== shown) {
    setShown(cql);
    setDraft(cql);
  }
  const run = (text = draft) => onRun(text.trim());

  // Stage 2 lint (§8.3): what only the server knows (unknown or ambiguous
  // values), 400 ms after typing stops. The applied text's findings arrive
  // with the page; anything else is asked for here.
  const [settled, setSettled] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setSettled(draft), 400);
    return () => clearTimeout(t);
  }, [draft]);
  const live = useCqlValidate(orgId, settled, settled !== cql && !parseCql(settled).diagnostics.length);
  const findings = draft === cql ? serverDiagnostics : settled === draft ? (live.data?.diagnostics ?? []) : [];

  const format = () => {
    const p = parseCql(draft);
    if (!p.diagnostics.some((d) => d.severity === "error")) setDraft(printCql(p.query));
  };

  // Fields the draft already constrains: offering them again would make a
  // query chips then refuse ("has two conditions on one field").
  const addable = useMemo(() => fieldsIn(draft), [draft]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
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
            onHelp={() => setHelp((h) => !h)}
            schema={schema}
            serverDiagnostics={findings}
          />
        )}
        <Button size="sm" onClick={() => run()} className="gap-1.5">
          <Play className="h-3.5 w-3.5" aria-hidden /> Run query
        </Button>
        <Button variant="ghost" size="sm" onClick={format} title="Tidy the query's spacing and keywords" className="gap-1">
          <WandSparkles className="h-3.5 w-3.5" aria-hidden /> Format
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAsk((a) => !a)} aria-expanded={ask} className="gap-1">
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Ask AI
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setHelp((h) => !h)}
          aria-expanded={help}
          aria-label="Syntax help"
          title="Syntax help (Ctrl or Cmd + /)"
        >
          <CircleHelp className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {/* "I should simply be able to add the filters from the dropdown on the
          right" — here too, not only in chips. This appends `AND <clause>` to
          the text and runs it, so it works on the grouped and history queries
          that forced the bar into this editor in the first place. */}
      <QueryChips
        orgId={orgId}
        schema={schema}
        chips={[]}
        matchAny={false}
        hideMatch
        excludeFields={addable}
        onChange={(c) => {
          const chip = c[c.length - 1];
          if (!chip) return;
          const r = appendChip(draft, chip);
          if (r.ok) {
            setDraft(r.cql);
            onRun(r.cql);
          } else toast.error(`Couldn't add that filter: ${r.reason}.`);
        }}
      />
      {/* The textarea has no inline lint, so its findings are listed. */}
      {narrow && draft !== cql && <Diagnostics items={findings} text={draft} />}
      {ask && <AskAi orgId={orgId} onQuery={setDraft} />}
      {help && <SyntaxHelp onPick={(q) => setDraft(q)} />}
    </div>
  );
}

/**
 * "Ask AI to build a filter" (§12.3): a sentence in, a query into the editor.
 * It never runs the query: the user reads it and presses Run query.
 */
function AskAi({ orgId, onQuery }: { orgId: string; onQuery: (cql: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<{ busy: boolean; note: string | null; error: string | null }>({ busy: false, note: null, error: null });
  const submit = async () => {
    const text = prompt.trim();
    if (!text || state.busy) return;
    setState({ busy: true, note: null, error: null });
    try {
      const r = await jsonFetch<{ cql: string; diagnostics: CqlDiagnostic[] }>(`/api/v1/orgs/${orgId}/cql/ai`, {
        method: "POST",
        body: JSON.stringify({ prompt: text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (!r.cql) {
        setState({ busy: false, note: null, error: "The assistant couldn't turn that into a query. Try rewording it." });
        return;
      }
      onQuery(r.cql);
      const bad = r.diagnostics.some((d) => d.severity === "error");
      setState({ busy: false, error: null, note: bad ? "The query has problems, underlined in the editor. Fix them, then Run query." : "Check the query in the editor, then Run query." });
    } catch (e) {
      const body = e instanceof FetchError ? (e.body as { error?: { message?: string } } | null) : null;
      const message =
        e instanceof FetchError && e.status === 429 ? "Too many requests. Wait a moment and try again." : (body?.error?.message ?? "The assistant couldn't build a query just now.");
      setState({ busy: false, note: null, error: message });
    }
  };
  return (
    <form
      className="flex min-w-0 flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={500}
        aria-label="Describe the filter"
        placeholder="e.g. my high priority bugs due this week"
        className="h-8 min-w-0 flex-1 text-sm"
      />
      <Button type="submit" size="sm" variant="outline" disabled={!prompt.trim() || state.busy} className="gap-1">
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> {state.busy ? "Building…" : "Build query"}
      </Button>
      {(state.note || state.error) && (
        <p role="status" className={cn("w-full text-xs", state.error ? "text-destructive" : "text-[var(--text-muted)]")}>
          {state.error ?? state.note}
        </p>
      )}
    </form>
  );
}


function SyntaxHelp({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div role="region" aria-label="Query syntax" className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 text-xs">
      <p className="mb-2 text-[var(--text-muted)]">
        <code>field operator value</code>, joined with <code>AND</code> / <code>OR</code> and grouped with parentheses.
        Operators: <code>= != &lt; &lt;= &gt; &gt;= IN NOT IN ~ !~ IS EMPTY</code>. Dates: <code>2026-01-31</code>,{" "}
        <code>-7d</code>, <code>-3wd</code> (working days), <code>startOfWeek()</code>. <code>me</code> is you. Ctrl+Space
        suggests what fits.
      </p>
      <p className="mb-2 text-[var(--text-muted)]">
        History: <code>WAS</code>, <code>WAS NOT</code>, <code>WAS IN</code> and <code>CHANGED</code>, with{" "}
        <code>FROM</code> / <code>TO</code> / <code>BY</code> / <code>AFTER</code> / <code>BEFORE</code> / <code>ON</code> /{" "}
        <code>DURING (a, b)</code>, for status, priority, assignee, sprint, team, type, due, start and completed. It
        covers changes recorded since history tracking began, and for assignee only the primary assignee.
      </p>
      <ul className="space-y-1">
        {CQL_EXAMPLES.map((e) => (
          <li key={e.q}>
            <button type="button" onClick={() => onPick(e.q)} className="text-left hover:underline">
              <code className="text-[var(--primary)]">{e.q}</code>
              <span className="ml-2 text-[var(--text-muted)]">{e.says}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Diagnostics({ items, text }: { items: CqlDiagnostic[]; text: string }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-0.5 text-xs" aria-label="Query problems">
      {items.slice(0, 5).map((d, i) => (
        <li key={i} className={d.severity === "error" ? "text-[var(--status-blocked-text)]" : "text-[var(--text-muted)]"}>
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
