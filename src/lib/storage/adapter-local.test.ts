import { describe, expect, it } from "vitest";
import { createLocalAdapter } from "./adapter-local";

// These tests touch the real filesystem. They're skipped in the default suite
// to keep CI hermetic; toggle to `describe.only` (or remove .skip) to run
// manually after changes to the adapter.
describe.skip("local storage adapter", () => {
  it("put → stream round-trip + delete", async () => {
    const adapter = createLocalAdapter();
    const key = `__test/${crypto.randomUUID()}/file.txt`;
    await adapter.put(key, Buffer.from("hello"), {
      contentType: "text/plain",
      filename: "file.txt",
    });

    const stream = await adapter.stream(key);
    expect(stream).not.toBeNull();
    const text = await new Response(stream!).text();
    expect(text).toBe("hello");

    await adapter.delete(key);
    const after = await adapter.stream(key);
    expect(after).toBeNull();
  });

  it("delete on missing key is a no-op", async () => {
    const adapter = createLocalAdapter();
    await adapter.delete(`__test/does-not-exist/${crypto.randomUUID()}`);
    // No throw = pass.
  });
});
