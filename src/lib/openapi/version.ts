/**
 * The API's date version (`Cosmos-API-Version: YYYY-MM-DD`) and the policy
 * around it (design §3.3; the Versioning guide on /developers says the same).
 *
 * - A request may name a version in the header. Without one, it gets the
 *   version its credential was pinned to at mint (`ApiKey.apiVersion`), and a
 *   browser session gets the current one.
 * - Breaking changes ship only behind a new date; additive ones ship any time.
 * - A superseded version stays supported for at least 12 months, announced
 *   with `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers, then
 *   answers 410.
 *
 * Where it's enforced: the proxy refuses a header naming an unknown or retired
 * version and echoes a good one (with `deprecationHeaders`); orgContext and
 * userContext resolve the version each request runs at, pin included, as
 * `apiVersion`, and refuse a credential pinned to a retired one.
 *
 * There is one version today. The plumbing exists so the first breaking change
 * doesn't have to build it under pressure: add its date here, branch on
 * `ctx.apiVersion` in the affected route, and mark the old one deprecated.
 */
export const API_VERSION = "2026-11-01";

export const API_VERSION_HEADER = "Cosmos-API-Version";

interface VersionInfo {
  /** When it was superseded (the Deprecation date). */
  deprecatedAt?: string;
  /** When it stops being served (then 410). */
  sunsetAt?: string;
}

export const SUPPORTED_API_VERSIONS: Record<string, VersionInfo> = {
  [API_VERSION]: {},
};

/** The version a request runs at: the one it named, else its credential's pin, else current. */
export function resolveApiVersion(requested: string | null | undefined, pinned?: string | null): string {
  return requested?.trim() || pinned || API_VERSION;
}

export function isSupportedApiVersion(v: string): boolean {
  return apiVersionRefusal(v) === null;
}

/**
 * Why a version can't be served, or null when it can: a date that was never a
 * version is a 400 (a typo, most likely), one past its sunset is a 410.
 */
export function apiVersionRefusal(v: string): { status: 400 | 410; detail: string } | null {
  const info = Object.hasOwn(SUPPORTED_API_VERSIONS, v) ? SUPPORTED_API_VERSIONS[v] : undefined;
  if (!info) {
    return {
      status: 400,
      detail: `${API_VERSION_HEADER} ${JSON.stringify(v.slice(0, 32))} is not a Cosmos API version. The current one is ${API_VERSION}.`,
    };
  }
  if (info.sunsetAt && Date.parse(info.sunsetAt) <= Date.now()) {
    return { status: 410, detail: `API version ${v} was retired on ${info.sunsetAt.slice(0, 10)}. The current one is ${API_VERSION}.` };
  }
  return null;
}

/** Headers announcing a version's retirement; empty for a current one. */
export function deprecationHeaders(v: string): Record<string, string> {
  const info = SUPPORTED_API_VERSIONS[v];
  if (!info?.deprecatedAt) return {};
  return {
    Deprecation: `@${Math.floor(Date.parse(info.deprecatedAt) / 1000)}`,
    ...(info.sunsetAt && { Sunset: new Date(info.sunsetAt).toUTCString() }),
    Link: `</developers/changelog#${v}>; rel="deprecation"`,
  };
}
