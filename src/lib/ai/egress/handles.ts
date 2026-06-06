// src/lib/ai/egress/handles.ts
//
// The opaque-handle resolver — the capability that lets the CUI-blind gov agent
// ACT on withheld CUI BY REFERENCE (move/file/route a value it is not cleared to
// read) WITHOUT that value ever reaching the commercial model.
//
// Flow:
//   1. The egress gate WITHHOLDS a CUI field from the model's structural view.
//   2. `mintHandle(...)` seals the real value at rest and returns an unguessable,
//      CONVERSATION-SCOPED token `h:<base64url(18 random bytes)>`. The model is
//      given the TOKEN, never the value (see projection.augmentWithHandles).
//   3. The model carries the token into a later tool call's args.
//   4. `resolveHandlesDeep(...)` (called by the agent loop BEFORE executeTool)
//      substitutes the real value back IN-BOUNDARY — only the executor sees it.
//      The executor's RESULT is re-gated by the existing loop, so a resolved value
//      does NOT return to the model unless the gate independently exposes it.
//
// THREAT-MODEL INVARIANTS (enforced here + tested in handles.test.ts /
// red-team.test.ts):
//   * Unguessable token: 18 random bytes (144 bits) via crypto.randomBytes — the
//     model cannot fabricate a valid token; a non-matching token simply isn't
//     resolved (passed through literally — harmless).
//   * Conversation-scoped resolve: resolveHandle matches findUnique({token}) THEN
//     verifies row.conversationId === the caller's conversationId, else returns
//     null. A token minted in conversation A MUST NOT resolve in conversation B
//     (defeats cross-conversation / cross-TENANT CUI access).
//   * Token carries no CUI: it is random; the value is vault-sealed at rest.
//   * Exact whole-string match on resolve: a handle is substituted only when an arg
//     string EQUALS a token, never as a substring — avoids partial-injection.
//   * No value is ever logged. Failures to open are swallowed → null (fail closed:
//     a value that can't be opened is treated as unresolvable).

import crypto from "node:crypto";
import type { ClassificationLevel } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";
import { rankOf } from "@/lib/classification/effective";

/** Token prefix + the random-byte width (18 bytes → 144 bits → 24 base64url chars). */
const HANDLE_PREFIX = "h:";
const TOKEN_BYTES = 18;
/** base64url alphabet only, the exact length 18 bytes encodes to (no padding). */
const TOKEN_BODY_RE = /^[A-Za-z0-9_-]{24}$/;

/** Max recursion depth for resolveHandlesDeep — bounds adversarial/cyclic args. */
const MAX_RESOLVE_DEPTH = 6;

/** Metadata recorded with a minted handle (NEVER the value). */
export interface HandleMeta {
  entityType: string;
  fieldName: string;
}

/**
 * True iff `s` has the exact opaque-handle token shape `h:<24 base64url chars>`.
 * Used both to decide what to resolve and (defensively) to never re-mint a token.
 * Shape-only — a syntactically valid token that was never minted simply won't
 * resolve (resolveHandle returns null).
 */
export function isHandle(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.startsWith(HANDLE_PREFIX) &&
    TOKEN_BODY_RE.test(s.slice(HANDLE_PREFIX.length))
  );
}

/** Generate a fresh unguessable token `h:<base64url(18 random bytes)>`. */
function newToken(): string {
  return HANDLE_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Mint an opaque handle for a withheld CUI value within a conversation.
 * Seals the value at rest (vault) and stores it keyed by an unguessable token;
 * returns the TOKEN (safe to hand the model — it carries no CUI).
 *
 * `ceiling` is the data-classification CEILING the value was WITHHELD under at mint
 * time (e.g. "CUI"). It is persisted and returned by {@link resolveHandle} so the
 * agent loop can re-gate a RESOLVING turn at ≥ this ceiling (C1 fix) — a value
 * withheld at a HIGH ceiling can never be resolved-and-echoed under a LOWER per-turn
 * ceiling. It carries no CUI (just the level string).
 *
 * The token is generated client-side and inserted with a UNIQUE constraint on
 * `token`; a collision at 144 bits is astronomically unlikely, but if Prisma ever
 * reports a unique violation we retry once with a fresh token.
 */
export async function mintHandle(
  conversationId: string,
  value: string,
  meta: HandleMeta,
  ceiling: ClassificationLevel,
): Promise<string> {
  const valueEnc = sealSecret(value); // CUI sealed BEFORE it touches the DB.
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = newToken();
    try {
      await prisma.egressHandle.create({
        data: {
          conversationId,
          token,
          valueEnc,
          entityType: meta.entityType,
          fieldName: meta.fieldName,
          ceiling,
        },
      });
      return token;
    } catch (e) {
      // P2002 = unique constraint (token collision) → retry once with a new token.
      if (attempt === 0 && (e as { code?: string })?.code === "P2002") continue;
      throw e;
    }
  }
  // Unreachable in practice (collision twice at 144 bits); satisfy the type checker.
  throw new Error("mintHandle: failed to allocate a unique token");
}

/** A successfully-resolved handle: the real value + the ceiling it was minted under. */
export interface ResolvedHandle {
  value: string;
  /** The mint-time classification ceiling (e.g. "CUI"); null for legacy/unset rows. */
  ceiling: ClassificationLevel | null;
}

/**
 * Resolve a token back to its real value, ENFORCING conversation scope.
 *
 * Returns null (not the value) when:
 *   - the token shape is invalid, OR
 *   - no row matches the token, OR
 *   - the row's conversationId !== the caller's conversationId (SCOPE CHECK — the
 *     cross-conversation / cross-tenant boundary), OR
 *   - the sealed value fails to open (tamper / retired key → fail closed).
 *
 * On success returns `{ value, ceiling }` where `ceiling` is the mint-time
 * classification ceiling (C1: the loop re-gates the resolving turn at ≥ this ceiling
 * so a high-ceiling value can never be echoed back under a lower per-turn ceiling).
 *
 * The lookup is `findUnique({ token })` THEN an in-code equality check on
 * conversationId — so a token from conversation A never yields B's value, and the
 * check is constant w.r.t. which conversation asked.
 */
export async function resolveHandle(
  conversationId: string,
  token: string,
): Promise<ResolvedHandle | null> {
  if (!isHandle(token)) return null;
  const row = await prisma.egressHandle.findUnique({ where: { token } });
  if (!row) return null;
  // SCOPE CHECK: the handle only resolves inside the conversation it was minted in.
  if (row.conversationId !== conversationId) return null;
  try {
    const value = openSecret(row.valueEnc);
    return { value, ceiling: (row.ceiling as ClassificationLevel | null) ?? null };
  } catch {
    // Fail closed: an unopenable value is treated as unresolvable (never log it).
    return null;
  }
}

/** Higher-rank of two (possibly-null) ceilings; null is the lowest (adds no floor). */
function maxCeilingOf(
  a: ClassificationLevel | null,
  b: ClassificationLevel | null,
): ClassificationLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return rankOf(b) > rankOf(a) ? b : a;
}

/**
 * Deep-walk tool-call args and substitute every string that is BOTH handle-shaped
 * AND resolves (in this conversation) with its real value. Whole-string match only
 * (a handle embedded inside a larger string is left untouched — no partial
 * injection). Non-matching handle-shaped strings (wrong conversation / fabricated /
 * unopenable) pass through unchanged.
 *
 * Bounded to MAX_RESOLVE_DEPTH levels of object/array nesting. Returns the resolved
 * structure, the COUNT of substitutions (for the AC-4 resolve audit), and the
 * `maxCeiling` = the HIGHEST-rank mint-time ceiling among ALL handles it resolved
 * (null when none resolved, or all resolved rows had a null ceiling). C1 fix: the
 * loop folds `maxCeiling` into the resolving turn's effective gate ceiling so a
 * high-ceiling value can never be resolved-and-echoed under a lower per-turn ceiling.
 * Resolves are done sequentially per node; the arg trees the model produces are tiny.
 */
export async function resolveHandlesDeep(
  input: unknown,
  conversationId: string,
): Promise<{ resolved: unknown; count: number; maxCeiling: ClassificationLevel | null }> {
  let count = 0;
  let maxCeiling: ClassificationLevel | null = null;

  async function walk(node: unknown, depth: number): Promise<unknown> {
    if (depth > MAX_RESOLVE_DEPTH) return node; // bound the recursion (adversarial/cyclic args)

    if (typeof node === "string") {
      if (!isHandle(node)) return node; // not a token → leave it (exact whole-string match)
      const real = await resolveHandle(conversationId, node);
      if (real === null) return node; // wrong conversation / fabricated / unopenable → pass through
      count++;
      maxCeiling = maxCeilingOf(maxCeiling, real.ceiling); // C1: track the highest mint ceiling
      return real.value;
    }

    if (Array.isArray(node)) {
      const out: unknown[] = new Array(node.length);
      for (let i = 0; i < node.length; i++) out[i] = await walk(node[i], depth + 1);
      return out;
    }

    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = await walk(v, depth + 1);
      }
      return out;
    }

    return node; // number / boolean / null / undefined → unchanged
  }

  const resolved = await walk(input, 0);
  return { resolved, count, maxCeiling };
}
