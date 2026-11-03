"use client";

import { useCallback, useEffect, useState } from "react";
import { markStepAsked, readAskedSteps } from "@/lib/tours/progress";

/**
 * The steps of a walkthrough this reader has left something on: feedback they
 * sent, and questions they asked. The card's step picker marks them, so a
 * reader coming back to a long walkthrough can jump straight to what they had
 * said instead of paging through it with Next.
 *
 * - FEEDBACK is read from the feedback queue, so it survives a new session or a
 *   new browser: their own items raised from this tour (`sourceRef` is
 *   "<tourId>/<stepId>"), only theirs (`isMine`), as the queue lists it for them.
 * - QUESTIONS are remembered in this browser only, and only as "asked here": the
 *   conversations themselves are deleted when the card closes, on purpose.
 *
 * Plain state, not a query cache: it lives and dies with the open card, and a
 * failure to load it only means no marks.
 */
export function useTourMarks(orgId: string, tourId: string) {
  const [feedback, setFeedback] = useState<Set<string>>(() => new Set());
  const [asked, setAsked] = useState(() => readAskedSteps(tourId));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!tourId) return;
    let live = true;
    const prefix = `${tourId}/`;
    (async () => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/feedback?source=tour&sourceRef=${encodeURIComponent(prefix)}`,
        );
        if (!res.ok) return;
        const items = (await res.json()) as unknown;
        if (!live || !Array.isArray(items)) return;
        setFeedback(
          new Set(
            (items as { isMine?: boolean; sourceRef?: string | null }[])
              .filter((i) => i.isMine === true && typeof i.sourceRef === "string" && i.sourceRef.startsWith(prefix))
              .map((i) => i.sourceRef!.slice(prefix.length)),
          ),
        );
      } catch {
        /* no marks, nothing worse */
      }
    })();
    return () => {
      live = false;
    };
  }, [orgId, tourId, version]);

  const markAsked = useCallback(
    (stepId: string) => {
      markStepAsked(tourId, stepId);
      setAsked((s) => (s.has(stepId) ? s : new Set(s).add(stepId)));
    },
    [tourId],
  );
  const feedbackSent = useCallback(() => setVersion((v) => v + 1), []);

  return { feedback, asked, markAsked, feedbackSent };
}
