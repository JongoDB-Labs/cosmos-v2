import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * A stand-in for login.botframework.com for tests (COSMOS-202 T1): serves the
 * OpenID metadata and key set at BOT_FRAMEWORK_LOGIN_ORIGIN (default origin),
 * and signs tokens the way the Bot Connector does, with knobs to get each part
 * wrong. `fetches` counts key-set downloads.
 */
export function fakeBotFramework(opts: { origin?: string; endorsements?: string[] } = {}) {
  const origin = opts.origin ?? "https://login.botframework.com";
  const mk = (kid: string, endorsements = opts.endorsements ?? ["msteams", "webchat"]) => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return { kid, publicKey, privateKey, endorsements };
  };
  const state = { keys: [mk("k1")], fetches: 0, down: false };

  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (state.down) throw new TypeError("fetch failed");
    if (url === `${origin}/v1/.well-known/openidconfiguration`) {
      return Response.json({ issuer: "https://api.botframework.com", jwks_uri: `${origin}/v1/.well-known/keys`, id_token_signing_alg_values_supported: ["RS256"] });
    }
    if (url === `${origin}/v1/.well-known/keys`) {
      state.fetches++;
      return Response.json({
        keys: state.keys.map((k) => ({ ...(k.publicKey.export({ format: "jwk" }) as object), kid: k.kid, use: "sig", endorsements: k.endorsements })),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  function token(
    claims: Record<string, unknown>,
    o: { kid?: string; alg?: string; key?: KeyObject; nowS?: number } = {},
  ): string {
    const now = o.nowS ?? Math.floor(Date.now() / 1000);
    const k = state.keys.find((x) => x.kid === (o.kid ?? state.keys[0].kid)) ?? state.keys[0];
    const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const head = enc({ alg: o.alg ?? "RS256", typ: "JWT", kid: o.kid ?? k.kid });
    const body = enc({ iss: "https://api.botframework.com", nbf: now - 10, exp: now + 3600, ...claims });
    const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), o.key ?? k.privateKey).toString("base64url");
    return `Bearer ${head}.${body}.${sig}`;
  }

  /** Start signing with a new key (and publish it), as Microsoft does on rotation. */
  function rotate(kid: string) {
    const k = mk(kid);
    state.keys = [k, ...state.keys];
    return k;
  }

  return { origin, fetch, token, rotate, state, mk };
}
