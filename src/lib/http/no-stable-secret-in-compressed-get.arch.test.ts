// No GET route returns a stable secret in its body.
//
// Raised by an automated review of `encode zstd gzip` in compose/Caddyfile as a
// BREACH compression side-channel (MEDIUM). BREACH needs three things at once:
// a secret in a COMPRESSED response, attacker-controlled input reflected into
// that SAME response, and the secret staying CONSTANT across many requests so
// response size becomes an oracle to binary-search it.
//
// The third condition is the one this codebase does not meet, and it is not an
// accident -- the routes say so:
//
//   GET  /calendar-feeds  "without their tokens: a token is shown once, at
//                          creation, and never again" -- the select excludes it
//   POST /calendar-feeds  carries the URL once, freshly minted per request
//   GET  /api-keys        "NEVER select `keyHash`"
//   POST /api-keys        plaintext token once, freshly minted per request
//   integrations          secret config fields are sealed into the vault and
//                         never written to the plaintext Integration.config
//   CSRF                  a cookie; `encode` compresses bodies, not headers
//
// An attacker issuing thousands of those POSTs mints thousands of DIFFERENT
// secrets, so there is no oracle. The narrow path exclusions the review
// suggested (`/api/*keys*`, `/api/*token*`) would cost compression on responses
// that carry no secret at all.
//
// That reasoning holds only while it stays true. A future GET that selects a
// long-lived token into its payload would quietly turn the compression win into
// a real side channel, and nothing else in the suite would notice -- which is
// why this is a test and not a comment. It is worth having independently of
// compression: a stable bearer token in a GET body is also something that lands
// in logs, caches and browser history.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codeWithoutComments } from "../arch/code-without-comments";

const API = "src/app/api";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

/** Prisma `select` keys that name long-lived secret material. */
const SECRET_FIELD =
  /\b(token|tokenHash|keyHash|secret|clientSecret|webhookSecret|refreshToken|accessToken|privateKey)\s*:\s*true\b/;

/**
 * The body of a named export.
 *
 * Skips the PARAMETER LIST by paren-matching before brace-counting the body.
 * Counting braces straight from the signature returns 59 characters for
 * `export async function GET(_request: NextRequest, { params }: RouteParams)`
 * -- the destructured `{ params }` opens and closes a brace, so the count
 * reaches zero at the end of the parameter list. Every route here destructures
 * its params, so the rule below scanned a 59-character fragment of each file,
 * found nothing, and the mutation that made the feeds GET select `tokenHash`
 * passed in silence.
 */
function exportBody(src: string, name: string): string | null {
  const sig = `export async function ${name}(`;
  const at = src.indexOf(sig);
  if (at === -1) return null;

  // Walk the parameter list to its closing paren first.
  let parens = 0;
  let i = at + sig.length - 1;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") {
      parens--;
      if (parens === 0) break;
    }
  }

  const open = src.indexOf("{", i);
  if (open === -1) return null;

  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  return src.slice(open);
}

const routes = walk(API).map((file) => ({
  file,
  src: codeWithoutComments(readFileSync(file, "utf8")),
}));

describe("no stable secret in a compressed GET", () => {
  it("found the API routes", () => {
    // Positive control: a moved api/ directory would make this vacuous.
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.some((r) => r.src.includes("export async function GET"))).toBe(true);
  });

  it("extracts a whole GET body, not a fragment of its signature", () => {
    // The control that was missing the first time. Discovery passed and the
    // regex passed, so the suite was green while the step BETWEEN them
    // returned 59 characters and the rule scanned nothing.
    const withGet = routes.filter((r) => r.src.includes("export async function GET"));
    expect(withGet.length).toBeGreaterThan(20);
    const bodies = withGet
      .map((r) => ({ file: r.file, body: exportBody(r.src, "GET") }))
      .filter((b) => b.body !== null);
    expect(bodies.length).toBe(withGet.length);
    // A real handler returns something; a signature fragment cannot.
    expect(bodies.filter((b) => !b.body!.includes("return")).map((b) => b.file)).toEqual([]);
  });

  it("can see a secret field when one is there", () => {
    // Control on the matcher itself, so a typo in SECRET_FIELD cannot read as
    // "no offenders". POST /api-keys legitimately returns a freshly minted
    // token, which is exactly the shape the GET rule below forbids.
    expect(SECRET_FIELD.test("select: { token: true, id: true }")).toBe(true);
    expect(SECRET_FIELD.test("select: { id: true, name: true }")).toBe(false);
  });

  it("no GET handler selects a long-lived secret into its response", () => {
    const offenders: string[] = [];
    for (const { file, src } of routes) {
      const get = exportBody(src, "GET");
      if (!get) continue;
      const m = get.match(SECRET_FIELD);
      if (m) offenders.push(`${file} → GET selects \`${m[1]}\``);
    }
    expect(offenders).toEqual([]);
  });
});
