import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageSection } from "@/components/ui/page-section";

const GROUPS = [
  {
    title: "Foundations",
    items: [
      { href: "/internal/design-system/tokens", label: "Tokens", desc: "Color, type, spacing" },
    ],
  },
  {
    title: "Components",
    items: [
      { href: "/internal/design-system/components", label: "All components", desc: "Live playground" },
    ],
  },
  {
    title: "Patterns",
    items: [
      { href: "/internal/design-system/patterns", label: "Layouts & forms", desc: "Higher-order compositions" },
    ],
  },
];

export default function DesignSystemHome() {
  return (
    <PageShell title="Design system" description="Living component reference">
      {GROUPS.map((g) => (
        <PageSection key={g.title} title={g.title}>
          <div className="grid gap-4 md:grid-cols-3">
            {g.items.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className="block rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 hover:shadow-[var(--shadow-glow)]"
              >
                <h3 className="font-medium">{it.label}</h3>
                <p className="mt-1 text-xs text-[var(--text-muted)]">{it.desc}</p>
              </Link>
            ))}
          </div>
        </PageSection>
      ))}
    </PageShell>
  );
}
