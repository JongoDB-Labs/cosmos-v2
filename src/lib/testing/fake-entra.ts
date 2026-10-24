import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * A stand-in for login.microsoftonline.com's per-tenant OpenID metadata and
 * key set, for tests of Teams SSO (COSMOS-202 T1 d). Signs access tokens the
 * way Entra does, with knobs to get each part wrong. `fetches` counts key-set
 * downloads; `metadataFetches` counts metadata requests (any tenant).
 */
export function fakeEntra(opts: { origin?: string; tid: string; jwksOrigin?: string }) {
  const origin = opts.origin ?? "https://login.microsoftonline.com";
  const mk = (kid: string) => ({ kid, ...generateKeyPairSync("rsa", { modulusLength: 2048 }) });
  const state = { keys: [mk("e1")], fetches: 0, metadataFetches: 0, down: false, redirects: [] as (string | undefined)[] };
  const jwks = `${opts.jwksOrigin ?? origin}/${opts.tid}/discovery/v2.0/keys`;

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    state.redirects.push(init?.redirect);
    if (state.down) throw new TypeError("fetch failed");
    if (url.endsWith("/v2.0/.well-known/openid-configuration")) {
      state.metadataFetches++;
      if (url !== `${origin}/${opts.tid}/v2.0/.well-known/openid-configuration`) return new Response("{}", { status: 400 });
      return Response.json({ issuer: `https://login.microsoftonline.com/${opts.tid}/v2.0`, jwks_uri: jwks });
    }
    if (url === jwks) {
      state.fetches++;
      return Response.json({ keys: state.keys.map((k) => ({ ...(k.publicKey.export({ format: "jwk" }) as object), kid: k.kid, use: "sig" })) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  function token(claims: Record<string, unknown>, o: { kid?: string; alg?: string; key?: KeyObject; nowS?: number } = {}): string {
    const now = o.nowS ?? Math.floor(Date.now() / 1000);
    const k = state.keys.find((x) => x.kid === (o.kid ?? state.keys[0].kid)) ?? state.keys[0];
    const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const head = enc({ alg: o.alg ?? "RS256", typ: "JWT", kid: o.kid ?? k.kid });
    const body = enc({
      iss: `https://login.microsoftonline.com/${opts.tid}/v2.0`, tid: opts.tid, scp: "access_as_user", oid: "oid-1",
      azp: "1fec8e78-bce4-4aaf-ab1b-5451cc387264", // Teams desktop
      nbf: now - 10, exp: now + 3600, ...claims,
    });
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), o.key ?? k.privateKey).toString("base64url")}`;
  }

  function rotate(kid: string) {
    const k = mk(kid);
    state.keys = [k, ...state.keys];
    return k;
  }

  return { origin, fetch, token, rotate, state };
}
