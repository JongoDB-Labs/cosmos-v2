/**
 * A read-only OCI/Docker Registry v2 client — enough to answer "what versions
 * exist?" and "what digest is this tag?", and nothing more.
 *
 * SCOPE, DELIBERATELY NARROW. This module can list tags, resolve a digest, and
 * list referrers. It cannot pull, push, delete, or deploy. An update *check* is
 * a read; keeping the client incapable of anything else means a bug here cannot
 * become a write to a production registry.
 *
 * THE REGISTRY IS CONFIGURED, NOT DISCOVERED. The app container has no docker
 * socket and no compose mount, so it cannot learn its own registry at runtime —
 * an operator supplies it. That also means the host here is NOT user input and
 * not attacker-controlled through the request path; it comes from deployment
 * configuration. Callers must keep it that way: never pass a registry host that
 * arrived in an HTTP request.
 *
 * CREDENTIALS ARE RUNTIME-ONLY. Nothing in this module writes credentials to a
 * log, an error message, or a response body. A private registry's username and
 * password come from the environment at runtime; they are never baked into an
 * image layer (the image is signed, published, and may be public — treat its
 * filesystem as world-readable).
 */

/** A registry reference split into the parts the v2 API needs. */
export interface ImageRef {
  /** Registry host, e.g. `registry.example.com` or `ghcr.io`. */
  host: string;
  /** Repository name below the host, e.g. `cosmos/assembly/alpha`. */
  name: string;
}

/**
 * Split `registry.example.com/cosmos/assembly/alpha` into host + name.
 *
 * Uses Docker's own rule for the ambiguous case: the first path segment is a
 * registry host only if it looks like one (contains a dot or a port, or is
 * localhost). `alpine` and `library/alpine` therefore resolve to Docker Hub,
 * matching what `docker pull` does with the same string.
 *
 * Throws on input with no repository part — a caller misconfiguration worth
 * surfacing loudly rather than turning into a confusing 404 later.
 */
export function parseImageRef(ref: string): ImageRef {
  const clean = ref.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!clean) throw new Error("empty image reference");

  const [first, ...rest] = clean.split("/");
  const looksLikeHost = first.includes(".") || first.includes(":") || first === "localhost";

  if (!looksLikeHost) {
    const name = clean.includes("/") ? clean : `library/${clean}`;
    return { host: "registry-1.docker.io", name };
  }
  if (rest.length === 0) throw new Error(`image reference has no repository part: ${ref}`);
  return { host: first, name: rest.join("/") };
}

export interface RegistryOptions {
  /** Optional credentials for a private registry. Runtime-only; never logged. */
  username?: string;
  password?: string;
  /** Per-request timeout. A hung registry must not hold a page open. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge. */
export function parseAuthChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^bearer\b/i.test(header.trim())) return null;
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A registry GET that performs the Bearer token dance when challenged.
 *
 * The v2 protocol answers an anonymous request with 401 plus a challenge naming
 * a token endpoint; you fetch a token (optionally with Basic auth) and retry.
 * GHCR, GitLab and Docker Hub all behave this way, which is why this is written
 * once rather than per-registry.
 */
async function registryGet(
  ref: ImageRef,
  path: string,
  opts: RegistryOptions,
  accept?: string,
): Promise<Response> {
  return registryGetUrl(ref, `https://${ref.host}/v2/${ref.name}${path}`, opts, accept);
}

async function registryGetUrl(
  ref: ImageRef,
  url: string,
  opts: RegistryOptions,
  accept?: string,
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = accept ? { Accept: accept } : {};

  const first = await doFetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (first.status !== 401) return first;

  const challenge = parseAuthChallenge(first.headers.get("www-authenticate"));
  if (!challenge?.realm) return first; // unauthorized with no usable challenge

  const tokenUrl = new URL(challenge.realm);
  if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
  tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${ref.name}:pull`);

  const tokenHeaders: Record<string, string> = {};
  if (opts.username && opts.password) {
    tokenHeaders.Authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
  }
  const tokenRes = await doFetch(tokenUrl.toString(), {
    headers: tokenHeaders,
    signal: AbortSignal.timeout(timeout),
  });
  if (!tokenRes.ok) return first; // keep the ORIGINAL 401 as the reported failure

  const token = (await tokenRes.json().catch(() => null)) as
    | { token?: string; access_token?: string }
    | null;
  const bearer = token?.token ?? token?.access_token;
  if (!bearer) return first;

  return doFetch(url, {
    headers: { ...headers, Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(timeout),
  });
}

/**
 * The `rel="next"` target of an RFC 5988 `Link` header, absolutised against the
 * page it came from. Registries send a path (`</v2/o/r/tags/list?last=x&n=100>`),
 * not a URL.
 */
export function parseNextLink(header: string | null, base: string): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
    if (m) return new URL(m[1], base).toString();
  }
  return null;
}

/** Registries cap page size; asking for more simply gets you their maximum. */
const TAG_PAGE_SIZE = 1000;
/** A backstop against a pathological or hostile `Link` chain, never a quiet cap. */
const MAX_TAG_PAGES = 100;

/**
 * Every tag in a repository, FOLLOWING PAGINATION.
 *
 * Pagination is not an optimisation here, it is correctness. `/tags/list`
 * returns one page — 100 entries on GHCR — plus a `Link: rel="next"` header.
 * Reading only the first page against the real registry returned a newest
 * release of 2.92.0 for a repository whose actual newest is 2.276.8, which is
 * not a small error: the caller compares that list against the running version
 * and would have concluded "this instance is AHEAD of the registry, no update
 * available" permanently, with no error anywhere. Mocked tests cannot catch
 * this; only a real registry call showed it.
 *
 * Hitting the page backstop THROWS rather than returning a partial list. A
 * truncated list is indistinguishable from a complete one to the caller, and
 * silently answering "no update" from partial data is the exact failure this
 * function exists to avoid.
 *
 * Throws on a non-OK response, with the status but NEVER the response body: a
 * registry error body can echo an auth header or a token, and this string ends
 * up in logs and in an admin-facing error panel.
 */
export async function listTags(ref: string | ImageRef, opts: RegistryOptions = {}): Promise<string[]> {
  const parsed = typeof ref === "string" ? parseImageRef(ref) : ref;
  let url = `https://${parsed.host}/v2/${parsed.name}/tags/list?n=${TAG_PAGE_SIZE}`;
  const tags: string[] = [];

  for (let page = 0; page < MAX_TAG_PAGES; page++) {
    const res = await registryGetUrl(parsed, url, opts);
    if (!res.ok) {
      throw new Error(`registry listing failed for ${parsed.host}/${parsed.name}: HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { tags?: unknown } | null;
    if (Array.isArray(body?.tags)) {
      for (const t of body.tags) if (typeof t === "string") tags.push(t);
    }
    const next = parseNextLink(res.headers.get("link"), url);
    if (!next) return tags;
    url = next;
  }

  throw new Error(
    `registry listing for ${parsed.host}/${parsed.name} exceeded ${MAX_TAG_PAGES} pages — refusing to answer from a truncated tag list`,
  );
}

/** Media types a manifest lookup must accept, or a registry returns v1 or 404s. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * The digest a tag currently points at, or null when the tag is absent.
 *
 * Absent is a normal answer — the caller is often asking exactly because it does
 * not know — so it is null rather than a throw.
 */
export async function resolveDigest(
  ref: string | ImageRef,
  tag: string,
  opts: RegistryOptions = {},
): Promise<string | null> {
  const parsed = typeof ref === "string" ? parseImageRef(ref) : ref;
  const res = await registryGet(parsed, `/manifests/${encodeURIComponent(tag)}`, opts, MANIFEST_ACCEPT);
  if (!res.ok) return null;
  const digest = res.headers.get("docker-content-digest");
  return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/** One artifact attached to an image by digest (OCI 1.1 Referrers). */
export interface Referrer {
  artifactType?: string;
  digest: string;
  size?: number;
  annotations?: Record<string, string>;
}

/**
 * Artifacts attached to an image digest — SBOMs, attestations, release notes.
 *
 * This is the addressable answer to "show me the notes for a version I have not
 * installed": a referrer is fetched by digest without pulling the image, is
 * signed independently, and can be amended after the build (an image label
 * cannot — changing it changes the digest).
 *
 * Returns [] rather than throwing when the registry does not implement the
 * endpoint. Referrers is OCI 1.1; a registry that predates it 404s here, and
 * "no notes available" must degrade to a quieter surface, not a failed check.
 * Callers that need notes from such a registry must use the tag-schema fallback.
 */
export async function listReferrers(
  ref: string | ImageRef,
  digest: string,
  opts: RegistryOptions = {},
): Promise<Referrer[]> {
  const parsed = typeof ref === "string" ? parseImageRef(ref) : ref;
  const res = await registryGet(parsed, `/referrers/${encodeURIComponent(digest)}`, opts);
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { manifests?: unknown } | null;
  if (!Array.isArray(body?.manifests)) return [];
  return body.manifests.filter(
    (m): m is Referrer => typeof m === "object" && m !== null && typeof (m as Referrer).digest === "string",
  );
}
