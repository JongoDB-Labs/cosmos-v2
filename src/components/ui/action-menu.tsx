"use client";

import {
  useState,
  useCallback,
  useRef,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ActionMenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
}

export interface ActionMenuGroup {
  label?: string;
  items: ActionMenuItem[];
}

interface ActionMenuProps {
  groups: ActionMenuGroup[];
  children: ReactNode;
  triggerClassName?: string;
  /** Accessible name for the ⋯ trigger. Defaults to "Open menu"; pass a
   *  contextual label (e.g. `Actions for ${name}`) so screen-reader users can
   *  tell repeated triggers apart in a list. */
  triggerLabel?: string;
}

/**
 * Lock scroll offsets for a short window after a menu open/close. The ⋯ trigger
 * is hidden (opacity-0) inside a possibly-scrolled row; base-ui focuses it on
 * open and restores focus to it on close, and the browser's focus-into-view
 * scrolls the container to reach it — which reads as the table "jerking" on
 * right-click. We snapshot the current offsets and revert any scroll that fires
 * during the transition (capture phase, so it's reverted before paint), then
 * release the guard. A capturing window listener catches inner-container
 * scrolls too (scroll doesn't bubble, but it does traverse the capture phase).
 */
// Only one guard chain may run at a time. A rapid close→scroll→re-open can
// otherwise leave the close-guard's rAF chain (which captured the OLD offsets)
// running while a new open-guard chain (capturing the NEW offsets) starts —
// the two then fight every frame, forcing the scroll back and forth: the exact
// jitter the guard exists to suppress. The newest open/close is authoritative,
// so each new guard supersedes (cancels) the previous one.
let activeGuardCancel: (() => void) | null = null;

export function guardScroll(from: Element | null, frames = 20): () => void {
  if (typeof window === "undefined") return () => {};
  // Supersede any in-flight guard so concurrent chains can never fight.
  activeGuardCancel?.();

  const targets: { el: Element; top: number; left: number }[] = [];
  let node: Element | null = from;
  while (node) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX)) {
      targets.push({ el: node, top: node.scrollTop, left: node.scrollLeft });
    }
    node = node.parentElement;
  }
  const winTop = window.scrollY;
  const winLeft = window.scrollX;

  // Snap every tracked container (and the window) back to its captured offset.
  const reassert = () => {
    for (const t of targets) {
      if (t.el.scrollTop !== t.top) t.el.scrollTop = t.top;
      if (t.el.scrollLeft !== t.left) t.el.scrollLeft = t.left;
    }
    if (window.scrollY !== winTop || window.scrollX !== winLeft) {
      window.scrollTo(winLeft, winTop);
    }
  };

  let cancelled = false;
  // Capture-phase scroll interceptor: base-ui's focus-into-view scroll dispatches
  // a scroll event, and reverting INSIDE that event — before the browser paints —
  // makes the correction invisible, so the row never visibly "jerks" (COSMOS-36).
  // The per-frame backstop below alone lands a frame late: base-ui schedules its
  // focus on rAF too, and after this guard's, so the scrolled state paints for one
  // frame before it's undone. Intercepting the scroll event closes that gap.
  // `capture: true` on window catches inner-container scrolls too — scroll doesn't
  // bubble, but it does traverse the capture phase.
  const onScroll = () => {
    if (!cancelled) reassert();
  };
  window.addEventListener("scroll", onScroll, true);

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    window.removeEventListener("scroll", onScroll, true);
    if (activeGuardCancel === cancel) activeGuardCancel = null;
  };
  activeGuardCancel = cancel;

  // Re-assert once per frame for a short window too, as a backstop for any scroll
  // that lands without an event we catch (timing varies as the popup mounts).
  let n = 0;
  const tick = () => {
    if (cancelled) return;
    reassert();
    if (++n < frames) requestAnimationFrame(tick);
    else cancel();
  };
  requestAnimationFrame(tick);
  return cancel;
}

export function ActionMenu({ groups, children, triggerClassName, triggerLabel }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    // Focus returns to the (hidden) trigger on close — neutralize the scroll.
    if (!next) guardScroll(btnRef.current?.parentElement ?? null);
  }, []);

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const btn = btnRef.current;
      if (!btn) return;

      // Guard against the open-focus scroll for the whole open transition.
      guardScroll(btn.parentElement);

      Object.assign(btn.style, {
        position: "fixed",
        left: `${e.clientX}px`,
        top: `${e.clientY}px`,
        width: "1px",
        height: "1px",
        padding: "0",
        overflow: "hidden",
        pointerEvents: "none",
      });

      btn.click();

      requestAnimationFrame(() => {
        Object.assign(btn.style, {
          position: "",
          left: "",
          top: "",
          width: "",
          height: "",
          padding: "",
          overflow: "",
          pointerEvents: "",
        });
      });
    },
    [],
  );

  const allEmpty = groups.every((g) => g.items.length === 0);
  if (allEmpty) return <>{children}</>;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <div onContextMenu={handleContextMenu} className="contents">
        {children}
        <DropdownMenuTrigger
          render={
            <button
              ref={btnRef}
              type="button"
              aria-label={triggerLabel ?? "Open menu"}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className={cn(
                "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/action:opacity-100 focus:opacity-100 data-[popup-open]:opacity-100",
                // Touch devices have no hover, focus-on-tab, or right-click, so
                // the hover-only reveal leaves the menu undiscoverable. On a
                // coarse pointer keep it visible with a real tap target.
                "[@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:p-2",
                triggerClassName,
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        />
      </div>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        className="min-w-[160px]"
      >
        {groups
          .filter((group) => group.items.length > 0)
          .map((group, gi) => (
            // base-ui's Menu.GroupLabel REQUIRES a Menu.Group ancestor — a bare
            // label throws production error #31 the instant the menu opens (the
            // Radix/shadcn pattern this was ported from allowed it; base-ui
            // hard-enforces the contract). Wrapping each group in
            // DropdownMenuGroup also restores role="group"/aria-labelledby.
            // Index the FILTERED list so an empty leading group (e.g. no edit
            // perms) doesn't leave a stray separator before the first one.
            <DropdownMenuGroup key={group.label ?? gi}>
              {gi > 0 && <DropdownMenuSeparator />}
              {group.label && (
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              )}
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <DropdownMenuItem
                    key={item.label}
                    variant={item.variant}
                    disabled={item.disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      item.onClick();
                      setOpen(false);
                    }}
                  >
                    {Icon && <Icon className="h-4 w-4" />}
                    {item.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
