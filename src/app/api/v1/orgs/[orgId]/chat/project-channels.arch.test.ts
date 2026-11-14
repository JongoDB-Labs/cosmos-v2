import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handlerCode } from "@/lib/auth/__tests__/gate-bits";

/**
 * A channel tied to a project is as visible as the project (lib/chat/access.ts).
 * The rule is written once, and it runs only where someone calls it: the
 * defect this pins was a correct project rule that no chat route called. So
 * every chat handler passes through one of the shared forms of the rule, per
 * handler, not per file (a sibling handler's call proves nothing about this
 * one), or is exempt by name with the reason it can't reach a project's
 * channel.
 *
 * Every handler, not only those that look like they read a channel: a read
 * this scan can't recognise is exactly the one that would slip past it.
 *
 * `project-channels.db.test.ts` drives the behaviour; this keeps a new handler
 * from reading around it.
 */

const ROOT = "src/app/api/v1/orgs/[orgId]/chat";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** The rule, as a call. */
const APPLIES_RULE = /\b(?:loadChannelAndMembership|channelProjectVisible|visibleChannelWhere|visibleChannelProjectIds)\(/;

/** Handlers that don't apply the rule, and why each can't expose a project's channel. */
const EXEMPT: Record<string, string> = {
  "bots/route.ts GET": "the org's bot settings; no channel",
  "bots/route.ts PATCH": "the org's bot settings; no channel",
  "presence/route.ts GET": "who is online in the org; no channel",
  "channels/route.ts POST": "creates a channel; its project must be one the creator can see (foreignRef)",
  "dms/route.ts POST": "a direct message has no project",
  "attachments/route.ts POST": "an upload, on no message yet",
  "channels/[channelId]/route.ts DELETE": "org OWNER or ADMIN only, who see every project",
  "channels/[channelId]/leave/route.ts POST": "the caller leaving; returns nothing about the channel",
  "channels/[channelId]/members/me/route.ts PATCH": "the caller's own notification settings; returns only those",
};

/** Comments out, so a handler that only explains the rule doesn't pass. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, acc);
    else if (entry.name === "route.ts") acc.push(full);
  }
  return acc;
}

function handlers(): { key: string; code: string }[] {
  const out: { key: string; code: string }[] = [];
  for (const file of routeFiles(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const method of METHODS) {
      const body = handlerCode(src, method, file);
      if (body) out.push({ key: `${file.slice(ROOT.length + 1)} ${method}`, code: code(body) });
    }
  }
  return out;
}

describe("every chat handler applies the project rule for channels", () => {
  const all = handlers();

  it("scans the real chat routes (not vacuous)", () => {
    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((h) => APPLIES_RULE.test(h.code)).length).toBeGreaterThan(20);
  });

  it("each one calls a shared form of the rule, or is exempt by name with a reason", () => {
    const missing = all.filter((h) => !APPLIES_RULE.test(h.code) && !(h.key in EXEMPT)).map((h) => h.key);
    expect(missing).toEqual([]);
  });

  it("every exemption is still a handler, and still one that doesn't apply the rule", () => {
    const stale = Object.keys(EXEMPT).filter((k) => {
      const h = all.find((x) => x.key === k);
      return !h || APPLIES_RULE.test(h.code);
    });
    expect(stale).toEqual([]);
  });

  it("doesn't count the rule named only in a comment", () => {
    const body = code(`const c = await prisma.chatChannel.findUnique({ where: { id } }); // loadChannelAndMembership(ctx, id)`);
    expect(APPLIES_RULE.test(body)).toBe(false);
    expect(APPLIES_RULE.test(code(`await loadChannelAndMembership(ctx, id);`))).toBe(true);
  });
});
