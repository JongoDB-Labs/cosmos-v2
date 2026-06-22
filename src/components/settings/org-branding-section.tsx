"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { passesAA } from "@/lib/theme/contrast";
import { readableForeground } from "@/lib/theme/derive";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { AppearanceSkinPicker } from "@/components/settings/appearance-skin-picker";

const PRESETS = [
  "#7C5CFF", "#3B82F6", "#06B6D4", "#10B981",
  "#F59E0B", "#EF4444", "#EC4899", "#A78BFA",
  "#22D3EE", "#84CC16", "#F97316", "#64748B",
];

// Base looks: a full theme = (primary hex + mode). These reproduce the two
// built-in defaults — White = the light-mode default (near-black slate primary
// on a white surface), Black = the dark-mode default (near-white primary on a
// near-black surface). Selecting one sets both `selected` and `mode`, so the
// existing Save persists the right pair with no backend change.
const BASE_PRESETS = [
  { id: "white", name: "White", primary: "#1E293B", mode: "light" as const, swatch: "#FFFFFF" },
  { id: "black", name: "Black", primary: "#F8FAFC", mode: "dark" as const, swatch: "#0B0E1A" },
];

export type OrgBrandingInitial = {
  themePrimary: string | null;
  themeMode: string | null;
  logoUrl: string | null;
  defaultSkinId: string | null;
  brandName: string | null;
  agentName: string | null;
  tagline: string | null;
  wakeWord: string | null;
};

export function OrgBrandingSection({
  orgId,
  initial,
}: {
  orgId: string;
  initial: OrgBrandingInitial;
}) {
  const [selected, setSelected] = useState<string>(initial.themePrimary ?? PRESETS[0]);
  const [custom, setCustom] = useState<string>(initial.themePrimary ?? "");
  const [mode, setMode] = useState<"auto" | "dark" | "light">(
    (initial.themeMode as "auto" | "dark" | "light" | null) ?? "auto",
  );
  const [logo, setLogo] = useState<string>(initial.logoUrl ?? "");
  const [skin, setSkin] = useState<string | null>(initial.defaultSkinId ?? null);
  const [brandName, setBrandName] = useState<string>(initial.brandName ?? "");
  const [agentName, setAgentName] = useState<string>(initial.agentName ?? "");
  const [tagline, setTagline] = useState<string>(initial.tagline ?? "");
  const [wakeWord, setWakeWord] = useState<string>(initial.wakeWord ?? "");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  type ThemePayload = {
    themePrimary: string | null;
    themeMode: "auto" | "dark" | "light" | null;
    logoUrl: string | null;
    defaultSkinId: string | null;
    brandName: string | null;
    agentName: string | null;
    tagline: string | null;
    wakeWord: string | null;
  };

  const saveTheme = useOrgMutation<unknown, Error, ThemePayload>({
    mutationFn: (payload) =>
      jsonFetch(`/api/v1/orgs/${orgId}/theme`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    invalidate: [["themes"]],
    // The org primary (injected as <style> by the cached OrgThemeStyle RSC) and
    // the sidebar logo (server-rendered from org.logoUrl) only update when the
    // RSC tree is re-fetched. The PATCH route already busts the server cache
    // tag; refresh re-requests the payload so changes apply without a hard
    // reload — this is what makes a saved logo/color actually show.
    onSuccess: () => router.refresh(),
    onError: (e) => setError(e.message),
  });

  const pending = saveTheme.isPending;

  async function handleLogoFile(file: File) {
    if (file.size > 200_000) {
      setError(`Logo must be ≤200KB (was ${Math.round(file.size / 1024)}KB)`);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("Only images are accepted");
      return;
    }
    setError(null);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setLogo(dataUrl);
  }

  function tryHex(hex: string) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      setError("Use a 6-digit hex like #7C5CFF");
      return;
    }
    if (!passesAA(hex, "#0B0E1A", "large") || !passesAA(hex, "#FFFFFF", "large")) {
      setError("That color doesn't meet AA contrast on both modes.");
      return;
    }
    setError(null);
    setSelected(hex);
  }

  function save() {
    setError(null);
    saveTheme.mutate({
      themePrimary: selected,
      themeMode: mode,
      logoUrl: logo.trim() || null,
      defaultSkinId: skin,
      brandName: brandName.trim() || null,
      agentName: agentName.trim() || null,
      tagline: tagline.trim() || null,
      wakeWord: wakeWord.trim() || null,
    });
  }

  function reset() {
    setError(null);
    saveTheme.mutate(
      {
        themePrimary: null,
        themeMode: null,
        logoUrl: null,
        defaultSkinId: null,
        brandName: null,
        agentName: null,
        tagline: null,
        wakeWord: null,
      },
      {
        onSuccess: () => {
          setSelected(PRESETS[0]);
          setCustom("");
          setMode("auto");
          setLogo("");
          setSkin(null);
          setBrandName("");
          setAgentName("");
          setTagline("");
          setWakeWord("");
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Base
        </p>
        <div className="flex flex-wrap gap-2">
          {BASE_PRESETS.map((b) => {
            const active =
              selected.toUpperCase() === b.primary.toUpperCase() &&
              mode === b.mode;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  setSelected(b.primary);
                  setMode(b.mode);
                  setCustom("");
                  setError(null);
                }}
                aria-label={`Set base to ${b.name} (${b.mode} mode)`}
                aria-pressed={active}
                className="flex items-center gap-2 rounded-[var(--radius-sm)] border-2 px-3 py-1.5 text-sm capitalize transition-transform hover:scale-[1.02]"
                style={{ borderColor: active ? "var(--primary)" : "var(--border)" }}
              >
                <span
                  className="h-5 w-5 rounded-full border border-[var(--border)]"
                  style={{ backgroundColor: b.swatch }}
                />
                {b.name}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          White = the light-mode default. Black = the dark-mode default.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Accent
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => {
                setSelected(p);
                setCustom("");
                setError(null);
              }}
              aria-label={`Set primary to ${p}`}
              className="h-10 w-10 rounded-full border-2 transition-transform hover:scale-105"
              style={{
                backgroundColor: p,
                borderColor: selected === p ? "var(--text)" : "transparent",
              }}
            />
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Custom hex
        </p>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => custom && tryHex(custom)}
          placeholder="#7C5CFF"
          className="h-10 w-40 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 font-mono text-sm"
        />
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Default mode for new members
        </p>
        <div className="flex gap-2">
          {(["auto", "dark", "light"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm capitalize",
                mode === m
                  ? "border-[var(--primary)] bg-[var(--primary-tint)] text-foreground"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Sets the default for people who join later — it doesn&apos;t change
          your own mode. Set yours in Settings → Preferences.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Organization logo
        </p>

        {logo ? (
          <div className="mb-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logo}
              alt="Org logo preview"
              className="h-12 w-12 rounded border border-[var(--border)] object-contain bg-[var(--surface)]"
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLogo("")}
            >
              Remove
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleLogoFile(f);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload image
          </Button>
          <input
            type="url"
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            placeholder="Or paste an https URL"
            className="h-10 w-full max-w-md rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Shown in the sidebar org switcher. PNG/JPG/WEBP up to 200KB.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Default skin for this organization
        </p>
        <AppearanceSkinPicker value={skin} onChange={setSkin} />
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Applied to members who haven&apos;t picked their own skin (Settings →
          Preferences). A member&apos;s own choice always wins.
        </p>
      </div>

      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
          White-label identity
        </p>
        <p className="-mt-2 text-xs text-[var(--text-muted)]">
          Leave a field blank to inherit the platform default.
        </p>
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--text)]">Brand name</span>
          <input
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Acme Studio"
            className="h-10 w-full max-w-md rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--text)]">Agent name</span>
          <input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Acme Helper"
            className="h-10 w-full max-w-md rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--text)]">Tagline</span>
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            maxLength={120}
            placeholder="e.g. Build beautifully"
            className="h-10 w-full max-w-md rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--text)]">Wake word</span>
          <input
            value={wakeWord}
            onChange={(e) => setWakeWord(e.target.value)}
            maxLength={40}
            placeholder="e.g. Hey Acme"
            className="h-10 w-full max-w-md rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
          />
        </label>
      </div>

      {error && (
        <div className="rounded-md border border-[var(--status-critical)]/30 bg-[var(--status-critical)]/10 px-3 py-2 text-sm text-[var(--status-critical)]">
          {error}
        </div>
      )}

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Preview
        </p>
        {/* A live swatch of the user's CHOSEN primary color. Its contrast
            reflects that arbitrary choice, not a code defect, so it's excluded
            from the automated a11y contrast scan (data-a11y-preview). */}
        <div
          data-a11y-preview
          className="grid grid-cols-2 gap-4"
          style={{ ["--primary" as string]: selected }}
        >
          <StatCard label="Sample stat" trend="+12%">
            <StatCard.Number>$48,200</StatCard.Number>
            <StatCard.Bar value={37800} max={48200} />
          </StatCard>
          <div className="flex flex-col items-start gap-3">
            <Button
              style={{ backgroundColor: selected, color: readableForeground(selected) }}
              className="w-fit"
            >
              Sample button
            </Button>
            <div>
              <Badge variant="progress">In progress</Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={save} disabled={pending || !!error}>
          {pending ? "Saving…" : "Save theme"}
        </Button>
        <Button variant="ghost" onClick={reset} disabled={pending}>
          Reset to default
        </Button>
      </div>
    </div>
  );
}
