import { Suspense } from "react";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { InlineCode as Code } from "@/components/developers/inline-code";

/**
 * `/developers`: the address the API spec and every error's `type` point at.
 * The full reference lives on each organization's Settings → API keys page,
 * next to the keys it explains, so this page says what applies to every org
 * and links there.
 */
export default function DevelopersPage() {
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">REST API</h1>
        <p className="text-[var(--text-muted)]">
          This instance serves its REST API under <Code>/api/v1</Code>. Requests and responses are JSON.
        </p>
      </header>

      <section className="space-y-2" aria-labelledby="auth">
        <h2 id="auth" className="text-lg font-semibold">Authentication</h2>
        <p>
          Send an API key as a bearer token: <Code>Authorization: Bearer &lt;key&gt;</Code>. A key belongs to one
          organization and acts as the person who created it. It can do only what its scopes allow and what
          that person is allowed to do, never more.
        </p>
      </section>

      <section className="space-y-2" aria-labelledby="keys">
        <h2 id="keys" className="text-lg font-semibold">API keys and the reference</h2>
        <p>
          Create keys in an organization&apos;s <b>Settings → API keys</b>. The same page has the API
          reference, with that organization&apos;s endpoints filled in and examples ready to copy.
        </p>
        <Suspense fallback={<p className="text-[var(--text-muted)]">Loading your organizations…</p>}>
          <YourOrganizations />
        </Suspense>
      </section>

      <section className="space-y-2" aria-labelledby="errors">
        <h2 id="errors" className="text-lg font-semibold">Errors</h2>
        <p>
          A failed request returns <Code>application/problem+json</Code> with a stable <Code>code</Code>.{" "}
          <Link href="/developers/guides/errors" className="font-medium text-[var(--primary)] underline underline-offset-2">
            Error codes
          </Link>{" "}
          lists them all.
        </p>
      </section>
    </>
  );
}

async function YourOrganizations() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <p>
        <Link href="/login" className="font-medium text-[var(--primary)] underline underline-offset-2">
          Sign in
        </Link>{" "}
        to see your organizations.
      </p>
    );
  }
  // A direct orgMember read, so the client's removed-member filter applies.
  const memberships = await prisma.orgMember.findMany({
    where: { userId: user.id },
    select: { org: { select: { slug: true, name: true } } },
    orderBy: { org: { name: "asc" } },
  });
  if (memberships.length === 0) {
    return <p className="text-[var(--text-muted)]">You aren&apos;t in an organization yet.</p>;
  }
  return (
    <ul className="list-disc space-y-1 pl-5">
      {memberships.map(({ org }) => (
        <li key={org.slug}>
          <Link
            href={`/${org.slug}/settings/api-keys`}
            className="font-medium text-[var(--primary)] underline underline-offset-2"
          >
            {org.name}: API keys
          </Link>
        </li>
      ))}
    </ul>
  );
}
