import Image from "next/image";

type Size = "sm" | "md" | "lg";

const SIZES: Record<Size, number> = { sm: 16, md: 24, lg: 48 };

export function CosmosMark({ size = "md" }: { size?: Size }) {
  const px = SIZES[size];
  return (
    <Image
      src="/cosmos-mark.png"
      alt="COSMOS"
      width={px}
      height={px}
      priority
      // The source is 1800x1200 (3:2) but most callers want a square slot.
      // object-contain preserves aspect ratio inside the requested box.
      style={{ width: px, height: px, objectFit: "contain" }}
    />
  );
}
