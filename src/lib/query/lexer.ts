/**
 * CQL tokens. One lexer for the server parser, the client parser and the
 * editor's syntax highlighter, so highlighting can never disagree with the
 * parser about what a token is.
 */
import { createToken, Lexer, type TokenType } from "chevrotain";

export const WhiteSpace = createToken({ name: "WhiteSpace", pattern: /\s+/, group: Lexer.SKIPPED });

export const StringLit = createToken({
  name: "StringLit",
  pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,
});

export const NotTilde = createToken({ name: "NotTilde", pattern: /!~/ });
export const Neq = createToken({ name: "Neq", pattern: /!=/ });
export const Lte = createToken({ name: "Lte", pattern: /<=/ });
export const Gte = createToken({ name: "Gte", pattern: />=/ });
export const Lt = createToken({ name: "Lt", pattern: /</ });
export const Gt = createToken({ name: "Gt", pattern: />/ });
/**
 * Equality. `==` is accepted and means the same as `=`.
 *
 * Reported from production: someone typed `type == feature`, got two
 * diagnostics neither of which mentioned `=`, and concluded the query language
 * did not work. Anyone who has written code types `==` by reflex, and the
 * grammar has no other meaning for it — so accepting it costs nothing and
 * removes a whole class of "it showed nothing". `printCql` still emits `=`,
 * so the canonical form, saved filters and the URL are unchanged.
 *
 * Safe against the two-character operators: `!=`, `<=` and `>=` are their own
 * tokens and are matched ahead of this one in OPERATOR_TOKENS.
 */
export const Eq = createToken({ name: "Eq", pattern: /==?/ });
export const Tilde = createToken({ name: "Tilde", pattern: /~/ });
export const Bang = createToken({ name: "Bang", pattern: /!/ });
export const LParen = createToken({ name: "LParen", pattern: /\(/ });
export const RParen = createToken({ name: "RParen", pattern: /\)/ });
export const LBracket = createToken({ name: "LBracket", pattern: /\[/ });
export const RBracket = createToken({ name: "RBracket", pattern: /\]/ });
export const Comma = createToken({ name: "Comma", pattern: /,/ });

export const Variable = createToken({ name: "Variable", pattern: /\$[A-Za-z_][A-Za-z0-9_]*/ });

export const DateLit = createToken({
  name: "DateLit",
  pattern: /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?(?![\w-])/,
  start_chars_hint: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
});

/** `-7d`, `+2w`, `3h`, `-1M` (months), `30m` (minutes), `-3wd` (working days). */
export const RelLit = createToken({
  name: "RelLit",
  pattern: /[+-]?\d{1,5}(?:wd|y|M|w|d|h|m)(?![\w-])/,
  start_chars_hint: ["+", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
});

export const NumberLit = createToken({
  name: "NumberLit",
  pattern: /-?\d+(?:\.\d+)?(?![\w-])/,
  start_chars_hint: ["-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
});

/**
 * Bare words: field names, function names and unquoted values like
 * `in-progress`, `ACME-12` or the prefix wildcard `log*`.
 */
export const Identifier = createToken({
  name: "Identifier",
  pattern: /[A-Za-z_*][A-Za-z0-9_\-.*]*/,
});

/** Keywords are case-insensitive and lose to a longer identifier (`order` vs `orders`). */
function kw(name: string): TokenType {
  return createToken({
    name,
    pattern: new RegExp(name, "i"),
    longer_alt: Identifier,
    categories: [Keyword],
  });
}
export const Keyword = createToken({ name: "Keyword", pattern: Lexer.NA });

export const And = kw("AND");
export const Or = kw("OR");
export const Not = kw("NOT");
export const In = kw("IN");
export const Is = kw("IS");
export const Empty = kw("EMPTY");
export const Null = kw("NULL");
export const Was = kw("WAS");
export const Changed = kw("CHANGED");
export const From = kw("FROM");
export const To = kw("TO");
export const By = kw("BY");
export const After = kw("AFTER");
export const Before = kw("BEFORE");
export const On = kw("ON");
export const During = kw("DURING");
export const Order = kw("ORDER");
export const Asc = kw("ASC");
export const Desc = kw("DESC");
export const Nulls = kw("NULLS");
export const First = kw("FIRST");
export const Last = kw("LAST");
export const All = kw("ALL");

/**
 * Keyword order matters where one is a prefix of another (`IN` vs `IS`, `NOT`
 * vs `NULLS`): with longer_alt each still yields to a longer identifier, and
 * none is a prefix of another full keyword except via that rule.
 */
export const KEYWORDS: TokenType[] = [
  Changed, During, Before, After, Order, Empty, Nulls, First, Desc, Last, Null, From, And, Not, Was, Asc, All,
  Or, In, Is, To, By, On,
];

/** Operators a "bare words" query never contains (see parser fallback). */
export const OPERATOR_TOKENS: TokenType[] = [NotTilde, Neq, Lte, Gte, Lt, Gt, Eq, Tilde];

export const ALL_TOKENS: TokenType[] = [
  WhiteSpace,
  StringLit,
  NotTilde,
  Neq,
  Lte,
  Gte,
  Lt,
  Gt,
  Eq,
  Tilde,
  Bang,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Comma,
  Variable,
  DateLit,
  RelLit,
  NumberLit,
  Keyword,
  ...KEYWORDS,
  Identifier,
];

export const cqlLexer = new Lexer(ALL_TOKENS, { positionTracking: "full", ensureOptimizations: false });

/** Highlighter classes, by token name. */
export function tokenClass(tokenName: string): string {
  switch (tokenName) {
    case "StringLit":
      return "string";
    case "NumberLit":
    case "RelLit":
    case "DateLit":
      return "number";
    case "Variable":
      return "variable";
    case "NotTilde":
    case "Neq":
    case "Lte":
    case "Gte":
    case "Lt":
    case "Gt":
    case "Eq":
    case "Tilde":
    case "Bang":
      return "operator";
    case "Identifier":
      return "name";
    default:
      return KEYWORDS.some((k) => k.name === tokenName) ? "keyword" : "punctuation";
  }
}
