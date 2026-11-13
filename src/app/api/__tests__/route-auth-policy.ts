/**
 * What the "every API route authenticates" sweep
 * (`every-route-authenticates*.db.test.ts`) needs to know beyond the code.
 *
 * Which handlers a caller with no session may reach is NOT listed here: it is
 * src/lib/auth/signed-out-api.ts, the one list the proxy enforces, re-exported
 * below so the sweep reads the same list the proxy does. Every handler not in
 * its PUBLIC_HANDLERS must refuse a caller with no credentials, with a fake
 * API key, and with malformed path values: 401 or 403, a redirect to /login,
 * or a 404 after asking who the caller is.
 */
export { PUBLIC_HANDLERS, SIGNED_OUT_STEPS, PLUGIN_SIGNED_OUT } from "@/lib/auth/signed-out-api";

/**
 * Handlers that refuse by sending the caller to a page of this app other than
 * /login, as `"<METHOD> <path>": { to: "<that exact path>", why: "<reason>" }`.
 * Only a redirect to that exact path on this app's own origin counts as a
 * refusal for that handler; one anywhere else still fails the sweep.
 */
export const REDIRECT_REFUSALS: Readonly<Record<string, { to: string; why: string }>> = {
  "GET v1/slack/oauth/callback": {
    to: "/",
    why: "Slack sends the admin's browser back here. Without the sealed state cookie it can't tell which org the install was for, "
      + "so it sends the caller home before asking who they are, and never trades a code for a token.",
  },
};

/**
 * Handlers known to answer an unidentified caller while a fix is in flight, as
 * `"<METHOD> <path>": "<the change fixing it>"`. Empty is the normal state. The
 * sweep fails when a listed handler starts refusing every caller, so the entry
 * is removed in the change that fixes it.
 */
export const KNOWN_OPEN: Readonly<Record<string, string>> = {};

/**
 * Handlers in route groups composed in from a plugin repository, as
 * `"<METHOD> <path>": "<why it answers, and where it gets fixed>"`, that answer
 * a caller the sweep hasn't identified. The public build composes no plugins,
 * so these only matter in a composed tree, where the sweep covers plugin
 * routes like any other. An entry whose plugin is composed must name a
 * handler that exists, and is removed once the handler refuses every caller.
 */
export const PLUGIN_KNOWN_OPEN: Readonly<Record<string, string>> = {
  "POST (plugin-foreman)/foreman/alert":
    "Public by design: a host watchdog posts with its own bearer token. With no token configured it answers 503 (it refuses a "
    + "wrong token with 401). Fix in the plugin: list it as public there, with a wrong-token test.",
  "PATCH v1/orgs/[orgId]/plugins/(plugin-whiteboard)/whiteboard/boards/[boardId]":
    "Parses the body before its access check (the tier it needs depends on the fields), so a body that isn't JSON answers 500 "
    + "before the caller is identified. Fix in the plugin: identify the caller first, then pick the tier.",
};

/** The `(plugin-<slug>)` route group a path sits in, or null for a core route. */
export const pluginOf = (rel: string): string | null => /(?:^|\/)\(plugin-([^)]+)\)(?:\/|$)/.exec(rel)?.[1] ?? null;

/**
 * Path params the sweep has no row for, and why a 404 on them may still count
 * as a refusal, as `"<param>": "<reason>"`. A 404 proves a refusal only where
 * the path ids point at real rows (route-sweep.ts, NotFoundEvidence), so a
 * handler that answers 404 on an unseeded param fails the sweep until either
 * the sweep seeds a row for it or the param is listed here. Prefer seeding.
 */
export const UNSEEDED_PARAMS: Readonly<Record<string, string>> = {};
