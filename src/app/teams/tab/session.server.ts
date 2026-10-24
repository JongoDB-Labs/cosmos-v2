import { cookies } from "next/headers";
import { readTabSession, TAB_COOKIE } from "@/lib/integrations/microsoft/teams-app/tab-session.server";

/**
 * The person a tab PAGE is for. The proxy lets only GET and HEAD reach
 * /teams/tab (405 otherwise), so a page render is a GET; `path` is the page's
 * own route. readTabSession enforces the GET-under-/teams/tab rule itself.
 */
export async function tabUser(path: string) {
  const jar = await cookies();
  return readTabSession({ method: "GET", pathname: path, cookie: jar.get(TAB_COOKIE)?.value });
}

/** Cosmos's public origin, for links out of the tab (behind the proxy). */
export async function tabOrigin(): Promise<string> {
  const { headers } = await import("next/headers");
  const { getPublicOrigin } = await import("@/lib/auth/public-url");
  return getPublicOrigin(new Request("http://localhost/", { headers: await headers() }));
}
