/**
 * Drives the full OIDC round-trip IN-NETWORK against the running stack:
 *   cosmos /api/auth/sso/dextest/login  →  dex authorize  →  dex login POST
 *   →  cosmos /api/auth/sso/dextest/callback  →  assert session cookie.
 *
 * Run inside a container on the compose network (cosmos + dex resolvable by
 * service name). We hit cosmos DIRECTLY at http://cosmos:3000 and set the
 * X-Forwarded-* headers ourselves so getPublicOrigin() computes a stable
 * public origin (http://localhost:8090) that matches dex's registered
 * redirectURI — sidestepping the reverse proxy's port handling.
 *
 * Emits a single JSON line of observed results on stdout (and exits non-zero on
 * a hard failure like a missing session cookie).
 */
const COSMOS = process.env.COSMOS_BASE ?? "http://cosmos:3000";
const FWD_HOST = process.env.FWD_HOST ?? "localhost:8090";
const SLUG = process.env.TEST_ORG_SLUG ?? "dextest";
const USER_EMAIL = process.env.DEX_USER_EMAIL ?? "ssotester@agency.gov";
const USER_PASS = process.env.DEX_USER_PASS ?? "Sup3rTest!";

const fwd = { "x-forwarded-host": FWD_HOST, "x-forwarded-proto": "http" };

// --- tiny cookie jar ---
const jar = new Map();
function storeCookies(res) {
  // Node fetch exposes getSetCookie() for multiple Set-Cookie headers.
  const raw =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [];
  for (const sc of raw) {
    const [pair] = sc.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function step(label, url, opts = {}) {
  const res = await fetch(url, {
    redirect: "manual",
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      cookie: cookieHeader(),
    },
  });
  storeCookies(res);
  console.error(`[drive] ${label}: ${res.status} ${url}`);
  return res;
}

function rewriteToCosmos(absUrl) {
  // Rewrite a public-origin (http://localhost:8090/...) callback URL to hit
  // cosmos directly in-network, preserving path + query.
  const u = new URL(absUrl);
  return `${COSMOS}${u.pathname}${u.search}`;
}

async function main() {
  // 1. login initiation (forwarded headers → redirect_uri uses FWD_HOST)
  const r1 = await step("login", `${COSMOS}/api/auth/sso/${SLUG}/login`, {
    headers: fwd,
  });
  if (r1.status !== 307 && r1.status !== 302)
    throw new Error(`login expected redirect, got ${r1.status}`);
  const authorizeUrl = r1.headers.get("location");
  if (!authorizeUrl?.includes("/dex/auth"))
    throw new Error(`login did not redirect to dex: ${authorizeUrl}`);

  // 2. follow to dex authorize → dex bounces through a few 302s before it
  //    renders the password login form (200 HTML). Follow until we get HTML.
  let cur2 = authorizeUrl;
  let resCur = await step("dex-authorize", cur2);
  for (let i = 0; i < 6 && (resCur.status === 302 || resCur.status === 303); i++) {
    const loc = new URL(resCur.headers.get("location"), cur2).href;
    cur2 = loc;
    resCur = await step(`dex-redirect-${i}`, loc);
  }
  const formActionBase = cur2;
  const formHtml = await resCur.text();

  // 3. extract the form action and POST credentials
  const actionMatch = formHtml.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
  if (!actionMatch) throw new Error("could not find dex login form action");
  // The action is HTML-encoded in the page (&amp; → &); decode before using.
  const actionRaw = actionMatch[1].replace(/&amp;/g, "&");
  const action = new URL(actionRaw, formActionBase).href;
  const body = new URLSearchParams({ login: USER_EMAIL, password: USER_PASS });
  const r3 = await step("dex-login-post", action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  // dex approves (skipApprovalScreen) and redirects (possibly via /approval)
  // until it lands on our callback. Follow redirects within dex; when the
  // Location is our public callback, rewrite to cosmos and stop.
  let loc = r3.headers.get("location");
  let cur = action;
  let callbackHit = null;
  for (let i = 0; i < 6 && loc; i++) {
    const next = new URL(loc, cur).href;
    if (next.includes(`/api/auth/sso/${SLUG}/callback`)) {
      callbackHit = next;
      break;
    }
    const rr = await step(`dex-follow-${i}`, next);
    loc = rr.headers.get("location");
    cur = next;
    if (!loc) {
      // Some dex versions render an auto-submit form to the callback.
      const html = await rr.text();
      const m = html.match(/action="([^"]*callback[^"]*)"/i);
      if (m) callbackHit = new URL(m[1], next).href;
      break;
    }
  }
  if (!callbackHit) throw new Error("never reached the cosmos callback");

  // 4. hit the cosmos callback in-network (forwarded headers + sso_tx cookie)
  const r4 = await step(
    "cosmos-callback",
    rewriteToCosmos(callbackHit),
    { headers: fwd },
  );

  const sessionSet =
    (typeof r4.headers.getSetCookie === "function"
      ? r4.headers.getSetCookie()
      : []
    ).some((c) => c.startsWith("session=")) || jar.has("session");

  const result = {
    ok: sessionSet,
    callbackStatus: r4.status,
    callbackLocation: r4.headers.get("location"),
    sessionCookieSet: sessionSet,
    sessionId: jar.get("session") ? `${jar.get("session").slice(0, 12)}…` : null,
  };
  console.log(JSON.stringify(result));
  if (!sessionSet) process.exit(2);
}

main().catch((e) => {
  console.error("[drive] FAILED:", e.message);
  process.exit(1);
});
