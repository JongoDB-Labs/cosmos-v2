import { webhookUrlSchema } from "@/lib/security/webhook-url";
import { requestPublicUrl } from "@/lib/security/outbound-post.server";
import { z } from "zod";
import type { ToolContext } from "./_ctx";

const fetchUrlSchema = z.object({
  url: webhookUrlSchema,
});

const MAX_BYTES = 1_000_000; // characters kept: about 1 MB
const TIMEOUT_MS = 30_000;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML entities, decoded in one pass (so "&amp;lt;" is "&lt;", not "<"). */
function decodeEntities(s: string): string {
  return s.replace(/&(?:([a-z]+)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi, (m, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/**
 * Naive HTML → text. Drops `<script>` / `<style>` blocks and comments, then
 * decodes entities, then strips tags until nothing changes, and collapses
 * whitespace. Decoding comes BEFORE stripping, and stripping repeats: an
 * encoded "&lt;img onerror&gt;" would otherwise come out as a real tag, and
 * removing one tag can join two halves into another ("<scr<script>ipt>").
 * Good enough for "give the model the gist" — we are not trying to be a
 * perfect renderer.
 */
export function stripHtmlToText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  s = decodeEntities(s);
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<[^<>]*>/g, " ");
  }
  return s.replace(/\s+/g, " ").trim();
}

export async function fetchUrl(
  input: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: ToolContext
) {
  const parsed = fetchUrlSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { url } = parsed.data;

  try {
    // Through the same path as a webhook delivery: every address the name
    // resolves to must be public, the connection is pinned to the address
    // checked, and a redirect is returned, never followed (its target could
    // be anywhere).
    const res = await requestPublicUrl(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "cosmos-saas/1.0 (+ai-tool)",
      },
      maxBody: MAX_BYTES,
      timeoutMs: TIMEOUT_MS,
    });

    if (res.status >= 300 && res.status < 400) {
      return {
        error: `Refused to follow redirect (status ${res.status}). Resolve the final URL yourself and re-fetch.`,
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return { error: `HTTP ${res.status} ${res.statusText}`.trim(), status: res.status };
    }

    const header = res.headers["content-type"];
    const contentType = (Array.isArray(header) ? header[0] : header ?? "").toLowerCase();
    const raw = res.body;

    const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw);
    const text = isHtml ? stripHtmlToText(raw) : raw;

    return {
      url,
      status: res.status,
      contentType: contentType || null,
      bytes: raw.length,
      truncated: res.truncated,
      text,
    };
  } catch (err) {
    return { error: `Fetch failed: ${(err as Error).message}` };
  }
}
