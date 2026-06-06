// scripts/cutover/lib/ndjson-codec.test.ts
import { describe, it, expect } from "vitest";
import {
  encodeValue,
  decodeValue,
  encodeRow,
  decodeRow,
  categoryForOid,
} from "./ndjson-codec";

describe("categoryForOid", () => {
  it("classifies bytea / timestamp / passthrough", () => {
    expect(categoryForOid(17)).toBe("bytea");
    expect(categoryForOid(1184)).toBe("timestamp"); // timestamptz
    expect(categoryForOid(1082)).toBe("timestamp"); // date
    expect(categoryForOid(1700)).toBe("passthrough"); // numeric
    expect(categoryForOid(20)).toBe("passthrough"); // bigint
    expect(categoryForOid(3802)).toBe("passthrough"); // jsonb
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

  it("jsonb objects pass through verbatim — even ones that LOOK like an envelope", () => {
    // A jsonb column is decoded with passthrough category, so a user object that happens to
    // carry our tag key is NOT misinterpreted as a bytea/ts envelope.
    const tricky = { __cutover_t: "bytea", v: "not-really-bytea", more: [1, 2] };
    const enc = JSON.parse(JSON.stringify(encodeValue(tricky)));
    expect(decodeValue(enc, "passthrough")).toEqual(tricky);
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
