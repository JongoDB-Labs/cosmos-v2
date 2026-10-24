/**
 * COSMOS-202 T1: what Cosmos shows inside Teams, as Adaptive Cards (1.5, the
 * version Teams renders). Pure, so the shapes are tested without a server.
 *
 * A card can be forwarded anywhere in Teams once it's posted, so what goes in
 * one is decided here, not by the caller: a restricted item's card carries its
 * key and the word "Restricted", never its title, status or people.
 */

export interface ItemSummary {
  ref: string;
  title: string;
  status: string;
  type: string;
  project: string;
  assignee: string | null;
  url: string;
}

type Card = Record<string, unknown>;
export interface Attachment {
  contentType: string;
  content: Card;
  preview?: { contentType: string; content: Card };
}

const ADAPTIVE = "application/vnd.microsoft.card.adaptive";
const THUMBNAIL = "application/vnd.microsoft.card.thumbnail";
const base = (body: Card[], actions: Card[] = []): Card => ({
  type: "AdaptiveCard",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  version: "1.5",
  body,
  ...(actions.length ? { actions } : {}),
});
const open = (title: string, url: string): Card => ({ type: "Action.OpenUrl", title, url });

/** "in_progress" -> "In progress": the board column key, readable. */
export function statusLabel(columnKey: string): string {
  const s = columnKey.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : columnKey;
}

export function itemCard(i: ItemSummary): Attachment {
  return {
    contentType: ADAPTIVE,
    content: base(
      [
        { type: "TextBlock", text: `${i.ref} · ${i.type}`, size: "Small", isSubtle: true, wrap: true },
        { type: "TextBlock", text: i.title, weight: "Bolder", size: "Medium", wrap: true },
        {
          type: "FactSet",
          facts: [
            { title: "Status", value: i.status },
            { title: "Assignee", value: i.assignee ?? "Unassigned" },
            { title: "Project", value: i.project },
          ],
        },
      ],
      [open("Open in Cosmos", i.url)],
    ),
    preview: { contentType: THUMBNAIL, content: { title: `${i.ref} ${i.title}`, text: `${i.status} · ${i.assignee ?? "Unassigned"}` } },
  };
}

/** A classified item: its key, and nothing that came from inside it. */
export function restrictedCard(ref: string, url: string): Attachment {
  return {
    contentType: ADAPTIVE,
    content: base(
      [
        { type: "TextBlock", text: ref, weight: "Bolder", wrap: true },
        { type: "TextBlock", text: "Restricted. Open it in Cosmos to see it.", isSubtle: true, wrap: true },
      ],
      [open("Open in Cosmos", url)],
    ),
    preview: { contentType: THUMBNAIL, content: { title: ref, text: "Restricted" } },
  };
}

/** One line of a T2 update: an item's key, title and link; no title when it's restricted. */
export interface UpdateLine {
  ref: string;
  url: string;
  /** Absent for a restricted item, which then reads "Restricted". */
  title?: string;
  /** A fixed label of ours ("New", "Status changed"), never the item's text. */
  note?: string;
}

/**
 * COSMOS-202 T2: what the bot posts to a chat or channel. A heading of ours,
 * then per item its key, title and a link, and nothing else: no description,
 * comment, status, people or dates ever go to Teams this way.
 */
export function updateCard(heading: string, lines: UpdateLine[]): Attachment {
  return {
    contentType: ADAPTIVE,
    content: base([
      { type: "TextBlock", text: heading, weight: "Bolder", wrap: true },
      ...lines.map((l) => ({
        type: "Container",
        separator: true,
        selectAction: open("Open in Cosmos", l.url),
        items: [
          { type: "TextBlock", text: l.note ? `${l.ref} · ${l.note}` : l.ref, size: "Small", isSubtle: true, wrap: true },
          { type: "TextBlock", text: l.title ?? "Restricted", wrap: true, ...(l.title ? {} : { isSubtle: true }) },
        ],
      })),
    ], lines.length === 1 ? [open("Open in Cosmos", lines[0].url)] : []),
  };
}

/** For a Teams user we can't match to a Cosmos account: how to fix that, and nothing else. */
export function connectCard(preferencesUrl: string): Attachment {
  return {
    contentType: ADAPTIVE,
    content: base(
      [
        { type: "TextBlock", text: "Connect your Cosmos account", weight: "Bolder", wrap: true },
        {
          type: "TextBlock",
          wrap: true,
          text: "Cosmos doesn't know who you are in Teams yet. In Cosmos, open Settings, Preferences and connect Outlook Calendar with your work account, then try again.",
        },
      ],
      [open("Open Cosmos settings", preferencesUrl)],
    ),
    preview: { contentType: THUMBNAIL, content: { title: "Connect your Cosmos account", text: "Then try again." } },
  };
}

export interface CreateFormArgs {
  projects: { id: string; label: string }[];
  types: { key: string; name: string }[];
  title: string;
  description: string;
  error?: string;
  values?: { projectId?: string; type?: string };
}

/** The "Create Cosmos item" form, prefilled from the message. */
export function createForm(a: CreateFormArgs): Card {
  const body: Card[] = [];
  if (a.error) body.push({ type: "TextBlock", text: a.error, color: "Attention", wrap: true });
  body.push(
    {
      type: "Input.ChoiceSet", id: "projectId", label: "Project", isRequired: true, errorMessage: "Pick a project",
      value: a.values?.projectId ?? a.projects[0]?.id,
      choices: a.projects.map((p) => ({ title: p.label, value: p.id })),
    },
    {
      type: "Input.ChoiceSet", id: "type", label: "Type", isRequired: true,
      value: a.values?.type ?? (a.types.find((t) => t.key === "task") ?? a.types[0])?.key,
      choices: a.types.map((t) => ({ title: t.name, value: t.key })),
    },
    { type: "Input.Text", id: "title", label: "Title", isRequired: true, maxLength: 500, errorMessage: "A title is needed", value: a.title },
    { type: "Input.Text", id: "description", label: "Description", isMultiline: true, value: a.description },
  );
  return base(body, [{ type: "Action.Submit", title: "Create" }]);
}

/** A message for the task module, where a form can't help (no projects, say). */
export function noticeCard(title: string, text: string): Card {
  return base([
    { type: "TextBlock", text: title, weight: "Bolder", wrap: true },
    { type: "TextBlock", text, wrap: true },
  ]);
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML entities, decoded in one pass (so "&amp;lt;" is "&lt;", not "<"). */
function decodeEntities(s: string): string {
  return s.replace(/&(?:([a-z]+)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi, (m, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/**
 * Teams' message HTML, as plain text for a description. Entities are decoded
 * FIRST and tags stripped after, repeatedly until nothing changes: decoding
 * can turn text into a tag ("&lt;img onerror&gt;"), and removing one tag can
 * join two halves into another ("<scr<script>ipt>"). What comes out has no
 * "<...>" left in it at all, and is stored as plain text.
 */
export function messageText(html: string): string {
  // Line breaks while the tags are still Teams' own.
  let s = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
  s = decodeEntities(s);
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<[^<>]*>/g, "");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
