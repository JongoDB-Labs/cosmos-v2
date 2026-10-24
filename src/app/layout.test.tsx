// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "font" }) }));

import RootLayout from "./layout";

describe("root layout <head>", () => {
  // Chromium reads rel=manifest only from <head>. Streamed metadata lands in
  // <body>, so a manifest link that only comes from metadata leaves the app
  // uninstallable (COSMOS-230).
  it("carries the web-app manifest link", () => {
    const html = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
  });
});
