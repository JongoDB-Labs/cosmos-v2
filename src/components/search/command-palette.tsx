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
  FileText,
  LayoutList,
  Plus,
  ArrowRight,
  Columns3,
  CornerDownLeft,
  Video,
  Users,
  Sparkles,
  Milestone,
  Goal,
  Gauge,
  File,
  TriangleAlert,
  Package,
  OctagonX,
  GitPullRequestArrow,
  Hash,
  Contact,
  Handshake,
  Boxes,
} from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import {
  useDrawers,
  type DrawerTool,
} from "@/components/drawers/drawer-provider";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";
import type { SidebarOrgSettings } from "@/components/layouts/nav-plugins";
import {
  paletteDestinations,
  matchesWords,
  type PaletteDestination,
} from "./palette-destinations";
import {
  ENTITY_ORDER,
  ENTITY_LABEL,
  ENTITY_LABEL_PLURAL,
  type EntityType,
} from "@/lib/mentions/refs";
import {
  QuickCreateWorkItem,
  type PaletteProject,
} from "./quick-create-work-item";
import { CreateWorkItemDialog } from "@/components/work-items/create-work-item-dialog";
import {
  getNewWorkItemContext,
  newIssueActionLabel,
  type NewWorkItemContext,
} from "@/lib/boards/new-work-item-context";

// ⌘K is a GLOBAL search: the route returns the shared registry's canonical
// `EntityType`, so the palette groups/labels every entity class the platform
// indexes — not just the original four.
interface SearchResult {
  id: string;
  type: EntityType;
  name: string;
  description?: string;
  url: string;
}

const iconCls = "h-4 w-4 shrink-0 text-muted-foreground";
const typeIcons: Record<EntityType, React.ReactNode> = {
  user: <Users className={iconCls} />,
  project: <FolderKanban className={iconCls} />,
  workItem: <LayoutList className={iconCls} />,
  note: <FileText className={iconCls} />,
  meeting: <Video className={iconCls} />,
  board: <Columns3 className={iconCls} />,
  milestone: <Milestone className={iconCls} />,
  objective: <Target className={iconCls} />,
  goal: <Goal className={iconCls} />,
  kpi: <Gauge className={iconCls} />,
  document: <File className={iconCls} />,
  risk: <TriangleAlert className={iconCls} />,
  deliverable: <Package className={iconCls} />,
  blocker: <OctagonX className={iconCls} />,
  changeRequest: <GitPullRequestArrow className={iconCls} />,
  clin: <Hash className={iconCls} />,
  crmContact: <Contact className={iconCls} />,
  partner: <Handshake className={iconCls} />,
  product: <Boxes className={iconCls} />,
};

// Singular badge + plural group heading come straight from the shared registry
// so the palette, @-mention picker and chips all read the same names.
const typeLabels = ENTITY_LABEL;
const groupLabels = ENTITY_LABEL_PLURAL;

interface CommandPaletteProps {
  /** The org switches let the palette offer exactly what the sidebar shows. */
  orgs: ({ id: string; slug: string } & SidebarOrgSettings)[];
}

/** Most pages shown above the search results when typing without ">". */
const MAX_PAGE_MATCHES = 5;

type Mode = "search" | "create" | "projects";

export function CommandPalette({ orgs }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("search");
  const [projects, setProjects] = useState<PaletteProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // The surface-published "new work item, here" context, SNAPSHOT when the palette
  // opens (COSMOS-166). Snapshotting rather than subscribing keeps the globally
  // mounted palette out of the Gantt's hover re-render path, and it is the right
  // semantics anyway: the action applies to what you were looking at when you
  // pressed ⌘K, not to whatever the pointer drifted onto afterwards.
  const [newIssueCtx, setNewWorkItemCtx] = useState<NewWorkItemContext | null>(null);
  const [newIssueOpen, setNewWorkItemOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { openDrawer } = useDrawers();
  const { can, permissions } = usePermissions();
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

  // Reset transient state whenever the dialog closes; take the create-context
  // snapshot whenever it opens. The context is deliberately NOT cleared on
  // close — closing the palette is how the New-issue dialog gets opened.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (open) {
      setNewWorkItemCtx(getNewWorkItemContext());
    } else {
      setMode("search");
      setQuery("");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
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

  // Hand off to the SAME full create dialog the surface's own "New work item"
  // button opens — project, board, and the dates of the row in focus already
  // filled in — rather than the palette's cut-down capture form.
  const openNewWorkItem = useCallback(() => {
    setOpen(false);
    setNewWorkItemOpen(true);
  }, []);

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

  // Every page the person may open, from the same lists and filters as the
  // sidebar, topbar and Settings menu (palette-destinations.ts). Empty off an
  // org route.
  const destinations = paletteDestinations({ can, permissions, org: currentOrg });
  const openDestination = (d: PaletteDestination) =>
    d.drawer !== undefined ? openToolDrawer(d.drawer) : goTo(d.href);

  const grouped = results.reduce(
    (acc, result) => {
      (acc[result.type] ??= []).push(result);
      return acc;
    },
    {} as Partial<Record<EntityType, SearchResult[]>>,
  );

  // Render groups in the registry's canonical order (people, work items,
  // projects first — the most-searched classes — then the rest).
  const groupOrder: EntityType[] = ENTITY_ORDER;

  // The verb-stripped query (after a leading ">") used for action display.
  const actionQuery = query.trimStart().replace(/^>\s*/, "");
  const showActions =
    mode === "search" && (query.trim() === "" || query.trimStart().startsWith(">"));

  // In the actions view, narrow the actions and pages by the words typed after
  // ">" (each word must appear in the label, ignoring case).
  const matchesAction = (label: string) => matchesWords(label, actionQuery);
  const filteredNav = showActions
    ? destinations.filter((d) => d.group === "goto" && matchesAction(d.label))
    : [];
  // The ~23 Settings rows join the actions view only once something is typed,
  // so the first view stays short.
  const filteredSettings =
    showActions && actionQuery.trim() !== ""
      ? destinations.filter((d) => d.group === "settings" && matchesAction(d.label))
      : [];
  // Typing without ">": the best few pages sit above the search results.
  const isSearchQuery =
    mode === "search" && query.trim() !== "" && !query.trimStart().startsWith(">");
  const pageMatches = isSearchQuery
    ? destinations.filter((d) => matchesWords(d.label, query)).slice(0, MAX_PAGE_MATCHES)
    : [];

  // Actions, each offered only to someone who can use it. The rows and the
  // "anything visible?" check both read this one list, so a hidden action can
  // never leave an empty "Actions" heading or hide "No actions match".
  const newIssueLabel = newIssueCtx ? newIssueActionLabel(newIssueCtx) : null;
  const createLabel = prefilledProject
    ? `Create work item in ${prefilledProject.key}`
    : "Create work item";
  const actions: {
    value: string;
    label: string;
    text: string;
    icon: React.ReactNode;
    onSelect: () => void;
    enter?: boolean;
    allowed: boolean;
  }[] = [
    ...(newIssueLabel
      ? [{
          value: "action-new-work-item",
          label: newIssueLabel,
          text: `${newIssueLabel}…`,
          icon: <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />,
          onSelect: openNewWorkItem,
          enter: true,
          allowed: can(Permission.ITEM_CREATE),
        }]
      : []),
    {
      value: "action-create-work-item",
      label: createLabel,
      text: `${createLabel}…`,
      icon: <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />,
      onSelect: openCreate,
      enter: true,
      allowed: can(Permission.ITEM_CREATE),
    },
    {
      // Its picker loads the project list, which needs PROJECT_READ.
      value: "action-go-to-project",
      label: "Go to project",
      text: "Go to project…",
      icon: <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />,
      onSelect: openProjectPicker,
      allowed: can(Permission.PROJECT_READ),
    },
    {
      // On a project route a project MANAGER/LEAD may add boards without the
      // org-wide permission, so it stays; elsewhere it opens the project picker.
      value: "action-new-board",
      label: "New board",
      text: "New board",
      icon: <Columns3 className="h-4 w-4 shrink-0 text-muted-foreground" />,
      onSelect: goToNewBoard,
      allowed: onProjectRoute || can(Permission.PROJECT_READ),
    },
    {
      value: "action-new-project",
      label: "New project",
      text: "New project…",
      icon: <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />,
      onSelect: () => goTo("/projects/new"),
      allowed: can(Permission.PROJECT_CREATE),
    },
    {
      // Not gated, like the topbar's own Assistant button.
      value: "action-assistant",
      label: "Open Assistant",
      text: "Open Assistant",
      icon: <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />,
      onSelect: openAssistant,
      allowed: true,
    },
  ];
  const visibleActions = showActions
    ? actions.filter((a) => a.allowed && matchesAction(a.label))
    : [];
  const anyActionVisible =
    visibleActions.length > 0 || filteredNav.length > 0 || filteredSettings.length > 0;

  const inputPlaceholder =
    mode === "create"
      ? "Work item title…"
      : mode === "projects"
        ? "Filter projects…"
        : "Search everything — projects, items, docs, people… or “>” for actions";

  // shouldFilter={false}: results are filtered server-side; cmdk's client filter
  // would otherwise re-hide rows (it matches the query against the item value, a
  // "{type}-{id}" string, not the visible name).
  return (
    <>
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
          {visibleActions.length > 0 && (
            <CommandGroup heading="Actions">
              {visibleActions.map((a) => (
                <CommandItem key={a.value} value={a.value} onSelect={a.onSelect}>
                  {a.icon}
                  <span className="flex-1 truncate">{a.text}</span>
                  {a.enter && (
                    <CornerDownLeft className="ml-2 h-3.5 w-3.5 text-muted-foreground/60" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {filteredNav.length > 0 && (
            <CommandGroup heading="Go to">
              {filteredNav.map((d) => (
                <DestinationRow key={d.key} d={d} onSelect={() => openDestination(d)} />
              ))}
            </CommandGroup>
          )}

          {filteredSettings.length > 0 && (
            <CommandGroup heading="Settings">
              {filteredSettings.map((d) => (
                <DestinationRow key={d.key} d={d} onSelect={() => openDestination(d)} />
              ))}
            </CommandGroup>
          )}

          {pageMatches.length > 0 && (
            <CommandGroup heading="Pages">
              {pageMatches.map((d) => (
                <DestinationRow key={d.key} d={d} onSelect={() => openDestination(d)} />
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
            pageMatches.length > 0 ? null : <CommandEmpty>No results found.</CommandEmpty>
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
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{result.name}</span>
                        {/* Why it matched when the name doesn't show it: "Label: Security". */}
                        {result.description && (
                          <span className="truncate text-xs text-muted-foreground">{result.description}</span>
                        )}
                      </span>
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

    {newIssueCtx && (
      <CreateWorkItemDialog
        orgId={newIssueCtx.orgId}
        open={newIssueOpen}
        onOpenChange={setNewWorkItemOpen}
        projects={[
          {
            id: newIssueCtx.projectId,
            key: newIssueCtx.projectKey,
            name: newIssueCtx.projectName ?? newIssueCtx.projectKey,
            sector: newIssueCtx.sector ?? null,
          },
        ]}
        prefilledProjectId={newIssueCtx.projectId}
        boardId={newIssueCtx.boardId}
        initialStartDate={newIssueCtx.startDate}
        initialDueDate={newIssueCtx.dueDate}
        onCreated={newIssueCtx.onCreated}
      />
    )}
    </>
  );
}

function DestinationRow({
  d,
  onSelect,
}: {
  d: PaletteDestination;
  onSelect: () => void;
}) {
  const Icon = d.icon;
  return (
    <CommandItem value={`nav-${d.key}`} onSelect={onSelect}>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{d.label}</span>
      <ArrowRight className="ml-2 h-3.5 w-3.5 text-muted-foreground/40" />
    </CommandItem>
  );
}
