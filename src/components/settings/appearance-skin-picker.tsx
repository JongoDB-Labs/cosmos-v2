"use client";
import { SKIN_PRESETS, DEFAULT_SKIN_ID } from "@/lib/theme/skins";

export function AppearanceSkinPicker({
  value, onChange,
}: { value: string | null; onChange: (id: string) => void }) {
  const active = value ?? DEFAULT_SKIN_ID;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {SKIN_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onChange(p.id)}
          aria-pressed={active === p.id}
          className={`rounded-[var(--radius)] border p-3 text-left transition ${
            active === p.id
              ? "border-[var(--primary)] ring-1 ring-[var(--primary)]"
              : "border-[var(--border)] hover:border-[var(--text-muted)]"
          }`}
        >
          <div
            className="mb-2 flex h-10 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]"
            aria-hidden
          >
            <span className="flex-1" style={{ background: p.light["--bg"] }} />
            <span className="flex-1" style={{ background: p.light["--surface"] }} />
            <span className="flex-1" style={{ background: p.light["--primary"] }} />
          </div>
          <div className="text-sm font-medium text-[var(--text)]">{p.label}</div>
          <div className="text-xs text-[var(--text-muted)]">{p.description}</div>
        </button>
      ))}
    </div>
  );
}
