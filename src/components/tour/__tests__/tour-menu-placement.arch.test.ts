import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const layout = readFileSync(join(root, "src/app/(dashboard)/layout.tsx"), "utf8");
const shell = readFileSync(join(root, "src/components/layouts/dashboard-shell.tsx"), "utf8");
const topbar = readFileSync(join(root, "src/components/layouts/topbar.tsx"), "utf8");

// The top bar's Walkthroughs menu decides what to offer from the enabled-plugins
// context. It sat OUTSIDE that context (the provider wrapped only the page), so
// it always saw no plugin enabled and never appeared for a plugin's walkthrough,
// while the closing toast told people to "reopen it from Walkthroughs in the top
// bar". A reader who closed or lost the card had no way back.
describe("the Walkthroughs menu can see which plugins are enabled", () => {
  it("is in the top bar, which the shell renders", () => {
    expect(topbar).toContain("<TourMenu />");
    expect(shell).toMatch(/<Topbar\b/);
  });

  it("has the shell, top bar included, inside the enabled-plugins provider", () => {
    const open = layout.indexOf("<PluginEnablementProvider");
    const close = layout.indexOf("</PluginEnablementProvider>");
    const shellOpen = layout.indexOf("<DashboardShell");
    const shellClose = layout.indexOf("</DashboardShell>");
    expect(open).toBeGreaterThan(-1);
    expect(shellOpen).toBeGreaterThan(-1);
    expect(open).toBeLessThan(shellOpen);
    expect(close).toBeGreaterThan(shellClose);
  });
});
