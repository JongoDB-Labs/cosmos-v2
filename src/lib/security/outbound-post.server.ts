/**
 * Send to a URL someone outside Cosmos chose: a webhook (POST), Cosmo's
 * fetch_url (GET), or an endpoint an org admin configured (Jira, an
 * OpenAI-compatible model endpoint), without letting that URL reach anything
 * inside the network Cosmos runs in.
 *
 * Checking a URL's text when it is saved isn't enough: a public name can
 * resolve to a private address, today or after its DNS changes, and a public
 * endpoint can redirect anywhere. So at send time this:
 *   - refuses cloud metadata host names outright;
 *   - resolves the name and refuses if ANY address it resolves to isn't allowed
 *     (public-address.ts: never link-local or metadata; a private address only
 *     for an admin-configured endpoint inside the operator's
 *     OUTBOUND_ALLOW_PRIVATE_CIDRS);
 *   - connects to the address it checked, not to a second lookup that could
 *     answer differently (DNS rebinding); TLS still verifies the host name;
 *   - never follows a redirect (a 3xx is returned as the result, not followed);
 *   - gives up after `timeoutMs` IN TOTAL: a response that keeps trickling in
 *     never resets the clock.
 * Node's http/https with a pinned `lookup`, so no dependency.
 */
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  hostAddress,
  isAllowedOutboundAddress,
  isMetadataHostname,
  isPublicAddress,
  normalizeHostname,
  type OutboundAddressPolicy,
} from "./public-address";

export { isPublicAddress };

const MAX_BODY = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** The URL was not sent, or gave up: why, in words fit for a delivery log. */
export class OutboundRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRefused";
  }
}

export interface OutboundResult {
  status: number;
  /** At most MAX_BODY characters. */
  body: string;
}

export interface DialOptions extends OutboundAddressPolicy {
  /** Overall deadline for the whole exchange, response body included. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tests only: resolve names without DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Tests only: allow a local address, to reach a server the test runs. */
  allowAddress?: (ip: string) => boolean;
}

export interface PostOptions extends DialOptions {
  headers: Record<string, string>;
  body: string;
}

export interface RequestOptions extends Omit<PostOptions, "body"> {
  method: "GET" | "POST";
  body?: string;
  /** Characters of the response kept; MAX_BODY when absent. */
  maxBody?: number;
}

export interface OutboundResponse extends OutboundResult {
  statusText: string;
  headers: http.IncomingHttpHeaders;
  /** The response was longer than `maxBody` and was cut off there. */
  truncated: boolean;
}

const resolveAll = async (hostname: string) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Parse and check `url`, resolve it, and return the address to connect to. */
async function preflight(url: string, opts: DialOptions): Promise<{ target: URL; pinned: string; family: number }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new OutboundRefused("Not a valid URL");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new OutboundRefused("Only http and https URLs are allowed");
  if (target.username || target.password) throw new OutboundRefused("URLs with credentials are not allowed");
  if (isMetadataHostname(target.hostname)) throw new OutboundRefused("Cloud metadata addresses are never allowed");

  const allowed = opts.allowAddress ?? ((ip: string) => isAllowedOutboundAddress(ip, opts));
  const literal = hostAddress(target.hostname);
  const hostname = literal ?? normalizeHostname(target.hostname);
  let addresses: string[];
  if (literal) addresses = [literal];
  else {
    try {
      addresses = await (opts.resolve ?? resolveAll)(hostname);
    } catch {
      throw new OutboundRefused(`Couldn't resolve ${hostname}`);
    }
  }
  if (addresses.length === 0) throw new OutboundRefused(`Couldn't resolve ${hostname}`);
  // Every answer, not just the first: a name that also resolves inside the
  // network is refused outright rather than raced.
  if (!addresses.every(allowed)) throw new OutboundRefused(`${hostname} resolves to an address that isn't public`);
  return { target, pinned: addresses[0], family: isIP(addresses[0]) };
}

interface Dialled {
  response: Promise<http.IncomingMessage>;
  /** Rejects with "Timed out" at the deadline, and destroys the request. */
  deadline: Promise<never>;
  /** Stop the clock: the exchange is over. */
  finish(): void;
}

/** Open the request to the checked address, under one overall deadline. */
function dial(
  target: URL,
  pinned: string,
  family: number,
  init: { method: string; headers: Record<string, string>; body?: string },
  opts: DialOptions,
): Dialled {
  const client = target.protocol === "https:" ? https : http;
  let timer: NodeJS.Timeout | undefined;
  let req: http.ClientRequest | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new OutboundRefused("Timed out");
      reject(err);
      req?.destroy(err);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  // The exchange usually ends first; the deadline must not then surface as an
  // unhandled rejection.
  deadline.catch(() => undefined);
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    req = client.request(
      target,
      {
        method: init.method,
        headers:
          init.body === undefined ? init.headers : { ...init.headers, "Content-Length": Buffer.byteLength(init.body).toString() },
        // Connect to the address checked above, whatever DNS says now.
        lookup: (_host, options, cb) => {
          if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pinned, family }]);
          else cb(null, pinned, family);
        },
        signal: opts.signal,
        agent: false,
      },
      resolve,
    );
    req.on("error", (e) => reject(e instanceof OutboundRefused ? e : new OutboundRefused(e.message)));
    req.end(init.body);
  });
  response.catch(() => undefined);
  return { response, deadline, finish: () => clearTimeout(timer) };
}

/** POST `body` to `url` under the rules above. Throws OutboundRefused when it won't send. */
export async function postToPublicUrl(url: string, opts: PostOptions): Promise<OutboundResult> {
  const { status, body } = await requestPublicUrl(url, { ...opts, method: "POST" });
  return { status, body };
}

/**
 * GET or POST `url` under the rules above and read at most `maxBody`
 * characters of the answer. Throws OutboundRefused when it won't send, or when
 * the deadline passes before the answer is complete.
 */
export async function requestPublicUrl(url: string, opts: RequestOptions): Promise<OutboundResponse> {
  const { target, pinned, family } = await preflight(url, opts);
  const maxBody = opts.maxBody ?? MAX_BODY;
  const call = dial(target, pinned, family, { method: opts.method, headers: opts.headers, body: opts.body }, opts);
  try {
    const read = call.response.then(
      (res) =>
        new Promise<OutboundResponse>((resolve, reject) => {
          let body = "";
          let truncated = false;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
            // Past the cap: keep its start, and stop reading the rest.
            if (body.length > maxBody) {
              truncated = true;
              res.destroy();
            }
          });
          res.on("error", (e) => {
            if (!truncated) reject(e instanceof OutboundRefused ? e : new OutboundRefused(e.message));
          });
          const done = () => {
            // Cut short by anything but our own cap (the deadline, a reset):
            // not an answer.
            if (!res.complete && !truncated) return reject(new OutboundRefused("The response ended early"));
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: res.headers,
              body: body.slice(0, maxBody),
              truncated,
            });
          };
          res.on("end", done);
          res.on("close", done);
        }),
    );
    return await Promise.race([read, call.deadline]);
  } finally {
    call.finish();
  }
}

/**
 * `fetch` for an admin-configured endpoint (or any URL under these rules): the
 * same checks, a pinned connection, no redirects, and an overall deadline that
 * also bounds reading the body. Returns a standard Response whose body
 * streams, so a caller can read server-sent events as they arrive.
 */
export async function fetchPublicUrl(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: DialOptions = {},
): Promise<Response> {
  const { target, pinned, family } = await preflight(url, opts);
  const method = init.method ?? "GET";
  const call = dial(target, pinned, family, { method, headers: init.headers ?? {}, body: init.body }, opts);
  let res: http.IncomingMessage;
  try {
    res = await Promise.race([call.response, call.deadline]);
  } catch (e) {
    call.finish();
    throw e;
  }
  res.on("close", () => call.finish());
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const status = res.statusCode ?? 0;
  // A Response can't carry a body for these, or a status outside 200-599.
  const nullBody = status === 204 || status === 205 || status === 304 || method === "HEAD";
  if (nullBody) res.resume();
  return new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
    status: status >= 200 && status <= 599 ? status : 502,
    statusText: res.statusMessage ?? "",
    headers,
  });
}
