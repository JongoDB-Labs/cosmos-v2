"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Elects one tab per browser as the leader for a given channel name. The
 * leader holds an exclusive Web Lock for the duration of its lifetime; when
 * it goes away, the next-waiting tab acquires the lock and becomes leader.
 *
 * Returns:
 *   - isLeader: true exactly in one tab per `channelName` per browser.
 *   - bcRef: a stable ref whose `.current` holds a BroadcastChannel ready to
 *     send/receive across tabs in this browser. The ref is populated before
 *     any lock callback fires so it is always non-null after mount.
 *
 * Falls back to "every tab is its own leader" if Web Locks aren't supported
 * (older browsers) — degraded but functional.
 */
export function useBroadcastChannelLeader(channelName: string): {
  isLeader: boolean;
  bcRef: React.RefObject<BroadcastChannel | null>;
} {
  const [isLeader, setIsLeader] = useState(false);
  const bcRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const channel = new BroadcastChannel(channelName);
    bcRef.current = channel;

    let alive = true;
    let release: (() => void) | null = null;

    if ("locks" in navigator) {
      navigator.locks
        .request(
          `cosmos-lock-${channelName}`,
          { mode: "exclusive" },
          () =>
            new Promise<void>((resolve) => {
              if (!alive) {
                resolve();
                return;
              }
              setIsLeader(true);
              release = () => {
                setIsLeader(false);
                resolve();
              };
            }),
        )
        .catch(() => {
          /* lock acquisition failed — stay follower */
        });
    } else {
      // Fallback: every tab acts as its own leader.
      // queueMicrotask defers the setState out of the synchronous effect body
      // so the lint rule (no sync setState in effects) is satisfied.
      queueMicrotask(() => {
        if (alive) setIsLeader(true);
      });
    }

    return () => {
      alive = false;
      if (release) release();
      channel.close();
      bcRef.current = null;
    };
  }, [channelName]);

  return { isLeader, bcRef };
}
