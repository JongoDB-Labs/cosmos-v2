"use client";

import { createContext, useContext, useMemo } from "react";
import { usePathname } from "next/navigation";
import { Permission, RolePermissions, hasPermission, permissionMaskFromKeys } from "@/lib/rbac/permissions";

interface Org {
  id: string;
  slug: string;
  role: string;
  /** The permission KEYS this person's session holds in the org, computed on
   *  the server by the fold its own checks use (the dashboard layout). The org
   *  role alone misses work roles, a stored override and the org's
   *  restrictions, so `can()` reads these, never the role. */
  permissions: readonly string[];
}

interface PermissionsContextValue {
  orgId: string;
  orgSlug: string;
  role: string;
  permissions: bigint;
  can: (perm: bigint) => boolean;
}

const PermissionsContext = createContext<PermissionsContextValue | null>(null);

export function PermissionsProvider({
  orgs,
  children,
}: {
  orgs: Org[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";

  const value = useMemo(() => {
    const org = orgs.find((o) => o.slug === orgSlug);
    if (!org) return null;
    const perms = permissionMaskFromKeys(org.permissions);
    return {
      orgId: org.id,
      orgSlug: org.slug,
      role: org.role,
      permissions: perms,
      can: (perm: bigint) => hasPermission(perms, perm),
    };
  }, [orgs, orgSlug]);

  return (
    <PermissionsContext.Provider value={value}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions(): PermissionsContextValue {
  const ctx = useContext(PermissionsContext);
  if (!ctx) {
    return {
      orgId: "",
      orgSlug: "",
      role: "VIEWER",
      permissions: RolePermissions.VIEWER,
      can: (perm: bigint) => hasPermission(RolePermissions.VIEWER, perm),
    };
  }
  return ctx;
}

export { Permission };
