import { cn } from "@/lib/utils";

/**
 * Foreman's mark — hard hat + safety glasses, filled monochrome. Inherits
 * `currentColor` so it sits in the sidebar/console exactly like a lucide icon;
 * size it with the usual h-4/w-4 style classes. (The comment-thread avatar is
 * the same glyph baked into /public/avatars/foreman.svg with fixed colors,
 * since an img tag can't inherit currentColor.)
 */
export function ForemanMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 128 128"
      fill="currentColor"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <path d="M50 26.5 L50 62 L26 62 C26 44 35 31.5 50 26.5 Z" />
      <rect x="55" y="21" width="18" height="41" rx="4" />
      <path d="M78 26.5 C93 31.5 102 44 102 62 L78 62 Z" />
      <rect x="16" y="66" width="96" height="11" rx="5.5" />
      <path d="M31 82 L97 82 C103 82 106 85 106 90 C106 99 101 104 92 104 L74.5 104 C71.5 104 70.5 100.5 69.5 98.5 C68.5 96.5 66.5 95.5 64 95.5 C61.5 95.5 59.5 96.5 58.5 98.5 C57.5 100.5 56.5 104 53.5 104 L36 104 C27 104 22 99 22 90 C22 85 25 82 31 82 Z" />
    </svg>
  );
}
