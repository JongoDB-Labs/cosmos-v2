import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isSafeStorageKey, storageSafeName } from "./keys";
import { createLocalAdapter } from "./adapter-local";

describe("isSafeStorageKey", () => {
  // Every shape the app writes today, including an uploaded name that keeps
  // its dots. If one of these stops passing, stored files become unreadable.
  it.each([
    "org_1/3f1c/report.pdf",
    "org_1/feedback/3f1c/screen shot.png",
    "org_1/branding/logo-3f1c.webp",
    "documents/proj_1/3f1c/notes.md",
    "documents/org/org_1/3f1c/report..v2.pdf",
    "org_1/3f1c/.env.example",
  ])("accepts %s", (key) => {
    expect(isSafeStorageKey(key)).toBe(true);
  });

  it.each([
    ["a parent segment", "org_1/../org_2/logo.png"],
    ["a leading parent", "../package.json"],
    ["a trailing parent", "org_1/branding/.."],
    ["a current-dir segment", "org_1/./logo.png"],
    ["an absolute path", "/etc/passwd"],
    ["a backslash", "org_1\\..\\x"],
    ["an empty segment", "org_1//logo.png"],
    ["a NUL", "org_1/logo.png\0.txt"],
    ["nothing", ""],
  ])("refuses %s", (_label, key) => {
    expect(isSafeStorageKey(key)).toBe(false);
  });

  it("refuses a non-string", () => {
    expect(isSafeStorageKey(undefined)).toBe(false);
    expect(isSafeStorageKey({ toString: () => "a/b" })).toBe(false);
  });
});

describe("the local adapter checks keys before touching the disk", () => {
  it("positive control: a safe key that isn't stored streams as null", async () => {
    await expect(createLocalAdapter().stream(`__test/${crypto.randomUUID()}/x.txt`)).resolves.toBeNull();
  });

  it.each(["../../package.json", "org_1/../../../package.json", "/etc/hosts"])(
    "refuses to read, write or delete %s",
    async (key) => {
      const adapter = createLocalAdapter();
      await expect(adapter.stream(key)).rejects.toThrow(/unsafe storage key/);
      await expect(adapter.delete(key)).rejects.toThrow(/unsafe storage key/);
      await expect(
        adapter.put(key, Buffer.from("x"), { contentType: "text/plain", filename: "x" }),
      ).rejects.toThrow(/unsafe storage key/);
    },
  );
});

describe("storageSafeName", () => {
  it.each([
    [".", "file"],
    ["..", "file"],
    ["...", "file"],
    ["", "file"],
    ["Screenshot at 2:27 PM.png", "Screenshot_at_2_27_PM.png"],
    ["report..v2.pdf", "report..v2.pdf"],
    [".env.example", ".env.example"],
    ["../../etc/passwd", ".._.._etc_passwd"],
  ])("%j becomes %j", (name, expected) => {
    expect(storageSafeName(name)).toBe(expected);
  });

  it("always yields a segment the adapters accept, however long or odd the name", () => {
    const names = [".", "..", "/", "\\", "\0", "a/../b", "日本語.txt", ".".repeat(200), `${".".repeat(80)}x`, "x".repeat(300)];
    for (const name of names) {
      const seg = storageSafeName(name);
      expect(seg.length, name).toBeLessThanOrEqual(80);
      expect(isSafeStorageKey(`org_1/3f1c/${seg}`), name).toBe(true);
    }
  });

  it("is the only copy of the upload-name rule in the app", () => {
    // Three hand-copied versions of this line all let a name of dots through.
    const SRC = join(process.cwd(), "src");
    const copies: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "generated") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) &&
                   readFileSync(full, "utf8").includes("[^a-zA-Z0-9._-]")) {
          copies.push(relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(copies).toEqual(["lib/storage/keys.ts"]);
  });
});
