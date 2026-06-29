import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Headless LibreOffice document-conversion service.
 *
 * Cosmos uses this for two things: (1) PDF export of the combined PM-dashboard
 * workbook, and (2) as a *validation oracle* for chart-injected .xlsx files —
 * `buildCombinedWorkbook({ withCharts: true })` rewrites raw OOXML to graft
 * burn's charts into the merged book, and the only trustworthy way to know the
 * result isn't corrupt is to render it. If LibreOffice turns the bytes into a
 * real PDF, the workbook opens; if it can't, we fall back to the chartless file.
 *
 * Everything shells out to `soffice --headless --convert-to`. There are NO new
 * npm dependencies — just node:child_process / node:fs/promises / node:os /
 * node:crypto. Each conversion runs in its own throwaway temp dir AND its own
 * per-call `-env:UserInstallation` profile, which is what makes concurrent
 * conversions safe (LibreOffice otherwise serializes on a single shared profile
 * lock and a second concurrent call would silently no-op).
 */

const execFileAsync = promisify(execFile);

/** Thrown when no LibreOffice binary can be located on the host. */
export class LibreOfficeUnavailableError extends Error {
  constructor(message = "LibreOffice binary not found") {
    super(message);
    this.name = "LibreOfficeUnavailableError";
  }
}

/**
 * Candidate binary locations, probed in order. `LIBREOFFICE_PATH` (env) wins so
 * an operator can pin an exact build; otherwise we try the macOS app bundle
 * (local dev), then the PATH names, then the Debian/Docker absolute path
 * (`apt-get install libreoffice-calc` lands `soffice` at /usr/bin/soffice).
 */
const CANDIDATES = [
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "soffice",
  "libreoffice",
  "/usr/bin/soffice",
] as const;

/**
 * Resolution cache:
 *   undefined → not yet probed
 *   null      → probed, no working binary found (unavailable)
 *   string    → the resolved binary path/name
 */
let resolvedBinary: string | null | undefined;

/** Per-call conversion budget. Big workbooks (burn's 19 tabs) render in seconds. */
const CONVERT_TIMEOUT_MS = 90_000;
/** Cap on captured stdout/stderr (the PDF is read off disk, not stdout). */
const CONVERT_MAX_BUFFER = 64 * 1024 * 1024;
/** A LibreOffice-produced PDF that's at least this big is "real" (not a stub). */
const MIN_VALID_PDF_BYTES = 1024;

/**
 * Probe one candidate by running `<bin> --version`. Returns true if it exits 0
 * and looks like LibreOffice. Uses a short timeout so a hung candidate can't
 * stall the whole resolution.
 */
async function probe(bin: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return /libreoffice/i.test(stdout);
  } catch {
    return false;
  }
}

/**
 * Resolve (and memoize) the LibreOffice binary. Returns the path/name, or null
 * if none of the candidates work on this host. The result is cached for the
 * process lifetime — both the success path and the "unavailable" answer, so we
 * never re-probe a host that hasn't got it.
 */
async function resolveBinary(): Promise<string | null> {
  if (resolvedBinary !== undefined) return resolvedBinary;

  const envPath = process.env.LIBREOFFICE_PATH?.trim();
  const ordered = envPath ? [envPath, ...CANDIDATES] : [...CANDIDATES];

  for (const candidate of ordered) {
    if (await probe(candidate)) {
      resolvedBinary = candidate;
      return resolvedBinary;
    }
  }
  resolvedBinary = null;
  return resolvedBinary;
}

/** Whether a usable LibreOffice binary exists on this host. */
export async function isLibreOfficeAvailable(): Promise<boolean> {
  return (await resolveBinary()) !== null;
}

export interface ConvertOptions {
  /** Extension of the input bytes WITHOUT a dot, e.g. "xlsx". */
  inputExt: string;
  /** LibreOffice target filter/extension, e.g. "pdf". */
  to: string;
}

/**
 * Convert one in-memory document to another format via headless LibreOffice.
 *
 * Writes the input to a private temp dir as `in.<inputExt>`, runs
 * `soffice --headless -env:UserInstallation=file://<tmp>/profile
 *   --convert-to <to> --outdir <tmp> in.<inputExt>`, then reads back the single
 * produced file (LibreOffice names the output `in.<to>` — same stem, new ext).
 * The temp dir (input, output, AND the per-call profile) is ALWAYS removed in a
 * finally, success or failure.
 *
 * Throws {@link LibreOfficeUnavailableError} when no binary is present. Any
 * other failure (timeout, non-zero exit, missing output) propagates as-is.
 */
export async function convertDocument(
  input: Buffer,
  { inputExt, to }: ConvertOptions,
): Promise<Buffer> {
  const bin = await resolveBinary();
  if (!bin) throw new LibreOfficeUnavailableError();

  // Unique temp dir per call; the random suffix keeps concurrent calls isolated.
  const dir = await mkdtemp(path.join(tmpdir(), `cosmos-lo-${randomUUID()}-`));
  try {
    const inputName = `in.${inputExt}`;
    const inputPath = path.join(dir, inputName);
    await writeFile(inputPath, input);

    // Per-call user profile inside the same temp dir → concurrency-safe.
    const profileUrl = `file://${path.join(dir, "profile")}`;

    await execFileAsync(
      bin,
      [
        "--headless",
        `-env:UserInstallation=${profileUrl}`,
        "--convert-to",
        to,
        "--outdir",
        dir,
        inputPath,
      ],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: CONVERT_MAX_BUFFER },
    );

    // The produced file shares the input stem ("in.") with the target ext. Find
    // it explicitly rather than assuming the name, so an unexpected filter ext
    // still resolves. Exclude the input itself.
    const entries = await readdir(dir);
    const produced = entries.find(
      (name) => name.startsWith("in.") && name !== inputName,
    );
    if (!produced) {
      throw new Error(
        `LibreOffice produced no ${to} output (saw: ${entries.join(", ") || "<empty>"})`,
      );
    }
    return await readFile(path.join(dir, produced));
  } finally {
    // Best-effort cleanup; never let a cleanup failure mask the real result.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Convert an .xlsx workbook buffer to a PDF buffer. */
export async function xlsxToPdf(buf: Buffer): Promise<Buffer> {
  return convertDocument(buf, { inputExt: "xlsx", to: "pdf" });
}

/** Result of a render-to-PDF validation pass. */
export interface ValidateResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate an .xlsx by rendering it to PDF. This is the gate for serving
 * chart-injected combined exports: if LibreOffice can turn the (possibly
 * surgically-edited) workbook into a non-trivial PDF, the OOXML is sound and
 * Excel will open it; if not, the caller serves the safe chartless file.
 *
 *   • LibreOffice unavailable → { ok:false, error:"not_configured" } (callers
 *     treat this as "can't validate" and fall back, NOT as corruption).
 *   • Renders a PDF > 1KB      → { ok:true }.
 *   • Anything else / throws   → { ok:false, error:<message> }.
 */
export async function validateXlsx(buf: Buffer): Promise<ValidateResult> {
  if (!(await isLibreOfficeAvailable())) {
    return { ok: false, error: "not_configured" };
  }
  try {
    const pdf = await xlsxToPdf(buf);
    if (pdf.byteLength > MIN_VALID_PDF_BYTES) return { ok: true };
    return { ok: false, error: `pdf too small (${pdf.byteLength} bytes)` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Test-only: reset the memoized binary resolution so a unit test can re-probe
 * (e.g. after pointing LIBREOFFICE_PATH at a bogus path). Not used in app code.
 */
export function __resetLibreOfficeCacheForTests(): void {
  resolvedBinary = undefined;
}

/**
 * Test-only: pin the resolution cache to "unavailable" (null) so the degraded
 * paths can be asserted deterministically even on a host that DOES have a real
 * LibreOffice (where probing would otherwise always succeed). Pass null to
 * force-unavailable; pass undefined to clear and re-probe. Not used in app code.
 */
export function __setResolvedBinaryForTests(value: string | null | undefined): void {
  resolvedBinary = value;
}
