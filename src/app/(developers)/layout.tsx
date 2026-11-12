import Link from "next/link";

/**
 * The developer docs sit outside `(dashboard)`: that shell reads the first path
 * segment as an organization slug, and `/developers` is not one. A plain,
 * static frame; each page fetches what it needs inside its own <Suspense>.
 */
export default function DevelopersLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <nav className="mb-8 flex items-center gap-4 text-sm">
          <Link href="/" className="text-[var(--text-muted)] hover:text-[var(--text)]">
            ← Back to the app
          </Link>
          <Link href="/developers" className="text-[var(--text-muted)] hover:text-[var(--text)]">
            API overview
          </Link>
          <Link href="/developers/guides/errors" className="text-[var(--text-muted)] hover:text-[var(--text)]">
            Error codes
          </Link>
        </nav>
        <main className="space-y-6 text-sm leading-6">{children}</main>
      </div>
    </div>
  );
}
