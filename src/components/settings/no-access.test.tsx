// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NoAccess } from "./no-access";

afterEach(cleanup);

describe("NoAccess", () => {
  it("renders the standard denied message with the subject", () => {
    render(<NoAccess what="audit logs" />);
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.getByText(/audit logs/i)).toBeInTheDocument();
  });
});
