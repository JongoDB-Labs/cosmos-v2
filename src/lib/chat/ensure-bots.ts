import { prisma } from "@/lib/db/client";
import type { ChatBot, ChatBotToolScope, User } from "@prisma/client";

/**
 * First-class AI bots as synthetic users. Each built-in bot is a `User` row
 * with `isBot=true` (so its messages are authored by the bot, not the invoking
 * human, and it shows up in the mention picker) plus a `ChatBot` config row
 * keyed on `@@unique([orgId, key])`.
 *
 * `ensureOrgBots` is IDEMPOTENT and runs in ONE transaction: safe to call on
 * every chat surface load. It upserts the built-ins and returns them. The 12
 * chat_bots rows migrated from prod ARE these built-ins (assistant/notetaker/
 * answerer/standup across 3 orgs), so on a migrated org this resolves the
 * EXISTING rows rather than creating new ones.
 *
 * NOTE: the synthetic bot user is intentionally NOT an OrgMember — a bot has no
 * permissions of its own. When a bot runs a tool it does so AS THE INVOKING
 * HUMAN (see bot-runner.ts / agent-loop.ts), so it can never exceed that
 * person's access. The bot user exists only to author messages + be mentioned.
 *
 * v2 note: `standup` ships as a config row + bot user for prod-parity and
 * round-trip, but has NO conversational runner in v2 (it only ever fired on a
 * schedule in prod); `ConversationalBotKind` in bot-runner.ts excludes it.
 */

export type BuiltInBotKey = "assistant" | "notetaker" | "answerer" | "standup";

interface BuiltInBotSpec {
  key: BuiltInBotKey;
  displayName: string;
  persona: string;
  toolScope: ChatBotToolScope;
}

const BUILTINS: BuiltInBotSpec[] = [
  {
    key: "assistant",
    displayName: "Assistant",
    persona:
      "A helpful AI teammate that can query and modify project/work data using its tools and the org's connected MCP servers.",
    // FULL ceiling: still perm-scoped to the invoking human at execution time.
    toolScope: "FULL",
  },
  {
    key: "notetaker",
    displayName: "Note-taker",
    persona:
      "Summarizes the recent conversation into Decisions and Action items, and creates work items for action items in project-linked channels.",
    // READONLY ceiling: bot-runner additionally pins it to its own allow-list.
    toolScope: "READONLY",
  },
  {
    key: "answerer",
    displayName: "Answerer",
    persona:
      "A cited-answer assistant. When a teammate asks a question it searches the org's knowledge (notes, work items, docs) and replies concisely WITH the source it used. If it has no grounded answer it stays silent rather than guessing.",
    // READONLY ceiling: it only ever reads/searches; never mutates.
    toolScope: "READONLY",
  },
  {
    key: "standup",
    displayName: "Standup",
    persona:
      "Posts a daily standup for the channel's linked project: Yesterday / Today / Blockers plus a one-line burndown, built from the last 24h of activity and the active interval's work items.",
    // READONLY ceiling: it reads project/interval/work data to compose the standup.
    toolScope: "READONLY",
  },
];

/** A synthetic email for a bot user — stable and namespaced per org. */
function botEmail(orgId: string, key: string): string {
  return `bot+${key}@${orgId}.cosmos.local`;
}

export type EnsuredBot = ChatBot & { user: Pick<User, "id" | "displayName" | "isBot"> };

/**
 * Ensure an org has its built-in bots (synthetic user + ChatBot row each).
 * Idempotent; returns the bots keyed by their `key`.
 */
export async function ensureOrgBots(orgId: string): Promise<Record<BuiltInBotKey, EnsuredBot>> {
  const bots = await prisma.$transaction(async (tx) => {
    const out: Partial<Record<BuiltInBotKey, EnsuredBot>> = {};
    for (const spec of BUILTINS) {
      const existing = await tx.chatBot.findUnique({
        where: { orgId_key: { orgId, key: spec.key } },
        include: { user: { select: { id: true, displayName: true, isBot: true } } },
      });
      if (existing) {
        out[spec.key] = existing;
        continue;
      }
      // Create the synthetic bot user, then the ChatBot row wiring to it.
      const user = await tx.user.create({
        data: {
          email: botEmail(orgId, spec.key),
          displayName: spec.displayName,
          isBot: true,
        },
        select: { id: true, displayName: true, isBot: true },
      });
      const bot = await tx.chatBot.create({
        data: {
          orgId,
          key: spec.key,
          displayName: spec.displayName,
          persona: spec.persona,
          toolScope: spec.toolScope,
          userId: user.id,
        },
      });
      out[spec.key] = { ...bot, user };
    }
    return out as Record<BuiltInBotKey, EnsuredBot>;
  });
  return bots;
}
