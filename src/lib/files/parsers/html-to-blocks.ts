import { parse } from "node-html-parser";
import type { ParsedBlock } from "./types";

/** Convert a clean HTML fragment (e.g. mammoth's docx output) into ordered blocks. */
export function htmlToBlocks(html: string): ParsedBlock[] {
  const root = parse(html);
  const out: ParsedBlock[] = [];
  for (const el of root.childNodes) {
    const node = el as unknown as { tagName?: string; text?: string; innerHTML?: string };
    const tag = (node.tagName || "").toLowerCase();
    const text = (node.text || "").trim();
    if (!tag) continue;
    if (/^h[1-6]$/.test(tag)) out.push({ kind: "HEADING", level: Number(tag[1]), text });
    else if (tag === "p" && text) out.push({ kind: "PARAGRAPH", text });
    else if (tag === "ul" || tag === "ol") out.push({ kind: "LIST", text, html: node.innerHTML });
    else if (tag === "table") {
      const rows = parse(node.innerHTML || "")
        .querySelectorAll("tr")
        .map((tr) => tr.querySelectorAll("td,th").map((c) => c.text.trim()));
      out.push({ kind: "TABLE", text: rows.map((r) => r.join(" | ")).join("\n"), data: { rows } });
    } else if (tag === "blockquote" && text) out.push({ kind: "QUOTE", text });
    else if (text) out.push({ kind: "PARAGRAPH", text });
  }
  return out;
}
