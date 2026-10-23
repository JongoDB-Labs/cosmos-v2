import type { Metadata } from "next";
import Link from "next/link";
import { getBrand } from "@/lib/brand";

export function generateMetadata(): Metadata {
  const { name } = getBrand();
  return {
    title: { template: `%s · ${name} API`, default: `${name} API` },
    description: `Guides and reference for the ${name} REST API.`,
  };
}

const NAV = [
  { href: "/developers", label: "Guides" },
  { href: "/developers/reference", label: "API reference" },
  { href: "/developers/changelog", label: "Changelog" },
];

/**
 * /developers sits outside (dashboard): no org, no sidebar, nothing read from
 * the request, so every page here prerenders. Who may see it is the proxy's
 * call (lib/developers/visibility.ts).
 */
export default function DevelopersLayout({ children }: { children: React.ReactNode }) {
  const brand = getBrand();
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {/* h-14 (3.5rem) is mirrored in components/developers/scalar-overrides.css,
          which keeps Scalar's own sticky sidebar below this header. */}
      <header className="sticky top-0 z-20 flex h-14 items-center border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-x-6 px-4">
          <Link href="/developers" className="font-semibold">
            {brand.name} <span className="text-[var(--text-muted)]">API</span>
          </Link>
          <nav aria-label="Developer docs" className="flex gap-4 text-sm">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-[var(--text-muted)] hover:text-[var(--text)]">
                {n.label}
              </Link>
            ))}
          </nav>
          <Link href="/" className="ml-auto text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
            Open {brand.name} →
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
