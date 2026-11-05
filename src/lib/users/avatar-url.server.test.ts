import { describe, expect, it } from "vitest";

import { AVATAR_VERSION_LENGTH, avatarSrc, decodeAvatarDataUri } from "./avatar-url.server";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

const dataUri = (body: string) => `data:image/png;base64,${body}`;

describe("avatarSrc", () => {
  it("passes through null, because a user with no avatar has no URL", () => {
    expect(avatarSrc(ORG, USER, null)).toBeNull();
  });

  it("replaces a data: URI with a path to the avatar endpoint", () => {
    const src = avatarSrc(ORG, USER, dataUri("AAAA"));
    expect(src).toMatch(new RegExp(`^/api/v1/orgs/${ORG}/users/${USER}/avatar\\?v=[0-9a-f]+$`));
  });

  it("never returns the data: URI itself — that is the whole point", () => {
    expect(avatarSrc(ORG, USER, dataUri("AAAA"))).not.toContain("data:");
    expect(avatarSrc(ORG, USER, dataUri("AAAA"))).not.toContain("base64");
  });

  it("leaves an absolute http(s) URL alone — it is already cacheable elsewhere", () => {
    expect(avatarSrc(ORG, USER, "https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(avatarSrc(ORG, USER, "http://cdn.example.com/a.png")).toBe("http://cdn.example.com/a.png");
  });

  it("is stable: the same stored avatar yields the same URL", () => {
    expect(avatarSrc(ORG, USER, dataUri("AAAA"))).toBe(avatarSrc(ORG, USER, dataUri("AAAA")));
  });

  it("busts the immutable cache: different bytes yield a different version", () => {
    const a = avatarSrc(ORG, USER, dataUri("AAAA"));
    const b = avatarSrc(ORG, USER, dataUri("BBBB"));
    expect(a).not.toBe(b);
  });

  it("scopes the version to the content, not the user, so two users sharing bytes still get their own path", () => {
    const a = avatarSrc(ORG, USER, dataUri("AAAA"));
    const b = avatarSrc(ORG, "33333333-3333-3333-3333-333333333333", dataUri("AAAA"));
    expect(a).not.toBe(b);
    expect(a?.split("?v=")[1]).toBe(b?.split("?v=")[1]);
  });

  it("keeps the version short enough to stay out of the way", () => {
    const v = avatarSrc(ORG, USER, dataUri("AAAA"))?.split("?v=")[1];
    expect(v).toHaveLength(AVATAR_VERSION_LENGTH);
  });
});

describe("decodeAvatarDataUri", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("decodes a png to bytes and its declared type", () => {
    const got = decodeAvatarDataUri(`data:image/png;base64,${b64("PNGBYTES")}`);
    expect(got?.contentType).toBe("image/png");
    expect(Buffer.from(got!.bytes).toString()).toBe("PNGBYTES");
  });

  it("accepts the raster types a browser will render", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(decodeAvatarDataUri(`data:${t};base64,${b64("x")}`)?.contentType).toBe(t);
    }
  });

  it("REFUSES svg — it can carry script, and we serve from our own origin", () => {
    expect(decodeAvatarDataUri(`data:image/svg+xml;base64,${b64("<svg onload=alert(1)>")}`)).toBeNull();
  });

  it("REFUSES anything that is not an allowlisted image, however it is dressed up", () => {
    for (const t of ["text/html", "application/javascript", "text/plain", "image/png2", "imagex/png"]) {
      expect(decodeAvatarDataUri(`data:${t};base64,${b64("x")}`)).toBeNull();
    }
  });

  it("REFUSES a non-base64 data URI rather than guessing at the encoding", () => {
    expect(decodeAvatarDataUri("data:image/png,rawbytes")).toBeNull();
  });

  it("returns null for malformed input instead of throwing", () => {
    for (const s of ["", "data:", "data:image/png;base64", "notadatauri", "https://x/a.png"]) {
      expect(decodeAvatarDataUri(s)).toBeNull();
    }
  });
});
