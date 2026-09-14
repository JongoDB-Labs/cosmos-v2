/**
 * A guided walk through what a release changed.
 *
 * Tours are CODE, not data: a release's tour is written alongside the release
 * that needs it and ships with it, so a step can never point at a page that does
 * not exist yet or describe a control that shipped differently. Storing them in
 * the database would let the two drift, and the drift would surface in front of
 * whoever the tour was built to impress.
 */
export interface TourStep {
  /** Stable within a tour; used for feedback attribution and resume state. */
  id: string;
  /** What this step is about, in the reader's terms. */
  title: string;
  /** Why it exists. One or two sentences. */
  blurb: string;
  /**
   * Where the step lives, relative to the org — "/reports" becomes
   * "/{orgSlug}/reports". Omit for a step about the page they are already on.
   */
  href?: string;
  /** The one thing to look at once they arrive. */
  look: string;
  /**
   * Seeds the question box when they ask about this step. Not an answer — a
   * starting point they can rewrite.
   */
  ask?: string;
}

export interface Tour {
  /** Release this tour belongs to, matching the changelog version. */
  version: string;
  /** Shown on the launcher and in feedback raised from the tour. */
  name: string;
  /** One line on the launcher, saying what the release was about. */
  summary: string;
  steps: TourStep[];
}
