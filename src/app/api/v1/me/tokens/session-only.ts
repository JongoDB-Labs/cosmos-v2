import { headers } from "next/headers";
import { classifyBearer } from "@/lib/auth/bearer";
import { getCurrentUser } from "@/lib/auth/session";
import { ProblemError } from "@/lib/openapi/problem";

/**
 * Personal tokens are managed by a person, in a browser. A token that could
 * list or mint tokens would be a credential that outlives its own revocation,
 * so any Cosmos bearer is refused here, even alongside a valid cookie.
 */
export async function sessionUser() {
  if (classifyBearer((await headers()).get("authorization")) !== null) {
    throw new ProblemError(403, "forbidden", "Tokens are managed from a signed-in browser session, not with a token");
  }
  const user = await getCurrentUser();
  if (!user) throw new ProblemError(401, "unauthorized");
  return user;
}
