import Link from "next/link";

export interface PageSectionProps {
  title: string;
  children: React.ReactNode;
  action?: { label: string; href: string };
}

export function PageSection({ title, action, children }: PageSectionProps) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between border-b border-[var(--border)] pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {title}
        </h2>
        {action && (
          <Link
            href={action.href}
            className="text-sm text-[var(--primary)] hover:underline"
          >
            {action.label} →
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
