/**
 * An outside program-management dashboard shown inside the Program Management
 * page, in place of the built-in roll-up, for as long as
 * `PROGRAM_MANAGEMENT_EMBED_URL` is set.
 *
 * It is a stopgap: the built-in page is where program work is meant to live,
 * and it comes back the moment the variable is unset. Nothing about the
 * outside dashboard is named in code -- this is core, and which dashboard an
 * instance shows is that instance's configuration.
 *
 * Read by TWO callers that must agree, which is why it is one function rather
 * than two `process.env` reads:
 *   - the page, which renders the frame, and
 *   - `src/lib/security/headers.ts`, which adds the origin to `frame-src`.
 * A page that renders a frame the CSP refuses shows an empty box and one
 * console line, which is the failure this module exists to make impossible.
 *
 * The dashboard must be on the SAME SITE as Cosmos (same registrable domain,
 * e.g. both under example.com) for a signed-in session to show in the frame.
 * Browsers do not send a SameSite=Lax cookie -- the common default for a
 * session -- to a frame whose page is on another site, so a dashboard on a
 * different domain shows its sign-in page in the frame however often the user
 * signs in. Measured, not assumed: signed in, the dashboard opened fine in its
 * own tab and showed its sign-in page in the frame. The fixes are outside this
 * code: serve Cosmos from a hostname on the dashboard's domain, or have the
 * dashboard mark its session cookie `SameSite=None; Secure`.
 *
 * Deliberately server-only (no `NEXT_PUBLIC_` prefix): the value is not a
 * secret, but an instance's private tooling has no business in a client
 * bundle that is built once and published for every instance.
 */

/**
 * The configured dashboard URL, or null when unset or unusable.
 *
 * https only -- a framed page over plain http is readable and rewritable by
 * anyone on the path -- except loopback, so it can be tried against a local
 * copy. A URL carrying credentials is refused rather than stripped: it would
 * put them in the page's HTML for every viewer.
 */
export function programManagementEmbedUrl(
  raw: string | undefined = process.env.PROGRAM_MANAGEMENT_EMBED_URL,
): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Malformed: fall back to the built-in page rather than breaking it.
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  return null;
}

/**
 * Where the sign-in window opens: `PROGRAM_MANAGEMENT_SIGN_IN_URL` when it is
 * on the dashboard's own origin, otherwise the dashboard URL itself.
 *
 * Optional. Opening the dashboard's own sign-in start (e.g. its `/auth/start`)
 * skips its sign-in PAGE, so the window goes straight to the identity provider
 * and, for someone already signed in there, finishes without a click. Left
 * unset, the window opens the dashboard and the person clicks its own button.
 *
 * Same-origin only: the window is opened by Cosmos, and a value pointing
 * anywhere else would make this page a launcher for an arbitrary site.
 */
export function programManagementSignInUrl(
  rawSignIn: string | undefined = process.env.PROGRAM_MANAGEMENT_SIGN_IN_URL,
  rawEmbed: string | undefined = process.env.PROGRAM_MANAGEMENT_EMBED_URL,
): URL | null {
  const embed = programManagementEmbedUrl(rawEmbed);
  if (!embed) return null;
  const signIn = programManagementEmbedUrl(rawSignIn);
  return signIn && signIn.origin === embed.origin ? signIn : embed;
}

/**
 * Where to send someone who opened Program Management at an address where the
 * dashboard can never be signed in, or null to stay where they are.
 *
 * Measured on prod 2026-11-11: an instance served at two addresses (an old and
 * a new domain, mid-move) showed the signed-in dashboard at the address on the
 * dashboard's site, and the dashboard's sign-in page at the other: same
 * browser, a minute apart. A SameSite=Lax session cookie only reaches a frame
 * on the same site as the page around it. At the other address every sign-in
 * succeeds in its window and the frame asks again: a loop with no way out from
 * inside it.
 *
 * `COSMOS_SITE_ADDRESS` lists the addresses Caddy serves this instance at
 * (compose/Caddyfile), and the app reads the same env file. Only an address
 * from that list is ever a target, so this is not an open redirect. The target
 * is on the dashboard's site, so it never redirects again.
 */
export function programManagementSameSiteOrigin(
  currentOrigin: string,
  rawEmbed: string | undefined = process.env.PROGRAM_MANAGEMENT_EMBED_URL,
  rawAddresses: string | undefined = process.env.COSMOS_SITE_ADDRESS,
): string | null {
  const embed = programManagementEmbedUrl(rawEmbed);
  if (!embed) return null;
  let here: URL;
  try {
    here = new URL(currentOrigin);
  } catch {
    return null;
  }
  if (sameSite(here, embed)) return null;
  return siteAddresses(rawAddresses).find((address) => sameSite(address, embed))?.origin ?? null;
}

/**
 * Caddy's site-address list: separated by commas or spaces (quotes from an env
 * file tolerated), scheme optional and https when absent. A port-only entry
 * (":80") or a wildcard names no host to send anyone to, so it is skipped.
 * No scheme filter here: a target must be same-site with the dashboard,
 * scheme included, and the dashboard is https or loopback http, so plain http
 * to a real host can never qualify.
 */
function siteAddresses(raw: string | undefined): URL[] {
  const out: URL[] = [];
  for (const token of (raw ?? "").split(/[\s,"']+/)) {
    if (!token || token.startsWith(":") || token.includes("*")) continue;
    try {
      out.push(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : `https://${token}`));
    } catch {
      // Not an address.
    }
  }
  return out;
}

/**
 * Schemeful same-site, the test a browser applies before sending a Lax cookie
 * to a frame.
 *
 * The registrable domain is approximated by the last two labels, with no
 * public-suffix list. That can only err one way: two hosts under a multi-label
 * suffix (a.example.co.uk, b.other.co.uk) look same-site when they are not.
 * Hosts that really share a registrable domain always share its last two
 * labels, so a same-site pair is never mistaken for a cross-site one. The
 * error therefore means "no redirect", today's behaviour, and never a loop.
 */
function sameSite(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && siteOf(a.hostname) === siteOf(b.hostname);
}

function siteOf(hostname: string): string {
  // An IP address or a single-label host (localhost) is a site of its own.
  if (hostname.startsWith("[") || /^\d+(\.\d+){3}$/.test(hostname) || !hostname.includes(".")) {
    return hostname;
  }
  return hostname.split(".").slice(-2).join(".");
}

/** The dashboard's ORIGIN, for `frame-src`. A CSP source is host-scoped. */
export function programManagementEmbedOrigin(
  raw: string | undefined = process.env.PROGRAM_MANAGEMENT_EMBED_URL,
): string | null {
  return programManagementEmbedUrl(raw)?.origin ?? null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
