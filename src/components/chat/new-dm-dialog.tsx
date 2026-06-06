"use client";
import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOrgMembers } from "./mention-picker";

export function NewDmDialog({ orgId }: { orgId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1] ?? "";
  const { data: members } = useOrgMembers(orgId);
  const qc = useQueryClient();
  const channelsKey = useOrgQueryKey("chat-channels");

  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const filtered = (members ?? [])
    .filter(
      (m) =>
        m.displayName.toLowerCase().includes(query.toLowerCase()) &&
        !picked.includes(m.id),
    )
    .slice(0, 10);

  async function go() {
    if (picked.length === 0 || picked.length > 7) return;
    setError(null);
    const r = await fetch(`/api/v1/orgs/${orgId}/chat/dms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIds: picked }),
    });
    if (!r.ok) {
      setError("Failed to start DM");
      return;
    }
    const j = await r.json();
    const channelId = j?.channelId ?? j?.data?.channelId;
    if (!channelId) {
      setError("Unexpected response");
      return;
    }
    await qc.invalidateQueries({ queryKey: channelsKey });
    setOpen(false);
    setPicked([]);
    setQuery("");
    router.push(`/${orgSlug}/chat/${channelId}`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 text-left"
          />
        }
      >
        + New DM
      </DialogTrigger>
      <DialogContent className="w-96">
        <DialogTitle>New direct message</DialogTitle>
        <div className="space-y-2 mt-2">
          <div className="flex flex-wrap gap-1">
            {picked.map((id) => {
              const u = members?.find((m) => m.id === id);
              if (!u) return null;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPicked((p) => p.filter((x) => x !== id))}
                  className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
                  aria-label={`Remove ${u.displayName}`}
                >
                  {u.displayName} ✕
                </button>
              );
            })}
          </div>
          <input
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder={
              picked.length >= 7
                ? "Max 7 other people"
                : "Add people…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={picked.length >= 7}
          />
          <div className="max-h-64 overflow-y-auto divide-y">
            {filtered.map((m) => (
              <button
                type="button"
                key={m.id}
                onClick={() => {
                  setPicked((p) => [...p, m.id]);
                  setQuery("");
                }}
                className="w-full px-2 py-1 flex items-center gap-2 hover:bg-accent text-left text-sm"
              >
                <span>{m.displayName}</span>
                <span className="text-muted-foreground text-xs">{m.email}</span>
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button onClick={go} disabled={picked.length === 0}>
              Start
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
