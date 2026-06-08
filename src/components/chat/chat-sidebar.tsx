"use client";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useChatChannels } from "@/hooks/use-chat-channels";
import type { ChatChannelSummary } from "@/hooks/use-chat-channels";
import { useChatPresence } from "@/hooks/use-chat-presence";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { cn } from "@/lib/utils";
import { ChannelList } from "./channel-list";
import { DmList } from "./dm-list";
import { ChannelCreateDialog } from "./channel-create-dialog";
import { ChannelBrowseDialog } from "./channel-browse-dialog";
import { NewDmDialog } from "./new-dm-dialog";
import { SearchPanel } from "./search-panel";
import { LoadError } from "@/components/ui/load-error";

interface ChatSidebarProps {
  orgId: string;
  activeChannelId?: string;
  /**
   * When provided, channel/DM rows select IN PLACE (call this) instead of
   * navigating to /chat/[id] — used by the docked Chat drawer so the page
   * behind it stays put. Absent (the /chat page) → normal link navigation.
   */
  onSelectChannel?: (channelId: string) => void;
}

type OrgProject = { id: string; name: string };

// Sentinel section id for channels with no project (or the org #general).
const GENERAL = "__general__";
const COLLAPSE_STORAGE_KEY = "cosmos.chat.collapsedProjectSections";

type ChannelGroup = {
  id: string;
  label: string;
  channels: ChatChannelSummary[];
};

function loadCollapsed(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function ChatSidebar({
  orgId,
  activeChannelId,
  onSelectChannel,
}: ChatSidebarProps) {
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";
  const { data, isLoading, isError, refetch } = useChatChannels(orgId);
  const online = useChatPresence(orgId);

  // Shares the "projects" cache key with the create dialog, so opening the
  // dialog and rendering the sidebar hit one cached fetch — used only to map
  // projectId -> display name for the group headers.
  const projectsKey = useOrgQueryKey("projects");
  const { data: projects } = useQuery({
    queryKey: projectsKey,
    queryFn: () => jsonFetch<OrgProject[]>(`/api/v1/orgs/${orgId}/projects`),
    staleTime: 60_000,
  });

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects ?? []) map.set(p.id, p.name);
    return map;
  }, [projects]);

  // Per-project collapse state, persisted to localStorage. Default = expanded.
  // Lazy-initialised from storage (matching the repo's localStorage pattern);
  // returns {} during SSR so the server output stays deterministic.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(
    loadCollapsed,
  );
  // Apply the (localStorage-derived) collapse state only AFTER hydration, so the
  // first client render matches the server's all-expanded output — no mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Mount flag for the hydration gate — same pattern as use-media-query.ts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  function toggleSection(id: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage may be unavailable (private mode); collapse stays in-memory.
      }
      return next;
    });
  }

  const channels = useMemo(
    () => (data ?? []).filter((c) => c.kind === "CHANNEL"),
    [data],
  );
  const dms = useMemo(
    () => (data ?? []).filter((c) => c.kind !== "CHANNEL"),
    [data],
  );

  // Group channels by projectId; un-projected channels go under "General".
  // General is always listed first, then projects ordered by display name.
  const groups = useMemo<ChannelGroup[]>(() => {
    const byProject = new Map<string, ChatChannelSummary[]>();
    for (const c of channels) {
      const key = c.projectId ?? GENERAL;
      const arr = byProject.get(key);
      if (arr) arr.push(c);
      else byProject.set(key, [c]);
    }
    const out: ChannelGroup[] = [];
    const general = byProject.get(GENERAL);
    if (general && general.length) {
      out.push({ id: GENERAL, label: "General", channels: general });
    }
    const projectGroups: ChannelGroup[] = [];
    for (const [pid, list] of byProject) {
      if (pid === GENERAL) continue;
      projectGroups.push({
        id: pid,
        label: projectName.get(pid) ?? "Project",
        channels: list,
      });
    }
    projectGroups.sort((a, b) => a.label.localeCompare(b.label));
    return out.concat(projectGroups);
  }, [channels, projectName]);

  if (isError) {
    return (
      <aside className="w-full md:w-64 md:border-r flex flex-col">
        <SearchPanel orgId={orgId} />
        <LoadError onRetry={() => { refetch(); }} />
      </aside>
    );
  }

  if (isLoading || !data) {
    return (
      <aside className="w-full md:w-64 md:border-r flex flex-col">
        <SearchPanel orgId={orgId} />
        <div className="p-2 text-xs text-muted-foreground">Loading…</div>
      </aside>
    );
  }

  return (
    <aside className="w-full md:w-64 md:border-r flex flex-col">
      <SearchPanel orgId={orgId} />
      <div className="px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
        Channels
      </div>
      <div className="px-2 pb-2 space-y-1">
        {groups.map((g) => {
          // The un-projected "General" bucket (which holds #general) renders as
          // a plain channel list with NO section header: a redundant "General"
          // header just adds noise and would shadow the #general link. Only
          // project groups get a collapsible header.
          const isGeneral = g.id === GENERAL;
          const isCollapsed = !isGeneral && mounted && !!collapsed[g.id];
          const Chevron = isCollapsed ? ChevronRight : ChevronDown;
          return (
            <div key={g.id}>
              {!isGeneral && (
                <button
                  type="button"
                  onClick={() => toggleSection(g.id)}
                  aria-expanded={!isCollapsed}
                  className={cn(
                    "flex w-full items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground hover:bg-accent",
                  )}
                >
                  <Chevron className="h-3 w-3 shrink-0" />
                  <span className="truncate">{g.label}</span>
                  <span className="ml-auto text-[10px] font-normal tabular-nums opacity-70">
                    {g.channels.length}
                  </span>
                </button>
              )}
              {!isCollapsed && (
                <div className={isGeneral ? undefined : "pl-2"}>
                  <ChannelList
                    channels={g.channels}
                    orgSlug={orgSlug}
                    activeChannelId={activeChannelId}
                    onSelectChannel={onSelectChannel}
                  />
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            No channels yet.
          </div>
        )}
      </div>
      <div className="px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
        Direct messages
      </div>
      <div className="px-2 pb-2">
        <DmList
          channels={dms}
          orgSlug={orgSlug}
          activeChannelId={activeChannelId}
          online={online}
          onSelectChannel={onSelectChannel}
        />
      </div>
      <div className="px-2 pb-2">
        <NewDmDialog orgId={orgId} />
      </div>
      <div className="mt-auto px-2 py-2 border-t flex flex-col gap-1">
        <ChannelCreateDialog orgId={orgId} />
        <ChannelBrowseDialog orgId={orgId} />
      </div>
    </aside>
  );
}
