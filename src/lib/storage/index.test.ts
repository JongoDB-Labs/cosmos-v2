import { afterEach, describe, expect, it } from "vitest";
import { getStorage, _resetStorageForTests } from "./index";

afterEach(() => {
  _resetStorageForTests();
  delete process.env.STORAGE_ADAPTER;
});

describe("getStorage", () => {
  it("returns the same instance across calls", () => {
    const a = getStorage();
    const b = getStorage();
    expect(a).toBe(b);
  });

  it("defaults to local adapter", async () => {
    const s = getStorage();
    expect(s.delete).toBeTypeOf("function");
    expect(await s.stream("any")).toBeNull();
  });

  it("local put returns a url and storageKey", async () => {
    const s = getStorage();
    const key = `__test/${crypto.randomUUID()}.txt`;
    const result = await s.put(key, Buffer.from("test"), {
      contentType: "text/plain",
      filename: "x.txt",
    });
    expect(result.storageKey).toBe(key);
    expect(result.url).toContain(encodeURIComponent(key));
    // Cleanup
    await s.delete(key);
  });

  it("selects the azure adapter for STORAGE_ADAPTER=azure", () => {
    // Reaching the azure adapter's own config check proves the wiring without a
    // storage account; the adapter itself is covered in adapter-azure.test.ts.
    process.env.STORAGE_ADAPTER = "azure";
    delete process.env.AZURE_STORAGE_CONTAINER;
    expect(() => getStorage()).toThrow(/azure storage adapter: missing required env AZURE_STORAGE_CONTAINER/);
  });

  it("throws on unknown STORAGE_ADAPTER", () => {
    process.env.STORAGE_ADAPTER = "invalid";
    expect(() => getStorage()).toThrow(/Unknown STORAGE_ADAPTER=invalid/);
  });
});
