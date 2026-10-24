import { webhookUrlSchema } from "@/lib/security/webhook-url";
import { z } from "zod";
import type { ToolContext } from "./_ctx";

const fetchUrlSchema = z.object({
  url: webhookUrlSchema,
});

const MAX_BYTES = 1_000_000; // 1 MB
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

/**
 * Read at most `MAX_BYTES` from the response stream. Aborts the underlying
 * controller once the cap is hit so we don't keep buffering megabytes.
 */
async function readCapped(
  res: Response,
  controller: AbortController
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_BYTES) {
      return { text: text.slice(0, MAX_BYTES), truncated: true };
    }
    return { text, truncated: false };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > MAX_BYTES) {
        const remaining = MAX_BYTES - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = MAX_BYTES;
        truncated = true;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  for (const c of chunks) text += decoder.decode(c, { stream: true });
  text += decoder.decode();
  return { text, truncated };
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "cosmos-saas/1.0 (+ai-tool)",
      },
    });

    // `redirect: "manual"` surfaces redirect responses as opaque (status 0)
    // OR as a real status with a Location header depending on the runtime.
    // Either way, refuse to follow — the redirect target might point at a
    // private host, and re-validating it would mean re-running the SSRF
    // gate which we don't bother with here.
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      return {
        error: `Refused to follow redirect (status ${res.status || "opaque"}). Resolve the final URL yourself and re-fetch.`,
      };
    }

    if (!res.ok) {
      return { error: `HTTP ${res.status} ${res.statusText}`, status: res.status };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const { text: raw, truncated } = await readCapped(res, controller);

    const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw);
    const text = isHtml ? stripHtmlToText(raw) : raw;

    return {
      url,
      status: res.status,
      contentType: contentType || null,
      bytes: raw.length,
      truncated,
      text,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { error: `Request aborted (timeout ${TIMEOUT_MS}ms or size cap ${MAX_BYTES}b)` };
    }
    return { error: `Fetch failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
