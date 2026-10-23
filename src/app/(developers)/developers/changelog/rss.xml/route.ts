import { getPublicOrigin } from "@/lib/auth/public-url";
import { getBrand } from "@/lib/brand";
import { API_CHANGELOG } from "@/lib/api-changelog";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** RSS 2.0 for the API changelog. Links are absolute (feed readers need them), so it reads the request. */
export function GET(request: Request) {
  const origin = getPublicOrigin(request);
  const page = `${origin}/developers/changelog`;
  const { name } = getBrand();
  const items = API_CHANGELOG.map((e) => [
    "<item>",
    `<title>${esc(e.breaking ? `[Breaking] ${e.title}` : e.title)}</title>`,
    `<link>${esc(`${page}#${e.date}`)}</link>`,
    `<guid isPermaLink="false">cosmos-api-${esc(e.date)}</guid>`,
    `<pubDate>${new Date(`${e.date}T00:00:00Z`).toUTCString()}</pubDate>`,
    `<description>${esc(e.body)}</description>`,
    "</item>",
  ].join(""));
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${esc(`${name} API changelog`)}</title>`,
    `<link>${esc(page)}</link>`,
    `<description>${esc(`Changes to the ${name} REST API`)}</description>`,
    ...items,
    "</channel></rss>",
  ].join("\n");
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
