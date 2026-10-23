"use client";

/**
 * The CQL editor (Advanced mode): CodeMirror 6, one line that grows.
 *
 *   highlighting  a StreamLanguage whose tokenizer IS the CQL lexer, so the
 *                 colours can never disagree with the parser
 *   completion    the slot detector (lib/query/complete) decides what fits at
 *                 the cursor; fields and operators come from the schema,
 *                 values from GET /cql/suggest (scoped like the resolver)
 *   lint          syntax and types locally on every change (no network);
 *                 unknown names come from the server's /cql/validate, pushed
 *                 in as `serverDiagnostics`
 *   hover         a value (a person, a sprint) shows what it resolves to
 *   keys          Enter or Mod-Enter runs; Escape closes completion; Mod-/
 *                 opens the syntax help
 *
 * Loaded with next/dynamic only when Advanced mode opens, so the Issues page's
 * first paint doesn't pay for CodeMirror.
 */
import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import {
  autocompletion,
  completionStatus,
  startCompletion,
  type Completion as CmCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { forceLinting, linter, type Diagnostic } from "@codemirror/lint";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { tags } from "@lezer/highlight";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { cqlLexer, tokenClass } from "@/lib/query/lexer";
import { parseCql } from "@/lib/query/parser";
import { typecheck } from "@/lib/query/typecheck";
import { completionAt } from "@/lib/query/complete";
import { lookupField, type FieldDef } from "@/lib/query/fields";
import { LINK_TYPES } from "@/lib/query/fields";
import type { CqlDiagnostic } from "@/lib/query/errors";
import type { Suggestion } from "@/lib/query/suggest.server";
import type { CqlClientSchema } from "./use-cql";

// ── highlighting ─────────────────────────────────────────────────────────────

const cqlLanguage = StreamLanguage.define<null>({
  token(stream) {
    if (stream.eatSpace()) return null;
    const rest = stream.string.slice(stream.pos);
    const { tokens } = cqlLexer.tokenize(rest);
    const first = tokens[0];
    if (!first || first.startOffset !== 0) {
      stream.next();
      return "invalid";
    }
    stream.pos += first.image.length;
    const cls = tokenClass(first.tokenType.name);
    return cls === "name" ? (lookupField(first.image) ? "propertyName" : "variableName") : cls === "variable" ? "special" : cls;
  },
  tokenTable: {
    keyword: tags.keyword,
    string: tags.string,
    number: tags.number,
    operator: tags.operator,
    propertyName: tags.propertyName,
    variableName: tags.variableName,
    special: tags.special(tags.variableName),
    punctuation: tags.punctuation,
    invalid: tags.invalid,
  },
});

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--primary)", fontWeight: "600" },
  { tag: tags.propertyName, color: "var(--status-progress-text)" },
  { tag: tags.string, color: "var(--status-done-text)" },
  { tag: tags.number, color: "var(--status-discovery-text)" },
  { tag: tags.operator, color: "var(--text-muted)" },
  { tag: tags.special(tags.variableName), color: "var(--status-blocked-text)" },
  { tag: tags.invalid, color: "var(--destructive)", textDecoration: "underline wavy" },
]);

const theme = EditorView.theme({
  "&": {
    fontSize: "0.875rem",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--surface)",
    color: "var(--text)",
  },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "1px" },
  ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)", padding: "6px 8px", minHeight: "1.5rem" },
  ".cm-line": { padding: 0 },
  ".cm-placeholder": { color: "var(--text-muted)" },
  ".cm-tooltip": { border: "1px solid var(--border)", background: "var(--popover, var(--surface))", color: "var(--text)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--accent)", color: "var(--accent-foreground, var(--text))" },
  ".cm-completionDetail": { color: "var(--text-muted)", marginLeft: "0.5em", fontStyle: "normal" },
  ".cm-cql-hover": { padding: "2px 6px", fontSize: "0.75rem" },
});

// ── completion ───────────────────────────────────────────────────────────────

const OPERATOR_LABELS: Record<string, string[]> = {
  eq: ["=", "!="],
  in: ["IN ()", "NOT IN ()"],
  inAll: ["IN ALL ()"],
  order: ["<", "<=", ">", ">="],
  empty: ["IS EMPTY", "IS NOT EMPTY"],
  text: ["~", "!~"],
  history: ["WAS", "CHANGED"],
};

/** Insert `text` and, when it ends in a space or "(", reopen completion for what comes next. */
function apply(text: string): CmCompletion["apply"] {
  return (view, _c, from, to) => {
    const insert = text.endsWith("()") ? text.slice(0, -1) : text;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
    if (/[ (]$/.test(insert)) setTimeout(() => startCompletion(view), 0);
  };
}

function fieldOptions(schema: CqlClientSchema, sortable = false): CmCompletion[] {
  const sys = schema.fields
    .filter((f) => !f.pending && (sortable ? f.sortable : f.ops.length > 0))
    .map((f) => ({ label: f.id, type: "property", detail: f.label, info: f.description, apply: apply(`${f.id} `) }));
  const cfs = sortable
    ? []
    : schema.customFields.map((c) => ({
        label: c.name,
        type: "property",
        detail: "Custom field",
        apply: apply(`${/^[A-Za-z0-9_]+$/.test(c.name) ? c.name : `"${c.name}"`} `),
        section: "Custom fields",
      }));
  return [...sys, ...cfs];
}

function opsFor(schema: CqlClientSchema, field: string): string[] {
  const sys = lookupField(field) as FieldDef | undefined;
  const fams = sys
    ? sys.ops
    : (() => {
        const cf = schema.customFields.find((c) => c.name.toLowerCase() === field.toLowerCase() || c.key === field);
        if (!cf) return ["eq", "in", "empty", "text", "order"] as const;
        return cf.fieldType === "NUMBER" || cf.fieldType === "DATE"
          ? (["eq", "order"] as const)
          : cf.fieldType === "CHECKBOX"
            ? (["eq"] as const)
            : cf.fieldType === "MULTI_SELECT"
              ? (["eq", "in", "inAll"] as const)
              : (["eq", "in"] as const);
      })();
  return fams.flatMap((f) => OPERATOR_LABELS[f] ?? []);
}

async function suggest(orgId: string, field: string, prefix: string): Promise<Suggestion[]> {
  const qs = new URLSearchParams({ field, prefix, limit: "20" });
  try {
    const r = await jsonFetch<{ items: Suggestion[] }>(`/api/v1/orgs/${orgId}/cql/suggest?${qs}`);
    return r.items;
  } catch {
    return [];
  }
}

const toOption = (s: Suggestion): CmCompletion => ({
  label: s.label,
  detail: s.detail,
  type: s.kind === "function" ? "function" : s.kind === "keyword" ? "keyword" : "constant",
  apply: apply(`${s.insert} `),
});

/** Hovering a value shows what it names: the person's email, the sprint's project and state. */
function valueHover(orgId: string): Extension {
  return hoverTooltip(
    async (view, pos) => {
      const text = view.state.doc.toString();
      const tok = cqlLexer.tokenize(text).tokens.find((t) => t.startOffset <= pos && pos <= (t.endOffset ?? t.startOffset));
      if (!tok || (tok.tokenType.name !== "Identifier" && tok.tokenType.name !== "StringLit")) return null;
      const { slot } = completionAt(text, tok.startOffset);
      if (slot.kind !== "value") return null;
      const word = tok.image.replace(/^["']|["']$/g, "");
      const unq = (s: string) => s.replace(/^"|"$/g, "").toLowerCase();
      const hit = (await suggest(orgId, slot.field, word)).find(
        (s) => s.label.toLowerCase() === word.toLowerCase() || unq(s.insert) === word.toLowerCase(),
      );
      if (!hit?.detail) return null;
      return {
        pos: tok.startOffset,
        end: (tok.endOffset ?? tok.startOffset) + 1,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-cql-hover";
          dom.textContent = `${hit.label} · ${hit.detail}`;
          return { dom };
        },
      };
    },
    { hoverTime: 350 },
  );
}

function completionSource(orgId: string, getSchema: () => CqlClientSchema | null) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const schema = getSchema();
    if (!schema) return null;
    const text = ctx.state.doc.toString();
    const { slot, from, prefix } = completionAt(text, ctx.pos);
    if (!ctx.explicit && from === ctx.pos && slot.kind !== "value" && slot.kind !== "operator" && !/[\s(,]$/.test(text.slice(0, ctx.pos))) {
      return null;
    }
    const words = (list: string[], type = "keyword") => list.map((w) => ({ label: w, type, apply: apply(w.endsWith("()") ? w : `${w} `) }));
    let options: CmCompletion[] = [];
    switch (slot.kind) {
      case "field":
        options = [...fieldOptions(schema), ...words(["NOT", "("])];
        break;
      case "operator":
        options = words(opsFor(schema, slot.field), "operator");
        break;
      case "value":
        options = slot.afterIs ? words(["EMPTY", "NOT EMPTY"]) : (await suggest(orgId, slot.field, prefix)).map(toOption);
        break;
      case "keyword":
        options = [...words(["AND", "OR", "ORDER BY"]), ...fieldOptions(schema)];
        break;
      case "sortField":
        options = fieldOptions(schema, true);
        break;
      case "sortDir":
        options = words(["ASC", "DESC", "NULLS FIRST", "NULLS LAST", ","]);
        break;
      case "argument": {
        const fn = slot.fn.toLowerCase();
        if (fn === "membersof") options = (await suggest(orgId, "team", prefix)).map(toOption);
        else if (fn.startsWith("startof") || fn.startsWith("endof")) options = words(["-1w", "+1w", "-1d", "-1M"], "constant");
        else if (fn === "linkeditems" && slot.index === 1) options = words([...LINK_TYPES], "constant");
        else if (fn === "updatedby" && slot.index === 0) options = (await suggest(orgId, "assignee", prefix)).map(toOption);
        else options = (await suggest(orgId, "key", prefix)).map(toOption);
        break;
      }
    }
    return { from, options, validFor: /^[\w\s"'$-]*$/ };
  };
}

// ── lint ─────────────────────────────────────────────────────────────────────

const setServerDiagnostics = StateEffect.define<CqlDiagnostic[]>();
const serverDiagnostics = StateField.define<CqlDiagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setServerDiagnostics)) return e.value;
    // Edits make server findings stale; the next validate refills them.
    return tr.docChanged ? [] : value;
  },
});

function toCm(d: CqlDiagnostic, len: number): Diagnostic {
  const from = Math.min(d.from, len);
  const to = Math.min(Math.max(d.to, from), len);
  return {
    from,
    to,
    severity: d.severity,
    message: d.hint ? `${d.message} ${d.hint}` : d.message,
    ...(d.fixes?.length
      ? {
          actions: d.fixes.map((f) => ({
            name: f.label,
            apply: (view: EditorView) =>
              view.dispatch({ changes: { from: f.replace.from, to: f.replace.to, insert: f.replace.insert } }),
          })),
        }
      : {}),
  };
}

function cqlLinter(getSchema: () => CqlClientSchema | null): Extension {
  return linter(
    (view) => {
      const text = view.state.doc.toString();
      const parsed = parseCql(text);
      const local = [...parsed.diagnostics];
      const schema = getSchema();
      if (!parsed.diagnostics.length && schema) {
        local.push(...typecheck(parsed.query, { customFields: schema.customFields }, text, parsed.spans).diagnostics);
      }
      const server = view.state.field(serverDiagnostics);
      const seen = new Set(local.map((d) => `${d.from}:${d.code}`));
      return [...local, ...server.filter((d) => !seen.has(`${d.from}:${d.code}`))].map((d) => toCm(d, text.length));
    },
    { delay: 150 },
  );
}

// ── component ────────────────────────────────────────────────────────────────

export interface CqlEditorProps {
  orgId: string;
  value: string;
  onChange: (text: string) => void;
  onRun: (text: string) => void;
  schema: CqlClientSchema | null;
  serverDiagnostics?: CqlDiagnostic[];
  placeholder?: string;
  autoFocus?: boolean;
  /** Mod-/ : open the syntax help. */
  onHelp?: () => void;
}

export default function CqlEditor({
  orgId,
  value,
  onChange,
  onRun,
  schema,
  serverDiagnostics: serverDiags = [],
  placeholder = "assignee = me AND priority IN (HIGH, CRITICAL) ORDER BY due",
  autoFocus,
  onHelp,
}: CqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Latest props for the long-lived extensions, without rebuilding the editor.
  const latest = useRef({ onChange, onRun, schema, onHelp });
  useEffect(() => {
    latest.current = { onChange, onRun, schema, onHelp };
  });

  useEffect(() => {
    if (!host.current) return;
    const run = (v: EditorView) => {
      // Enter accepts a completion when the list is open; otherwise it runs.
      if (completionStatus(v.state) === "active") return false;
      latest.current.onRun(v.state.doc.toString());
      return true;
    };
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([
          { key: "Enter", run },
          { key: "Mod-Enter", run: (v) => (latest.current.onRun(v.state.doc.toString()), true) },
          { key: "Mod-/", run: () => (latest.current.onHelp?.(), true) },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        cqlLanguage,
        syntaxHighlighting(highlight),
        theme,
        cmPlaceholder(placeholder),
        autocompletion({ override: [completionSource(orgId, () => latest.current.schema)], activateOnTyping: true }),
        serverDiagnostics,
        cqlLinter(() => latest.current.schema),
        valueHover(orgId),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": "Query", "aria-multiline": "true" }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is built once; value and diagnostics are pushed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // A value set from outside (URL, Basic mode, a saved filter) replaces the text.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setServerDiagnostics.of(serverDiags) });
    forceLinting(v);
  }, [serverDiags]);

  return <div ref={host} className="min-w-0 flex-1" data-testid="cql-editor" />;
}
