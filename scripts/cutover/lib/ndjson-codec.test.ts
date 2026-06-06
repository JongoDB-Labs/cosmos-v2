// scripts/cutover/lib/ndjson-codec.test.ts
import { describe, it, expect } from "vitest";
import {
  encodeValue,
  decodeValue,
  encodeRow,
  decodeRow,
  categoryForOid,
  jsonBindParam,
} from "./ndjson-codec";

describe("categoryForOid", () => {
  it("classifies bytea / timestamp / json / passthrough", () => {
    expect(categoryForOid(17)).toBe("bytea");
    expect(categoryForOid(1184)).toBe("timestamp"); // timestamptz
    expect(categoryForOid(1082)).toBe("timestamp"); // date
    expect(categoryForOid(1700)).toBe("passthrough"); // numeric
    expect(categoryForOid(20)).toBe("passthrough"); // bigint
    expect(categoryForOid(114)).toBe("json"); // json
    expect(categoryForOid(3802)).toBe("json"); // jsonb
    expect(categoryForOid(199)).toBe("json"); // json[]
    expect(categoryForOid(3807)).toBe("json"); // jsonb[]
  });
});

describe("C3 — json/jsonb bind (array/object/scalar serialize as JSON, never PG array literal)", () => {
  // pg binds a value via its toPostgres() method (pg/lib/utils prepareValue). We assert the
  // wrapper emits JSON for EVERY shape — the exact text the jsonb column accepts.
  function pgText(v: unknown): string {
    const wrapped = decodeValue(v, "json") as { toPostgres: () => string };
    expect(typeof wrapped.toPostgres).toBe("function");
    return wrapped.toPostgres();
  }

  it("an ARRAY-valued jsonb (the CustomField.options bug) serializes as a JSON array", () => {
    // WITHOUT the fix, pg would render ['High','Low'] as the PG array literal {High,Low},
    // which jsonb rejects ⇒ the import transaction aborts. With the fix it's a JSON array.
    expect(pgText(["High", "Low"])).toBe('["High","Low"]');
  });

  it("an array-of-objects jsonb serializes as JSON (no corruption)", () => {
    expect(pgText([{ a: 1 }, { b: 2 }])).toBe('[{"a":1},{"b":2}]');
  });

  it("object / scalar / string jsonb values all serialize as JSON", () => {
    expect(pgText({ k: "v" })).toBe('{"k":"v"}');
    expect(pgText(42)).toBe("42");
    expect(pgText("hi")).toBe('"hi"');
  });

  it("a SQL NULL in a json column stays NULL (not the string 'null')", () => {
    // The leading null-guard means a genuine SQL NULL binds as NULL, not JSON null.
    expect(decodeValue(null, "json")).toBeNull();
  });

  it("jsonBindParam round-trips the original value structurally", () => {
    const v = { options: ["a", "b"], nested: { x: [1, 2] } };
    const wrapped = jsonBindParam(v);
    expect(JSON.parse(wrapped.toPostgres())).toEqual(v);
  });

  it("decodeRow binds a json column via the wrapper, not as a raw array", () => {
    const row = { id: "x", options: ["High", "Low"] };
    const values = decodeRow(row, ["id", "options"], { id: "passthrough", options: "json" });
    expect(values[0]).toBe("x");
    const w = values[1] as { toPostgres: () => string };
    expect(w.toPostgres()).toBe('["High","Low"]');
  });
});

describe("encode/decode round-trip", () => {
  it("numeric strings survive EXACTLY (money correctness)", () => {
    const enc = encodeValue("1234.5600");
    expect(JSON.parse(JSON.stringify(enc))).toBe("1234.5600");
    expect(decodeValue(JSON.parse(JSON.stringify(enc)), "passthrough")).toBe("1234.5600");
  });

  it("bigint strings survive beyond Number.MAX_SAFE_INTEGER", () => {
    const big = "9007199254740993";
    expect(decodeValue(JSON.parse(JSON.stringify(encodeValue(big))), "passthrough")).toBe(big);
  });

  it("Buffer ↔ base64 envelope, decoded by bytea category", () => {
    const buf = Buffer.from([1, 2, 3, 250]);
    const enc = JSON.parse(JSON.stringify(encodeValue(buf)));
    const dec = decodeValue(enc, "bytea");
    expect(Buffer.isBuffer(dec)).toBe(true);
    expect((dec as Buffer).equals(buf)).toBe(true);
  });

  it("Date ↔ ISO envelope, decoded by timestamp category", () => {
    const d = new Date("2026-06-06T12:34:56.000Z");
    const enc = JSON.parse(JSON.stringify(encodeValue(d)));
    const dec = decodeValue(enc, "timestamp");
    expect(dec instanceof Date).toBe(true);
    expect((dec as Date).toISOString()).toBe(d.toISOString());
  });

  it("json objects bind verbatim — a tag-shaped object is NOT misread as an envelope", () => {
    // Decoding is GUIDED by the column category (json), never by sniffing the value, so a
    // user object that happens to carry our tag key is bound as JSON, not as a bytea/ts
    // envelope. (The same value under passthrough also survives — both paths are safe.)
    const tricky = { __cutover_t: "bytea", v: "not-really-bytea", more: [1, 2] };
    const enc = JSON.parse(JSON.stringify(encodeValue(tricky)));
    expect(decodeValue(enc, "passthrough")).toEqual(tricky);
    const w = decodeValue(enc, "json") as { toPostgres: () => string };
    expect(JSON.parse(w.toPostgres())).toEqual(tricky);
  });

  it("text[] arrays pass through", () => {
    const arr = ["CUI//SP-PRVCY", "FOUO"];
    expect(decodeValue(JSON.parse(JSON.stringify(encodeValue(arr))), "passthrough")).toEqual(arr);
  });

  it("null/undefined → null", () => {
    expect(encodeValue(null)).toBeNull();
    expect(encodeValue(undefined)).toBeNull();
    expect(decodeValue(null, "bytea")).toBeNull();
    expect(decodeValue(null, "timestamp")).toBeNull();
  });

  it("encodeRow/decodeRow align to a column order + category map", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      amount: "10.0000",
      created_at: new Date("2026-06-06T00:00:00Z"),
      row_hash: Buffer.from([9, 8, 7]),
      meta: { a: 1 },
    };
    const columns = ["id", "amount", "created_at", "row_hash", "meta"];
    const categories = {
      id: "passthrough",
      amount: "passthrough",
      created_at: "timestamp",
      row_hash: "bytea",
      meta: "passthrough",
    } as const;
    const wire = JSON.parse(JSON.stringify(encodeRow(row, columns)));
    const values = decodeRow(wire, columns, categories);
    expect(values[0]).toBe(row.id);
    expect(values[1]).toBe("10.0000");
    expect((values[2] as Date).toISOString()).toBe(row.created_at.toISOString());
    expect((values[3] as Buffer).equals(row.row_hash)).toBe(true);
    expect(values[4]).toEqual({ a: 1 });
  });
});
