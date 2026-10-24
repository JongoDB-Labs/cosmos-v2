"use client";

import { useCallback, useRef, useState } from "react";
import { TransitionDialog, type TransitionInput } from "@/components/work-items/transition-dialog";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { asTransitionError, type TransitionErrorBody } from "@/lib/workflow/contract";
import type { CustomField } from "@/types/models";

interface Pending {
  refusal: TransitionErrorBody;
  resolve: (input: TransitionInput | null) => void;
}

/**
 * The one way a surface turns "this move needs more from you" into a dialog.
 *
 * `ask(refusal)` opens the TransitionDialog with the fields the server asked
 * for and resolves with what the person entered, or null if they backed out:
 * the caller then retries its change with `transition: { id, input }`, or
 * rolls back. Render `dialog` once in the surface.
 */
export function useTransitionPrompt(customFields?: readonly CustomField[]) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef<Pending | null>(null);

  const settle = useCallback((input: TransitionInput | null) => {
    const p = current.current;
    current.current = null;
    setPending(null);
    setSaving(false);
    p?.resolve(input);
  }, []);

  const ask = useCallback((refusal: TransitionErrorBody) => {
    // A second refusal while one is open replaces it; the first backs out.
    current.current?.resolve(null);
    return new Promise<TransitionInput | null>((resolve) => {
      const p = { refusal, resolve };
      current.current = p;
      setPending(p);
    });
  }, []);

  const dialog = (
    <TransitionDialog
      open={pending !== null}
      transition={pending?.refusal.transition ?? (pending ? { id: "", name: "Change status" } : null)}
      fields={pending?.refusal.fields ?? []}
      customFields={customFields}
      pending={saving}
      onSubmit={(input) => {
        setSaving(true);
        settle(input);
      }}
      onClose={() => settle(null)}
    />
  );

  return { ask, dialog };
}

/**
 * Read a failed change's response. A workflow refusal comes back as its body,
 * anything else as a FetchError carrying the server's message for notifyError.
 */
export async function refusalOf(res: Response): Promise<{ refusal: TransitionErrorBody | null; error: FetchError }> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const refusal = asTransitionError(body);
  const message =
    refusal?.error ?? (body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "");
  return { refusal, error: new FetchError(res.status, body, message) };
}

/** Thrown when someone backs out of a transition's dialog: revert, but say nothing. */
export class TransitionBackedOut extends Error {
  constructor() {
    super("backed out");
    this.name = "TransitionBackedOut";
  }
}

/**
 * PUT one item's change; when the workflow asks for details, ask and send it
 * again with them. Resolves with the response body; throws a FetchError with the
 * server's message on a refusal, or TransitionBackedOut if the person backed out.
 */
export async function sendItemChange<T = unknown>(
  url: string,
  body: Record<string, unknown>,
  ask: (refusal: TransitionErrorBody) => Promise<TransitionInput | null>,
): Promise<T> {
  const put = (transition?: { id?: string; input: TransitionInput }) =>
    jsonFetch<T>(url, { method: "PUT", body: JSON.stringify({ ...body, ...(transition && { transition }) }) });
  try {
    return await put();
  } catch (err) {
    const refusal = err instanceof FetchError ? asTransitionError(err.body) : null;
    if (refusal?.code !== "transition_input_required") throw err;
    const input = await ask(refusal);
    if (!input) throw new TransitionBackedOut();
    return put({ id: refusal.transition?.id, input });
  }
}
