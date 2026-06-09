import { resolveBrandIcon } from "./brand-icons";
import { MicrosoftLogo } from "@/components/brand/provider-logos";
import { cn } from "@/lib/utils";

/** Stable hue (0–359) derived from the brand name, so each company's monogram
 *  gets its own consistent color instead of a flat gray box. */
function hueFromName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) % 360;
  }
  return h;
}

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

  // Microsoft removed its marks from simple-icons (trademark), so the whole
  // microsoft* family falls through here — render the official multicolor mark.
  if (slug.startsWith("microsoft")) {
    return <MicrosoftLogo className={cn("h-5 w-5", className)} />;
  }

  // Fallback monogram for brands with no library logo (gov agencies, niche
  // SaaS). A per-brand tint reads as an intentional avatar, not a broken icon.
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const hue = hueFromName(name);
  return (
    <span
      aria-label={name}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold",
        className,
      )}
      style={{
        backgroundColor: `hsl(${hue} 60% 50% / 0.16)`,
        color: `hsl(${hue} 55% 55%)`,
      }}
    >
      {initial}
    </span>
  );
}
