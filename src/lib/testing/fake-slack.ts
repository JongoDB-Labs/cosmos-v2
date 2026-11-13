/**
 * A stand-in for the Slack Web API, for tests: the five methods Slack
 * notifications use (oauth.v2.access, users.lookupByEmail, conversations.open,
 * chat.postMessage, auth.revoke), answering the way Slack does, with HTTP 200
 * and `{ ok: false, error }` for a refusal and 429 with Retry-After for a rate
 * limit. It checks credentials like Slack would: the app's client id and
 * secret for the OAuth exchange, and a bot token it issued and hasn't revoked
 * for everything else. `fail` scripts the next answers of a method.
 */
export interface FakeSlackUser {
  id: string;
  /** The address users.lookupByEmail finds this person by. */
  email: string;
  /** The email on their profile, when Slack's lookup matched another one (an alias). */
  profileEmail?: string;
  confirmed?: boolean;
  deleted?: boolean;
  bot?: boolean;
  teamId?: string;
}

export interface FakeSlackPost {
  token: string;
  channel: string;
  /** The Slack user the channel is a direct message with. */
  user: string | null;
  text: string;
  blocks: unknown[];
  params: Record<string, string>;
}

type Scripted = { status?: number; error?: string; retryAfter?: string };

export function fakeSlack(opts: {
  origin?: string;
  clientId?: string;
  clientSecret?: string;
  team?: { id: string; name: string };
  scopes?: string[];
  enterprise?: boolean;
} = {}) {
  const origin = opts.origin ?? "https://slack.com";
  // A workspace of its own per fake: one Cosmos org per workspace is the rule,
  // and test files share a database.
  const team = opts.team ?? { id: `T${Math.random().toString(36).slice(2, 10).toUpperCase()}`, name: "Fake workspace" };
  const state = {
    clientId: opts.clientId ?? "fake-client-id",
    clientSecret: opts.clientSecret ?? "fake-client-secret",
    team,
    scopes: opts.scopes ?? ["chat:write", "im:write", "users:read", "users:read.email"],
    enterprise: opts.enterprise ?? false,
    users: [] as FakeSlackUser[],
    /** Every method called, in order, with its parameters and token. */
    calls: [] as { method: string; params: Record<string, string>; token: string | null }[],
    posts: [] as FakeSlackPost[],
    issued: [] as string[],
    revoked: new Set<string>(),
    /** Codes the next oauth.v2.access will accept, with the redirect URI each was issued for (undefined = any). */
    codes: new Map<string, string | undefined>(),
    fail: {} as Record<string, Scripted[]>,
  };
  const channels = new Map<string, string>();
  const ok = (body: Record<string, unknown>) => Response.json({ ok: true, ...body });
  const no = (error: string) => Response.json({ ok: false, error });

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const prefix = `${origin}/api/`;
    if (!url.startsWith(prefix) || init?.method !== "POST") return new Response("not found", { status: 404 });
    const method = url.slice(prefix.length);
    const params = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
    const auth = new Headers(init.headers).get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    state.calls.push({ method, params, token: bearer });

    const scripted = state.fail[method]?.shift();
    if (scripted) {
      if (scripted.status && scripted.status !== 200) {
        return new Response(JSON.stringify({ ok: false, error: scripted.error ?? "ratelimited" }), {
          status: scripted.status,
          headers: scripted.retryAfter ? { "Retry-After": scripted.retryAfter } : {},
        });
      }
      return no(scripted.error ?? "internal_error");
    }

    if (method === "oauth.v2.access") {
      const basic = auth?.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString() : "";
      const [id, secret] = basic.split(":").map(decodeURIComponent);
      if (id !== state.clientId || secret !== state.clientSecret) return no("invalid_client");
      if (!state.codes.has(params.code)) return no("invalid_code");
      const wantRedirect = state.codes.get(params.code);
      state.codes.delete(params.code);
      if (wantRedirect !== undefined && wantRedirect !== params.redirect_uri) return no("bad_redirect_uri");
      const token = `xoxb-fake-${state.issued.length + 1}-${Math.random().toString(36).slice(2, 10)}`;
      state.issued.push(token);
      return ok({
        access_token: token, token_type: "bot", scope: state.scopes.join(","), bot_user_id: "UBOT", app_id: "AFAKE",
        team: state.team, enterprise: null, is_enterprise_install: state.enterprise,
      });
    }

    if (!bearer) return no("not_authed");
    if (!state.issued.includes(bearer) || state.revoked.has(bearer)) return no("invalid_auth");

    if (method === "auth.revoke") {
      state.revoked.add(bearer);
      return ok({ revoked: true });
    }
    if (method === "users.lookupByEmail") {
      const u = state.users.find((x) => x.email.toLowerCase() === (params.email ?? "").toLowerCase());
      if (!u) return no("users_not_found");
      return ok({
        user: {
          id: u.id, team_id: u.teamId ?? state.team.id, deleted: !!u.deleted, is_bot: !!u.bot,
          is_email_confirmed: u.confirmed ?? true, profile: { email: u.profileEmail ?? u.email },
        },
      });
    }
    if (method === "conversations.open") {
      const user = params.users;
      if (!user || !state.users.some((x) => x.id === user)) return no("user_not_found");
      const id = `D${user}`;
      channels.set(id, user);
      return ok({ channel: { id } });
    }
    if (method === "chat.postMessage") {
      if (!channels.has(params.channel)) return no("channel_not_found");
      state.posts.push({
        token: bearer, channel: params.channel, user: channels.get(params.channel) ?? null,
        text: params.text ?? "", blocks: params.blocks ? JSON.parse(params.blocks) : [], params,
      });
      return ok({ channel: params.channel, ts: `${Date.now()}.000${state.posts.length}` });
    }
    return no("unknown_method");
  }) as typeof globalThis.fetch;

  return {
    fetch,
    state,
    /** A code Slack would hand back after the admin approves the install. */
    issueCode(redirectUri?: string) {
      const code = `code-${Math.random().toString(36).slice(2, 12)}`;
      state.codes.set(code, redirectUri);
      return code;
    },
    /** Messages each Slack user received. */
    postsTo: (slackUserId: string) => state.posts.filter((p) => p.user === slackUserId),
    callsOf: (method: string) => state.calls.filter((c) => c.method === method),
  };
}
