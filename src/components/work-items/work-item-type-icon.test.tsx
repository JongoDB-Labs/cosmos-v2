// @vitest-environment jsdom
//
// The Issues table read "CheckSquare Task" and "Layers Feature" — the lucide
// component NAME printed next to the type name. WorkItemType.icon is a string
// because the database cannot store a component, so rendering the field
// directly leaks it.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  WorkItemTypeIcon,
  resolveWorkItemTypeIcon,
} from "./work-item-type-icon";

afterEach(cleanup);

describe("resolveWorkItemTypeIcon", () => {
  // Asserted by rendering rather than by typeof: lucide icons are forwardRef
  // objects, so a typeof check proves nothing about whether React can mount it.
  it("resolves the names the seeds actually use", () => {
    for (const name of ["CheckSquare", "Layers", "Flag", "Bug", "Milestone"]) {
      const { container, unmount } = render(<WorkItemTypeIcon icon={name} />);
      expect(container.querySelector("svg"), name).toBeTruthy();
      unmount();
    }
  });

  it("always returns something renderable, never undefined", () => {
    // Returning undefined throws on mount; returning the raw string is what
    // produced the bug in the first place.
    for (const icon of ["NotARealLucideIcon", null, undefined]) {
      expect(resolveWorkItemTypeIcon(icon)).toBeTruthy();
      const { container, unmount } = render(<WorkItemTypeIcon icon={icon} />);
      expect(container.querySelector("svg")).toBeTruthy();
      unmount();
    }
  });
});

describe("WorkItemTypeIcon", () => {
  it("renders an svg, never the icon's name as text", () => {
    const { container } = render(<WorkItemTypeIcon icon="CheckSquare" />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).not.toContain("CheckSquare");
  });

  it("renders an svg for an unknown icon too", () => {
    const { container } = render(<WorkItemTypeIcon icon="Bogus" />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toBe("");
  });

  it("tints with the type's colour when one is set", () => {
    const { container } = render(
      <WorkItemTypeIcon icon="Flag" color="rgb(139, 92, 246)" />,
    );
    expect(container.querySelector("svg")?.getAttribute("style")).toContain(
      "rgb(139, 92, 246)",
    );
  });
});
