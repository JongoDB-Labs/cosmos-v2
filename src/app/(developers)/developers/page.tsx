import Link from "next/link";
import { GUIDES } from "@/content/developers";
import { getBrand } from "@/lib/brand";
import { API_VERSION } from "@/lib/openapi/version";
import { RuntimeBrandMarker } from "@/components/brand/runtime-brand-marker";

export default function DevelopersHome() {
  const brand = getBrand();
  return (
    <div className="space-y-8">
      <RuntimeBrandMarker />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{brand.name} API</h1>
        <p className="max-w-2xl text-sm text-[var(--text-muted)]">
          Read and change projects, work, plans, OKRs and time from your own code. Authenticate with a personal
          access token; every operation is in the <Link className="underline" href="/developers/reference">API
          reference</Link>. Current version <code>{API_VERSION}</code>.
        </p>
      </div>

      <section aria-labelledby="guides-heading" className="space-y-3">
        <h2 id="guides-heading" className="text-lg font-semibold">Guides</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {GUIDES.map((g) => (
            <li key={g.slug}>
              <Link
                href={`/developers/guides/${g.slug}`}
                className="block h-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 hover:border-[var(--primary)]"
              >
                <span className="font-medium">{g.title}</span>
                <span className="mt-1 block text-sm text-[var(--text-muted)]">{g.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="machine-heading" className="space-y-2 text-sm">
        <h2 id="machine-heading" className="text-lg font-semibold">For tools</h2>
        <ul className="list-disc space-y-1 pl-5 text-[var(--text-muted)]">
          <li><a className="underline" href="/api/v1/openapi.json">OpenAPI 3.1 description</a>, for code generators and API clients</li>
          <li><a className="underline" href="/developers/llms.txt">llms.txt</a> and <a className="underline" href="/developers/llms-full.txt">llms-full.txt</a>, for LLMs</li>
          <li><a className="underline" href="/developers/changelog/rss.xml">Changelog RSS</a></li>
        </ul>
      </section>
    </div>
  );
}
