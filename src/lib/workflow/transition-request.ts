import { z } from "zod";

/**
 * What a client may send beside a work-item patch to steer the workflow: the
 * transition it means, the values that transition asked for, an override, and
 * the board the move was made on (accepted; hard WIP limits now hold from every
 * surface, so it is no longer needed). Not stored on the item.
 */
export const transitionRequestSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    input: z.record(z.string().max(120), z.unknown()).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export const changeContextSchema = z.object({
  transition: transitionRequestSchema.optional(),
  boardId: z.string().uuid().optional(),
});
