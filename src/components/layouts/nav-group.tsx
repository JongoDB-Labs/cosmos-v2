"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { motion as fm, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import type { NavGroupDef } from "./nav-config";
import { isHrefActive, resolveHref } from "./nav-active";

/**
 * A Monograph-style collapsible parent group: a parent row with a chevron that
 * expands to reveal indented child links. Keyboard-operable (the parent row is
 * a real <button>), with the standard focus ring and aria-expanded.
 *
 * When the rail is collapsed (icon-only), the parent renders as a single icon
 * that navigates to / expands inline is suppressed — instead it acts as a
 * tooltip-labelled link to the group's first child so the rail stays usable.
 */
export function NavGroup({
  group,
  orgSlug,
  pathname,
  expanded,
  onToggle,
  railOpen,
}: {
  group: NavGroupDef;
  orgSlug: string | undefined;
  pathname: string;
  expanded: boolean;
  onToggle: () => void;
  railOpen: boolean;
}) {
  const childHrefs = group.children.map((c) => resolveHref(orgSlug, c.href));
  // A group is "active" when any child route is active.
  const groupActive = group.children.some((c, i) =>
    isHrefActive(pathname, childHrefs[i], c.href === "", childHrefs),
  );
  const GroupIcon = group.icon;

  // Collapsed rail: show only the group icon, linking to the first child so the
  // group is still reachable. Hover title surfaces the label.
  if (!railOpen) {
    const firstHref = childHrefs[0];
    return (
      <Link
        href={firstHref}
        title={group.label}
        aria-current={groupActive ? "page" : undefined}
        className={cn(
          "flex items-center justify-center rounded-md px-2.5 py-2 text-sm transition-colors",
          groupActive
            ? "bg-[var(--primary-tint)] text-[var(--primary)]"
            : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
        )}
      >
        <GroupIcon className="h-4 w-4 shrink-0" />
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
          groupActive && !expanded
            ? "text-[var(--primary)]"
            : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
        )}
      >
        <GroupIcon className="h-4 w-4 shrink-0" />
        <span className="truncate flex-1 text-left">{group.label}</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <fm.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-[var(--border)] pl-2">
              {group.children.map((child, i) => {
                const href = childHrefs[i];
                const active = isHrefActive(
                  pathname,
                  href,
                  child.href === "",
                  childHrefs,
                );
                const ChildIcon = child.icon;
                return (
                  <Link
                    key={child.id}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-[var(--primary-tint)] text-[var(--primary)]"
                        : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
                    )}
                  >
                    <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{child.label}</span>
                  </Link>
                );
              })}
            </div>
          </fm.div>
        )}
      </AnimatePresence>
    </div>
  );
}
