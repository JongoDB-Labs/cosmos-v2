import { describe, it, expect } from "vitest";
import { detectVideoProvider } from "./video";

describe("detectVideoProvider", () => {
  it("detects Google Meet", () => {
    expect(detectVideoProvider("https://meet.google.com/abc-defg-hij")).toBe("GOOGLE_MEET");
  });
  it("detects Zoom (incl. subdomains)", () => {
    expect(detectVideoProvider("https://us02web.zoom.us/j/123")).toBe("ZOOM");
    expect(detectVideoProvider("https://zoom.us/j/123")).toBe("ZOOM");
  });
  it("detects Teams", () => {
    expect(detectVideoProvider("https://teams.microsoft.com/l/meetup-join/xyz")).toBe("TEAMS");
    expect(detectVideoProvider("https://teams.live.com/meet/123")).toBe("TEAMS");
  });
  it("falls back to OTHER for unknown / invalid", () => {
    expect(detectVideoProvider("https://whereby.com/room")).toBe("OTHER");
    expect(detectVideoProvider("not a url")).toBe("OTHER");
  });
});
