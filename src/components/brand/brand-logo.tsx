import { CosmosMark } from "./cosmos-mark";

/**
 * White-label brand slot. Renders the current org's logo when one is set
 * (Organization.logoUrl), otherwise falls back to the COSMOS mark.
 *
 * The rendered box is a FIXED 24x24 square regardless of sidebar state — the
 * mark must NOT shrink when the rail collapses (the old `size={open?"md":"sm"}`
 * behaviour was the bug). `object-contain` keeps any aspect ratio inside the
 * square slot.
 */
export function BrandLogo({
  logoUrl,
  orgName,
}: {
  logoUrl?: string | null;
  orgName?: string | null;
}) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={orgName ? `${orgName} logo` : "Organization logo"}
        width={24}
        height={24}
        className="h-6 w-6 shrink-0 rounded object-contain"
      />
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center">
      <CosmosMark size="md" />
    </span>
  );
}
