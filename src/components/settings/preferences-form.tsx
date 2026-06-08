"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Sun,
  Moon,
  Monitor,
  PanelLeft,
  PanelRight,
  LayoutList,
  Navigation,
  Layers,
  Check,
  Upload,
  Trash2,
  Image as ImageIcon,
  Undo2,
} from "lucide-react";
import { UnsavedChangesGuard } from "@/components/ui/unsaved-changes-guard";
import { DndSettings } from "@/components/settings/dnd-settings";
import { notifyError } from "@/lib/errors/notify";
import type { UserPreferences } from "@/types/models";

type ThemeModeOption = "LIGHT" | "DARK" | "SYSTEM";
type Density = "COMPACT" | "COMFORTABLE" | "SPACIOUS";
type SidebarPosition = "LEFT" | "RIGHT";
type NavigationStyle = "TABS" | "BREADCRUMBS" | "BOTH";

interface PrefState {
  themeMode: ThemeModeOption;
  density: Density;
  sidebarPosition: SidebarPosition;
  navigationStyle: NavigationStyle;
  methodology: string;
  defaultBoardId: string;
  bgDarkUrl: string | null;
  bgLightUrl: string | null;
  // Pending uploads (blob URLs) — only persisted on Save
  bgDarkFile: File | null;
  bgLightFile: File | null;
  bgDarkRemoved: boolean;
  bgLightRemoved: boolean;
}

const DEFAULT_STATE: PrefState = {
  themeMode: "SYSTEM",
  density: "COMFORTABLE",
  sidebarPosition: "LEFT",
  navigationStyle: "BOTH",
  methodology: "",
  defaultBoardId: "",
  bgDarkUrl: null,
  bgLightUrl: null,
  bgDarkFile: null,
  bgLightFile: null,
  bgDarkRemoved: false,
  bgLightRemoved: false,
};

const themeModes: { value: ThemeModeOption; label: string; icon: React.ElementType }[] = [
  { value: "LIGHT", label: "Light", icon: Sun },
  { value: "DARK", label: "Dark", icon: Moon },
  { value: "SYSTEM", label: "System", icon: Monitor },
];

const densityOptions: { value: Density; label: string; description: string }[] = [
  { value: "COMPACT", label: "Compact", description: "Tighter spacing, more content visible" },
  { value: "COMFORTABLE", label: "Comfortable", description: "Balanced spacing for everyday use" },
  { value: "SPACIOUS", label: "Spacious", description: "Extra breathing room between elements" },
];

const sidebarOptions: { value: SidebarPosition; label: string; icon: React.ElementType }[] = [
  { value: "LEFT", label: "Left", icon: PanelLeft },
  { value: "RIGHT", label: "Right", icon: PanelRight },
];

const navOptions: { value: NavigationStyle; label: string; icon: React.ElementType }[] = [
  { value: "TABS", label: "Tabs", icon: LayoutList },
  { value: "BREADCRUMBS", label: "Breadcrumbs", icon: Navigation },
  { value: "BOTH", label: "Both", icon: Layers },
];

const methodologyOptions = [
  { value: "agile", label: "Agile" },
  { value: "scrum", label: "Scrum" },
  { value: "kanban", label: "Kanban" },
  { value: "waterfall", label: "Waterfall" },
  { value: "hybrid", label: "Hybrid" },
  { value: "safe", label: "SAFe" },
];

interface PreferencesFormProps {
  orgId: string;
}

function applyTheme(mode: ThemeModeOption) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  if (mode === "DARK") root.classList.add("dark");
  else if (mode === "LIGHT") root.classList.add("light");
  // SYSTEM: no class — CSS @media (prefers-color-scheme) takes over
}

function applyBgVar(mode: "dark" | "light", url: string | null) {
  if (typeof document === "undefined") return;
  const cssVar = mode === "dark" ? "--user-bg-dark" : "--user-bg-light";
  if (url) {
    document.body.style.setProperty(cssVar, `url('${url}')`);
  } else {
    document.body.style.removeProperty(cssVar);
  }
}

export function PreferencesForm({ orgId }: PreferencesFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [committed, setCommitted] = useState<PrefState>(DEFAULT_STATE);
  const [draft, setDraft] = useState<PrefState>(DEFAULT_STATE);
  const blobUrlsRef = useRef<string[]>([]);

  const darkInputRef = useRef<HTMLInputElement | null>(null);
  const lightInputRef = useRef<HTMLInputElement | null>(null);

  const apiBase = `/api/v1/orgs/${orgId}/preferences`;

  const dirty = useMemo(() => {
    const keys: (keyof PrefState)[] = [
      "themeMode",
      "density",
      "sidebarPosition",
      "navigationStyle",
      "methodology",
      "defaultBoardId",
    ];
    for (const k of keys) {
      if (committed[k] !== draft[k]) return true;
    }
    if (draft.bgDarkFile || draft.bgLightFile) return true;
    if (draft.bgDarkRemoved || draft.bgLightRemoved) return true;
    return false;
  }, [committed, draft]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    const urlsRef = blobUrlsRef;
    return () => {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  // Load preferences
  const fetchPreferences = useCallback(async () => {
    try {
      const res = await fetch(apiBase);
      if (res.ok) {
        const json = await res.json();
        const prefs: UserPreferences | undefined = json.data ?? json;
        if (prefs && prefs.id) {
          const loaded: PrefState = {
            themeMode: (prefs.themeMode as ThemeModeOption) ?? "SYSTEM",
            density: prefs.density ?? "COMFORTABLE",
            sidebarPosition: prefs.sidebarPosition ?? "LEFT",
            navigationStyle: prefs.navigationStyle ?? "BOTH",
            methodology: prefs.methodology ?? "",
            defaultBoardId: prefs.defaultBoardId ?? "",
            bgDarkUrl: prefs.bgDarkUrl ?? null,
            bgLightUrl: prefs.bgLightUrl ?? null,
            bgDarkFile: null,
            bgLightFile: null,
            bgDarkRemoved: false,
            bgLightRemoved: false,
          };
          setCommitted(loaded);
          setDraft(loaded);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchPreferences();
  }, [fetchPreferences]);

  // Apply draft preview on every change
  function update<K extends keyof PrefState>(key: K, value: PrefState[K]) {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      // Preview theme immediately
      if (key === "themeMode") applyTheme(value as ThemeModeOption);
      return next;
    });
  }

  function handleBgSelect(mode: "dark" | "light", file: File) {
    const blobUrl = URL.createObjectURL(file);
    blobUrlsRef.current.push(blobUrl);
    setDraft((prev) => ({
      ...prev,
      ...(mode === "dark"
        ? { bgDarkFile: file, bgDarkUrl: blobUrl, bgDarkRemoved: false }
        : { bgLightFile: file, bgLightUrl: blobUrl, bgLightRemoved: false }),
    }));
    applyBgVar(mode, blobUrl);
  }

  function handleBgRemove(mode: "dark" | "light") {
    setDraft((prev) => ({
      ...prev,
      ...(mode === "dark"
        ? { bgDarkFile: null, bgDarkUrl: null, bgDarkRemoved: true }
        : { bgLightFile: null, bgLightUrl: null, bgLightRemoved: true }),
    }));
    applyBgVar(mode, null);
  }

  async function saveAll(): Promise<boolean> {
    setSaving(true);
    try {
      // Upload pending backgrounds first
      let newDarkUrl = draft.bgDarkUrl;
      let newLightUrl = draft.bgLightUrl;

      if (draft.bgDarkFile) {
        const fd = new FormData();
        fd.append("mode", "dark");
        fd.append("file", draft.bgDarkFile);
        const r = await fetch("/api/v1/me/background", { method: "POST", body: fd });
        if (r.ok) {
          const j = await r.json();
          newDarkUrl = j?.data?.url ?? j?.url ?? newDarkUrl;
          applyBgVar("dark", newDarkUrl);
        } else {
          notifyError(undefined, "Couldn't upload the dark mode background.");
          return false;
        }
      }

      if (draft.bgLightFile) {
        const fd = new FormData();
        fd.append("mode", "light");
        fd.append("file", draft.bgLightFile);
        const r = await fetch("/api/v1/me/background", { method: "POST", body: fd });
        if (r.ok) {
          const j = await r.json();
          newLightUrl = j?.data?.url ?? j?.url ?? newLightUrl;
          applyBgVar("light", newLightUrl);
        } else {
          notifyError(undefined, "Couldn't upload the light mode background.");
          return false;
        }
      }

      if (draft.bgDarkRemoved && !draft.bgDarkFile) {
        const res = await fetch("/api/v1/me/background?mode=dark", { method: "DELETE" });
        if (!res.ok) throw new Error("Couldn't remove the dark mode background.");
        newDarkUrl = null;
      }

      if (draft.bgLightRemoved && !draft.bgLightFile) {
        const res = await fetch("/api/v1/me/background?mode=light", { method: "DELETE" });
        if (!res.ok) throw new Error("Couldn't remove the light mode background.");
        newLightUrl = null;
      }

      // Save the rest of the preferences
      const res = await fetch(apiBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          themeMode: draft.themeMode === "SYSTEM" ? null : draft.themeMode,
          density: draft.density,
          sidebarPosition: draft.sidebarPosition,
          navigationStyle: draft.navigationStyle,
          methodology: draft.methodology || null,
          defaultBoardId: draft.defaultBoardId || null,
        }),
      });

      if (!res.ok) {
        notifyError(undefined, "Couldn't save your preferences.");
        return false;
      }

      // The dark/light <html> class is driven by the `theme` COOKIE (read by the
      // no-FOUC bootstrap in app/layout.tsx), NOT by UserPreferences.themeMode —
      // so persist the cookie too, or the chosen mode reverts on the next
      // reload. SYSTEM clears the cookie → falls back to prefers-color-scheme.
      if (committed.themeMode !== draft.themeMode) {
        await fetch("/api/theme", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode:
              draft.themeMode === "SYSTEM"
                ? null
                : draft.themeMode.toLowerCase(),
          }),
        }).catch(() => {
          /* cookie is best-effort; applyTheme already toggled the live class */
        });
      }

      const committedNext: PrefState = {
        ...draft,
        bgDarkUrl: newDarkUrl,
        bgLightUrl: newLightUrl,
        bgDarkFile: null,
        bgLightFile: null,
        bgDarkRemoved: false,
        bgLightRemoved: false,
      };
      setCommitted(committedNext);
      setDraft(committedNext);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      // Re-render server chrome (sidebar/background read org + prefs server-side)
      // so saved preferences are reflected without a manual hard reload.
      router.refresh();
      return true;
    } catch (err) {
      notifyError(err, "Couldn't save your preferences.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function discardAll() {
    // Revert theme to committed
    applyTheme(committed.themeMode);
    // Revert background CSS vars to committed
    applyBgVar("dark", committed.bgDarkUrl);
    applyBgVar("light", committed.bgLightUrl);
    setDraft(committed);
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-7 w-40" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 pb-24">
      <UnsavedChangesGuard dirty={dirty} onSave={saveAll} onDiscard={discardAll} />

      <section className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">Appearance</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose your preferred theme mode (previews instantly)
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {themeModes.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => update("themeMode", opt.value)}
                className={cn(
                  "relative flex flex-col items-center gap-2 rounded-lg border p-4 transition-all",
                  draft.themeMode === opt.value
                    ? "border-primary ring-2 ring-primary/20"
                    : "border-border hover:border-primary/50"
                )}
              >
                {draft.themeMode === opt.value && (
                  <Check className="absolute top-2 right-2 h-3.5 w-3.5 text-primary" />
                )}
                <Icon className="h-5 w-5 text-muted-foreground" />
                <span className="text-xs font-medium">{opt.label}</span>
              </button>
            );
          })}
        </div>

        <Separator />

        <div>
          <h3 className="text-sm font-semibold">Density</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Control the spacing of interface elements
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {densityOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => update("density", opt.value)}
              className={cn(
                "flex items-center justify-between rounded-lg border px-4 transition-all",
                draft.density === opt.value
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-primary/50",
                opt.value === "COMPACT" && "py-2",
                opt.value === "COMFORTABLE" && "py-3",
                opt.value === "SPACIOUS" && "py-4"
              )}
            >
              <div className="text-left">
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.description}</p>
              </div>
              {draft.density === opt.value && (
                <Check className="h-4 w-4 text-primary shrink-0" />
              )}
            </button>
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">Background</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Upload a custom background image for each theme. JPEG or PNG, ≤5MB. Previews instantly; saves on Save.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {(["dark", "light"] as const).map((mode) => {
            const url = mode === "dark" ? draft.bgDarkUrl : draft.bgLightUrl;
            const inputRef = mode === "dark" ? darkInputRef : lightInputRef;
            const ModeIcon = mode === "dark" ? Moon : Sun;
            return (
              <div
                key={mode}
                className="flex flex-col gap-2 rounded-lg border border-border p-3"
              >
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5 text-xs font-medium">
                    <ModeIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    {mode === "dark" ? "Dark mode" : "Light mode"}
                  </Label>
                  {url && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleBgRemove(mode)}
                      className="h-7 px-2 text-xs"
                    >
                      <Trash2 className="h-3 w-3 mr-1" />
                      Remove
                    </Button>
                  )}
                </div>

                <input
                  ref={inputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleBgSelect(mode, f);
                    e.target.value = "";
                  }}
                />

                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className={cn(
                    "group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-muted/40 transition-all",
                    "hover:border-primary/60 hover:bg-muted/70",
                  )}
                  style={
                    url
                      ? {
                          backgroundImage: `url('${url}')`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                      : undefined
                  }
                >
                  <div
                    className={cn(
                      "flex flex-col items-center gap-1.5 text-xs",
                      url
                        ? "rounded-md bg-black/55 px-3 py-2 text-white opacity-0 transition-opacity group-hover:opacity-100"
                        : "text-muted-foreground",
                    )}
                  >
                    {url ? (
                      <>
                        <Upload className="h-4 w-4" />
                        <span>Replace</span>
                      </>
                    ) : (
                      <>
                        <ImageIcon className="h-5 w-5" />
                        <span>Click to upload</span>
                      </>
                    )}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">Layout</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure sidebar and navigation behavior
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Sidebar Position</Label>
          <div className="flex gap-3">
            {sidebarOptions.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => update("sidebarPosition", opt.value)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-4 py-3 transition-all",
                    draft.sidebarPosition === opt.value
                      ? "border-primary ring-2 ring-primary/20"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{opt.label}</span>
                  {draft.sidebarPosition === opt.value && (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Navigation Style</Label>
          <div className="flex gap-3">
            {navOptions.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => update("navigationStyle", opt.value)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-4 py-3 transition-all",
                    draft.navigationStyle === opt.value
                      ? "border-primary ring-2 ring-primary/20"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{opt.label}</span>
                  {draft.navigationStyle === opt.value && (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">Defaults</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Set default values for common settings
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 max-w-lg">
          <div className="flex flex-col gap-1.5">
            <Label>Default Methodology</Label>
            <Select value={draft.methodology} onValueChange={(val) => update("methodology", val ?? "")}>
              <SelectTrigger className="w-full" aria-label="Default Methodology">
                <SelectValue placeholder="Select methodology" />
              </SelectTrigger>
              <SelectContent>
                {methodologyOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-board">Default Board ID</Label>
            <Input
              id="default-board"
              value={draft.defaultBoardId}
              onChange={(e) => update("defaultBoardId", e.target.value)}
              placeholder="Optional"
            />
            <p className="text-[11px] text-muted-foreground">
              Board to open by default when visiting a project
            </p>
          </div>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">Notifications</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure push notification delivery preferences
          </p>
        </div>
        <DndSettings orgId={orgId} />
      </section>

      {/* Sticky save bar — appears when dirty. Bottom offset clears the
       * mobile bottom-nav (h-16 + safe-area, z-30); desktop has no bottom
       * nav so falls back to bottom-4. z-40 so it stacks above the nav. */}
      {dirty && (
        <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)] right-4 left-4 sm:bottom-4 sm:left-auto sm:right-8 z-40 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg">
          <span className="text-sm text-muted-foreground">Unsaved changes</span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={discardAll} disabled={saving}>
            <Undo2 className="h-3.5 w-3.5 mr-1" />
            Discard
          </Button>
          <Button size="sm" onClick={saveAll} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            Save
          </Button>
        </div>
      )}

      {saved && !dirty && (
        <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)] right-4 left-4 sm:bottom-4 sm:left-auto sm:right-8 z-40 flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-50 px-4 py-3 text-emerald-700 shadow-lg dark:bg-emerald-950 dark:text-emerald-300">
          <Check className="h-4 w-4" />
          <span className="text-sm font-medium">Preferences saved</span>
        </div>
      )}
    </div>
  );
}
