// A shadcn-style primitive module ships the WHOLE upstream family, used or not.
//
// That is how `src/components/ui` accumulated `AvatarBadge`/`AvatarGroup`/
// `AvatarGroupCount`, `CommandShortcut`, `DropdownMenuShortcut`/
// `DropdownMenuPortal`, `InputGroupButton`/`Text`/`Input`/`Textarea` and
// `SelectSeparator` — nine exported components with zero call sites, plus the
// imports and cva tables that only they kept alive. Nothing is broken by an
// unused export, which is exactly why it survives: `tsc` and eslint both see a
// used symbol (the export list uses it), so no existing check can go red.
//
// CLEANUP-13 removed them. This is the guard that keeps them gone.
//
// The rule it encodes is "every export has a reader", NOT a frozen name list:
// adding a primitive that something actually renders stays green, adding one
// nothing imports goes red. So this does not tax real work — it taxes exactly
// the thing that went wrong.
//
// Why read the filesystem instead of importing the modules: the question is
// which names the REST of the tree imports, and that is a property of the
// source, not of any runtime value. `import * as m` can tell us what a module
// exports; it cannot tell us whether anyone wants it.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const UI = join(SRC, "components", "ui");

/** Modules whose export surface must stay fully reachable. */
const GUARDED = [
  "avatar",
  "command",
  "dropdown-menu",
  "input-group",
  "local-timestamp",
  "select",
] as const;

/**
 * Exports that are ALREADY unimported and that CLEANUP-13 deliberately did not
 * remove — its scope named nine specific components and said not to widen.
 *
 * This is debt, recorded rather than hidden: the sweep that found the nine said
 * a further finding in this area did not fit under its size gate, and running
 * the rule above is how these surfaced. Some are used INSIDE their own module
 * (`Command` by `CommandDialog`, the two scroll buttons by `SelectContent`), so
 * removing those means unexporting, not deleting.
 *
 * The list may shrink, never grow. An entry that is no longer unimported fails
 * below, so cleaning one up forces its removal from here too.
 */
const KNOWN_UNIMPORTED: Record<string, string[]> = {
  command: ["Command", "CommandSeparator"],
  select: [
    "SelectGroup",
    "SelectLabel",
    "SelectScrollDownButton",
    "SelectScrollUpButton",
  ],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const ALL_SOURCES = walk(SRC);

/** `export { A, B as C }` plus `export function X` / `export const X`. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const [, body] of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of body.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const [, name] of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(name);
  }
  return [...names];
}

/**
 * Every name some OTHER file imports from `modulePath`.
 *
 * Specifiers are resolved against the importing file so only a real reference
 * to this module counts — a bare basename match would let an unrelated
 * `./avatar` elsewhere in the tree vouch for `ui/avatar`.
 */
function importersOf(modulePath: string): Set<string> {
  const wanted = new Set<string>();
  for (const file of ALL_SOURCES) {
    if (file === modulePath) continue;
    const source = readFileSync(file, "utf8");
    for (const [, body, specifier] of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
    )) {
      const target = specifier.startsWith("@/")
        ? join(SRC, specifier.slice(2))
        : specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : null;
      if (target !== modulePath.replace(/\.tsx?$/, "")) continue;
      for (const part of body.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (name) wanted.add(name);
      }
    }
  }
  return wanted;
}

describe("src/components/ui exports nothing the app does not import", () => {
  for (const moduleName of GUARDED) {
    it(`${moduleName}.tsx`, () => {
      const modulePath = join(UI, `${moduleName}.tsx`);
      const exported = exportedNames(readFileSync(modulePath, "utf8"));
      // Proves the parser found a surface at all — an empty list would make
      // the assertion below vacuously true.
      expect(exported.length).toBeGreaterThan(0);

      const imported = importersOf(modulePath);
      const known = KNOWN_UNIMPORTED[moduleName] ?? [];

      const orphans = exported
        .filter((name) => !imported.has(name))
        .filter((name) => !known.includes(name));
      expect(orphans, `unimported export(s) in ${relative(SRC, modulePath)}`).toEqual([]);

      // Keeps the allow-list honest: once something starts importing a name
      // (or the name goes away), its entry has to come out.
      const stale = known.filter((name) => imported.has(name) || !exported.includes(name));
      expect(stale, `stale KNOWN_UNIMPORTED entries for ${moduleName}`).toEqual([]);
    });
  }
});
