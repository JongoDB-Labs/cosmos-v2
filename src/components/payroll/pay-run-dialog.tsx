"use client";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const fmt = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

type PayRun = {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "POSTED";
  laborCost: string;
};
type Preview = {
  byProject: { projectId: string | null; projectName: string | null; cost: string }[];
  total: string;
  priced: number;
  unpriced: number;
};

export function PayRunDialog({
  orgId,
  run,
  onOpenChange,
}: {
  orgId: string;
  run: PayRun | null;
  onOpenChange: (open: boolean) => void;
}) {
  const previewKey = useOrgQueryKey("pay-runs", run?.id ?? "", "preview");
  const previewQ = useQuery({
    queryKey: previewKey,
    enabled: run !== null && run.status === "DRAFT",
    queryFn: () =>
      jsonFetch<{ data: Preview }>(
        `/api/v1/orgs/${orgId}/pay-runs/${run!.id}/preview`,
      ).then((r) => r.data),
  });

  const post = useOrgMutation<{ unpricedSkipped?: number }, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/pay-runs/${run!.id}/post`, { method: "POST" }),
    invalidate: [["pay-runs"], ["payroll", "labor-by-project"]],
    onSuccess: () => onOpenChange(false),
    onError: (e) => notifyError(e, "Couldn't post the pay run."),
  });

  const p = previewQ.data;

  return (
    <Dialog open={run !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Pay run
            {run && (
              <Badge variant={run.status === "POSTED" ? "done" : "neutral"}>
                {run.status}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {run
              ? `${new Date(run.periodStart).toLocaleDateString()} – ${new Date(
                  run.periodEnd,
                ).toLocaleDateString()}${run.label ? ` · ${run.label}` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {run?.status === "POSTED" ? (
          <div className="text-sm">
            Posted labor cost:{" "}
            <span className="font-semibold tabular-nums">{fmt(run.laborCost)}</span>
          </div>
        ) : previewQ.isLoading ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : p ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Project</th>
                    <th className="px-3 py-1.5 text-right font-medium">Labor cost</th>
                  </tr>
                </thead>
                <tbody>
                  {p.byProject.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-3 py-3 text-center text-muted-foreground">
                        No priced, approved labor in this period.
                      </td>
                    </tr>
                  ) : (
                    p.byProject.map((g) => (
                      <tr key={g.projectId ?? "none"} className="border-b last:border-0">
                        <td className="px-3 py-1.5">
                          {g.projectId ? (
                            <span className="text-xs">
                              {g.projectName ?? "Unknown project"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Unassigned</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(g.cost)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {p.priced} entries priced
                {p.unpriced > 0 && (
                  <span className="text-destructive"> · {p.unpriced} with no pay rate (skipped)</span>
                )}
              </span>
              <span className="font-semibold tabular-nums">Total {fmt(p.total)}</span>
            </div>
            <div className="flex justify-end">
              <Button
                disabled={post.isPending || Number(p.total) <= 0}
                onClick={() => post.mutate()}
              >
                Post to ledger
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
