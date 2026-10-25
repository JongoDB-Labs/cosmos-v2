/**
 * The email a filter subscription sends (query design §6.6, §12.4). Email is
 * egress, so what goes in it is decided here and nowhere else:
 *
 *   - Titles only when the org allows them (`cqlEmailTitles`: off by default
 *     for GOV, on for COMMERCIAL); otherwise ticket keys and links.
 *   - A title or filter name carrying a controlled marking is replaced, never
 *     sent (`detectMarkings`, the same tripwire the model egress uses).
 *   - Never descriptions or comments. At most 50 rows, then "View all N".
 *
 * Pure: the run (subscriptions.server.ts) passes in the rows it already
 * scoped to the recipient.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { detectMarkings } from "@/lib/classification/markings";

export const EMAIL_MAX_ROWS = 50;
export const MARKED = "[marked — open in Cosmos]";

export interface EmailRow {
  id: string;
  ticketKey: string;
  title: string;
  columnKey: string;
}

export interface SubscriptionEmailInput {
  filterName: string;
  origin: string;
  orgSlug: string;
  viewId: string;
  rows: EmailRow[];
  /** Every match (null when counting ran out of time). */
  total: number | null;
  /** Only rows new since the last send. */
  onlyChanges: boolean;
  format: "LIST" | "COUNT";
  includeTitles: boolean;
  /** "you subscribed" vs. "your team Platform is subscribed". */
  reason: string;
  unsubscribeUrl: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const safe = (s: string, fallback: string) => (detectMarkings(s) ? fallback : s);

export function buildSubscriptionEmail(i: SubscriptionEmailInput): { subject: string; text: string; html: string } {
  const name = safe(i.filterName, "Saved filter");
  const base = `${i.origin}/${i.orgSlug}`;
  const viewAll = `${base}/issues?filter=${encodeURIComponent(i.viewId)}`;
  const n = i.onlyChanges ? i.rows.length : i.total;
  const count = n === null ? `${i.rows.length}+` : String(n);
  const noun = `${count} ${i.onlyChanges ? "new " : ""}item${n === 1 ? "" : "s"}`;
  const subject = `${name}: ${noun}`;

  const shown = i.format === "LIST" ? i.rows.slice(0, EMAIL_MAX_ROWS) : [];
  const line = (r: EmailRow) => (i.includeTitles ? `${r.ticketKey}  ${safe(r.title, MARKED)}` : r.ticketKey);
  const itemUrl = (r: EmailRow) => `${base}/issues?item=${encodeURIComponent(r.id)}`;
  const more = i.format === "LIST" && (n === null || n > shown.length);

  const text = [
    `${name}: ${noun}.`,
    "",
    ...shown.map((r) => `- ${line(r)}  ${itemUrl(r)}`),
    ...(shown.length ? [""] : []),
    `${more || i.format === "COUNT" ? `View all ${count}` : "Open the filter"}: ${viewAll}`,
    "",
    `You get this because ${i.reason}. Unsubscribe: ${i.unsubscribeUrl}`,
  ].join("\n");

  const rowsHtml = shown
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;"><a href="${escapeHtml(itemUrl(r))}">${escapeHtml(r.ticketKey)}</a></td>` +
        (i.includeTitles ? `<td style="padding:4px 0;">${escapeHtml(safe(r.title, MARKED))}</td>` : "") +
        `</tr>`,
    )
    .join("");
  const html = [
    `<p><strong>${escapeHtml(name)}</strong>: ${escapeHtml(noun)}.</p>`,
    rowsHtml ? `<table style="border-collapse:collapse;font-size:14px;">${rowsHtml}</table>` : "",
    `<p><a href="${escapeHtml(viewAll)}">${more || i.format === "COUNT" ? `View all ${escapeHtml(count)} in Cosmos` : "Open the filter in Cosmos"}</a></p>`,
    `<p style="color:#666;font-size:12px;">You get this because ${escapeHtml(i.reason)}. <a href="${escapeHtml(i.unsubscribeUrl)}">Unsubscribe</a></p>`,
  ].join("\n");
  return { subject, text, html };
}

/**
 * An unsubscribe token: `<subscriptionId>.<userId>.<mac>`, the MAC keyed by
 * the subscription's own random key. It works without a session, names one
 * person on one subscription, and dies with the subscription.
 */
export function unsubscribeToken(key: string, subscriptionId: string, userId: string): string {
  return `${subscriptionId}.${userId}.${mac(key, subscriptionId, userId)}`;
}

function mac(key: string, subscriptionId: string, userId: string): string {
  return createHmac("sha256", key).update(`filter-unsubscribe:${subscriptionId}:${userId}`).digest("base64url");
}

export function parseUnsubscribeToken(token: string): { subscriptionId: string; userId: string; mac: string } | null {
  const m = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  return m ? { subscriptionId: m[1], userId: m[2], mac: m[3] } : null;
}

export function verifyUnsubscribeMac(key: string, t: { subscriptionId: string; userId: string; mac: string }): boolean {
  const want = Buffer.from(mac(key, t.subscriptionId, t.userId));
  const got = Buffer.from(t.mac);
  return want.length === got.length && timingSafeEqual(want, got);
}
