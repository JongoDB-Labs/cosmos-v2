import { getCurrentUser } from "@/lib/auth/session";
import { isInternalAdmin } from "@/lib/internal/access";

/**
 * Gate for INSTANCE-WIDE admin surfaces (sign-in providers, the global email
 * allowlist, tenant-class, etc.). Returns the current user iff they're a
 * platform/system admin per the INTERNAL_ADMINS allowlist, else null.
 *
 * This is the SYSTEM tier of the admin hierarchy (system → org → project →
 * board). It deliberately does NOT accept "OWNER of any org": org ownership is
 * a per-tenant role, and self-service org creation mints OWNER, so gating an
 * instance-wide control on it is an escalation path. Org/project/board-scoped
 * admin is enforced separately via the permission/role checks at those scopes.
 */
export async function requireSystemAdmin() {
  const me = await getCurrentUser();
  if (!me) return null;
  return isInternalAdmin(me.email, process.env.INTERNAL_ADMINS) ? me : null;
}
