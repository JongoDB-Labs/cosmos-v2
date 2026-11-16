import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sessionRowId } from "@/lib/auth/session-id";

/**
 * Sign a fixture user in the way the app does: store the Session row under
 * `sessionRowId(token)` and return the token, which is what a request carries
 * as its `session` cookie.
 *
 * Specs used to write `prisma.session.create({ data: { id: token, ... } })` and
 * send the same string as the cookie. Rows are now keyed by the hash, so that
 * shape signs nobody in, and a later `findUnique({ where: { id: token } })`
 * finds nothing whether or not the row is there, which would turn every "it
 * was deleted" assertion into a pass. Look a fixture's row up by
 * `sessionRowId(token)` instead.
 *
 * Imported only from specs. `token` defaults to the app's own shape (32 random
 * bytes, hex) and `expiresAt` to a day from now.
 */
export async function createTestSession(
  data: Omit<Prisma.SessionUncheckedCreateInput, "id" | "expiresAt"> & { token?: string; expiresAt?: Date },
): Promise<string> {
  const { token = randomBytes(32).toString("hex"), expiresAt = new Date(Date.now() + 86_400_000), ...row } = data;
  await prisma.session.create({ data: { ...row, expiresAt, id: sessionRowId(token) } });
  return token;
}
