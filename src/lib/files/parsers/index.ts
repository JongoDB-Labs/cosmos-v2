import type { DocumentParser } from "./types";
import { docxParser } from "./docx";
import { xlsxParser } from "./xlsx";
import { pdfParser } from "./pdf";
import { pptxParser } from "./pptx";

const ALL = [docxParser, xlsxParser, pdfParser, pptxParser];

export const SUPPORTED_FORMATS = ALL.flatMap((p) => p.formats);

export function parserFor(format: string): DocumentParser | null {
  return ALL.find((p) => p.formats.includes(format)) ?? null;
}

/**
 * Extensions a document library will not take.
 *
 * Deliberately NARROW, and not about parsing: it is the set an operating system
 * will execute on a double-click. Everything else — images, text, CSV, archives,
 * CAD, mail, video, anything — is a thing a practice legitimately keeps, and
 * refusing it was the bug this list replaces.
 *
 * Storing one of these is not a server-side risk (nothing here runs them). The
 * risk is handing one to a colleague from inside a tool they trust, which is a
 * worse place to meet malware than an email attachment.
 */
const EXECUTABLE = new Set([
  "exe", "dll", "com", "scr", "msi", "msix", "cpl", "bat", "cmd", "ps1", "vbs", "vbe", "wsf", "hta",
  "so", "dylib", "app", "pkg", "dmg", "deb", "rpm", "appimage", "run", "bin",
  "jar", "apk", "sh", "bash", "zsh", "csh",
]);

/** True when the name ends in something an OS would execute. */
export function isExecutableUpload(name: string): boolean {
  return EXECUTABLE.has(name.toLowerCase().split(".").pop() ?? "");
}

/** Map a filename to a PARSEABLE format key, or null when nothing can read it.
 *  Null is not a rejection — see ingestDocument. */
export function formatFromName(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return SUPPORTED_FORMATS.includes(ext) ? ext : null;
}
