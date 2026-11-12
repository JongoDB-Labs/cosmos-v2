"use client";

import { useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDrawers } from "./drawer-provider";
import { chatDrawerHref, type ChatDrawerTarget } from "@/lib/chat/drawer-link";

/** Opens the docked Chat drawer on `target`, beside the current page. */
export function useOpenChat(): (target: ChatDrawerTarget) => void {
  const { open } = useDrawers();
  return useCallback((target: ChatDrawerTarget) => open("chat", { chat: target }), [open]);
}

/** A click the browser would otherwise follow in this tab. */
function isPlainClick(e: React.MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * A link into chat. A plain click opens the drawer beside the page you are on,
 * without navigating. The href is the drawer form on this page, so opening it
 * in a new tab, or copying it, lands on the same page with the drawer open.
 */
export function ChatDrawerLink({
  target,
  className,
  children,
  onOpen,
}: {
  target: ChatDrawerTarget;
  className?: string;
  children: React.ReactNode;
  /** Runs after the drawer opens, e.g. to close the popover the link sat in. */
  onOpen?: () => void;
}) {
  const pathname = usePathname();
  const openChat = useOpenChat();
  return (
    <Link
      href={chatDrawerHref(pathname || "/", target)}
      prefetch={false}
      className={className}
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        openChat(target);
        onOpen?.();
      }}
    >
      {children}
    </Link>
  );
}
