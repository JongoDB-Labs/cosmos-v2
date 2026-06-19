// @vitest-environment node
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { SKIN_COOKIE } from "@/lib/theme/cookie";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/skin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
describe("POST /api/skin", () => {
  it("sets the cookie for a valid skin", async () => {
    const res = await POST(req({ skin: "atelier" }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SKIN_COOKIE)?.value).toBe("atelier");
  });
  it("clears the cookie for null", async () => {
    const res = await POST(req({ skin: null }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SKIN_COOKIE)?.value).toBe("");
  });
  it("400 on an unknown skin", async () => {
    const res = await POST(req({ skin: "bogus" }));
    expect(res.status).toBe(400);
  });
});
