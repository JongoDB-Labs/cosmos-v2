import { afterEach, describe, expect, it } from "vitest";
import {
  isLibreOfficeAvailable,
  validateXlsx,
  xlsxToPdf,
  convertDocument,
  LibreOfficeUnavailableError,
  __resetLibreOfficeCacheForTests,
  __setResolvedBinaryForTests,
} from "./libreoffice";

/**
 * These tests exercise binary RESOLUTION and graceful DEGRADATION without
 * assuming LibreOffice is installed. The degraded paths are forced
 * deterministically via __setResolvedBinaryForTests(null) so they assert the
 * SAME way whether or not the host actually has soffice. The "real convert"
 * assertions are guarded behind isLibreOfficeAvailable() so the suite still
 * passes on CI hosts that lack it.
 */

afterEach(() => {
  // Clear any forced/cached resolution between tests so each re-probes fresh.
  __resetLibreOfficeCacheForTests();
});

describe("LibreOffice binary resolution", () => {
  it("never throws during resolution; returns a boolean", async () => {
    const available = await isLibreOfficeAvailable();
    expect(typeof available).toBe("boolean");
  });

  it("memoizes the resolution result (idempotent across calls)", async () => {
    const a = await isLibreOfficeAvailable();
    const b = await isLibreOfficeAvailable();
    expect(a).toBe(b);
  });

  it("reports unavailable when resolution is pinned to null", async () => {
    __setResolvedBinaryForTests(null);
    expect(await isLibreOfficeAvailable()).toBe(false);
  });
});

describe("graceful degradation when unavailable", () => {
  it("validateXlsx returns {ok:false, error:'not_configured'} (never throws)", async () => {
    __setResolvedBinaryForTests(null); // force unavailable
    const res = await validateXlsx(Buffer.from("anything"));
    expect(res).toEqual({ ok: false, error: "not_configured" });
  });

  it("xlsxToPdf throws LibreOfficeUnavailableError when no binary resolves", async () => {
    __setResolvedBinaryForTests(null);
    await expect(xlsxToPdf(Buffer.from("nope"))).rejects.toBeInstanceOf(
      LibreOfficeUnavailableError,
    );
  });

  it("convertDocument throws LibreOfficeUnavailableError when no binary resolves", async () => {
    __setResolvedBinaryForTests(null);
    await expect(
      convertDocument(Buffer.from("nope"), { inputExt: "xlsx", to: "pdf" }),
    ).rejects.toBeInstanceOf(LibreOfficeUnavailableError);
  });
});

describe("real conversion (only when LibreOffice is present)", () => {
  it(
    "converts a minimal real .xlsx to a non-trivial PDF and validates it",
    async () => {
      if (!(await isLibreOfficeAvailable())) {
        // No soffice on this host — the unavailable behavior is covered above.
        return;
      }
      // Build a tiny real workbook with exceljs (already a dependency) so the
      // conversion has valid OOXML to render.
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Sheet1");
      ws.getCell("A1").value = "Cosmos LibreOffice smoke test";
      ws.getCell("A2").value = 42;
      const arr = await wb.xlsx.writeBuffer();
      const xlsx = Buffer.from(arr as ArrayBuffer);

      const pdf = await xlsxToPdf(xlsx);
      expect(pdf.byteLength).toBeGreaterThan(1024);
      // First bytes of a PDF are "%PDF".
      expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");

      const res = await validateXlsx(xlsx);
      expect(res).toEqual({ ok: true });
    },
    // soffice cold-start + two conversions can take well over the 5s default.
    60_000,
  );
});
