/**
 * Whole rows, as Prisma returns them, for tests of routes that answer through
 * a response contract. A hand-built partial row is (correctly) a contract
 * violation there, so tests start from these and override what they assert on.
 */
export function projectRow<T extends { id: string; orgId: string }>(over: T) {
  const base: Record<string, unknown> = {
    name: "Project", key: "PRJ", description: null, settings: {}, status: "ACTIVE", archived: false,
    projectTemplateId: null, enabledFeatures: [], teamScopedAccess: false, clientId: null,
    externalRef: null, krLinkTypeId: null, objectiveLinkTypeId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"),
    _count: { boards: 1, intervals: 0, members: 1 },
  };
  return { ...base, ...over };
}

export function timeEntryRow<T extends { id: string; userId: string }>(over: T) {
  const base: Record<string, unknown> = {
    orgId: "11111111-1111-4111-8111-111111111111", projectId: null, workItemId: null,
    date: new Date("2026-10-20T00:00:00Z"), hours: 1, rate: null, client: null, description: "",
    billableType: "BILLABLE", status: "DRAFT", approvedById: null, approvedAt: null, billedHours: null,
    billedById: null, billedAt: null, tags: [], payRunId: null, clinId: null, timesheetId: null,
    voidedAt: null, voidedById: null, voidReason: null,
    createdAt: new Date("2026-10-20T00:00:00Z"), updatedAt: new Date("2026-10-20T00:00:00Z"),
  };
  return { ...base, ...over };
}
