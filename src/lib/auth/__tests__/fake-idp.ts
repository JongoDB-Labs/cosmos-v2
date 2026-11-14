// A real OIDC identity provider for tests: an HTTP server on 127.0.0.1 that
// serves a discovery document and a token endpoint. 127.0.0.1 is a private
// address, so reaching it needs 127.0.0.0/8 in SSO_ALLOW_PRIVATE_CIDRS; it is
// plain http, so tests also set SSO_ALLOW_INSECURE_ISSUER=1.
import http from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_IDP_CLIENT_ID = "cosmos-test-client";
export const FAKE_IDP_NONCE = "test-nonce";

export interface FakeIdp {
  issuer: string;
  hits: { discovery: number; token: number };
  /** The last token request as it arrived. */
  tokenRequest: { contentType: string; body: URLSearchParams } | null;
  /** The token endpoint the discovery document names (default: this server's). */
  tokenEndpoint: string | null;
  /** Instead of tokens, answer the token request with this status and JSON body. */
  tokenError: { status: number; body: Record<string, unknown> } | null;
  /** Fields that replace the token response's own. */
  tokenExtra: Record<string, unknown> | null;
  reset(): void;
  close(): Promise<void>;
}

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export async function startFakeIdp(): Promise<FakeIdp> {
  const idp = {
    issuer: "",
    hits: { discovery: 0, token: 0 },
    tokenRequest: null,
    tokenEndpoint: null,
    tokenError: null,
    tokenExtra: null,
    reset() {
      idp.hits.discovery = 0;
      idp.hits.token = 0;
      idp.tokenRequest = null;
      idp.tokenEndpoint = null;
      idp.tokenError = null;
      idp.tokenExtra = null;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  } as FakeIdp;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/openid-configuration") {
      idp.hits.discovery++;
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/authorize`,
          token_endpoint: idp.tokenEndpoint ?? `${idp.issuer}/token`,
          jwks_uri: `${idp.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/token") {
      idp.hits.token++;
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (raw += c));
      req.on("end", () => {
        idp.tokenRequest = { contentType: String(req.headers["content-type"] ?? ""), body: new URLSearchParams(raw) };
        if (idp.tokenError) {
          res.writeHead(idp.tokenError.status, { "Content-Type": "application/json" }).end(JSON.stringify(idp.tokenError.body));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        // Signature bytes are never checked for a token-endpoint ID token: TLS
        // stands in for it (OpenID Connect Core 3.1.3.7), and openid-client only
        // fetches the JWKS when non-repudiation checks are enabled.
        const idToken = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({
          iss: idp.issuer,
          aud: FAKE_IDP_CLIENT_ID,
          sub: "idp-subject-1",
          nonce: FAKE_IDP_NONCE,
          iat: now,
          exp: now + 300,
        })}.c2lnbmF0dXJl`;
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken, ...idp.tokenExtra }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return idp;
}
