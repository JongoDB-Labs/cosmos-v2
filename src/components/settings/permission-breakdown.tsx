import { ALL_PERMISSIONS, PERMISSION_GROUPS, labelOf } from "@/lib/rbac/permission-groups";
import type { PermissionKey } from "@/lib/rbac/permissions";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Read-only, grouped view of a permission set — e.g. what a work role or
 * built-in preset grants. Server-component-safe (no hooks); pairs with the
 * editable checklist in RoleEditor, which shares the same grouping/labeling
 * (see @/lib/rbac/permission-groups).
 */
export function PermissionBreakdown({
  permissions,
  className,
}: {
  permissions: PermissionKey[];
  className?: string;
}) {
  const granted = new Set<string>(permissions);

  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-sm text-muted-foreground">
        {`${granted.size} of ${ALL_PERMISSIONS.length} permissions`}
      </p>
      {Object.entries(PERMISSION_GROUPS).map(([group, keys]) => {
        const grantedKeys = keys.filter((k) => granted.has(k));
        if (grantedKeys.length === 0) return null;
        return (
          <div key={group}>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {grantedKeys.map((k) => (
                <Badge key={k} variant="neutral" className="text-[10px]">
                  {labelOf(k)}
                </Badge>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
