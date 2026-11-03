"use client";

/**
 * Draws the widgets a board has saved (`Board.config.widgets`).
 *
 * This is the reader that did not exist. The builder has saved to that key
 * since the original v4.4.0 import (53cbcf5f, 2026-06-05), and
 * `widget-registry.ts` — written as the render seam — was never registered
 * into or read out of, so every saved layout was invisible. Same class of
 * defect as the whiteboard's dropped third callback argument and the CQL flag
 * with no setter: a complete feature with no consumer, which type-checks clean
 * and shows up in no diff.
 */
import { GridLayout, noCompactor, type Layout } from "react-grid-layout";
import { WidgetRegistry } from "@/lib/boards/widget-registry";
import {
  byGridPosition,
  normalizeLayout,
  type BoardWidgetData,
} from "@/lib/boards/widget-data";
import { WIDGET_DEFINITIONS } from "@/lib/boards/widget-definitions";
import { registerBoardWidgets } from "./widgets/board-widgets";
import type { BuilderWidget } from "@/types/models";

import "react-grid-layout/css/styles.css";

// Called at module scope rather than in an effect: the first render must find
// the registry populated, or every tile paints its unavailable state once and
// then flips — which looks exactly like a broken board on a slow machine.
registerBoardWidgets();

interface WidgetGridProps {
  widgets: BuilderWidget[];
  data: BoardWidgetData;
  orgId: string;
  projectId: string;
  boardId: string;
}

/** The catalogue's display name for a type, or the raw type if it has none. */
function widgetTypeName(type: string): string {
  return WIDGET_DEFINITIONS.find((d) => d.type === type)?.name ?? type;
}

/** The tile title: the author's own, else the widget's catalogue name. */
export function widgetTileTitle(widget: BuilderWidget): string {
  const raw = widget.config.title;
  return typeof raw === "string" && raw.trim().length > 0
    ? raw
    : widgetTypeName(widget.type);
}

/**
 * The honest answer for a type nothing draws yet.
 *
 * Names the type BOTH ways — the catalogue label a person recognises from the
 * palette, and the raw slug, which is what they would have to quote to ask for
 * it. A blank tile would read as a board that failed to load, which is the one
 * message that is actually false.
 */
function UnavailableWidget({ widget }: { widget: BuilderWidget }) {
  const name = widgetTypeName(widget.type);
  return (
    <div
      data-testid={`widget-unavailable-${widget.id}`}
      className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center"
    >
      <p className="text-xs font-medium text-muted-foreground">
        {name} is not available on this board yet
      </p>
      <p className="font-mono text-[10px] text-muted-foreground/70">
        {widget.type}
      </p>
    </div>
  );
}

/**
 * One widget's body, through the registry.
 *
 * Exported because the BUILDER renders it too: its canvas used to paint
 * `"{type} widget"` on every tile, so the one place you choose a layout was
 * also the one place that could not show you what the layout would look like.
 * `data` is optional for exactly that caller — the builder has no work items
 * loaded, and each widget handles its own absence of data.
 */
export function WidgetBody({
  widget,
  data,
  orgId,
  projectId,
  boardId,
}: { widget: BuilderWidget } & Omit<WidgetGridProps, "widgets" | "data"> & {
    data?: BoardWidgetData;
  }) {
  const registration = WidgetRegistry.get(widget.type);
  if (!registration) return <UnavailableWidget widget={widget} />;
  const { Component } = registration;
  return (
    <Component
      // The widget's own saved config wins over the registration's defaults,
      // and `__widgetId` lets a tile address its own value in the DOM without
      // every widget taking an extra prop the registry would have to carry.
      config={{
        ...registration.defaultConfig,
        ...widget.config,
        __widgetId: widget.id,
      }}
      data={data}
      orgId={orgId}
      projectId={projectId}
      boardId={boardId}
    />
  );
}

function WidgetTile({
  widget,
  children,
}: {
  widget: BuilderWidget;
  children: React.ReactNode;
}) {
  return (
    <>
      <h3 className="mb-2 truncate text-xs font-medium text-muted-foreground">
        {widgetTileTitle(widget)}
      </h3>
      <div className="min-h-0 flex-1" data-testid={`widget-body-${widget.id}`}>
        {children}
      </div>
    </>
  );
}

export function WidgetGrid({
  widgets,
  data,
  orgId,
  projectId,
  boardId,
}: WidgetGridProps) {
  const rest = { data, orgId, projectId, boardId };

  // Clamped HERE as well as in `readBuilderWidgets`, because this component is
  // the last thing between a layout and react-grid-layout — and the library's
  // answer to a zero or negative dimension is a 1x1 cell at the origin, where
  // the tile collapses to an unreadable sliver under whatever else landed
  // there. Idempotent, so normalising an already-normal layout costs nothing.
  const placed = widgets.map((w) => ({ ...w, layout: normalizeLayout(w.layout) }));

  // Reading order for the stack. `widgets` is saved in the order tiles were
  // ADDED, which after a few drags has nothing to do with where they sit — so a
  // phone would read the board in creation order while a desktop reads it in
  // layout order, and the two would disagree about what the board says.
  const stacked = [...placed].sort(byGridPosition);

  const layout: Layout = placed.map((w) => ({
    i: w.id,
    x: w.layout.x,
    y: w.layout.y,
    w: w.layout.w,
    h: w.layout.h,
    minW: 2,
    minH: 1,
    // Read-only: this is the board, not the builder. Dragging here would move
    // a tile with nowhere to save it — and a static item is also exempt from
    // compaction, which is half of why the saved gaps survive (see the
    // `compactor` note below).
    static: true,
  }));

  return (
    <>
      {/* Mobile: a vertical stack. Same CSS-only split the default panels use,
          so there is no hydration flash and no second breakpoint to keep in
          step.

          `tabIndex={0}` here and on the desktop wrapper below, because a board
          of counters and text blocks contains nothing tabbable at all — and
          axe's `scrollable-region-focusable` (serious) is right that such a
          region is unreachable by keyboard. The default-panel wrappers get away
          without it only because their metric cards and chart segments are
          clickable. This would NOT have been caught by the gate:
          `e2e/a11y.spec.ts` scans the gallery dashboard and no seeded board has
          saved widgets, so `widget-grid.test.tsx` pins it instead. */}
      <div className="flex-1 overflow-auto p-3 md:hidden" tabIndex={0}>
        <div className="space-y-3">
          {stacked.map((w) => (
            <div
              key={w.id}
              className="flex min-h-48 flex-col rounded-lg border bg-background p-4"
            >
              <WidgetTile widget={w}>
                <WidgetBody widget={w} {...rest} />
              </WidgetTile>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop: the saved grid, honoured exactly. `noCompactor` and NOT the
          `verticalCompactor` the default panels use: compaction collapses
          vertical gaps, so a layout someone deliberately spaced out would be
          re-flowed into something they never saved.

          MEASURED, so nobody reads this as one guard: `static: true` above and
          `noCompactor` here are EACH sufficient on their own. Swapping in
          `verticalCompactor` while the items stay static changes nothing, and
          dropping `static` while this stays `noCompactor` changes nothing
          either; only removing both re-flows the layout. Both are kept because
          they say different things — static is "the reader cannot move this",
          noCompactor is "nothing moves it for them". */}
      <div className="hidden flex-1 overflow-auto p-4 md:block" tabIndex={0}>
        <GridLayout
          layout={layout}
          gridConfig={{
            cols: 12,
            rowHeight: 30,
            margin: [12, 12] as [number, number],
          }}
          width={1200}
          compactor={noCompactor}
          dragConfig={{ enabled: false }}
          resizeConfig={{ enabled: false }}
        >
          {placed.map((w) => (
            <div
              key={w.id}
              className="flex flex-col overflow-hidden rounded-lg border bg-background p-4"
            >
              <WidgetTile widget={w}>
                <WidgetBody widget={w} {...rest} />
              </WidgetTile>
            </div>
          ))}
        </GridLayout>
      </div>
    </>
  );
}
