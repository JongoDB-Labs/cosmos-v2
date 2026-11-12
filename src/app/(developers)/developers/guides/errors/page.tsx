import { RuntimeBrandMarker } from "@/components/brand/runtime-brand-marker";
import { InlineCode as Code } from "@/components/developers/inline-code";
import { PROBLEM_CODES, type ProblemCode } from "@/lib/openapi/problem-codes";

/**
 * Every API error's `type` is `/developers/guides/errors#<code>` (see
 * lib/openapi/problem.ts), so each code needs an element with that id here.
 * The list is read from PROBLEM_CODES, so a new code gets its anchor without
 * anyone remembering this page.
 */

const FIELDS: [field: string, meaning: string][] = [
  ["type", "A link to this page, at the entry for the code."],
  ["title", "A short, fixed summary of the code."],
  ["status", "The HTTP status, repeated in the body."],
  ["code", "A stable, machine-readable name for what went wrong. Branch on this, not on the text."],
  ["detail", "What went wrong with this request, in words. Optional."],
  ["requestId", "The request's X-Request-Id. Quote it when you ask for help. Optional."],
  ["issues", "The fields that failed validation, on a 400 invalid_request. Optional."],
  ["error", "Deprecated. The same text as detail, or title when there is none. Kept for older clients."],
];

const PROBLEM_CODE_LIST = Object.entries(PROBLEM_CODES) as [ProblemCode, string][];

export default function ErrorCodesPage() {
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Error codes</h1>
        <p className="text-[var(--text-muted)]">
          A failed API request returns <Code>application/problem+json</Code> (RFC 9457).
        </p>
      </header>

      <section className="space-y-2" aria-labelledby="fields">
        <h2 id="fields" className="text-lg font-semibold">The error body</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
          {FIELDS.map(([field, meaning]) => (
            <div key={field} className="contents">
              <dt><Code>{field}</Code></dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
        <p>
          New codes are added over time. Treat a code you don&apos;t recognise by its <Code>status</Code>.
        </p>
      </section>

      <section className="space-y-2" aria-labelledby="codes">
        <h2 id="codes" className="text-lg font-semibold">Codes</h2>
        <dl className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {PROBLEM_CODE_LIST.map(([code, title]) => (
            <div key={code} id={code} className="scroll-mt-6 px-4 py-2 target:bg-[var(--surface)]">
              <dt><Code>{code}</Code></dt>
              <dd className="text-[var(--text-muted)]">{title}</dd>
            </div>
          ))}
        </dl>
      </section>
      <RuntimeBrandMarker />
    </>
  );
}
