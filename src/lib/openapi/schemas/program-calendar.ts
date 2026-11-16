import { z } from "zod";
import { IsoDateTime } from "./common";

/**
 * The program calendar's wire shapes.
 *
 * Pure zod, like every module here: route contracts import it, and the spec
 * build runs those in plain node.
 */

const flag = z.enum(["true", "false"]).optional();

/**
 * The calendar's filters as query parameters, other than the window and the
 * category list. The events list and the category counts both take exactly
 * these, so a count always describes the events the calendar is showing.
 */
export const ProgramEventFilterQuery = {
  ownerKeys: z.string().optional(),
  projectId: z.string().uuid().optional(),
  includeOrgEvents: flag,
  showOnDashboardOnly: flag,
  customerAttending: flag,
  hasDeliverable: flag,
};

/** One Program Increment, sprint or release on the Agile overlay. */
export const AgileInterval = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["PROGRAM_INCREMENT", "SPRINT", "RELEASE"]),
  startDate: IsoDateTime.describe("The first day, as that day's UTC midnight."),
  endDate: IsoDateTime.describe("The LAST day, inclusive, as that day's UTC midnight."),
  projectKey: z.string(),
  projectName: z.string(),
});

/** One work item falling due on the Agile overlay. */
export const AgileDue = z.object({
  id: z.string(),
  key: z.string().describe('The ticket key, e.g. "WEB-12".'),
  title: z.string(),
  dueDate: IsoDateTime,
  resolved: z.boolean().describe("Done or cancelled, by the rule the boards strike an item through by."),
});

export const AgilePayload = z.object({
  intervals: z.array(AgileInterval),
  due: z.array(AgileDue),
  dueCapped: z.boolean().describe("More work items fall due in the window than were returned."),
});
