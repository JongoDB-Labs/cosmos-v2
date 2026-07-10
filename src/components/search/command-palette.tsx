"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import {
  FolderKanban,
  Target,
  Briefcase,
  FileText,
  LayoutList,
  Plus,
  ArrowRight,
  Columns3,
  CornerDownLeft,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  Video,
  Users,
  Building2,
  FileSignature,
  BarChart3,
  Wallet,
  Clock,
  MessageSquarePlus,
  Settings,
  Sparkles,
} from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import {
  useDrawers,
  type DrawerTool,
} from "@/components/drawers/drawer-provider";
import {
  QuickCreateWorkItem,
  type PaletteProject,
} from "./quick-create-work-item";

interface SearchResult {
  id: string;
  type: "project" | "work_item" | "objective" | "contact" | "note";
  name: string;
  description?: string;
  url: string;
}

const typeIcons: Record<SearchResult["type"], React.ReactNode> = {
  project: <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />,
  work_item: <LayoutList className="h-4 w-4 shrink-0 text-muted-foreground" />,
  objective: <Target className="h-4 w-4 shrink-0 text-muted-foreground" />,
  contact: <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" />,
  note: <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />,
};

const typeLabels: Record<SearchResult["type"], string> = {
  project: "Project",
  work_item: "Work Item",
  objective: "OKR",
  contact: "CRM",
  note: "Note",
};

const groupLabels: Record<SearchResult["type"], string> = {
  project: "Projects",
  work_item: "Work Items",
  objective: "OKRs",
  contact: "CRM",
  note: "Notes",
};

interface CommandPaletteProps {
  orgs: { id: string; slug: string }[];
}

type Mode = "search" | "create" | "projects";

export function CommandPalette({ orgs }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("search");
  const [projects, setProjects] = useState<PaletteProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { openDrawer } = useDrawers();
  const orgSlug = pathname.split("/")[1];
  const currentOrg = orgs.find((o) => o.slug === orgSlug);

  // Project key from a board/project route (e.g. /acme/projects/FSC/...).
  const segments = pathname.split("/").filter(Boolean);
  const onProjectRoute = segments[1] === "projects" && !!segments[2];
  const routeProjectKey = onProjectRoute ? segments[2] : null;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("cosmos:command-palette:open", handler);
    return () =>
      window.removeEventListener("cosmos:command-palette:open", handler);
  }, []);

  // Reset transient state whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setMode("search");
      setQuery("");
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open]);

  // Lazily fetch the org's projects — only when an action view that needs them
  // is opened (create / project picker). Keeps the common search path fast.
  const ensureProjects = useCallback(async () => {
    if (!currentOrg || projects.length > 0 || projectsLoading) return;
    setProjectsLoading(true);
    try {
      const data = await jsonFetch<
        { id: string; key: string; name: string }[]
      >(`/api/v1/orgs/${currentOrg.id}/projects`);
      setProjects(
        data.map((p) => ({ id: p.id, key: p.key, name: p.name })),
      );
    } catch {
      // Leave the list empty; pickers degrade gracefully.
    } finally {
      setProjectsLoading(false);
    }
  }, [currentOrg, projects.length, projectsLoading]);

  // Resolve the prefilled project for the route we're on (needs the project
  // list to map key -> id). Case-insensitive, matching the route resolver.
  const prefilledProject =
    routeProjectKey != null
      ? (projects.find(
          (p) => p.key.toLowerCase() === routeProjectKey.toLowerCase(),
        ) ?? null)
      : null;

  // Debounced search: clearing/streaming results from inside the effect is the
  // intended pattern here (synchronizing with the query input + fetch).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    // Only the search view queries the server. In action views the input is a
    // form field (e.g. the work-item title), not a search box.
    if (mode !== "search") return;

    const isActionQuery = query.trimStart().startsWith(">");
    if (!query.trim() || isActionQuery || !currentOrg) {
      setResults([]);
      return;
    }

    // Guard against out-of-order responses: a slow fetch for an earlier query
    // must not overwrite results from a later one. The cleanup flips `cancelled`
    // when the query changes, so a stale in-flight response is ignored.
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/v1/orgs/${currentOrg.id}/search?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled && res.ok) {
          const data: SearchResult[] = await res.json();
          setResults(data);
        }
      } catch {
        // Silently fail
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, currentOrg, mode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleSelect = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      setQuery("");
      router.push(result.url);
    },
    [router],
  );

  const openCreate = useCallback(() => {
    setMode("create");
    void ensureProjects();
  }, [ensureProjects]);

  const openProjectPicker = useCallback(() => {
    setMode("projects");
    void ensureProjects();
  }, [ensureProjects]);

  const goToNewBoard = useCallback(() => {
    if (routeProjectKey) {
      setOpen(false);
      router.push(`/${orgSlug}/projects/${routeProjectKey}/boards/new`);
    } else {
      // No project context — let the user pick a project first.
      openProjectPicker();
    }
  }, [routeProjectKey, orgSlug, router, openProjectPicker]);

  const goToProject = useCallback(
    (project: PaletteProject) => {
      setOpen(false);
      router.push(`/${orgSlug}/projects/${project.key}`);
    },
    [orgSlug, router],
  );

  // Navigate to a workspace destination (relative to the org slug) and close.
  const goTo = useCallback(
    (suffix: string) => {
      setOpen(false);
      router.push(`/${orgSlug}${suffix}`);
    },
    [orgSlug, router],
  );

  // Open the Assistant drawer from anywhere (the FloatingAgentBubble listens).
  const openAssistant = useCallback(() => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("cosmos:agent:open"));
  }, []);

  // Drawer-backed destinations (e.g. Chat) live in the docked slide drawer now —
  // opening one must dock it in place, NOT navigate to the orphaned standalone
  // page (mirrors the topbar/sidebar/mobile-nav, which all use openDrawer).
  const openToolDrawer = useCallback(
    (t: DrawerTool) => {
      setOpen(false);
      openDrawer(t);
    },
    [openDrawer],
  );

  // Quick-jump destinations — the bulk of the "operations" expansion. Each is a
  // real workspace route; they're filtered live by whatever you type after ">".
  const navItems: { id: string; label: string; suffix: string; drawer?: DrawerTool; icon: React.ReactNode }[] = [
    { id: "overview", label: "Overview", suffix: "", icon: <LayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "projects", label: "Projects", suffix: "/projects", icon: <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "issues", label: "Issues", suffix: "/issues", icon: <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "chat", label: "Chat", suffix: "/chat", drawer: "chat", icon: <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "notes", label: "Notes", suffix: "/notes", icon: <FileText className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "meetings", label: "Meetings", suffix: "/meetings", icon: <Video className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "team", label: "Team", suffix: "/team", icon: <Users className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "crm", label: "CRM", suffix: "/crm", icon: <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "contracts", label: "Contracts", suffix: "/contracts", icon: <FileSignature className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "analytics", label: "Analytics", suffix: "/analytics", icon: <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "finance", label: "Finance", suffix: "/finance", icon: <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "time", label: "Time Tracking", suffix: "/time-tracking", icon: <Clock className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "feedback", label: "Feedback", suffix: "/feedback", icon: <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" /> },
    { id: "settings", label: "Settings", suffix: "/settings", icon: <Settings className="h-4 w-4 shrink-0 text-muted-foreground" /> },
  ];

  const grouped = results.reduce(
    (acc, result) => {
      if (!acc[result.type]) acc[result.type] = [];
      acc[result.type].push(result);
      return acc;
    },
    {} as Record<string, SearchResult[]>,
  );

  const groupOrder: SearchResult["type"][] = [
    "project",
    "work_item",
    "objective",
    "contact",
    "note",
  ];

  // The verb-stripped query (after a leading ">") used for action display.
  const actionQuery = query.trimStart().replace(/^>\s*/, "");
  const showActions =
    mode === "search" && (query.trim() === "" || query.trimStart().startsWith(">"));

  // In the actions view, narrow both the quick actions and the nav list by the
  // text typed after ">" (case-insensitive substring on the visible label).
  const matchesAction = (label: string) =>
    actionQuery.trim() === "" ||
    label.toLowerCase().includes(actionQuery.trim().toLowerCase());
  const filteredNav = showActions ? navItems.filter((n) => matchesAction(n.label)) : [];
  const fixedActionLabels = [
    prefilledProject ? `Create work item in ${prefilledProject.key}` : "Create work item",
    ...(onProjectRoute ? ["Add card to this project"] : []),
    "Go to project",
    "New board",
    "New project",
    "Open Assistant",
  ];
  const anyActionVisible =
    showActions && (filteredNav.length > 0 || fixedActionLabels.some(matchesAction));

  const inputPlaceholder =
    mode === "create"
      ? "Work item title…"
      : mode === "projects"
        ? "Filter projects…"
        : "Search projects, items, OKRs… or “>” for actions";

  // shouldFilter={false}: results are filtered server-side; cmdk's client filter
  // would otherwise re-hide rows (it matches the query against the item value, a
  // "{type}-{id}" string, not the visible name).
  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput
        placeholder={inputPlaceholder}
        value={query}
        onValueChange={setQuery}
      />

      {mode === "create" && currentOrg ? (
        <QuickCreateWorkItem
          orgId={currentOrg.id}
          orgSlug={orgSlug}
          title={query}
          prefilledProject={prefilledProject}
          projects={projects}
          projectsLoading={projectsLoading}
          onClose={() => setOpen(false)}
        />
      ) : mode === "projects" ? (
        <CommandList>
          {projectsLoading ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted-foreground">Loading projects…</p>
            </div>
          ) : (
            (() => {
              const filtered = projects.filter((p) =>
                `${p.key} ${p.name}`
                  .toLowerCase()
                  .includes(query.trim().toLowerCase()),
              );
              if (filtered.length === 0) {
                return <CommandEmpty>No projects found.</CommandEmpty>;
              }
              return (
                <CommandGroup heading="Go to project">
                  {filtered.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`project-${p.id}`}
                      onSelect={() => goToProject(p)}
                    >
                      <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{p.name}</span>
                      <Badge variant="neutral" className="ml-2 text-[10px]">
                        {p.key}
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })()
          )}
        </CommandList>
      ) : (
        <CommandList>
          {showActions && fixedActionLabels.some(matchesAction) && (
            <CommandGroup heading="Actions">
              {matchesAction(
                prefilledProject
                  ? `Create work item in ${prefilledProject.key}`
                  : "Create work item",
              ) && (
                <CommandItem value="action-create-work-item" onSelect={openCreate}>
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">
                    {prefilledProject
                      ? `Create work item in ${prefilledProject.key}…`
                      : "Create work item…"}
                  </span>
                  <CornerDownLeft className="ml-2 h-3.5 w-3.5 text-muted-foreground/60" />
                </CommandItem>
              )}

              {onProjectRoute && matchesAction("Add card to this project") && (
                <CommandItem
                  value="action-add-card"
                  onSelect={openCreate}
                >
                  <LayoutList className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">
                    Add card to this project
                  </span>
                </CommandItem>
              )}

              {matchesAction("Go to project") && (
                <CommandItem
                  value="action-go-to-project"
                  onSelect={openProjectPicker}
                >
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">Go to project…</span>
                </CommandItem>
              )}

              {matchesAction("New board") && (
                <CommandItem value="action-new-board" onSelect={goToNewBoard}>
                  <Columns3 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">New board</span>
                </CommandItem>
              )}

              {matchesAction("New project") && (
                <CommandItem
                  value="action-new-project"
                  onSelect={() => goTo("/projects/new")}
                >
                  <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">New project…</span>
                </CommandItem>
              )}

              {matchesAction("Open Assistant") && (
                <CommandItem value="action-assistant" onSelect={openAssistant}>
                  <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">Open Assistant</span>
                </CommandItem>
              )}
            </CommandGroup>
          )}

          {showActions && currentOrg && filteredNav.length > 0 && (
            <CommandGroup heading="Go to">
              {filteredNav.map((n) => (
                <CommandItem
                  key={n.id}
                  value={`nav-${n.id}`}
                  onSelect={() =>
                    n.drawer ? openToolDrawer(n.drawer) : goTo(n.suffix)
                  }
                >
                  {n.icon}
                  <span className="flex-1 truncate">{n.label}</span>
                  <ArrowRight className="ml-2 h-3.5 w-3.5 text-muted-foreground/40" />
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {query.trim() === "" ? (
            <div className="px-2 pb-3 pt-1 text-center">
              <p className="text-xs text-muted-foreground">
                Type to search · “{">"}” for actions
              </p>
            </div>
          ) : query.trimStart().startsWith(">") ? (
            actionQuery.trim() === "" || anyActionVisible ? null : (
              <CommandEmpty>No actions match “{actionQuery.trim()}”.</CommandEmpty>
            )
          ) : loading ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted-foreground">Searching...</p>
            </div>
          ) : results.length === 0 ? (
            <CommandEmpty>No results found.</CommandEmpty>
          ) : (
            groupOrder.map((type) => {
              const items = grouped[type];
              if (!items || items.length === 0) return null;
              return (
                <CommandGroup key={type} heading={groupLabels[type]}>
                  {items.map((result) => (
                    <CommandItem
                      key={result.id}
                      value={`${result.type}-${result.id}`}
                      onSelect={() => handleSelect(result)}
                    >
                      {typeIcons[result.type]}
                      <span className="flex-1 truncate">{result.name}</span>
                      <Badge variant="neutral" className="ml-2 text-[10px]">
                        {typeLabels[result.type]}
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })
          )}
        </CommandList>
      )}
    </CommandDialog>
  );
}
