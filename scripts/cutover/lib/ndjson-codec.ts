// scripts/cutover/lib/ndjson-codec.ts
//
// Lossless, type-aware row codec for the export NDJSON.
//
// node-postgres hands us values in these JS shapes (verified empirically against PG16):
//   numeric/decimal → String  (e.g. "1234.5600" — EXACT, never a float)
//   bigint          → String  (exact beyond Number.MAX_SAFE_INTEGER)
//   uuid/text       → String
//   text[]          → Array
//   json/jsonb      → parsed Object/Array/scalar
//   timestamptz     → Date
//   bytea           → Buffer
//   vector(n)       → (stripped before we ever read it)
//
// JSON natively represents String/Array/Object/number/boolean/null. The only values it
// CANNOT round-trip are Date and Buffer, so we wrap ONLY those in a tagged envelope.
// To make decoding COLLISION-PROOF against a jsonb column whose data legitimately looks
// like an envelope, we do NOT sniff values on decode — we decode by the column's known
// PG type CATEGORY (captured in the manifest at export time). Encoding still wraps Date/
// Buffer wherever they appear (they only ever appear in ts/bytea columns anyway).

/** PG type categories that need special decoding; everything else is passthrough. */
export type PgTypeCategory = "bytea" | "timestamp" | "passthrough";

// PG type OIDs we special-case. Source: pg_type. We classify by OID so the manifest can
// record a tiny per-column category instead of the full type.
const BYTEA_OID = 17;
const TIMESTAMP_OIDS = new Set([
  1114, // timestamp (without tz)
  1184, // timestamptz
  1082, // date
  1083, // time
  1266, // timetz
]);

/** Classify a pg field's dataTypeID into a decode category. */
export function categoryForOid(oid: number): PgTypeCategory {
  if (oid === BYTEA_OID) return "bytea";
  if (TIMESTAMP_OIDS.has(oid)) return "timestamp";
  return "passthrough";
}

const TAG = "__cutover_t";

/** Encode one JS value (as returned by pg) into a JSON-safe form. */
export function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { [TAG]: "bytea", v: v.toString("base64") };
  if (v instanceof Date) return { [TAG]: "ts", v: v.toISOString() };
  if (typeof v === "bigint") return { [TAG]: "bigint", v: v.toString() };
  // String (incl. numeric/bigint already-as-string), number, boolean, Array, Object:
  // JSON round-trips these verbatim. Nested Buffers/Dates inside a jsonb object can't
  // occur (jsonb has no binary/date types — they'd already be strings).
  return v;
}

/**
 * Decode one JSON value back to the JS type pg expects as a bind parameter, GUIDED by
 * the column's PG category (never by sniffing the value — so a jsonb object that happens
 * to contain our tag is returned untouched).
 *   - bytea     → Buffer
 *   - timestamp → Date (pg accepts a Date or an ISO string; Date is unambiguous)
 *   - passthrough → the value as-is (numeric/bigint stay STRINGS → exact; arrays/objects
 *                   pass through; node-pg serializes them to the column type).
 */
export function decodeValue(v: unknown, category: PgTypeCategory): unknown {
  if (v === null || v === undefined) return null;
  if (category === "bytea") {
    if (isEnvelope(v, "bytea")) return Buffer.from(v.v, "base64");
    // A bytea column should always arrive enveloped; tolerate a raw base64 string.
    if (typeof v === "string") return Buffer.from(v, "base64");
    throw new Error(`ndjson-codec: bytea column got un-decodable value ${JSON.stringify(v)}`);
  }
  if (category === "timestamp") {
    if (isEnvelope(v, "ts")) return new Date(v.v);
    if (typeof v === "string") return new Date(v);
    throw new Error(`ndjson-codec: timestamp column got un-decodable value ${JSON.stringify(v)}`);
  }
  // passthrough: a bigint envelope (rare — pg gives strings) collapses to its string.
  if (isEnvelope(v, "bigint")) return v.v;
  return v;
}

function isEnvelope(
  v: unknown,
  kind: "bytea" | "ts" | "bigint",
): v is { [TAG]: string; v: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>)[TAG] === kind &&
    typeof (v as Record<string, unknown>).v === "string"
  );
}

/** Encode a full row (column→value map) for NDJSON. Column order is fixed by the caller. */
export function encodeRow(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = encodeValue(row[c]);
  return out;
}

/** Decode a full NDJSON row back into bind values, in the manifest's column order. */
export function decodeRow(
  row: Record<string, unknown>,
  columns: string[],
  categories: Record<string, PgTypeCategory>,
): unknown[] {
  return columns.map((c) => decodeValue(row[c], categories[c] ?? "passthrough"));
}
