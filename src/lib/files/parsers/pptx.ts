import { unzipSync, strFromU8 } from "fflate";
import type { DocumentParser, ParsedBlock } from "./types";

export const pptxParser: DocumentParser = {
  formats: ["pptx"],
  async parse(buf) {
    const files = unzipSync(new Uint8Array(buf));
    const slideNames = Object.keys(files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
    const blocks: ParsedBlock[] = [];
    slideNames.forEach((name, i) => {
      const xml = strFromU8(files[name]);
      // Each <a:p> is a paragraph; its <a:t> runs are the text. Runs may carry
      // attributes (e.g. <a:t xml:space="preserve">) — match the open tag loosely.
      const paras = (xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || [])
        .map((p) => [...p.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(""))
        .map((s) =>
          s
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#0*39;|&apos;/g, "'")
            .trim(),
        )
        .filter(Boolean);
      if (paras.length) {
        blocks.push({ kind: "HEADING", level: 2, text: paras[0] || `Slide ${i + 1}`, page: i + 1 });
        for (const p of paras.slice(1)) blocks.push({ kind: "PARAGRAPH", text: p, page: i + 1 });
      } else {
        blocks.push({ kind: "HEADING", level: 2, text: `Slide ${i + 1}`, page: i + 1 });
      }
    });
    return { blocks, pageCount: slideNames.length };
  },
};
