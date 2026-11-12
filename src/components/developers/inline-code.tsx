/** A code span for the developer docs. */
export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  );
}
