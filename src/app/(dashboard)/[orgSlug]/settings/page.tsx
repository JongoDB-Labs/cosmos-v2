import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Settings as Cog,
  Palette,
  ListTree,
  Lock,
  ShieldCheck,
  Tag,
  Plug,
  Webhook,
  ScrollText,
  User as UserIcon,
} from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageSection } from "@/components/ui/page-section";
import { Skeleton } from "@/components/ui/skeleton";

type PageParams = { params: Promise<{ orgSlug: string }> };

// Note: unstable_instant intentionally omitted here. The parent
// settings/layout.tsx is a client component that reads usePathname()
// from the navigation context; instant validation rejects routes whose
// inherited layout can't run in the static probe shell.

const GROUPS = [
  {
    title: "Personal",
    items: [
      { icon: UserIcon, label: "Profile", path: "profile", desc: "Your name and avatar" },
    ],
  },
  {
    title: "Workspace",
    items: [
      { icon: Cog, label: "Preferences", path: "preferences", desc: "General settings" },
      { icon: Palette, label: "Themes", path: "themes", desc: "Branding & accent" },
      { icon: ListTree, label: "Custom Fields", path: "custom-fields", desc: "Per-entity schemas" },
    ],
  },
  {
    title: "Security & compliance",
    items: [
      { icon: Lock, label: "Security", path: "security", desc: "SSO, IP allowlists" },
      { icon: ShieldCheck, label: "Compliance", path: "compliance", desc: "FedRAMP, SOC 2" },
      { icon: Tag, label: "Classifications", path: "classifications", desc: "Data labels" },
    ],
  },
  {
    title: "Integrations & audit",
    items: [
      { icon: Plug, label: "Integrations", path: "integrations", desc: "Connect tools" },
      { icon: Webhook, label: "Webhooks", path: "webhooks", desc: "Outbound events" },
      { icon: ScrollText, label: "Audit Logs", path: "audit-logs", desc: "Activity history" },
    ],
  },
];

export default function SettingsHubPage({ params }: PageParams) {
  return (
    <Suspense fallback={<SettingsHubSkeleton />}>
      <SettingsHubContent params={params} />
    </Suspense>
  );
}

async function SettingsHubContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Settings" description={`Configure ${orgSlug}`}>
      {GROUPS.map((g) => (
        <PageSection key={g.title} title={g.title}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {g.items.map((it) => (
              <Link
                key={it.path}
                href={`/${orgSlug}/settings/${it.path}`}
                className="block rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 transition-shadow hover:shadow-[var(--shadow-glow)]"
              >
                <it.icon className="mb-3 h-5 w-5 text-[var(--primary)]" />
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

function SettingsHubSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-8">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-2 h-4 w-56" />
      </div>
      {[0, 1, 2, 3].map((g) => (
        <div key={g} className="mb-8">
          <Skeleton className="mb-3 h-5 w-32" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5"
              >
                <Skeleton className="mb-3 h-5 w-5" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-2 h-3 w-32" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
