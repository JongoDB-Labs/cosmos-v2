import { describe, it, expect, vi, beforeEach } from "vitest";
import { FetchError } from "@/lib/query/json-fetcher";

const errorSpy = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => errorSpy(...args) },
}));

import { notifyError } from "./notify";

describe("notifyError", () => {
  beforeEach(() => errorSpy.mockClear());

  it("shows the server-provided message for a FetchError (jsonFetch)", () => {
    notifyError(
      new FetchError(400, { error: "Name is required" }, "Name is required"),
      "fallback",
    );
    expect(errorSpy).toHaveBeenCalledWith("Name is required");
  });

  it("shows the friendly fallback for a generic Error (raw-fetch 'HTTP 500' guard)", () => {
    notifyError(new Error("HTTP 500"), "Couldn't save your changes.");
    expect(errorSpy).toHaveBeenCalledWith("Couldn't save your changes.");
  });

  it("shows the fallback for non-Error throws", () => {
    notifyError("boom", "Couldn't save your changes.");
    expect(errorSpy).toHaveBeenCalledWith("Couldn't save your changes.");
  });

  it("uses the default fallback when none is given", () => {
    notifyError(new Error("HTTP 500"));
    expect(errorSpy).toHaveBeenCalledWith(
      "Something went wrong. Please try again.",
    );
  });
});
