// The front door's config ships with the release, not from the host.
//
// 2.517.0 added `encode zstd gzip` to compose/Caddyfile. It passed CI, merged,
// tagged, released and DEPLOYED -- and did nothing, because the Caddyfile was
// mounted from the host (`./compose/Caddyfile:/etc/caddy/Caddyfile:ro`) and the
// deploy only rewrites image pins in docker-compose.override.yml. It never
// pulls, fetches or checks out the repo. The compression win had to be applied
// to the host by hand before it took effect.
//
// Syncing the host was not an option either: that checkout was found ~870 PRs
// behind with 456 dirty files, including a modified Caddyfile and an untracked
// .deploy/ full of hand-edited scripts. A `git checkout` there would be
// destructive and unpredictable.
//
// So the config is baked into a digest-pinned, cosign-signed image
// (compose/proxy/Dockerfile) and rides the one path that demonstrably works:
// the deploy already resolves signed digests and pulls runtime, migrate and
// postgres exactly this way. Config now ships with the release and rolls back
// with it.
//
// Re-adding a host mount would restore the silent-drift failure, and nothing
// else in the suite would notice: the app would run, every test would pass, and
// a config change would simply have no effect. Hence this file.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const COMPOSE = "docker-compose.yml";
const DOCKERFILE = "compose/proxy/Dockerfile";
const WORKFLOW = ".github/workflows/release.yml";

type Service = { image?: string; build?: unknown; volumes?: string[] };
const compose = parse(readFileSync(COMPOSE, "utf8")) as {
  services: Record<string, Service>;
};

describe("the proxy config is baked, not mounted", () => {
  it("found the reverse-proxy service", () => {
    // Positive control: a rename would make every rule below vacuous.
    expect(Object.keys(compose.services)).toContain("reverse-proxy");
  });

  it("does not mount a Caddyfile from the host", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      for (const v of svc.volumes ?? []) {
        expect(
          v,
          `${name} mounts a Caddyfile from the host — the deploy cannot ship host files`,
        ).not.toMatch(/Caddyfile/);
      }
    }
  });

  it("builds the proxy from a Dockerfile that copies the Caddyfile in", () => {
    expect(compose.services["reverse-proxy"].build).toBeTruthy();
    const df = readFileSync(DOCKERFILE, "utf8");
    // The COPY is the whole point; without it the image is bare upstream Caddy
    // with no config, and Caddy would serve nothing.
    expect(df).toMatch(/^COPY\s+compose\/Caddyfile\s+\/etc\/caddy\/Caddyfile\s*$/m);
    // Digest-pinned base, as everything else here is.
    expect(df).toMatch(/^FROM\s+caddy@sha256:[0-9a-f]{64}\s*$/m);
  });

  it("bakes no secret into the image", () => {
    // This image is published to a registry that may be public. The Caddyfile is
    // routing plus `{$ENV}` placeholders Caddy resolves at RUNTIME; nothing is
    // substituted at build. Assert the Dockerfile introduces no ENV/ARG at all.
    const df = readFileSync(DOCKERFILE, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean);
    expect(df.filter((l) => /^(ENV|ARG)\b/.test(l))).toEqual([]);
  });

  it("the release publishes and signs the proxy image alongside the others", () => {
    // A baked config only ships if the release actually builds, manifests and
    // signs it. Partial wiring is the realistic failure: the image exists but
    // is unsigned, so the verify gate rejects the release.
    const wf = readFileSync(WORKFLOW, "utf8");
    for (const needle of [
      "PROXY_IMAGE=ghcr.io/$OWNER/${{ matrix.image_base }}-proxy",
      "file: compose/proxy/Dockerfile",
      "/tmp/d/proxy",
      "for kind in runtime migrate postgres proxy; do",
      'verify_one "$PROXY_IMAGE"',
    ]) {
      expect(wf, `release.yml is missing: ${needle}`).toContain(needle);
    }
    // Signed the same way as the rest, by digest.
    expect(wf).toMatch(/cosign sign --yes "\$\{\{ env\.PROXY_IMAGE \}\}@/);
  });
});
