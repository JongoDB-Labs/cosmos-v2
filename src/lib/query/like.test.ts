import { describe, expect, it } from "vitest";
import { escapeLike, likeText } from "./like";

describe("escapeLike", () => {
  it("escapes LIKE's wildcards and its escape character, and nothing else", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("snake_case")).toBe("snake\\_case");
    expect(escapeLike("C:\\temp")).toBe("C:\\\\temp");
    expect(escapeLike("plain words*")).toBe("plain words*");
  });
});

describe("likeText", () => {
  it("drops a trailing * (CQL's prefix) and escapes the rest", () => {
    expect(likeText("log*")).toBe("log");
    expect(likeText("a*b")).toBe("a*b");
    expect(likeText("10%_*")).toBe("10\\%\\_");
  });
});
