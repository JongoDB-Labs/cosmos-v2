import { z } from "zod";
import * as E from "./enums.generated";
import { IsoDateTime, Uuid } from "./common";

/** A directed link between two work items in the same project. */
export const WorkItemLink = z.object({
  id: Uuid,
  orgId: Uuid,
  sourceItemId: Uuid,
  targetItemId: Uuid,
  type: z.enum(E.LinkType).describe("BLOCKS, PREDECESSOR and their inverses are directed; RELATES, DUPLICATES and CLONES are not."),
  createdAt: IsoDateTime,
}).meta({ id: "WorkItemLink" });

/** A link as the project's list shows it, with both ends' ticket numbers and titles. */
export const WorkItemLinkRow = WorkItemLink.omit({ orgId: true }).extend({
  sourceTicketNumber: z.number().int(),
  sourceTitle: z.string(),
  targetTicketNumber: z.number().int(),
  targetTitle: z.string(),
}).meta({ id: "WorkItemLinkRow" });

/** What creating a link returns. */
export const CreatedWorkItemLink = WorkItemLink.omit({ orgId: true }).meta({ id: "CreatedWorkItemLink" });

/** For schemas.test: every entity names every column of its model. */
export const entities = {
  WorkItemLink: { schema: WorkItemLink, model: "WorkItemLink", omitted: {} },
};
