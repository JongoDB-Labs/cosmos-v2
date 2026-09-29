"use client";

import Image from "next/image";
import { useBrand } from "@/components/providers/brand-provider";

type Size = "sm" | "md" | "lg";

const SIZES: Record<Size, number> = { sm: 16, md: 24, lg: 48 };

/**
 * The deployment's product mark.
 *
 * Reads the brand from the PROVIDER, not from getBrand(). That is the whole
 * point of the provider: under Cache Components a synchronous
 * `process.env.PRODUCT` read is statically inlined with the BUILD-time value,
 * so getBrand() in a component answers whatever the image was built as and
 * never what the container is running as. RootBrandProvider does the
 * `await connection()` dance once and seeds the live value.
 *
 * Calling getBrand() here made this component the one place on the login page
 * that disagreed with the rest of it: the title, the heading and the tagline
 * all said the deployment's real product, while the mark beside them described
 * itself with the default name baked into the image — in its alt text, so it
 * reached screen readers and nobody else.
 *
 * (Naming that default here would trip brand-literals.arch.test.ts, which
 * forbids the literal in exactly these files. Hence the circumlocution.)
 */
export function BrandMark({ size = "md" }: { size?: Size }) {
  const px = SIZES[size];
  const brand = useBrand();
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
