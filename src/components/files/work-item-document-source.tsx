"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";

interface DocSource {
  docId: string;
  docTitle: string;
  blockAnchor: string;
}

/**
 * A "Source" chip on a work item that was created from a document (via the Files
 * convert/AI-propose flow). Links back to the exact block in the Files tab. Renders
 * nothing when the item has no document source.
 */
export function WorkItemDocumentSource({
  itemId,
  orgId,
  projectId,
}: {
  itemId: string;
  orgId: string;
  projectId: string;
}) {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const orgSlug = parts[0] ?? "";
  const projectKey = parts[1] === "projects" ? parts[2] ?? "" : "";

  const key = useOrgQueryKey("work-item-source", projectId, itemId);
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<DocSource | null>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/work-items/${itemId}/document-source`,
      ),
    staleTime: 60_000,
  });

  if (!data) return null;

  return (
    <Link
      href={`/${orgSlug}/projects/${projectKey}/files/${data.docId}#${data.blockAnchor}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
      title={`From document: ${data.docTitle}`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Source: {data.docTitle}</span>
    </Link>
  );
}
