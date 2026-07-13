/**
 * Auto-titling for assistant conversations (Anthropic Claude Chat/Code/Cowork UX):
 * after the first user↔assistant exchange, generate a short descriptive title from
 * the conversation content so the sidebar stops showing "New conversation" forever.
 *
 * The generation call goes through the SAME CUI-blind egress chokepoint
 * (`runModelTurn`) as the assistant itself — no second egress path — and uses the
 * org's connected model credential (resolved inside the chokepoint). It is kept
 * cheap: a short system prompt, the first exchange only, no tools, and a low
 * `maxTokens`. Callers generate ONCE (when the title is still the default) and
 * persist; they do not regenerate on later turns.
 */
import { runModelTurn } from "./egress";
import type { TenantClass } from "./egress";

/** The stored default that marks a conversation as "never titled". */
export const DEFAULT_CONVERSATION_TITLE = "New conversation";

const MAX_TITLE_LEN = 60;
const TITLE_MAX_TOKENS = 24;

const TITLE_SYSTEM_PROMPT =
  "You write a short, specific title for a chat conversation so it can be found " +
  "in a list. Reply with ONLY the title: 3 to 6 words, Title Case, no surrounding " +
  "quotes, no trailing punctuation, no preamble like 'Title:'.";

/**
 * Clean the model's raw output into a stored title. PURE + testable: takes the
 * first line, strips wrapping quotes/backticks and a leading "Title:" label,
 * collapses whitespace, drops trailing punctuation, and caps the length. Returns
 * "" when nothing usable remains (the caller then keeps the default title).
 */
export function cleanTitle(raw: string): string {
  let t = (raw ?? "").trim();
  if (!t) return "";
  // First non-empty line only — the model occasionally adds a second line.
  t = (t.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
  // Strip a leading "Title:"/"Title -" label.
  t = t.replace(/^\s*title\s*[:\-]\s*/i, "").trim();
  // Strip surrounding quotes / backticks (straight and curly).
  t = t.replace(/^["'`“”]+/, "").replace(/["'`“”]+$/, "").trim();
  // Collapse internal whitespace.
  t = t.replace(/\s+/g, " ");
  // Drop trailing sentence punctuation.
  t = t.replace(/[.,;:!?]+$/, "").trim();
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim();
  return t;
}

export interface GenerateTitleInput {
  orgId: string;
  userId: string;
  conversationId: string;
  tenantClass: TenantClass;
  /** Reuse the conversation's model so the connected credential path is unchanged. */
  model: string;
  firstUserMessage: string;
  firstAssistantMessage: string;
}

/**
 * Generate a concise title from the first exchange via the egress chokepoint.
 * Returns "" on any failure (empty output, model/credential error, marking
 * tripwire) so titling never breaks the message flow — the caller keeps the
 * default and may retry on a later turn.
 */
export async function generateConversationTitle(
  input: GenerateTitleInput,
): Promise<string> {
  // Cap each side so a huge first turn can't blow up the titling prompt; the
  // chokepoint still gates this content (a controlled marking ⇒ withheld body).
  const user = input.firstUserMessage.slice(0, 2000);
  const assistant = input.firstAssistantMessage.slice(0, 2000);
  const transcript = `User: ${user}\n\nAssistant: ${assistant}`;

  try {
    const reply = await runModelTurn({
      ctx: {
        orgId: input.orgId,
        userId: input.userId,
        conversationId: input.conversationId,
        turn: 0,
        tenantClass: input.tenantClass,
        mode: "enforced",
      },
      system: TITLE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Write a title for this conversation:\n\n${transcript}`,
        },
      ],
      tools: [],
      model: input.model,
      maxTokens: TITLE_MAX_TOKENS,
    });
    return cleanTitle(reply.text);
  } catch {
    return "";
  }
}
