import { z } from "zod";
import { IsoDateTime, NullableUuid, Uuid } from "./common";

export const AuditLogEntry = z.object({
  id: Uuid,
  orgId: Uuid,
  userId: NullableUuid.describe("Null for actions taken by the system."),
  action: z.string().describe("Dotted verb, e.g. `project.updated`."),
  entity: z.string(),
  entityId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ipAddress: z.string().nullable(),
  createdAt: IsoDateTime,
}).meta({ id: "AuditLogEntry" });

export const entities = {
  AuditLogEntry: {
    schema: AuditLogEntry,
    model: "AuditLog",
    omitted: {
      seq: "hash-chain sequence (a BigInt): tamper-evidence internals",
      rowHash: "hash-chain internals",
      prevHash: "hash-chain internals",
    },
  },
};
