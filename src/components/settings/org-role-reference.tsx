"use client";

import { useState } from "react";
import {
  RolePermissions,
  permissionNames,
  type PermissionKey,
} from "@/lib/rbac/permissions";
import { PermissionBreakdown } from "@/components/settings/permission-breakdown";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";

/** What a Clone click hands back to the parent (before it prefixes "Copy of "). */
export interface CloneSource {
  name: string;
  description: string | null;
  grants: PermissionKey[];
}

// The six built-in ORG roles (set per member on the Members page). Descriptions
// are product copy — keep them verbatim. Permission sets come from
// RolePermissions so this stays in lockstep with the RBAC source of truth.
const ORG_ROLES: {
  role: keyof typeof RolePermissions;
  label: string;
  description: string;
}[] = [
  { role: "OWNER", label: "Owner", description: "Everything, including deleting the org" },
  { role: "ADMIN", label: "Admin", description: "Run the org day-to-day (no billing, no org deletion)" },
  { role: "BILLING_ADMIN", label: "Billing admin", description: "Billing plus everyday member access" },
  { role: "MEMBER", label: "Member", description: "Standard collaborator" },
  { role: "VIEWER", label: "Viewer", description: "Read-only across the org" },
  { role: "GUEST", label: "Guest", description: "Minimal, invite-scoped access" },
];

/**
 * Read-only reference for the base org roles, shown above the work-role list.
 * Each card expands to a full PermissionBreakdown and can be cloned into a new
 * work role (grants copied, editable before save).
 */
export function OrgRoleReference({ onClone }: { onClone: (source: CloneSource) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Base org roles</h2>
      <div className="space-y-2">
        {ORG_ROLES.map(({ role, label, description }) => {
          const keys = permissionNames(RolePermissions[role]);
          const isOpen = expanded === role;
          return (
            <div key={role} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="mt-0.5"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${label}`}
                    onClick={() => setExpanded(isOpen ? null : role)}
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">{label}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {keys.length} permission{keys.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  aria-label={`Clone ${label}`}
                  onClick={() => onClone({ name: label, description, grants: keys })}
                >
                  <Copy className="mr-1 h-3.5 w-3.5" /> Clone
                </Button>
              </div>
              {isOpen && <PermissionBreakdown permissions={keys} className="mt-3" />}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Base roles are set per member on the Members page. Work roles below grant additional permissions on top.
      </p>
    </section>
  );
}
