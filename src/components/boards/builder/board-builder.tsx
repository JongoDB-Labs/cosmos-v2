"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { GridLayout, verticalCompactor, type Layout } from "react-grid-layout";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Save,
  Undo2,
  Redo2,
  Eye,
  EyeOff,
  X,
  Loader2,
  GripVertical,
} from "lucide-react";
import { useBuilderStore } from "@/lib/boards/builder-store";
import { WidgetPalette, type PaletteWidget } from "./widget-palette";
import { ConfigPanel } from "./config-panel";
import type { BuilderWidget, Board } from "@/types/models";

import "react-grid-layout/css/styles.css";

interface BoardBuilderProps {
  orgId: string;
  projectId: string;
  boardId: string;
  initialBoard: Board;
  sector?: string;
}

export function BoardBuilder({
  orgId,
  projectId,
  boardId,
  initialBoard,
  sector,
}: BoardBuilderProps) {
  const {
    widgets,
    selectedWidgetId,
    undoStack,
    redoStack,
    isDirty,
    boardName,
    addWidget,
    removeWidget,
    updateWidgetConfig,
    updateWidgetLayout,
    selectWidget,
    undo,
    redo,
    setBoardName,
    loadFromBoard,
    save,
    markDirty,
  } = useBuilderStore();

  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const initialized = useRef(false);

  // Load board data on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const existingWidgets = (initialBoard.config as { widgets?: BuilderWidget[] })?.widgets ?? [];
    loadFromBoard(initialBoard.name, existingWidgets);
  }, [initialBoard, loadFromBoard]);

  const selectedWidget = widgets.find((w) => w.id === selectedWidgetId) ?? null;

  const handleAddWidget = useCallback(
    (paletteWidget: PaletteWidget) => {
      const id = `w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      // Find the bottom of existing widgets to place new one below
      const maxY = widgets.reduce(
        (max, w) => Math.max(max, w.layout.y + w.layout.h),
        0
      );
      const widget: BuilderWidget = {
        id,
        type: paletteWidget.type,
        config: { title: paletteWidget.name },
        layout: { x: 0, y: maxY, w: paletteWidget.defaultW, h: paletteWidget.defaultH },
      };
      addWidget(widget);
    },
    [widgets, addWidget]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    // Capture the widgets + clear dirty synchronously: edits made DURING the
    // request re-set isDirty themselves, so they survive a successful save
    // (avoids a TOCTOU where a late save() would clear their unsaved flag).
    const savedWidgets = save();
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards/${boardId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: boardName,
            config: { widgets: savedWidgets },
          }),
        }
      );
      if (!res.ok) throw new Error(`Failed to save board (HTTP ${res.status})`);
    } catch (err) {
      console.error("Failed to save board:", err);
      // Re-flag dirty so the Save button re-enables for a retry.
      markDirty();
      notifyError(err, "Couldn't save the board layout.");
    } finally {
      setSaving(false);
    }
  }, [orgId, projectId, boardId, boardName, save, markDirty]);

  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      layout.forEach((item) => {
        const existing = widgets.find((w) => w.id === item.i);
        if (
          existing &&
          (existing.layout.x !== item.x ||
            existing.layout.y !== item.y ||
            existing.layout.w !== item.w ||
            existing.layout.h !== item.h)
        ) {
          updateWidgetLayout(item.i, {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          });
        }
      });
    },
    [widgets, updateWidgetLayout]
  );

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Delete" || e.key === "Backspace") {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (selectedWidgetId) {
          e.preventDefault();
          removeWidget(selectedWidgetId);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedWidgetId, removeWidget, undo, redo]);

  const gridLayout: Layout = widgets.map((w) => ({
    i: w.id,
    x: w.layout.x,
    y: w.layout.y,
    w: w.layout.w,
    h: w.layout.h,
    minW: 2,
    minH: 1,
  }));

  return (
    <div className="flex flex-col h-full">
      {/* Top toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-background">
        <Input
          value={boardName}
          onChange={(e) => setBoardName(e.target.value)}
          className="w-56 font-medium"
          placeholder="Board name"
        />

        <div className="flex items-center gap-1 ml-auto">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={undo}
            disabled={undoStack.length === 0}
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={redo}
            disabled={redoStack.length === 0}
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-4 w-4" />
          </Button>

          <div className="w-px h-5 bg-border mx-1" />

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPreview((p) => !p)}
            title={preview ? "Edit mode" : "Preview mode"}
          >
            {preview ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>

          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1" />
            )}
            Save
          </Button>
        </div>
      </div>

      {/* Mobile: read-only widget stack. The builder UI (palette, drag,
          resize, config panel) is desktop-only because react-grid-layout
          requires mouse precision. */}
      <div className="md:hidden flex-1 overflow-auto p-3">
        <MobileBuilderBanner />
        {widgets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 text-center py-12">
            <div className="h-16 w-16 rounded-xl bg-muted flex items-center justify-center">
              <GripVertical className="h-8 w-8 text-muted-foreground/40" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                No widgets yet
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Open on a larger screen to add widgets
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {widgets.map((widget) => (
              <div
                key={widget.id}
                className="rounded-lg border bg-background p-4"
              >
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium truncate">
                    {(widget.config.title as string) ||
                      widget.type.replace(/-/g, " ")}
                  </h3>
                </div>
                <div className="flex items-center justify-center py-6">
                  <span className="text-xs text-muted-foreground capitalize">
                    {widget.type.replace(/-/g, " ")} widget
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Desktop: palette + canvas + config */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        {/* Left: Widget Palette (hidden in preview) */}
        {!preview && <WidgetPalette onAddWidget={handleAddWidget} sector={sector} />}

        {/* Center: Canvas */}
        <div
          className="flex-1 overflow-auto bg-muted/20 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) selectWidget(null);
          }}
        >
          {widgets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <div className="h-16 w-16 rounded-xl bg-muted flex items-center justify-center">
                <GripVertical className="h-8 w-8 text-muted-foreground/40" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Canvas is empty
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Click widgets from the palette to add them
                </p>
              </div>
            </div>
          ) : (
            <GridLayout
              className="layout"
              layout={gridLayout}
              gridConfig={{ cols: 12, rowHeight: 60, margin: [12, 12] as [number, number] }}
              width={900}
              dragConfig={{ enabled: !preview }}
              resizeConfig={{ enabled: !preview }}
              onLayoutChange={handleLayoutChange}
              compactor={verticalCompactor}
            >
              {widgets.map((widget) => (
                // Mouse click-to-select only: the tile contains its own
                // interactive controls (the X remove button + drag handle), so
                // it can't be a role="button" without invalid nested-interactive
                // ARIA. Keyboard selection would need a dedicated control inside
                // the header — out of scope for this builder (a mouse-centric
                // drag-and-drop canvas).
                <div
                  key={widget.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!preview) selectWidget(widget.id);
                  }}
                  className={cn(
                    "relative rounded-lg border bg-background shadow-sm transition-shadow",
                    "hover:shadow-md",
                    selectedWidgetId === widget.id &&
                      !preview &&
                      "ring-2 ring-primary border-primary",
                    preview && "cursor-default"
                  )}
                >
                  {/* Widget header */}
                  <div className="flex items-center justify-between px-3 py-2 border-b">
                    <span className="text-xs font-medium truncate">
                      {(widget.config.title as string) || widget.type.replace(/-/g, " ")}
                    </span>
                    {!preview && selectedWidgetId === widget.id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeWidget(widget.id);
                        }}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Widget body placeholder */}
                  <div className="p-3 flex items-center justify-center h-[calc(100%-33px)]">
                    <span className="text-xs text-muted-foreground capitalize">
                      {widget.type.replace(/-/g, " ")} widget
                    </span>
                  </div>
                </div>
              ))}
            </GridLayout>
          )}
        </div>

        {/* Right: Config Panel (hidden in preview) */}
        {!preview && (
          <ConfigPanel
            widget={selectedWidget}
            onUpdateConfig={(config) => {
              if (selectedWidgetId) updateWidgetConfig(selectedWidgetId, config);
            }}
            onDelete={() => {
              if (selectedWidgetId) removeWidget(selectedWidgetId);
            }}
          />
        )}
      </div>
    </div>
  );
}

function MobileBuilderBanner() {
  return (
    <div className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      Widget layout editing is desktop-only. View widgets here; switch to a
      larger screen to add, rearrange, or configure them.
    </div>
  );
}
