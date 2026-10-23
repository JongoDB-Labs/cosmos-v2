"use client";

import Link from "next/link";
import { BookOpen } from "lucide-react";
import { CodeSnippet } from "@/components/ui/code-snippet";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/**
 * Under the API keys manager: the first request to make with a key, and the
 * way to /developers, where the guides and the full reference live. This used
 * to carry its own endpoint list, scope notes and an MCP setup for a package
 * that was never published; all of that is generated from the contracts now,
 * so it can't drift from the API the way a hand-kept copy here did.
 */
export function ApiReference({ orgId }: { orgId: string }) {
  // Resolved client-side so the example uses the real public origin.
  const base = typeof window !== "undefined" ? window.location.origin : "https://cosmos.example.com";

  return (
    <section
      aria-labelledby="api-quickstart-heading"
      className="mt-8 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4 text-sm"
    >
      <h2 id="api-quickstart-heading" className="flex items-center gap-2 font-medium text-[var(--text)]">
        <BookOpen className="size-4 text-[var(--primary)]" aria-hidden /> Using the API
      </h2>
      <p className="text-[var(--text-muted)]">
        Send a key as a bearer token. It acts as the person who created it, in this organization only, and can
        never do more than both its scopes and that person allow. To list this organization&apos;s projects:
      </p>
      <CodeSnippet
        code={`curl -H "Authorization: Bearer cosmos_<prefix>_<secret>" \\\n  ${base}/api/v1/orgs/${orgId}/projects`}
      />
      <Link href="/developers" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        Guides and API reference
      </Link>
    </section>
  );
}
