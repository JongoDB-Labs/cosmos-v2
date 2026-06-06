"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Settings2 } from "lucide-react";
import type { BuilderWidget } from "@/types/models";

const presetColors = [
  { label: "Blue", value: "#3b82f6" },
  { label: "Green", value: "#22c55e" },
  { label: "Yellow", value: "#eab308" },
  { label: "Red", value: "#ef4444" },
  { label: "Purple", value: "#a855f7" },
  { label: "Pink", value: "#ec4899" },
  { label: "Orange", value: "#f97316" },
  { label: "Gray", value: "#6b7280" },
];

const dataSources = [
  { label: "Work Items", value: "work-items" },
  { label: "Sprints", value: "sprints" },
  { label: "Objectives", value: "objectives" },
  { label: "Activity", value: "activity" },
  { label: "Members", value: "members" },
];

interface ConfigPanelProps {
  widget: BuilderWidget | null;
  onUpdateConfig: (config: Record<string, unknown>) => void;
  onDelete: () => void;
}

export function ConfigPanel({ widget, onUpdateConfig, onDelete }: ConfigPanelProps) {
  if (!widget) {
    return (
      <div className="flex flex-col w-72 border-l bg-muted/30">
        <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
          <Settings2 className="h-10 w-10 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">No widget selected</p>
            <p className="text-xs text-muted-foreground mt-1">
              Click a widget on the canvas to configure it
            </p>
          </div>
        </div>
      </div>
    );
  }

  const config = widget.config;

  return (
    <div className="flex flex-col w-72 border-l bg-muted/30 overflow-y-auto">
      <div className="flex items-center justify-between p-3 border-b">
        <div>
          <h3 className="text-sm font-semibold">Configure</h3>
          <p className="text-xs text-muted-foreground capitalize">
            {widget.type.replace(/-/g, " ")}
          </p>
        </div>
        <Button variant="destructive" size="icon-sm" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        {/* Title */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="widget-title">Title</Label>
          <Input
            id="widget-title"
            value={(config.title as string) ?? ""}
            onChange={(e) => onUpdateConfig({ title: e.target.value })}
            placeholder="Widget title"
          />
        </div>

        {/* Data source — for data widgets */}
        {(widget.type === "card-list" ||
          widget.type === "metric-counter" ||
          widget.type === "bar-chart" ||
          widget.type === "pie-chart" ||
          widget.type === "activity-feed" ||
          widget.type === "burndown-chart") && (
          <div className="flex flex-col gap-1.5">
            <Label>Data Source</Label>
            <Select
              value={(config.dataSource as string) ?? "work-items"}
              onValueChange={(val) => onUpdateConfig({ dataSource: val })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dataSources.map((src) => (
                  <SelectItem key={src.value} value={src.value}>
                    {src.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Color */}
        <div className="flex flex-col gap-1.5">
          <Label>Color</Label>
          <Select
            value={(config.color as string) ?? "#3b82f6"}
            onValueChange={(val) => onUpdateConfig({ color: val })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {presetColors.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  <span className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 rounded-full border"
                      style={{ backgroundColor: c.value }}
                    />
                    {c.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Text content — for text block */}
        {widget.type === "text-block" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-content">Content</Label>
            <textarea
              id="widget-content"
              className="flex min-h-[80px] w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={(config.content as string) ?? ""}
              onChange={(e) => onUpdateConfig({ content: e.target.value })}
              placeholder="Enter text content..."
            />
          </div>
        )}

        {/* Link list — for link list */}
        {widget.type === "link-list" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-links">Links (one per line, format: Label|URL)</Label>
            <textarea
              id="widget-links"
              className="flex min-h-[80px] w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={(config.links as string) ?? ""}
              onChange={(e) => onUpdateConfig({ links: e.target.value })}
              placeholder={"Docs|https://...\nAPI|https://..."}
            />
          </div>
        )}

        {/* Metric label — for metric counter */}
        {widget.type === "metric-counter" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-label">Label</Label>
            <Input
              id="widget-label"
              value={(config.label as string) ?? ""}
              onChange={(e) => onUpdateConfig({ label: e.target.value })}
              placeholder="e.g. Open Issues"
            />
          </div>
        )}

        {/* Max items — for lists/feeds */}
        {(widget.type === "card-list" || widget.type === "activity-feed") && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="widget-max-items">Max Items</Label>
            <Input
              id="widget-max-items"
              type="number"
              min={1}
              max={50}
              value={(config.maxItems as number) ?? 10}
              onChange={(e) =>
                onUpdateConfig({ maxItems: parseInt(e.target.value, 10) || 10 })
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
