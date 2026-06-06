import { PageShell } from "@/components/ui/page-shell";
import { PageSection } from "@/components/ui/page-section";

const COLOR_TOKENS = [
  "bg", "surface", "overlay", "border", "text", "text-muted",
  "primary", "primary-hover", "primary-tint",
  "status-progress", "status-review", "status-done",
  "status-blocked", "status-critical", "status-strategic", "status-discovery",
];

const TYPE_TOKENS = [
  { name: "text-xs", classes: "text-xs" },
  { name: "text-sm", classes: "text-sm" },
  { name: "text-base", classes: "text-base" },
  { name: "text-lg", classes: "text-lg" },
  { name: "text-2xl", classes: "text-2xl" },
  { name: "text-3xl", classes: "text-3xl" },
];

export default function TokensPage() {
  return (
    <PageShell title="Tokens" description="Color, typography, and spacing values">
      <PageSection title="Colors">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {COLOR_TOKENS.map((t) => (
            <div key={t} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
              <div className="mb-2 h-12 w-full rounded" style={{ backgroundColor: `var(--${t})` }} />
              <p className="font-mono text-xs">--{t}</p>
            </div>
          ))}
        </div>
      </PageSection>
      <PageSection title="Typography">
        <div className="space-y-3">
          {TYPE_TOKENS.map((t) => (
            <div key={t.name} className="flex items-baseline gap-4 border-b border-[var(--border)] pb-3">
              <code className="w-32 font-mono text-xs text-[var(--text-muted)]">{t.name}</code>
              <span className={t.classes}>The quick brown fox</span>
            </div>
          ))}
        </div>
      </PageSection>
    </PageShell>
  );
}
