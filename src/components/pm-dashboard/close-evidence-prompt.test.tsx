// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { FetchError } from "@/lib/query/json-fetcher";
import { useCloseEvidencePrompt } from "./close-evidence-prompt";

afterEach(cleanup);

const refusal = () => new FetchError(422, { code: "close_evidence_required", error: "needs a file" }, "needs a file");

function Harness({ send }: { send: (extra: { closeEvidenceNote?: string }) => Promise<string> }) {
  const { withEvidence, dialog } = useCloseEvidencePrompt();
  const [out, setOut] = useState("");
  return (
    <>
      <button onClick={() => withEvidence(send).then(setOut, (e: Error) => setOut(`error: ${e.message}`))}>go</button>
      <output data-testid="out">{out}</output>
      {dialog}
    </>
  );
}

describe("useCloseEvidencePrompt", () => {
  it("on close_evidence_required, asks for the reason and retries with it", async () => {
    const seen: unknown[] = [];
    const send = async (extra: { closeEvidenceNote?: string }) => {
      seen.push(extra);
      if (!extra.closeEvidenceNote) throw refusal();
      return "saved";
    };
    render(<Harness send={send} />);
    fireEvent.click(screen.getByText("go"));
    const box = await screen.findByLabelText("Reason no file is needed");
    fireEvent.change(box, { target: { value: "  Accepted at review  " } });
    fireEvent.click(screen.getByText("Record and close"));
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("saved"));
    expect(seen).toEqual([{}, { closeEvidenceNote: "Accepted at review" }]);
  });

  it("cancelling hands back the original refusal", async () => {
    render(<Harness send={async () => { throw refusal(); }} />);
    fireEvent.click(screen.getByText("go"));
    await screen.findByLabelText("Reason no file is needed");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("error: needs a file"));
  });

  it("any other error passes straight through, with no prompt", async () => {
    render(<Harness send={async () => { throw new FetchError(500, { code: "internal_error" }, "boom"); }} />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("error: boom"));
    expect(screen.queryByLabelText("Reason no file is needed")).toBeNull();
  });
});
