import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { isInternalAdmin } from "@/lib/internal/access";

/**
 * Cache Components requires cookie/header reads to live inside a <Suspense>
 * boundary. The internal admin gate now runs inside <InternalGate>, which
 * is suspended below so the static shell ships immediately.
 */
export default function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-4">
        <h1 className="text-sm font-medium text-[var(--text-muted)]">
          COSMOS Design System
        </h1>
      </header>
      <main className="px-8 py-8">
        <Suspense fallback={null}>
          <InternalGate>{children}</InternalGate>
        </Suspense>
      </main>
    </div>
  );
}

async function InternalGate({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!isInternalAdmin(user.email, process.env.INTERNAL_ADMINS)) notFound();
  return <>{children}</>;
}
