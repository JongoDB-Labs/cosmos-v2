import { cookies } from "next/headers";
import { readTabSession, TAB_COOKIE } from "@/lib/integrations/microsoft/teams-app/tab-session.server";

/**
 * The person a tab PAGE is for. Only GET and HEAD reach /teams/tab (the
 * proxy answers 405 to anything else), and the cookie's Path keeps it under
 * /teams/tab, so this is only ever a GET of a tab page.
 */
export async function tabUser() {
  const jar = await cookies();
  return readTabSession(jar.get(TAB_COOKIE)?.value);
}

/** Cosmos's public origin, for links out of the tab (behind the proxy). */
export async function tabOrigin(): Promise<string> {
  const { headers } = await import("next/headers");
  const { getPublicOrigin } = await import("@/lib/auth/public-url");
  return getPublicOrigin(new Request("http://localhost/", { headers: await headers() }));
}
