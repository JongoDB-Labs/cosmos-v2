/**
 * The shape every storage key must have, checked by both adapters before any
 * read, write or delete.
 *
 * Keys are built by the app (`<orgId>/<uuid>/<name>`, `documents/<scope>/...`),
 * but some are read back from places a user can influence, such as an org's
 * settings. A key that climbs out of its folder reached any file on the server
 * through the local adapter, and on S3 it names whatever object it spells. So a
 * key is a relative path of plain segments: no leading slash, no backslash or
 * NUL, and no empty, `.` or `..` segment.
 *
 * A `..` INSIDE a segment is allowed. Uploaded file names keep their dots
 * (`report..v2.pdf`), files with such names are already stored, and the
 * segment rule is what stops traversal. The local adapter also checks that the
 * resolved path is still inside its root.
 */
export class UnsafeStorageKeyError extends Error {
  constructor() {
    super("Refused an unsafe storage key");
    this.name = "UnsafeStorageKeyError";
  }
}

export function isSafeStorageKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.includes("\0") || key.includes("\\") || key.startsWith("/")) return false;
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function assertSafeStorageKey(key: string): void {
  if (!isSafeStorageKey(key)) throw new UnsafeStorageKeyError();
}

/**
 * An uploaded file's name as one storage-key segment. Anything other than a
 * letter, digit, `.`, `_` or `-` becomes `_`, and it is cut to 80 characters.
 * A name made only of dots (`.`, `..`) would be a segment isSafeStorageKey
 * refuses, so the upload failed; it becomes `file`, as an empty name does.
 * The name people see is stored separately and is not changed.
 */
export function storageSafeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return /^\.*$/.test(safe) ? "file" : safe;
}
