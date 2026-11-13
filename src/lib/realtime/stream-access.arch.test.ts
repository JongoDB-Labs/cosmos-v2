import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_SERVER_EVENT_TYPES } from "./event-types";
import {
  CHAT_EVENT_PREFIX,
  ORG_WIDE_EVENTS,
  OWN_TOPIC_EVENTS,
  PROJECT_BOUND_EVENTS,
  STREAM_ONLY_EVENTS,
  pluginEventClass,
} from "./stream-access";

/**
 * Two rules for what goes onto the org topic, which every connection in the
 * org hears before the stream gate decides:
 *
 *  1. Ids, not content. Clients refetch through the permission-checked routes,
 *     so a title in an event only ever reaches someone the route would refuse.
 *     A ticket key is content too: it names the project.
 *  2. A project-bound event names its project. The gate drops one that does
 *     not, so leaving `projectId` out silently stops that view updating live.
 *
 * And every event name is classified, so a new one cannot skip the gate's
 * decision about who hears it. The gate drops an unclassified event, so this
 * rule is what keeps a new event from going silent.
 *
 * Plugins publish onto the same topic. Their source lives in each plugin's
 * `overlay/src`, composed into `src/plugins/<slug>` at build time, so the scan
 * reads both: `plugins/<slug>/overlay/src` where a plugin is checked out, and
 * `src` (which holds the composed copy once composed).
 */

/** Core's source, and each checked-out plugin's overlay. */
function scannedRoots(): string[] {
  const roots = ["src"];
  if (!existsSync("plugins")) return roots;
  for (const slug of readdirSync("plugins")) {
    const overlay = join("plugins", slug, "overlay", "src");
    if (existsSync(overlay)) roots.push(overlay);
  }
  return roots;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Comments out, so a doc comment naming a field cannot satisfy or trip a rule. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The argument text of a call that opens at `open` (the index of its `(`). */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

type Site = { file: string; type: string; args: string };

/** Every publish onto the ORG topic: `publishToOrg(...)` and `publish(topics.org(...), ...)`. */
function orgTopicPublishes(): Site[] {
  const sites: Site[] = [];
  const call = /\bpublishToOrg\s*\(|\.publish\s*\(\s*topics\.org\s*\(/g;
  for (const file of scannedRoots().flatMap((root) => sourceFiles(root))) {
    if (file.endsWith("realtime/broker.ts")) continue; // the definition, not a publish
    const src = stripComments(readFileSync(file, "utf8"));
    let m: RegExpExecArray | null;
    call.lastIndex = 0;
    while ((m = call.exec(src)) !== null) {
      const open = src.indexOf("(", m.index);
      const args = argsAt(src, open);
      const type = /["']([a-z0-9.\-_]+)["']/.exec(args)?.[1];
      if (type) sites.push({ file, type, args });
    }
  }
  return sites;
}

describe("org-topic events", () => {
  const sites = orgTopicPublishes();

  it("found the publish sites at all", () => {
    // Guards the guard: an empty scan passes every rule below.
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.some((s) => s.type === "work-item.created")).toBe(true);
  });

  it("carry no title and no ticket key", () => {
    const offenders = sites.filter((s) => /\b(title|ticketKey)\b/.test(s.args)).map((s) => `${s.file}: ${s.type}`);
    expect(offenders).toEqual([]);
  });

  it("are each classified, core's and plugins' alike", () => {
    // The gate sends an event only when its class says who may hear it.
    const unclassified = sites
      .filter((s) => {
        const t = s.type;
        return !(
          PROJECT_BOUND_EVENTS.has(t) ||
          t in ORG_WIDE_EVENTS ||
          t.startsWith(CHAT_EVENT_PREFIX) ||
          pluginEventClass(t) !== null
        );
      })
      .map((s) => `${s.file}: ${s.type}`);
    expect(unclassified).toEqual([]);
  });

  it("name their project when they are about one", () => {
    const offenders = sites
      .filter((s) => PROJECT_BOUND_EVENTS.has(s.type) && !/\bprojectId\b/.test(s.args))
      .map((s) => `${s.file}: ${s.type}`);
    expect(offenders).toEqual([]);
  });

  it("are classified for the stream gate", () => {
    const unclassified = ALL_SERVER_EVENT_TYPES.filter((t) => {
      const classes = [
        PROJECT_BOUND_EVENTS.has(t),
        t in ORG_WIDE_EVENTS,
        t.startsWith(CHAT_EVENT_PREFIX) && !(t in ORG_WIDE_EVENTS),
        OWN_TOPIC_EVENTS.has(t),
        STREAM_ONLY_EVENTS.has(t),
      ].filter(Boolean).length;
      return classes !== 1;
    });
    expect(unclassified).toEqual([]);
  });

  it("classify nothing the server does not publish", () => {
    const known = new Set<string>(ALL_SERVER_EVENT_TYPES);
    const stale = [...PROJECT_BOUND_EVENTS, ...Object.keys(ORG_WIDE_EVENTS), ...OWN_TOPIC_EVENTS].filter((t) => !known.has(t));
    expect(stale).toEqual([]);
  });
});
