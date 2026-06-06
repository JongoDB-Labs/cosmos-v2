"use client";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useEffect, useState } from "react";

export type OrgUser = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

/**
 * Fetches the org's members for the mention typeahead. The GET /members route
 * calls success(members) where members is an array — so the JSON body IS the
 * array (no wrapper key). We handle both shapes defensively.
 *
 * Each array element has shape: { id, orgId, userId, role, joinedAt, user: { id, email, displayName, avatarUrl } }
 * We map to a uniform OrgUser using m.user when present.
 */
export function useOrgMembers(orgId: string) {
  const key = useOrgQueryKey("chat-org-members");
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/v1/orgs/${orgId}/members`);
      if (!r.ok) throw new Error("Failed to load members");
      const j = await r.json();
      // success() returns data directly — the members route passes the array.
      // Defensively handle { members: [...] } or { data: [...] } wrapping too.
      type RawMember = {
        user?: { id: string; email?: string; displayName?: string; avatarUrl?: string | null };
        id?: string;
        userId?: string;
        displayName?: string;
        email?: string;
        avatarUrl?: string | null;
      };
      type RawResponse = { members?: RawMember[]; data?: RawMember[] } | RawMember[];
      const body = j as RawResponse;
      const raw: RawMember[] = Array.isArray(body) ? body : body.members ?? body.data ?? [];
      const mapped: OrgUser[] = raw.map((m) => {
        if (m.user) {
          // Primary shape: { userId, role, user: { id, email, displayName, avatarUrl } }
          return {
            id: m.user.id,
            displayName: m.user.displayName ?? m.user.email ?? "User",
            email: m.user.email ?? "",
            avatarUrl: m.user.avatarUrl ?? null,
          };
        }
        return {
          id: m.id ?? m.userId ?? "",
          displayName: m.displayName ?? m.email ?? "User",
          email: m.email ?? "",
          avatarUrl: m.avatarUrl ?? null,
        };
      });
      return mapped;
    },
    staleTime: 60_000,
  });
}

export function MentionPicker({
  query,
  anchor,
  members,
  onPick,
  onCancel,
}: {
  query: string;
  anchor: { top: number; left: number };
  members: OrgUser[];
  onPick: (user: OrgUser) => void;
  onCancel: () => void;
}) {
  const q = query.toLowerCase();
  const filtered = members
    .filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.email.toLowerCase().startsWith(q),
    )
    .slice(0, 8);
  const [active, setActive] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        setActive((a) => Math.min(filtered.length - 1, a + 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setActive((a) => Math.max(0, a - 1));
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (filtered[active]) {
          onPick(filtered[active]);
          e.preventDefault();
        }
      } else if (e.key === "Escape") {
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, active, onPick, onCancel]);

  if (filtered.length === 0) return null;
  return (
    <div
      className="fixed z-50 bg-popover border rounded shadow-md text-sm min-w-[200px]"
      style={{ top: anchor.top, left: anchor.left }}
    >
      {filtered.map((m, i) => (
        <button
          type="button"
          key={m.id}
          onClick={() => onPick(m)}
          className={
            "w-full px-3 py-1.5 flex items-center gap-2 text-left " +
            (i === active ? "bg-accent" : "hover:bg-accent")
          }
        >
          <span className="h-5 w-5 rounded-full bg-muted overflow-hidden shrink-0">
            {m.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.avatarUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            )}
          </span>
          <span>{m.displayName}</span>
          <span className="text-muted-foreground text-xs">{m.email}</span>
        </button>
      ))}
    </div>
  );
}
