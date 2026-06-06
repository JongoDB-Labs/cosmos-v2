"use client";
import { useEffect, useMemo, useState } from "react";
import { matchCommands, type SlashCommand } from "@/lib/chat/commands";

export function SlashCommandMenu({
  prefix,
  canManage,
  anchor,
  onPick,
  onCancel,
}: {
  prefix: string;
  canManage: boolean;
  anchor: { top: number; left: number };
  onPick: (cmd: SlashCommand) => void;
  onCancel: () => void;
}) {
  const matches = useMemo(() => matchCommands(prefix, canManage), [prefix, canManage]);
  // Use the React-documented "adjust state during render" pattern to reset
  // the active index whenever the prefix changes, without a useEffect.
  const [prevPrefix, setPrevPrefix] = useState(prefix);
  const [active, setActive] = useState(0);
  if (prevPrefix !== prefix) {
    setPrevPrefix(prefix);
    setActive(0);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (matches.length === 0) return;
      if (e.key === "ArrowDown") {
        setActive((a) => Math.min(matches.length - 1, a + 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setActive((a) => Math.max(0, a - 1));
        e.preventDefault();
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (matches[active]) {
          onPick(matches[active]);
          e.preventDefault();
        }
      } else if (e.key === "Escape") {
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matches, active, onPick, onCancel]);

  if (matches.length === 0) return null;
  return (
    <div
      className="fixed z-50 bg-popover border rounded shadow-md text-sm min-w-[260px]"
      style={{ top: anchor.top, left: anchor.left }}
    >
      {matches.map((c, i) => (
        <button
          type="button"
          key={c.name}
          onClick={() => onPick(c)}
          className={
            "w-full px-3 py-1.5 flex flex-col items-start text-left " +
            (i === active ? "bg-accent" : "hover:bg-accent")
          }
        >
          <span className="font-medium">{c.usage}</span>
          <span className="text-xs text-muted-foreground">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
