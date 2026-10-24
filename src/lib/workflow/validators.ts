/**
 * "Validate details": what must hold for a transition to go through, checked
 * against the PROPOSED item (current values with the transition's input
 * applied) and facts the caller loaded for it.
 *
 * Pure. The engine loads only the facts the transition's validators need
 * (children, links, the board's WIP count), then calls `runValidators`.
 * Fail-closed: a validator whose fact was not loaded fails rather than passes.
 */
import { compare } from "@/lib/abac/engine";
import { blockingChildren, describeBlockers, type ChildLike } from "@/lib/boards/parent-done-guard";
import { INTERVAL_REQUIRED_MESSAGE, requiresInterval } from "@/lib/work-items/interval-required";
import { CANCEL_NOTE_REQUIRED_MESSAGE } from "@/lib/work-items/cancel";
import { fieldValue, type ConditionItem } from "@/lib/workflow/conditions";
import type { FieldRef, ValidatorSpec } from "@/lib/workflow/definition";

export interface ValidationFacts {
  /** The item's children and the project's DONE / CANCELLED status keys. */
  children?: { items: readonly ChildLike[]; doneKeys: ReadonlySet<string>; cancelledKeys: ReadonlySet<string> };
  /** Items linked from this one, by link type, with whether each is settled. */
  links?: Readonly<Record<string, readonly { title: string; settled: boolean }[]>>;
  /** The destination column's WIP limit and how many items it would hold after the move. */
  wip?: { limit: number | null; countAfter: number; columnName: string; boardName: string };
  /** The item's type key and whether the project plans in intervals. */
  interval?: { typeKey: string | null; projectHasIntervals: boolean };
  /** The cancel reason and note the change carries. */
  cancel?: { reason: string | null; note: string | null };
}

export interface ValidationFailure {
  validator: ValidatorSpec["kind"];
  message: string;
  /** For `fieldsRequired`: the fields still missing. */
  fields?: FieldRef[];
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function missingFact(kind: ValidatorSpec["kind"]): ValidationFailure {
  return { validator: kind, message: "This transition's checks could not be completed." };
}

export function runValidators(
  validators: readonly ValidatorSpec[],
  item: ConditionItem,
  facts: ValidationFacts,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  for (const v of validators) {
    switch (v.kind) {
      case "fieldsRequired": {
        const missing = v.fields.filter((f) => isEmpty(fieldValue(item, f)));
        if (missing.length > 0) failures.push({ validator: v.kind, message: "Some required fields are empty.", fields: missing });
        break;
      }
      case "field": {
        const value = fieldValue(item, v.field);
        if (value === undefined || !compare(value, v.op, v.value)) failures.push({ validator: v.kind, message: v.message });
        break;
      }
      case "childrenSettled": {
        if (!facts.children) {
          failures.push(missingFact(v.kind));
          break;
        }
        const blockers = blockingChildren(facts.children.items, facts.children.doneKeys, facts.children.cancelledKeys);
        if (blockers.length > 0) {
          failures.push({ validator: v.kind, message: `Finish its sub-items first: ${describeBlockers(blockers)}.` });
        }
        break;
      }
      case "linksSettled": {
        const linked = facts.links?.[v.linkType];
        if (!linked) {
          failures.push(missingFact(v.kind));
          break;
        }
        const open = linked.filter((l) => !l.settled);
        if (open.length > 0) {
          failures.push({ validator: v.kind, message: `Still waiting on: ${open.map((l) => l.title).slice(0, 3).join(", ")}${open.length > 3 ? ` and ${open.length - 3} more` : ""}.` });
        }
        break;
      }
      case "wipLimit": {
        // No board with a hard limit on the column: nothing to enforce.
        if (!facts.wip || facts.wip.limit === null) break;
        if (facts.wip.countAfter > facts.wip.limit) {
          // The board's own wording, plus which board: the move may not have come from it.
          failures.push({ validator: v.kind, message: `"${facts.wip.columnName}" on ${facts.wip.boardName} is at its WIP limit (${facts.wip.limit}) — move blocked.` });
        }
        break;
      }
      case "intervalRequired": {
        if (!facts.interval) {
          failures.push(missingFact(v.kind));
          break;
        }
        const needs = facts.interval.projectHasIntervals && requiresInterval(facts.interval.typeKey);
        if (needs && isEmpty(item.fields.intervalId)) failures.push({ validator: v.kind, message: INTERVAL_REQUIRED_MESSAGE });
        break;
      }
      case "cancelReason": {
        // Today's semantics: the reason is optional; "Other" needs a note.
        const cancel = facts.cancel;
        if (cancel?.reason === "OTHER" && !cancel.note?.trim()) {
          failures.push({ validator: v.kind, message: CANCEL_NOTE_REQUIRED_MESSAGE });
        }
        break;
      }
      default:
        failures.push({ validator: (v as { kind: ValidatorSpec["kind"] }).kind, message: "Unknown check." });
    }
  }
  return failures;
}
