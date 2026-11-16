"use client";
import { toast } from "sonner";
import { FetchError } from "@/lib/query/json-fetcher";

/**
 * Surface a failed user action as an error toast — the project-wide convention
 * for telling the user that a save/delete/update did NOT happen.
 *
 * Shows the server-provided message ONLY for a `FetchError` (thrown by
 * `jsonFetch`, or built by `fetchErrorOf` for code that calls `fetch` itself,
 * where `.message` is the API's own reason). For anything else, and for a
 * FetchError the server gave no reason for, the friendly `fallback` is shown
 * instead of a technical string. So a raw fetch must throw
 * `await fetchErrorOf(res)`, never `new Error(...)`: a plain Error hides the
 * server's reason behind the fallback.
 *
 *   try { await jsonFetch(...) } catch (err) { notifyError(err, "Couldn't save the note."); }
 *   if (!res.ok) throw await fetchErrorOf(res);
 */
export function notifyError(
  err: unknown,
  fallback = "Something went wrong. Please try again.",
) {
  const msg =
    err instanceof FetchError && err.message.trim() ? err.message : fallback;
  toast.error(msg);
}
