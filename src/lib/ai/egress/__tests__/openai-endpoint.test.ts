// An OpenAI-compatible endpoint is a URL an org admin typed in, so Cosmos
// treats it like any other outside URL: never link-local or cloud metadata, a
// private address only inside the operator's OUTBOUND_ALLOW_PRIVATE_CIDRS, no
// redirects, and an error is reported by its status alone, never by echoing
// what the endpoint sent back.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callModel } from "../provider";

const ENV = "OUTBOUND_ALLOW_PRIVATE_CIDRS";
const turn = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "m" };
const cred = (baseURL: string) => ({ kind: "openai" as const, baseURL, apiKey: "test-key", model: "m" });

let server: http.Server;
let base: string;
// A Map, not an object keyed by the request path: a path is whatever the
// client sent, and an object would take "__proto__" as a key.
const hits = new Map<string, number>();
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    req.resume();
    if (req.url === "/ok/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "hello" } }] }));
    } else if (req.url === "/stream/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      }, 30);
    } else if (req.url === "/fail/chat/completions") {
      res.writeHead(500, { "Content-Type": "text/plain" }).end("internal detail 7f3a");
    } else if (req.url === "/moved/chat/completions") {
      res.writeHead(307, { Location: "/ok/chat/completions" }).end();
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  hits.clear();
});

describe("an OpenAI-compatible endpoint", () => {
  it("is never sent to a link-local or metadata address", async () => {
    vi.stubEnv(ENV, "0.0.0.0/0");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connected"));
    for (const u of ["http://169.254.169.254/v1", "http://metadata.google.internal/v1", "http://[fd00:ec2::254]/v1"]) {
      await expect(callModel({ ...turn, credential: cred(u) })).rejects.toThrow(/never allowed|isn't public/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reaches a private address only inside the operator's ranges", async () => {
    vi.stubEnv(ENV, "");
    await expect(callModel({ ...turn, credential: cred(`${base}/ok`) })).rejects.toThrow(/isn't public/);
    expect(hits.get("/ok/chat/completions")).toBeUndefined();
    // Control: the same endpoint answers once the operator lists the range.
    vi.stubEnv(ENV, "127.0.0.0/8");
    const r = await callModel({ ...turn, credential: cred(`${base}/ok`) });
    expect(r.text).toBe("hello");
    expect(hits.get("/ok/chat/completions")).toBe(1);
  });

  it("streams through the same checks", async () => {
    vi.stubEnv(ENV, "127.0.0.0/8");
    const deltas: string[] = [];
    const r = await callModel({ ...turn, credential: cred(`${base}/stream`), onTextDelta: (d: string) => deltas.push(d) });
    expect(deltas).toEqual(["hel", "lo"]);
    expect(r.text).toBe("hello");
  });

  it("reports an error by its status, never the body the endpoint sent", async () => {
    vi.stubEnv(ENV, "127.0.0.0/8");
    const err = await callModel({ ...turn, credential: cred(`${base}/fail`) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/500/);
    expect((err as Error).message).not.toContain("7f3a");
  });

  it("does not follow a redirect", async () => {
    vi.stubEnv(ENV, "127.0.0.0/8");
    await expect(callModel({ ...turn, credential: cred(`${base}/moved`) })).rejects.toThrow(/307/);
    expect(hits.get("/moved/chat/completions")).toBe(1);
    expect(hits.get("/ok/chat/completions")).toBeUndefined();
  });
});
