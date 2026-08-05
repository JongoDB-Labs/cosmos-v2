import { afterEach, describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import {
  NEUTRAL_PDF_PALETTE,
  derivePdfPalette,
  resolvePdfLogo,
  resolvePdfPalette,
  toPdfColor,
} from "./brand";
import { generateContractPdf } from "./contract";
import { generateAuditLogPdf } from "./audit-log";

// A 1x1 transparent PNG — the smallest thing pdfkit will actually embed.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * pdfkit's own colour parser. Anything it returns null for is silently ignored
 * by fillColor/strokeColor — the document keeps whatever colour was last set —
 * so "pdfkit understands this string" is the real acceptance bar for a palette
 * value, not "it looks like a colour".
 */
function pdfkitUnderstands(value: string): boolean {
  const doc = new PDFDocument() as unknown as {
    _normalizeColor(v: string): number[] | null;
  };
  return doc._normalizeColor(value) !== null;
}

describe("toPdfColor", () => {
  it("passes through 6-digit hex", () => {
    expect(toPdfColor("#214144")).toBe("#214144");
  });

  it("expands 3-digit hex", () => {
    expect(toPdfColor("#ccc")).toBe("#cccccc");
  });

  it("converts space-separated rgb() to hex", () => {
    expect(toPdfColor("rgb(33 65 68)")).toBe("#214144");
  });

  it("converts comma-separated rgb() to hex", () => {
    expect(toPdfColor("rgb(33, 65, 68)")).toBe("#214144");
  });

  // The skin token this exists for: a slash-alpha border. Flattened onto white
  // because a PDF page is white paper — pdfkit has no alpha channel here.
  it("flattens slash-alpha rgb() onto white", () => {
    expect(toPdfColor("rgb(33 65 68 / 0.14)")).toBe("#e0e4e5");
  });

  it("flattens rgba() onto white", () => {
    expect(toPdfColor("rgba(33, 65, 68, 0.14)")).toBe("#e0e4e5");
  });

  it("returns null for colour syntax pdfkit cannot use", () => {
    expect(toPdfColor("oklch(0.5 0.1 200)")).toBeNull();
    expect(toPdfColor("color-mix(in srgb, red, blue)")).toBeNull();
    expect(toPdfColor("var(--text)")).toBeNull();
    expect(toPdfColor("not-a-colour")).toBeNull();
    expect(toPdfColor("")).toBeNull();
    expect(toPdfColor(null)).toBeNull();
    expect(toPdfColor(undefined)).toBeNull();
  });

  // The whole point of the function: never hand pdfkit something it drops.
  it("only ever returns values pdfkit can parse", () => {
    for (const css of [
      "#214144",
      "#ccc",
      "rgb(33 65 68)",
      "rgb(33, 65, 68)",
      "rgb(33 65 68 / 0.14)",
      "rgba(33, 65, 68, 0.14)",
    ]) {
      const out = toPdfColor(css);
      expect(out).not.toBeNull();
      expect(pdfkitUnderstands(out as string)).toBe(true);
    }
  });

  it("proves the guard is load-bearing — pdfkit drops raw rgb() itself", () => {
    expect(pdfkitUnderstands("rgb(33 65 68 / 0.14)")).toBe(false);
    expect(pdfkitUnderstands("rgb(33, 65, 68)")).toBe(false);
  });
});

describe("derivePdfPalette", () => {
  const PRINT_SAFE = {
    "--text": "#214144",
    "--text-muted": "#61655f",
    "--primary": "#1a3134",
    "--border": "rgb(33 65 68 / 0.14)",
  };

  it("derives text roles from the skin's light tokens", () => {
    const p = derivePdfPalette(PRINT_SAFE);
    expect(p.body).toBe("#214144");
    expect(p.strong).toBe("#1a3134");
    expect(p.meta).toBe("#61655f");
  });

  it("normalises the border token into something pdfkit accepts", () => {
    const p = derivePdfPalette(PRINT_SAFE);
    expect(p.rule).toBe("#e0e4e5");
    expect(pdfkitUnderstands(p.rule)).toBe(true);
  });

  it("derives faint as a lighter step of muted, not a repeat of it", () => {
    const p = derivePdfPalette(PRINT_SAFE);
    expect(p.faint).not.toBe(p.meta);
    expect(pdfkitUnderstands(p.faint)).toBe(true);
  });

  // A skin whose light tokens are light-on-dark would print as near-invisible
  // text on white paper. Better to lose the brand than to ship an unreadable
  // contract.
  it("falls back to neutral when body text would be illegible on white", () => {
    const p = derivePdfPalette({
      "--text": "#f4f1ea",
      "--text-muted": "#e8e9ea",
      "--primary": "#f9f7f4",
      "--border": "#cfcfc8",
    });
    expect(p).toEqual(NEUTRAL_PDF_PALETTE);
  });

  it("falls back to neutral when tokens are missing entirely", () => {
    expect(derivePdfPalette({})).toEqual(NEUTRAL_PDF_PALETTE);
  });

  it("keeps type in one place rather than scattered literals", () => {
    const p = derivePdfPalette(PRINT_SAFE);
    expect(p.fontRegular).toBe("Helvetica");
    expect(p.fontBold).toBe("Helvetica-Bold");
    expect(p.fontMono).toBe("Courier");
  });
});

describe("resolvePdfPalette", () => {
  it("is neutral for no org", () => {
    expect(resolvePdfPalette(null)).toEqual(NEUTRAL_PDF_PALETTE);
    expect(resolvePdfPalette(undefined)).toEqual(NEUTRAL_PDF_PALETTE);
  });

  it("is neutral for an org that has chosen no skin", () => {
    expect(resolvePdfPalette({ defaultSkinId: null })).toEqual(NEUTRAL_PDF_PALETTE);
    expect(resolvePdfPalette({ brandName: "Acme" })).toEqual(NEUTRAL_PDF_PALETTE);
  });

  it("adopts the skin an org has actually chosen", () => {
    const p = resolvePdfPalette({ defaultSkinId: "atelier" });
    expect(p).not.toEqual(NEUTRAL_PDF_PALETTE);
    for (const c of [p.strong, p.body, p.meta, p.faint, p.rule]) {
      expect(pdfkitUnderstands(c)).toBe(true);
    }
  });

  // Every shipped skin has to survive the print path, not just the one we care
  // about — a palette that silently degrades to neutral is a bug, not a fallback.
  it("produces pdfkit-safe colours for every shipped skin", () => {
    for (const id of ["universe", "atelier", "field", "ledger", "clinical", "studio"]) {
      const p = resolvePdfPalette({ defaultSkinId: id });
      for (const c of [p.strong, p.body, p.meta, p.faint, p.rule]) {
        expect(pdfkitUnderstands(c), `${id}: ${c}`).toBe(true);
      }
    }
  });
});

describe("resolvePdfLogo", () => {
  it("decodes an inline PNG data URL", () => {
    const buf = resolvePdfLogo(`data:image/png;base64,${PNG_1X1}`);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.subarray(1, 4).toString()).toBe("PNG");
  });

  it("accepts inline JPEG", () => {
    // JPEG SOI marker is enough to prove the mime branch is taken.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    expect(resolvePdfLogo(`data:image/jpeg;base64,${jpeg}`)).toBeInstanceOf(Buffer);
  });

  // The security boundary. logoUrl is validated as "http(s) or data:image" and
  // is otherwise only ever handed to a browser; fetching it server-side would
  // turn an org-admin text field into an SSRF primitive against the instance.
  it("never fetches a remote logo", () => {
    expect(resolvePdfLogo("https://example.com/logo.png")).toBeNull();
    expect(resolvePdfLogo("http://169.254.169.254/latest/meta-data/")).toBeNull();
  });

  it("rejects image types pdfkit cannot draw", () => {
    const svg = Buffer.from("<svg/>").toString("base64");
    expect(resolvePdfLogo(`data:image/svg+xml;base64,${svg}`)).toBeNull();
    expect(resolvePdfLogo(`data:image/webp;base64,${PNG_1X1}`)).toBeNull();
  });

  it("returns null rather than throwing on junk", () => {
    expect(resolvePdfLogo("data:image/png;base64,!!!not-base64!!!")).toBeNull();
    expect(resolvePdfLogo("data:text/html;base64,PGgxPmhpPC9oMT4=")).toBeNull();
    expect(resolvePdfLogo("")).toBeNull();
    expect(resolvePdfLogo(null)).toBeNull();
    expect(resolvePdfLogo(undefined)).toBeNull();
  });

  it("refuses an oversized inline logo", () => {
    const huge = Buffer.alloc(400_000, 0).toString("base64");
    expect(resolvePdfLogo(`data:image/png;base64,${huge}`)).toBeNull();
  });
});

// AC: "a branded org and an unbranded org produce different output".
//
// A PDF embeds a creation timestamp, so two runs differ regardless of brand and
// a bare inequality assertion would pass even if brand were ignored completely.
// Freezing the clock removes that, and asserting the UNBRANDED pair is
// byte-identical proves the freeze worked — so the branded inequality means the
// brand, and only the brand.
describe("generated documents reflect the org's brand", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function freeze() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  }

  const CONTRACT = {
    title: "Services Agreement",
    partyName: "Acme",
    partyEmail: "ops@example.com",
    value: 1000,
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: new Date("2026-06-01T00:00:00.000Z"),
    body: "Terms.",
    signedAt: null,
  };

  const AUDIT_INPUT = {
    orgName: "Acme",
    exportedBy: "ops@example.com",
    exportedAt: new Date("2026-01-01T00:00:00.000Z"),
    filters: {},
    fullCount: 1,
    truncated: false,
    rows: [
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        seq: 1n,
        userId: "u1",
        userLabel: "ops@example.com",
        action: "update",
        entity: "Contract",
        entityId: "c1",
        ipAddress: "10.0.0.1",
        metadata: { field: "value" },
      },
    ],
  };

  const AUDIT_INTEGRITY = {
    sha256: "a".repeat(64),
    minSeq: "1",
    maxSeq: "1",
    tailRowHash: "b".repeat(64),
    signature: null,
    signatureAlgo: "unsigned",
  };

  it("contract: same input twice is byte-identical under a frozen clock", async () => {
    freeze();
    const a = await generateContractPdf(CONTRACT);
    const b = await generateContractPdf(CONTRACT);
    expect(a.equals(b)).toBe(true);
  });

  it("contract: a branded org differs from an unbranded one", async () => {
    freeze();
    const plain = await generateContractPdf(CONTRACT);
    const branded = await generateContractPdf({
      ...CONTRACT,
      brand: { defaultSkinId: "atelier" },
    });
    expect(branded.equals(plain)).toBe(false);
  });

  it("contract: an org logo changes the document", async () => {
    freeze();
    const plain = await generateContractPdf(CONTRACT);
    const withLogo = await generateContractPdf({
      ...CONTRACT,
      brand: { logoUrl: `data:image/png;base64,${PNG_1X1}` },
    });
    expect(withLogo.equals(plain)).toBe(false);
  });

  it("contract: a remote logo URL leaves the document untouched", async () => {
    freeze();
    const plain = await generateContractPdf(CONTRACT);
    const remote = await generateContractPdf({
      ...CONTRACT,
      brand: { logoUrl: "https://example.com/logo.png" },
    });
    expect(remote.equals(plain)).toBe(true);
  });

  it("audit log: same input twice is byte-identical under a frozen clock", async () => {
    freeze();
    const a = await generateAuditLogPdf(AUDIT_INPUT, AUDIT_INTEGRITY);
    const b = await generateAuditLogPdf(AUDIT_INPUT, AUDIT_INTEGRITY);
    expect(a.equals(b)).toBe(true);
  });

  it("audit log: a branded org differs from an unbranded one", async () => {
    freeze();
    const plain = await generateAuditLogPdf(AUDIT_INPUT, AUDIT_INTEGRITY);
    const branded = await generateAuditLogPdf(
      { ...AUDIT_INPUT, brand: { defaultSkinId: "atelier" } },
      AUDIT_INTEGRITY,
    );
    expect(branded.equals(plain)).toBe(false);
  });

  // The zero-plugin build passes no brand at all; that path must keep working.
  it("both generators still work with no brand supplied", async () => {
    freeze();
    await expect(generateContractPdf(CONTRACT)).resolves.toBeInstanceOf(Buffer);
    await expect(
      generateAuditLogPdf(AUDIT_INPUT, AUDIT_INTEGRITY),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
