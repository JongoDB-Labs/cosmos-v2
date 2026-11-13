import type { NextRequest } from "next/server";
import { MS_STATE_COOKIE, microsoftAuthorizeUrl, microsoftRedirectUri } from "@/lib/auth/microsoft";
import { getProviderConfig } from "@/lib/auth/provider-config";
import { startConnect } from "@/lib/auth/connect-flow";

/** Connect Microsoft to the signed-in account (Profile, Sign-in methods). */
export async function POST(request: NextRequest) {
  return startConnect(request, "microsoft", {
    stateCookie: MS_STATE_COOKIE,
    authorizeUrl: async (state) => {
      const cfg = await getProviderConfig("microsoft");
      if (!cfg || !cfg.enabled) throw new Error("microsoft sign-in is not configured");
      return microsoftAuthorizeUrl({
        clientId: cfg.clientId,
        tenant: cfg.tenant,
        state,
        redirectUri: microsoftRedirectUri(request),
      });
    },
  });
}
