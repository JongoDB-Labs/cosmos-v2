import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { UpdatesManager } from "./updates-manager";

// cacheComponents enabled: `dynamic` segment config not supported (routes are dynamic by default).
//
// No `unstable_instant` export: every one of them was removed from this app
// while the Next.js Turbopack build-validation bug is investigated, and this
// would be the only one left. (AGENTS.md still tells you to add one — it is
// stale on that point.)

export default async function UpdatesAdminPage() {
  // An image upgrade is instance-wide → SYSTEM admin only (INTERNAL_ADMINS),
  // not "owner of any org": self-service org creation mints OWNER, so gating
  // this on org ownership would be an escalation path.
  const me = await requireSystemAdmin();
  if (!me) redirect("/");

  // Deliberately NOT prefetched on the server, unlike the allowlist page. This
  // query makes an outbound call to a container registry; doing that during the
  // page render would put a third party's latency (and outage) directly in the
  // path of the page loading. The client fetches it and shows its own state.
  return (
    <PageShell
      title="Updates"
      description="Whether a newer Cosmos image is available, and whether it would be safe to apply."
      maxWidth="5xl"
    >
      <UpdatesManager />
    </PageShell>
  );
}
