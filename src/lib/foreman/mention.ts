// @Foreman — the instruction channel. Ticket comments that @-mention the Foreman
// bot user (tag-any-entity serializes a user mention as the token `<@<uuid>>`)
// become maintainer instructions: injected into the build/clarity prompts, and —
// on a parked ticket — an auto-requeue trigger. PURE module (no IO) so the
// parsing, the privilege filter, and the watermark logic are unit-tested; the
// daemon (scripts/foreman) owns the queries and side effects.
//
// SECURITY: instructions steer a coding agent, so authorship is a privilege.
// Only comments by OWNER/ADMIN members count (the caller supplies the privileged
// id set); everyone else's mentions are inert. Instructions only ever shape the
// prompt — every existing gate (checks, risk classifier, adversarial reviewer,
// self-mod paths) still binds the result.

export interface TicketComment {
  authorId: string;
  content: string;
  createdAt: Date;
}

/** The tag-any-entity user-mention token for a given user id. */
export function mentionToken(botUserId: string): string {
  return `<@${botUserId}>`;
}

/** Does this content @-mention the bot? Token-anchored — a plain-text "@Foreman"
 *  (no token) is NOT an instruction, so prose about Foreman can't trigger it. */
export function mentionsBot(content: string, botUserId: string): boolean {
  return content.includes(mentionToken(botUserId));
}

export interface Instruction {
  authorId: string;
  text: string;
  createdAt: Date;
}

/** Extract the privileged instructions addressed to the bot, oldest first.
 *  The mention token itself is stripped (the prompt wants the instruction, not
 *  the markup); other entity tokens are left as-is (they carry ids the agent
 *  can look up). Empty remainders (a bare "@Foreman" ping) are dropped. */
export function extractInstructions(
  comments: TicketComment[],
  botUserId: string,
  privilegedUserIds: ReadonlySet<string>,
  opts: { since?: Date } = {},
): Instruction[] {
  const token = mentionToken(botUserId);
  return comments
    .filter(
      (c) =>
        c.content.includes(token) &&
        privilegedUserIds.has(c.authorId) &&
        (!opts.since || c.createdAt.getTime() > opts.since.getTime()),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((c) => ({ authorId: c.authorId, text: c.content.split(token).join("").trim(), createdAt: c.createdAt }))
    .filter((i) => i.text.length > 0);
}

/** The reply instruction for the read-only answering agent (Phase 3): a
 *  privileged member asked @Foreman something on a ticket that is NOT parked
 *  (parked mentions requeue instead). It may read the repo to answer, never
 *  change it. */
export function replyPrompt(input: {
  key: string;
  title: string;
  columnKey: string;
  description: string;
  thread: { author: string; text: string }[];
  question: string;
}): string {
  const thread = input.thread.length
    ? input.thread.map((c) => `- ${c.author}: ${c.text}`).join("\n")
    : "(no earlier comments)";
  return `You are Foreman, the autonomous delivery agent for this repository (cosmos-v2). A maintainer addressed you in a comment on ticket ${input.key} and expects a useful, grounded answer.

## Ticket
${input.key} (${input.columnKey}): ${input.title}
${input.description || "(no description)"}

## Earlier comments
${thread}

## The maintainer's message to you
${input.question}

## How to answer
- You may Read/Grep/Glob the repository to ground your answer in the actual code. You are READ-ONLY: no edits, no shell, no builds.
- If they're giving guidance for a future build of this ticket, acknowledge it concretely (what you'll do differently) — the guidance is applied automatically when the ticket is next built.
- If they're asking a question, answer it directly, citing files/behavior where useful.
- If they ask for something you cannot do from a comment (deploy, merge, revert), say what you CAN do and what the correct lever is.
- Reply in 1-6 sentences of plain prose. No headings, no sign-off, no attribution boilerplate.`;
}
