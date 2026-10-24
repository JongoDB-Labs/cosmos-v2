import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { openSecret, sealSecret } from "@/lib/crypto/vault";
import type { AuthContext } from "@/lib/rbac/check";
import { ProblemError } from "./problem";

/**
 * `Idempotency-Key` for POSTs that create something (design §3.5, Stripe's
 * semantics): a client that times out can retry with the same key and get the
 * first answer back, instead of creating the thing twice.
 *
 *  - Scoped to the credential: a key means nothing across tokens or users.
 *  - Same key, different method/path/body: 422 `idempotency_key_reused`.
 *  - Same key while the first request is still running: 409.
 *  - Only a 2xx is kept (sealed, 24 hours) and replayed, marked
 *    `Idempotent-Replayed: true`. A failure keeps nothing, so the client can
 *    fix the request and retry with the same key.
 *  - No header: `run()` as if this module didn't exist.
 */
export const IDEMPOTENCY_HEADER = "idempotency-key";
const TTL_MS = 24 * 60 * 60 * 1000;
const VALID_KEY = /^[\x21-\x7e]{1,255}$/;

export async function idempotent(
  opts: { request: Request; ctx: AuthContext; orgId: string; body: unknown },
  run: () => Promise<Response>,
): Promise<Response> {
  const key = opts.request.headers.get(IDEMPOTENCY_HEADER);
  if (key === null) return run();
  if (!VALID_KEY.test(key)) {
    throw new ProblemError(400, "invalid_request", "Idempotency-Key must be 1–255 printable characters");
  }

  const credential = opts.ctx.credential ? `key:${opts.ctx.credential.keyId}` : `user:${opts.ctx.userId}`;
  const url = new URL(opts.request.url);
  const requestHash = createHash("sha256")
    .update(`${opts.request.method} ${url.pathname}\n${JSON.stringify(opts.body ?? null)}`)
    .digest("hex");

  // Keep the table to a day's worth without a scheduler: a cheap, indexed
  // sweep on roughly one claim in fifty.
  if (Math.random() < 0.02) {
    await prisma.apiIdempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - TTL_MS) } } });
  }

  // Claim the key. skipDuplicates makes a clash a count of 0 rather than a
  // thrown (and logged) unique violation.
  const claim = async () => {
    const { count } = await prisma.apiIdempotencyKey.createMany({
      data: [{ orgId: opts.orgId, credential, key, requestHash }],
      skipDuplicates: true,
    });
    return count === 1
      ? prisma.apiIdempotencyKey.findUniqueOrThrow({ where: { credential_key: { credential, key } }, select: { id: true } })
      : null;
  };

  let row = await claim();
  if (!row) {
    const prior = await prisma.apiIdempotencyKey.findUnique({ where: { credential_key: { credential, key } } });
    if (!prior || prior.createdAt.getTime() < Date.now() - TTL_MS) {
      // Gone, or expired: the key is free again.
      if (prior) await prisma.apiIdempotencyKey.delete({ where: { id: prior.id } }).catch(() => {});
      row = await claim();
      if (!row) throw new ProblemError(409, "conflict", "A request with this Idempotency-Key is still in progress");
    } else if (prior.requestHash !== requestHash) {
      throw new ProblemError(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request");
    } else if (prior.status === null || prior.responseBody === null) {
      throw new ProblemError(409, "conflict", "A request with this Idempotency-Key is still in progress");
    } else {
      const stored = JSON.parse(openSecret(prior.responseBody)) as { contentType: string; body: string };
      return new NextResponse(stored.body, {
        status: prior.status,
        headers: { "Content-Type": stored.contentType, "Idempotent-Replayed": "true" },
      });
    }
  }

  let res: Response;
  try {
    res = await run();
  } catch (e) {
    await prisma.apiIdempotencyKey.delete({ where: { id: row.id } }).catch(() => {});
    throw e;
  }
  if (res.status >= 200 && res.status < 300) {
    const payload = JSON.stringify({
      contentType: res.headers.get("content-type") ?? "application/json",
      body: await res.clone().text(),
    });
    await prisma.apiIdempotencyKey.update({
      where: { id: row.id },
      data: { status: res.status, responseBody: sealSecret(payload) },
    });
  } else {
    await prisma.apiIdempotencyKey.delete({ where: { id: row.id } }).catch(() => {});
  }
  return res;
}
