/**
 * Human labels for an assistant tool-call chip ("Creating whiteboard…",
 * "Added to whiteboard").
 *
 * These used to live inside `assistant-panel.tsx` as a curated map of ~20 names
 * plus a `Running ${name}` fallback, so the chip showed the RAW tool name for
 * everything else — and the agent offers well over a hundred tools. The ones a
 * PLUGIN contributes can never be on such a list, because core does not know
 * their names: asking Cosmo for a whiteboard reported itself as
 * "Ran create_whiteboard" and "Ran add_to_whiteboard". That is the tool's
 * identifier, not an account of what happened — and for the objects drawn onto a
 * board the chip is the only account there is, since a drawn-on board
 * deliberately gets no artifact card (see `artifacts.ts`).
 *
 * So the fallback does the work instead of the list. Tool names here are
 * `verb_subject` by convention (`create_work_item`, `list_boards`,
 * `add_to_whiteboard`, `github_list_issues`), which is enough to read as English
 * from the name alone — plugin tools included, with core naming none of them.
 * The curated map stays for the few the derivation gets WRONG (an acronym it
 * would lowercase, a name whose qualifier is not a verb's object).
 *
 * Client-safe (strings only), and it lives here beside `tool-status.ts` — the
 * other half of the same chip — so both are testable without rendering the
 * panel.
 */

/** Names the derivation below reads wrongly. Keep this SHORT; prefer a verb. */
const TOOL_LABELS: Record<string, string> = {
  // Acronyms the derivation would lowercase.
  create_kpi: "Creating KPI",
  update_kpi: "Updating KPI",
  list_kpis: "Listing KPIs",
  add_kr_checkin: "Adding key-result check-in",
  describe_cql: "Explaining CQL",
  // "semantic" is the search's KIND, not its object: derived, it reads
  // "Searching semantic".
  semantic_search: "Searching the workspace",
};

/** Past-tense forms of the curated present labels above. */
const PAST_LABELS: Record<string, string> = {
  "Creating KPI": "Created KPI",
  "Updating KPI": "Updated KPI",
  "Listing KPIs": "Listed KPIs",
  "Adding key-result check-in": "Added key-result check-in",
  "Explaining CQL": "Explained CQL",
  "Searching the workspace": "Searched the workspace",
};

/**
 * The verbs a tool name can carry → [present participle, past tense].
 *
 * Past tense is listed, never derived: the naive "-ing" → "-ed" substitution
 * produces "Runned", "Sended" and "Writed". An unknown verb keeps the raw name
 * rather than guessing at one.
 */
const VERBS: Record<string, readonly [string, string]> = {
  create: ["Creating", "Created"],
  add: ["Adding", "Added"],
  update: ["Updating", "Updated"],
  set: ["Setting", "Set"],
  delete: ["Deleting", "Deleted"],
  archive: ["Archiving", "Archived"],
  list: ["Listing", "Listed"],
  get: ["Loading", "Loaded"],
  query: ["Searching", "Searched"],
  search: ["Searching", "Searched"],
  describe: ["Explaining", "Explained"],
  link: ["Linking", "Linked"],
  unlink: ["Unlinking", "Unlinked"],
  log: ["Logging", "Logged"],
  transition: ["Moving", "Moved"],
  complete: ["Completing", "Completed"],
  generate: ["Generating", "Generated"],
  process: ["Processing", "Processed"],
  send: ["Sending", "Sent"],
  post: ["Posting", "Posted"],
  read: ["Reading", "Read"],
  write: ["Writing", "Wrote"],
  fetch: ["Fetching", "Fetched"],
};

/**
 * Read `verb_subject` as English, or null when no part of the name is a known
 * verb — in which case the caller keeps the raw-name fallback rather than
 * inventing a reading of a name it does not understand.
 *
 * The verb is not always first: a connector namespaces its tools
 * (`github_list_issues`, `m365_list_messages`), so the first KNOWN verb wins and
 * the words before it stay as a qualifier — "Listing github issues". Everything
 * after it reads as written, which is why `add_to_whiteboard` comes out as
 * "Added to whiteboard" without an entry of its own.
 */
function derive(name: string): { present: string; past: string } | null {
  const parts = name.split("_").filter((p) => p.length > 0);
  const at = parts.findIndex((p) => p in VERBS);
  if (at === -1) return null;
  const [present, past] = VERBS[parts[at]];
  const subject = [...parts.slice(0, at), ...parts.slice(at + 1)].join(" ");
  return subject
    ? { present: `${present} ${subject}`, past: `${past} ${subject}` }
    : { present, past };
}

/**
 * The present-progressive label shown while the tool is still executing. Falls
 * back to the raw tool name, as before, for a name nothing can be read from.
 */
export function labelForTool(name: string | undefined): string {
  if (!name) return "Running tool";
  return TOOL_LABELS[name] ?? derive(name)?.present ?? `Running ${name}`;
}

/** The past-tense label shown once the call has finished. */
export function pastTenseLabel(name: string | undefined): string {
  if (!name) return "Ran tool";
  const curated = TOOL_LABELS[name];
  if (curated) return PAST_LABELS[curated] ?? curated;
  return derive(name)?.past ?? `Ran ${name}`;
}
