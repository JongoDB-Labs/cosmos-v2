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

/** The dashboard's ORIGIN, for `frame-src`. A CSP source is host-scoped. */
export function programManagementEmbedOrigin(
  raw: string | undefined = process.env.PROGRAM_MANAGEMENT_EMBED_URL,
): string | null {
  return programManagementEmbedUrl(raw)?.origin ?? null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
