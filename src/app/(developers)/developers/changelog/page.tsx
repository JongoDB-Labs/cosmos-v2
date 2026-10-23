import type { Metadata } from "next";
import Link from "next/link";
import { GuideMarkdown } from "@/components/developers/guide-markdown";
import { API_CHANGELOG } from "@/lib/api-changelog";
import { RuntimeBrandMarker } from "@/components/brand/runtime-brand-marker";

export const metadata: Metadata = { title: "API changelog" };

export default function ApiChangelogPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <RuntimeBrandMarker />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">API changelog</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Changes to the API, newest first. Also as <a className="underline" href="/developers/changelog/rss.xml">RSS</a>.
          See <Link className="underline" href="/developers/guides/versioning">Versioning</Link> for what counts as breaking.
        </p>
      </header>
      {API_CHANGELOG.map((e) => (
        <section key={e.date} id={e.date} aria-labelledby={`h-${e.date}`} className="scroll-mt-20 space-y-2">
          <h2 id={`h-${e.date}`} className="text-lg font-semibold">
            {e.title}
            {e.breaking && (
              <span className="ml-2 rounded bg-[var(--status-blocked)] px-1.5 py-0.5 align-middle text-xs text-white">
                Breaking
              </span>
            )}
          </h2>
          <p className="text-xs text-[var(--text-muted)]"><time dateTime={e.date}>{e.date}</time></p>
          <GuideMarkdown>{e.body}</GuideMarkdown>
        </section>
      ))}
    </div>
  );
}
