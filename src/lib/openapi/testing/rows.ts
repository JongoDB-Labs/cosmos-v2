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

export function intervalRow<T extends Record<string, unknown>>(over: T & { id: string; orgId: string; projectId: string }) {
  return {
    intervalKind: "SPRINT", number: 1, name: "Sprint 1", sectorLabel: null, goal: "", status: "ACTIVE",
    startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-14T00:00:00Z"),
    report: null, createdAt: new Date("2026-09-30T00:00:00Z"), parentId: null,
    ...over,
  };
}

/** A whole work-item row, `searchVector` and `sourceRecord` included, as a findMany without `omit` returns it. */
export function workItemRow<T extends Record<string, unknown>>(over: T & { id: string; orgId: string; projectId: string }) {
  return {
    title: "Item", description: "", columnKey: "todo", assigneeId: null, priority: "MEDIUM", parentId: null,
    ticketNumber: 1, storyPoints: null, sortOrder: 0, dueDate: null, startDate: null, actualStart: null,
    completedAt: null, columnEnteredAt: null, workCategory: "BUSINESS", archivedAt: null, cancelReason: null,
    cancelNote: null, mergedIntoId: null, tags: [], highlight: null, customFields: {},
    createdById: "44444444-4444-4444-8444-444444444444",
    createdAt: new Date("2026-10-02T00:00:00Z"), updatedAt: new Date("2026-10-02T00:00:00Z"),
    workItemTypeId: "55555555-5555-4555-8555-555555555555", intervalId: null, teamId: null,
    externalSource: null, externalId: null, externalKey: null, sourceStatus: null, resolution: null,
    originalEstimate: null, remainingEstimate: null, timeSpent: null,
    searchVector: { title: "item" }, sourceRecord: null,
    ...over,
  };
}

/** A whole comment row, as Prisma returns it. */
export function commentRow<T extends Record<string, unknown>>(over: T & { id: string; orgId: string; authorId: string }) {
  return {
    workItemId: null, subjectType: null, subjectId: null, content: "c", parentId: null,
    visibility: "PUBLIC", kind: "COMMENT", meta: null, editedAt: null, deletedAt: null, deletedById: null,
    hiddenAt: null, hiddenById: null, hiddenReason: null, originSubjectId: null, classification: null,
    createdAt: new Date("2026-10-02T00:00:00Z"), updatedAt: new Date("2026-10-02T00:00:00Z"),
    ...over,
  };
}
