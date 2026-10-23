/** A /developers guide: markdown, rendered server-side at /developers/guides/<slug>. */
export interface Guide {
  slug: string;
  title: string;
  /** One line, for the index and llms.txt. */
  summary: string;
  body: string;
}
