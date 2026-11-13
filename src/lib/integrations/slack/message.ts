import type { SlackNotifyType } from "./config";

/**
 * What a Slack notification says: a heading, the item's key as a link, and
 * its title when the reader may have it in Slack (null otherwise, and the
 * line says "Restricted"). Never a description or a comment.
 */

const HEADINGS: Record<SlackNotifyType, string> = {
  assigned: "Assigned to you",
  mentioned: "You were mentioned",
};

/** Slack mrkdwn treats &, < and > as control characters; everything else is literal text. */
export const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A URL safe inside <url|label>: no character that could end it early. */
const linkTarget = (url: string) => url.replace(/[<>|\s]/g, (c) => encodeURIComponent(c));

export function buildSlackMessage(m: { type: SlackNotifyType; key: string; title: string | null; url: string }): {
  text: string;
  blocks: unknown[];
} {
  const heading = HEADINGS[m.type];
  const key = slackEscape(m.key);
  const title = m.title === null ? "Restricted" : slackEscape(m.title.replace(/\s+/g, " ").trim().slice(0, 300));
  return {
    // The notification preview (and what a client that can't show blocks shows).
    text: `${heading}: ${key} ${title}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${heading}*\n<${linkTarget(m.url)}|${key}> ${title}` } },
    ],
  };
}
