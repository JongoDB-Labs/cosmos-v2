"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CodeSnippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — secure context not available
    }
  }

  return (
    <div className="relative mt-4 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)]">
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2 top-2 rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre className="overflow-x-auto p-4 pr-12 text-xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
