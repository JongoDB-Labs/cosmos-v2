"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useRouter } from "next/navigation";

const inviteSchema = z.object({
  email: z.email("Enter a valid email address."),
  // Full assignable org-role set (OWNER excluded — ownership transfer is a
  // separate, deliberate flow). Granular per-permission / ABAC access is layered
  // on top via work-roles (selectable below; defined in Settings → Roles & Access).
  role: z.enum(["VIEWER", "MEMBER", "ADMIN", "BILLING_ADMIN", "GUEST"]),
  workRoleIds: z.array(z.string()),
});
type InviteValues = z.infer<typeof inviteSchema>;

type WorkRoleOption = { id: string; name: string; grants: string[] };

type InviteResponse = {
  invitation: { id: string; email: string; role: string };
  acceptUrl: string;
  emailSent: boolean;
  emailError: string | null;
};

export function InviteMemberButton({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<InviteResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "MEMBER", workRoleIds: [] },
  });

  const role = watch("role");
  const selectedRoles = watch("workRoleIds") ?? [];

  // Work-roles available to assign at invite time (granular permission grants +
  // ABAC policies, defined in Settings → Roles & Access).
  const { data: workRoles = [] } = useQuery({
    queryKey: ["work-roles", "invite", orgId],
    queryFn: () => jsonFetch<WorkRoleOption[]>(`/api/v1/orgs/${orgId}/work-roles`),
    enabled: open,
  });

  function toggleRole(id: string) {
    const next = selectedRoles.includes(id)
      ? selectedRoles.filter((r) => r !== id)
      : [...selectedRoles, id];
    setValue("workRoleIds", next, { shouldValidate: true });
  }

  const invite = useMutation({
    mutationFn: (payload: InviteValues) =>
      jsonFetch<InviteResponse>(`/api/v1/orgs/${orgId}/invitations`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (res) => {
      setResult(res);
      if (res.emailSent) {
        toast.success(`Invitation emailed to ${res.invitation.email}`);
      } else {
        toast.warning(
          "Invite created — email send unavailable, copy the link to share.",
        );
      }
      router.refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      reset();
      setResult(null);
      setCopied(false);
    }
  }

  async function copyLink() {
    if (!result?.acceptUrl) return;
    await navigator.clipboard.writeText(result.acceptUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Invite member
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {result ? "Invitation sent" : "Invite a teammate"}
          </DialogTitle>
          <DialogDescription>
            {result
              ? result.emailSent
                ? "An email with a sign-in link has been sent."
                : "Email delivery was unavailable. Share the link below."
              : "We'll email them a sign-in link. Their email is also added to the allowlist so the first sign-in is one click."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
              <p className="text-xs text-[var(--text-muted)]">Recipient</p>
              <p className="text-sm font-medium">{result.invitation.email}</p>
              <p className="mt-2 text-xs text-[var(--text-muted)]">Role</p>
              <p className="text-sm font-medium">{result.invitation.role}</p>
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                Sign-in link
              </Label>
              <div className="mt-1 flex items-center gap-2">
                <Input value={result.acceptUrl} readOnly className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copyLink}
                  aria-label="Copy invitation link"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-[var(--status-done)]" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {result.emailError ? (
                <p className="mt-2 text-xs text-[var(--status-blocked)]">
                  Email error: {result.emailError}
                </p>
              ) : null}
            </div>

            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  reset();
                  setResult(null);
                  setCopied(false);
                }}
              >
                Invite another
              </Button>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit((values) => invite.mutate(values))}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label
                htmlFor="invite-email"
                className="text-xs uppercase tracking-wide text-[var(--text-muted)]"
              >
                Email address
              </Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="teammate@example.com"
                autoFocus
                disabled={invite.isPending}
                aria-invalid={errors.email ? "true" : undefined}
                aria-describedby={errors.email ? "invite-email-error" : undefined}
                {...register("email")}
              />
              {errors.email ? (
                <p id="invite-email-error" className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="invite-role"
                className="text-xs uppercase tracking-wide text-[var(--text-muted)]"
              >
                Role
              </Label>
              <Select
                value={role}
                onValueChange={(v) =>
                  setValue("role", v as InviteValues["role"], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GUEST">Guest — comment on items only</SelectItem>
                  <SelectItem value="VIEWER">Viewer — read-only access</SelectItem>
                  <SelectItem value="MEMBER">Member — standard access</SelectItem>
                  <SelectItem value="BILLING_ADMIN">Billing admin — finance & billing</SelectItem>
                  <SelectItem value="ADMIN">Admin — manage the whole org</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {workRoles.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  Work-roles (optional)
                </Label>
                <p className="text-xs text-[var(--text-muted)]">
                  Extra permissions + attribute rules applied on top of the org
                  role when they accept. Manage these in Settings → Roles &amp; Access.
                </p>
                <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-[var(--border)] p-2">
                  {workRoles.map((wr) => (
                    <label
                      key={wr.id}
                      className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-[var(--primary-tint)]"
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 rounded border-border"
                        checked={selectedRoles.includes(wr.id)}
                        onChange={() => toggleRole(wr.id)}
                        disabled={invite.isPending}
                      />
                      <span className="flex-1 truncate">{wr.name}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {wr.grants.length} perm{wr.grants.length === 1 ? "" : "s"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={invite.isPending}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? "Sending…" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
