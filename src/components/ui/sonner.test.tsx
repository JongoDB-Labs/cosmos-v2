// @vitest-environment jsdom
// Toast text must be readable (WCAG AA): each type's text uses the design
// system's -text token, which meets 4.5:1 on the toast in both themes, while
// the brighter fill colour stays on the border (and the progress bar).
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const seen = vi.hoisted(() => ({ style: {} as Record<string, string> }));
vi.mock("sonner", () => ({
  Toaster: (props: { style?: Record<string, string> }) => {
    seen.style = props.style ?? {};
    return null;
  },
}));

import { Toaster } from "./sonner";

describe("Toaster colours", () => {
  it("uses the -text tokens for text and the fills for borders", () => {
    render(<Toaster />);
    for (const [type, token] of [["success", "done"], ["error", "critical"], ["info", "progress"], ["warning", "blocked"]]) {
      expect(seen.style[`--${type}-text`]).toBe(`var(--status-${token}-text)`);
      expect(seen.style[`--${type}-border`]).toBe(`var(--status-${token})`);
    }
  });
});
