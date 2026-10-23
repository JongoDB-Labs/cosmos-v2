import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GUIDES, guideBySlug } from "@/content/developers";
import { GuideMarkdown } from "@/components/developers/guide-markdown";
import { RuntimeBrandMarker } from "@/components/brand/runtime-brand-marker";

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const guide = guideBySlug((await params).slug);
  return guide ? { title: guide.title, description: guide.summary } : {};
}

// params handed to a Suspense child, per AGENTS.md (Cache Components).
export default function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <RuntimeBrandMarker />
      <Suspense>
        <Guide params={params} />
      </Suspense>
    </>
  );
}

async function Guide({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) notFound();
  const i = GUIDES.indexOf(guide);
  const next = GUIDES[i + 1];
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <p className="text-xs text-[var(--text-muted)]"><Link href="/developers" className="hover:underline">Guides</Link></p>
        <h1 className="text-2xl font-semibold">{guide.title}</h1>
      </header>
      <GuideMarkdown>{guide.body}</GuideMarkdown>
      {next && (
        <footer className="border-t border-[var(--border)] pt-4 text-sm">
          Next: <Link className="underline" href={`/developers/guides/${next.slug}`}>{next.title}</Link>
        </footer>
      )}
    </article>
  );
}
