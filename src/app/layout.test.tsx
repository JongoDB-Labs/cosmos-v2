// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "font" }) }));

import RootLayout from "./layout";

describe("root layout <head>", () => {
  // Chromium reads rel=manifest only from <head>. Streamed metadata lands in
  // <body>, so a manifest link that only comes from metadata leaves the app
  // uninstallable.
  // Next's own (streamed) copy lands in <body>, which Chromium ignores, so
  // the one in <head> is the only one it sees.
  it("carries exactly one web-app manifest link", () => {
    const html = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head.match(/<link[^>]*rel="manifest"[^>]*>/g)).toEqual([
      '<link rel="manifest" href="/manifest.webmanifest"/>',
    ]);
  });
});
