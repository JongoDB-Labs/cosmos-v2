import type { APIRequestContext } from "@playwright/test";

/**
 * Personal access tokens for specs that exercise the public API as a token
 * holder. Every call rides the signed-in page's session (`page.request`),
 * because minting, listing and revoking tokens are session-only operations.
 */

const origin = (baseURL?: string) => baseURL ?? "http://localhost:3000";

export async function orgIdForSlug(request: APIRequestContext, slug: string): Promise<string> {
  const r = await request.get("/api/v1/orgs");
  if (!r.ok()) throw new Error(`GET /api/v1/orgs: ${r.status()}`);
  const org = ((await r.json()) as { id: string; slug: string }[]).find((o) => o.slug === slug);
  if (!org) throw new Error(`not a member of ${slug}`);
  return org.id;
}

export async function mintToken(
  request: APIRequestContext,
  baseURL: string | undefined,
  input: { orgId: string; name: string; scopes: string[]; expiresIn?: number },
): Promise<{ token: string; id: string }> {
  const r = await request.post("/api/v1/me/tokens", {
    data: { expiresIn: 3600, ...input },
    // The proxy's CSRF check wants a same-origin Origin on a session POST.
    headers: { Origin: origin(baseURL) },
  });
  if (r.status() !== 201) throw new Error(`mint token: ${r.status()} ${await r.text()}`);
  const body = (await r.json()) as { token: string; record: { id: string } };
  return { token: body.token, id: body.record.id };
}

/** Revoke every token of this user named `name` (tests clean up after themselves). */
export async function revokeTokensNamed(
  request: APIRequestContext,
  baseURL: string | undefined,
  name: string,
): Promise<void> {
  const r = await request.get("/api/v1/me/tokens");
  if (!r.ok()) return;
  for (const t of (await r.json()) as { id: string; name: string }[]) {
    if (t.name !== name) continue;
    await request.delete(`/api/v1/me/tokens/${t.id}`, { headers: { Origin: origin(baseURL) } });
  }
}
