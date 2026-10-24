// @vitest-environment jsdom
// A SectionCard sits directly under the page's h1, so its title is an h2 by
// default (an h3 there skips a level: axe heading-order). Nested in a section
// with its own h2, it can be an h3.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Settings } from "lucide-react";
import { SectionCard } from "./section-card";

afterEach(cleanup);

describe("SectionCard", () => {
  it("titles itself with an h2 by default", () => {
    render(<SectionCard icon={Settings} title="Outlook calendar" description="d">x</SectionCard>);
    expect(screen.getByRole("heading", { level: 2, name: "Outlook calendar" })).toBeTruthy();
  });

  it("takes level 3 when nested under a section of its own", () => {
    render(<SectionCard icon={Settings} title="Nested" description="d" level={3}>x</SectionCard>);
    expect(screen.getByRole("heading", { level: 3, name: "Nested" })).toBeTruthy();
  });
});
