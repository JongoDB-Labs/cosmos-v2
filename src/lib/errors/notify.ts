"use client";
import { toast } from "sonner";
import { FetchError } from "@/lib/query/json-fetcher";

/**
 * Surface a failed user action as an error toast — the project-wide convention
 * for telling the user that a save/delete/update did NOT happen.
 *
 * Shows the server-provided message ONLY for a `FetchError` (thrown by
 * `jsonFetch`, where `.message` is the API's human error). For anything else —
 * including the generic `throw new Error("HTTP 500")` guards on raw fetches —
 * the friendly `fallback` is shown instead of a technical string.
 *
 *   try { await jsonFetch(...) } catch (err) { notifyError(err, "Couldn't save the note."); }
 */
export function notifyError(
  err: unknown,
  fallback = "Something went wrong. Please try again.",
) {
  const msg =
    err instanceof FetchError && err.message.trim() ? err.message : fallback;
  toast.error(msg);
}
