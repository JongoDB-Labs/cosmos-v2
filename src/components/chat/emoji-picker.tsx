"use client";
import { useState } from "react";

const POPULAR = [
  "👍", "❤️", "😂", "🎉", "🚀", "🙏", "👀", "✅",
  "👏", "🔥", "💯", "🤔", "😢", "😮", "😅", "😎",
];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [custom, setCustom] = useState("");
  return (
    <div className="p-2 bg-popover border rounded shadow-md w-56">
      <div className="grid grid-cols-8 gap-1 mb-2">
        {POPULAR.map((e) => (
          <button
            type="button"
            key={e}
            onClick={() => onPick(e)}
            className="text-lg hover:bg-accent rounded p-0.5"
            aria-label={`React with ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
      <input
        className="w-full border rounded px-1 py-0.5 text-sm"
        placeholder="other"
        value={custom}
        maxLength={48}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && custom.trim()) {
            onPick(custom.trim());
            setCustom("");
          }
        }}
      />
    </div>
  );
}
