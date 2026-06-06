import { resolveBrandIcon } from "./brand-icons";
import { cn } from "@/lib/utils";

export function BrandIcon({
  slug,
  name,
  className,
}: {
  slug: string;
  name: string;
  className?: string;
}) {
  const icon = resolveBrandIcon(slug);
  if (icon) {
    return (
      <svg
        role="img"
        aria-label={name}
        viewBox="0 0 24 24"
        className={cn("h-5 w-5", className)}
        fill={`#${icon.hex}`}
      >
        <path d={icon.path} />
      </svg>
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-label={name}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold bg-muted text-muted-foreground",
        className
      )}
    >
      {initial}
    </span>
  );
}
