"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useDrawers } from "./drawer-provider";
import {
  chatDrawerTargetFromParams,
  deleteChatParams,
} from "@/lib/chat/drawer-link";

/**
 * Honours a chat link on any page: `?chat=<id>`, `?chat=<id>&chatMsg=<m>`,
 * `?chat=` or `?chatWith=<userId>` (see `lib/chat/drawer-link`). It opens the
 * docked Chat drawer on that conversation, then takes the parameters out of
 * the address bar, so closing the drawer does not leave a link that reopens it
 * on reload and the page's own address stays clean.
 *
 * Mounted once, in the org layout, inside its own <Suspense>: it calls
 * useSearchParams(), and without a boundary that opts every org route out of
 * prerendering (the same reason TourMount has one).
 *
 * The parameters come out with history.replaceState, which Next's router
 * follows, rather than router.replace, which would refetch the page itself
 * for a change only this island cares about.
 */
export function ChatLinkMount() {
  const params = useSearchParams();
  const { open } = useDrawers();
  // The query this mount last acted on. Cleared once the parameters are gone,
  // so following the same link again later opens the drawer again.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const target = chatDrawerTargetFromParams(params, window.location.hash);
    if (!target) {
      handled.current = null;
      return;
    }
    const key = params.toString();
    if (handled.current === key) return;
    handled.current = key;

    open("chat", { chat: target, source: "link" });

    const url = new URL(window.location.href);
    deleteChatParams(url.searchParams);
    // An old link's `#msg-<id>` has done its job once read into the target.
    if (/^#msg-/.test(url.hash)) url.hash = "";
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [params, open]);

  // Real markup, never null: a client island whose first render is null can
  // fail to activate in the production build, and then its effect never runs.
  return <span hidden data-chat-link-mount="" />;
}
