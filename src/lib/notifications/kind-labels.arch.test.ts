// Every notification type core creates gets a chip of its own. Derived labels
// can only collide if two types differ by nothing but `.` versus `_`, which
// this would catch — and it reads the types out of the source, so a new kind
// is covered the day it is written, with no list to keep up to date.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { kindLabel, pluginKindPrefix } from "./kind";
import { PluginRegistry } from "@/lib/plugins/registry";
import "@/lib/plugins/registry/index";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const typesInSource = () => {
  const found = new Set<string>();
  for (const file of sources(join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    // Only files that create notifications: their `type:` is a notification kind.
    if (!/createNotification\(|notification\.create(Many)?\(/.test(text)) continue;
    // Every dotted literal on a `type:` line, so `type: shipped ? "a.x" : "a.y"`
    // counts both.
    for (const line of text.matchAll(/\btype:\s*([^\n]+)/g)) {
      for (const m of line[1].matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/g)) found.add(m[1]);
    }
  }
  return [...found].sort();
};

describe("notification kind labels", () => {
  it("finds core's notification types (so this test is not vacuous)", () => {
    const types = typesInSource();
    expect(types.length).toBeGreaterThan(15);
    expect(types).toEqual(
      expect.arrayContaining(["comment.added", "comment.mentioned", "work_item.assigned", "delivery.parked", "delivery.shipped"]),
    );
  });

  it("gives every core notification type a label no other type shares", () => {
    const byLabel = new Map<string, string[]>();
    for (const t of typesInSource()) byLabel.set(kindLabel(t), [...(byLabel.get(kindLabel(t)) ?? []), t]);
    const clashes = [...byLabel].filter(([, ts]) => ts.length > 1);
    expect(clashes).toEqual([]);
  });

  it("lets each registered plugin name only its own kinds, with labels no core kind uses", () => {
    const coreLabels = new Set(typesInSource().map(kindLabel));
    for (const plugin of PluginRegistry.getAll()) {
      for (const [type, label] of Object.entries(plugin.notificationKinds ?? {})) {
        expect(type.startsWith(pluginKindPrefix(plugin.slug)), `${plugin.slug}: ${type}`).toBe(true);
        expect(coreLabels.has(label), `${plugin.slug}: "${label}" is a core kind's label`).toBe(false);
      }
    }
  });
});
