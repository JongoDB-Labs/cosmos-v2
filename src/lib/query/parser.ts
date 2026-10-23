/**
 * CQL text → CqlQuery (unresolved), with positioned diagnostics.
 *
 *   parseCql("assignee = me AND priority IN (HIGH, CRITICAL) ORDER BY due")
 *
 * Chevrotain, with error recovery on: the editor gets a partial query and
 * EVERY error per keystroke rather than "error at col 1". The AST is the
 * contract; if this parser is ever swapped (a hand-written Pratt parser is the
 * fallback), nothing downstream changes, and the golden tests are the spec.
 *
 * Bare words are a text search: a query that does not parse and contains no
 * operator, parenthesis or field name at the start (`login timeout`, `work in
 * progress`) means `text ~ "login timeout"`, as in YouTrack, so a beginner never
 * sees a syntax error for typing words.
 *
 * Values come out UNRESOLVED (`{t:"str"}`); names become ids in
 * resolve.server.ts. Unknown bare field names come out as custom-field refs and
 * are judged by the typechecker, which knows the org's custom fields.
 */
import { EmbeddedActionsParser, EOF, type IToken, type TokenType } from "chevrotain";
import {
  ALL_TOKENS,
  After,
  All,
  And,
  Asc,
  Bang,
  Before,
  By,
  Changed,
  Comma,
  DateLit,
  Desc,
  During,
  Empty,
  Eq,
  First,
  From,
  Gt,
  Gte,
  Identifier,
  In,
  Is,
  Last,
  LBracket,
  LParen,
  Lt,
  Lte,
  Neq,
  Not,
  NotTilde,
  Null,
  Nulls,
  NumberLit,
  On,
  OPERATOR_TOKENS,
  Or,
  Order,
  RBracket,
  RelLit,
  RParen,
  StringLit,
  Tilde,
  To,
  Variable,
  Was,
  cqlLexer,
} from "./lexer";
import {
  CQL_LIMITS,
  CQL_VERSION,
  type CmpOp,
  type CqlNode,
  type CqlQuery,
  type CqlSort,
  type CqlValue,
  type FieldRef,
  type HistoryPreds,
  type PredValue,
} from "./ast";
import { lookupField } from "./fields";
import { lookupFunction } from "./functions";
import { diag, type CqlDiagnostic, type Span } from "./errors";

export interface ParseResult {
  query: CqlQuery;
  diagnostics: CqlDiagnostic[];
  /** Text span of each node / value / field object, by identity. */
  spans: WeakMap<object, Span>;
}

const tokSpan = (t: IToken): Span => ({ from: t.startOffset, to: (t.endOffset ?? t.startOffset) + 1 });
const join = (a: Span | undefined, b: Span | undefined): Span | undefined =>
  a && b ? { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) } : (a ?? b);

function unquote(image: string): string {
  const body = image.slice(1, -1);
  return body.replace(/\\(.)/g, "$1");
}

class CqlParser extends EmbeddedActionsParser {
  spans = new WeakMap<object, Span>();

  constructor() {
    super(ALL_TOKENS, { recoveryEnabled: true, maxLookahead: 3 });
    this.performSelfAnalysis();
  }

  private mark<T extends object>(o: T, s: Span | undefined): T {
    if (s) this.ACTION(() => this.spans.set(o, s));
    return o;
  }
  private spanOf(o: object | undefined): Span | undefined {
    return o ? this.spans.get(o) : undefined;
  }

  public query = this.RULE("query", () => {
    let where: CqlNode | null = null;
    let orderBy: CqlSort[] | undefined;
    this.OPTION(() => {
      where = this.SUBRULE(this.orExpr);
    });
    this.OPTION2(() => {
      orderBy = this.SUBRULE(this.orderBy);
    });
    const q: CqlQuery = { v: CQL_VERSION, where: where ?? null };
    if (orderBy) q.orderBy = orderBy;
    return q;
  });

  private orExpr = this.RULE("orExpr", (): CqlNode => {
    const args: CqlNode[] = [this.SUBRULE(this.andExpr)];
    this.MANY(() => {
      this.CONSUME(Or);
      args.push(this.SUBRULE2(this.andExpr));
    });
    return this.ACTION(() => this.combine("or", args));
  });

  private andExpr = this.RULE("andExpr", (): CqlNode => {
    const args: CqlNode[] = [this.SUBRULE(this.notExpr)];
    // Juxtaposition is AND, as in GitHub and YouTrack: `type = Bug priority = HIGH`.
    this.MANY(() => {
      this.OPTION(() => this.CONSUME(And));
      args.push(this.SUBRULE2(this.notExpr));
    });
    return this.ACTION(() => this.combine("and", args));
  });

  private combine(op: "and" | "or", args: CqlNode[]): CqlNode {
    const real = args.filter(Boolean);
    // Error recovery can leave nothing behind; the caller sees `null`.
    if (real.length === 0) return undefined as unknown as CqlNode;
    if (real.length === 1) return real[0];
    const span = real.map((a) => this.spanOf(a)).reduce(join, undefined);
    return this.mark({ op, args: real } as CqlNode, span);
  }

  private notExpr = this.RULE("notExpr", (): CqlNode => {
    return this.OR([
      {
        ALT: () => {
          const t = this.OR2([{ ALT: () => this.CONSUME(Not) }, { ALT: () => this.CONSUME(Bang) }]);
          const arg = this.SUBRULE(this.notExpr);
          return this.mark({ op: "not", arg } as CqlNode, join(tokSpan(t), this.spanOf(arg)));
        },
      },
      { ALT: () => this.SUBRULE(this.atom) },
    ]);
  });

  private atom = this.RULE("atom", (): CqlNode => {
    return this.OR([
      {
        ALT: () => {
          const open = this.CONSUME(LParen);
          const inner = this.SUBRULE(this.orExpr);
          const close = this.CONSUME(RParen);
          // The span includes the parentheses, so `NOT (…)` highlights whole.
          return this.mark(inner ?? ({} as CqlNode), join(tokSpan(open), tokSpan(close)));
        },
      },
      {
        // A bare item-set function is a clause: `descendantsOf(ACME-1)`.
        GATE: () => this.LA(1).tokenType === Identifier && this.LA(2).tokenType === LParen,
        ALT: () => {
          const fn = this.SUBRULE(this.functionCall);
          const field = { kind: "sys", id: "key" } as FieldRef;
          return this.mark({ op: "in", field, values: [fn] } as CqlNode, this.spanOf(fn));
        },
      },
      { ALT: () => this.SUBRULE(this.clause) },
    ]);
  });

  private field = this.RULE("field", (): FieldRef => {
    return this.OR([
      {
        // cf[severity] / cf["Severity"]
        GATE: () => this.LA(1).image.toLowerCase() === "cf" && this.LA(2).tokenType === LBracket,
        ALT: () => {
          const cf = this.CONSUME(Identifier);
          this.CONSUME(LBracket);
          const name = this.OR2([
            { ALT: () => this.CONSUME2(Identifier).image },
            { ALT: () => unquote(this.CONSUME(StringLit).image) },
          ]);
          const close = this.CONSUME(RBracket);
          return this.mark({ kind: "cf", key: name } as FieldRef, join(tokSpan(cf), tokSpan(close)));
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME3(Identifier);
          const def = lookupField(t.image);
          const f: FieldRef = def ? { kind: "sys", id: def.id } : { kind: "cf", key: t.image };
          return this.mark(f, tokSpan(t));
        },
      },
      {
        // "Story Points": a custom field by display name.
        ALT: () => {
          const t = this.CONSUME2(StringLit);
          const name = unquote(t.image);
          const def = lookupField(name);
          return this.mark(
            (def ? { kind: "sys", id: def.id } : { kind: "cf", key: name }) as FieldRef,
            tokSpan(t),
          );
        },
      },
    ]);
  });

  private clause = this.RULE("clause", (): CqlNode => {
    const field = this.SUBRULE(this.field);
    const node = this.OR([
      {
        ALT: () => {
          const op = this.SUBRULE(this.compareOp);
          const value = this.SUBRULE(this.value);
          return this.ACTION(() => {
            // `= EMPTY` is `IS EMPTY`, as in JQL.
            if (value?.t === "empty" && (op === "eq" || op === "neq")) {
              return { op: "empty", field, ...(op === "neq" ? { negate: true } : {}) } as CqlNode;
            }
            return { op: "cmp", field, cmp: op, value } as CqlNode;
          });
        },
      },
      {
        ALT: () => {
          let negate = false;
          let all = false;
          this.OPTION(() => {
            this.CONSUME(Not);
            negate = true;
          });
          this.CONSUME(In);
          this.OPTION2(() => {
            this.CONSUME(All);
            all = true;
          });
          const values = this.SUBRULE(this.valueSet);
          return {
            op: "in",
            field,
            ...(negate ? { negate: true } : {}),
            ...(all ? { all: true } : {}),
            values,
          } as CqlNode;
        },
      },
      {
        ALT: () => {
          let negate = false;
          this.CONSUME(Is);
          this.OPTION3(() => {
            this.CONSUME2(Not);
            negate = true;
          });
          this.OR2([{ ALT: () => this.CONSUME(Empty) }, { ALT: () => this.CONSUME(Null) }]);
          return { op: "empty", field, ...(negate ? { negate: true } : {}) } as CqlNode;
        },
      },
      {
        ALT: () => {
          const neg = this.OR3([
            { ALT: () => (this.CONSUME(Tilde), false) },
            { ALT: () => (this.CONSUME(NotTilde), true) },
          ]);
          const v = this.SUBRULE2(this.value);
          return this.ACTION(() => {
            const query = v && (v.t === "str" || v.t === "num") ? String(v.v) : "";
            return { op: "text", field, ...(neg ? { negate: true } : {}), query } as CqlNode;
          });
        },
      },
      {
        ALT: () => {
          this.CONSUME(Was);
          let negate = false;
          this.OPTION4(() => {
            this.CONSUME3(Not);
            negate = true;
          });
          const values = this.OR4([
            {
              ALT: () => {
                this.CONSUME2(In);
                return this.SUBRULE2(this.valueSet);
              },
            },
            { ALT: () => [this.SUBRULE3(this.value)] },
          ]);
          const preds = this.SUBRULE(this.historyPreds);
          return {
            op: "was",
            field,
            ...(negate ? { negate: true } : {}),
            values,
            ...(preds ? { preds } : {}),
          } as CqlNode;
        },
      },
      {
        ALT: () => {
          this.CONSUME(Changed);
          const preds = this.SUBRULE2(this.historyPreds);
          return { op: "changed", field, ...(preds ? { preds } : {}) } as CqlNode;
        },
      },
    ]);
    const end = this.LA(0);
    return this.mark(node, join(this.spanOf(field), end ? tokSpan(end) : undefined));
  });

  private compareOp = this.RULE("compareOp", (): CmpOp => {
    return this.OR([
      { ALT: () => (this.CONSUME(Eq), "eq" as const) },
      { ALT: () => (this.CONSUME(Neq), "neq" as const) },
      { ALT: () => (this.CONSUME(Lte), "lte" as const) },
      { ALT: () => (this.CONSUME(Gte), "gte" as const) },
      { ALT: () => (this.CONSUME(Lt), "lt" as const) },
      { ALT: () => (this.CONSUME(Gt), "gt" as const) },
    ]);
  });

  private historyPreds = this.RULE("historyPreds", (): HistoryPreds | undefined => {
    const preds: HistoryPreds = {};
    let any = false;
    this.MANY(() => {
      any = true;
      this.OR([
        { ALT: () => (this.CONSUME(From), (preds.from = this.SUBRULE(this.predValue))) },
        { ALT: () => (this.CONSUME(To), (preds.to = this.SUBRULE2(this.predValue))) },
        { ALT: () => (this.CONSUME(By), (preds.by = this.SUBRULE3(this.predValue))) },
        { ALT: () => (this.CONSUME(After), (preds.after = this.SUBRULE4(this.value))) },
        { ALT: () => (this.CONSUME(Before), (preds.before = this.SUBRULE5(this.value))) },
        { ALT: () => (this.CONSUME(On), (preds.on = this.SUBRULE6(this.value))) },
        {
          ALT: () => {
            this.CONSUME(During);
            this.CONSUME(LParen);
            const a = this.SUBRULE7(this.value);
            this.CONSUME(Comma);
            const b = this.SUBRULE8(this.value);
            this.CONSUME(RParen);
            preds.during = [a, b];
          },
        },
      ]);
    });
    return any ? preds : undefined;
  });

  /** FROM / TO / BY: a value, or a list `(a, b)`. */
  private predValue = this.RULE("predValue", (): PredValue => {
    return this.OR([
      {
        ALT: () => {
          this.CONSUME(LParen);
          const vals: CqlValue[] = [];
          this.AT_LEAST_ONE_SEP({
            SEP: Comma,
            DEF: () => {
              vals.push(this.SUBRULE(this.value));
            },
          });
          this.CONSUME(RParen);
          return vals.length === 1 ? vals[0] : vals;
        },
      },
      { ALT: () => this.SUBRULE2(this.value) },
    ]);
  });

  /** `(a, b, c)`, or a set-valued function / variable: `IN openSprints()`. */
  private valueSet = this.RULE("valueSet", (): CqlValue[] => {
    return this.OR([
      {
        ALT: () => {
          this.CONSUME(LParen);
          const vals: CqlValue[] = [];
          this.AT_LEAST_ONE_SEP({
            SEP: Comma,
            DEF: () => {
              vals.push(this.SUBRULE(this.value));
            },
          });
          this.CONSUME(RParen);
          return vals;
        },
      },
      {
        GATE: () => this.LA(1).tokenType === Identifier && this.LA(2).tokenType === LParen,
        ALT: () => [this.SUBRULE(this.functionCall)],
      },
      { ALT: () => [this.variable()] },
    ]);
  });

  private variable(): CqlValue {
    const t = this.CONSUME(Variable);
    return this.mark({ t: "var", name: t.image.slice(1) } as CqlValue, tokSpan(t));
  }

  private value = this.RULE("value", (): CqlValue => {
    return this.OR([
      {
        GATE: () => this.LA(1).tokenType === Identifier && this.LA(2).tokenType === LParen,
        ALT: () => this.SUBRULE(this.functionCall),
      },
      {
        ALT: () => {
          const t = this.CONSUME(StringLit);
          return this.mark({ t: "str", v: unquote(t.image) } as CqlValue, tokSpan(t));
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(NumberLit);
          return this.mark({ t: "num", v: Number(t.image) } as CqlValue, tokSpan(t));
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(RelLit);
          return this.mark({ t: "rel", v: t.image } as CqlValue, tokSpan(t));
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(DateLit);
          return this.mark({ t: "date", v: t.image } as CqlValue, tokSpan(t));
        },
      },
      { ALT: () => this.variable() },
      {
        ALT: () => {
          const t = this.OR2([{ ALT: () => this.CONSUME(Empty) }, { ALT: () => this.CONSUME(Null) }]);
          return this.mark({ t: "empty" } as CqlValue, tokSpan(t));
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(Identifier);
          return this.mark(this.ACTION(() => bareValue(t.image)), tokSpan(t));
        },
      },
    ]);
  });

  private functionCall = this.RULE("functionCall", (): CqlValue => {
    const name = this.CONSUME(Identifier);
    this.CONSUME(LParen);
    const args: CqlValue[] = [];
    this.MANY_SEP({
      SEP: Comma,
      DEF: () => {
        args.push(this.SUBRULE(this.value));
      },
    });
    const close = this.CONSUME(RParen);
    return this.ACTION(() => {
      const def = lookupFunction(name.image);
      // Unknown names are kept (as written) for the typechecker to report with
      // a suggestion; the AST schema rejects them if they ever get stored.
      const v = { t: "fn", name: def?.name ?? name.image, args } as CqlValue;
      return this.mark(v, join(tokSpan(name), tokSpan(close)));
    });
  });

  private orderBy = this.RULE("orderBy", (): CqlSort[] => {
    this.CONSUME(Order);
    this.CONSUME(By);
    const keys: CqlSort[] = [];
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => {
        const field = this.SUBRULE(this.field);
        let dir: "asc" | "desc" = "asc";
        let nulls: "first" | "last" | undefined;
        this.OPTION(() => {
          dir = this.OR([
            { ALT: () => (this.CONSUME(Asc), "asc" as const) },
            { ALT: () => (this.CONSUME(Desc), "desc" as const) },
          ]);
        });
        this.OPTION2(() => {
          this.CONSUME(Nulls);
          nulls = this.OR2([
            { ALT: () => (this.CONSUME(First), "first" as const) },
            { ALT: () => (this.CONSUME(Last), "last" as const) },
          ]);
        });
        const k: CqlSort = { field, dir, ...(nulls ? { nulls } : {}) };
        keys.push(this.mark(k, this.spanOf(field)));
      },
    });
    return keys;
  });
}

/** An unquoted value: `me`, `true`/`false`, otherwise a literal to resolve. */
function bareValue(image: string): CqlValue {
  const lower = image.toLowerCase();
  if (lower === "me") return { t: "fn", name: "currentUser", args: [] };
  if (lower === "true" || lower === "false") return { t: "bool", v: lower === "true" };
  return { t: "str", v: image };
}

// Built once: self-analysis is the expensive part, and the parser is reusable.
let parserInstance: CqlParser | null = null;
function parser(): CqlParser {
  if (!parserInstance) parserInstance = new CqlParser();
  return parserInstance;
}

const EXPECTED_HINT: Partial<Record<string, string>> = {
  value: "Expected a value (try `me`, `EMPTY`, a name in quotes, or a function like `openSprints()`).",
  compareOp: "Expected an operator such as `=`, `!=`, `IN`, `IS EMPTY` or `~`.",
};

function friendlySyntax(err: { message: string; token: IToken; context?: { ruleStack?: string[] } }): string {
  const stack = err.context?.ruleStack ?? [];
  const rule = stack[stack.length - 1];
  const at = err.token.tokenType === EOF ? "the end of the query" : `\`${err.token.image}\``;
  if (rule === "clause" && stack.length >= 1) {
    return `${EXPECTED_HINT.compareOp} Found ${at}.`;
  }
  if (rule === "value" || rule === "valueSet") return `${EXPECTED_HINT.value} Found ${at}.`;
  if (err.token.tokenType === EOF) return "The query ends too early.";
  return `Unexpected ${at}.`;
}

function looksLikeWords(tokens: IToken[]): boolean {
  if (tokens.length === 0) return false;
  // An operator, parenthesis, variable or ORDER keyword means "this is a query".
  const ops = new Set<TokenType>([...OPERATOR_TOKENS, LParen, RParen, LBracket, RBracket, Variable, Order]);
  if (tokens.some((t) => ops.has(t.tokenType))) return false;
  const first = tokens[0];
  // A query that starts with a field name is meant as a query, and should get
  // the real error ("assignee in bob" → "expected a value"), not a text search.
  return !(first.tokenType === Identifier && lookupField(first.image));
}

/** Tokens a value list's `(` follows: `IN (a, b)`, `IN ALL (…)`, `DURING (a, b)`. */
const LIST_OPENERS = new Set<TokenType>([In, All, During]);

/**
 * The first place the token stream nests too deep, if any: grouping
 * parentheses beyond CQL_LIMITS.parenDepth, any parentheses (function calls
 * and value lists included) beyond CQL_LIMITS.nodeDepth, or more NOTs in a
 * row than that. A function call's or a value list's `(` is not a group.
 */
function depthProblem(tokens: IToken[]): { message: string; span: Span } | null {
  let groups = 0;
  let parens = 0;
  let nots = 0;
  const open: boolean[] = []; // per open paren: a call's or a list's (not a group)?
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.tokenType === LParen) {
      const before = tokens[i - 1]?.tokenType;
      const call = before === Identifier || (before !== undefined && LIST_OPENERS.has(before));
      open.push(call);
      parens++;
      if (!call) groups++;
      if (groups > CQL_LIMITS.parenDepth) return { message: `Parentheses can nest at most ${CQL_LIMITS.parenDepth} deep.`, span: tokSpan(t) };
      if (parens > CQL_LIMITS.nodeDepth) return { message: `Conditions can nest at most ${CQL_LIMITS.nodeDepth} levels deep.`, span: tokSpan(t) };
    } else if (t.tokenType === RParen) {
      if (open.length) {
        if (!open.pop()) groups--;
        parens--;
      }
    }
    if (t.tokenType === Not || t.tokenType === Bang) {
      if (++nots > CQL_LIMITS.nodeDepth) return { message: `At most ${CQL_LIMITS.nodeDepth} NOTs in a row.`, span: tokSpan(t) };
    } else if (t.tokenType !== LParen) {
      nots = 0;
    }
  }
  return null;
}

export function parseCql(text: string): ParseResult {
  const diagnostics: CqlDiagnostic[] = [];
  if (text.length > CQL_LIMITS.textLength) {
    diagnostics.push(
      diag(text, "CQL_LIMIT", `Queries are limited to ${CQL_LIMITS.textLength} characters.`, {
        from: CQL_LIMITS.textLength,
        to: text.length,
      }),
    );
    return { query: { v: CQL_VERSION, where: null }, diagnostics, spans: new WeakMap() };
  }
  // Postgres text can't hold U+0000; refuse it here rather than fail in the database.
  const nul = text.indexOf("\u0000");
  if (nul >= 0) {
    diagnostics.push(diag(text, "CQL_SYNTAX", "Queries can't contain a NUL character.", { from: nul, to: nul + 1 }));
    return { query: { v: CQL_VERSION, where: null }, diagnostics, spans: new WeakMap() };
  }

  const lexed = cqlLexer.tokenize(text);
  // Depth is checked on the tokens BEFORE parsing. The parser recurses once
  // per level, so a few hundred `(` (closed or not) or a long run of NOTs
  // would overflow the stack before any check after parsing could run.
  const tooDeep = depthProblem(lexed.tokens);
  if (tooDeep) {
    diagnostics.push(diag(text, "CQL_LIMIT", tooDeep.message, tooDeep.span));
    return { query: { v: CQL_VERSION, where: null }, diagnostics, spans: new WeakMap() };
  }
  const p = parser();
  p.spans = new WeakMap();
  p.input = lexed.tokens;
  // Recovery can abandon the top rule entirely; an empty query stands in.
  const query = (p.query() as CqlQuery | undefined) ?? { v: CQL_VERSION, where: null };

  const lexErrors = lexed.errors;
  const parseErrors = p.errors;

  if ((lexErrors.length || parseErrors.length) && text.trim() && looksLikeWords(lexed.tokens) && lexErrors.length === 0) {
    const words = text.trim().replace(/\s+/g, " ");
    const spans = new WeakMap<object, Span>();
    const where: CqlNode = { op: "text", field: { kind: "sys", id: "text" }, query: words };
    spans.set(where, { from: 0, to: text.length });
    return { query: { v: CQL_VERSION, where }, diagnostics: [], spans };
  }

  for (const e of lexErrors) {
    const ch = text[e.offset];
    const msg =
      ch === '"' || ch === "'"
        ? "This quote is never closed."
        : `Unexpected character \`${ch}\`.`;
    diagnostics.push(diag(text, "CQL_SYNTAX", msg, { from: e.offset, to: e.offset + Math.max(1, e.length) }));
  }
  for (const e of parseErrors) {
    const t = e.token;
    // "priority HIGH": the parser stops at the field, but what is missing is the
    // operator after it, so point at the word that should have been one.
    if (t.tokenType === Identifier && lookupField(t.image)) {
      const i = lexed.tokens.indexOf(t);
      const next = i >= 0 ? lexed.tokens[i + 1] : undefined;
      if (!next || !OPERATOR_TOKENS.includes(next.tokenType)) {
        const span = next ? tokSpan(next) : { from: text.length, to: text.length };
        diagnostics.push(diag(text, "CQL_SYNTAX", `${EXPECTED_HINT.compareOp} after \`${t.image}\`.`.replace(". after", " after"), span));
        continue;
      }
    }
    const span =
      t.tokenType === EOF || Number.isNaN(t.startOffset)
        ? { from: text.length, to: text.length }
        : tokSpan(t);
    diagnostics.push(diag(text, "CQL_SYNTAX", friendlySyntax(e as never), span));
  }
  // Recovery often reports the same token twice from two rules; the first,
  // most specific message is the useful one.
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const k = `${d.code}:${d.from}:${d.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { query, diagnostics: unique, spans: p.spans };
}

/** Token stream for the editor's highlighter and completion slot detector. */
export function lexCql(text: string): IToken[] {
  return cqlLexer.tokenize(text).tokens;
}
