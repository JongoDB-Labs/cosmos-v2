/**
 * What can be typed at the cursor? The editor's completion asks this on every
 * keystroke, on text that is usually broken (it is being typed), so this does
 * not parse: it walks the token stream before the cursor with a small state
 * machine. Simpler to test than a grammar-introspection API, and it never
 * throws on garbage.
 *
 *   slot      what to offer
 *   field     system and custom fields                     `|`, `a = 1 AND |`, `(|`
 *   operator  operators valid for `field`                  `priority |`
 *   value     values (and functions) for `field`           `priority = |`, `assignee IN (me, |`
 *   keyword   AND, OR, ORDER BY (and fields: juxtaposition) `priority = HIGH |`
 *   sortField fields after ORDER BY                        `ORDER BY |`, `ORDER BY due, |`
 *   sortDir   ASC / DESC / NULLS FIRST|LAST                `ORDER BY due |`
 *   argument  an argument of `fn` (e.g. teams for membersOf) `assignee IN membersOf(|`
 *
 * `from` is where the word being completed starts, so applying a completion
 * replaces it. Pure and client-safe.
 */
import type { IToken, TokenType } from "chevrotain";
import { cqlLexer, And, Or, Not, Bang, LParen, RParen, LBracket, RBracket, Comma, In, Is, Empty, Null, Was, Changed, From, To, By, After, Before, On, During, Order, Asc, Desc, Nulls, First, Last, All, Eq, Neq, Lt, Lte, Gt, Gte, Tilde, NotTilde, Identifier, StringLit, NumberLit, RelLit, DateLit, Variable } from "./lexer";

export type Slot =
  | { kind: "field" }
  | { kind: "operator"; field: string }
  | { kind: "value"; field: string; inList: boolean; afterIs?: boolean }
  | { kind: "keyword" }
  | { kind: "sortField" }
  | { kind: "sortDir" }
  | { kind: "argument"; fn: string; index: number; field: string | null };

export interface Completion {
  slot: Slot;
  /** Start of the word under completion (== cursor when there is none). */
  from: number;
  /** What has been typed of that word. */
  prefix: string;
}

const COMPARE = new Set<TokenType>([Eq, Neq, Lt, Lte, Gt, Gte, Tilde, NotTilde]);
const VALUE_TOKENS = new Set<TokenType>([StringLit, NumberLit, RelLit, DateLit, Variable, Empty, Null, Identifier]);
const PREDS = new Set<TokenType>([From, To, By, After, Before, On]);

type State =
  | { s: "field" }
  | { s: "op"; field: string }
  | { s: "afterNot"; field: string }
  | { s: "afterIn"; field: string }
  | { s: "afterIs"; field: string }
  | { s: "value"; field: string }
  | { s: "list"; field: string }
  | { s: "listNext"; field: string }
  | { s: "after"; field: string }
  | { s: "orderBy" }
  | { s: "sortField" }
  | { s: "sortDir" }
  | { s: "nulls" };

/** Tokens of `text`, unbroken by lexer errors (unknown characters are skipped). */
function tokens(text: string): IToken[] {
  return cqlLexer.tokenize(text).tokens;
}

/** Offset of a quote opened before the cursor and not yet closed, or -1. */
function openQuoteAt(before: string): number {
  let open = -1;
  let quote = "";
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (open >= 0) {
      if (c === "\\") i++;
      else if (c === quote) open = -1;
    } else if (c === '"' || c === "'") {
      open = i;
      quote = c;
    }
  }
  return open;
}

export function completionAt(text: string, cursor: number): Completion {
  const full = text.slice(0, cursor);
  // `assignee = "Dana R|`: the open quote starts the word being typed.
  const q = openQuoteAt(full);
  if (q >= 0) {
    const inner = completionAt(text, q);
    return { slot: inner.slot, from: q, prefix: full.slice(q + 1) };
  }
  const before = full;
  const all = tokens(before);
  // The word being typed: a token touching the cursor with no space after it.
  const last = all[all.length - 1];
  const touching = last && (last.endOffset ?? -1) + 1 === cursor && /^[A-Za-z_$*"']/.test(last.image);
  const toks = touching ? all.slice(0, -1) : all;
  const from = touching ? last.startOffset : cursor;
  const prefix = touching ? before.slice(from).replace(/^["']/, "") : "";

  let st: State = { s: "field" };
  // Function call frames: name, argument index, the field it is a value of.
  const fnStack: { fn: string; index: number; field: string | null }[] = [];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const tt = t.tokenType;
    const next = toks[i + 1];

    // Inside a function call's parentheses.
    if (fnStack.length) {
      if (tt === LParen && toks[i - 1]?.tokenType === Identifier) {
        fnStack.push({ fn: toks[i - 1].image, index: 0, field: fnStack[fnStack.length - 1].field });
      } else if (tt === Comma) fnStack[fnStack.length - 1].index++;
      else if (tt === RParen) {
        const frame = fnStack.pop()!;
        if (!fnStack.length) st = frame.field ? { s: "after", field: frame.field } : { s: "after", field: "" };
      }
      continue;
    }

    if (tt === Identifier && next?.tokenType === LParen && (st.s === "field" || st.s === "value" || st.s === "list" || st.s === "afterIn" || st.s === "after")) {
      // A function call: a value, or a bare item-set clause.
      const field = "field" in st ? st.field : null;
      fnStack.push({ fn: t.image, index: 0, field: st.s === "field" || st.s === "after" ? null : field });
      i++; // its "("
      continue;
    }

    switch (st.s) {
      case "field":
      case "after":
        if (tt === And || tt === Or || tt === LParen || tt === Not || tt === Bang) st = { s: "field" };
        else if (tt === RParen) st = { s: "after", field: "" };
        else if (tt === Order) st = { s: "orderBy" };
        else if (st.s === "after" && PREDS.has(tt)) st = { s: "value", field: st.field };
        else if (st.s === "after" && tt === During) st = { s: "value", field: st.field };
        else if (tt === Identifier && t.image.toLowerCase() === "cf" && next?.tokenType === LBracket) {
          const close = toks.findIndex((x, j) => j > i && x.tokenType === RBracket);
          if (close < 0) return { slot: { kind: "field" }, from, prefix };
          const inner = toks.slice(i + 2, close).map((x) => x.image.replace(/^["']|["']$/g, "")).join(" ");
          st = { s: "op", field: inner };
          i = close;
        } else if (tt === Identifier || tt === StringLit) st = { s: "op", field: t.image.replace(/^["']|["']$/g, "") };
        break;
      case "op":
        if (COMPARE.has(tt)) st = { s: "value", field: st.field };
        else if (tt === Not) st = { s: "afterNot", field: st.field };
        else if (tt === In) st = { s: "afterIn", field: st.field };
        else if (tt === Is) st = { s: "afterIs", field: st.field };
        else if (tt === Was) st = { s: "value", field: st.field };
        else if (tt === Changed) st = { s: "after", field: st.field };
        break;
      case "afterNot":
        st = tt === In ? { s: "afterIn", field: st.field } : { s: "after", field: st.field };
        break;
      case "afterIn":
        if (tt === All) break;
        if (tt === LParen) st = { s: "list", field: st.field };
        else st = { s: "after", field: st.field };
        break;
      case "afterIs":
        if (tt === Not) break;
        st = { s: "after", field: st.field };
        break;
      case "value":
        if (tt === In) st = { s: "afterIn", field: st.field }; // WAS IN (…)
        else if (tt === Not) break; // WAS NOT …
        else if (tt === LParen) st = { s: "list", field: st.field }; // DURING (
        else if (VALUE_TOKENS.has(tt)) st = { s: "after", field: st.field };
        break;
      case "list":
        if (VALUE_TOKENS.has(tt)) st = { s: "listNext", field: st.field };
        else if (tt === RParen) st = { s: "after", field: st.field };
        break;
      case "listNext":
        if (tt === Comma) st = { s: "list", field: st.field };
        else if (tt === RParen) st = { s: "after", field: st.field };
        break;
      case "orderBy":
        if (tt === By) st = { s: "sortField" };
        break;
      case "sortField":
        if (tt === Identifier || tt === StringLit) st = { s: "sortDir" };
        break;
      case "sortDir":
        if (tt === Comma) st = { s: "sortField" };
        else if (tt === Nulls) st = { s: "nulls" };
        // ASC / DESC keep the direction slot (NULLS may follow).
        else if (tt !== Asc && tt !== Desc) st = { s: "sortDir" };
        break;
      case "nulls":
        if (tt === First || tt === Last) st = { s: "sortDir" };
        break;
    }
  }

  if (fnStack.length) {
    const f = fnStack[fnStack.length - 1];
    return { slot: { kind: "argument", fn: f.fn, index: f.index, field: f.field }, from, prefix };
  }
  const slot: Slot = (() => {
    switch (st.s) {
      case "field":
        return { kind: "field" } as const;
      case "op":
      case "afterNot":
        return { kind: "operator", field: st.field } as const;
      case "afterIs":
        return { kind: "value", field: st.field, inList: false, afterIs: true } as const;
      case "afterIn":
      case "list":
        return { kind: "value", field: st.field, inList: true } as const;
      case "value":
        return { kind: "value", field: st.field, inList: false } as const;
      case "listNext":
        return { kind: "keyword" } as const;
      case "after":
        return { kind: "keyword" } as const;
      case "orderBy":
        return { kind: "keyword" } as const;
      case "sortField":
        return { kind: "sortField" } as const;
      case "sortDir":
      case "nulls":
        return { kind: "sortDir" } as const;
    }
  })();
  return { slot, from, prefix };
}
