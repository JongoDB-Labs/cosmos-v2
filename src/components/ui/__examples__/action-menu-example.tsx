"use client";
import { Pencil, Copy, Trash2, Archive } from "lucide-react";
import { ActionMenu } from "../action-menu";

export function ActionMenuBasic() {
  return (
    <div className="group/action flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
      <span className="flex-1 text-sm">Hover me — row with actions</span>
      <ActionMenu
        groups={[
          {
            items: [
              { label: "Edit", icon: Pencil, onClick: () => {} },
              { label: "Duplicate", icon: Copy, onClick: () => {} },
            ],
          },
          {
            items: [
              { label: "Archive", icon: Archive, onClick: () => {} },
              {
                label: "Delete",
                icon: Trash2,
                variant: "destructive",
                onClick: () => {},
              },
            ],
          },
        ]}
      >
        <span className="sr-only">Row actions</span>
      </ActionMenu>
    </div>
  );
}

export function ActionMenuLabeledGroup() {
  return (
    <div className="group/action flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
      <span className="flex-1 text-sm">Grouped + disabled item</span>
      <ActionMenu
        groups={[
          {
            label: "Manage",
            items: [
              { label: "Rename", icon: Pencil, onClick: () => {} },
              { label: "Duplicate", icon: Copy, onClick: () => {}, disabled: true },
            ],
          },
        ]}
      >
        <span className="sr-only">Row actions</span>
      </ActionMenu>
    </div>
  );
}
