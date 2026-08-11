// @vitest-environment node
//
// The registry client, driven entirely through an injected fetch.
//
// Two properties here are security properties rather than correctness ones, and
// they are the reason several of these tests exist at all:
//
//   - a registry error body may echo an Authorization header or a token, and
//     the thrown message lands in logs and in an admin-facing panel, so the
//     body must never reach it;
//   - the Referrers endpoint is OCI 1.1 and older registries simply 404 it, so
//     "no release notes" must degrade quietly instead of failing the check that
//     tells an operator an upgrade exists.
import { describe, it, expect, vi } from "vitest";
import {
  parseImageRef,
  parseAuthChallenge,
  listTags,
  resolveDigest,
  listReferrers,
} from "./registry";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("parseImageRef", () => {
  it("splits a private registry reference into host and repository", () => {
    expect(parseImageRef("registry.example.com/cosmos/assembly/alpha")).toEqual({
      host: "registry.example.com",
      name: "cosmos/assembly/alpha",
    });
  });

  it("handles ghcr", () => {
    expect(parseImageRef("ghcr.io/acme/cosmos-v2")).toEqual({
      host: "ghcr.io",
      name: "acme/cosmos-v2",
    });
  });

  it("treats a first segment with no dot or port as Docker Hub, like docker pull", () => {
    expect(parseImageRef("library/alpine").host).toBe("registry-1.docker.io");
    expect(parseImageRef("alpine")).toEqual({ host: "registry-1.docker.io", name: "library/alpine" });
  });

  it("accepts localhost and a host:port", () => {
    expect(parseImageRef("localhost/foo").host).toBe("localhost");
    expect(parseImageRef("localhost:5000/foo").host).toBe("localhost:5000");
  });

  it("tolerates a scheme and trailing slashes rather than producing a broken URL", () => {
    expect(parseImageRef("https://ghcr.io/o/r/")).toEqual({ host: "ghcr.io", name: "o/r" });
  });

  it("throws on input with no repository part instead of 404ing later", () => {
    expect(() => parseImageRef("ghcr.io")).toThrow(/no repository part/);
    expect(() => parseImageRef("   ")).toThrow(/empty image reference/);
  });
});

describe("parseAuthChallenge", () => {
  it("reads realm, service and scope out of a Bearer challenge", () => {
    expect(
      parseAuthChallenge('Bearer realm="https://auth.example.com/token",service="registry",scope="repository:o/r:pull"'),
    ).toEqual({
      realm: "https://auth.example.com/token",
      service: "registry",
      scope: "repository:o/r:pull",
    });
  });

  it("ignores a non-Bearer scheme", () => {
    expect(parseAuthChallenge('Basic realm="x"')).toBeNull();
    expect(parseAuthChallenge(null)).toBeNull();
  });
});

describe("listTags — the v2 token dance", () => {
  it("returns tags from an anonymous registry", async () => {
    const fetchImpl = vi.fn(async () => json({ tags: ["2.276.8", "latest"] })) as unknown as typeof fetch;
    await expect(listTags("ghcr.io/o/r", { fetchImpl })).resolves.toEqual(["2.276.8", "latest"]);
  });

  it("fetches a token when challenged, then retries with it", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/v2/o/r/tags/list") && !(init?.headers as Record<string, string>)?.Authorization) {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="reg"' },
        });
      }
      if (u.startsWith("https://auth.example.com/token")) return json({ token: "TOK" });
      return json({ tags: ["2.276.8"] });
    }) as unknown as typeof fetch;

    await expect(listTags("reg.example.com/o/r", { fetchImpl })).resolves.toEqual(["2.276.8"]);
    // The scope must be requested, or the token comes back with no pull rights.
    expect(calls.some((c) => c.includes("scope=repository%3Ao%2Fr%3Apull"))).toBe(true);
    expect(calls.some((c) => c.includes("service=reg"))).toBe(true);
  });

  it("sends Basic auth to the token endpoint when credentials are configured", async () => {
    let tokenAuth: string | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/tags/list") && !(init?.headers as Record<string, string>)?.Authorization) {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token"' },
        });
      }
      if (u.startsWith("https://auth.example.com/token")) {
        tokenAuth = (init?.headers as Record<string, string>)?.Authorization;
        return json({ access_token: "TOK" });
      }
      return json({ tags: ["1.0.0"] });
    }) as unknown as typeof fetch;

    await listTags("reg.example.com/o/r", { fetchImpl, username: "u", password: "p" });
    expect(tokenAuth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("NEVER puts the response body in the thrown error — it can echo a token", async () => {
    const secret = "Bearer eyJhbGciOi.SUPERSECRET.token";
    const fetchImpl = vi.fn(async () =>
      new Response(`{"errors":[{"message":"denied for ${secret}"}]}`, { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(listTags("reg.example.com/o/r", { fetchImpl })).rejects.toThrow(/HTTP 403/);
    await expect(listTags("reg.example.com/o/r", { fetchImpl })).rejects.not.toThrow(/SUPERSECRET/);
  });

  it("returns [] for a repository with a null tag list, which registries do send", async () => {
    const fetchImpl = vi.fn(async () => json({ tags: null })) as unknown as typeof fetch;
    await expect(listTags("ghcr.io/o/r", { fetchImpl })).resolves.toEqual([]);
  });

  it("drops non-string entries rather than propagating them into version parsing", async () => {
    const fetchImpl = vi.fn(async () => json({ tags: ["1.0.0", 42, null] })) as unknown as typeof fetch;
    await expect(listTags("ghcr.io/o/r", { fetchImpl })).resolves.toEqual(["1.0.0"]);
  });
});

describe("listTags — pagination, which is correctness and not an optimisation", () => {
  // Found against the REAL registry, not in a mock: reading only page one gave a
  // newest release of 2.92.0 for a repo whose newest is 2.276.8. The caller
  // would then have reported "ahead of the registry, no update available"
  // permanently, with nothing logged anywhere.
  const pagedFetch = (pages: Record<string, { tags: string[]; next?: string }>) =>
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const key = Object.keys(pages).find((k) => u.includes(k));
      if (!key) return new Response("", { status: 404 });
      const { tags, next } = pages[key];
      return json({ tags }, next ? { headers: { link: `<${next}>; rel="next"` } } : {});
    }) as unknown as typeof fetch;

  it("follows rel=next until the registry stops offering one", async () => {
    const fetchImpl = pagedFetch({
      "tags/list?n=": { tags: ["2.1.0", "2.2.0"], next: "/v2/o/r/tags/list?last=2.2.0&n=1000" },
      "last=2.2.0": { tags: ["2.276.8"] },
    });
    await expect(listTags("ghcr.io/o/r", { fetchImpl })).resolves.toEqual(["2.1.0", "2.2.0", "2.276.8"]);
  });

  it("absolutises the relative Link path registries actually send", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      return u.includes("last=")
        ? json({ tags: ["2.2.0"] })
        : json({ tags: ["2.1.0"] }, { headers: { link: '</v2/o/r/tags/list?last=2.1.0>; rel="next"' } });
    }) as unknown as typeof fetch;

    await listTags("ghcr.io/o/r", { fetchImpl });
    expect(seen[1]).toBe("https://ghcr.io/v2/o/r/tags/list?last=2.1.0");
  });

  it("THROWS rather than returning a truncated list when the chain will not end", async () => {
    // A partial list is indistinguishable from a complete one to the caller, and
    // answering "no update" from partial data is the whole failure mode.
    const fetchImpl = vi.fn(async () =>
      json({ tags: ["1.0.0"] }, { headers: { link: '</v2/o/r/tags/list?last=loop>; rel="next"' } }),
    ) as unknown as typeof fetch;
    await expect(listTags("ghcr.io/o/r", { fetchImpl })).rejects.toThrow(/truncated tag list/);
  });

  it("ignores a Link header that offers only a previous page", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ tags: ["1.0.0"] }, { headers: { link: '</v2/o/r/tags/list?first=1>; rel="prev"' } }),
    ) as unknown as typeof fetch;
    await expect(listTags("ghcr.io/o/r", { fetchImpl })).resolves.toEqual(["1.0.0"]);
  });
});

describe("resolveDigest", () => {
  it("reads the digest header and accepts index + manifest media types", async () => {
    let accept: string | undefined;
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      accept = (init?.headers as Record<string, string>)?.Accept;
      return new Response("", {
        status: 200,
        headers: { "docker-content-digest": `sha256:${"a".repeat(64)}` },
      });
    }) as unknown as typeof fetch;

    await expect(resolveDigest("ghcr.io/o/r", "2.276.8", { fetchImpl })).resolves.toBe(
      `sha256:${"a".repeat(64)}`,
    );
    expect(accept).toContain("application/vnd.oci.image.index.v1+json");
    expect(accept).toContain("application/vnd.docker.distribution.manifest.list.v2+json");
  });

  it("returns null for an absent tag — a normal answer, not an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(resolveDigest("ghcr.io/o/r", "nope", { fetchImpl })).resolves.toBeNull();
  });

  it("rejects a malformed digest header rather than passing it on as fact", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("", { status: 200, headers: { "docker-content-digest": "not-a-digest" } }),
    ) as unknown as typeof fetch;
    await expect(resolveDigest("ghcr.io/o/r", "t", { fetchImpl })).resolves.toBeNull();
  });
});

describe("listReferrers — release notes without pulling the image", () => {
  it("returns the attached artifacts", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ manifests: [{ artifactType: "application/vnd.cosmos.release-notes", digest: "sha256:x" }] }),
    ) as unknown as typeof fetch;
    const out = await listReferrers("ghcr.io/o/r", "sha256:abc", { fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].artifactType).toBe("application/vnd.cosmos.release-notes");
  });

  it("degrades to [] on a registry that does not implement Referrers (OCI 1.1)", async () => {
    // The whole update check must not fail because notes are unavailable —
    // "an upgrade exists" is the useful part and it does not depend on notes.
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(listReferrers("ghcr.io/o/r", "sha256:abc", { fetchImpl })).resolves.toEqual([]);
  });
});
