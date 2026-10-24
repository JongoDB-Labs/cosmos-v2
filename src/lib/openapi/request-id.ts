/**
 * `X-Request-Id`: one id per request, on every response, so a caller can quote
 * it and an operator can find the matching log line (Stripe's `Request-Id`).
 *
 * The proxy assigns it: it echoes a well-formed inbound value (a caller's or an
 * upstream proxy's own correlation id) and otherwise mints a UUID, then hands
 * it to the route as a request header and sets it on the response. Pure, since
 * the proxy imports it.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/** Echoed only when it is short and plain: it ends up in logs and in error
 *  bodies, so nothing that could break a log line or smuggle markup. */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdFor(inbound: string | null | undefined): string {
  const v = inbound?.trim();
  return v && SAFE_ID.test(v) ? v : crypto.randomUUID();
}

/** The id the proxy assigned to this request, or undefined outside one. */
export function requestIdOf(req: Request | null | undefined): string | undefined {
  const v = req?.headers.get(REQUEST_ID_HEADER);
  return v && SAFE_ID.test(v) ? v : undefined;
}
