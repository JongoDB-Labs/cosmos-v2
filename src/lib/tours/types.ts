/**
 * A guided walk through what a release changed.
 *
 * Tours are CODE, shipped beside the feature they describe, so a step can never
 * point at a page that does not exist yet or describe a control that shipped
 * differently. Kept in a table they would drift, and the drift would surface in
 * front of whoever the tour was built to impress.
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
   * Questions offered as one-tap chips beside the free-text box. Suggestions,
   * not a script: the box is always there, and these only save typing the ones
   * everybody asks anyway.
   */
  asks?: string[];
  /**
   * Permissions that make this step reachable — ANY one suffices. Omit for a
   * step everybody can follow.
   *
   * A step is only worth showing to somebody who can act on it. Without this a
   * walkthrough sends a reader to a page their role redirects away from, and the
   * walkthrough is where they learn they are not trusted with it — which is a
   * worse first impression than never offering the step at all.
   */
  anyOf?: bigint[];
  /**
   * The element this step is about, matched as [data-tour="<anchor>"].
   *
   * A deliberate attribute rather than a CSS selector into somebody else's
   * markup: a selector silently stops matching the first time that component is
   * restyled, and a walkthrough that highlights nothing is worse than one that
   * never tried. When the element is absent the card falls back to its corner
   * and simply does not highlight — never a broken pointer at empty space.
   */
  anchor?: string;
}

export interface Tour {
  /**
   * Stable, globally unique, and the thing everything else keys on: resume
   * state, "already seen", and the ?tour= link.
   *
   * NOT the release version. A tour belongs to whatever ships it, on its own
   * cadence — a plugin releasing weekly would otherwise have to name a core
   * version it has nothing to do with, and renaming a tour would silently
   * reset everyone's progress.
   */
  id: string;
  /** Shown on the launcher and on the card. */
  name: string;
  /** One line saying what this release was about. */
  summary: string;
  /**
   * Sorts newest-first when several are on offer. ISO date (YYYY-MM-DD) of the
   * release it describes — a date rather than a version because the things
   * contributing tours version independently of each other.
   */
  released: string;
  steps: TourStep[];
}
