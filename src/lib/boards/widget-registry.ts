import type { ComponentType } from "react";
import type { WidgetDefinition } from "./widget-definitions";
import type { BoardWidgetData } from "./widget-data";

/**
 * The render seam between a saved widget and the component that draws it.
 *
 * This file shipped with the board builder and had ZERO references outside
 * itself for as long as it existed: nothing registered, nothing read, and the
 * builder painted `"{type} widget"` placeholders on its own canvas. The
 * registrations now live in
 * `components/boards/dashboard/widgets/board-widgets.tsx` and the reader is
 * `components/boards/dashboard/widget-grid.tsx`.
 */
export interface WidgetProps {
  config: Record<string, unknown>;
  orgId: string;
  projectId?: string;
  boardId?: string;
  /**
   * Everything the host board computed from its FILTERED item set.
   *
   * Optional so a widget can be mounted in isolation (the builder's own
   * preview has no board data), which is also why every widget must render
   * something sensible without it.
   */
  data?: BoardWidgetData;
}

export interface WidgetRegistration {
  slug: string;
  name: string;
  /**
   * Shares the palette's vocabulary (`widget-definitions.ts`) rather than
   * inventing a second one. It used to read "data" | "layout" | "filter" |
   * "info" — four names no widget definition has ever used, so a registration
   * and its palette entry could not have agreed about a widget's category even
   * in principle.
   */
  category: WidgetDefinition["category"];
  icon: string;
  description: string;
  minWidth: number;
  minHeight: number;
  defaultConfig: Record<string, unknown>;
  Component: ComponentType<WidgetProps>;
}

const registry = new Map<string, WidgetRegistration>();

export const WidgetRegistry = {
  register(widget: WidgetRegistration) {
    registry.set(widget.slug, widget);
  },

  get(slug: string): WidgetRegistration | undefined {
    return registry.get(slug);
  },

  getAll(): WidgetRegistration[] {
    return Array.from(registry.values());
  },

  getByCategory(category: WidgetRegistration["category"]): WidgetRegistration[] {
    return Array.from(registry.values()).filter((w) => w.category === category);
  },

  has(slug: string): boolean {
    return registry.has(slug);
  },
};
