import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stream = vi.fn();
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ stream, put: vi.fn(), delete: vi.fn() }),
}));

// Imported after the mock so the module under test binds the stubbed adapter.
const { loadPdfLogo } = await import("./org-logo");

// A 1x1 transparent PNG — the smallest thing pdfkit will actually embed.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_1X1, "base64");

/** A web stream over `bytes`, delivered in `chunkSize` pieces. */
function streamOf(bytes: Uint8Array, chunkSize = bytes.byteLength): ReadableStream {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

const uploaded = (contentType: string) => ({
  // What the upload route actually writes: a relative app path, NOT a data URL.
  logoUrl: "/api/v1/orgs/org_1/logo?v=3",
  settings: { logoStorageKey: "org_1/branding/logo-3.png", logoContentType: contentType },
});

beforeEach(() => {
  stream.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadPdfLogo", () => {
  it("returns null for no org", async () => {
    await expect(loadPdfLogo(null)).resolves.toBeNull();
    await expect(loadPdfLogo(undefined)).resolves.toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it("decodes an inline data URL without touching storage", async () => {
    const buf = await loadPdfLogo({ logoUrl: `data:image/png;base64,${PNG_1X1}` });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.subarray(1, 4).toString()).toBe("PNG");
    expect(stream).not.toHaveBeenCalled();
  });

  // The regression this module exists for: before it, this returned null and
  // every export silently lost the logo the app was displaying.
  it("reads an uploaded logo out of object storage", async () => {
    stream.mockResolvedValue(streamOf(PNG_BYTES));
    const buf = await loadPdfLogo(uploaded("image/png"));
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.equals(PNG_BYTES)).toBe(true);
    expect(stream).toHaveBeenCalledWith("org_1/branding/logo-3.png");
  });

  it("reassembles a logo delivered in several chunks", async () => {
    stream.mockResolvedValue(streamOf(PNG_BYTES, 7));
    const buf = await loadPdfLogo(uploaded("image/png"));
    expect(buf!.equals(PNG_BYTES)).toBe(true);
  });

  it("accepts JPEG", async () => {
    stream.mockResolvedValue(streamOf(PNG_BYTES));
    await expect(loadPdfLogo(uploaded("image/jpeg"))).resolves.toBeInstanceOf(Buffer);
  });

  // The upload route accepts these; pdfkit cannot embed either. They must be
  // skipped before the read, not after — there is nothing to be gained by
  // pulling bytes we can never draw.
  it.each(["image/svg+xml", "image/webp"])("skips %s, which pdfkit cannot embed", async (ct) => {
    await expect(loadPdfLogo(uploaded(ct))).resolves.toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it("returns null when the org has no stored logo", async () => {
    await expect(loadPdfLogo({ logoUrl: null, settings: {} })).resolves.toBeNull();
    await expect(loadPdfLogo({ settings: null })).resolves.toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it("returns null when the content type was never recorded", async () => {
    await expect(
      loadPdfLogo({ settings: { logoStorageKey: "org_1/branding/logo-3.png" } }),
    ).resolves.toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  // Everything below is the same promise: a logo problem must never fail an
  // export. The document matters; the mark does not.
  it("returns null when the object is missing", async () => {
    stream.mockResolvedValue(null);
    await expect(loadPdfLogo(uploaded("image/png"))).resolves.toBeNull();
  });

  it("swallows a storage error rather than failing the export", async () => {
    stream.mockRejectedValue(new Error("minio unreachable"));
    await expect(loadPdfLogo(uploaded("image/png"))).resolves.toBeNull();
  });

  it("abandons an object larger than the cap", async () => {
    stream.mockResolvedValue(streamOf(Buffer.alloc(3 * 1024 * 1024, 1), 64 * 1024));
    await expect(loadPdfLogo(uploaded("image/png"))).resolves.toBeNull();
  });

  it("returns null for a zero-byte object", async () => {
    stream.mockResolvedValue(streamOf(Buffer.alloc(0)));
    await expect(loadPdfLogo(uploaded("image/png"))).resolves.toBeNull();
  });
});
