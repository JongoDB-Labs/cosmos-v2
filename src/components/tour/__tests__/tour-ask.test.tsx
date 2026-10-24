// The walkthrough's answers must read exactly like the assistant's.
//
// They were rendered as plain text, so a list arrived as literal hyphens, bold
// as asterisks, and a table as a wall of pipes — the model formats its answers
// whether or not the surface is ready for it.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TourAsk } from "../tour-ask";
import { useAskThreads, EMPTY_THREAD } from "../ask-threads";
import type { TourStep } from "@/lib/tours/types";

const step: TourStep = {
  id: "s1",
  title: "Runway",
  blurb: "b",
  look: "l",
  asks: ["How is runway calculated?"],
};

/** One SSE frame per delta, the shape the assistant stream emits. */
function streamOf(chunks: string[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify({ delta: c })}\n`).join("");
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

/** TourAsk as the card wires it: one thread per step, held by useAskThreads. */
function Ask({ stepOverride }: { stepOverride?: TourStep } = {}) {
  const asks = useAskThreads("o1");
  const st = stepOverride ?? step;
  const key = `t:${st.id}`;
  const thread = asks.threads[key] ?? EMPTY_THREAD;
  return (
    <TourAsk
      orgId="o1"
      step={st}
      tourName="Phase health"
      thread={thread}
      onThread={(fn) => asks.update(key, fn)}
      onReset={() => asks.reset(key, thread.conversationId)}
    />
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/conversations")) {
        return { ok: true, json: async () => ({ data: { id: "c1" } }) } as unknown as Response;
      }
      return streamOf([
        "Runway is **hours left** divided by pace.\n\n",
        "- trailing four weeks\n- clipped to the phase\n",
      ]) as unknown as Response;
    }),
  );
});

describe("answers render as rich text", () => {
  it("renders markdown rather than printing its syntax", async () => {
    render(<Ask />);
    fireEvent.click(screen.getByText("How is runway calculated?"));

    await waitFor(() => expect(screen.getByText("hours left")).toBeInTheDocument());
    // Bold became an element, not asterisks around a word.
    expect(screen.getByText("hours left").tagName).toBe("STRONG");
    // The bullets became a real list.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // And none of the raw syntax survived into the text.
    expect(document.body.textContent).not.toContain("**");
  });

  it("streams deltas into one growing answer rather than repeating them", async () => {
    render(<Ask />);
    fireEvent.click(screen.getByText("How is runway calculated?"));
    await waitFor(() => expect(screen.getByText("hours left")).toBeInTheDocument());
    const text = document.body.textContent ?? "";
    // "Runway is" appears once: concatenating whole-message frames instead of
    // deltas would show it twice.
    expect(text.split("Runway is").length - 1).toBe(1);
  });
});

describe("when the assistant cannot answer", () => {
  it("says so instead of leaving an empty box", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/conversations")
          ? ({ ok: true, json: async () => ({ data: { id: "c1" } }) } as unknown as Response)
          : (streamOf([]) as unknown as Response),
      ),
    );
    render(<Ask />);
    fireEvent.click(screen.getByText("How is runway calculated?"));
    await waitFor(() =>
      expect(screen.getByText(/no answer came back/i)).toBeInTheDocument(),
    );
  });
});

// A refusal is not a hiccup. "Couldn't ask just now" invites a retry that can
// never succeed and hides a role problem behind a transient-sounding word.
it("says the role cannot use the assistant when the endpoint refuses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response),
  );
  render(<Ask />);
  fireEvent.click(screen.getByText("How is runway calculated?"));
  expect(await screen.findByText(/role cannot use the assistant/i)).toBeInTheDocument();
  expect(screen.queryByText(/just now/i)).not.toBeInTheDocument();
});

it("still reports a genuine transient failure as transient", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response));
  render(<Ask />);
  fireEvent.click(screen.getByText("How is runway calculated?"));
  expect(await screen.findByText(/just now/i)).toBeInTheDocument();
});

describe("a conversation, not one question at a time", () => {
  // Routes the assistant API by URL and method, recording what was asked.
  function api() {
    let n = 0;
    const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST" && String(url).endsWith("/conversations")) {
        n += 1;
        return { ok: true, json: async () => ({ data: { id: `c${n}` } }) } as unknown as Response;
      }
      if (method === "DELETE") return { ok: true, status: 204 } as unknown as Response;
      return streamOf([`answer ${calls.filter((c) => c.url.endsWith("/messages")).length}`]) as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, created: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/conversations")) };
  }

  async function ask(text: string) {
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: "Enter" });
  }

  it("keeps earlier questions and answers, and asks the follow-up in the same conversation", async () => {
    const { calls, created } = api();
    render(<Ask />);
    await ask("How is runway calculated?");
    expect(await screen.findByText("answer 1")).toBeInTheDocument();
    await ask("And if pace doubles?");
    expect(await screen.findByText("answer 2")).toBeInTheDocument();

    // Both turns are still on screen.
    expect(screen.getByText("How is runway calculated?", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("answer 1")).toBeInTheDocument();
    // One conversation, two messages into it.
    expect(created()).toHaveLength(1);
    const sent = calls.filter((c) => c.url.endsWith("/messages"));
    expect(sent.map((c) => c.url)).toEqual([
      "/api/v1/orgs/o1/assistant/conversations/c1/messages",
      "/api/v1/orgs/o1/assistant/conversations/c1/messages",
    ]);
    // The step's context rides with the first question only; the follow-up is
    // just the question, the conversation carries the rest.
    expect(String(sent[0].body?.content)).toContain("Context:");
    expect(sent[1].body?.content).toBe("And if pace doubles?");
  });

  it("starts over on New conversation, deleting the old one", async () => {
    const { calls, created } = api();
    render(<Ask />);
    await ask("First?");
    expect(await screen.findByText("answer 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    expect(screen.queryByText("answer 1")).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      "/api/v1/orgs/o1/assistant/conversations/c1",
    ]);
    await ask("Second?");
    expect(await screen.findByText("answer 2")).toBeInTheDocument();
    expect(created()).toHaveLength(2);
  });

  it("deletes the conversation when the card goes away", async () => {
    const { calls } = api();
    const { unmount } = render(<Ask />);
    await ask("First?");
    expect(await screen.findByText("answer 1")).toBeInTheDocument();
    unmount();
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.url)).toEqual(["/api/v1/orgs/o1/assistant/conversations/c1"]);
  });

  it("deletes it when the page goes away too", async () => {
    const { calls } = api();
    render(<Ask />);
    await ask("First?");
    expect(await screen.findByText("answer 1")).toBeInTheDocument();
    window.dispatchEvent(new Event("pagehide"));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("keeps each step's conversation to that step", async () => {
    const { calls } = api();
    const other: TourStep = { ...step, id: "s2", title: "Burn" };
    const { rerender } = render(<Ask />);
    await ask("About runway?");
    expect(await screen.findByText("answer 1")).toBeInTheDocument();
    rerender(<Ask stepOverride={other} />);
    // A fresh thread on the other step: nothing from the first shows,
    // and its first question opens its own conversation.
    expect(screen.queryByText("answer 1")).toBeNull();
    await ask("About burn?");
    expect(await screen.findByText("answer 2")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.url)).toEqual([
      "/api/v1/orgs/o1/assistant/conversations/c1/messages",
      "/api/v1/orgs/o1/assistant/conversations/c2/messages",
    ]);
    // And going back shows the first step's thread again.
    rerender(<Ask />);
    expect(screen.getByText("answer 1")).toBeInTheDocument();
  });
});
