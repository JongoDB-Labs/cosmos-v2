import type { ComponentType } from "react";

export interface WidgetProps {
  config: Record<string, unknown>;
  orgId: string;
  projectId?: string;
  boardId?: string;
}

export interface WidgetRegistration {
  slug: string;
  name: string;
  category: "data" | "layout" | "filter" | "info";
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
