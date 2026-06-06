"use client";

import { cn } from "@/lib/utils";
import type { WorkItem } from "@/types/models";

interface ActivityFeedProps {
  items: WorkItem[];
  projectKey: string;
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function ActivityFeed({ items, projectKey }: ActivityFeedProps) {
  // Show recently updated items as activity proxy
  const recentItems = [...items]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10);

  if (recentItems.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No recent activity
      </div>
    );
  }

  return (
    <div className="space-y-1 overflow-y-auto h-full">
      {recentItems.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors"
        >
          <div
            className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              item.completedAt
                ? "bg-green-500"
                : "bg-blue-500"
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs truncate">
              <span className="text-muted-foreground">
                {projectKey}-{item.ticketNumber}
              </span>{" "}
              {item.title}
            </p>
          </div>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {timeAgo(item.updatedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}
