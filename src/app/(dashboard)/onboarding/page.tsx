import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { OnboardingForm } from "./onboarding-form";

// cacheComponents enabled: `dynamic` segment config not supported (routes are dynamic by default).

export default async function OnboardingPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");

  return (
    <PageShell
      title="Create your organization"
      description="Organizations are the top-level workspace for your team. You can invite others after it's created."
      maxWidth="5xl"
    >
      <div className="mx-auto max-w-md">
        <OnboardingForm />
      </div>
    </PageShell>
  );
}
