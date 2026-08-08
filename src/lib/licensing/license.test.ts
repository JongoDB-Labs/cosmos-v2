// @vitest-environment node
//
// The environment half: where a licence comes from, and the property that
// matters most for a mechanism shipped ahead of the business model — that
// nothing already in the field changes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPluginEntitled, licenseStatus, resetLicenseCache } from "./license";
import { signingInput, ANY } from "./entitlement";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "pem" }).toString();

function mint(over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const c = {
    v: 1,
    lid: "lic-1",
    orgId: "org-1",
    instance: ANY,
    plugins: ["whiteboard"],
    iat: now - 60,
    exp: now + 86_400,
    ...over,
  };
  const payload = Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
  const sig = sign(null, signingInput(payload), privateKey).toString("base64url");
  return `cosmos-lic.v1.${payload}.${sig}`;
}

const ENV_KEYS = [
  "COSMOS_LICENSE",
  "COSMOS_LICENSE_FILE",
  "COSMOS_LICENSE_PUBLIC_KEY",
  "COSMOS_INSTANCE",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetLicenseCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLicenseCache();
});

describe("an unlicensed deployment — the state every install is in today", () => {
  it("entitles nothing", () => {
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(false);
  });

  it("says WHY, so an admin is not left guessing", () => {
    const s = licenseStatus();
    expect(s.result.ok).toBe(false);
    if (!s.result.ok) expect(s.result.reason).toBe("no_public_key");
  });

  it("refuses when a key is configured but no licence is installed", () => {
    process.env.COSMOS_LICENSE_PUBLIC_KEY = PUB;
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(false);
  });
});

describe("a licensed deployment", () => {
  beforeEach(() => {
    process.env.COSMOS_LICENSE_PUBLIC_KEY = PUB;
  });

  it("entitles the named org and plugin from COSMOS_LICENSE", () => {
    process.env.COSMOS_LICENSE = mint();
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(true);
    expect(isPluginEntitled("org-2", "whiteboard")).toBe(false);
    expect(isPluginEntitled("org-1", "pi-planning")).toBe(false);
  });

  it("reads a licence from a FILE, so it can be a mounted secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "cosmos-lic-"));
    const path = join(dir, "license.txt");
    writeFileSync(path, `${mint()}\n`);
    process.env.COSMOS_LICENSE_FILE = path;
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(true);
  });

  it("prefers the inline value when both are set", () => {
    process.env.COSMOS_LICENSE = mint({ plugins: ["pi-planning"] });
    process.env.COSMOS_LICENSE_FILE = "/definitely/not/here.txt";
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "pi-planning")).toBe(true);
  });

  it("treats an unreadable licence file as no licence, not as a crash", () => {
    process.env.COSMOS_LICENSE_FILE = "/definitely/not/here.txt";
    resetLicenseCache();
    expect(() => isPluginEntitled("org-1", "whiteboard")).not.toThrow();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(false);
  });

  it("refuses an expired licence", () => {
    const now = Math.floor(Date.now() / 1000);
    process.env.COSMOS_LICENSE = mint({ iat: now - 200_000, exp: now - 100_000 });
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(false);
  });

  it("honours instance binding against COSMOS_INSTANCE", () => {
    process.env.COSMOS_LICENSE = mint({ instance: "alpha" });
    process.env.COSMOS_INSTANCE = "beta";
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(false);

    process.env.COSMOS_INSTANCE = "alpha";
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(true);
  });

  it("accepts a PEM whose newlines were escaped, as env vars often do", () => {
    process.env.COSMOS_LICENSE_PUBLIC_KEY = PUB.replace(/\n/g, "\\n");
    process.env.COSMOS_LICENSE = mint();
    resetLicenseCache();
    expect(isPluginEntitled("org-1", "whiteboard")).toBe(true);
  });
});
