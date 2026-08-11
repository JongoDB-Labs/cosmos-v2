import { isDoneColumnKey } from "./sprint-review";

/**
 * Resolves "what carried forward" for a sprint, and says which of three things
 * the answer actually is.
 *
 * While a sprint is open the set derives from its board. Once it completes, the
 * unfinished items have been reassigned to another sprint, so deriving returns
 * nothing and only `intervals.report.carriedItemIds` still knows. Sprints
 * completed before that field existed cannot be reconstructed at all.
 *
 * The distinction matters because the wrong collapse — reporting "unrecorded"
 * as an empty list — tells a room that nothing carried, which the data does not
 * support. A ceremony board that invents a clean sprint is worse than one that
 * admits it does not know.
 */

export type CarriedItems =
  | { kind: "live"; itemIds: string[] }
  | { kind: "recorded"; itemIds: string[] }
  | { kind: "unrecorded" };

export interface CarriedInput {
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  items: { id: string; columnKey: string }[];
  report: unknown;
}

export function resolveCarriedItems(input: CarriedInput): CarriedItems {
  if (input.status !== "COMPLETED") {
    return {
      kind: "live",
      itemIds: input.items
        .filter((i) => !isDoneColumnKey(i.columnKey))
        .map((i) => i.id),
    };
  }

  // `report` is a JSON column, so nothing below the application guarantees its
  // shape. An array of strings or we treat it as absent.
  const report = input.report;
  if (report === null || typeof report !== "object") return { kind: "unrecorded" };

  const raw = (report as Record<string, unknown>).carriedItemIds;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return { kind: "unrecorded" };
  }

  return { kind: "recorded", itemIds: raw as string[] };
}
