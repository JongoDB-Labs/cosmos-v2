import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-sm)] bg-[var(--primary-tint)]",
        "before:absolute before:inset-0 before:translate-x-[-100%] before:animate-[shimmer_1.4s_infinite] before:bg-gradient-to-r before:from-transparent before:via-[var(--primary-tint)] before:to-transparent",
        className,
      )}
    />
  );
}
