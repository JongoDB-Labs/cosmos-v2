/**
 * The bell and the Inbox page hold separate copies of the same notifications.
 * Either one, after writing (read, unread, clear), announces it; the other
 * reloads. Same tab only: other tabs catch up on their next load.
 */
const EVENT = "cosmos:notifications-changed";

/** `source` lets a listener skip its own announcement. */
export function announceNotificationsChanged(source: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { source } }));
}

/** Returns the unsubscribe. */
export function onNotificationsChanged(
  source: string,
  reload: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    if ((e as CustomEvent<{ source?: string }>).detail?.source !== source)
      reload();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
