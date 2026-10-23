"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TryItTokenPanel } from "./try-it-token-panel";

const ApiReferenceClient = dynamic(() => import("./api-reference.client"), {
  ssr: false,
  loading: () => <Skeleton className="h-[60vh] w-full" />,
});

/**
 * /developers/reference: the try-it token panel above Scalar.
 *
 * The spec is fetched here, WITH the session, and handed to Scalar as content.
 * Scalar's own fetch omits credentials (see api-reference.client.tsx), so
 * pointing it at the URL would 401 on any instance whose docs aren't public.
 */
export function ReferenceView() {
  const [spec, setSpec] = useState<object | null>(null);
  const [failed, setFailed] = useState(false);
  const [tryIt, setTryIt] = useState<{ token?: string; orgId?: string }>({});

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/v1/openapi.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((doc: object) => { if (live) setSpec(doc); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);

  // Pre-fill every `{orgId}` with the try-it organization, so a request works
  // without first looking the id up.
  const withOrg = useMemo(() => (spec && tryIt.orgId ? prefillOrgId(spec, tryIt.orgId) : null), [spec, tryIt.orgId]);

  return (
    <div className="space-y-4">
      <TryItTokenPanel onChange={setTryIt} />
      {failed ? (
        <LoadError title="Couldn't load the API description" onRetry={() => { setFailed(false); setAttempt((a) => a + 1); }} />
      ) : spec ? (
        <ApiReferenceClient spec={withOrg ?? spec} token={tryIt.token} />
      ) : (
        <Skeleton className="h-[60vh] w-full" />
      )}
    </div>
  );
}

type Param = { name?: string; in?: string; example?: unknown };
type Doc = { paths?: Record<string, Record<string, { parameters?: Param[] }>> };

/** A copy of the spec whose `orgId` path parameters carry `orgId` as their example. */
export function prefillOrgId(spec: object, orgId: string): object {
  const doc = structuredClone(spec) as Doc;
  for (const ops of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(ops)) {
      for (const p of op.parameters ?? []) if (p.in === "path" && p.name === "orgId") p.example = orgId;
    }
  }
  return doc;
}
