// @vitest-environment jsdom
// COSMOS-196 — PageTransition looked up `React.unstable_ViewTransition`, which
// React 19.3 does not export, and fell back to a fragment passthrough, so route
// navigations never cross-faded. Rendering can't tell the two apart (both just
// show the children), so this asserts on the element type: it must be React's
// real <ViewTransition>, carrying the transition name.
import { describe, it, expect } from "vitest";
import { ViewTransition } from "react";
import { render, screen } from "@testing-library/react";
import { PageTransition } from "./page-transition";

describe("PageTransition", () => {
  it("wraps children in React's ViewTransition, not a passthrough", () => {
    const el = PageTransition({ children: "content" });
    expect(ViewTransition).toBeDefined();
    expect(el.type).toBe(ViewTransition);
    expect(el.props).toMatchObject({ name: "page", children: "content" });
  });

  it("forwards a custom transition name", () => {
    expect(PageTransition({ children: null, name: "detail" }).props).toMatchObject({
      name: "detail",
    });
  });

  it("renders its children", () => {
    render(
      <PageTransition>
        <p>hello</p>
      </PageTransition>,
    );
    expect(screen.getByText("hello")).toBeTruthy();
  });
});
