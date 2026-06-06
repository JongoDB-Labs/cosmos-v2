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
}

export function ActionMenu({ groups, children, triggerClassName }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const btn = btnRef.current;
      if (!btn) return;

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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div onContextMenu={handleContextMenu} className="contents">
        {children}
        <DropdownMenuTrigger
          render={
            <button
              ref={btnRef}
              type="button"
              aria-label="Open menu"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className={cn(
                "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/action:opacity-100 focus:opacity-100 data-[popup-open]:opacity-100",
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
        {groups.map((group, gi) => {
          if (group.items.length === 0) return null;
          return (
            <div key={gi}>
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
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
