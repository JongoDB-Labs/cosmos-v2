/**
 * JQL-lite QUERY LANGUAGE for the org-wide Issues search bar (COSMOS-59).
 *
 * Turns a free-text query like
 *
 *     project = FSC priority is high label = urgent overdue login
 *
 * into a typed {@link WorkItemFilter} (the same model the Issues API already
 * runs), a residual free-text remainder ("overdue login"), a list of recognised
 * clauses, and a list of human parse errors. It also powers autocomplete
 * ({@link suggestJql}) — suggesting fields, operators and values as you type.
 *
 * This module is PURE (no DB, no React) so the grammar is exhaustively
 * unit-testable. The vocabulary of valid values (which projects/types/statuses/
 * … exist) is injected as a {@link QueryVocab}, built client-side from the
 * Issues facets. Nothing here widens RBAC scope — the server still re-scopes
 * every query to the projects the caller may read.
 *
 * Grammar (v1):
 *   query   := (clause | word)*
 *   clause  := field op value
 *   field   := one of the known field aliases (project, type, status, …)
 *   op      := "="  | "==" | ":" | "is"          (equality synonyms)
 *   value   := "quoted string" | bareword
 * Bare words that are not part of a clause become the free-text search.
 * Negation / list operators (`!=`, `is not`, `in`) are recognised but reported
 * as unsupported so a user gets feedback instead of a silently-ignored clause.
 */
import { Priority } from "@prisma/client";
import { UNASSIGNED, type WorkItemFilter } from "./filter";

/** The scoped fields a clause can target. */
export type JqlFieldKey =
  | "project"
  | "type"
  | "status"
  | "priority"
  | "assignee"
  | "label"
  | "cycle";

/** A selectable value for a field (project, type, status, …). */
export interface VocabOption {
  /** The value stored in the filter (project id, column key, tag, priority
   *  enum, user id, cycle id). */
  value: string;
  /** Human label shown in autocomplete. */
  label: string;
  /** Extra single-token match keys (e.g. a project/type/status key) — matched
   *  case-insensitively and preferred when echoing a value back into the box. */
  aliases?: string[];
}

/** The vocabulary of valid values, injected from the Issues facets. */
export interface QueryVocab {
  project: VocabOption[];
  type: VocabOption[];
  status: VocabOption[];
  priority: VocabOption[];
  assignee: VocabOption[];
  label: VocabOption[];
  cycle: VocabOption[];
  /** Current user id — lets `assignee = me` resolve. */
  currentUserId?: string;
}

/** An empty vocab (parser still works — clauses over empty fields just error). */
export const EMPTY_VOCAB: QueryVocab = {
  project: [],
  type: [],
  status: [],
  priority: [],
  assignee: [],
  label: [],
  cycle: [],
};

interface FieldDef {
  key: JqlFieldKey;
  /** Canonical name echoed by autocomplete. */
  canonical: string;
  /** All accepted field names (canonical first), lowercased. */
  aliases: string[];
  /** Human noun for error messages ("project", "label", …). */
  noun: string;
}

const FIELD_DEFS: FieldDef[] = [
  { key: "project", canonical: "project", aliases: ["project", "proj"], noun: "project" },
  { key: "type", canonical: "type", aliases: ["type", "kind", "issuetype"], noun: "type" },
  { key: "status", canonical: "status", aliases: ["status", "state", "column", "lane"], noun: "status" },
  { key: "priority", canonical: "priority", aliases: ["priority", "prio"], noun: "priority" },
  { key: "assignee", canonical: "assignee", aliases: ["assignee", "owner", "assigned"], noun: "assignee" },
  { key: "label", canonical: "label", aliases: ["label", "labels", "tag", "tags"], noun: "label" },
  { key: "cycle", canonical: "cycle", aliases: ["cycle", "sprint", "iteration"], noun: "cycle" },
];

/** Built-in priority vocabulary — used when the injected vocab omits it. */
export const PRIORITY_OPTIONS: VocabOption[] = [
  { value: Priority.CRITICAL, label: "Critical" },
  { value: Priority.HIGH, label: "High" },
  { value: Priority.MEDIUM, label: "Medium" },
  { value: Priority.LOW, label: "Low" },
];

/** Sentinel tokens that resolve an assignee clause to "no assignee". */
const UNASSIGNED_TOKENS = new Set(["unassigned", "none", "nobody", "noone"]);

const FIELD_BY_ALIAS = new Map<string, FieldDef>();
for (const def of FIELD_DEFS) {
  for (const a of def.aliases) FIELD_BY_ALIAS.set(a, def);
}

/** Resolve a bareword to a field def (case-insensitive), or null. */
function resolveField(word: string): FieldDef | null {
  return FIELD_BY_ALIAS.get(word.trim().toLowerCase()) ?? null;
}

// ── Tokeniser ────────────────────────────────────────────────────────────

type TokenType = "word" | "op" | "value";
interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  /** True for a "value" token that came from a quoted string. */
  quoted?: boolean;
}

/** Characters that end a bareword (operators + quotes). */
function isBreak(input: string, i: number): boolean {
  const c = input[i];
  if (c === " " || c === "\t" || c === '"' || c === "'" || c === "=" || c === ":") return true;
  if (c === "!" && input[i + 1] === "=") return true;
  return false;
}

interface TokenizeResult {
  tokens: Token[];
  errors: JqlError[];
}

function tokenize(input: string): TokenizeResult {
  const tokens: Token[] = [];
  const errors: JqlError[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let val = "";
      while (i < n && input[i] !== quote) {
        val += input[i];
        i++;
      }
      if (i >= n) {
        errors.push({ message: "Unterminated quote — add a closing quote.", start, end: n });
        tokens.push({ type: "value", value: val, start, end: n, quoted: true });
      } else {
        i++; // consume closing quote
        tokens.push({ type: "value", value: val, start, end: i, quoted: true });
      }
      continue;
    }
    if (c === "=") {
      if (input[i + 1] === "=") {
        tokens.push({ type: "op", value: "==", start: i, end: i + 2 });
        i += 2;
      } else {
        tokens.push({ type: "op", value: "=", start: i, end: i + 1 });
        i++;
      }
      continue;
    }
    if (c === ":") {
      tokens.push({ type: "op", value: ":", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === "!" && input[i + 1] === "=") {
      tokens.push({ type: "op", value: "!=", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    // bareword
    const start = i;
    let val = "";
    while (i < n && !isBreak(input, i)) {
      val += input[i];
      i++;
    }
    tokens.push({ type: "word", value: val, start, end: i });
  }
  return { tokens, errors };
}

// ── Operator detection ───────────────────────────────────────────────────

type OpKind = "eq" | "neq" | "in";
interface OpMatch {
  kind: OpKind | null;
  display: string;
  /** Index of the token AFTER the operator (where the value begins). */
  next: number;
}

function isEqOp(t: Token | undefined): boolean {
  return !!t && t.type === "op" && (t.value === "=" || t.value === "==" || t.value === ":");
}
function isWord(t: Token | undefined, word: string): boolean {
  return !!t && t.type === "word" && t.value.toLowerCase() === word;
}

/** Read the operator that (may) follow a field word at token index `idx`. */
function readOperator(tokens: Token[], idx: number): OpMatch {
  const t = tokens[idx];
  if (!t) return { kind: null, display: "", next: idx };
  if (t.type === "op") {
    if (t.value === "=" || t.value === "==" || t.value === ":") {
      return { kind: "eq", display: t.value, next: idx + 1 };
    }
    if (t.value === "!=") return { kind: "neq", display: "!=", next: idx + 1 };
    return { kind: null, display: t.value, next: idx };
  }
  const w = t.value.toLowerCase();
  if (w === "is") {
    if (isWord(tokens[idx + 1], "not")) return { kind: "neq", display: "is not", next: idx + 2 };
    return { kind: "eq", display: "is", next: idx + 1 };
  }
  if (w === "in") return { kind: "in", display: "in", next: idx + 1 };
  if (w === "not" && isWord(tokens[idx + 1], "in")) {
    return { kind: "in", display: "not in", next: idx + 2 };
  }
  return { kind: null, display: "", next: idx };
}

// ── Value resolution ───────────────────────────────────────────────────────

interface ResolveResult {
  ok: boolean;
  value?: string;
  error?: string;
}

/** Options a field draws its values from (with the priority fallback). */
function optionsFor(field: JqlFieldKey, vocab: QueryVocab): VocabOption[] {
  if (field === "priority") return vocab.priority.length ? vocab.priority : PRIORITY_OPTIONS;
  return vocab[field];
}

type MatchResult = { option?: VocabOption; ambiguous?: boolean };

/** Match a raw token against a set of options (exact, then unique prefix). */
function matchOption(options: VocabOption[], raw: string): MatchResult {
  const low = raw.trim().toLowerCase();
  if (!low) return {};
  const exact = options.find(
    (o) =>
      o.value.toLowerCase() === low ||
      o.label.toLowerCase() === low ||
      (o.aliases ?? []).some((a) => a.toLowerCase() === low),
  );
  if (exact) return { option: exact };
  const prefix = options.filter(
    (o) =>
      o.label.toLowerCase().startsWith(low) ||
      (o.aliases ?? []).some((a) => a.toLowerCase().startsWith(low)),
  );
  if (prefix.length === 1) return { option: prefix[0] };
  if (prefix.length > 1) return { ambiguous: true };
  return {};
}

function resolveValue(field: JqlFieldKey, raw: string, vocab: QueryVocab): ResolveResult {
  const noun = FIELD_DEFS.find((f) => f.key === field)?.noun ?? field;
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: `Missing value for "${noun}".` };

  if (field === "assignee") {
    const low = trimmed.toLowerCase();
    if (UNASSIGNED_TOKENS.has(low)) return { ok: true, value: UNASSIGNED };
    if (low === "me") {
      return vocab.currentUserId
        ? { ok: true, value: vocab.currentUserId }
        : { ok: false, error: `Can't resolve "me" here — try your name.` };
    }
    const m = matchOption(vocab.assignee, trimmed);
    if (m.option) return { ok: true, value: m.option.value };
    if (m.ambiguous) return { ok: false, error: `"${trimmed}" matches more than one ${noun}.` };
    return { ok: false, error: `No ${noun} matches "${trimmed}".` };
  }

  if (field === "label") {
    // Tags are free-form and the facet list can be partial, so a label that
    // isn't in the vocab is still applied verbatim (case-normalised to a known
    // tag when one matches case-insensitively).
    const m = matchOption(vocab.label, trimmed);
    return { ok: true, value: m.option ? m.option.value : trimmed };
  }

  const m = matchOption(optionsFor(field, vocab), trimmed);
  if (m.option) return { ok: true, value: m.option.value };
  if (m.ambiguous) return { ok: false, error: `"${trimmed}" matches more than one ${noun}.` };
  return { ok: false, error: `No ${noun} matches "${trimmed}".` };
}

// ── Parser ────────────────────────────────────────────────────────────────

export interface JqlClause {
  field: JqlFieldKey;
  /** The operator as typed ("=", "is", …). */
  operator: string;
  /** The raw value token. */
  rawValue: string;
  /** The resolved filter value, when resolution succeeded. */
  value?: string;
}

export interface JqlError {
  message: string;
  /** Character offset range in the input (for optional highlighting). */
  start: number;
  end: number;
}

export interface ParsedJql {
  /** The typed filter — only the fields the query actually mentioned are set.
   *  Free-text remainder lands in `filter.text`. */
  filter: WorkItemFilter;
  /** The residual free-text (also mirrored into `filter.text`). */
  text: string;
  clauses: JqlClause[];
  errors: JqlError[];
}

function applyToFilter(filter: WorkItemFilter, field: JqlFieldKey, value: string): void {
  const push = (key: keyof WorkItemFilter) => {
    const arr = (filter[key] as string[] | undefined) ?? [];
    if (!arr.includes(value)) arr.push(value);
    (filter[key] as string[]) = arr;
  };
  switch (field) {
    case "project":
      push("projectIds");
      break;
    case "type":
      push("typeIds");
      break;
    case "status":
      push("columnKeys");
      break;
    case "priority": {
      const arr = filter.priorities ?? [];
      if (!arr.includes(value as Priority)) arr.push(value as Priority);
      filter.priorities = arr;
      break;
    }
    case "assignee":
      push("assigneeIds");
      break;
    case "label":
      push("labels");
      break;
    case "cycle":
      push("cycleIds");
      break;
  }
}

/** Parse a raw query string into a typed filter + clauses + errors. */
export function parseJql(input: string, vocab: QueryVocab = EMPTY_VOCAB): ParsedJql {
  const { tokens, errors: tokErrors } = tokenize(input);
  const filter: WorkItemFilter = {};
  const clauses: JqlClause[] = [];
  const errors: JqlError[] = [...tokErrors];
  const textParts: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok.type === "op") {
      errors.push({ message: `Unexpected "${tok.value}".`, start: tok.start, end: tok.end });
      i++;
      continue;
    }

    if (tok.type === "value") {
      // A top-level quoted string (no preceding field) is free text.
      textParts.push(tok.value);
      i++;
      continue;
    }

    // tok.type === "word"
    const field = resolveField(tok.value);
    if (!field) {
      textParts.push(tok.value);
      i++;
      continue;
    }

    const op = readOperator(tokens, i + 1);
    if (!op.kind) {
      // A field name with no operator behind it is just a search word.
      textParts.push(tok.value);
      i++;
      continue;
    }

    const valTok = tokens[op.next];
    // Missing value: end of input, or the next token starts a new clause
    // (field op …) rather than being a value.
    const nextStartsClause =
      valTok?.type === "word" &&
      !!resolveField(valTok.value) &&
      !!readOperator(tokens, op.next + 1).kind;
    if (!valTok || valTok.type === "op" || nextStartsClause) {
      errors.push({
        message: `Missing value for "${field.noun}".`,
        start: tok.start,
        end: tok.end,
      });
      i = op.next; // resume at the token after the operator
      continue;
    }

    if (op.kind !== "eq") {
      errors.push({
        message: `The "${op.display}" operator isn't supported yet — use "=" or "is".`,
        start: tok.start,
        end: valTok.end,
      });
      i = op.next + 1;
      continue;
    }

    const rawValue = valTok.value;
    const res = resolveValue(field.key, rawValue, vocab);
    const clause: JqlClause = { field: field.key, operator: op.display, rawValue };
    if (res.ok && res.value !== undefined) {
      clause.value = res.value;
      applyToFilter(filter, field.key, res.value);
    } else if (res.error) {
      errors.push({ message: res.error, start: valTok.start, end: valTok.end });
    }
    clauses.push(clause);
    i = op.next + 1;
  }

  const text = textParts.join(" ").trim();
  if (text) filter.text = text;
  return { filter, text, clauses, errors };
}

// ── Autocomplete ────────────────────────────────────────────────────────────

export interface Suggestion {
  kind: "field" | "operator" | "value";
  /** Primary text shown in the dropdown. */
  label: string;
  /** Secondary hint (e.g. a project key or "attribute"). */
  hint?: string;
  /** The full input string after accepting this suggestion (trailing space so
   *  the next token can be typed immediately). */
  newInput: string;
}

const EQ_OPERATORS = ["=", "is"] as const;
const MAX_VALUE_SUGGESTIONS = 8;

interface TailState {
  mode: "field" | "operator" | "value";
  field?: JqlFieldKey;
  /** The partial token being typed (may be ""). */
  partial: string;
  /** Char index where the partial begins (where a completion replaces from). */
  partialStart: number;
}

/** Figure out what the user is typing at the end of the input. */
function analyzeTail(input: string, tokens: Token[]): TailState {
  const endsWithSpace = input === "" || /\s$/.test(input);
  const len = tokens.length;
  const last = tokens[len - 1];
  const fieldAt = (idx: number): JqlFieldKey | null => {
    const t = tokens[idx];
    return t && t.type === "word" ? (resolveField(t.value)?.key ?? null) : null;
  };

  if (len === 0) return { mode: "field", partial: "", partialStart: input.length };

  if (endsWithSpace) {
    if (isEqOp(last) || isWord(last, "is")) {
      const field = fieldAt(len - 2);
      if (field) return { mode: "value", field, partial: "", partialStart: input.length };
    }
    if (last.type === "word") {
      const f = resolveField(last.value);
      const precededByOp = isEqOp(tokens[len - 2]) || isWord(tokens[len - 2], "is");
      if (f && !precededByOp) {
        return { mode: "operator", field: f.key, partial: "", partialStart: input.length };
      }
    }
    return { mode: "field", partial: "", partialStart: input.length };
  }

  // Mid-token (typing the last token).
  if (isEqOp(last)) {
    const field = fieldAt(len - 2);
    if (field) return { mode: "value", field, partial: "", partialStart: input.length };
    return { mode: "field", partial: "", partialStart: input.length };
  }
  if (last.type === "word" || last.type === "value") {
    const prev = tokens[len - 2];
    if ((isEqOp(prev) || isWord(prev, "is")) && fieldAt(len - 3)) {
      return {
        mode: "value",
        field: fieldAt(len - 3)!,
        partial: last.value,
        partialStart: last.start,
      };
    }
    if (last.type === "word") {
      // Right after a field word → typing the operator.
      const prevField = fieldAt(len - 2);
      if (prevField) {
        return { mode: "operator", field: prevField, partial: last.value, partialStart: last.start };
      }
      return { mode: "field", partial: last.value, partialStart: last.start };
    }
  }
  return { mode: "field", partial: "", partialStart: input.length };
}

/** Wrap a token in quotes when it contains whitespace. */
function asToken(text: string): string {
  return /\s/.test(text) ? `"${text}"` : text;
}

/** The text to echo into the box for a value option (prefer a single-token
 *  alias/label so the query stays readable). */
function insertTextFor(option: VocabOption): string {
  const candidates = [...(option.aliases ?? []), option.label];
  const singleToken = candidates.find((c) => c && !/\s/.test(c));
  return singleToken ?? asToken(option.label);
}

/**
 * Suggest completions for the query as it stands (cursor assumed at the end).
 * Returns field names, operators, or value options depending on context.
 */
export function suggestJql(input: string, vocab: QueryVocab = EMPTY_VOCAB): Suggestion[] {
  const { tokens } = tokenize(input);
  const tail = analyzeTail(input, tokens);
  const base = input.slice(0, tail.partialStart);
  const low = tail.partial.trim().toLowerCase();

  if (tail.mode === "operator") {
    return EQ_OPERATORS.filter((op) => !low || op.startsWith(low)).map((op) => ({
      kind: "operator" as const,
      label: op,
      hint: "operator",
      newInput: `${base}${op} `,
    }));
  }

  if (tail.mode === "value" && tail.field) {
    const options = optionsFor(tail.field, vocab);
    const matches = options.filter(
      (o) =>
        !low ||
        o.label.toLowerCase().includes(low) ||
        o.value.toLowerCase().includes(low) ||
        (o.aliases ?? []).some((a) => a.toLowerCase().includes(low)),
    );
    return matches.slice(0, MAX_VALUE_SUGGESTIONS).map((o) => ({
      kind: "value" as const,
      label: o.label,
      hint: o.aliases?.[0] ?? tail.field,
      newInput: `${base}${insertTextFor(o)} `,
    }));
  }

  // Field mode — suggest field names by prefix.
  return FIELD_DEFS.filter((f) => !low || f.aliases.some((a) => a.startsWith(low))).map((f) => ({
    kind: "field" as const,
    label: f.canonical,
    hint: "attribute",
    newInput: `${base}${f.canonical} `,
  }));
}

/** All queryable field names — handy for placeholder/help text. */
export const JQL_FIELDS: readonly string[] = FIELD_DEFS.map((f) => f.canonical);
