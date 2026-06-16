import Image from "next/image";
import { getBrand } from "@/lib/brand";

type Size = "sm" | "md" | "lg";

const SIZES: Record<Size, number> = { sm: 16, md: 24, lg: 48 };

export function BrandMark({ size = "md" }: { size?: Size }) {
  const px = SIZES[size];
  const brand = getBrand();
  return (
    <Image
      src={brand.markSrc}
      alt={brand.name}
      width={px}
      height={px}
      priority
      // Marks may be non-square (source art is often 3:2); object-contain
      // preserves aspect ratio inside the requested square slot.
      style={{ width: px, height: px, objectFit: "contain" }}
    />
  );
}
