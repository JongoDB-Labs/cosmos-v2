// @vitest-environment node
//
// The spec's description and every error's `type` pointed at /developers, and
// /developers was a 404. Every in-app link the API emits has to reach a real
// page. A link the API publishes can't name a tenant, so it has to resolve
// without filling a dynamic segment: on the route tree alone, `/developers`
// "resolved" all along, as an organization called "developers".
import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { contractModules } from "../contracts.generated";
import { buildDocument, collectContracts } from "../registry";
import { problemBody } from "../problem";
import { PROBLEM_CODES, type ProblemCode } from "../problem-codes";

vi.mock("@/components/brand/runtime-brand-marker", () => ({ RuntimeBrandMarker: () => null }));

const ROOT = process.cwd();
const APP = join(ROOT, "src/app");
const ERRORS_PAGE = join(APP, "(developers)/developers/guides/errors/page.tsx");

/**
 * The file `pathname` reaches under src/app, or null. Route groups are
 * transparent. With `dynamic: false`, only static segments match.
 */
function routeFile(pathname: string, opts: { file: string; dynamic: boolean }, dir = APP): string | null {
  const [seg, ...rest] = pathname.split("/").filter(Boolean);
  const entries = readdirSync(dir, { withFileTypes: true });
  if (seg === undefined && entries.some((e) => e.isFile() && e.name === opts.file)) {
    return join(dir, opts.file);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const group = /^\(.+\)$/.test(e.name);
    const matches =
      seg !== undefined &&
      (e.name === decodeURIComponent(seg) || (opts.dynamic && /^\[[^.[\]]+\]$/.test(e.name)));
    const hit = group
      ? routeFile(pathname, opts, join(dir, e.name))
      : matches
        ? routeFile(`/${rest.join("/")}`, opts, join(dir, e.name))
        : null;
    if (hit) return hit;
  }
  return null;
}

const page = (pathname: string) => routeFile(pathname, { file: "page.tsx", dynamic: false });

/** A link the app serves: a page, or for /api/ an API route (templated ids allowed). */
function resolves(link: string): boolean {
  const pathname = link.split("#")[0];
  return pathname.startsWith("/api/")
    ? routeFile(pathname, { file: "route.ts", dynamic: true }) !== null
    : page(pathname) !== null;
}

/** Every absolute in-app path in the document's string values. */
function linksIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(/(?<![\w/.:#])\/[\w\-~%{}][\w\-.~%/{}]*(?:#[\w-]+)?/g)) {
      out.add(m[0].replace(/[.,;:]+$/, ""));
    }
  } else if (Array.isArray(value)) {
    for (const v of value) linksIn(v, out);
  } else if (value && typeof value === "object") {
    // Values only: the keys of `paths` are API templates, not links.
    for (const v of Object.values(value)) linksIn(v, out);
  }
  return out;
}

describe("the route check itself", () => {
  it("finds static pages, through route groups, and refuses a tenant-shaped match", () => {
    expect(page("/login")).not.toBeNull();
    expect(page("/")).not.toBeNull(); // (dashboard)/page.tsx
    expect(page("/no-such-page")).toBeNull();
    // Only [orgSlug] would match this.
    expect(page("/some-org/settings/api-keys")).toBeNull();
    expect(routeFile("/some-org/settings/api-keys", { file: "page.tsx", dynamic: true })).not.toBeNull();
  });
});

describe("in-app links the public API emits", () => {
  const doc = buildDocument(collectContracts(contractModules), "public") as { servers?: unknown };
  // `servers` holds the API's base URL, which is not a page.
  const links = [...linksIn({ ...doc, servers: undefined })];

  it("are found in the spec (the probe is not empty)", () => {
    expect(links).toContain("/developers");
  });

  it.each(links)("spec link %s resolves", (link) => {
    expect(resolves(link), link).toBe(true);
  });

  it.each(Object.keys(PROBLEM_CODES) as ProblemCode[])("the type of a %s error resolves", (code) => {
    const type = problemBody(400, code).type;
    expect(type).toBe(`/developers/guides/errors#${code}`);
    expect(resolves(type), type).toBe(true);
  });

  it("the errors page has an anchor for every code", async () => {
    expect(existsSync(ERRORS_PAGE), relative(ROOT, ERRORS_PAGE)).toBe(true);
    const { default: ErrorCodesPage } = (await import(/* @vite-ignore */ ERRORS_PAGE)) as {
      default: ComponentType;
    };
    const html = renderToStaticMarkup(createElement(ErrorCodesPage));
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [code, title] of Object.entries(PROBLEM_CODES)) {
      expect(ids.has(code), code).toBe(true);
      expect(html).toContain(title.replace(/'/g, "&#x27;"));
    }
    expect(ids.has("no_such_code")).toBe(false);
  });

  it("the docs pages' own links resolve", () => {
    const dirs = [join(APP, "(developers)"), join(ROOT, "src/components/developers")];
    const files = dirs.filter(existsSync).flatMap(function walk(d: string): string[] {
      return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : [],
      );
    });
    const hrefs = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]));
    expect(hrefs).toContain("/developers/guides/errors");
    for (const href of hrefs) expect(resolves(href), href).toBe(true);
    // The overview links each organization's Settings → API keys page.
    expect(readFileSync(join(APP, "(developers)/developers/page.tsx"), "utf8")).toContain("/settings/api-keys`");
    expect(routeFile("/any-org/settings/api-keys", { file: "page.tsx", dynamic: true })).toMatch(
      /\[orgSlug\][/\\]settings[/\\]api-keys[/\\]page\.tsx$/,
    );
  });
});
